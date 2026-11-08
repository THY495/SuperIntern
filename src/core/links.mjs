// 事项链接：推送里带的那个链接，点开就是那件事。
//
// 基址：部署设置 deploy.board_url（管理员填的看板地址）优先；没填就用看板启动时登记的地址
// （团队模式的 --public-url，本机模式的 127.0.0.1:端口）—— `web --daemon` 同一个进程里推送就带得上。
// 单独跑的 daemon 又没填 deploy.board_url：不带链接（推送照推）。
//
// 不自动把登记的地址写进 deploy.board_url：那个设置还会写进提交与 PR 的追溯链接，内网地址不该悄悄出现在公开的 PR 里。
// 链接里不带任何凭据：打开要登录，跟平常打开看板一样（免登录的链接会被转发、被聊天软件预览抓取）。

import { getSetting } from './settings.mjs';

let registered = null;

/** 看板启动时登记自己的地址（进程内有效）。 */
export function registerBoardBase(url) {
  registered = url ? String(url).replace(/\/+$/, '') : null;
}

export function boardBase(db) {
  const set = String(getSetting(db, 'deploy.board_url') ?? '').trim().replace(/\/+$/, '');
  return set || registered;
}

/**
 * 一件事的链接：事项 → 快速答复（#q/<id>）；任务 → 任务页；项目 → 项目页；都没有 → 收件箱。没有基址返回 null。
 */
export function itemLink(db, { questionId = null, taskId = null, projectId = null, view = null } = {}) {
  const b = boardBase(db);
  if (!b) return null;
  const e = encodeURIComponent;
  if (view) return `${b}/#${e(view)}`;   // 看板上的一个页面（状态报告：#report）
  if (questionId) return `${b}/#q/${e(questionId)}`;
  if (taskId) return `${b}/#${e(taskId)}`;
  if (projectId) return `${b}/#p/${e(projectId)}`;
  return `${b}/#inbox`;
}

/** 推送队列里的一行该链到哪：事项 → 那条事项；信号 → 它所在的任务 / 项目。 */
export function linkForPush(db, row) {
  if (row.source === 'question') return itemLink(db, { questionId: row.source_id });
  if (row.source === 'report') return itemLink(db, { view: 'report' });
  return itemLink(db, { taskId: row.task_id, projectId: row.project_id });
}
