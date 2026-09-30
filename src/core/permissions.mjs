// 权限一览（只读）：一个人现在能做什么。权限散在三处 —— 部署级角色、负责哪些项目 / 任务、各张路由表的八类决策 ——
// 这里把三处合成一张视图。与 responsibilitiesOf 的区别：那个只认点名的 `user:<id>`（交接要换的东西），
// 这个按解析器真算，`group:*` / `group:<标签>` / `on_duty` / `user:lead` 间接指到的也算进去。
//
// 路由部分按"此刻"解析（值班表取现在当班的人）；只列还开着的项目的表与默认表。

import { now } from '../db/db.mjs';
import { rulesOf, resolveRecipients, dutyCalendarOf, onDutyAt, DECISION_TYPES, LEAD_PLACEHOLDER } from './routing.mjs';
import { canCreate } from './settings.mjs';
import { I18nError } from '../i18n/index.mjs';

const OPEN_PROJECT = `('proposed','active','stalled')`;
const ROLE_CAPS = {
  lead: ['管理成员、角色与部署级设置', '管理服务商、模型与模型分配', '修改默认决策路由', '执行或批准任意交接（含强制交接）'],
  member: ['按决策路由接收并答复待决事项', '发消息、评论'],
  observer: ['只读', '发消息、评论（不参与决策）'],
};
const OWNER_CAPS = ['运行 / 暂停 / 中止', '修改该项目的决策路由', '推进与交付', '答复该项目的任何事项', '执行或批准该项目范围内的交接'];

export function permissionsOf(db, userId, { at = now() } = {}) {
  const u = db.one(`SELECT id, display_name, role, disabled_at FROM users WHERE id=?`, userId);
  if (!u) throw new I18nError('成员不存在：{id}', { id: userId });
  const out = { userId: u.id, name: u.display_name, role: u.role, disabled: !!u.disabled_at, roleCaps: ROLE_CAPS[u.role] ?? [], ownerCaps: OWNER_CAPS,
    canCreate: canCreate(db, u.id), owns: { projects: [], soloTasks: [] }, routing: [], duty: [] };
  if (u.disabled_at) { out.roleCaps = []; return out; }

  out.owns.projects = db.all(`SELECT id, title, status FROM projects WHERE owner_id=? AND status IN ${OPEN_PROJECT} ORDER BY created_at`, u.id);
  out.owns.soloTasks = db.all(`SELECT id, title, status FROM tasks WHERE owner_id=? AND project_id IS NULL AND status NOT IN ('done','aborted') ORDER BY created_at`, u.id);

  // 路由：每张表、每种决策类型 —— 他是需答复、仅知会，还是不在其中；经由哪个写法指到他。
  const keys = [{ key: '', title: '默认决策路由（不属于项目的任务）', owner: null },
    ...db.all(`SELECT id, title, owner_id FROM projects WHERE status IN ${OPEN_PROJECT} ORDER BY created_at`).map((p) => ({ key: p.id, title: p.title, owner: p.owner_id }))];
  for (const k of keys) {
    const isOwner = k.key ? k.owner === u.id : false;
    // 默认表的 `user:lead` 是各任务自己的负责人：只有当他确有不属于项目的任务时才算指到他。
    const lead = k.key ? k.owner : (out.owns.soloTasks.length ? u.id : LEAD_PLACEHOLDER);
    const types = [];
    for (const [t, def] of Object.entries(DECISION_TYPES)) {
      let mode = null; const vias = { answer: new Set(), inform: new Set() };
      for (const r of rulesOf(db, k.key).filter((x) => x.decision_type === t)) {
        for (const s of r.recipients) {
          let res; try { res = resolveRecipients(db, k.key, [s], { parties: [], at, lead }); } catch { continue; }
          const hit = res.answerers.includes(u.id) ? 'answer' : res.informed.includes(u.id) ? 'inform' : null;
          if (!hit) continue;
          if (hit === 'answer') mode = 'answer'; else if (!mode) mode = 'inform';
          vias[hit].add(`${viaText(db, s.replace(/^inform:/, ''), u.id)}${r.scope !== '*' ? `（范围 ${r.scope}）` : ''}${r.position > 0 ? `（顺位 ${r.position}）` : ''}`);
        }
      }
      // leadOnly：只因为"他是负责人"才指到他 —— 界面把这些类型合成一行，不逐类列。
      // 只列与最终结论同一种方式的来源：同时被点名需答复、又经标签被知会的人，结论是"需答复"，来源只说点名。
      const via = mode ? [...vias[mode]] : [];
      if (mode) types.push({ type: t, label: def.label, mode, via, leadOnly: via.every((v) => v.startsWith('作为负责人')) });
    }
    if (types.length || isOwner) out.routing.push({ key: k.key, title: k.title, isOwner, types });
  }

  for (const d of db.all(`SELECT project_id FROM duty_calendar`)) {
    const cal = dutyCalendarOf(db, d.project_id);
    if (!cal?.users?.includes(u.id)) continue;
    out.duty.push({ key: d.project_id, title: d.project_id ? (db.one(`SELECT title FROM projects WHERE id=?`, d.project_id)?.title ?? d.project_id) : '默认决策路由', onDutyNow: onDutyAt(cal, at) === u.id });
  }
  return out;
}

function viaText(db, s, userId) {
  if (s === 'user:lead') return '作为负责人';
  if (s === `user:${userId}`) return '点名';
  if (s === 'group:*') return '所有成员';
  if (s.startsWith('group:')) return `标签 ${s.slice(6)}`;
  if (s === 'on_duty') return '当前值班';
  return s;
}

/** 纯文本版（CLI 用）。 */
export function renderPermissions(p) {
  const roleName = { lead: '管理员', member: '成员', observer: '旁观者' }[p.role] ?? p.role;
  const L = [`${p.name}　角色：${roleName}${p.disabled ? '（已停用：不能登录，不接收任何事项）' : ''}`];
  if (p.disabled) return L.join('\n');
  L.push(`  角色权限：${p.roleCaps.join('；')}`);
  L.push(`  新建项目 / 任务：${p.canCreate.ok ? '可以（创建者即负责人）' : `不可以（${p.canCreate.why}）`}`);
  const n = p.owns.projects.length + p.owns.soloTasks.length;
  L.push(`  负责：${n ? [p.owns.projects.length ? `项目${p.owns.projects.map((x) => `「${x.title}」`).join('、')}` : '', p.owns.soloTasks.length ? `不属于项目的任务 ${p.owns.soloTasks.length} 个` : ''].filter(Boolean).join('；') : '无'}`);
  if (n) L.push(`    负责人权限：${p.ownerCaps.join('；')}`);
  for (const r of p.routing) {
    if (!r.types.length) continue;
    L.push(`  ${r.key ? `项目「${r.title}」` : r.title}${r.isOwner ? '（负责人）' : ''}`);
    const asLead = r.types.filter((t) => t.leadOnly);
    if (asLead.length) L.push(`    作为负责人：${asLead.map((t) => t.label).join('、')}`);
    for (const t of r.types.filter((x) => !x.leadOnly)) L.push(`    ${t.label}：${t.mode === 'inform' ? '仅知会' : t.type === 'delivery' ? '可执行' : '需答复'}　经由 ${t.via.join('、')}`);
  }
  if (p.duty.length) L.push(`  值班表：${p.duty.map((d) => `${d.title}${d.onDutyNow ? '（当前值班）' : ''}`).join('、')}`);
  return L.join('\n');
}
