// ── 动态 ───────────────────────────────────────────────────────────────
const ACTION_NAMES = { status_changed: T('状态变化'), process_crashed: T('运行进程意外退出（系统已记下，会自动重试）'), question_raised: T('提出事项'), question_answered: T('事项已答复'), answer_recorded: T('记录答复'), answer_overridden: T('负责人修改结论'), conflict_raised: T('答复不一致，生成冲突事项'), conflict_resolved: T('冲突已有结论'), question_transferred: T('事项已转交'), question_rerouted: T('事项已改派'), question_defaulted: T('已按默认处理'), node_done: T('步骤完成'), node_failed: T('步骤失败'), task_done: T('任务完成'), task_delivered: T('已交付'), task_signed_off: T('签收'), signoff_requested: T('待签收'), signoff_voided: T('签收作废（产物已变更）'), limit_breached: T('达到上限，暂停并提问'), limit_set: T('修改上限'), egress_requested: T('请求联网'), egress_allowlist_set: T('修改联网许可'), message_received: T('收到消息'), revision_proposed: T('提出计划变更'), revision_applied: T('计划变更已应用'), revision_rejected: T('计划变更已驳回'), task_paused: T('暂停'), task_resumed: Tc('activity', '继续'), task_aborted: T('中止'), orchestrator_started: T('开始运行'), orchestrator_exit: T('本轮结束'), node_escalated: T('升级模型后重试'), dissent_noted: T('对已决事项的异议'), answer_abstained: T('弃权（这条不归我）'), answer_withdrawn: T('撤回自己的立场'), question_unassigned: T('无人认领，等人处理'), contract_rule_overruled: T('任务说明里有一条被判作废'), message_released: T('消息核对完毕，开始处理'), message_held_for_verdict: T('消息暂不执行，等裁定'), decision_check_done: T('核对了已有决定'), decision_conflict_raised: T('和已有决定对不上，挂了冲突事项'), decision_conflict_resolved: T('决定冲突已有结论'), decision_registered: T('记入已定的约定'), decision_voided: T('约定作废'), preview_captured: T('自动测试通过后截了页面图'), preview_failed: T('页面截图没截出来'), preview_skipped: T('这一轮没改界面，没截页面图'), preview_node_added: T('系统自动加了一步：写页面截图说明（没有它就截不了图）'), preview_seed_node_added: T('系统自动加了一步：给截图准备样例数据（不然截到的是空列表）'), env_setup_done: T('自动装好了依赖'), env_setup_failed: T('自动装依赖失败'), runtime_down: T('沙箱暂时用不了（Docker 没在运行）'), runtime_up: T('沙箱恢复了'), workspace_created: T('建好了工作区'), task_created: T('建了任务'), user_login: T('登录'), task_verify_failed: T('验收没过'), handback_raised: T('卡住了，挂了事项等人拿主意'), handback_answer_abort: T('答复要求中止（要在任务页点）'), workspace_build_output_discarded: T('撤掉了验收留下的构建产物'), advance_retry_requested: T('答复：再试一次'), stall_detected: T('停等报警'), approval_read: T('系统判读了对方案的答复'), approval_confirm_raised: T('挂了【先确认一下】事项（答复以「A」开头又像要改）'), project_append_queued: T('添加任务：已排队'), project_append_queue_dropped: T('排队的需求没能起草'), project_append_requested: T('添加任务'), choices_review_raised: T('AI 自己定的事交给人过目'), choices_kept: T('同意了 AI 定的事'), choices_change_appended: T('要改 AI 定的事（替人添加了任务）'), choices_noted: T('对 AI 定的事补了一句说明'), choices_review_failed: T('AI 自己定的事没能交给人过目'), cosign_merged: T('会签：几个人的答复合在一起'),
  // 活动流里原来还有原始英文动作名（handoff_verified、report_generated……）
  answer_superseded: T('后来的答复取代了前一条'), conflict_escalated: T('冲突转负责人裁定'), contract_register_failed: T('方案没能记进约定清单'), decision_check_failed: T('核对已有决定没跑成'),
  decision_register_failed: T('没能记进约定清单'), draft_abandoned: T('草案放弃'), draft_approved: T('草案已批准'), draft_attempt: T('草案不合规，重出'), draft_proposed: T('出了草案'),
  egress_credential_injected: T('联网时带上了访问凭证'), egress_declined: T('联网没放行'), egress_denied: T('联网被挡'), elicitor_exit: T('追问结束'), elicitor_started: T('开始追问'),
  handback_raise_failed: T('没能挂出事项'), handoff_rejected: T('交接被退回（没过核对）'), handoff_verified: T('交接核对通过'), livelock_detected: T('空转报警'),
  node_aborted: T('步骤中止'), node_crashed: T('步骤中途崩了'), node_priority_set: T('改了步骤优先级'), node_reclaimed: T('收回卡住的步骤'), node_stalled: T('步骤卡住'),
  notification_sent: T('发了通知'), plan_attempt: T('计划不合规，重出'), plan_persisted: T('计划定下了'), planner_exit: T('规划结束'), planner_started: T('开始规划'),
  provider_error: T('模型服务出错'), sandbox_error: T('沙箱出错（不算这一步失败，会自动再试）'), question_escalated: T('事项升级'), question_informed_added: T('加了知会对象'), question_stuck: T('事项没人答，又没有默认做法，只能继续等'),
  replan_attempt: T('改计划重试'), replan_failed: T('改计划没成'), report_generated: T('生成了汇报'), run_launched_from_web: T('从看板启动运行'),
  sandbox_skipped: T('这一轮没用沙箱'), sandbox_started: T('沙箱启动'), sandbox_stopped: T('沙箱关闭'), signoff_deferred: T('这个任务的签收改到交付前一起签（自动挡）'), task_renamed: T('改了标题'), task_reopened: T('恢复任务'),
  project_task_started: T('开工（项目里的任务）'), project_task_merged: T('合进项目分支'), project_task_drift: T('开工时项目里已经合进了别的改动（已提示 AI）'), project_task_integrated: T('集成进项目分支'),
  project_task_integrate_conflict: T('集成时有冲突'), project_task_integrate_verify_failed: T('集成后验收没过'), project_task_redone: T('重做'), project_task_regression_refreshed: T('更新了回归义务'),
  answer_recorded: T('记录答复'), decision_check_done: T('核对了已有决定'), node_diagnosed: T('判了一次收敛情况'), handoff_test_changes: T('交上来的改动里改了测试'),
  context_compacted: T('上下文太长，整理了一次'), context_compaction_failed: T('上下文整理没成（照原样接着做）'), compaction_escalated: T('上下文整理了几次还是不够，转给人') };
// 系统内部的起止记录：默认不列（勾「显示全部」才列）。还没有中文名的动作也算这一类 —— 默认视图里不出现英文。
const ACTIVITY_NOISE = new Set(['sandbox_started', 'sandbox_stopped', 'sandbox_skipped', 'run_launched_from_web', 'elicitor_started', 'elicitor_exit', 'planner_started', 'planner_exit',
  'orchestrator_started', 'orchestrator_exit', 'plan_attempt', 'draft_attempt', 'replan_attempt', 'answer_recorded', 'decision_check_done', 'handoff_verified', 'notification_sent',
  'report_generated', 'question_informed_added', 'project_task_regression_refreshed', 'node_reclaimed', 'egress_credential_injected', 'status_changed', 'node_diagnosed']);
const isNoise = (action) => ACTIVITY_NOISE.has(action) || /_launched_by_daemon$/.test(action) || !ACTION_NAMES[action];
function renderActivity() {
  const items = [];
  for (const a of detail.assumptions) items.push({ ts: a.recorded_at, kind: T('假设'), flag: a.must_disclose === 1 || a.verified_against === 'settled_by_me',
    text: `${a.verified_against === 'settled_by_me' ? T('系统代为决定：') : ''}${T('{key}：{statement}', { key: a.subject_key, statement: a.statement })}${a.verification ? `\n${T('依据：{basis}', { basis: a.verification })}` : ''}` });
  for (const d of detail.decisions) items.push({ ts: d.recorded_at, kind: T('决定'), flag: d.actor_kind === 'agent' && d.layer === 'constitutional', text: `${d.summary}\n${T('理由：{reason}', { reason: d.rationale })}` });
  const skip = new Set(['context_assembled', 'ledger_flushed', 'billed', 'messages_consumed', 'answer_pending_quorum']);
  // 系统内部的起止记录（活动流"信息量太大"）：默认收起，勾「显示全部」才看
  let all = false; try { all = localStorage.getItem('si.activityAll') === '1'; } catch { /* 记不住就默认收起 */ }
  const cb = $('#activityAll'); if (cb) { cb.checked = all; cb.onchange = () => { try { localStorage.setItem('si.activityAll', cb.checked ? '1' : '0'); } catch { /* 同上 */ } renderActivity(); }; }
  for (const a of detail.audits) if (!skip.has(a.action) && (all || !isNoise(a.action))) items.push({ ts: a.ts, kind: ACTION_NAMES[a.action] ?? (/_launched_by_daemon$/.test(a.action) ? T('自动运行拉起') : a.action), flag: ['question_defaulted', 'node_escalated', 'limit_breached', 'handoff_rejected', 'conflict_raised', 'answer_overridden'].includes(a.action),
    // 转交写成一句话（"事项已转交 某人"会被读成"转给了某人"，其实是某人转出去）
    text: a.action === 'question_transferred' ? T('{who} 把这条转交给 {to}，之后由对方来答{why}', { who: a.actor_kind === 'user' ? nameOf(a.actor_id) : T('系统'), to: [].concat(a.payload?.to ?? []).map(nameOf).join(T('、')), why: a.payload?.reason ? T('：{reason}', { reason: a.payload.reason }) : a.payload?.via === 'handover' ? T('（人员交接）') : T('（没写理由）') })
      : `${a.target_type === 'node' ? `[${nodeNo(a.target_id)}] ` : ''}${a.actor_kind === 'user' ? `${nameOf(a.actor_id)}` : ''}${payloadHint(a)}` });
  items.sort((x, y) => y.ts - x.ts);
  $('#activity').innerHTML = items.slice(0, 120).map((i) => `<div class="item ${i.flag ? 'flag' : ''}"><div class="small mute">${T('{t}前', { t: ago(i.ts) })} · ${esc(i.kind)}</div><div class="body small">${esc(i.text)}</div></div>`).join('') || `<span class="mute small">${T('无')}</span>`;
}
const nodeNo = (id) => { const i = detail.nodes.findIndex((n) => n.id === id); return i >= 0 ? T('步骤 {n}', { n: i + 1 }) : id; };
function payloadHint(a) {
  const p = a.payload || {};
  const kt = (n) => `${Math.round((n ?? 0) / 1000)}k`;
  const who = p.role === 'verifier' ? T('验收时：') : '';
  if (a.action === 'context_compacted') return `\n${who}${p.level === 2 ? T('把前面的过程写成了简报（最近两轮原样留着）：{b} → {a} token', { b: kt(p.before), a: kt(p.after) }) : T('清掉了 {n} 段早先的大块工具输出（要时能重读）：{b} → {a} token', { n: p.cleared ?? '?', b: kt(p.before), a: kt(p.after) })}`;
  if (a.action === 'context_compaction_failed') return `\n${who}${({ brief_invalid: T('写出来的简报没过校验，照原样接着做'), no_progress: T('整理后没变小多少，照原样接着做'), too_few_rounds: T('前面的轮数太少，没什么可整理，照原样接着做') })[p.why] ?? p.why}`;
  // 决定冲突的结论在库里是 new / old / none，页面上说人话（'· new' 像没翻译完的内部值）
  const verdict = a.action === 'decision_conflict_resolved' ? ({ new: T('以新为准'), old: T('以旧为准'), none: T('判为不冲突') }[p.verdict] ?? p.verdict) : p.verdict;
  const pick = p.human ?? p.why ?? p.summary ?? verdict ?? p.error ?? (p.reasons ? p.reasons.join(T('；')) : null) ?? (p.defaultAction ? T('默认：{action}', { action: p.defaultAction }) : null) ?? (p.from && p.to ? `${[].concat(p.from).map(nameOf).join(T('、'))} → ${[].concat(p.to).map(nameOf).join(T('、'))}` : null) ?? p.body ?? p.leadBody;
  return pick ? `\n${String(pick).slice(0, 240)}` : '';
}
