// 出站 HTTP 的时限。
//
// 原来只有通知（notify.mjs）带了 AbortSignal.timeout；GitHub 接口、模型列表、连通性探测、模型调用都靠 Node 内置 fetch 的
// 默认值（等响应头 300 s、两次收到数据之间 300 s）。看板上的请求（测试连接、交付）会跟着挂那么久；
// 卡住的连接也不会被当成"网络失败"去重试。

/** 普通 API：GitHub、模型列表、连通性探测。 */
export const HTTP_TIMEOUT_MS = 30_000;
/**
 * 一次模型调用的总时限。要盖得住最长的正常生成：项目规划器首稿一次输出约 64k token（含推理），
 * 从开始规划到这一笔落账约 10–11 分钟。给到 30 分钟（约 3 倍），免得厂商慢一点就把正常的长生成掐掉、白白重试花钱。
 * 超时按网络失败处理（可重试，见 client.mjs）。
 */
export const LLM_TIMEOUT_MS = 30 * 60_000;
/** 生效值：环境变量 SUPERINTERN_LLM_TIMEOUT_MS 可改（毫秒；慢的自建网关、或测试里调短）。每次调用现读。 */
export const llmTimeoutMs = () => Number(process.env.SUPERINTERN_LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS;

/** 给 fetch 的 init 加上时限（调用方自己给了 signal 就不覆盖）。 */
export const withTimeout = (init = {}, ms = HTTP_TIMEOUT_MS) => ({ ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
