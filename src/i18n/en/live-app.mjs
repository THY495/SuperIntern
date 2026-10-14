// 验收员看运行中的应用
export default {
  '这一步有界面条目，验收员要照仓库根的 {file} 把应用起起来、在页面上逐条点验，但现在没有这份文件。写一份：start（起后端 / 前端的命令，每条一个后台进程、监听 127.0.0.1）、url（前端地址）、ready（后端一个返回 200 的地址）、seed（可选：样例数据命令）、pages（要看的页）':
    'This step has UI checks: the reviewer starts the app from {file} at the repository root and checks each item on the running page, but the file does not exist. Write one: start (commands that start the backend / frontend, one background process each, listening on 127.0.0.1), url (frontend address), ready (a backend address that returns 200), seed (optional: sample-data commands), pages (pages to look at)',
  '缺 {file}：验收员起不了应用': 'Missing {file}: the reviewer cannot start the app',
  '这一步有界面条目，验收员要照 {file} 把应用起起来，但它写得不对：{error}': 'This step has UI checks and the reviewer starts the app from {file}, but the file is wrong: {error}',
  '应用起来了，但沙箱里的浏览器没起来（镜像里可能没装 chromium）': 'The app started, but the browser in the sandbox did not (the image may not have chromium)',
  '驱动浏览器出错：{msg}': 'Driving the browser failed: {msg}',
  '这次验收的截图已经到 {n} 张上限，改用 read_page 看文字': 'This review has reached its limit of {n} screenshots; use read_page for the text',
  '截图没写出来': 'The screenshot was not written',
  '不在沙箱里跑，起不了应用': 'Not running in a sandbox, so the app cannot be started',
  '仓库根没有 {file}': 'No {file} at the repository root',
  // 看板：步骤详情里的页面点验
  '不对': 'Wrong',
  '没验成': 'Not checked',
  '通过 {n}': '{n} pass',
  '不对 {n}': '{n} wrong',
  '没验成 {n}': '{n} not checked',
  '页面点验': 'Page checks',
  '页面点验 · {n} 条，待点验': 'Page checks · {n}, waiting to be checked',
  'AI 执行器修改中': 'AI executor is fixing it',
  '签收时要你看': 'You check these at sign-off',
  '按代码与测试放行；第 {nums} 条没在页面上验成，没参与判断，留给签收人：任务做完后签收事项会出现在「待决事项」里，签收时请在页面上看一下这几条':
    'Accepted on code and tests; item(s) {nums} could not be checked on the page and did not count — they are left to whoever signs off: when the task is done, a sign-off item appears under Pending decisions; check these on the page then',
  '因第 {nums} 条不对打回，AI 执行器正在改，改完会再验一次': 'Sent back because item(s) {nums} were wrong; the AI executor is fixing it and it will be checked again',
  '打回（原因见下面「打回与诊断」），AI 执行器正在改，改完会再验一次': 'Sent back (see Rejections and diagnosis below); the AI executor is fixing it and it will be checked again',
  '；没验成的第 {nums} 条下一次验收会重试': '; item(s) {nums} that could not be checked will be retried at the next review',
  '第 {n} 次验收 · {verdict} · {at}': 'Review #{n} · {verdict} · {at}',
  '已放行': 'Accepted',
  '没验成的原因：{why}': 'Not checked because: {why}',
  'AI 看到：{what}': 'AI saw: {what}',
  'AI 验收会启动应用，在页面上照下面每一条点一遍、看结果': 'The AI reviewer starts the app and tries each item below on the page',
  '这次没能启动应用（下面几条都因此没验成）：{why}': 'The app could not be started this time (so none of these were checked): {why}',
};
