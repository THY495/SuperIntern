// 验收员看运行中的应用：给验收员的浏览器工具。
//
// 会话（起服务、起浏览器、收尾还原）在 core/live-app.mjs；这里只管"模型看到什么工具、工具结果写成什么样"。
// 点、填、选会改应用里的数据 —— 那是在沙箱里、验收完整体还原，验收员仍然不能写文件、不能跑命令。
// 截图只给收图的模型（目录里 vision: true）；不收图的模型只有文字版的页面，工具都不给它，免得它白调。

const PAGE_HINT = '返回页面文字与带编号的控件清单；后面 click / type_text 用编号或控件上的文字指定控件。';
// 动作引起的弹框（删除前的"确定删除吗？"之类）按 on_dialog 处理，结果里写弹了什么（原来弹框一出页面就卡死）
const ON_DIALOG = { type: 'string', enum: ['accept', 'dismiss'], description: '这一下如果弹出确认框 / 提示框：accept = 点「确定」（默认），dismiss = 点「取消」' };

export function liveTools({ vision = false } = {}) {
  const tools = [
    { name: 'open_page', description: `打开应用里的一页；再打开同一页就是刷新（看数据是否存下来了）。第一次调用会先把应用启动起来（可能要等一两分钟）。${PAGE_HINT}`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: '页面路径，如 / 或 /todos' } }, required: ['path'] } },
    { name: 'read_page', description: `重新看当前页面。${PAGE_HINT}`,
      parameters: { type: 'object', properties: { selector: { type: 'string', description: '可选：CSS 选择器，只看这一块的文字' } } } },
    { name: 'click', description: '点一个控件（按钮、链接、复选框……），返回点完之后的页面。弹出的确认框按 on_dialog 处理，结果里写弹了什么。',
      parameters: { type: 'object', properties: { target: { type: 'string', description: '控件编号（read_page 给的），或控件上的文字' }, on_dialog: ON_DIALOG }, required: ['target'] } },
    { name: 'type_text', description: '在输入框里填字（先清空原有内容），返回填完之后的页面。',
      parameters: { type: 'object', properties: { target: { type: 'string', description: '控件编号或控件上的文字 / 占位提示' }, text: { type: 'string' },
        press_enter: { type: 'boolean', description: '填完按回车（提交表单）' }, on_dialog: ON_DIALOG }, required: ['target', 'text'] } },
    { name: 'select_option', description: '在下拉框里选一项，返回选完之后的页面。',
      parameters: { type: 'object', properties: { target: { type: 'string', description: '控件编号或控件上的文字' }, value: { type: 'string', description: '选项的值或显示文字' }, on_dialog: ON_DIALOG }, required: ['target', 'value'] } },
  ];
  if (vision) tools.push({ name: 'screenshot', description: '截当前页面的图（一次验收至多 6 张）。看布局、样式、图表这类文字里看不出来的东西时用；文字内容用 read_page 就够了。',
    parameters: { type: 'object', properties: { full_page: { type: 'boolean', description: '截整页（默认只截一屏）' } } } });
  return tools;
}

export const LIVE_TOOL_NAMES = new Set(['open_page', 'read_page', 'click', 'type_text', 'select_option', 'screenshot']);

/** 驱动返回的页面概况 → 给模型看的文字 */
export function renderPage(r, { action = null } = {}) {
  if (!r?.ok) return `没做成：${r?.error ?? '未知原因'}`;
  const p = r.page ?? {};
  const lines = [];
  if (action) lines.push(action);
  for (const d of r.dialogs ?? []) {
    const kind = { alert: '提示框', confirm: '确认框', prompt: '输入框', beforeunload: '离开页面的确认' }[d.type] ?? '弹框';
    lines.push(`页面弹出了${kind}「${d.message}」，${d.answered === 'dismiss' && d.type !== 'alert' ? '点了「取消」' : '点了「确定」'}。`);
  }
  if (r.reopened) lines.push(`（上一步之后页面弹出了一个框、当时没人接，页面因此卡住；已经关掉重开了 ${r.reopened.url || '这一页'} —— 页面上没提交的输入会丢）`);
  lines.push(`当前页面：${p.title ? `「${p.title}」` : '（无标题）'} ${p.url ?? ''}${r.status ? `（HTTP ${r.status}）` : ''}${r.screen ? ` [画面 #${r.screen}]` : ''}`);
  if (r.navigated) lines.push(`（点完跳到了 ${r.navigated}）`);
  if (p.controls?.length) {
    lines.push('控件：');
    for (const c of p.controls) {
      const kind = { link: '链接', button: '按钮', select: '下拉框', textarea: '多行输入框', checkbox: '复选框', radio: '单选', submit: '提交按钮' }[c.kind] ?? `输入框(${c.kind})`;
      const extra = [c.value !== undefined && c.kind !== 'select' ? `= "${c.value}"` : '', c.kind === 'select' ? `= ${c.value}（可选：${(c.options ?? []).join(' / ')}）` : '',
        c.checked !== undefined ? (c.checked ? '已勾' : '未勾') : '', c.disabled ? '（不可用）' : ''].filter(Boolean).join(' ');
      lines.push(`  ${c.n} ${kind}${c.label ? `「${c.label}」` : ''}${extra ? ` ${extra}` : ''}`);
    }
  } else lines.push('控件：（没有可操作的控件）');
  if (r.errors?.length) lines.push(`页面上的程序报错：\n  ${r.errors.join('\n  ')}`);
  if (r.failed?.length) lines.push(`失败的请求：\n  ${r.failed.map((f) => `${f.request} → ${f.status ?? f.error}`).join('\n  ')}`);
  if (p.found === false) lines.push('（选择器没找到元素）');
  else lines.push(`页面文字${p.truncated ? '（太长，只给前一部分）' : ''}：\n${p.text || '（空白）'}`);
  return lines.join('\n');
}

const dialogOf = (v) => (v === 'dismiss' ? 'dismiss' : 'accept');

/** 工具处理器。live = core/live-app.mjs 的 LiveApp（或测试里同形的假对象） */
export function liveHandlers(live) {
  return {
    open_page: async ({ path }) => renderPage(await live.drive({ cmd: 'open', url: live.url(path) })),
    read_page: async ({ selector } = {}) => renderPage(await live.drive({ cmd: 'read', selector: selector || null })),
    click: async ({ target, on_dialog }) => renderPage(await live.drive({ cmd: 'click', target: String(target), dialog: dialogOf(on_dialog) }), { action: `点了「${target}」。` }),
    type_text: async ({ target, text, press_enter, on_dialog }) => renderPage(await live.drive({ cmd: 'type', target: String(target), text: String(text ?? ''), enter: !!press_enter, dialog: dialogOf(on_dialog) }),
      { action: `在「${target}」里填了「${String(text ?? '').slice(0, 60)}」${press_enter ? '并按了回车' : ''}。` }),
    select_option: async ({ target, value, on_dialog }) => renderPage(await live.drive({ cmd: 'select', target: String(target), value: String(value ?? ''), dialog: dialogOf(on_dialog) }), { action: `在「${target}」里选了「${value}」。` }),
    screenshot: async ({ full_page } = {}) => {
      const r = await live.screenshot({ full: !!full_page });
      if (!r.ok) return `没截成：${r.error}`;
      return { text: `当前页面 ${r.url} 的截图${full_page ? '（整页）' : ''}：`, images: [{ mediaType: r.mediaType, data: r.data }] };
    },
  };
}
