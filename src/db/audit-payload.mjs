// 审计 payload 的形状版本。审计轨只增不改，所以某个动作的 payload 形状一旦要变（改键名、拆字段），
// 历史行永远是旧形状 —— 读的人原来只能靠"有没有这个键"去猜。现在每行带 payload_v：
//   - audit() 写当前版本 AUDIT_PAYLOAD_V；
//   - 迁移前写的行、测试里直接 INSERT 的行是 NULL（= 0，"版本号出现之前"），不回填、不改写历史；
//   - 读的时候用 auditPayload(row)：按 UPGRADES 从行的版本逐级升到当前版本，读者只需认识当前形状。
//
// 要改某个动作的 payload 形状时：AUDIT_PAYLOAD_V +1，在 UPGRADES 末尾加一级 { <action>: (p) => 新形状 }，
// 只列形状变了的动作（没列的原样通过）；tests/schema-quality.test.mjs 核"每一级都在、版本号对得上"。

export const AUDIT_PAYLOAD_V = 1;

/**
 * UPGRADES[k]：从版本 k 升到 k+1，按动作名给转换函数。
 * 0 → 1：版本号本身是这一级引入的，形状没有变化。
 * @type {Array<Record<string, (payload: any) => any>>}
 */
export const UPGRADES = [
  {},
];

/**
 * 读一行审计的 payload，并升到当前形状。坏 JSON 返回 {}（审计轨本身有 json_valid 约束，这只兜 v29 之前的库）。
 * @param {{action: string, payload: string|null, payload_v?: number|null}} row
 */
export function auditPayload(row) {
  let p;
  try { p = row.payload ? JSON.parse(row.payload) : {}; } catch { return {}; }
  for (let v = row.payload_v ?? 0; v < AUDIT_PAYLOAD_V; v++) {
    const up = UPGRADES[v]?.[row.action];
    if (up) p = up(p);
  }
  return p;
}
