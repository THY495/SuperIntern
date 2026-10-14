// 推送护栏：系统往远端推东西只走这里（tests/push-guard.test.mjs 扫源码钉住）。
//
// 2026-10-12 用户定"私有仓库、先用免费组织"：免费组织的私有仓库没有分支保护、也设不了"PR 必须有人审"。
// GitHub App / 令牌一旦有写代码的权限，GitHub 那边不会拦它直推默认分支、强推、删分支 —— 所以护栏做在我们这边，
// 对所有连接一视同仁：
//   ① 只推系统自己的分支：superintern/…（项目）、v0/…（任务）；
//   ② 不推远端的默认分支（哪怕名字碰巧对得上前缀）；
//   ③ 不强推：远端分支上有我们没有的提交（别人推过、或历史改写过），git 自己会拒，这里把拒绝说清楚；
//   ④ 从不删远端分支（refspec 由这里拼，不接受外面传进来的 refspec）。
// 唯一的例外是空仓库：远端一条分支都没有时，可以把项目起点推成默认分支（PR 要有个目标分支）—— 推之前当场核对"确实是空的"。
// 拒绝都写审计 push_refused。合并永远由人在 GitHub 上点。
//
// 本机的项目仓库（项目推进时把任务分支并进项目仓库）是系统自己的地盘，不受 ①–③ 约束（internal）。

import { audit } from '../db/db.mjs';
import { I18nError } from '../i18n/index.mjs';
import { gitRaw, safePositional } from './git.mjs';

export const PUSH_PREFIXES = ['superintern/', 'v0/'];

const lastLines = (e, n = 3) => String(e.stderr ?? e.message ?? '').trim().split('\n').filter(Boolean).slice(-n).join(' / ');

function refuse(db, { remote, branch, rule, actorId }, err) {
  audit(db, { actorKind: actorId ? 'user' : 'system', actorId, action: 'push_refused', targetType: 'remote', targetId: remote, payload: { branch, rule } });
  err.pushRefused = rule;
  throw err;
}

/** 分支名：不以 - 开头、不含 refspec 的特殊字符（: + 空白 ~ ^ ? * [ \）、不含 ..。 */
function checkBranchName(branch) {
  const b = String(branch ?? '');
  if (!b || b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.includes('..') || /[:+\s~^?*[\\\0]/.test(b) || b.endsWith('.lock')) {
    throw new I18nError('分支名不对：{branch}', { branch: b.slice(0, 80) });
  }
  return b;
}

/** 远端默认分支（`git ls-remote --symref`；远端读不了 / 空仓库 → null）。 */
export function remoteDefaultBranch(dir, remote, env) {
  try {
    const out = gitRaw(dir, ['ls-remote', '--symref', '--', remote, 'HEAD'], { env, timeout: 60_000 });
    return out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null;
  } catch { return null; }
}

/**
 * 把本地的 `src`（提交号或本地分支）推成远端的 `branch`。
 * @param {object} db
 * @param {object} o
 * @param {string} o.dir       在哪个本地仓库里推
 * @param {string} o.remote
 * @param {string} o.src
 * @param {string} o.branch    远端分支名（不带 refs/heads/）
 * @param {object} o.env       推送用的环境（连接解析给的，含凭据）
 * @param {boolean} [o.internal]  推到系统自己的本机项目仓库：不受护栏约束，沿用 --force-with-lease
 * @param {string|null} [o.actorId]
 */
export function pushBranch(db, { dir, remote, src, branch, env, internal = false, actorId = null }) {
  remote = safePositional(remote);
  branch = checkBranchName(branch);
  if (internal) {
    gitRaw(dir, ['push', '--force-with-lease', '--', remote, `${src}:refs/heads/${branch}`], { env });
    return { branch };
  }
  const ctx = { remote, branch, actorId };
  if (!PUSH_PREFIXES.some((p) => branch.startsWith(p))) {
    refuse(db, { ...ctx, rule: 'prefix' }, new I18nError('不推 {branch}：系统只往远端推它自己的分支（{prefixes}…），不碰别的分支。合并由人在 GitHub 上点', { branch, prefixes: PUSH_PREFIXES.join('… / ') }));
  }
  const def = remoteDefaultBranch(dir, remote, env);
  if (def && def === branch) refuse(db, { ...ctx, rule: 'default_branch' }, new I18nError('不推 {branch}：它是远端的默认分支。系统只推自己的分支、开 PR，合并由人点', { branch }));
  try {
    gitRaw(dir, ['push', '--', remote, `${src}:refs/heads/${branch}`], { env });
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? '');
    if (/non-fast-forward|fetch first|\[rejected\]|stale info/i.test(msg)) {
      refuse(db, { ...ctx, rule: 'non_fast_forward' }, new I18nError('远端的 {branch} 上有这里没有的提交（有人往上推过，或历史被改写过）。系统不强推、不覆盖别人的提交。先在 GitHub 上看那条分支多出来的是谁的什么提交：要保留，就让推它的人另开分支或合进主线；确认不要了，再在 GitHub 上删掉那条分支、重新交付（删分支会连那些提交一起丢掉）', { branch }));
    }
    if (/refusing to allow .*workflow|workflows? permission|`workflow` scope/i.test(msg)) {
      const err = new I18nError('推送被 GitHub 拒绝：这次改动碰到了 .github/workflows/ 下的文件，而所用的连接没有改工作流的权限（GitHub App 与 fine-grained 令牌要开 Workflows: Read and write；classic 令牌要勾 workflow）');
      err.code = 'WORKFLOW_SCOPE';
      throw err;
    }
    const err = new I18nError('推送到 {target} 失败：{error}', { target: remote, error: lastLines(e) });
    // 鉴权 / 权限不够：调用方可以换下一份连接再试（GitHub 对没权限的令牌常回 "Repository not found"，也算）
    if (/Permission to .* denied|returned error: 40[13]|Authentication failed|could not read Username|Permission denied \(publickey\)|Write access to repository not granted|Repository not found|access denied/i.test(msg)) err.code = 'PUSH_AUTH';
    throw err;
  }
  return { branch, defaultBranch: def };
}

/**
 * 空仓库起步：把 `src` 推成远端的默认分支。只在远端**一条分支都没有**时做（推之前当场核对）。
 */
export function pushInitialDefault(db, { dir, remote, src, branch, env, actorId = null }) {
  remote = safePositional(remote);
  branch = checkBranchName(branch);
  let heads;
  try { heads = gitRaw(dir, ['ls-remote', '--heads', '--', remote], { env, timeout: 60_000 }).trim(); } catch (e) {
    throw new I18nError('读不了远端 {target}：{error}', { target: remote, error: lastLines(e) });
  }
  if (heads) refuse(db, { remote, branch, rule: 'bootstrap_not_empty', actorId }, new I18nError('远端已经有分支了，不再往默认分支 {branch} 上推起点', { branch }));
  try { gitRaw(dir, ['push', '--', remote, `${src}:refs/heads/${branch}`], { env }); } catch (e) {
    throw new I18nError('推送到 {target} 失败：{error}', { target: remote, error: lastLines(e) });
  }
  return { branch };
}

/** 远端是不是空的（一条分支都没有）。读不了 → null（不知道）。 */
export function remoteIsEmpty(dir, remote, env) {
  try { return gitRaw(dir, ['ls-remote', '--heads', '--', remote], { env, timeout: 60_000 }).trim() === ''; } catch { return null; }
}
