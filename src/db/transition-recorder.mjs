// 状态迁移的普查（开发用）。设了环境变量 SUPERINTERN_RECORD_TRANSITIONS=<文件> 时，openDb 给每个
// 带状态的表挂上 TEMP 触发器（只在这个连接里、不落库），每发生一次状态变化 / 带状态插入就往文件追加一行
// "表<TAB>旧状态<TAB>新状态"。全套测试带着它跑一遍，就得到代码里实际发生过的全部迁移 —— 状态机的允许表照它定，
// 不靠读 95 处 UPDATE 去猜（漏一条，库层的迁移守卫就会在生产上把那条路径直接拦死）。

import { appendFileSync } from 'node:fs';

export const STATEFUL = ['tasks', 'nodes', 'questions', 'projects', 'revisions', 'handover_requests', 'decision_registry'];

export function recordTransitions(raw, file) {
  raw.function('si_rec_transition', (table, from, to) => { appendFileSync(file, `${table}\t${from ?? '∅'}\t${to}\n`); return null; });
  for (const t of STATEFUL) {
    // 迁移测试会打开停在老版本的库：那时还没有的表跳过
    if (!raw.prepare(`SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?`).get(t)) continue;
    raw.exec(`CREATE TEMP TRIGGER IF NOT EXISTS si_rec_upd_${t} AFTER UPDATE OF status ON main.${t}
      WHEN OLD.status IS NOT NEW.status BEGIN SELECT si_rec_transition('${t}', OLD.status, NEW.status); END;
      CREATE TEMP TRIGGER IF NOT EXISTS si_rec_ins_${t} AFTER INSERT ON main.${t}
      BEGIN SELECT si_rec_transition('${t}', NULL, NEW.status); END;`);
  }
}
