// ── 修改溯源：一步的出处 → HTML。追溯框与步骤详情共用 ───────────────────
let PROV_OPEN = false, pendingNode = null;
const provWhen = (ms) => (ms ? fmtWhen(ms) : '');
const provWho = (u) => (u.github ? `${u.name} (@${u.github})` : u.name);
function provApproval(c, autoAdded) {
  if (!c) return T('没有契约');
  const a = c.approval, who = a ? esc(a.by.map(provWho).join(T('、')) || T('（已不在成员表里）')) : '';
  const ver = T('契约第 {v} 版', { v: c.version }) + (c.current ? '' : ` <span class="mute">${T('（之后又改过）')}</span>`);
  if (!a) return `${ver}：${autoAdded ? T('自动挡里 AI 自己加的任务，没有人批，签收在后') : `<span class="bad">${T('没有批准记录')}</span>`}`;
  return `${ver}：${{ approval: T('{who} 于 {at} 在待决事项里批准', { who, at: provWhen(a.at) }), direct: T('{who} 于 {at} 直接批准（在看板或命令行上，没走待决事项）', { who, at: provWhen(a.at) }),
    instruction: T('{who} 于 {at} 发的修正直接生效（没触发批准门）', { who, at: provWhen(a.at) }), inherited: T('沿用第 {v} 版的批准：{who}，{at}', { v: a.fromVersion, who, at: provWhen(a.at) }) }[a.kind] ?? ''}`;
}
const PROV_KIND = { correction: T('修正'), context: T('补充'), answer: T('答复'), instruction: T('指令') };
function provHtml(p) {
  const req = p.requestedBy ?? (p.task.owner ? [p.task.owner] : []);
  const rows = [
    `<div>${provApproval(p.constitution, p.task.autoAdded)}</div>`,
    req.length ? `<div>${T('发起任务：{who}', { who: esc(req.map(provWho).join(T('、'))) })}</div>` : '',
    p.policyText ? `<div>${T('系统按规则加的步骤（不在批准时的计划里）：{why}', { why: esc(p.policyText) })}</div>` : '',
    `<div style="margin-top:6px"><b>${T('落实的条款')}</b> ${hint(T('契约每条都有编号（C1、C2……），文字不变编号就不变。规划时这一步声明了它负责哪几条；写给这一步的要求里引用了哪条契约原文，也自动算上'))}</div>`,
    p.clauses.length ? p.clauses.map((c) => `<div><code>${esc(c.key)}</code> ${esc(c.text)}</div>`).join('') : `<div class="mute">${p.policyText ? T('系统补的步骤不对应具体条款') : T('没有标到具体条款（只依据整版契约）')}</div>`,
    `<div style="margin-top:6px"><b>${T('指令来源')}</b> ${hint(T('谁对这一步下过指令：读进来的补充说明、对这一步提问的答复、改了这一步的修正'))}</div>`,
    p.instructions.length ? p.instructions.map((m) => `<div>${esc(m.senders.map(provWho).join(T('、')))}（${m.question ? T('答“{q}”', { q: esc(m.question.length > 80 ? m.question.slice(0, 80) + '…' : m.question) }) : PROV_KIND[m.kind] ?? esc(m.kind)}，${provWhen(m.at)}）：${esc(m.body.length > 200 ? m.body.slice(0, 200) + '…' : m.body)}</div>`).join('') : `<div class="mute">${p.policyText ? T('没有人的指令，按上面那条规则加的') : T('没有单独的指令，按契约做的')}</div>`,
    p.commits ? `<div style="margin-top:6px"><b>${T('对应提交')}</b> ${hint(T('提交信息里写着这一步 id（node: 行）的提交，最新的在最前；返工过的话，之前几轮的也列在后面'))} ${p.commits.length ? p.commits.map((s) => `<code>${esc(s)}</code>`).join(' ') : `<span class="mute">${T('还没有')}</span>`}</div>` : '',
  ];
  return rows.filter(Boolean).join('');
}
