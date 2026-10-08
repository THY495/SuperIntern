// 英文目录：内容 3。键是中文原文（逐字），值是英文。占位符 {名字} 两边一致。
export default {
  // ── src/core/project.mjs ──
  '、': ', ',
  '；': '; ',
  '无（不等其他任务）': 'none (does not wait for other tasks)',
  '；并让 {list} 等本任务完成后再开工': '; and {list} will wait for this task to finish before starting',
  '⚠ 范围重叠（机械检查，零模型）：下面 {n} 对任务在依赖图上互不可达 —— 按上面那条调度规则，它们**可能同时开着**，而它们声明要动同一处。':
    '⚠ Scope overlap (mechanical check, no model): the {n} pair(s) of tasks below cannot reach each other in the dependency graph — under the scheduling rule above they **may be open at the same time**, and they declare they will change the same place.',
  '  - #{a}「{aTitle}」与 #{b}「{bTitle}」都声明要动：{where}': '  - #{a} "{aTitle}" and #{b} "{bTitle}" both declare they will change: {where}',
  '  同时改同一处 = 合并时大概率冲突，而解冲突要回头问你取哪一侧。要不要现在就处理？**在反馈里回一句就行**：':
    '  Changing the same place at the same time = a likely conflict at merge time, and resolving it means coming back to ask you which side to take. Want to deal with it now? **Just say so in your feedback**:',
  '    · 「把 #{b} 对 {where} 的改动并进 #{a}」—— 让一个任务负责那一处（最常用）': '    · "Fold #{b}\'s changes to {where} into #{a}" — one task owns that place (most common)',
  '    · 「#{b} 依赖 #{a}」—— 排成先后，就不会同时开着（代价：不能让路了）': '    · "#{b} depends on #{a}" — put them in order so they are never open at the same time (cost: one can no longer go ahead while the other waits on you)',
  '    · 「知道了，就这样」—— 接受这个风险；真撞上了会按冲突那条路来问你取哪一侧': '    · "Got it, leave it as is" — accept the risk; if they really do collide, you will be asked which side to take through the conflict path',
  '未限定': 'unrestricted',
  '--empty 与 --source 只能给一个': 'Give only one of --empty and --source',
  '要给 --source（项目仓库：本机路径或 URL）或 --empty（从零开始）': 'Give --source (the project repository: a local path or URL) or --empty (start from scratch)',
  '仓库克隆失败：{detail}': 'Failed to clone the repository: {detail}',
  '项目 JSON 不合规：\n  - {errs}': 'The project JSON is invalid:\n  - {errs}',
  '没有这个项目：{id}': 'No such project: {id}',
  '复盘被搁置：全部任务已合并，但没有宣布达成。项目等人：添加任务 / 宣布达成 / 中止项目':
    'Project review set aside: all tasks are merged, but the project was not declared done. The project is waiting on people: add tasks / declare it done / abort the project',
  '唯一的任务在草案阶段被放弃': 'The only task was abandoned at the draft stage',
  '剩下的任务都被已中止的任务卡住；项目等人：恢复 / 重做该任务，或中止项目':
    'The remaining tasks are all blocked by an aborted task; the project is waiting on people: resume / redo that task, or abort the project',
  '{file}（{how}）': '{file} ({how})',
  '项目分支 {branch} 无法快进到 {taskBranch}（{detail}）—— 任务分支不是从项目分支当前头起的？':
    'The project branch {branch} cannot fast-forward to {taskBranch} ({detail}) — was the task branch not started from the current head of the project branch?',
  '项目已中止且没有任何已合并的任务，没有可交付的内容': 'The project was aborted and has no merged tasks; there is nothing to deliver',
  '项目状态是 {status}，只交付已完成的项目，或已中止但有已合并任务的项目': 'The project status is {status}; only done projects, or aborted projects with merged tasks, can be delivered',
  '要给 --remote <url>：项目分支推到哪里。不默认取源仓库 —— 那可能是别人的仓库':
    'Give --remote <url>: where to push the project branch. It does not default to the source repository — that may be someone else\'s repository',
  '还有 {n} 个任务的签收被后置了（自动挡下 AI 自己加的）：{list}。交付前要一次签掉：命令行加 --accept-pending，或先 node src/cli.mjs project signoff {id} --accept-all':
    '{n} task(s) still have deferred sign-offs (added by the AI itself in auto mode): {list}. Sign them all off before delivering: add --accept-pending on the command line, or first run node src/cli.mjs project signoff {id} --accept-all',
  '远端不是 GitHub（{remote}），已推送，未创建 PR': 'The remote is not GitHub ({remote}); pushed, but no PR was created',
  '未设置 GITHUB_TOKEN：已推送，未创建 PR。在 .env 中设置后重新交付即可': 'GITHUB_TOKEN is not set: pushed, no PR opened. Set it in .env and deliver again',
  '{order}. **{title}**（`{id}`）\n   {summary}': '{order}. **{title}** (`{id}`)\n   {summary}',
  '> 项目已中止：本次只交付已签收并合并的第 1–{merged} 个任务（共 {total} 个）。\n\n':
    '> The project was aborted: this delivery only includes tasks 1–{merged}, which were signed off and merged ({total} in total).\n\n',
  '## 任务': '## Tasks',
  '由 SuperIntern 交付：项目 `{id}`，分支 `{branch}` @ {head}。摘要取自各任务真相源里的终版汇报。':
    'Delivered by SuperIntern: project `{id}`, branch `{branch}` @ {head}. The summaries come from each task\'s final report in the source of truth.',
  '开 PR 失败：HTTP {status} {body}': 'Failed to open the PR: HTTP {status} {body}',
  '读仓库信息失败：HTTP {status} {body}': 'Failed to read the repository info: HTTP {status} {body}',
  '项目里没有任何任务，无处建验收工作区': 'The project has no tasks, so there is nowhere to set up the acceptance workspace',
  '环境准备命令失败，验收命令没有跑：': 'An environment setup command failed, so the acceptance command did not run:',
  '（输出共 {total} 行，这里是最后 {kept} 行，不是全部）': '(The output has {total} lines; these are the last {kept}, not all of it)',
  '验收没能跑起来：{error}': 'The acceptance check could not run: {error}',
  '项目「{title}」的全部任务都已合并，你也确认了达成，但项目级验收命令没过。':
    'All tasks of project "{title}" are merged and you confirmed it is done, but the project-level acceptance command failed.',
  '命令：{cmd}（在项目分支的一个干净克隆里跑）': 'Command: {cmd} (run in a clean clone of the project branch)',
  '退出码：': 'Exit code: ',
  '（没跑起来）': '(did not run)',
  '（超时）': ' (timed out)',
  '输出尾部：': 'Output tail:',
  '（空）': '(empty)',
  '项目**没有**转为已完成。这条事项是系统按规则直接生成的，没有经过 AI。': 'The project has **not** been marked done. This item was generated directly by the system from rules, without going through the AI.',
  '请选一条：': 'Please pick one:',
  '(A) 加一个任务把它修好：到项目页「添加任务」，把上面的输出尾部贴进去（在这条里回复不会替你加任务）；新任务合并之后系统会再复盘、再跑这条验收':
    '(A) Add a task to fix it: on the project page use "Add task" and paste in the output tail above (replying here will not add a task for you); once the new task is merged, the system reviews the project again and re-runs this acceptance check',
  '(B) 验收命令本身不对：到「项目设置 → 自动化」改项目级验收命令，然后回这条「再跑一次」—— 系统用新命令重新验收，过了就宣布完成':
    '(B) The acceptance command itself is wrong: change the project-level acceptance command in "Project settings → Automation", then reply "retry" to this item — the system re-runs the acceptance check with the new command and declares the project done if it passes',
  '(C) 这条验收不该拦：到「项目设置 → 自动化」清空项目级验收命令，然后回「再跑一次」（清空后"达成"就完全由人宣布，没有机械核实）':
    '(C) This acceptance check should not block: clear the project-level acceptance command in "Project settings → Automation", then reply "retry" (once it is cleared, "done" is declared entirely by people, with no mechanical check)',
  '批量签收要说明是谁签的': 'A batch sign-off must say who is signing',
  '这个任务这一侧': 'this task\'s side',
  '项目分支那一侧': 'the project branch\'s side',
  '工作区不在了，没法集成': 'The workspace is gone, so it cannot be integrated',
  '取项目分支失败：{error}': 'Failed to fetch the project branch: {error}',
  '集成项目分支 {head}': 'Integrate project branch {head}',
  '（按你选的「{side}」机械解冲突没成功：{error}）': '(Mechanically resolving the conflicts with "{side}", as you chose, did not work: {error})',
  '集成之后按此刻已合并的任务重算回归义务': 'After integration, the regression checks were recomputed from the tasks merged so far',
  '这个任务没有验收命令，集成后无从重跑': 'This task has no acceptance command, so there is nothing to re-run after integration',
  '集成后的重跑没能跑起来：{error}': 'The re-run after integration could not run: {error}',
  '#{order} 合并时记下的头接不上前一个（老项目或手工改过）': 'the head recorded when #{order} was merged does not follow from the previous one (an old project, or edited by hand)',
  '读不到 #{order} 那一段的提交': 'cannot read the commits for #{order}',
  '%h %an：%s': '%h %an: %s',
  '任务 #{order}「{title}」（{files}{signer}）': 'task #{order} "{title}" ({files}{signer})',
  '，由{name}签收': ', signed off by {name}',
  '项目分支上已经合并、已经各自签过收的那些任务（算不出具体是哪一个）': 'the tasks already merged into the project branch, each already signed off (cannot tell exactly which one)',
  '任务 #{order}「{title}」合不进项目分支：{why}。': 'Task #{order} "{title}" cannot be merged into the project branch: {why}.',
  '合并有冲突': 'the merge has conflicts',
  '合并之后重跑验收没过': 'the acceptance re-run after merging failed',
  '原因：这个任务开工之后，项目分支上又合并了别的任务（现在是 {head}）。系统已经机械地把项目分支合进它的分支':
    'Cause: after this task started, other tasks were merged into the project branch (it is now at {head}). The system mechanically merged the project branch into this task\'s branch',
  '，但有冲突，已回滚到合并前的状态：': ', but there were conflicts, so it rolled back to the state before the merge:',
  '冲突文件：': 'Conflicting files: ',
  '（拿不到清单）': '(could not get the list)',
  '撞在一起的是这几行：': 'These are the lines that collided:',
  '两侧分别是谁的：': 'Whose each side is:',
  '　　**任务 #{order} 这一侧**（`<<<<<<< HEAD` 那一段）= 「{title}」': '　　**Task #{order}\'s side** (the `<<<<<<< HEAD` part) = "{title}"',
  '，还没有人签收过': ', not signed off by anyone yet',
  '　　**项目分支这一侧**（`>>>>>>> {head}…` 那一段）= {owners}': '　　**The project branch\'s side** (the `>>>>>>> {head}…` part) = {owners}',
  '并重跑了它的验收命令与全部回归义务，其中一条没过：': ' and re-ran its acceptance command and all regression checks; one of them failed:',
  '命令：': 'Command: ',
  '（没能跑起来）': '(could not run)',
  '（这是回归义务里的，不是它自己那条）': ' (this is one of the regression checks, not its own command)',
  '任务没有合并，产物原样留着；项目分支不前进就不会再试一次。本事项由系统直接生成，未调用模型。':
    'The task was not merged and its output is left as is; it will not be retried until the project branch moves. This item was generated directly by the system, without calling a model.',
  '请选一条（答复里写 A、B 或 C 就行）：': 'Please pick one (just write A, B or C in your reply):',
  '请选一条（答复里写 A、B、C 或 D 就行）：': 'Please pick one (just write A, B, C or D in your reply):',
  '(D) **两边都保留新增的内容** —— 这次的 {total} 处冲突里有 {n} 处是两边在同一位置各自新加了行（例如各自追加了测试用例）：这几处两边都留下，项目分支的在前；':
    '(D) **Keep what both sides added** — {n} of the {total} conflicts here are places where each side added new lines at the same spot (for example, each appended test cases): both are kept there, the project branch\'s first;',
  '　　其余的冲突处取项目分支这一侧（同 B）。之后同样重跑验收。':
    '　　the remaining conflicts take the project branch\'s side (as in B). The acceptance checks are re-run afterwards as well.',
  '⚠ 选 A、B 或 D 之后，合并出来的是一份**谁都还没签过字的新状态**，所以会重新找你签收一次；':
    '⚠ After you pick A, B or D, the merged result is a **new state nobody has signed off yet**, so you will be asked to sign off again;',
  '⚠ 粒度：A、B 是"全部冲突文件一起取一侧"；D 只认得"两边都是新增"这一种块。如果两处冲突要往别的方向定，那就是 (C)。':
    '⚠ Granularity: A and B take one side for all conflicting files together; D only recognises spots where both sides added lines. If conflicts need to go some other way, that is (C).',
  '两边都保留新增内容': 'keep what both sides added',
  '(A) **取任务 #{order} 这一侧** —— 冲突的每一处都按它的写法定。系统会重做一次合并、只在冲突处取这一侧':
    '(A) **Take task #{order}\'s side** — every conflict is settled its way. The system redoes the merge and takes this side only where there are conflicts',
  '　　（同一个文件里没冲突的部分照常合并，不受影响），然后重跑它自己的验收命令与全部回归义务。':
    '　　(parts of the same file without conflicts are merged as usual and are not affected), then re-runs its own acceptance command and all regression checks.',
  '(B) **取项目分支这一侧** —— 冲突的每一处都按项目分支上已有的写法定。其余同 (A)。':
    '(B) **Take the project branch\'s side** — every conflict is settled the way it already is on the project branch. Otherwise the same as (A).',
  '(C) **两边都不对** —— 系统不动手。出路是在项目页加一个任务去修这一处，或者中止这个任务（都得你自己去点）。':
    '(C) **Neither side is right** — the system does nothing. The way out is to add a task on the project page to fix this spot, or to abort this task (you have to click either yourself).',
  '⚠ 选 A 或 B 之后，合并出来的是一份**谁都还没签过字的新状态**，所以会重新找你签收一次；':
    '⚠ After you pick A or B, the merged result is a **new state nobody has signed off yet**, so you will be asked to sign off again;',
  '　那一次只给你看这一轮真正变了什么，集成带进来的别人的产物会单独列出来、不混在里面。':
    '　that time you only see what really changed in this round; other people\'s output brought in by the integration is listed separately, not mixed in.',
  '⚠ 重跑验收拦得住"合起来跑不起来"，**拦不住这一侧在语义上选错了** —— A/B 是一次取舍，不是一道审批。':
    '⚠ The acceptance re-run catches "it does not run once merged", **not picking the semantically wrong side** — A/B is a trade-off, not an approval.',
  '⚠ 粒度是"全部冲突文件一起取一侧"，没有逐块挑。如果两处冲突要往不同方向定，那就是 (C)。':
    '⚠ The granularity is "one side for all conflicting files together"; there is no picking hunk by hunk. If two conflicts need to go different ways, that is (C).',
  '(A) 让它自己改：**直接在下面写下要它怎么改**。你写的那段会原样当成打回理由发给它，':
    '(A) Let it fix this itself: **write below how it should change it**. What you write is sent to it verbatim as the send-back reason;',
  '　　任务重新开工，改完再签收 —— 和手敲 node src/cli.mjs signoff {id} --reject "…" 是同一条路，不用再去敲命令。':
    '　　the task restarts and comes back for sign-off when done — the same path as typing node src/cli.mjs signoff {id} --reject "…" by hand, with no command needed.',
  '(B) 先看清楚：到任务页看「改动」「活动」和「日志」，看完再回来选': '(B) Look first: check "Changes", "Activity" and "Log" on the task page, then come back and pick',
  '(C) 这个任务不要了：在项目页中止它（它的下游会跟着停，项目会转停滞等你处理）。这一步不可逆，答复里写"中止"不算数，得你自己去点。':
    '(C) Drop this task: abort it on the project page (the tasks downstream of it stop too, and the project becomes stalled until you deal with it). This cannot be undone; writing "abort" in a reply does not count — you have to click it yourself.',
  '答复不是"再跑一次"：加任务要到项目页「添加任务」，改 / 清验收命令要到项目设置':
    'The reply is not "retry": add tasks with "Add task" on the project page; change / clear the acceptance command in project settings',
  '答复是(C)两边都不对：出路是加任务去修或中止，都要人自己去点': 'The reply was (C) neither side is right: the way out is to add a task to fix it or to abort, and a person has to click either',
  '答复不是 A/B/C 里的任何一条，系统不猜一侧': 'The reply is none of A/B/C; the system does not guess a side',
  '答复要求中止，这一步不可逆，留给人在项目页做': 'The reply asks to abort; that cannot be undone, so it is left for a person to do on the project page',
};
