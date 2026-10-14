// ── 待决事项 ─────────────────────────────────────────────────────
// 只写"需 2 人表态，已有 0 人；1 人弃权，人数已重算"，读的人分不清那个 2 是重算前还是重算后的。
// 改成直接写**还差谁**——具体的名字不会有歧义，也省掉读者自己做减法。
/** 只是顺带收到的人（达成确认按目录发给了各段的人，但只有整个项目那一段计数）—— 能补充，但不欠这一票、不拍板。与 answers.mjs 同一口径。 */
function sideOnlyOf(q) {
  const rows = q.route?.rows ?? [];
  const counted = new Set(rows.filter((r) => !r.advisory).flatMap((r) => r.recipients ?? []));
  return new Set(rows.filter((r) => r.advisory).flatMap((r) => r.recipients ?? []).filter((u) => !counted.has(u)));
}
function quorumText(q) {
  const rows = q.route?.rows ?? [];
  if (!rows.length) return '';
  const acted = new Set(q.answers.filter((a) => ['answer', 'agree'].includes(a.stance) && a.userId).map((a) => a.userId));
  const parts = rows.map((row) => {
    // 自己提的计划变更：提出人的席位不算（与后端结算同一口径）
    const r = q.selfExcluded ? { ...row, recipients: row.recipients.filter((u) => u !== q.selfExcluded.userId) } : row;
    if (!r.recipients.length && row.recipients.length) return '';
    const need = r.quorum === 'all' ? r.recipients.length : Math.min(Number(r.quorum), r.recipients.length || Number(r.quorum));
    if (need <= 1) return '';
    const missing = r.recipients.filter((u) => !acted.has(u)).map((u) => esc(nameOf(u)));   // 这一行是按 HTML 插的，名字要转义
    const have = r.recipients.length - missing.length;
    // 只写"还差谁"会把规则藏起来（为什么一条是"任意 1 人"、另一条是"都要"？）——
    // 需要几个人来自决策路由，剩下几个人是它减去已表态的，两个数都写出来才看得出是怎么算的。
    // 分段会签时有好几行：不标是哪一段，读的人会把"还差甲""还差乙"读成"两人里随便谁"
    const seg = rows.length > 1 && r.scope && r.scope !== '*' ? T('「{scope}」那一段', { scope: esc(r.scope) }) : '';
    const from = T('{seg}需 {need} 人表态（人数由决策路由定）', { seg, need });
    if (have >= need) return q.status === 'escalated' ? T('{from}，{need} 人都已表态，但立场不一致', { from, need }) : T('{from}，{need} 人都已表态', { from, need });
    const gap = need - have;
    return missing.length > gap
      ? T('{from}，已有 {have} 人，还差 {gap} 人：{names} 中的任意 {gap} 人', { from, have, gap, names: missing.join(T('、')) })
      : T('{from}，已有 {have} 人，还差 {gap} 人：{names}（这几位都要）', { from, have, gap, names: missing.join(T('、')) });
  }).filter(Boolean);
  // 两条额外规则：别人提的需求的签收必须有提出人那一票；自己提的计划变更自己批不算。
  const live = ['open', 'escalated'].includes(q.status);
  const sideAll = sideOnlyOf(q);
  const deciders = [...new Set(rows.filter((r) => !r.advisory).flatMap((r) => r.recipients ?? []))].map((u) => esc(nameOf(u))).join(T('、'));
  if (sideAll.size && live && me && sideAll.has(me.id)) parts.push(T('你是顺带收到的：可以补充还差什么，拍板的是 {deciders}；你回 A、C 不计数', { deciders }));
  else { const side = [...sideAll].filter((u) => !acted.has(u));
    if (side.length && live) parts.push(T('{names} 也收到了这条，可以补充还差什么，不用等 {names}；拍板的是 {deciders}', { names: side.map((u) => esc(nameOf(u))).join(T('、')), deciders })); }
  if (q.mustSign && live) for (const m of q.mustSign) parts.push(acted.has(m.userId) ? T('提需求的 {name} 已签', { name: esc(m.name) })
    : T('这是 {name} 提的需求：必须 {name} 本人签收才算数，别人签了替不了 —— 还差 {name}', { name: esc(m.name) }));
  if (q.selfExcluded && live) parts.push(T('这项变更是 {name} 提的：{name} 自己批准不计入人数，要别人批', { name: esc(q.selfExcluded.name) }));
  if (!parts.length) return '';
  const canAgree = q.answers.some((a) => a.stance === 'answer' && a.userId);
  const gaveUp = q.answers.filter((a) => a.stance === 'abstain' && a.userId).map((a) => esc(a.name));
  // 不变的那半（够数之后会怎样）每条事项重复一遍太吵，收进悬浮。
  // 有顺带段时不拼这一句：拍板的只有那几位，"表态"的说法会让人以为还要等顺带的人
  return [...parts, canAgree && !sideAll.size ? T('表态 = 自己写一条答复，或附议已有的那条') : '',
    gaveUp.length ? T('{names}已弃权，不再计入人数', { names: gaveUp.join(T('、')) }) : ''].filter(Boolean).join(T('；'))
    + ` <span title="${rows.some((r) => r.advisory)
      ? T('拍板的人回「还差东西」：顺带收到的人写的还差什么一起交给 AI，出下一版再来问。拍板的人确认达成或先放着：照他定，顺带收到的人写的不同意见留档，并通知他们')
      : q.decision_type === 'contract_approval'
      // 方案会签：按"批准 / 要改 / 放弃"归并，不按字面
      ? T('人数够了之后（方案会签，按每个人答的是批准、要改还是放弃来算，不看措辞）：都批准 = 这一版生效，各人的保留意见合在一起记下；有人要改 = 把要改的话署名合在一起，出下一版，下一版照样送这几位签；有人放弃、有人不放弃 = 生成一条冲突事项。负责人在这里也只是其中一个签字；要越过别人，把那人的签字位「转交」给自己（等于替那人表了态，最好先问一声）')
      : T('人数够了之后：只有一条答复就照它定案；有两条写法不同的答复（系统按字面看，不判断是不是一个意思）会生成一条冲突事项，双方在那条里协商 —— 附议对方、撤回自己、或各自重申；谈不拢转负责人裁定')}" style="text-decoration:underline dotted;cursor:help">${rows.some((r) => r.advisory) ? T('怎么算？') : T('够数之后？')}</span>`;
}
