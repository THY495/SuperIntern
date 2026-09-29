# mitmproxy addon：出口白名单 + 凭证注入 + 审计日志（出口白名单 + 凭证隔离）
#
# 这是"脑/手分离"的关键件：
#   - 沙箱（手）挂在 internal 网上，没有网关，只能把请求交给这个代理
#   - 白名单在**这里**执行，模型无从参与，也就无从被说服
#   - 真令牌只在这里，沙箱内即使被完全接管也偷不到可复用的凭证
#   - 每一次出网尝试都记审计，**含被拒的** —— 那同时是防数据外传的闸门，
#     也是发现白名单遗漏项的唯一渠道
#
# 三处要点：
#   ① 注入规则的粒度是 `(host, path 前缀, method)`，默认不注入。
#      按整个 host 无条件注入会破坏无需认证的路径 ——
#      公开仓库的匿名 `git clone` 因此收到 401，而报错信息
#      （"could not read Username"）完全指不到真实原因。
#   ② **审计记规则，永不记值。** 落盘的是"用了哪条规则注入"，不是注入了什么。
#      一份会把令牌写进日志的凭证隔离，隔离的只是沙箱，不是磁盘。
#   ③ 路径**去掉 query**。审计的用途是"发现漏了哪个域"，不是留存请求内容；
#      而 query string 是凭证与个人数据最常见的意外泄漏位置。

import json
import os
import time

from mitmproxy import ctx, http

AUDIT_PATH = "/audit/egress.jsonl"


def _jenv(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        ctx.log.error(f"{name} 不是合法 JSON，按空处理（这会让一切出网被拒）：{e}")
        return default


# [{"group":"npm","host":"registry.npmjs.org"}, ...]
# 带 group 是为了让被拒记录能说出"你要的域属于哪个还没放行的生态"。
ALLOW = _jenv("SUPERINTERN_ALLOWLIST", [])

# [{"host":..., "path_prefix":..., "methods":[...], "header":..., "env":...}]
# `env` 指向**代理容器内**存着真值的环境变量名。规则里只有变量名，没有值 ——
# 这样规则本身可以入库、可以打印、可以进审计，而值只活在这个进程的内存里。
CRED_RULES = _jenv("SUPERINTERN_CRED_RULES", [])


def match_host(host, rule_host):
    if rule_host.startswith("*."):
        return host == rule_host[2:] or host.endswith(rule_host[1:])
    return host == rule_host


def allowed_group(host):
    """返回放行它的生态名；没有就返回 None。"""
    for r in ALLOW:
        if match_host(host, r.get("host", "")):
            return r.get("group", "?")
    return None


# 只读的源（v20，信息源默认只读）：只放行这几种方法。拦的是"往外提交"，拦不住把数据塞进网址参数 —— 只是收窄。
READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def read_only(host):
    """这个域是否只读。同一个域出现在多个源里时，只要有一个源允许写，就算可写。"""
    hits = [r for r in ALLOW if match_host(host, r.get("host", ""))]
    return bool(hits) and all(r.get("readOnly") for r in hits)


def cred_rule_for(host, path, method):
    for i, r in enumerate(CRED_RULES):
        if not match_host(host, r.get("host", "")):
            continue
        if not path.startswith(r.get("path_prefix", "/")):
            continue
        methods = r.get("methods")
        if methods and method.upper() not in [m.upper() for m in methods]:
            continue
        return i, r
    return None, None


def audit(**rec):
    rec["ts"] = round(time.time(), 3)
    try:
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        # 审计写不进去是严重事件，但让代理静默崩掉更糟 —— 那会表现为"外网不通"，
        # 排查方向完全指错。
        ctx.log.warn(f"audit write failed: {e}")


class EgressGuard:
    def http_connect(self, flow: http.HTTPFlow):
        """HTTPS 在 CONNECT 阶段就拦：非白名单的域连 TLS 握手都不发生。

        既省资源也减小攻击面。注意客户端看到的报错形态是
        `curl: (56) CONNECT tunnel failed, response 403`，不是 HTTP 状态码 ——
        告警与测试逻辑要认这个形态。
        """
        host = flow.request.host
        if allowed_group(host) is None:
            audit(phase="connect", host=host, allowed=False, action="denied")
            flow.response = http.Response.make(
                403,
                b"egress denied by allowlist (CONNECT)\n",
                {"Content-Type": "text/plain"},
            )

    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        method = flow.request.method
        # 去掉 query：审计要回答的是"漏了哪个域"，不是留存请求内容。
        path = flow.request.path.split("?", 1)[0]

        group = allowed_group(host)
        if group is None:
            audit(phase="request", host=host, method=method, path=path,
                  allowed=False, action="denied")
            flow.response = http.Response.make(
                403, b"egress denied by allowlist\n", {"Content-Type": "text/plain"}
            )
            return

        if read_only(host) and method.upper() not in READ_METHODS:
            audit(phase="request", host=host, method=method, path=path,
                  allowed=False, group=group, action="denied_method")
            flow.response = http.Response.make(
                403, b"egress denied: this source is read-only (GET/HEAD/OPTIONS only)\n", {"Content-Type": "text/plain"}
            )
            return

        idx, rule = cred_rule_for(host, path, method)
        action = "forwarded"
        if rule is not None:
            value = os.environ.get(rule.get("env", ""), "")
            if value:
                flow.request.headers[rule.get("header", "Authorization")] = value
                # 记规则，不记值。连值的长度都不记 —— 那是免费送出去的一点熵。
                action = "injected"
            else:
                # 规则命中但值是空的。这不能静默放过：它会表现为上游 401，
                # 而排查的人会去怀疑令牌错了，而不是怀疑令牌根本没送到代理。
                action = "injection_skipped_empty"

        audit(phase="request", host=host, method=method, path=path, allowed=True,
              group=group, action=action,
              cred_rule=None if rule is None else f"#{idx} {rule.get('host')}{rule.get('path_prefix', '/')}")


addons = [EgressGuard()]
