// 基础设施错误 —— **不是模型的错，也不是模型能修的错**。
//
// 实际运行中会撞上的两端：
//   - 厂商回 403，异常从 runToolLoop **炸穿**到 CLI，进程死掉，节点停在 running，
//     下次启动被 reclaim 记一次重试 —— 而那不是节点难，是厂商挂了。
//   - 容器撞 OOM 硬边界，container.mjs 抛 Error，runToolLoop 把它**吞成工具报错**
//     回给模型，模型看到一句话接着跑 —— "硬失败"变成了一句话。
//
// 同一个形状的两端：工具循环对"基础设施坏了"没有概念，要么吞、要么炸。
// 这里给它一个概念。带 `infra=true` 的错误穿过工具循环（不回给模型），
// 在编排器被接住，干净地停：节点退回 pending、账落库、审计留证、CLI 说清楚。

export class InfraError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = new.target.name;
    this.infra = true;
    Object.assign(this, meta);
  }
}

/** 厂商侧：HTTP 非 2xx 或网络失败。`retryable` 由状态码定（429/408/5xx/网络）。 */
export class ProviderError extends InfraError {
  kind = 'provider';
  /** @returns 给审计与 CLI 用的平铺字段 */
  summary() {
    const { vendor, model, tier, status, retryable, attempts } = this;
    return { vendor, model, tier, status: status ?? null, retryable: !!retryable,
      attempts: attempts ?? 1, message: String(this.message).slice(0, 400) };
  }
}

/**
 * 配置侧：档位绑的模型 / 服务商被停用、键不在目录里、.env 里没填 key。
 * 和厂商 403 同一类事 —— **不是节点的错，模型也修不了** —— 所以走同一条通道：节点退回 pending、不计重试、
 * 编排器干净地停。在这之前它们是普通 Error：执行器按"真 bug"扣 retry_count，守护进程反复拉起把
 * limit.node_retries 耗光，最后出一个"节点太难"的上限问题，全程误诊。
 * `summary()` 与 ProviderError 同形，多一个 config:true；retryable 恒为 false（配置不改，重试没有意义）。
 */
export class ConfigError extends InfraError {
  kind = 'config';
  summary() {
    const { vendor, model, tier, key } = this;
    return { vendor: vendor ?? null, model: model ?? null, tier: tier ?? null, key: key ?? null, status: null, retryable: false,
      attempts: 0, config: true, message: String(this.message).slice(0, 400) };
  }
}

/** 硬边界（on_hit='hard_fail'）：容器被 OOM / pids-limit 掐死。携带 breach。 */
export class HardLimitError extends InfraError {
  kind = 'hard_limit';
}

export const isInfraError = (e) => e?.infra === true;
