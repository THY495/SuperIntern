// 并发冲突：提交时带上"我看到的是什么"，看到的已经变了就拒绝并说清是谁、什么时候改的。
// 走查定的写法：开头先说"没有 X / 已 X"（操作有没有生效），再说是谁，最后说下一步去哪点什么
export default {
  // 拒绝（409 / 不能做）
  '没有转交：你打开这条事项之后，{who} 于 {when} 改了接收人，现在是：{now}。页面已刷新成最新的；现在的接收人已经是你要的，就不用再操作，否则重新点「转交」再选': 'Not handed over: after you opened this item, {who} changed its recipients at {when}; they are now: {now}. The page has been refreshed — if the current recipients are what you wanted, you’re done; otherwise click “Hand over” again and choose',
  '没有保存：「{label}」在你打开之后已被 {who} 于 {when} 改成 {now}。页面已刷新；仍要用你的值，就重新输入并保存（会覆盖 {who} 改的 {now}）': 'Not saved: after you opened the page, {who} changed “{label}” to {now} at {when}. The page has been refreshed; to use your value anyway, enter it again and save (this overwrites the {now} that {who} set)',
  '没有批准：你看过之后，MCP server {name} 又被检查了一次，命令或工具说明和你看过的不一样了。页面已刷新成新的这一版；批准之前 AI 用不到这个 server，看过新的再批准': 'Not approved: after you looked at it, MCP server {name} was checked again and its command or tool descriptions differ from what you saw. The page now shows the new version; the AI can’t use this server until it is approved — review the new version, then approve',
  '没有交付：这个任务正在被处理（AI 在改它，或系统正在把它合并进项目）。等任务页顶上不再显示「在跑」再点交付 —— 交付出去的必须是签收时看过的那一版，不能带上正在改的东西': 'Not delivered: this task is being worked on (the AI is changing it, or the system is merging it into the project). Wait until the top of the task page no longer shows “Running”, then deliver — what goes out must be the version that was signed off, not something mid-change',
  '不能重来：系统正在把这个任务合并进项目，合并之后就不能再从某一步重来了。要改，在项目页用「添加任务…」新加一个任务': 'Can’t redo: the system is merging this task into the project, and once merged it can’t be redone from a step. To change it, use “Add tasks…” on the project page',
  // 生效了，但和别人的改动合在一起
  '已转交给 {name}。{who} 的答复已作废（不在新的接收人里），需要新的接收人重新答': 'Handed over to {name}. The answer from {who} has been voided (not among the new recipients); the new recipients need to answer again',
  '已保存。现在放行的是：{all}。其中 {names} 是你打开这一页之后 {who} 刚放行的，你的保存保留了它；不想放行 {names}，取消勾选后再保存': 'Saved. Now allowed: {all}. Of these, {names} was just allowed by {who} after you opened this page, and your save kept it; to stop allowing {names}, untick it and save again',
  '已签收你看到的 {n} 个任务。另有 {m} 个是你打开这一页之后才做完的，还没有签 —— 页面已刷新，看过再签': 'Signed off the {n} tasks you saw. {m} more finished after you opened this page and are not signed yet — the page has been refreshed; review them before signing',
  // 规划进程之间（命令行 / 审计里看得到）
  '任务 {taskId} 已经有方案了（另一个规划进程先落了库）：这一份不落': 'Task {taskId} already has a plan (another planning process saved first); this one is discarded',
  '规划期间契约改过了（{id} 已被新版本取代）：这一份方案照的是旧契约，不落；重新规划': 'The contract changed during planning ({id} was superseded); this plan follows the old contract and is discarded — plan again',
  '规划期间项目已经出了新一版草案（v{version}）：这一份不落': 'A newer draft (v{version}) of the project was produced during planning; this one is discarded',
};
