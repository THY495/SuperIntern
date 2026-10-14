// ── 设置 · 模型（负责人）：模型分配 / 服务商 / 模型列表 ─────────────────────
// 三个分区读同一个 /api/llm；写全走 /api/llm 的动作，每次写完服务端回一份新视图，直接重画。
// 设置页**不跟着 SSE 自动重画**（任务在跑时审计每秒都变，重画会冲掉正在填的表单）：进入设置 / 切分区 / 自己的写动作之后才画。
let llm = null, modelEdit = null, modelFilter = '', listed = null, listFilter = '', epEdit = null;
const EFFORT_NAME = { low: 'low', medium: 'medium', high: 'high' };
// 预设：只是把表单填上，保存前仍可改；地址以各家文档为准
const EP_PRESETS = [
  { id: 'siliconflow', label: T('硅基流动'), adapter: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY' },
  { id: 'dashscope', label: T('阿里云百炼'), adapter: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY' },
  { id: 'ark', label: T('火山方舟'), adapter: 'openai-chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY' },
  { id: 'together', label: 'Together', adapter: 'openai-chat', baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY' },
  { id: 'fireworks', label: 'Fireworks', adapter: 'openai-chat', baseUrl: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
  { id: 'groq', label: 'Groq', adapter: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  { id: 'deepinfra', label: 'DeepInfra', adapter: 'openai-chat', baseUrl: 'https://api.deepinfra.com/v1/openai', keyEnv: 'DEEPINFRA_API_KEY' },
  { id: 'novita', label: 'Novita', adapter: 'openai-chat', baseUrl: 'https://api.novita.ai/v3/openai', keyEnv: 'NOVITA_API_KEY' },
];
const API_FORMAT = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic Messages', gemini: 'Gemini' };
const hint = (t) => `<span class="hint" title="${esc(t)}">i</span>`;
async function llmAct(body, msg) {
  try { const r = await api('/api/llm', { version: llm?.version, ...body }); llm = r.view; if (msg) toast(msg); renderLlm(false); return r.result; }
  catch (e) { toast(e.message, true); throw e; }
}
function llmDots() {
  const n = llm?.binding?.problems?.length ?? 0;
  $('#setDot').textContent = n ? ' ●' : ''; $('#bindDot').textContent = n ? '●' : '';
}
async function renderLlm(reload = true) {
  if (!me || me.role !== 'lead') return;
  if (reload) { try { llm = await api('/api/llm'); } catch (e) { $('#binding').innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; } }
  llmDots(); renderBinding(); renderEndpoints(); renderModels();
}
const fmt$ = (n) => String(Math.round(Number(n) * 1e4) / 1e4);
const shortKey = (m) => m.key.slice(m.key.indexOf('/') + 1);
const price = (p) => (p && p.input != null ? `$${fmt$(p.input)} / $${fmt$(p.output)}` : '');
const epName = (id) => llm.endpoints.find((e) => e.id === id)?.label ?? id;

// ── 服务商 ──
function renderEndpoints() {
  const E = llm.endpoints;
  const rows = E.map((e) => {
    if (e.orphan) return `<tr class="off"><td><b>${esc(e.label)}</b></td><td colspan="3"><span class="pill warn">${T('已移除')}</span> ${T('当前版本已不再内置此服务商，仅保留本地覆盖项。删除时一并删除其下的自定义模型；若仍被模型分配使用，须先更改模型分配。')}</td>
      <td class="act"><button data-eprm="${esc(e.id)}" class="danger">${T('删除')}</button></td></tr>`;
    const tags = [e.enabled ? '' : `<span class="pill">${T('已停用')}</span>`, e.gateway ? `<span class="pill" title="${T('通过一个 API 密钥访问多个上游服务商（如 OpenRouter）')}">${T('聚合网关')}</span>` : '',
      e.billing === 'reported' ? `<span class="pill" title="${T('按每次响应中的 usage.cost 计费，不使用本地单价；响应缺少费用字段时该次调用报错，不按 0 计')}">${T('按响应计费')}</span>` : '',
      e.source === 'user' ? `<span class="pill">${T('自定义')}</span>` : (e.diff && e.diff.length) ? `<span class="pill" title="${esc(e.diff.map((d) => `${esc(d.field)}: ${esc(d.from)} → ${esc(d.to)}`).join(T('；')))}">${T('已修改')}</span>` : ''].filter(Boolean).join(' ');
    return `<tr${e.enabled ? '' : ' class="off"'}>
      <td><b>${esc(e.label)}</b>${e.label !== e.id ? ` <span class="mute small mono">${esc(e.id)}</span>` : ''} ${tags}<br><span class="small mute">${esc(API_FORMAT[e.adapter] ?? e.adapter)} · <span class="mono">${esc(e.baseUrl ?? '')}</span></span></td>
      <td>${e.keyPresent ? `<span class="pill ok">${T('已配置')}</span>` : `<span class="pill warn">${T('未配置')}</span>`} <span class="small mute mono">${esc(e.keyEnv)}</span></td>
      <td class="small">${T('{n} 个模型', { n: esc(e.models) })}${e.boundTiers.length ? ` · ${T('使用中')} <span class="mono">${esc(e.boundTiers.join(' '))}</span>` : ''}</td>
      <td class="small" id="epTest-${esc(e.id)}"></td>
      <td class="act"><button data-eptest="${esc(e.id)}" title="${T('发送一次最小请求（16 tokens）')}">${T('测试')}</button> <button data-epedit="${esc(e.id)}">${T('编辑')}</button></td></tr>`;
  }).join('');
  $('#endpoints').innerHTML = `<table class="rt"><tr><th>${T('服务商')}</th><th>${T('API 密钥')}</th><th>${T('模型')}</th><th></th><th></th></tr>${rows}</table>
    <div class="row" style="margin-top:10px"><button id="epAdd">${T('添加服务商')}</button> <span class="small mute">${T('支持 4 种 API 格式；其他格式（如 Bedrock Converse）需编写适配器')}</span></div>
    <div id="epPanel"></div>`;
  $('#epAdd').onclick = () => { epEdit = { isNew: true, id: '', label: '', adapter: 'openai-chat', baseUrl: '', keyEnv: '', gateway: false, billing: 'computed' }; renderEpPanel(); };
  document.querySelectorAll('button[data-eptest]').forEach((b) => b.onclick = async () => {
    const box = $(`#epTest-${b.dataset.eptest}`); box.textContent = T('测试中…');
    try { const r = await api('/api/llm', { action: 'endpoint_test', id: b.dataset.eptest }); box.innerHTML = r.result.ok ? `<span style="color:var(--ok)">${T('连接正常')}</span>${r.result.model ? ` <span class="mute mono">${esc(r.result.model)}</span>` : ''}` : `<span style="color:var(--bad)">${esc(r.result.message)}</span>`; }
    catch (e) { box.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  });
  document.querySelectorAll('button[data-eprm]').forEach((b) => b.onclick = () => { if (confirm(T('删除此服务商及其下的自定义模型？'))) llmAct({ action: 'endpoint_remove', id: b.dataset.eprm }, T('已删除')).catch(() => {}); });
  document.querySelectorAll('button[data-epedit]').forEach((b) => b.onclick = () => { epEdit = { ...E.find((x) => x.id === b.dataset.epedit), isNew: false }; renderEpPanel(); });
  renderEpPanel();
}
function renderEpPanel() {
  const box = $('#epPanel'); if (!box) return;
  const e = epEdit; if (!e) { box.innerHTML = ''; return; }
  const cur = e.isNew ? null : llm.endpoints.find((x) => x.id === e.id);
  const builtin = cur && cur.source === 'default';
  box.innerHTML = `<div class="item" style="margin-top:10px">
    <div class="row"><b>${e.isNew ? T('添加服务商') : T('编辑 {name}', { name: esc(e.label || e.id) })}</b><span class="grow"></span>
      ${e.isNew ? `<select id="epPreset"><option value="">${T('从预设填充…')}</option>${EP_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select>` : ''}</div>
    ${cur ? `<div class="form" style="margin-top:10px"><label>${T('API 密钥')} ${hint(T('写入仓库根目录的 .env（变量名见下方）；不写入数据库，不回显。对看板进程及此后启动的运行生效，执行中的步骤不受影响'))}</label>
      <div class="row"><input id="epKey" type="password" autocomplete="off" placeholder="${cur.keyPresent ? T('已配置，输入新密钥可替换') : T('输入 API 密钥')}" style="flex:1"> <button id="epKeySave">${T('保存密钥')}</button></div></div>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">` : ''}
    <div class="form"${cur ? '' : ' style="margin-top:10px"'}>
      <label>ID ${hint(T('仅限小写字母、数字、- 和 _；用作模型键的前缀（ID/模型名），保存后不可修改'))}</label><input id="epId" value="${esc(e.id)}" placeholder="siliconflow" ${e.isNew ? '' : 'disabled'}>
      <label>${T('显示名称')}</label><input id="epLabel" value="${esc(e.label === e.id ? '' : (e.label ?? ''))}" placeholder="${T('可选')}">
      <label>${T('API 格式')}</label><select id="epAdapter">${llm.adapters.map((a) => `<option value="${esc(a.id)}"${a.id === e.adapter ? ' selected' : ''}>${esc(API_FORMAT[a.id] ?? a.id)}${a.id === 'openai-chat' ? T('（OpenAI 兼容）') : ''}</option>`).join('')}</select>
      <label>${T('API 地址')}</label><input id="epBase" value="${esc(e.baseUrl ?? '')}" placeholder="https://api.example.com/v1">
      <label>${T('密钥环境变量')}</label><input id="epKeyEnv" value="${esc(e.keyEnv ?? '')}" placeholder="EXAMPLE_API_KEY">
      <details class="span"><summary>${T('高级')}</summary><div class="form" style="margin-top:8px">
        <label>${T('聚合网关')} ${hint(T('通过一个 API 密钥访问多个上游服务商（如 OpenRouter）。启用后请求携带上游偏好，并要求响应包含 usage.cost'))}</label><div><input type="checkbox" id="epGateway" style="width:auto"${e.gateway ? ' checked' : ''}></div>
        <label>${T('计费方式')}</label><select id="epBilling"><option value="computed">${T('按模型单价计算')}</option><option value="reported">${T('按响应中的 usage.cost（仅聚合网关）')}</option></select>
        <label>${T('鉴权头')} ${hint(T('默认由 API 格式决定。以下三项尚未在任何平台验证；已知 Azure OpenAI 的路径结构不同，填写后仍无法连接'))}</label><input id="epAuthHeader" value="${esc(e.authHeader ?? '')}" placeholder="${T('默认')}">
        <label>${T('鉴权前缀')}</label><input id="epAuthPrefix" value="${esc(e.authPrefix ?? '')}" placeholder="${T('默认，如 Bearer ')}">
        <label>${T('模型列表路径')}</label><input id="epModelsPath" value="${esc(e.modelsPath ?? '')}" placeholder="/models">
      </div></details>
    </div>
    <div class="row" style="margin-top:12px"><button id="epSave" class="primary">${T('保存')}</button> <button id="epCancel">${T('取消')}</button><span class="grow"></span>
      ${cur ? `<button id="epToggle" title="${cur.enabled ? T('停用后其模型不可选；被模型分配使用时不能停用') : ''}">${cur.enabled ? T('停用') : T('启用')}</button>` : ''}
      ${cur && !builtin ? `<button id="epRemove" class="danger">${T('删除')}</button>` : cur && cur.overridden ? `<button id="epRemove">${T('恢复默认')}</button>` : ''}</div></div>`;
  const syncBilling = () => { const g = $('#epGateway').checked; $('#epBilling').querySelector('option[value=reported]').disabled = !g; if (!g) $('#epBilling').value = 'computed'; };
  $('#epGateway').onchange = syncBilling; syncBilling(); $('#epBilling').value = e.gateway ? (e.billing ?? 'computed') : 'computed';
  if ($('#epPreset')) $('#epPreset').onchange = () => { const p = EP_PRESETS.find((x) => x.id === $('#epPreset').value); if (!p) return; $('#epId').value = p.id; $('#epLabel').value = p.label; $('#epAdapter').value = p.adapter; $('#epBase').value = p.baseUrl; $('#epKeyEnv').value = p.keyEnv; $('#epGateway').checked = false; syncBilling(); };
  $('#epCancel').onclick = () => { epEdit = null; renderEpPanel(); };
  $('#epSave').onclick = () => { const id = $('#epId').value.trim().toLowerCase();
    llmAct({ action: 'endpoint_save', id, label: $('#epLabel').value.trim() || null, adapter: $('#epAdapter').value, baseUrl: $('#epBase').value.trim(), keyEnv: $('#epKeyEnv').value.trim(),
      authHeader: $('#epAuthHeader').value.trim() || null, authPrefix: $('#epAuthPrefix').value || null, modelsPath: $('#epModelsPath').value.trim() || null, gateway: $('#epGateway').checked, billing: $('#epBilling').value },
    e.isNew ? T('已添加，请继续配置 API 密钥') : T('已保存')).then(() => { epEdit = { ...llm.endpoints.find((x) => x.id === id), isNew: false }; renderEpPanel(); if (e.isNew) $('#epKey')?.focus(); }).catch(() => {}); };
  if (cur) {
    $('#epKeySave').onclick = async () => { const v = $('#epKey').value; if (!v) return toast(T('API 密钥不能为空'), true); $('#epKey').value = ''; await llmAct({ action: 'key_set', id: cur.id, value: v }, T('API 密钥已写入 .env')).catch(() => {}); };
    $('#epToggle').onclick = () => llmAct({ action: 'endpoint_enable', id: cur.id, enabled: !cur.enabled }, cur.enabled ? T('已停用') : T('已启用')).then(() => { epEdit = { ...llm.endpoints.find((x) => x.id === cur.id), isNew: false }; renderEpPanel(); }).catch(() => {});
    if ($('#epRemove')) $('#epRemove').onclick = () => { if (confirm(builtin ? T('恢复为内置默认值？') : T('删除此服务商及其下的自定义模型？'))) llmAct({ action: 'endpoint_remove', id: cur.id }, builtin ? T('已恢复默认') : T('已删除')).then(() => { epEdit = null; renderEpPanel(); }).catch(() => {}); };
  }
}

// ── 模型列表 ──
async function pullList(epId) {
  listed = { epId, loading: true }; listFilter = ''; renderModels();
  try { const r = await api('/api/llm', { action: 'endpoint_models', id: epId }); listed = { epId, ...r.result }; }
  catch (e) { listed = { epId, rows: [], error: e.message }; }
  renderModels();
}
function renderModels() {
  const M = llm.models.filter((m) => !modelFilter || m.vendor === modelFilter || (m.orphan && !modelFilter));
  const effText = (m) => (m.efforts == null ? 'low–high' : m.efforts.length ? m.efforts.join(' / ') : '—');
  const status = (m) => m.boundTiers.length ? `<span class="pill ok">${T('使用中')} <span class="mono">${esc(m.boundTiers.join(' '))}</span></span>`
    : !m.enabled ? `<span class="pill">${T('已停用')}</span>` : m.cannotBind ? `<span class="pill warn" title="${esc(m.cannotBind)}">${esc(m.cannotBind.split(/[，（]/)[0])}</span>` : `<span class="pill">${T('可用')}</span>`;
  const rows = M.map((m) => m.orphan ? `<tr class="off"><td><b class="mono">${esc(shortKey(m))}</b></td><td colspan="6"><span class="pill warn">${T('已移除')}</span> ${T('当前版本已不再内置此模型，仅保留本地覆盖项。若仍被模型分配使用，须先更改模型分配。')}</td>
      <td class="act"><button data-mrm="${esc(m.key)}" class="danger">${T('删除')}</button></td></tr>`
    : `<tr${m.enabled ? '' : ' class="off"'}>
      <td><b class="mono">${esc(shortKey(m))}</b>${m.notes?.length ? ` ${hint(m.notes.map((x) => T(x)).join(' / '))}` : ''}${shortKey(m) !== m.model ? `<br><span class="small mute">${T('模型 ID')} <span class="mono">${esc(m.model)}</span></span>` : ''}</td>
      <td class="small">${esc(epName(m.vendor))}${m.endpointEnabled ? '' : ` <span class="pill">${T('服务商已停用')}</span>`}${m.keyPresent ? '' : ` <span class="pill warn">${T('未配置密钥')}</span>`}</td>
      <td class="num">${m.pricing?.input != null ? `$${fmt$(m.pricing.input)}` : '<span style="color:var(--bad)">—</span>'}</td>
      <td class="num">${m.pricing?.output != null ? `$${fmt$(m.pricing.output)}` : '<span style="color:var(--bad)">—</span>'}</td>
      <td class="num">${m.contextWindow ? esc(m.contextWindow.toLocaleString()) : `<span class="mute" title="${T('未填写，按 150,000 tokens 处理')}">—</span>`}</td>
      <td class="small mono">${esc(effText(m))}</td>
      <td>${status(m)}${m.source === 'user' ? ` <span class="pill">${T('自定义')}</span>` : m.overridden ? ` <span class="pill">${T('已修改')}</span>` : ''}${m.findings.length ? ` <span class="pill warn" title="${esc(m.findings.join('\n'))}">${T('异常 {n}', { n: m.findings.length })}</span>` : ''}</td>
      <td class="act"><button data-medit="${esc(m.key)}">${T('编辑')}</button></td></tr>`).join('');
  const lc = llm.lastCheck;
  const listBox = !listed ? '' : listed.loading ? `<div class="small mute" style="margin-top:10px">${T('正在获取 {name} 的模型列表…', { name: esc(epName(listed.epId)) })}</div>`
    : listed.error ? `<div class="small" style="margin-top:10px;color:var(--bad)">${T('获取失败：{error}', { error: esc(listed.error) })}${listed.noKey ? T('（未配置 API 密钥）') : ''}</div>`
    : `<div class="item" style="margin-top:10px"><div class="row"><b>${esc(epName(listed.epId))}</b> <span class="small mute">${T('{n} 个模型', { n: listed.rows.length })}${listed.rows.some((r) => r.pricing) ? '' : ` · ${T('列表不含单价，添加时需手动填写')}`}</span><span class="grow"></span>
        <input id="listFilter" placeholder="${T('筛选，如 claude')}" value="${esc(listFilter)}" style="width:200px" autocomplete="off"> <button id="listClose" class="ghost small">${T('关闭')}</button></div>
      <div id="listCount" class="small mute" style="margin-top:4px"></div>
      <div id="listRows" class="list" style="max-height:240px;margin-top:6px;gap:2px"></div></div>`;
  const listRowHtml = (r) => `<div class="row small"><span class="mono" style="flex:1;min-width:240px">${esc(r.id)}</span><span class="mute">${r.pricing ? price(r.pricing) : ''}${r.contextWindow ? ` · ${esc(r.contextWindow.toLocaleString())}` : ''}${r.efforts && !r.efforts.length ? ` · ${T('不支持推理强度')}` : ''}${r.expires ? ` · ${T('下线 {date}', { date: esc(r.expires) })}` : ''}</span>${r.inCatalog ? `<span class="pill ok">${T('已添加')}</span>` : `<button data-madd="${esc(r.id)}" class="small">${T('添加')}</button>`}</div>`;
  const LIST_SHOW = 50;
  function renderListRows() {
    const box = $('#listRows'); if (!box || !listed?.rows) return;
    const q = listFilter.trim().toLowerCase();
    const hit = listed.rows.filter((r) => !q || r.id.toLowerCase().includes(q));
    box.innerHTML = hit.slice(0, LIST_SHOW).map(listRowHtml).join('') || `<div class="small mute">${T('无匹配结果')}</div>`;
    $('#listCount').textContent = hit.length > LIST_SHOW ? T('匹配 {n} 个，显示前 {shown} 个', { n: hit.length, shown: LIST_SHOW }) : q ? T('匹配 {n} 个', { n: hit.length }) : '';
    bindListAdd();
  }
  const ed = modelEdit;
  const edReported = !!ed && llm.endpoints.find((e) => e.id === ed.key.slice(0, ed.key.indexOf('/')))?.billing === 'reported';
  const edCur = ed && !ed.isNew ? llm.models.find((m) => m.key === ed.key) : null;
  const ph = edReported ? T('可选') : T('必填（否则不可用）');
  const editBox = !ed ? '' : `<div class="item" style="margin-top:10px"><div class="row"><b>${ed.isNew ? T('添加模型') : T('编辑模型')}</b> <span class="mono mute small">${esc(ed.key)}</span></div>
      <div class="form" style="margin-top:10px">
        <label>${T('模型 ID')}</label><input id="mModel" value="${esc(ed.model ?? '')}">
        <label>${T('单价（USD / 1M tokens）')} ${hint(edReported ? T('此服务商按响应中的 usage.cost 计费，单价可选；填写时输入、输出须同时填写') : T('预算上限按单价计算，未填单价的模型不可用。可先保存，稍后补填；填写时输入、输出须同时填写。缓存单价留空时按输入单价计'))}</label>
        <div class="row small" style="gap:6px 12px">${[['mIn', T('输入'), ed.pricing?.input, ph], ['mOut', T('输出'), ed.pricing?.output, ph], ['mCr', T('缓存读取'), ed.pricing?.cacheRead, T('可选')], ['mCw', T('缓存写入'), ed.pricing?.cacheWrite, T('可选')]].map(([id, lb, v, p]) => `<span class="row" style="gap:4px;flex:1;min-width:120px"><span class="mute" style="white-space:nowrap">${esc(lb)}</span><input id="${esc(id)}" value="${esc(v ?? '')}" placeholder="${esc(p)}"></span>`).join('')}</div>
        <label>${T('上下文窗口')} ${hint(T('单位 tokens。单次请求上限为该值的 75%；留空按 150,000 处理'))}</label><input id="mWin" value="${esc(ed.contextWindow ?? '')}" placeholder="${T('可选，单位 tokens')}">
        <label>${T('推理强度')} ${hint(T('模型支持的 reasoning effort 取值；全部不选表示不支持该参数'))}</label>
        <div class="row">${llm.efforts.map((x) => `<label class="small" style="color:inherit"><input type="checkbox" data-eff="${esc(x)}" style="width:auto"${(ed.efforts == null || ed.efforts.includes(x)) ? ' checked' : ''}> <span class="mono">${esc(x)}</span></label>`).join('')}</div>
      </div>
      <div class="row" style="margin-top:12px"><button id="mSave" class="primary">${T('保存')}</button> <button id="mCancel">${T('取消')}</button><span class="grow"></span>
        ${edCur ? `<button id="mToggle" title="${edCur.enabled ? T('被模型分配使用时不能停用') : ''}">${edCur.enabled ? T('停用') : T('启用')}</button>` : ''}
        ${edCur && edCur.source === 'user' ? `<button id="mRemove" class="danger">${T('删除')}</button>` : edCur && edCur.overridden ? `<button id="mRemove">${T('恢复默认')}</button>` : ''}</div></div>`;
  $('#models').innerHTML = `<div class="row">
      <select id="mFilter" aria-label="${T('服务商')}"><option value="">${T('全部服务商')}</option>${llm.endpoints.filter((e) => !e.orphan).map((e) => `<option value="${esc(e.id)}"${modelFilter === e.id ? ' selected' : ''}>${esc(e.label)}</option>`).join('')}</select>
      <button id="mPull" title="${T('调用所选服务商的模型列表接口')}">${T('获取模型列表')}</button>
      <button id="mNew">${T('手动添加')}</button>
      <span class="grow"></span>
      <span class="small mute">${lc ? `${T('上次核对 {ago}前', { ago: ago(lc.at) })} · ${lc.warnings ? T('{n} 项异常', { n: esc(lc.warnings) }) : T('无异常')}${lc.fetchErrors ? ` · ${T('{n} 个服务商连接失败', { n: esc(lc.fetchErrors) })}` : ''}` : T('尚未核对')}</span>
      <button id="mCheck" title="${T('对照各服务商的模型列表与 OpenRouter 公开价格，检查模型是否仍在列表中、单价与上下文窗口是否一致。仅报告，不修改')}">${T('核对')}</button>
    </div>
    <table class="rt" style="margin-top:8px"><tr><th>${T('模型')}</th><th>${T('服务商')}</th><th class="num" title="USD / 1M tokens">${T('输入 $/1M')}</th><th class="num" title="USD / 1M tokens">${T('输出 $/1M')}</th><th class="num">${T('上下文窗口')}</th><th>${T('推理强度')}</th><th>${T('状态')}</th><th></th></tr>${rows || `<tr><td colspan="8" class="mute">${T('暂无模型')}</td></tr>`}</table>
    ${listBox}${editBox}`;
  onPick($('#mFilter'), () => { modelFilter = $('#mFilter').value; renderModels(); });
  $('#mPull').onclick = () => { const id = $('#mFilter').value; if (!id) return toast(T('请先选择服务商'), true); pullList(id); };
  $('#mNew').onclick = () => { const id = $('#mFilter').value; if (!id) return toast(T('请先选择服务商'), true); modelEdit = { key: `${id}/`, model: '', isNew: true, manual: true, pricing: null, efforts: null }; renderModels(); $('#mModel')?.focus(); };
  $('#mCheck').onclick = async () => { $('#mCheck').disabled = true; try { const r = await llmAct({ action: 'catalog_check' }, null); toast(r.warnings ? T('核对完成：{n} 项异常，已标注在对应行', { n: r.warnings }) : T('核对完成：无异常')); } catch {} };
  const bindListAdd = () => document.querySelectorAll('button[data-madd]').forEach((b) => b.onclick = () => {
    const r = listed.rows.find((x) => x.id === b.dataset.madd);
    if (r.pricing) llmAct({ action: 'model_save', key: `${listed.epId}/${r.id}`, origin: 'listed', fields: { model: r.id, pricing: r.pricing, contextWindow: r.contextWindow ?? null, efforts: r.efforts ?? null } }, T('已添加')).then(() => { listed.rows.find((x) => x.id === r.id).inCatalog = true; renderModels(); }).catch(() => {});
    else { modelEdit = { key: `${listed.epId}/${r.id}`, model: r.id, isNew: true, pricing: null, contextWindow: r.contextWindow ?? null, efforts: r.efforts ?? null }; renderModels(); $('#mIn')?.focus(); }
  });
  if ($('#listFilter')) { $('#listFilter').oninput = () => { listFilter = $('#listFilter').value; renderListRows(); }; $('#listClose').onclick = () => { listed = null; renderModels(); }; renderListRows(); }
  document.querySelectorAll('button[data-medit]').forEach((b) => b.onclick = () => { const m = llm.models.find((x) => x.key === b.dataset.medit); modelEdit = { ...m, isNew: false }; renderModels(); $('#mModel')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  document.querySelectorAll('button[data-mrm]').forEach((b) => b.onclick = () => { if (confirm(T('删除此本地覆盖项？'))) llmAct({ action: 'model_remove', key: b.dataset.mrm }, T('已删除')).catch(() => {}); });
  if (ed) {
    $('#mCancel').onclick = () => { modelEdit = null; renderModels(); };
    if ($('#mToggle')) $('#mToggle').onclick = () => llmAct({ action: 'model_save', key: ed.key, fields: { enabled: !edCur.enabled } }, edCur.enabled ? T('已停用') : T('已启用')).then(() => { modelEdit = null; renderModels(); }).catch(() => {});
    if ($('#mRemove')) $('#mRemove').onclick = () => { if (confirm(edCur.source === 'user' ? T('删除此模型？') : T('恢复为内置默认值？'))) llmAct({ action: 'model_remove', key: ed.key }, edCur.source === 'user' ? T('已删除') : T('已恢复默认')).then(() => { modelEdit = null; renderModels(); }).catch(() => {}); };
    $('#mSave').onclick = () => {
      const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
      const effs = [...document.querySelectorAll('input[data-eff]')].filter((c) => c.checked).map((c) => c.dataset.eff);
      const pr = { input: num('#mIn'), output: num('#mOut'), cacheRead: num('#mCr'), cacheWrite: num('#mCw') };
      const model = $('#mModel').value.trim(); if (!model) return toast(T('模型 ID 不能为空'), true);
      const key = ed.manual ? `${ed.key}${model}` : ed.key;
      // 四个单价都空 = 没填（发 null）；只填一部分仍发对象，由服务端报错 —— 那是填错，不是没填
      const fields = { model, pricing: Object.values(pr).every((v) => v === undefined) ? null : pr, contextWindow: $('#mWin').value.trim() ? Number($('#mWin').value) : null, efforts: effs.length === 3 ? null : effs };
      llmAct({ action: 'model_save', key, fields }, T('已保存')).then(() => { modelEdit = null; if (listed?.rows) { const r = listed.rows.find((x) => `${listed.epId}/${x.id}` === key); if (r) r.inCatalog = true; } renderModels(); }).catch(() => {});
    };
  }
}

// ── 模型分配 ──
function renderBinding() {
  const B = llm.binding;
  const byEp = {};
  for (const m of llm.models) if (!m.orphan || Object.values(B.binding).includes(m.key)) (byEp[m.vendor ?? '—'] ??= []).push(m);
  const rows = llm.tiers.map((t) => {
    const curKey = B.binding[t], curM = llm.models.find((m) => m.key === curKey);
    const opts = Object.entries(byEp).map(([ep, ms]) => `<optgroup label="${esc(epName(ep))}">${ms.map((m) => `<option value="${esc(m.key)}"${m.key === curKey ? ' selected' : ''}${m.cannotBind && m.key !== curKey ? ' disabled' : ''} title="${esc(m.cannotBind ?? '')}">${esc(shortKey(m))}${m.pricing ? ` · ${price(m.pricing)}` : ''}${m.cannotBind ? ` · ${T('不可用')}` : ''}</option>`).join('')}</optgroup>`).join('');
    const allowed = curM ? (curM.efforts ?? llm.efforts) : llm.efforts;
    const eff = B.efforts[t];
    const prob = B.problems.find((p) => p.tier === t);
    // 备用模型 —— 主模型那家暂停调用（熔断）或重试用尽时，这一档自动换用它。标出同一家 / 同一服务商（它停了备用也一起停）
    const fbKey = B.fallbacks?.[t] ?? null;
    const fbTag = (m) => (!curM ? '' : m.hkey && m.hkey === curM.hkey ? ` · ${T('同一服务商，它停了这个也停')}` : m.maker && m.maker === curM.maker ? ` · ${T('同一家出品')}` : '');
    const fbOpts = Object.entries(byEp).map(([ep, ms]) => `<optgroup label="${esc(epName(ep))}">${ms.map((m) => `<option value="${esc(m.key)}"${m.key === fbKey ? ' selected' : ''}${(m.cannotBind || m.key === curKey) && m.key !== fbKey ? ' disabled' : ''}>${esc(shortKey(m))}${m.pricing ? ` · ${price(m.pricing)}` : ''}${m.key === curKey ? ` · ${T('主模型')}` : fbTag(m)}</option>`).join('')}</optgroup>`).join('');
    const fbM = fbKey ? llm.models.find((m) => m.key === fbKey) : null;
    const down = curM && (llm.health ?? []).find((h) => h.key === curM.hkey && (h.state === 'open' || h.state === 'half_open'));
    return `<tr><td><b class="mono">${esc(t)}</b><br><span class="small mute">${esc(tierUsers(t))}</span></td>
      <td><select data-bind="${esc(t)}" style="min-width:280px" aria-label="${T('{tier} 档用哪个模型', { tier: esc(t) })}">${curM ? '' : `<option value="${esc(curKey)}" selected>${esc(curKey)}${T('（不在模型列表中）')}</option>`}${opts}</select></td>
      <td><select data-eff="${esc(t)}" aria-label="${T('{tier} 档的思考强度', { tier: esc(t) })}" ${allowed.length ? '' : 'disabled'}><option value="">${T('默认')}</option>${llm.efforts.map((x) => `<option value="${esc(x)}"${eff === x ? ' selected' : ''}${allowed.includes(x) ? '' : ' disabled'}>${esc(x)}</option>`).join('')}</select></td>
      <td><select data-fb="${esc(t)}" style="width:220px" aria-label="${T('{tier} 档的备用模型', { tier: esc(t) })}"><option value="">${T('不配备用')}</option>${fbOpts}</select></td>
      <td style="min-width:200px">${prob ? `<span class="pill bad">${T('不可用')}</span> <span class="small" style="color:var(--bad)">${esc(prob.why)}</span>` : curM && !(down && fbKey) ? `<span class="small mute">${esc(epName(curM.vendor))} · ${price(curM.pricing) || T('按响应计费')}</span>` : ''}${down ? `<div class="small" style="color:var(${fbKey ? '--wait' : '--bad'})">${T('这家连着出错，系统暂时不调用它。')}${fbKey ? T('这一档正在用备用 {fb}，按它的价计费{price}', { fb: esc(shortKey({ key: fbKey })), price: fbM?.pricing ? ` · ${price(fbM.pricing)}` : '' }) : T('这一档要用它的步骤会停下等；配个备用就能接着做')}</div>` : ''}</td>
      <td class="act"><button data-bsave="${esc(t)}" class="primary" disabled>${T('保存')}</button></td></tr>`;
  }).join('');
  $('#bindTag').innerHTML = B.problems.length ? `<span style="color:var(--bad)">${T('{tiers} 不可用', { tiers: esc(B.problems.map((p) => p.tier).join(T('、'))) })}</span>` : (B.source === 'db' ? T('更新于 {ago}前', { ago: ago(B.updatedAt) }) : T('内置默认值'));
  $('#binding').innerHTML = `<table class="rt"><tr><th>${T('档位')}</th><th>${T('模型')}</th><th>${T('推理强度')} ${hint(T('reasoning effort。默认按角色取值：执行 / 规划 / 澄清为 high，验收为 medium'))}</th><th>${T('备用')} ${hint(T('主模型那家连着出错、系统暂时不调用它时，或重试几次还是失败时，这一档自动换用备用模型；那家恢复后自动换回。选另一家出品、走另一个服务商的，才挡得住整家出问题'))}</th><th></th><th></th></tr>${rows}</table>
    ${(() => { const none = llm.tiers.filter((t) => !B.fallbacks?.[t]); return none.length ? `<div class="small" style="margin-top:8px">${T('{tiers} 档没配备用：主模型那家出问题时，这几档的步骤会停下等它恢复。', { tiers: esc(none.join(T('、'))) })}</div>` : ''; })()}
    <div class="small mute" style="margin-top:8px">${T('自下一个步骤起生效。执行各步骤用哪一档由规划器按难度决定；其余角色各走一档（见下表），也可以单独指定模型。')}</div>
    ${rolesHtml(byEp)}`;
  const primDirty = (t) => document.querySelector(`select[data-bind="${t}"]`).value !== B.binding[t] || (document.querySelector(`select[data-eff="${t}"]`).value || null) !== (B.efforts[t] ?? null);
  const fbDirty = (t) => (document.querySelector(`select[data-fb="${t}"]`).value || null) !== (B.fallbacks?.[t] ?? null);
  const dirty = (t) => { document.querySelector(`button[data-bsave="${t}"]`).disabled = !primDirty(t) && !fbDirty(t); };
  document.querySelectorAll('select[data-fb]').forEach((s) => s.onchange = () => dirty(s.dataset.fb));
  document.querySelectorAll('select[data-bind]').forEach((s) => s.onchange = () => { const m = llm.models.find((x) => x.key === s.value); const es = document.querySelector(`select[data-eff="${s.dataset.bind}"]`); const allowed = m ? (m.efforts ?? llm.efforts) : llm.efforts; es.disabled = !allowed.length; [...es.options].forEach((o) => { if (o.value) o.disabled = !allowed.includes(o.value); }); if (es.value && !allowed.includes(es.value)) es.value = ''; dirty(s.dataset.bind); });
  document.querySelectorAll('select[data-eff]').forEach((s) => s.onchange = () => dirty(s.dataset.eff));
  document.querySelectorAll('button[data-bsave]').forEach((b) => b.onclick = async () => {
    const t = b.dataset.bsave, fb = document.querySelector(`select[data-fb="${t}"]`).value || null, prim = primDirty(t), fbc = fbDirty(t);
    try {
      if (prim) await llmAct({ action: 'bind_set', tier: t, key: document.querySelector(`select[data-bind="${t}"]`).value, effort: document.querySelector(`select[data-eff="${t}"]`).value || null }, fbc ? null : T('{tier} 已保存', { tier: t }));
      if (fbc) await llmAct({ action: 'fallback_set', tier: t, key: fb }, T('{tier} 已保存', { tier: t }));
    } catch { /* llmAct 已提示 */ }
  });
  bindRoles();
}

// ── 按角色：每个角色现在用什么、来自哪一层；可以单独指定，也可以回到"跟着档位" ──
// 档位那一栏"谁在用"按角色表现算（走查：手写的说明与角色表对不上，"分类"写在 light 下、分辨来信其实跟 standard）
function tierUsers(t) {
  const N = ROLE_NAME(), rs = llm.roles ?? [];
  const names = rs.filter((r) => r.tier === t && !r.override).map((r) => N[r.role] ?? r.role);
  if (!rs.find((r) => r.role === 'executor')?.override) names.push(T('按难度分到这一档的步骤'));
  return names.join(T('、'));
}
const ROLE_DESC = () => ({ planner: T('把任务拆成步骤'), project_planner: T('把项目拆成任务'), elicitor: T('开工前向人追问需求'), replanner: T('收到修正后改计划'),
  executor: T('做每一步'), compactor: T('一步做到一半上下文太长时，把前面的过程整理成简报'), verifier: T('检查每一步交上来的东西'), classifier: T('判断人发来的话是修正、答复还是补充'), reporter: T('给人写进展汇报'), 'decision-check': T('看新说法与已定的约定冲不冲突') });
const ROLE_NAME = () => ({ planner: T('规划'), project_planner: T('项目规划'), elicitor: T('澄清需求'), replanner: T('改计划'), executor: T('执行步骤'), compactor: T('整理上下文'),
  verifier: T('验收'), classifier: T('分辨来信'), reporter: T('写汇报'), 'decision-check': T('对照已定约定') });
function rolesHtml(byEp) {
  const B = llm.binding, N = ROLE_NAME();
  const modelOf = (k) => llm.models.find((m) => m.key === k);
  const vp = llm.verifierPolicy;
  // 验收员这一行的"实际效果"：执行器在各档时验收员用谁（策略换了的标出来；只有一家时说清是同一家）
  const vEffect = () => (vp?.byExecutor ?? []).map((x) => {
    const v = x.verifier;
    const pm = modelOf(v.key);
    const to = `<span class="mono">${esc(shortKey({ key: v.key }))}</span>${pm?.pricing ? ` <span class="mute">${price(pm.pricing)}</span>` : ''}`;
    return `<div class="small">${T('执行用 {exec} 时', { exec: `<span class="mono">${esc(shortKey({ key: x.executorKey }))}</span>` })} → ${to}${v.source === 'policy' ? ` <span class="ok">${T('（自动换了一家）')}</span>` : v.sameMaker ? ` <span class="warn">${v.note === 'only_maker' ? T('（同一家：没有第二家可用）') : v.note === 'role_same' ? T('（同一家：照你指定的用）') : T('（同一家）')}</span>` : ''}</div>`;
  }).join('');
  const rows = llm.roles.map((r) => {
    const own = r.override;
    const follow = r.tier ? T('跟着 {tier} 档：{model}', { tier: r.tier, model: shortKey({ key: B.binding[r.tier] }) }) : T('跟着各步骤的档位（规划器定）');
    const opts = Object.entries(byEp).map(([ep, ms]) => `<optgroup label="${esc(epName(ep))}">${ms.map((m) => `<option value="${esc(m.key)}"${own?.key === m.key ? ' selected' : ''}${m.cannotBind && own?.key !== m.key ? ' disabled' : ''}>${esc(shortKey(m))}${m.pricing ? ` · ${price(m.pricing)}` : ''}</option>`).join('')}</optgroup>`).join('');
    const cur = own ? modelOf(own.key) : null, allowed = cur ? (cur.efforts ?? llm.efforts) : [];
    return `<tr><td><b>${esc(N[r.role] ?? r.role)}</b><br><span class="small mute">${esc(ROLE_DESC()[r.role] ?? '')}</span></td>
      <td><select data-rbind="${esc(r.role)}" style="min-width:240px" aria-label="${T('{role}用哪个模型', { role: esc(N[r.role] ?? r.role) })}"><option value="">${esc(follow)}</option>${opts}</select></td>
      <td><select data-reff="${esc(r.role)}" aria-label="${T('{role}的推理强度', { role: esc(N[r.role] ?? r.role) })}" ${own && allowed.length ? '' : 'disabled'}><option value="">${own ? T('默认') : T('跟着档位')}</option>${llm.efforts.map((x) => `<option value="${esc(x)}"${own?.effort === x ? ' selected' : ''}${allowed.includes(x) ? '' : ' disabled'}>${esc(x)}</option>`).join('')}</select></td>
      <td>${r.cannotBind ? `<span class="pill bad">${T('不可用')}</span> <span class="small" style="color:var(--bad)">${esc(r.cannotBind)}</span>`
        : r.role === 'verifier' ? vEffect() : r.role === 'executor' && own ? `<span class="small warn">${T('所有步骤都用这一个，规划器按难度分的档不再起作用')}</span>` : ''}</td>
      <td class="act"><button data-rsave="${esc(r.role)}" class="primary" disabled>${T('保存')}</button></td></tr>`;
  }).join('');
  return `<h3 style="margin-top:16px">${T('各角色用哪个模型')}</h3>
    <table class="rt"><tr><th>${T('角色')}</th><th>${T('模型')}</th><th>${T('推理强度')}</th><th></th><th></th></tr>${rows}</table>
    <div class="row" style="margin-top:8px;gap:12px;align-items:center">
      <label class="small">${T('验收与执行在同一家时')} <select id="vpVendor"><option value="different"${vp?.policy === 'different' ? ' selected' : ''}>${T('换一家验收')}</option><option value="same"${vp?.policy === 'same' ? ' selected' : ''}>${T('不换')}</option></select></label>
      <label class="small">${T('规划时标为高风险的步骤')} <select id="vpCosign"><option value="off"${vp?.cosign === 'off' ? ' selected' : ''}>${T('一个验收员')}</option><option value="high_risk"${vp?.cosign === 'high_risk' ? ' selected' : ''}>${T('再请另一家验一次，两个都通过才算过（这些步骤验收花费约翻倍）')}</option></select></label>
      <button id="vpSave" class="primary" disabled>${T('保存')}</button></div>`;
}
function bindRoles() {
  const cur = (role) => llm.roles.find((r) => r.role === role)?.override ?? null;
  const dirty = (role) => { const o = cur(role); $(`button[data-rsave="${role}"]`).disabled = ($(`select[data-rbind="${role}"]`).value || null) === (o?.key ?? null) && ($(`select[data-reff="${role}"]`).value || null) === (o?.effort ?? null); };
  document.querySelectorAll('select[data-rbind]').forEach((s) => s.onchange = () => {
    const m = llm.models.find((x) => x.key === s.value), es = $(`select[data-reff="${s.dataset.rbind}"]`);
    const allowed = m ? (m.efforts ?? llm.efforts) : [];
    es.disabled = !allowed.length; [...es.options].forEach((o) => { if (o.value) o.disabled = !allowed.includes(o.value); }); if (es.value && !allowed.includes(es.value)) es.value = '';
    dirty(s.dataset.rbind);
  });
  document.querySelectorAll('select[data-reff]').forEach((s) => s.onchange = () => dirty(s.dataset.reff));
  document.querySelectorAll('button[data-rsave]').forEach((b) => b.onclick = () => { const r = b.dataset.rsave;
    llmAct({ action: 'role_bind_set', role: r, key: $(`select[data-rbind="${r}"]`).value || null, effort: $(`select[data-reff="${r}"]`).value || null }, T('{role} 已保存', { role: ROLE_NAME()[r] ?? r })).catch(() => {}); });
  const vpDirty = () => { $('#vpSave').disabled = $('#vpVendor').value === llm.verifierPolicy?.policy && $('#vpCosign').value === llm.verifierPolicy?.cosign; };
  $('#vpVendor').onchange = vpDirty; $('#vpCosign').onchange = vpDirty;
  $('#vpSave').onclick = () => llmAct({ action: 'verifier_policy', vendor: $('#vpVendor').value, cosign: $('#vpCosign').value }, T('已保存')).catch(() => {});
}
