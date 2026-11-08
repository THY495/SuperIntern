// 「添加任务」的需求来源（入站）：不是人在看板 / CLI 上敲的那几种。
// project-append 起草、出队、渲染批准事项时按 origin.kind 回调这里。放在单独一个模块里、不依赖 project-append：
// 不管哪个进程处理排队（看板、守护进程、CLI），来源的定义都在 —— 不靠"谁先 import 了入站模块"。
//
// kind：
//   github_issue  外部文本（作者可能不在项目里）：给规划器时围起来、批准事项开头写来源、自动挡也要人批
//   schedule      负责人写的定时需求：跟人敲的一样走挡位
//   project_ci    项目整体交付的 PR CI 没过：按交付人交付时的授权起草修复，跟任务级自动修一样走挡位；CI 输出在需求原文里自己围着

import { getProjectParam } from './params.mjs';
import { canAddTasks } from './project-members.mjs';
import { tl, N_ } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';

export const ISSUES_KEY = 'inbound.issues';             // 配置 { repo: 'owner/repo', label, on, by, at }
export const SCHEDULES_KEY = 'inbound.schedules';       // [{ id, name, cron, brief, on, by, at }]
export const issueConfigOf = (db, projectId) => getProjectParam(db, projectId, ISSUES_KEY);
export const schedulesOf = (db, projectId) => getProjectParam(db, projectId, SCHEDULES_KEY) ?? [];

const nameOf = (db, id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;

export const ORIGINS = {
  github_issue: {
    external: true,
    label: (o) => `GitHub issue #${o.number}（${o.repo}）`,
    /** 还收不收：入口还开着、还是这个仓库、开入口的人还有添加权限 */
    problem(db, projectId, o) {
      const cfg = issueConfigOf(db, projectId);
      if (!cfg?.on) return { msg: N_('这个项目的 GitHub issue 入口已经关了') };
      if (cfg.repo !== o.repo) return { msg: N_('这个项目的 issue 入口改成了别的仓库（{repo}）'), params: { repo: cfg.repo } };
      if (!canAddTasks(db, projectId, cfg.by)) return { msg: N_('开 issue 入口的人已经没有添加任务的权限：请负责人在「项目设置 → Issue 与定时任务」重新打开') };
      return null;
    },
    /** 批准事项开头那一段 */
    note(db, o, L) {
      const who = o.author?.member ? tl(L, '{name}（@{login}）', { name: nameOf(db, o.author.member), login: o.author.login })
        : tl(L, '@{login}（对不上这个项目里的人）', { login: o.author?.login ?? '?' });
      return `${markOf(L, 'inboundIssue')}${tl(L, '这一轮来自 GitHub issue #{n}「{title}」，{who} 写的：{url}', { n: o.number, title: o.title, who, url: o.url })}\n`
        + `${tl(L, '下面的任务是按 issue 原文起草的。原文是项目外面的文本 —— 批之前点开看一眼；里面要读密钥、改 CI 或部署配置、往外发东西的，别批。')}\n\n`;
    },
  },
  project_ci: {
    external: false,
    label: (o) => `PR #${o.pr}`,
    problem(db, projectId, o) {
      const pr = getProjectParam(db, projectId, 'delivery.pr');
      if (!pr || pr.number !== o.pr) return { msg: N_('项目交付的 PR 换了（不是 #{n} 了）'), params: { n: o.pr } };
      if (pr.autofix === false) return { msg: N_('交付人收回了 AI 跟进这个 PR 的授权') };
      if (!canAddTasks(db, projectId, pr.by)) return { msg: N_('交付人已经没有给这个项目添加任务的权限') };
      return null;
    },
    note(db, o, L) {
      return `${markOf(L, 'ciFailed')}${tl(L, '这一轮是项目整体交付的 PR #{n} 的 CI 没过，按{who}交付时的授权起草的修复（第 {k}/{max} 轮）：{url}', { n: o.pr, who: nameOf(db, o.by), k: o.attempt, max: o.max, url: o.url })}\n`
        + `${tl(L, '批了之后新任务合并，还要到项目页再交付一次，PR 才会更新、CI 才会再跑。')}\n\n`;
    },
  },
  schedule: {
    external: false,
    label: (o) => o.name,
    problem(db, projectId, o) {
      const s = schedulesOf(db, projectId).find((x) => x.id === o.id);
      if (!s?.on) return { msg: N_('定时任务「{name}」已经停了或删了'), params: { name: o.name } };
      if (!canAddTasks(db, projectId, s.by)) return { msg: N_('设定时任务「{name}」的人已经没有添加任务的权限'), params: { name: o.name } };
      return null;
    },
    note(db, o, L) {
      return `${markOf(L, 'inboundSchedule')}${tl(L, '这一轮是定时任务「{name}」（{cron}，{who}设的）按时起草的。', { name: o.name, cron: o.cron, who: nameOf(db, o.by) })}\n\n`;
    },
  },
};
