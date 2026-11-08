// 部署级开关。存 params 表的系统层（task_id NULL、layer='system'），治理类别 constitutional ——
// 库层 CHECK 保证只有人能写，agent 结构上改不了。键很少，全列在 SETTINGS 里；不认识的键拒收。
//
// 现在只有一个：谁能新建项目 / 任务。默认成员即可（创建者就是负责人，花费由预算上限封着）；
// 打开"仅管理员可创建"后只有管理员能建。旁观者与已停用成员恒不可。

import { newId, now, audit } from '../db/db.mjs';
import { writeParam } from './params.mjs';
import { I18nError, CATALOGS, contentLang } from '../i18n/index.mjs';
import { validTz, parseHolidays, HOLIDAY_MAX_SPAN } from './tz.mjs';

export const SETTINGS = {
  'deploy.create_admin_only': { default: false, type: 'boolean', label: '仅管理员可新建项目与任务' },
  // 新项目建好就放行的联网源（管理员在联网目录里勾）。原来每个新项目第一次装依赖都要负责人答一条"放不放行"。
  'deploy.egress_defaults': { default: [], type: 'list', label: '新项目默认放行的联网源' },
  // 0.2.0：写进库里的文字（事项正文、汇报……）与模型写给人的文字用哪种语言。按部署统一，见 src/i18n/index.mjs。
  'deploy.content_lang': { default: 'zh', type: 'enum', values: ['zh', 'en'], label: '内容语言' },
  // 2026-10-12：部署级急停。开着时不拉起任何进程（守护进程与看板的「运行」都走启动器），
  // 在跑的编排器下一轮（步骤内则下一次工具调用轮）停下、不计重试；关掉后守护进程自己接着拉。状态落库，重启照样生效。
  'deploy.paused': { default: false, type: 'boolean', label: '暂停全部自动运行' },
  // 2026-10-12：管理员发给所有人的公告（维护窗口、升级通知……），走急停的同一条通道：
  // 存这里、随任务列表下发、改了经 SSE 推给所有人；看板顶部一条横幅（按原文显示，不当 HTML）。空 = 没有公告。
  'deploy.announcement': { default: '', type: 'text', max: 500, label: '公告' },
  // 2026-10-12：守护进程每隔多少小时做一份定期备份（并核过、按保留数删旧的）。0 = 关。
  'deploy.backup_every_hours': { default: 24, type: 'int', min: 0, max: 24 * 7, label: '定期备份间隔（小时，0 = 不备份）' },
  // 2026-10-12：日志留几天（任务日志、JSON 行日志）；已合并 / 已归档任务的工作区要不要删依赖目录
  'deploy.log_keep_days': { default: 14, type: 'int', min: 1, max: 365, label: '日志保留天数' },
  'deploy.clean_merged_deps': { default: true, type: 'boolean', label: '已合并 / 已归档任务的工作区自动删依赖目录（node_modules 等）' },
  // 2026-10-12：会话与令牌的期限（参考 NIST SP 800-63B-4 的会话管理：闲置超时 + 绝对上限）
  'deploy.session_idle_hours': { default: 12, type: 'int', min: 1, max: 24 * 7, label: '浏览器会话闲置多久失效（小时）' },
  'deploy.session_max_days': { default: 7, type: 'int', min: 1, max: 90, label: '浏览器会话最长多久（天）' },
  'deploy.cli_token_days': { default: 90, type: 'int', min: 0, max: 3650, label: '新签发的命令行令牌多久过期（天，0 = 不过期）' },
  'deploy.invite_hours': { default: 24, type: 'int', min: 1, max: 24 * 7, label: '邀请链接多久失效（小时）' },
  // 2026-10-12：按人记账、按人 / 按部署的月度预算、公平调度
  'deploy.cost_attribution': { default: 'requester', type: 'enum', values: ['requester', 'project_owner', 'approver'], label: '花费记在谁头上（requester 发起人 / project_owner 项目负责人 / approver 批准契约的人）' },
  'deploy.person_budget_usd_month': { default: 0, type: 'int', min: 0, max: 1_000_000, label: '每人每月预算（美元，0 = 不设）' },
  'deploy.budget_usd_month': { default: 0, type: 'int', min: 0, max: 10_000_000, label: '整个部署每月预算（美元，0 = 不设）' },
  'deploy.max_running_per_person': { default: 0, type: 'int', min: 0, max: 100, label: '每人同时在跑的任务数上限（0 = 不限）' },
  // 2026-10-12：推送 / 开 PR 时先用谁的连接。personal_first：点交付的人自己的连接优先（PR 署他的名）；
  // app_first：GitHub App 优先（PR 显示为 bot），成员自己的连接只在 App 用不上时才用
  // 2026-10-12：提交 trailer 与 PR 里的追溯链接用哪个看板地址（空 = 不写链接）；要不要加 Co-authored-by（默认不加：它表示"共同作者"）
  'deploy.board_url': { default: '', type: 'url', label: '看板地址（写进提交与 PR 的追溯链接；空 = 不写）' },
  'deploy.commit_coauthor': { default: false, type: 'boolean', label: '提交里给批准、发指令、发起的人加 Co-authored-by（GitHub 会显示头像；只给填了提交邮箱的人）' },
  // 用 GitHub 登录：要求是哪个组织的正式成员（空 = 不开 GitHub 登录）；对不上看板成员的 GitHub 账号怎么办
  'deploy.github_login_org': { default: '', type: 'github_name', label: '用 GitHub 登录：必须是哪个组织的成员（空 = 不开）' },
  'deploy.github_login_autocreate': { default: 'off', type: 'enum', values: ['off', 'member', 'observer'], label: '用 GitHub 登录时对不上成员（off 拒绝 / member 自动建为成员 / observer 自动建为旁观者）' },
  // 2026-10-12：部署时区（IANA 名，如 Asia/Shanghai；空 = UTC）—— 业务日（1bd）、值班换班、月度预算按它算；
  // 节假日与调休（一行一条，见 core/tz.mjs parseHolidays）—— 「休」的日子不算工作日，「班」的日子周末也算
  'deploy.timezone': { default: '', type: 'timezone', label: '部署时区（业务日、值班换班、月度预算按它算；空 = UTC）' },
  'deploy.holidays': { default: '', type: 'holidays', max: 20000, label: '节假日与调休' },
  'deploy.credential_order': { default: 'personal_first', type: 'enum', values: ['personal_first', 'app_first'], label: '推送时先用谁的连接（personal_first 点交付的人自己的 / app_first GitHub App）' },
  // 2026-10-13：一步把原有测试改弱了（删文件、加跳过、用例 / 断言变少、改期望值）怎么办。
  // 默认只标注（交给验收员当证据、看板上标出来）：功能变化可能需要同步修改测试，因此由人核对具体差异
  // 验收员与执行器异厂商。different = 验收员没单独绑模型、它的档位又与这一步执行器同一家时，换一家有 key 的（只有一家就只好同一家）
  'deploy.verifier_vendor': { default: 'different', type: 'enum', values: ['different', 'same'], label: '验收员与执行器（different 落在同一家时换一家 / same 不强求）' },
  // 高风险步骤（规划时标 high）两个不同服务商的验收员会签：两个都通过才算过
  'deploy.verifier_cosign': { default: 'off', type: 'enum', values: ['off', 'high_risk'], label: '两个验收员会签（off 不用 / high_risk 高风险步骤用两家各验一次，都通过才算过）' },
  // 部署级停用的 skill（`<层>:<名字>`，或 `<层>:*` 停掉整层）。停了的，项目里打不开
  'deploy.skills_off': { default: [], type: 'list', label: '停用的 skill（对所有项目）' },
  // 每一步开头给执行器的仓库地图（文件 → 定义的符号，按这一步的范围排序）截到多少 token。
  // 默认 2048：中小仓库里，执行器开工阶段要读的文件大多能列进去；再大收益递减，而这一段每一轮都要付
  'deploy.repo_map_tokens': { default: 2048, type: 'int', min: 0, max: 16384, label: '每一步开头给执行器的仓库地图（token，0 = 不给）' },
  // 2026-11-08：没单独设过监督模式的项目用哪一种（full 逐项审批 / spot 抽检 / exception 例外管理），见 core/signals.mjs
  // 推送节奏：个人没设时用这里的（个人在「我的通知」里改自己的）
  'deploy.work_start_hour': { default: 9, type: 'int', min: 0, max: 23, label: '工作时间从几点开始（按各人自己的时区；工作时间外只推紧急的）' },
  'deploy.work_end_hour': { default: 18, type: 'int', min: 1, max: 24, label: '工作时间到几点结束（24 = 到午夜）' },
  'deploy.work_days_only': { default: true, type: 'boolean', label: '工作时间只算工作日（按部署的节假日表）' },
  'deploy.digest_every_min': { default: 60, type: 'int', min: 0, max: 1440, label: '汇总推送间隔（分钟；0 = 不攒，有就推）' },
  'deploy.push_cap_per_hour': { default: 4, type: 'int', min: 0, max: 60, label: '推送限额：每人每小时最多几条即时推送（0 = 不限；Ⅲ 级与部署健康不受限）' },
  // 状态报告：部署默认；各人可在「我的通知」里改
  'deploy.report_every': { default: 'auto', type: 'enum', values: ['auto', 'off', 'day', 'week'], label: '状态报告多久一份（auto 按默认监督模式：逐项审批每天、抽检每周、例外管理每周只报异常 / off 不发 / day 每天 / week 每周）' },
  'deploy.report_day': { default: 1, type: 'int', min: 1, max: 7, label: '每周的状态报告发在星期几（1 = 周一 … 7 = 周日）' },
  'deploy.report_hour': { default: 9, type: 'int', min: 0, max: 23, label: '状态报告几点发（按各人时区；那天不是工作日就顺延到下一个工作日）' },
  'deploy.report_detail': { default: 'auto', type: 'enum', values: ['auto', 'exceptions', 'summary', 'full'], label: '状态报告详略（auto 按默认监督模式 / exceptions 只报异常 / summary 摘要 / full 详细）' },
  'deploy.oversight_mode': { default: 'spot', type: 'enum', values: ['full', 'spot', 'exception'], label: '默认监督模式（full 逐项审批 / spot 抽检 / exception 例外管理；项目没单独设时用它）' },
  'deploy.test_guard':{ default: 'annotate', type: 'enum', values: ['annotate', 'reject'], label: '原有测试被改弱时（annotate 只标出来给验收员和人看 / reject 交接时直接打回）' },
};

export function getSetting(db, key) {
  const def = SETTINGS[key] ?? (() => { throw new I18nError('设置项不存在：{key}', { key }); })();
  // ⚠️ `project_id IS NULL` 不能省（v16 起 params 多了项目层）：项目层的行 task_id 也是 NULL，
  // 少这一句就会把某个项目的同名设置读成部署级的。
  const row = db.one(`SELECT value FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, key);
  if (!row) return def.default;
  try { return JSON.parse(row.value); } catch { return def.default; }
}

/** 调用方保证操作者是管理员。 */
export function setSetting(db, { key, value, userId }) {
  const def = SETTINGS[key] ?? (() => { throw new I18nError('设置项不存在：{key}', { key }); })();
  // 报错里的设置项名按内容语言取（label 是中文原文，看板上的名字由看板翻）
  const label = () => CATALOGS[contentLang(db)]?.[def.label] ?? def.label;
  if (def.type === 'boolean' && typeof value !== 'boolean') throw new I18nError('{label}：值无效（应为 true 或 false）', { label: label() });
  if (def.type === 'list' && !(Array.isArray(value) && value.every((x) => typeof x === 'string'))) throw new I18nError('{label}：值无效（应为一组名字）', { label: label() });
  if (def.type === 'enum' && !def.values.includes(value)) throw new I18nError('{label}：值无效（可选：{values}）', { label: label(), values: def.values.join(' / ') });
  if (def.type === 'int' && !(Number.isInteger(value) && value >= def.min && value <= def.max)) throw new I18nError('{label}：值无效（应为 {min}–{max} 的整数）', { label: label(), min: def.min, max: def.max });
  if (def.type === 'github_name') {
    if (typeof value !== 'string') throw new I18nError('{label}：值无效（应为 GitHub 组织名，或留空）', { label: label() });
    value = value.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (value && !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value)) throw new I18nError('{label}：值无效（应为 GitHub 组织名，或留空）', { label: label() });
  }
  if (def.type === 'text') {
    if (typeof value !== 'string') throw new I18nError('{label}：值无效（应为文字）', { label: label() });
    // 统一换行、去掉控制字符（制表与换行除外）、首尾空白
    value = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (value.length > def.max) throw new I18nError('{label}：太长了（上限 {max} 字，现在 {n} 字）', { label: label(), max: def.max, n: value.length });
  }
  if (def.type === 'timezone') {
    if (typeof value !== 'string') throw new I18nError('{label}：值无效（应为时区名，如 Asia/Shanghai；或留空 = UTC）', { label: label() });
    value = value.trim();
    if (value && !validTz(value)) throw new I18nError('{label}：不认识的时区「{tz}」（应为 IANA 时区名，如 Asia/Shanghai、America/New_York；或留空 = UTC）', { label: label(), tz: value.slice(0, 64) });
  }
  if (def.type === 'holidays') {
    if (typeof value !== 'string') throw new I18nError('{label}：值无效（应为文字）', { label: label() });
    value = value.replace(/\r\n?/g, '\n').trim();
    if (value.length > def.max) throw new I18nError('{label}：太长了（上限 {max} 字，现在 {n} 字）', { label: label(), max: def.max, n: value.length });
    const bad = parseHolidays(value).errors;
    if (bad.length) throw new I18nError('{label}：有 {n} 行看不懂（行号：原文）—— {lines}。每行写 2026-10-01 或 2026-10-01..2026-10-07，后面可跟名字；补班的日子加「班」；一段最多 {max} 天', { label: label(), n: bad.length, lines: bad.slice(0, 3).map((e) => `${e.line}: ${e.text.slice(0, 40)}`).join(' / '), max: HOLIDAY_MAX_SPAN });
  }
  if (def.type === 'url') {
    if (typeof value !== 'string') throw new I18nError('{label}：值无效（应为 http(s) 地址，或留空）', { label: label() });
    value = value.trim().replace(/\/+$/, '');
    let u = null; try { u = value ? new URL(value) : null; } catch { /* 下面报 */ }
    if (value && (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash)) throw new I18nError('{label}：值无效（应为 http(s) 地址，不带用户名口令、查询串与 #；或留空）', { label: label() });
  }
  const t = now();
  return db.tx(() => {
    const before = getSetting(db, key);
    writeParam(db, { key, value, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'system', at: t });
    audit(db, { actorKind: 'user', actorId: userId, action: 'setting_set', targetType: 'setting', targetId: key, payload: { from: before, to: value } });
    return { key, value };
  });
}

/** 某个设置最近一次是谁、什么时候设的：{ at, by }；没设过返回 null（公告横幅用 at 区分"同一条"和"新的一条"） */
export function settingSetAt(db, key) {
  const r = db.one(`SELECT recorded_at, set_by_id FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, key);
  return r ? { at: r.recorded_at, by: r.set_by_id } : null;
}

export const settingsView = (db) => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, getSetting(db, k)]));

/** 某人能否新建项目 / 任务。返回 { ok, why }。 */
export function canCreate(db, userId) {
  const u = db.one(`SELECT role, disabled_at FROM users WHERE id=?`, userId);
  if (!u || u.disabled_at) return { ok: false, why: '成员不存在或已停用' };
  if (u.role === 'observer') return { ok: false, why: '旁观者不能新建项目或任务' };
  if (u.role !== 'lead' && getSetting(db, 'deploy.create_admin_only')) return { ok: false, why: '当前设置为仅管理员可新建项目与任务' };
  return { ok: true, why: null };
}
