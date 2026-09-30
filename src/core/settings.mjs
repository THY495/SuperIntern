// 部署级开关。存 params 表的系统层（task_id NULL、layer='system'），治理类别 constitutional ——
// 库层 CHECK 保证只有人能写，agent 结构上改不了。键很少，全列在 SETTINGS 里；不认识的键拒收。
//
// 现在只有一个：谁能新建项目 / 任务。默认成员即可（创建者就是负责人，花费由预算上限封着）；
// 打开"仅管理员可创建"后只有管理员能建。旁观者与已停用成员恒不可。

import { newId, now, audit } from '../db/db.mjs';
import { I18nError, CATALOGS, contentLang } from '../i18n/index.mjs';

export const SETTINGS = {
  'deploy.create_admin_only': { default: false, type: 'boolean', label: '仅管理员可新建项目与任务' },
  // 新项目建好就放行的联网源（管理员在联网目录里勾）。原来每个新项目第一次装依赖都要负责人答一条"放不放行"。
  'deploy.egress_defaults': { default: [], type: 'list', label: '新项目默认放行的联网源' },
  // 0.2.0：写进库里的文字（事项正文、汇报……）与模型写给人的文字用哪种语言。按部署统一，见 src/i18n/index.mjs。
  'deploy.content_lang': { default: 'zh', type: 'enum', values: ['zh', 'en'], label: '内容语言' },
};

export function getSetting(db, key) {
  const def = SETTINGS[key] ?? (() => { throw new I18nError('设置项不存在：{key}', { key }); })();
  // ⚠️ `project_id IS NULL` 不能省（v16 起 params 多了项目层）：项目层的行 task_id 也是 NULL，
  // 少这一句就会把某个项目的同名设置读成部署级的。
  const row = db.one(`SELECT value FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, key);
  if (!row) return def.default;
  try { return JSON.parse(row.value); } catch { return def.default; }
}

/** 调用方保证操作者是管理员。 */
export function setSetting(db, { key, value, userId }) {
  const def = SETTINGS[key] ?? (() => { throw new I18nError('设置项不存在：{key}', { key }); })();
  // 报错里的设置项名按内容语言取（label 是中文原文，看板上的名字由看板翻）
  const label = () => CATALOGS[contentLang(db)]?.[def.label] ?? def.label;
  if (def.type === 'boolean' && typeof value !== 'boolean') throw new I18nError('{label}：值无效（应为 true 或 false）', { label: label() });
  if (def.type === 'list' && !(Array.isArray(value) && value.every((x) => typeof x === 'string'))) throw new I18nError('{label}：值无效（应为一组名字）', { label: label() });
  if (def.type === 'enum' && !def.values.includes(value)) throw new I18nError('{label}：值无效（可选：{values}）', { label: label(), values: def.values.join(' / ') });
  const t = now();
  return db.tx(() => {
    const before = getSetting(db, key);
    db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL`, t, t, key);
    db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at) VALUES (?,NULL,?,?,'system','constitutional','user',?,?,?)`,
      newId('p'), key, JSON.stringify(value), userId, t, t);
    audit(db, { actorKind: 'user', actorId: userId, action: 'setting_set', targetType: 'setting', targetId: key, payload: { from: before, to: value } });
    return { key, value };
  });
}

export const settingsView = (db) => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, getSetting(db, k)]));

/** 某人能否新建项目 / 任务。返回 { ok, why }。 */
export function canCreate(db, userId) {
  const u = db.one(`SELECT role, disabled_at FROM users WHERE id=?`, userId);
  if (!u || u.disabled_at) return { ok: false, why: '成员不存在或已停用' };
  if (u.role === 'observer') return { ok: false, why: '旁观者不能新建项目或任务' };
  if (u.role !== 'lead' && getSetting(db, 'deploy.create_admin_only')) return { ok: false, why: '当前设置为仅管理员可新建项目与任务' };
  return { ok: true, why: null };
}
