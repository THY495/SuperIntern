// 场景集合并时用的执行器：宿主上直接跑（不起容器）。带 workerSpec：守护进程把项目推进放到 worker 线程时
// （core/offthread.mjs），worker 按它重新 import 出同一个工厂。
import { LocalExecutor } from '../../src/core/executor.mjs';

export const makeHostExec = Object.assign(async () => new LocalExecutor(), { workerSpec: { module: import.meta.url, export: 'makeHostExec' } });
