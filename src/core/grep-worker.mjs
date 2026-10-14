// 在独立线程里跑 agent 给的正则（见 safe-grep.mjs）。主线程给文件内容，这里只做匹配。
import { parentPort, workerData } from 'node:worker_threads';

const { pattern, flags, files, maxHits } = workerData;
const re = new RegExp(pattern, flags);
const hits = [];
outer: for (const { path, text } of files) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) { hits.push(`${path}:${i + 1}:${lines[i].trim().slice(0, 200)}`); if (hits.length >= maxHits) break outer; }
  }
}
parentPort.postMessage(hits);
