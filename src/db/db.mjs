// 状态库句柄。**全系统唯一的真相源**，所有角色只经此读写。
//
// 为什么用内置 node:sqlite 而不是 better-sqlite3：
// 后者要本地编译，是纯摩擦；而 node:sqlite 的能力（CHECK / 触发器 /
// 递归 CTE / WAL）已全部验过够用。代价是启动打一行 ExperimentalWarning。
// 整个驱动面被这一个文件包住，真要换只改这里。

import { N_ } from '../i18n/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recordTransitions } from './transition-recorder.mjs';
import { createMetrics } from './metrics.mjs';
import { procKind } from '../core/lifetimes.mjs';
import { redactParams } from '../core/redact.mjs';
import { splitClauses, assignClauseKeys, maxClauseNum } from '../core/clauses.mjs';
import { performance } from 'node:perf_hooks';
import { guessDecisionType } from '../core/routing.mjs';
import { maybeFault } from '../core/faults.mjs';
import { rebuildTables } from './rebuild.mjs';
import { AUDIT_PAYLOAD_V } from './audit-payload.mjs';
import { currentOnBehalfOf } from './context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
/** 撞上别的进程的写锁时最多等多久（毫秒）。见 openDb。 */
export const BUSY_TIMEOUT_MS = 10_000;

/**
 * 整库备份到库文件旁的 backups/ 目录（`VACUUM INTO`：一致的快照，WAL 里的内容也在，生成的是普通库文件，
 * openDb 直接能开）。迁移前自动调一次；也给 `cli backup` 用。不能在事务里调。
 * @returns {string} 备份文件路径
 */
export function backupDb(rawOrDb, path, tag = 'manual') {
  const raw = rawOrDb.raw ?? rawOrDb;
  const dir = join(dirname(path), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(dir, `state-${tag}-${stamp}.db`);
  raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  return out;
}

export const now = () => Date.now();
export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 迁移表：`MIGRATIONS[v]` 把一个 user_version=v 的库带到 v+1。
 *
 * 为什么需要它（实际跑出来的）：`openDb` 原本只在库文件不存在时跑 schema.sql，
 * 于是加一张表之后，**已存在的库永远拿不到它**。而全部离线测试都用新建的
 * `:memory:` 库，所以测试全绿、实际运行第一句就 `no such table`。
 *
 * 更要命的是它伤的正是最贵的东西：实际运行跑出来的历史（花费、审计轨、交接记录）
 * 只此一份。schema 不保证不改 ——那就必须有一条不毁掉证据的改法。
 *
 * **schema.sql 只是 v1 基线**，v1 之后的 DDL 只写在这里，新库同样要跑一遍。
 * 每条 DDL 全系统一份副本，且迁移路径每次建库都被走一遍——不再是只有实际运行
 * 才会踩到的死角。
 *
 * ⚠️ 起点是 0 而不是 1：最早期的库压根没设过 user_version。
 */
// 导出只为测试：db-safety 往末尾临时追加一条坏迁移，验证"迁移写出外键违例就回滚"。生产代码不改它。
export const MIGRATIONS = [
  // 0 → 1：老库（最早期建的）本就含 v1 的全部表，只是没有版本号。空迁移，认领版本。
  () => {},
  // 1 → 2：复工简报。挂起分支**不冷冻上下文**——冷冻会复活过时的
  // 世界观。挂起时写这一份入真相源，丢弃执行上下文；复工时靠"简报 + 答案 +
  // 新鲜装配"重建。
  //
  // 为什么是一张表而不是塞进 questions 或审计轨的 payload：装配层要**读**它。
  // 审计轨是 append-only 的旁路记录，让它成为装配的输入源等于把不可删的东西
  // 变成活状态；而问题是问题，简报是工作状态，一个节点可以挂起多次。
  (raw) => raw.exec(`
    CREATE TABLE briefings (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id),
      node_id       TEXT NOT NULL REFERENCES nodes(id),
      question_id   TEXT REFERENCES questions(id),
      work_done     TEXT NOT NULL,              -- 已经做到哪一步（含已落盘的产物）
      blocked_by    TEXT NOT NULL,              -- 卡点，引用规格/验收标准原文
      plan_after    TEXT NOT NULL,              -- 获答之后打算怎么做
      context_tokens INTEGER,                   -- 挂起那一刻的上下文体量，供丈量丢弃了多少
      narrative_ref TEXT,                       -- 挂起时的执行叙事归档，供上下文考古
      -- 与交接记录同一条安全边界：简报由 agent 写、复工时又被 agent
      -- 读回，正是注入最短的一条路。它永远是情报，不是指令。
      trust_label   TEXT NOT NULL DEFAULT 'agent-generated'
                      CHECK (trust_label = 'agent-generated'),
      valid_from    INTEGER NOT NULL,
      valid_to      INTEGER,
      recorded_at   INTEGER NOT NULL,
      superseded_at INTEGER
    );
    CREATE INDEX idx_briefings_node ON briefings(node_id, superseded_at);`),
  // 2 → 3：假设的**认识论轴**。
  //
  // 没有这一列时，agent 记下的"假设"里只有少数真的是"我替人做了个决定"；多数是**本来就该去查证**的事实
  // （有的 agent 其实已经知道答案），其余是验不了的披露。
  // 假设表被当成了备注栏，而提问机制因为有这个免费出口从不被触发。
  //
  // 故每条假设必须交代**对着谁查证**。这一列把"去验 / 假设 / 提问"分开，
  // 后果分级（Ⅰ/Ⅱ/Ⅲ）是另一个轴，由花费口径决定，不在这里。
  (raw) => raw.exec(`
    ALTER TABLE assumptions ADD COLUMN verified_against TEXT;
    ALTER TABLE assumptions ADD COLUMN verification TEXT;
    ALTER TABLE assumptions ADD COLUMN must_disclose INTEGER NOT NULL DEFAULT 0;`),
  // 3 → 4：修正指令的**重规划提案**。
  //
  // 为什么是一张表，不是塞进审计轨的 payload：提案有**生命周期**
  // （proposed → applied / rejected），而审计轨是 append-only 的事件流，
  // 拿它当待办队列用会把"发生过什么"和"现在还欠什么"混成一件事。
  // 而且计划 diff 要能被查询、被复盘渲染，那是状态，不是日志。
  //
  // 逐节点影响标记落在这张表里，是因为：
  // 确认门的 30% 阈值只是**麻烦度阈值**，它挡"悄悄扔掉大量已完成工作"，
  // 挡不住"扔掉少量关键工作"。真正的护栏是每一次作废都留下出处与理由。
  (raw) => raw.exec(`
    CREATE TABLE revisions (
      id                  TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL REFERENCES tasks(id),
      message_id          TEXT NOT NULL REFERENCES messages(id),
      status              TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected')),
      impact              TEXT NOT NULL,   -- JSON [{node_id, mark, reason}]，**必须覆盖每个现存节点**
      salvage             TEXT NOT NULL,   -- JSON [{node_id, disposition, note}]
      changed_nodes       TEXT NOT NULL,   -- JSON [{node_id, title?, spec?, acceptance?}]
      new_nodes           TEXT NOT NULL,   -- JSON，形状同规划器
      constitution_patch  TEXT,            -- JSON 或 NULL。非空即"触及宪法层"，一律过确认门
      rationale           TEXT NOT NULL,
      done_micro_usd      INTEGER NOT NULL,   -- 门的分母：已完成工作量，按**花费金额**
      discarded_micro_usd INTEGER NOT NULL,   -- 门的分子
      gate                TEXT,            -- NULL=未触发；否则触发原因
      question_id         TEXT REFERENCES questions(id),
      proposed_at         INTEGER NOT NULL,
      resolved_at         INTEGER
    );
    CREATE INDEX idx_rev_task ON revisions(task_id, status);`),
  // 4 → 5：主动汇报。
  //
  // 为什么是表：汇报有"已读/未读"这个状态，而人的控制面要能列"我还没看的"。
  // 审计轨是事件流，不是收件箱。`facts` 记装配用到的真相源条目 id（装配审计），
  // `gaps` 记持久化纪律审计的发现 —— 汇报生成器若无法仅凭真相源重建发生了
  // 什么，即证明执行器违反了 flush-before-evict，那个发现要落在这里，不是落在日志里。
  (raw) => raw.exec(`
    CREATE TABLE reports (
      id              TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL REFERENCES tasks(id),
      trigger         TEXT NOT NULL CHECK (trigger IN (
                        'node_done','revision_applied','limit_breached','provider_error',
                        'task_done','verify_failed')),
      trigger_ref     TEXT,                       -- 触发它的实体 id（节点 / 提案 / 问题）
      since_report_id TEXT REFERENCES reports(id),
      since_ts        INTEGER NOT NULL,           -- 汇总窗口起点
      summary         TEXT NOT NULL,              -- 一句话摘要
      body            TEXT NOT NULL,              -- Markdown 全文
      facts           TEXT NOT NULL,              -- JSON：装配用到的真相源条目 id
      generated_by    TEXT NOT NULL CHECK (generated_by IN ('llm','template')),
      gaps            TEXT NOT NULL DEFAULT '[]', -- JSON：持久化纪律审计发现
      trust_label     TEXT NOT NULL DEFAULT 'agent-generated'
                        CHECK (trust_label = 'agent-generated'),
      read_at         INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_reports_task ON reports(task_id, created_at);`),
  // 项目层：项目 =一批契约（任务）的有序链 + 一个项目仓库克隆 + 一条项目分支。
  // 任务 N 签收 → 交付到项目仓库 → ff 合进项目分支 → 从项目分支建任务 N+1 的工作区。
  // 契约仍是普通任务（宪法块 + 验收命令），只多了 project_id / project_order / merged_at 三列 ——
  // 执行器、验收员、汇报、看板对"项目"一无所知，这是有意的：项目层只做串接，不做第二个状态机。
  (raw) => raw.exec(`
    CREATE TABLE projects (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      title       TEXT NOT NULL,
      brief       TEXT NOT NULL DEFAULT '',
      repo        TEXT NOT NULL,            -- 项目仓库克隆（本机路径），各任务分支交付到这里
      branch      TEXT NOT NULL,            -- 项目分支，任务分支按顺序 ff 合进来
      base_ref    TEXT NOT NULL,            -- 项目分支的起点
      source      TEXT,                     -- 克隆来源（本机路径或 URL）
      status      TEXT NOT NULL CHECK (status IN ('active','done','stalled','aborted')),
      created_at  INTEGER NOT NULL
    );
    ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
    ALTER TABLE tasks ADD COLUMN project_order INTEGER;
    ALTER TABLE tasks ADD COLUMN merged_at INTEGER;
    CREATE INDEX idx_tasks_project ON tasks(project_id, project_order);`),
  // 项目规划器：项目可以从一份"完整规划"文本开始 —— 状态 proposed，模型产整批契约，人批一次。
  // SQLite 改不了 CHECK，重建表；draft_* 三列记草案版本 / 批准问题 / 说明。
  // ⚠️ 天真的写法在真库上会炸：node:sqlite 默认开外键，DROP 旧表撞上 tasks.project_id 的引用；迁移又不在事务里，
  // 会留下半截（projects_v2 已建、旧表还在、版本没升）。所以：先关外键（PRAGMA 在事务外才生效）、幂等（IF NOT EXISTS +
  // 先清空）、整段一个事务、完了再开外键。
  (raw) => {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec(`
    CREATE TABLE IF NOT EXISTS projects_v2 (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL REFERENCES users(id),
      title         TEXT NOT NULL,
      brief         TEXT NOT NULL DEFAULT '',
      repo          TEXT NOT NULL,
      branch        TEXT NOT NULL,
      base_ref      TEXT NOT NULL,
      source        TEXT,
      status        TEXT NOT NULL CHECK (status IN ('proposed','active','done','stalled','aborted')),
      draft_version INTEGER NOT NULL DEFAULT 0,
      draft_question TEXT,
      draft_notes   TEXT,
      created_at    INTEGER NOT NULL
    );
    DELETE FROM projects_v2;
    INSERT INTO projects_v2 (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at)
      SELECT id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at FROM projects;
    DROP TABLE projects;
    ALTER TABLE projects_v2 RENAME TO projects;
    `);
    } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* 没开事务 */ } throw e; }
    finally { raw.exec('PRAGMA foreign_keys = ON'); }
  },
  // 7 → 8：角色与路由。权限挂在决策上不挂在人身上：
  //   - users.role 改为 lead / member / observer（owner→lead、contributor→member、viewer→observer）；
  //     can_answer 废弃（member 的实际权限由路由表推导）；domain_tags 保留作标签组。
  //   - routing_rules：项目级六字段表；routing_profiles：项目选了哪个模板、占位符绑定；duty_calendar：轮值。
  //   - answers：每人对每条事项的答复，一对多 —— 此前答复只是 messages.kind='answer' + 一条 answers 边，
  //     冲突检测（同一问题不同人不同答案）没有依据。
  //   - questions 加：decision_type / type_source / quorum / conflict_policy / route（当前 stage 各链的行）/
  //     informed（只知会）/ route_due_at（路由行时限，与 level 的 timeout_at 是两口钟）/ notified_at / origin_question_id（冲突事项指回原问题）。
  //   旧事项按正文前缀回填 decision_type（硬规则生成的问题都有固定前缀），type_source='backfill'。
  // users 重建与 projects 那次同一套路：关外键、幂等、一个事务。
  (raw) => {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec(`
    CREATE TABLE IF NOT EXISTS users_v2 (
      id            TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('lead','member','observer')),
      domain_tags   TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL
    );
    DELETE FROM users_v2;
    INSERT INTO users_v2 (id,display_name,role,domain_tags,created_at)
      SELECT id, display_name,
             CASE role WHEN 'owner' THEN 'lead' WHEN 'contributor' THEN 'member' ELSE 'observer' END,
             domain_tags, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_v2 RENAME TO users;
    CREATE TABLE routing_rules (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL DEFAULT '',   -- '' = 不属于任何项目的任务共用的默认表
      decision_type   TEXT NOT NULL CHECK (decision_type IN
                        ('spec_choice','structural','contract_approval','signoff','budget','egress','delivery','conflict')),
      scope           TEXT NOT NULL DEFAULT '*',
      position        INTEGER NOT NULL DEFAULT 0,  -- 同 (类型, 范围) 内的行序；超时 next 转下一行
      recipients      TEXT NOT NULL DEFAULT '[]',  -- JSON 解析器列表
      quorum          TEXT NOT NULL DEFAULT '1',   -- '1' / 'N' / 'all'
      conflict_policy TEXT NOT NULL DEFAULT 'block' CHECK (conflict_policy IN ('block','latest')),
      timeout_action  TEXT NOT NULL DEFAULT 'hang' CHECK (timeout_action IN ('hang','next','default')),
      timeout_after   TEXT,                        -- '30m' / '8h' / '1d' / '1bd'
      template        TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_routing_rules ON routing_rules(project_id, decision_type, scope, position);
    CREATE TABLE routing_profiles (
      project_id  TEXT PRIMARY KEY,
      template    TEXT,
      bindings    TEXT NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE duty_calendar (
      project_id  TEXT PRIMARY KEY,
      users       TEXT NOT NULL,                   -- JSON user id 列表，按 period_days 轮换
      start_at    INTEGER NOT NULL,
      period_days INTEGER NOT NULL DEFAULT 7,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE answers (
      id          TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id),
      user_id     TEXT REFERENCES users(id),        -- NULL = 系统（超时默认 / 冲突结论回写）
      message_id  TEXT REFERENCES messages(id),
      body        TEXT NOT NULL,
      stance      TEXT NOT NULL CHECK (stance IN ('answer','dissent','comment','withdrawn','superseded')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER
    );
    CREATE INDEX idx_answers_question ON answers(question_id, stance);
    ALTER TABLE questions ADD COLUMN decision_type TEXT;
    ALTER TABLE questions ADD COLUMN type_source TEXT;
    ALTER TABLE questions ADD COLUMN quorum TEXT;
    ALTER TABLE questions ADD COLUMN conflict_policy TEXT;
    ALTER TABLE questions ADD COLUMN route TEXT;
    ALTER TABLE questions ADD COLUMN informed TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE questions ADD COLUMN route_due_at INTEGER;
    ALTER TABLE questions ADD COLUMN notified_at INTEGER;
    ALTER TABLE questions ADD COLUMN origin_question_id TEXT;
    `);
    } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* 没开事务 */ } throw e; }
    finally { raw.exec('PRAGMA foreign_keys = ON'); }
    const upd = raw.prepare(`UPDATE questions SET decision_type=?, type_source='backfill' WHERE id=?`);
    for (const q of raw.prepare(`SELECT id, node_id, text FROM questions WHERE decision_type IS NULL`).all()) {
      upd.run(guessDecisionType(q.text, { nodeId: q.node_id }), q.id);
    }
  },
  // v8 → v9：待决事项打包摘要的发送记录。定时摘要按 (user, kind) 的上一条算间隔；
  // 换班交接按 (project, kind='handover') 的上一条判断"当班的人变了没有"。摘要正文不存 —— 它随时能从真相源重算。
  (raw) => raw.exec(`
    CREATE TABLE digests (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      kind       TEXT NOT NULL CHECK (kind IN ('scheduled','handover','manual')),
      project_id TEXT NOT NULL DEFAULT '',
      items      INTEGER NOT NULL DEFAULT 0,
      sent       INTEGER NOT NULL DEFAULT 0,
      sent_at    INTEGER NOT NULL,
      receipts   TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_digests_user ON digests(user_id, kind, sent_at);
    CREATE INDEX idx_digests_project ON digests(project_id, kind, sent_at);`),
  // v9 → v10：注册表三层落库 —— 服务商 / 模型目录 / 档位绑定。代码里的 VENDORS / MODEL_CATALOG / TIER_BINDING
  // 退为默认值，这三张表是**叠加在默认值上的部署级配置**（src/llm/registry.mjs 负责叠加）：
  //   - llm_endpoints：有行 = 覆盖或新增一个服务商；默认服务商的行里 NULL 字段继承代码默认值。
  //   - llm_models：同上；`enabled=0` 隐藏（退役 / 不想用）。
  //   - llm_bindings：三档各一行；表空时退回代码默认（init 会显式写入）。
  // 凭证**不在这里**：服务商只记 .env 里的变量名（key_env），库是所有人可读的真相源。
  (raw) => raw.exec(`
    CREATE TABLE llm_endpoints (
      id           TEXT PRIMARY KEY,                 -- 服务商 id = 目录键的前缀（'deepseek' / 'openrouter' / 'siliconflow' …）
      label        TEXT,
      adapter      TEXT CHECK (adapter IN ('openai-chat','openai-responses','anthropic','gemini')),
      base_url     TEXT,
      key_env      TEXT,                             -- .env 变量名；只记名字，永不记值
      auth_header  TEXT,                             -- NULL = API 格式默认（authorization / x-api-key / x-goog-api-key）
      auth_prefix  TEXT,                             -- 'Bearer ' 之类；NULL = API 格式默认
      models_path  TEXT,                             -- 模型列表路径；NULL = API 格式默认（/models）
      gateway      INTEGER,                          -- 1 = 聚合平台（带 provider 偏好、usage.include）；NULL = 继承
      billing      TEXT CHECK (billing IN ('computed','reported')),
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE llm_models (
      key            TEXT PRIMARY KEY,               -- 'vendor/model'（与代码目录同一键空间）
      vendor         TEXT,                           -- 服务商 id；NULL = 继承
      model          TEXT,                           -- 发给厂商的模型名；NULL = 继承
      adapter        TEXT,
      efforts        TEXT,                           -- JSON 数组；NULL = 继承 / 全部
      pricing        TEXT,                           -- JSON {input,output,cacheRead,cacheWrite}，USD / M token；NULL = 继承 / 缺
      context_window INTEGER,
      provider_prefs TEXT,                           -- JSON
      notes          TEXT,                           -- JSON 数组
      enabled        INTEGER NOT NULL DEFAULT 1,
      origin         TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','listed')),   -- listed = 从服务商列表加入
      updated_at     INTEGER NOT NULL
    );
    CREATE TABLE llm_bindings (
      tier       TEXT PRIMARY KEY CHECK (tier IN ('light','standard','heavy')),
      model_key  TEXT NOT NULL,
      effort     TEXT CHECK (effort IN ('low','medium','high')),   -- NULL = 各角色自己的默认推理强度
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );`),
  // v10 → v11：成员停用与交接。
  //   - users.disabled_at：停用 = 令牌全吊销 + 不再被解析成收件人；**不删行**（答复 / 审计 / 签收都挂在 user id 上）。
  //   - handover_requests：成员发起的"把我名下的责任交给某人"要负责人批准。不做成 questions 里的一种决策类型：
  //     事项必须挂在任务上而交接不属于任何任务；新增类型还会让所有现存路由表缺一行 * 而校验不过。
  (raw) => raw.exec(`
    ALTER TABLE users ADD COLUMN disabled_at INTEGER;
    CREATE TABLE handover_requests (
      id           TEXT PRIMARY KEY,
      from_user    TEXT NOT NULL REFERENCES users(id),
      to_user      TEXT NOT NULL REFERENCES users(id),
      scope        TEXT NOT NULL,                  -- JSON：{"project":"<id>"} / {"soloTasks":true} / {"all":true}
      note         TEXT,
      then_disable INTEGER NOT NULL DEFAULT 0,     -- 批准并执行后顺带停用 from_user
      status       TEXT NOT NULL CHECK (status IN ('open','approved','rejected','withdrawn')),
      requested_by TEXT NOT NULL REFERENCES users(id),
      requested_at INTEGER NOT NULL,
      decided_by   TEXT REFERENCES users(id),
      decided_at   INTEGER,
      decide_note  TEXT
    );
    CREATE INDEX idx_handover_requests ON handover_requests(status, requested_at);`),
  // v11 → v12：归档。纯显示标记（不是状态），按部署存；只许对已结束的任务 / 项目设（规则在 lifecycle.mjs）。
  (raw) => raw.exec(`
    ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
    ALTER TABLE projects ADD COLUMN archived_at INTEGER;`),
  // v12 → v13：项目成为唯一容器。
  //   - goal / done_definition：项目级的目标与完成定义（文字；新建必填，旧项目为空串）。项目级验收命令不在这里（是项目层参数）。
  //   - visibility：'all'（所有成员可见）/ 'members'（只有负责人、项目成员、管理员、以及被它的待决事项点到的人）。
  //   - project_members：负责人按项目派发。can_add_tasks = 能不能给这个项目加任务；note = 职能说明（给人看的）。
  //     "谁答哪类问题"不在这里 —— 那是按项目键的路由表（routing_rules）。
  //   旧的独立任务（project_id IS NULL）不迁移：原样保留、照旧能跑，只是不再有新建它们的入口。
  (raw) => raw.exec(`
    ALTER TABLE projects ADD COLUMN goal TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN done_definition TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
    CREATE TABLE project_members (
      project_id    TEXT NOT NULL REFERENCES projects(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      can_add_tasks INTEGER NOT NULL DEFAULT 0,
      note          TEXT NOT NULL DEFAULT '',
      added_by      TEXT NOT NULL REFERENCES users(id),
      added_at      INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );`),
  // v13 → v14：答复的立场多出"附议"与"弃权"。
  //   系统退出"按文字判一致"这件事（多人 + 自由文本必然误报成冲突：例如
  //   "按 A 处理，判据换成……" 与 "听后端的，按 A" 会被判为不一致，生成一条本不该有的冲突事项）。
  //   取而代之的是让人**显式**表态：
  //     - agree（附议）：明确同意已有的某一条答复，不写新文本，计入法定人数，不构成新的立场。
  //       agrees_with 记它附议的是哪一条 —— 没有这一列，"够数了但有两条答复"就还是要靠文字去猜。
  //     - abstain（弃权）：这不归我。从该事项的收件人里去掉自己，法定人数按剩余人数重算。
  //   stance 的 CHECK 要改，SQLite 只能重建表（与 users / projects 那两次同一套路）。
  (raw) => {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec(`
    CREATE TABLE IF NOT EXISTS answers_v2 (
      id          TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id),
      user_id     TEXT REFERENCES users(id),
      message_id  TEXT REFERENCES messages(id),
      body        TEXT NOT NULL,
      stance      TEXT NOT NULL CHECK (stance IN ('answer','agree','abstain','dissent','comment','withdrawn','superseded')),
      agrees_with TEXT REFERENCES answers_v2(id),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER
    );
    DELETE FROM answers_v2;
    INSERT INTO answers_v2 (id,question_id,user_id,message_id,body,stance,agrees_with,created_at,updated_at)
      SELECT id, question_id, user_id, message_id, body, stance, NULL, created_at, updated_at FROM answers;
    DROP TABLE answers;
    ALTER TABLE answers_v2 RENAME TO answers;
    CREATE INDEX idx_answers_question ON answers(question_id, stance);
    `);
    } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* 已回滚 */ } throw e; }
    finally { raw.exec('PRAGMA foreign_keys = ON'); }
  },
  // v14 → v15：决定登记。项目级、长期有效的"约定清单"，供"新意见 vs 尚未作废的旧决定"比对。
  //
  // ⚠️ 与既有的 decisions 表**不是**一回事，这一点想清楚了再改：decisions 是每个任务的叙事日志
  // （执行器为什么这么选、宪法升到第几版），大半由 agent 写。把它们混进比对清单，等于让模型对着
  // 一堆施工记录去判断"这条新需求推翻了什么约定"——误报会淹掉真命中，而"作废 / 取代"在施工记录上
  // 也没有意义。登记表只收**人拍过板**的四种来源：
  //   question  已有结论的待决事项（只收规格取舍与结构矛盾，见 core/decisions.mjs 的 DECIDING_TYPES）
  //   contract  批准过的契约里的行为规则 / 范围 / 验收命令
  //   revision  批准过的计划变更
  //   goal      项目目标与完成定义的改动
  //
  // 结构照假设登记表（supersedes + 有效 / 作废），但**没有 subject_key**：那一列在假设表里是
  // 模型生成的归一化键，靠它做精确匹配；这里的比对是轻档模型对着整张清单读，键帮不上忙，
  // 机械伪造一个只会给人一种"系统在按主题归并"的错觉。subject 是一句话主题，给人看的。
  // scope 是**召回式**预筛材料，不是执法依据 —— 同一处"从散文里抽路径"的启发式已经
  // 出过两次事，这里只让它做加法：抽不准就多带几条给模型看，不能少带。
  (raw) => raw.exec(`
    CREATE TABLE decision_registry (
      id            TEXT PRIMARY KEY,
      project_id    TEXT REFERENCES projects(id),
      task_id       TEXT REFERENCES tasks(id),
      subject       TEXT NOT NULL,
      statement     TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT '[]',
      source_kind   TEXT NOT NULL CHECK (source_kind IN ('question','contract','revision','goal')),
      source_id     TEXT,
      decided_by    TEXT REFERENCES users(id),
      decided_at    INTEGER NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('active','void')),
      supersedes    TEXT REFERENCES decision_registry(id),
      void_reason   TEXT,
      voided_at     INTEGER,
      voided_by     TEXT REFERENCES users(id),
      recorded_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_decreg_project ON decision_registry(project_id, status);
    CREATE INDEX idx_decreg_task ON decision_registry(task_id, status);`),
  // v15 → v16：params 多一个**项目层**。
  //
  // 没有这一层时上限只有两层：代码里的内置天花板（LIMITS[key].def）与任务覆盖（params.task_id）。中间少了
  // "这个项目的新任务默认多少"——于是每建一个任务就要重设一遍同样的六个旋钮，而"每个任务重设一遍"
  // 本身就是设计问题。项目预算闸让这一层有了真实需求：闸门按项目设，
  // 任务上限也该按项目设，两者必须能互相解释（"任务上限 × 任务数 > 项目闸门"是要当场看见的矛盾）。
  //
  // 为什么加列而不是新开一张 project_params：三层要能用**同一条**查找路径解释，否则"当前值来自哪一层"
  // 这句话在代码里就是两套 if。params 没有任何表用外键指过来（出处边走通用的 edges），重建是纯拷贝。
  // layer 的 CHECK 要加 'project'，SQLite 改不了 CHECK —— 与 users / projects / answers 那三次同一套路：
  // 关外键、幂等、整段一个事务。
  (raw) => {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec(`
    CREATE TABLE IF NOT EXISTS params_v2 (
      id                TEXT PRIMARY KEY,
      task_id           TEXT REFERENCES tasks(id),     -- NULL 且 project_id NULL = 部署级默认
      project_id        TEXT REFERENCES projects(id),  -- 非 NULL = 项目层（此时 task_id 必为 NULL）
      key               TEXT NOT NULL,
      value             TEXT NOT NULL,
      layer             TEXT NOT NULL CHECK (layer IN ('system','project','task','branch')),
      governance_class  TEXT NOT NULL CHECK (governance_class IN ('execution','constitutional')),
      set_by_kind       TEXT NOT NULL CHECK (set_by_kind IN ('agent','user')),
      set_by_id         TEXT,
      valid_from        INTEGER NOT NULL,
      valid_to          INTEGER,
      recorded_at       INTEGER NOT NULL,
      superseded_at     INTEGER,
      CHECK (governance_class <> 'constitutional' OR set_by_kind = 'user'),
      CHECK (project_id IS NULL OR task_id IS NULL)
    );
    DELETE FROM params_v2;
    INSERT INTO params_v2 (id,task_id,project_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,valid_to,recorded_at,superseded_at)
      SELECT id,task_id,NULL,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,valid_to,recorded_at,superseded_at FROM params;
    DROP TABLE params;
    ALTER TABLE params_v2 RENAME TO params;
    CREATE INDEX idx_params_lookup ON params(task_id, key, superseded_at);
    CREATE INDEX idx_params_project ON params(project_id, key, superseded_at);
    `);
    } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* 已回滚 */ } throw e; }
    finally { raw.exec('PRAGMA foreign_keys = ON'); }
  },
  // v16 → v17：契约多一列 `scope_paths` —— **结构化的范围**。
  //
  // 没有这一列时，"这个任务能动哪些文件"是从一段自由文本里用正则抽出来的（`routing.prefixesOfScope`）。
  // 那个抽取器出过两次事（越界校验放过了不该放的、路由按范围找错了人），而它同时是
  // 三件事的判据：执行器的越界校验、路由表的"触及范围"、批准页的范围重叠预警。
  // 一个跑在散文上的正则同时承重这三件事，是这个项目里最贵的一处启发式。
  //
  // 所以让规划器**直接给路径**：`scope_paths` 是字符串数组，`src/a/` 这样带斜杠结尾的是目录前缀，
  // 不带的是具体文件。散文的 `scope` **保留不动** —— 它写的是"为什么只动这些、不许碰什么"，
  // 那是给人和执行器读的，不是判据。老契约这一列是 `[]`，判据照旧回落 `prefixesOfScope`。
  (raw) => {
    raw.exec(`ALTER TABLE constitutions ADD COLUMN scope_paths TEXT NOT NULL DEFAULT '[]'`);
  },
  // v17 → v18：决定登记多一列 `reservation` —— **这一条是保留意见，不是约定**。
  //
  // 例：负责人批准一份计划变更时写下「下限截到 1 那条……他没明确说之前，
  // 这条先别当硬规则写进宪法」；如果这一页只有批 / 驳两个按钮，他只能改口「不值得为这一条
  // 卡住正题 —— 批」。那条他明说"先别写进宪法"的规则，就被他自己批进了宪法。
  // **这不是他改主意，是界面上没有地方放那句话。**
  //
  // 所以给它一个地方。用一列而不是在 subject 前面加个前缀：保留意见与约定必须**机械可分** ——
  // 它进上下文、但不参与决定冲突比对（它不是一条能被违反的规则），两处判断都读这一列。
  (raw) => {
    raw.exec(`ALTER TABLE decision_registry ADD COLUMN reservation INTEGER NOT NULL DEFAULT 0`);
  },
  // v18 → v19：修正消息多一列 `held_until` —— **这条修正还在比对，先别拉**。
  //
  // 签收打回的时序是：答复落库 → 钩子当场生成修正消息 → 然后才调轻档模型比对（几秒）→ 命中挂冲突事项。
  // 守护进程在另一个进程里，完全可能在冲突事项挂出来之前就把那条修正拉走、交给重规划器 ——
  // 于是"以旧为准"的裁定来得再快，那句话也已经被执行了。
  // 用时间戳而不是布尔：比对器所在的进程死在半路时，这条修正到点自己放行，不会被卡死。
  (raw) => {
    raw.exec(`ALTER TABLE messages ADD COLUMN held_until INTEGER`);
  },
  // v19 → v20：联网从"固定 5 类、按任务开、按数量设上限"改成两层 ——
  //   ① 联网目录（部署级，管理员维护）：每项一个"源"，软件源或信息源；内置原来那 5 类，可以加自己的（镜像、私有仓库、
  //      可信的资料站）。信息源默认只读（代理只放行 GET / HEAD / OPTIONS）。软件源可带"工具配置"（如 PIP_INDEX_URL），
  //      否则加了镜像工具也不会去用。
  //   ② 项目联网（项目负责人勾选）：项目下所有任务共用，不再有任务层的单独加开。
  // 内置项的 id 就是原来的生态名（npm / pypi / …），所以旧的 `egress.groups` 值不用改写就能读。
  // 项目任务上的旧放行名单按项目取并集，写成项目层的 `egress.sources`；没有项目的老独立任务照旧按任务读。
  (raw) => {
    raw.exec(`CREATE TABLE egress_sources (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('package','info')),
      hosts       TEXT NOT NULL,
      read_only   INTEGER NOT NULL DEFAULT 0,
      tool_env    TEXT NOT NULL DEFAULT '{}',
      note        TEXT NOT NULL DEFAULT '',
      builtin     INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT,
      created_at  INTEGER NOT NULL,
      removed_at  INTEGER
    )`);
    const t = Date.now();
    // 名称 / 说明是数据（入库后可改），N_ 只为登记给目录：看板显示时 T(name) 能翻出内置源的英文，用户自己加的原样
    const seed = raw.prepare(`INSERT INTO egress_sources (id,name,kind,hosts,read_only,tool_env,note,builtin,created_at) VALUES (?,?,'package',?,0,'{}',?,1,?)`);
    for (const [id, name, hosts, note] of [
      ['npm', N_('npm 官方源'), ['registry.npmjs.org'], N_('npm install 用')],
      ['pypi', N_('PyPI 官方源'), ['pypi.org', 'files.pythonhosted.org'], N_('pip install 用：元数据与下载分属两个域，缺一个会在下载阶段失败')],
      ['github', 'GitHub', ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'], N_('git clone、API、源码包与原始文件')],
      ['crates', 'crates.io', ['crates.io', 'static.crates.io', 'index.crates.io'], N_('Rust / cargo 用')],
      ['goproxy', N_('Go 模块代理'), ['proxy.golang.org', 'sum.golang.org'], N_('go mod download 用')],
    ]) seed.run(id, name, JSON.stringify(hosts), note, t);
    const rows = raw.prepare(`SELECT t.project_id AS pid, p.value AS v FROM params p JOIN tasks t ON t.id=p.task_id
                              WHERE p.key='egress.groups' AND p.superseded_at IS NULL AND t.project_id IS NOT NULL`).all();
    const byProject = new Map();
    for (const r of rows) { let v = []; try { v = JSON.parse(r.v); } catch { /* 坏值跳过 */ } for (const g of (Array.isArray(v) ? v : [])) (byProject.get(r.pid) ?? byProject.set(r.pid, new Set()).get(r.pid)).add(g); }
    const ins = raw.prepare(`INSERT INTO params (id,task_id,project_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
                             VALUES (?,NULL,?,'egress.sources',?,'project','constitutional','user',NULL,?,?)`);
    for (const [pid, set] of byProject) ins.run(`p_mig20_${pid}`, pid, JSON.stringify([...set]), t, t);
  },
  // v20 → v21：决策类型加「运维」（ops）—— 系统卡住了（合并出错、工作区里有来路不明的改动、长时间没动静、
  // 改计划没成），要有人看一眼、决定怎么办。原来这些都走「结构矛盾」，而结构矛盾必须送负责人（level3）：
  // 每条停等报警都至少发两个人。分出来之后负责人可以只派给管代码的那一位。
  // SQLite 改不了 CHECK：重建 routing_rules（没有外键指向它）。已存的表里没有 ops 的行 —— 读的时候按结构矛盾那几行补（routing.rulesOf）。
  (raw) => {
    {
      raw.exec(`CREATE TABLE routing_rules_v21 (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL DEFAULT '',
        decision_type   TEXT NOT NULL CHECK (decision_type IN
                          ('spec_choice','structural','contract_approval','signoff','budget','egress','delivery','conflict','ops')),
        scope           TEXT NOT NULL DEFAULT '*',
        position        INTEGER NOT NULL DEFAULT 0,
        recipients      TEXT NOT NULL DEFAULT '[]',
        quorum          TEXT NOT NULL DEFAULT '1',
        conflict_policy TEXT NOT NULL DEFAULT 'block' CHECK (conflict_policy IN ('block','latest')),
        timeout_action  TEXT NOT NULL DEFAULT 'hang' CHECK (timeout_action IN ('hang','next','default')),
        timeout_after   TEXT,
        template        TEXT,
        created_at      INTEGER NOT NULL
      );
      INSERT INTO routing_rules_v21 SELECT id, project_id, decision_type, scope, position, recipients, quorum, conflict_policy, timeout_action, timeout_after, template, created_at FROM routing_rules;
      DROP TABLE routing_rules;
      ALTER TABLE routing_rules_v21 RENAME TO routing_rules;
      CREATE INDEX idx_routing_rules ON routing_rules(project_id, decision_type, scope, position);`);
    }
  },
  // v21 → v22（0.2.0 多语言）：每人的界面语言。NULL = 跟随部署的内容语言（设置 deploy.content_lang）。
  // 先看列在不在：测试会把新库的版本号拨回去重跑某一段迁移，已有的列再加一次会报 duplicate column。
  (raw) => { if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='lang'`).get()) raw.exec(`ALTER TABLE users ADD COLUMN lang TEXT CHECK (lang IS NULL OR lang IN ('zh','en'))`); },
  // v22 → v23（2026-10-12）：补回 params 的"只增不删"触发器。v16 重建 params 时 DROP TABLE 把它
  // 一起删了、没重建 —— 从那以后每个库（新建的也一样，新库同样走一遍迁移）都缺这条护栏。没有代码删 params，
  // 所以没丢数据；丢的是"库层兜底"。tests/schema.test.mjs 现在钉住：schema.sql 与迁移里声明过的对象迁移完都还在，
  // 只增表真删不掉，整库形状与金样一致 —— 以后哪条重建迁移再漏，当场红。
  (raw) => raw.exec(`CREATE TRIGGER IF NOT EXISTS trg_params_no_delete BEFORE DELETE ON params
BEGIN SELECT RAISE(ABORT, 'params: supersede instead of delete'); END;`),
  // v23 → v24（2026-10-12）：账本记"哪个进程花的"。复盘原来只能按时间窗口猜一笔钱落在哪段进程寿命里，
  // 看板 / 守护进程直接发的调用（分类、决定比对、汇报）根本没有寿命括号 —— 本机真实库里一跑就是上百条"落在所有寿命之外"。
  // 有了进程种类 + pid，复盘按 pid 对到具体那一段寿命；看板 / 守护进程花的单列。老行两列为空，复盘退回按时间窗口判。
  (raw) => {
    const has = (c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('usage_ledger') WHERE name=?`).get(c);
    if (!has('proc_kind')) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN proc_kind TEXT`);
    if (!has('proc_pid')) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN proc_pid INTEGER`);
  },
  // v24 → v25（2026-10-12）：状态迁移的库层守卫。七张带状态的表，每张一个 BEFORE UPDATE 触发器：
  // 不在允许表里的迁移直接拦（例：答复过的事项改回 open、作废的步骤复活、中止的任务不恢复就算完成）。
  // 允许表的真相源是 src/db/state.mjs 的 TRANSITIONS；这里是生成时刻的字面量快照 —— 迁移一经发布就不改，
  // 以后放宽 / 收紧要配新迁移（DROP 再 CREATE）。tests/state.test.mjs 比对两边一致。
  (raw) => raw.exec(`
CREATE TRIGGER IF NOT EXISTS trg_tasks_transition BEFORE UPDATE OF status ON tasks
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('planning>running','planning>waiting','planning>suspended','planning>done','planning>aborted','running>planning','running>waiting','running>suspended','running>done','running>aborted','waiting>planning','waiting>running','waiting>suspended','waiting>done','waiting>aborted','suspended>planning','suspended>running','suspended>waiting','suspended>aborted','done>planning','done>running','done>waiting','done>suspended','done>aborted','aborted>planning','aborted>running','aborted>waiting','aborted>suspended')
  BEGIN SELECT RAISE(ABORT, 'tasks: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_nodes_transition BEFORE UPDATE OF status ON nodes
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('pending>ready','pending>running','pending>blocked','pending>review','pending>done','pending>void','pending>failed','ready>pending','ready>running','ready>blocked','ready>review','ready>done','ready>void','ready>failed','running>pending','running>blocked','running>review','running>done','running>void','running>failed','blocked>pending','blocked>ready','blocked>running','blocked>void','blocked>failed','review>pending','review>running','review>done','review>void','review>failed','done>pending','done>void','failed>pending','failed>void')
  BEGIN SELECT RAISE(ABORT, 'nodes: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_questions_transition BEFORE UPDATE OF status ON questions
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('open>escalated','open>answered','open>defaulted','open>withdrawn','escalated>answered','escalated>defaulted','escalated>withdrawn')
  BEGIN SELECT RAISE(ABORT, 'questions: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_projects_transition BEFORE UPDATE OF status ON projects
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('proposed>active','proposed>done','proposed>aborted','active>proposed','active>done','active>stalled','active>aborted','stalled>active','stalled>done','stalled>aborted','done>active','done>stalled','done>aborted','aborted>proposed','aborted>active')
  BEGIN SELECT RAISE(ABORT, 'projects: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_revisions_transition BEFORE UPDATE OF status ON revisions
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('proposed>applied','proposed>rejected')
  BEGIN SELECT RAISE(ABORT, 'revisions: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_handover_requests_transition BEFORE UPDATE OF status ON handover_requests
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('open>approved','open>rejected','open>withdrawn')
  BEGIN SELECT RAISE(ABORT, 'handover_requests: illegal status transition'); END;
CREATE TRIGGER IF NOT EXISTS trg_decision_registry_transition BEFORE UPDATE OF status ON decision_registry
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('active>void')
  BEGIN SELECT RAISE(ABORT, 'decision_registry: illegal status transition'); END;
`),
  // v25 → v26（2026-10-12）：租约。按到期时间接管、不看 pid；接管时代数 +1，关键写入核对代数（见 db/lease.mjs）。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS leases (
    resource      TEXT PRIMARY KEY,
    holder        TEXT NOT NULL,
    pid           INTEGER,
    epoch         INTEGER NOT NULL CHECK (epoch >= 1),
    acquired_at   INTEGER NOT NULL,
    heartbeat_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    meta          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
  ) STRICT;`),
  // v26 → v27（2026-10-12）：审计轨的两个二级索引。拿全套测试的语句普查（545 种）在真实库上逐条
  // EXPLAIN：57 种查询整表扫 audit_log —— 守护进程每 15 秒扫一遍"某对象的某动作""某动作在某时段"，审计轨只增不减，
  // 跑得越久越慢。(target_id, action) 覆盖前者（rowid 隐含在索引末尾，ORDER BY id DESC LIMIT 1 也走它）；(action, ts) 覆盖后者。
  // 同一轮源码扫描（tests/query-plans.test.mjs）还查出账本按步骤汇总花费（升档、修正的作废确认门）整表扫：补 (node_id)。
  (raw) => raw.exec(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_id, action);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_node ON usage_ledger(node_id);`),
  // v27 → v28（2026-10-12）：汇报的窗口改按各表的 rowid 游标切，不按墙钟时刻 —— 墙钟会被校时往回拨，
  // 回拨那一下发生的事就落在"上一份之前"、两份汇报都不提（WSL 上的一次偶发失败就是它）。游标 = 生成汇报那一刻各表的最大 rowid（JSON）。
  (raw) => { if (!raw.prepare(`SELECT 1 FROM pragma_table_info('reports') WHERE name='cursor'`).get()) raw.exec(`ALTER TABLE reports ADD COLUMN cursor TEXT CHECK (cursor IS NULL OR json_valid(cursor))`); },
  // v28 → v29（2026-10-12）：schema 质量批次。下面的约束清单是**冻结的**（迁移不能事后改），以后要加约束另起一级。
  //   ① 全部表重建为 STRICT（leases 原本就是）：类型不对的值当场被拒，不再按"亲和性"悄悄存成别的类型。
  //      先在 23 个实际运行试跑库上普查过：没有一个值类型不符（时间戳全是整数毫秒，金额全是整数微美元）。
  //   ② 29 个 JSON 列加 json_valid + 形状（数组 / 对象）约束（加上原有的 leases.meta、reports.cursor，JSON 列全部有约束）。形状按实际运行数据逐列核过（单一形状，无一例外）；
  //      revisions.constitution_patch 只要求合法 JSON（理由见下）。
  //   ③ 只给**封闭**的枚举加 CHECK：问题的类型 / 类型来源 / 冲突策略 / 法定人数格式，项目可见性。
  //      不加的：路由模板名（来自 routing-templates.json，是可扩的配置）、角色名、审计动作名 —— 给开放集合加 CHECK，
  //      以后每多一个值都得整表重建一次。
  //   ④ 没加 NOT NULL：23 个"实际运行数据里从未为 NULL"的可空列逐个看过代码，每个都有合法的 NULL 状态
  //      （问题刚插入还没路由、修订待定还没 resolved、系统写的答复没有 user_id……），数据没出现不等于不会出现。
  //   ⑤ 删三张从没有读者、也从没写过一行的表（impact_marks / meetings / notifications，23 个库里都是 0 行），
  //      和 v8 起就废弃的 users.can_answer。
  //   ⑥ 审计加 payload_v（payload 的形状版本）：新写的行记当前版本（见 db/audit-payload.mjs），旧行留 NULL —— 不改写历史，
  //      读的时候按版本升级。
  (raw) => {
    raw.exec(`DROP TABLE IF EXISTS impact_marks; DROP TABLE IF EXISTS meetings; DROP TABLE IF EXISTS notifications;`);
    const hasCol = (t, c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c);
    if (hasCol('users', 'can_answer')) raw.exec(`ALTER TABLE users DROP COLUMN can_answer`);
    if (!hasCol('audit_log', 'payload_v')) raw.exec(`ALTER TABLE audit_log ADD COLUMN payload_v INTEGER CHECK (payload_v IS NULL OR payload_v >= 1)`);
    // json_type 碰到不合法的 JSON 会直接报错而不是给 false，所以先 json_valid 再看形状
    const shape = (col, ty) => ({ name: `${col}_json`, expr: `"${col}" IS NULL OR CASE WHEN json_valid("${col}") THEN json_type("${col}") = '${ty}' ELSE 0 END` });
    const arr = (col) => shape(col, 'array'), obj = (col) => shape(col, 'object');
    const oneOf = (col, vals) => ({ name: `${col}_enum`, expr: `"${col}" IS NULL OR "${col}" IN (${vals.map((v) => `'${v}'`).join(',')})` });
    const quorum = { name: 'quorum_format', expr: `quorum IS NULL OR quorum = 'all' OR (quorum GLOB '[1-9]*' AND quorum NOT GLOB '*[^0-9]*')` };
    const EXTRA = {
      audit_log: [obj('payload')],
      constitutions: [arr('constraints'), arr('scope_paths')],
      questions: [arr('addressed_to'), obj('route'), arr('informed'),
        oneOf('decision_type', ['spec_choice', 'structural', 'contract_approval', 'signoff', 'budget', 'egress', 'delivery', 'conflict', 'ops']),
        oneOf('type_source', ['hard_rule', 'self', 'default', 'backfill']), oneOf('conflict_policy', ['block', 'latest']), quorum],
      handoffs: [arr('artifacts'), arr('known_issues')],
      context_assemblies: [arr('items')],
      // constitution_patch 只要求是合法 JSON、不限形状：它原样存模型给的方案，形状不对是已知状态（确认门照样开、
      // 人来看，applyRevision 响亮地失败，见 tests/revision.test.mjs）—— 库层在这里抛异常反而让修正流程中途崩掉
      revisions: [arr('impact'), arr('salvage'), arr('changed_nodes'), arr('new_nodes'),
        { name: 'constitution_patch_json', expr: `constitution_patch IS NULL OR json_valid(constitution_patch)` }],
      reports: [obj('facts'), arr('gaps')],
      users: [arr('domain_tags')],
      routing_profiles: [obj('bindings')],
      routing_rules: [arr('recipients'), quorum],
      decision_registry: [arr('scope')],
      egress_sources: [arr('hosts'), obj('tool_env')],
      digests: [arr('receipts')],
      duty_calendar: [arr('users')],
      handover_requests: [obj('scope')],
      llm_models: [arr('efforts'), obj('pricing'), obj('provider_prefs'), arr('notes')],
      projects: [oneOf('visibility', ['all', 'members'])],
    };
    const tables = raw.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
    for (const t of Object.keys(EXTRA)) if (!tables.some((x) => x.name === t)) throw new Error(`v29：约束清单里的表 ${t} 不存在`);
    const plan = tables.filter((t) => !/\)\s*STRICT\s*$/i.test(t.sql)).map((t) => ({ table: t.name, checks: EXTRA[t.name] ?? [] }));
    rebuildTables(raw, plan, { suffix: '_v29' });
  },
  // v29 → v30（2026-10-12）：事项"推到过谁"。通知原来按事项只发一次（notified_at），转交 / 超时转下一行 /
  // 全员弃权转负责人之后的新收件人永远收不到推送（tests/question-notify.test.mjs）。改为记推到过的人，通知只推还没推过的。
  // 已经推过的旧事项回填为当时的收件人与知会人 —— 不回填的话，升级后每条开放事项都会把所有人重推一遍。
  (raw) => {
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('questions') WHERE name='notified_to'`).get()) {
      raw.exec(`ALTER TABLE questions ADD COLUMN notified_to TEXT NOT NULL DEFAULT '[]'
        CONSTRAINT notified_to_json CHECK (CASE WHEN json_valid(notified_to) THEN json_type(notified_to) = 'array' ELSE 0 END)`);
    }
    raw.exec(`UPDATE questions SET notified_to = (SELECT json_group_array(value) FROM
      (SELECT value FROM json_each(addressed_to) UNION SELECT value FROM json_each(informed)))
      WHERE notified_at IS NOT NULL AND notified_to = '[]'`);
  },
  // v30 → v31（2026-10-12）：参数同一作用域 + 键同一时刻只有一行现值，由库层保证。原来"先作废再插入"散在 8 个文件、
  // 一半没包事务，读的一侧只好 ORDER BY recorded_at DESC LIMIT 1 防着重复；写入收口到 core/params.mjs 的 writeParam 之后，
  // 用唯一索引把它钉死（23 个实际运行库里没有一组重复的现值）。
  (raw) => raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_params_current ON params(ifnull(task_id,''), ifnull(project_id,''), key) WHERE superseded_at IS NULL`),
  // v31 → v32（2026-10-12）：身份与会话。原来一个人一枚长期令牌，团队模式的"登录"就是把它明文种进 cookie（30 天），
  // 退出只清 cookie、令牌照样有效；没有过期、没有类型、没有"在哪用过"。
  //   tokens：name / kind（cli 命令行 · session 浏览器会话 · service 服务账户）/ scope（read 只读 · write 读写）/ expires_at 绝对过期 /
  //           idle_ms 闲置多久失效 / last_used_at · last_ip / parent_id（会话由哪枚令牌登录换来；那枚失效，会话跟着失效）。
  //           已有的令牌：kind=cli、scope=write、不过期 —— 升级不能把正在用的部署锁在门外（看板上会标"没有过期时间，建议重发"）。
  //   users.kind：human / service（服务账户与人分开：不能登录看板、不能当负责人）。
  //   audit_log.on_behalf_of：服务账户替谁做的（actor 是服务账户本身）。
  //   invites：一次性邀请链接（库里只存哈希、短时效、绑定角色；接受后作废）。
  (raw) => {
    const has = (t, c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c);
    const add = (t, c, ddl) => { if (!has(t, c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`); };
    add('tokens', 'name', `name TEXT`);
    add('tokens', 'kind', `kind TEXT NOT NULL DEFAULT 'cli' CONSTRAINT token_kind CHECK (kind IN ('cli','session','service'))`);
    add('tokens', 'scope', `scope TEXT NOT NULL DEFAULT 'write' CONSTRAINT token_scope CHECK (scope IN ('read','write'))`);
    add('tokens', 'expires_at', `expires_at INTEGER`);
    add('tokens', 'idle_ms', `idle_ms INTEGER CONSTRAINT token_idle CHECK (idle_ms IS NULL OR idle_ms > 0)`);
    add('tokens', 'last_used_at', `last_used_at INTEGER`);
    add('tokens', 'last_ip', `last_ip TEXT`);
    add('tokens', 'parent_id', `parent_id TEXT REFERENCES tokens(id)`);
    add('users', 'kind', `kind TEXT NOT NULL DEFAULT 'human' CONSTRAINT user_kind CHECK (kind IN ('human','service'))`);
    add('audit_log', 'on_behalf_of', `on_behalf_of TEXT`);
    raw.exec(`CREATE TABLE IF NOT EXISTS invites (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      role        TEXT NOT NULL CHECK (role IN ('member','observer')),
      name        TEXT,
      created_by  TEXT NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER,
      used_by     TEXT REFERENCES users(id),
      revoked_at  INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_parent ON tokens(parent_id);`);
    raw.exec(`UPDATE tokens SET name='${N_('（升级前签发）')}' WHERE name IS NULL`);
  },
  // v32 → v33（2026-10-12）：幂等键。POST 带 Idempotency-Key 时存 (人, 键) → 结果：网络断了重试不会把"签收""答复"做两遍。
  // 不是只增表：一天后清掉（守护进程日常清理）。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id     TEXT NOT NULL REFERENCES users(id),
    key         TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    req_hash    TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('pending','done')),
    status      INTEGER,
    body        TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);`),
  // v33 → v34（2026-10-12）：按人记账与预占。
  //   usage_ledger.payer_id / payer_scope：这笔钱记在谁头上（口径由部署设置 deploy.cost_attribution 定）。账本只增不改，
  //     旧行不回填（留 NULL），读的时候按"发起人"口径算 —— 与默认口径一致。
  //   users.budget_usd_month：这个人每月的预算（美元整数；NULL = 用部署默认 deploy.person_budget_usd_month）。
  //   budget_reservations：每次模型调用前按最坏情况预占的额度（事务里与闸门一起判），调用结束结算即删；
  //     几个编排器并发时不会一起越过闸门。进程死了留下的预占到期自动不算。
  (raw) => {
    const has = (t, c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c);
    if (!has('usage_ledger', 'payer_id')) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN payer_id TEXT REFERENCES users(id)`);
    if (!has('usage_ledger', 'payer_scope')) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN payer_scope TEXT CONSTRAINT payer_scope_enum CHECK (payer_scope IS NULL OR payer_scope IN ('user','project'))`);
    if (!has('users', 'budget_usd_month')) raw.exec(`ALTER TABLE users ADD COLUMN budget_usd_month INTEGER CONSTRAINT user_budget CHECK (budget_usd_month IS NULL OR budget_usd_month >= 0)`);
    raw.exec(`CREATE TABLE IF NOT EXISTS budget_reservations (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      project_id  TEXT REFERENCES projects(id),
      payer_id    TEXT REFERENCES users(id),
      micro_usd   INTEGER NOT NULL CHECK (micro_usd >= 0),
      holder      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_resv_expires ON budget_reservations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_usage_payer ON usage_ledger(payer_id, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);`);
  },
  // v34 → v35（2026-10-12）：连接（凭据）。原来整个部署一份 GITHUB_TOKEN（.env），不分人、不分仓库、长期有效。
  //   凭据挂在"连接"上，不挂在项目上：项目只记远端地址，每次动作按"动作 + 远端 + 操作人"现场解析用哪份（core/credentials.mjs）。
  //   secret 是 AES-256-GCM 密文（主密钥在库外，附加数据绑定行 id —— 把密文挪到别的行解不开）；只写不读，界面只显示 hint。
  //   owner_id NULL = 部署级（管理员加）；否则是某个成员自己的，只用于他本人发起的动作（防混淆代理）。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS credentials (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('token','github_app','ssh_key')),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    owner_id     TEXT REFERENCES users(id),
    host         TEXT NOT NULL CHECK (length(host) > 0 AND host = lower(host)),
    path_glob    TEXT NOT NULL DEFAULT '*' CHECK (length(path_glob) > 0),
    secret       TEXT NOT NULL CHECK (json_valid(secret) AND json_type(secret) = 'object'),
    hint         TEXT NOT NULL,
    meta         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND json_type(meta) = 'object'),
    expires_at   INTEGER,
    created_by   TEXT NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    revoked_by   TEXT REFERENCES users(id),
    last_used_at INTEGER,
    last_check   TEXT CHECK (last_check IS NULL OR (json_valid(last_check) AND json_type(last_check) = 'object'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_cred_host ON credentials(host) WHERE revoked_at IS NULL;`),
  // v35 → v36（2026-10-12 修改溯源）：
  //   ① 契约条款：constitutions.clauses = [{key, kind, text}]（core/clauses.mjs 切条编号，跨版本同文字沿用旧号）。老数据按版本顺序回填。
  //   ② 出处边只增：原来 edges 没有任何触发器，出处能被删改 —— "这处改动凭什么"的证据链自己就不可信。
  //      现在不许删；改只许"把还在算数的边置为不算数"（superseded_at 由空变非空、valid_to 跟着记），别的列一个都不许动。
  (raw) => {
    const has = !!raw.prepare(`SELECT 1 FROM pragma_table_info('constitutions') WHERE name='clauses'`).get();
    if (!has) raw.exec(`ALTER TABLE constitutions ADD COLUMN clauses TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(clauses) AND json_type(clauses) = 'array')`);
    const rows = raw.prepare(`SELECT id, task_id, goal, scope, definition_of_done, constraints FROM constitutions ORDER BY task_id, version`).all();
    const upd = raw.prepare(`UPDATE constitutions SET clauses=? WHERE id=?`);
    let task = null, prev = [], max = 0;
    for (const r of rows) {
      if (r.task_id !== task) { task = r.task_id; prev = []; max = 0; }
      const cl = assignClauseKeys(splitClauses(r), { prev, maxUsed: max });
      upd.run(JSON.stringify(cl), r.id);
      prev = cl; max = Math.max(max, maxClauseNum([JSON.stringify(cl)]));
    }
    raw.exec(`CREATE TRIGGER IF NOT EXISTS trg_edges_no_delete BEFORE DELETE ON edges
BEGIN SELECT RAISE(ABORT, 'edges: append-only, supersede instead of delete'); END;
CREATE TRIGGER IF NOT EXISTS trg_edges_supersede_only BEFORE UPDATE ON edges
WHEN NOT (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.from_id IS OLD.from_id AND NEW.to_id IS OLD.to_id AND NEW.relation IS OLD.relation
  AND NEW.valid_from IS OLD.valid_from AND NEW.recorded_at IS OLD.recorded_at
  AND (OLD.valid_to IS NULL OR NEW.valid_to IS OLD.valid_to))
BEGIN SELECT RAISE(ABORT, 'edges: append-only, only superseded_at/valid_to may be set once'); END;`);
  },
  // v36 → v37（2026-10-12 修改溯源）：成员的 GitHub 账号与提交邮箱 —— 提交 trailer / PR 溯源表里写人名，
  //   部署开了 Co-authored-by 时用提交邮箱（GitHub 按邮箱认人、显示头像；建议填 GitHub 的 noreply 地址）。都可空。
  (raw) => {
    const has = (c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name=?`).get(c);
    if (!has('github_login')) raw.exec(`ALTER TABLE users ADD COLUMN github_login TEXT CHECK (github_login IS NULL OR (length(github_login) BETWEEN 1 AND 39 AND github_login NOT GLOB '*[^A-Za-z0-9-]*'))`);
    if (!has('commit_email')) raw.exec(`ALTER TABLE users ADD COLUMN commit_email TEXT CHECK (commit_email IS NULL OR (instr(commit_email, '@') > 1 AND length(commit_email) <= 254))`);
  },
  // v37 → v38（2026-10-12 身份与会话扩展：用 GitHub 登录 + 必须是组织成员）：users.github_id = GitHub 的数字用户 id。
  //   账号名可以改、改了还能被别人注册走，所以登录按数字 id 认人：第一次用 GitHub 登录时按成员资料里填的账号对上人、记下 id，
  //   以后只认 id（账号改了名跟着更新）。管理员改了某人的 GitHub 账号就解绑（core/users.mjs setGitIdentity）。
  (raw) => {
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='github_id'`).get()) raw.exec(`ALTER TABLE users ADD COLUMN github_id INTEGER CHECK (github_id IS NULL OR github_id > 0)`);
    raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL`);
  },
  // v38 → v39（2026-10-12 时间与日历时间与日历）：
  //   duty_calendar.overrides = 换班：[{ from, to, user, note? }]，from / to 是部署时区的日期（含两端），这几天整天由 user 值班，
  //     不改轮换本身（轮换照旧往下数）。原来值班表只有"名单 + 起点 + 周期"，有人请假只能改整张表。
  //   users.tz = 成员自己的时区，只影响给他看的时刻（看板、摘要）；空 = 跟部署时区。业务日、换班、月度预算一律按部署时区算。
  (raw) => {
    const has = (t, c) => !!raw.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c);
    if (!has('duty_calendar', 'overrides')) raw.exec(`ALTER TABLE duty_calendar ADD COLUMN overrides TEXT NOT NULL DEFAULT '[]'
      CONSTRAINT overrides_json CHECK (CASE WHEN json_valid(overrides) THEN json_type(overrides) = 'array' ELSE 0 END)`);
    if (!has('users', 'tz')) raw.exec(`ALTER TABLE users ADD COLUMN tz TEXT CHECK (tz IS NULL OR length(tz) BETWEEN 1 AND 64)`);
  },
  // v39 → v40（2026-10-14）：按角色绑定模型。档位（llm_bindings）仍是底子；某个角色单独绑了就用这里的、不再看档位。
  //   角色名是闭集（llm/canonical.mjs 的 LLM_ROLES），库层 CHECK 钉住：写进一个代码不认的角色，只会静默不生效。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS llm_role_bindings (
      role       TEXT PRIMARY KEY CHECK (role IN ('planner','project_planner','elicitor','replanner','executor','verifier','classifier','reporter','decision-check')),
      model_key  TEXT NOT NULL,
      effort     TEXT CHECK (effort IN ('low','medium','high')),   -- NULL = 跟着这个模型所在档位 / 角色自己的默认
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    ) STRICT`),
  // v40 → v41（2026-10-14）：nodes.ui_checks = 这一步的界面条目，要在运行起来的页面上看到 / 点到才算数的事项。
  //   JSON 字符串数组，NULL = 没有（命令行、后端、纯文档的步骤）。规划器写，执行器看得到，验收员必须逐条点验、给出结果。
  (raw) => {
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('nodes') WHERE name='ui_checks'`).get()) raw.exec(`ALTER TABLE nodes ADD COLUMN ui_checks TEXT
      CONSTRAINT ui_checks_json CHECK (ui_checks IS NULL OR (CASE WHEN json_valid(ui_checks) THEN json_type(ui_checks) = 'array' ELSE 0 END))`);
  },
  // v41 → v42（2026-10-14）：question_views = 某人在看板上第一次看到某条事项的时间。
  //   监测走过场用（core/approval-habits.mjs）：打开到答复的时长。只记第一次；命令行 / 通知里答复的没有这一行。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS question_views (
      question_id TEXT NOT NULL REFERENCES questions(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      first_at    INTEGER NOT NULL,
      PRIMARY KEY (question_id, user_id)
    ) STRICT`),
  // v42 → v43（2026-10-14）：厂商熔断与共享退避（llm/health.mjs）；档位的备用模型。
  //   llm_health：每个服务商（网关按"网关/模型"）一行，所有进程共用 —— 熔断器状态、连续失败、近期结果、共享退避到哪一刻。
  //   llm_bindings.fallback_key：这一档的主模型熔断 / 重试用尽时自动换用的模型（NULL = 没配，照旧失败）。
  (raw) => {
    raw.exec(`CREATE TABLE IF NOT EXISTS llm_health (
      key            TEXT PRIMARY KEY,
      state          TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
      fails          INTEGER NOT NULL DEFAULT 0,                       -- 连续失败次数（成功清零）
      recent         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recent) AND json_type(recent) = 'array'),   -- [[时刻, 1 成 / 0 败], …]（运行期不变量起带第三项 pid）
      cool_ms        INTEGER NOT NULL DEFAULT 0,                       -- 这次打开的冷却时长（反复打开时翻倍）
      opened_at      INTEGER,
      retry_at       INTEGER,                                          -- 共享退避：谁都别在这之前打
      probe_until    INTEGER,                                          -- 半开：试探者占到这一刻
      fallback_since INTEGER,                                          -- 这次出问题以来换用过备用档（合上时清掉）
      last_status    INTEGER,
      last_error     TEXT,
      updated_at     INTEGER NOT NULL
    ) STRICT`);
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('llm_bindings') WHERE name='fallback_key'`).get()) raw.exec(`ALTER TABLE llm_bindings ADD COLUMN fallback_key TEXT`);
  },
  // v43 → v44（2026-10-14）：运行期不变量（core/invariants.mjs）每条一行 —— 最近一次查的时刻与结果。
  //   守护进程按它判"到没到点"（重启、两个守护进程都不重查），健康卡读它。违反的转换另记审计。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS invariant_state (
      id          TEXT PRIMARY KEY,
      checked_at  INTEGER NOT NULL,
      checked     INTEGER NOT NULL DEFAULT 0,                              -- 这次看了几个对象（0 = 没得可查，不是"都对"）
      violations  INTEGER NOT NULL DEFAULT 0,
      sample      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sample) AND json_type(sample) = 'array'),   -- 至多 20 个违反的例子（事实，不是句子）
      since       INTEGER,                                                 -- 这一段违反从哪一刻起（对了清掉）
      error       TEXT,                                                    -- 查的时候炸了
      skipped     TEXT,                                                    -- 这次不适用的原因（急停中……）
      elapsed_ms  INTEGER,
      baseline    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(baseline) AND json_type(baseline) = 'array'),   -- 第一次查时就在的违反（启用检查之前的历史），之后不再报
      baselined   INTEGER NOT NULL DEFAULT 0                               -- 这次有几条因为在基线里没报
    ) STRICT`),
  // v44 → v45（2026-10-14 最小权限注入）：联网目录里某个源的凭据，由出口代理替沙箱里的工具带上。
  //   沙箱里看不到值（原来只能塞进 tool_env：进沙箱环境、还原样印进执行器提示词）。值用主密钥加密（附加数据绑定行 id）。
  //   allow_write = 0：只在 GET / HEAD / OPTIONS 上带 —— 沙箱里的代码用得了它、读不到它，用它也改不了东西；要写由管理员显式打开。
  //   与 credentials（交付用的连接，按远端解析）分开放：混在一起，推送时按主机挑连接就可能挑到它。
  (raw) => raw.exec(`CREATE TABLE IF NOT EXISTS egress_credentials (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL REFERENCES egress_sources(id),
      header      TEXT NOT NULL CHECK (length(header) BETWEEN 1 AND 64),
      secret      TEXT NOT NULL CHECK (json_valid(secret) AND json_type(secret) = 'object'),
      hint        TEXT NOT NULL,
      allow_write INTEGER NOT NULL DEFAULT 0 CHECK (allow_write IN (0,1)),
      created_by  TEXT NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      revoked_at  INTEGER,
      revoked_by  TEXT REFERENCES users(id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_egress_cred_live ON egress_credentials(source_id) WHERE revoked_at IS NULL;`),
  // v45 → v46（2026-10-14 耗时埋点）：原来单次模型调用、单次工具调用的耗时都不记，
  //   耗时复盘只能拿账本时刻倒推、再拟合模型延迟。账本每行加开始时刻、耗时（含重试与退避等待）、尝试次数；
  //   工具调用另起一张表，每次一行（哪一步、第几轮、什么工具、命令类别、开始、耗时、退出码）。
  (raw) => {
    for (const [col, type] of [['started_at', 'INTEGER'], ['duration_ms', 'INTEGER'], ['attempts', 'INTEGER']]) {
      if (!raw.prepare(`SELECT 1 FROM pragma_table_info('usage_ledger') WHERE name=?`).get(col)) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN ${col} ${type}`);
    }
    raw.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      node_id     TEXT REFERENCES nodes(id),
      role        TEXT NOT NULL,
      round       INTEGER NOT NULL,
      tool        TEXT NOT NULL,
      category    TEXT,                                   -- run_command 的命令类别：test / install / build / git / other
      started_at  INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      exit_code   INTEGER,                                -- run_command 才有
      ok          INTEGER NOT NULL CHECK (ok IN (0,1)),   -- 处理器抛错（回给模型的那种）= 0
      proc_pid    INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_tool_calls_node ON tool_calls(node_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id, started_at);`);
  },
  // v46 → v47（2026-10-14）：AI 自选（settled_by_me）谁会在乎 —— user = 用这个软件的人看得到、碰得到；
  //   developer = 只有写代码、调接口的人在乎。过目事项按它分给规格那一行 / 结构那一行的人。原来按主题正则分，
  //   HTTP 状态码、模块入口这类被当成"接口行为"发给了管产品的人，她只能回"都行"。老数据为 NULL，按正则兜底。
  (raw) => {
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('assumptions') WHERE name='audience'`).get()) raw.exec(`ALTER TABLE assumptions ADD COLUMN audience TEXT CHECK (audience IN ('user','developer'))`);
  },
  // v47 → v48（2026-10-19，中途打断）：人中止任务 / 管理员急停可以当场取消进行中的模型调用。被取消的那一次厂商多半照样计费，
  //   而我们拿不到用量 —— 按"输入照估、输出打满"记一笔估算（闸门宁可多算），这一列标出哪几行是估的，复盘与花费页认得出来。
  (raw) => {
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('usage_ledger') WHERE name='estimated'`).get()) raw.exec(`ALTER TABLE usage_ledger ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0,1))`);
  },
  // v48 → v49（2026-11-08 信号分级）：不成为事项的信号（超时替人定了、别人动了你的事、部署出故障……）统一进发件箱。
  //   signals 一条一件事（登记过的信号名 + 所属类）；signal_recipients 每个收件人一行，记下发出时按项目监督模式 + 个人偏好
  //   解析出的介入方式：notify = 推送，record = 只留记录（看板可查）。推送由守护进程 / tick 认领后发，认领即 pushed_at（至多一次）。
  //   users.signal_prefs：个人对各类信号的"通知 / 备案"偏好（只能在底线之上调自己的）。
  (raw) => {
    raw.exec(`CREATE TABLE IF NOT EXISTS signals (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      class       TEXT NOT NULL,
      project_id  TEXT REFERENCES projects(id),
      task_id     TEXT REFERENCES tasks(id),
      ref         TEXT,
      title       TEXT NOT NULL,
      text        TEXT NOT NULL,
      fallback    INTEGER NOT NULL DEFAULT 0 CHECK (fallback IN (0,1)),   -- 没有人收得到推送时退到部署级通道（.env）
      created_at  INTEGER NOT NULL,
      pushed_at   INTEGER                                                  -- 认领推送的时刻；NULL = 还没推（或不用推）
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_signals_unpushed ON signals(created_at) WHERE pushed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_signals_task ON signals(task_id, created_at);
    CREATE TABLE IF NOT EXISTS signal_recipients (
      signal_id   TEXT NOT NULL REFERENCES signals(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      tier        TEXT NOT NULL CHECK (tier IN ('notify','record')),
      read_at     INTEGER,
      PRIMARY KEY (signal_id, user_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_signal_recipients_user ON signal_recipients(user_id, signal_id);`);
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='signal_prefs'`).get()) raw.exec(`ALTER TABLE users ADD COLUMN signal_prefs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(signal_prefs) AND json_type(signal_prefs) = 'object')`);
  },
  // v49 → v50（2026-11-08）：决策类型加「安全审批」（security）—— 审批门禁、策略钩子要确认、MCP 工具要批准。
  //   原来这些按"规格取舍"派人、8 小时后默认不同意。questions 与 routing_rules 的枚举 CHECK 各多一个值（重建表：SQLite 改不了已有约束）。
  //   已存的路由表里没有 security 的行：读的时候按"系统卡住"那几行补（routing.rulesOf）。
  (raw) => {
    const add = (body) => body.replace(/'conflict',\s*'ops'\)/, "'conflict','ops','security')");
    const plan = ['questions', 'routing_rules'].filter((t) => !/'security'/.test(raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t)?.sql ?? ''))
      .map((table) => ({ table, rewrite: add }));
    if (plan.length) rebuildTables(raw, plan, { suffix: '_v50' });
  },
  // v50 → v51（2026-11-08 推送节奏）：推送不再在产生点各推各的，统一进按人的推送队列。
  //   push_queue 一行 = 要推给某个人的一件事（一条通知档信号，或一条等他答 / 抄送他的事项）。紧急的马上推（受推送限额），
  //   不紧急的攒到工作时间里按汇总间隔合成一条推。认领即 sent_at（至多一次）；sent_as 记怎么推出去的（单条 / 汇总 / 没有通道）。
  //   users.push_prefs：个人的工作时间、汇总间隔、推送限额（空 = 跟部署默认）。
  (raw) => {
    raw.exec(`CREATE TABLE IF NOT EXISTS push_queue (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      kind        TEXT NOT NULL,                                            -- 信号名，或 question.addressed / question.informed
      source      TEXT NOT NULL CHECK (source IN ('signal','question')),
      source_id   TEXT NOT NULL,
      urgent      INTEGER NOT NULL CHECK (urgent IN (0,1)),
      exempt      INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),       -- 不受推送限额（Ⅲ 级、部署健康）
      capped      INTEGER NOT NULL DEFAULT 0 CHECK (capped IN (0,1)),       -- 紧急但撞了限额，排进下一次汇总的最前面
      group_key   TEXT NOT NULL,
      project_id  TEXT REFERENCES projects(id),
      task_id     TEXT REFERENCES tasks(id),
      title       TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER,
      sent_as     TEXT CHECK (sent_as IN ('single','digest','none','moot')),   -- none = 这个人没有通道；moot = 推之前事项已经结了
      batch_id    TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_push_queue_pending ON push_queue(user_id, created_at) WHERE sent_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_push_queue_sent ON push_queue(user_id, sent_at);`);
    if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='push_prefs'`).get()) raw.exec(`ALTER TABLE users ADD COLUMN push_prefs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(push_prefs) AND json_type(push_prefs) = 'object')`);
  },
  // v51 → v52（2026-11-08 邮件答复）：直接回推送邮件就算答复。
  //   答复令牌就是 tokens 里的一种（kind='mail'）：答复写成消息时要挂签发令牌（messages 的硬约束，指令溯源锚点），
  //   复用这张表就不用另开一条认证路。authenticate 默认不认它（只有邮件答复那条路认），所以随邮件转发出去也调不了接口。
  //   mail_reply_tokens：令牌属于哪个人 × 哪件事、用掉没有；mail_inbound：收到的每封信处理过一次（按 Message-ID 去重）和结果。
  //   都不存邮箱地址：发件地址只存哈希（限回信频率用）和域名。
  (raw) => {
    if (!/'mail'/.test(raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tokens'`).get()?.sql ?? '')) {
      rebuildTables(raw, [{ table: 'tokens', rewrite: (b) => b.replace("CHECK (kind IN ('cli','session','service'))", "CHECK (kind IN ('cli','session','service','mail'))") }], { suffix: '_v52' });
    }
    raw.exec(`CREATE TABLE IF NOT EXISTS mail_reply_tokens (
      token_id    TEXT PRIMARY KEY REFERENCES tokens(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      question_id TEXT NOT NULL REFERENCES questions(id),
      created_at  INTEGER NOT NULL,
      used_at     INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_mail_reply_tokens_q ON mail_reply_tokens(question_id, user_id);
    CREATE TABLE IF NOT EXISTS mail_inbound (
      id          TEXT PRIMARY KEY,
      msg_key     TEXT NOT NULL UNIQUE,                 -- Message-ID（没有就整封信的哈希）：同一封只处理一次
      from_hash   TEXT,                                 -- 发件地址的哈希：限"给同一个地址回说明信"的频率
      from_domain TEXT,
      token_id    TEXT REFERENCES tokens(id),
      question_id TEXT REFERENCES questions(id),
      user_id     TEXT REFERENCES users(id),
      outcome     TEXT NOT NULL,
      replied     INTEGER NOT NULL DEFAULT 0 CHECK (replied IN (0,1)),
      received_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_mail_inbound_from ON mail_inbound(from_hash, received_at);`);
  },
  // v52 → v53（2026-11-08 状态报告）：定期给每人一份"这段时间发生了什么"。
  //   status_reports：每人每个时刻点（slot_at）一份，记这份覆盖的时段与详略、范围（正文不存，看板随时现算）；UNIQUE 保证一个时刻点只发一次。
  //   push_queue.source 多一个 'report'：报告走推送队列（受工作时间与推送限额管），但单条推、不并进汇总。
  (raw) => {
    raw.exec(`CREATE TABLE IF NOT EXISTS status_reports (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      slot_at     INTEGER NOT NULL,
      since       INTEGER NOT NULL,
      until       INTEGER NOT NULL,
      detail      TEXT NOT NULL CHECK (detail IN ('exceptions','summary','full')),
      scope       TEXT NOT NULL CHECK (scope IN ('mine','all')),
      quiet       INTEGER NOT NULL CHECK (quiet IN (0,1)),
      created_at  INTEGER NOT NULL,
      UNIQUE (user_id, slot_at)
    ) STRICT;`);
    if (!/'report'/.test(raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='push_queue'`).get()?.sql ?? '')) {
      rebuildTables(raw, [{ table: 'push_queue', rewrite: (b) => b.replace("CHECK (source IN ('signal','question'))", "CHECK (source IN ('signal','question','report'))") }], { suffix: '_v53' });
    }
  },
  // v53 → v54（2026-11-08 「你不在时」）：离开一段时间后第一次回到看板，顶上一条这段时间的状态报告。
  //   seen_at：最后一次在看板上（页面可见、有过操作时由看板报上来；SSE 触发的自动刷新不算，否则看板开着过夜就永远"没离开"）；
  //   away_from / away_to：认出来的那段离开（关掉提示前一直在；再离开一次就接着往前算）。
  (raw) => {
    for (const [c, def] of [['seen_at', 'seen_at INTEGER'], ['away_from', 'away_from INTEGER'], ['away_to', 'away_to INTEGER']]) {
      if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name=?`).get(c)) raw.exec(`ALTER TABLE users ADD COLUMN ${def}`);
    }
  },
  // v54 → v55（2026-11-08 发版前补）：禁默认的几类（结构矛盾、方案批准、签收、上限、联网、意见不一致、安全审批、系统卡住）
  //   从 routeQuestion 起一律没有默认，但那是路由时才套；升级前就开着、存着默认动作的事项到期仍会替人定。
  //   这里对还开着的这几类做一次与 dropDefault 相同的清理（类型清单照当时的 DECISION_TYPES.noDefault 写死：迁移不跟着代码变）。
  (raw) => {
    raw.exec(`UPDATE questions SET default_action=NULL, level=CASE WHEN level=1 THEN 2 ELSE level END
      WHERE status IN ('open','escalated') AND (default_action IS NOT NULL OR level=1)
        AND decision_type IN ('structural','contract_approval','signoff','budget','egress','conflict','security','ops')`);
  },
];

/**
 * 打开（必要时建立）状态库。
 * @param {string} path  文件路径；':memory:' 用于测试
 * @param {{migrateTo?: number}} [opts]  只给测试用：迁到第几版为止（造"第 k 版代码建的库"做升级等价测试）
 */
export function openDb(path, { migrateTo = MIGRATIONS.length } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  // 看板、守护进程、每个任务的编排器是不同进程，写同一个库文件。没有忙等待时，撞上别人的写锁当场抛
  // `database is locked` —— 0.3.0 四跑与 v9 的日志里有 9 个编排器进程就这样崩掉。
  // 连接级设置，每次打开都要设；要在建库 / 迁移之前，迁移本身也会撞锁。
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const exists = raw.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='tasks'`).get().n > 0;
  if (!exists) raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  // 逐级补齐。schema.sql 只到 v1，所以**新库也会把全部迁移走一遍**（这是设计：每条迁移每次建库都被执行，
  // 不留只有实际运行才踩得到的死角）；两条路径（建库 / 迁移）落到同一形状，靠 tests 里的形状比对钉住。
  let v = raw.prepare('PRAGMA user_version').get().user_version;
  if (v > MIGRATIONS.length) {
    // ⚠️ 先关句柄再抛。带着打开的句柄抛异常，在 Windows 上会把库文件锁到进程退出，
    // 调用方连"换个库重试"或"删掉重建"都做不了。
    raw.close();
    throw new Error(`状态库版本 ${v} 比本代码认识的 ${MIGRATIONS.length} 还新 —— `
      + `这是一个更新的 SuperIntern 建的库，用旧代码打开会静默写坏数据，拒绝打开。`);
  }
  // 已有的库要升级：先整库备份一份。全部状态（花费、审计轨、交接记录）只此一个文件，迁移写坏了没有第二份
  // （GitLab 2017 式教训：没验证过的备份等于没有 —— 备份文件能被 openDb 直接打开，测试里验了）。
  if (exists && v < migrateTo && path !== ':memory:') {
    try { backupDb(raw, path, `pre-v${v}`); } catch (e) { raw.close(); throw new Error(`迁移前备份失败，没有动库：${e.message}`); }
  }
  while (v < migrateTo) {
    // 每一级迁移与它的版本号在**同一个事务**里：原来版本号在事务外单独写，中途崩溃就会把一条
    // 已经做完的迁移再跑一遍（非幂等的会炸，注释里记过一次真实事故）。
    // 外键在事务外关掉（事务内 PRAGMA foreign_keys 不生效）：重建表的迁移要 DROP 被引用的旧表。
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      raw.exec('BEGIN IMMEDIATE');
      // 外键在迁移期间是关着的（重建表要 DROP 被引用的旧表），所以迁移写坏引用不会当场报错 —— 提交前核一遍。
      // 只拦"这一步新增的"违例：老库里原本就有的几条不该让升级卡死（那要人去看，不是迁移能修的）。
      const fkBefore = raw.prepare('PRAGMA foreign_key_check').all().length;
      MIGRATIONS[v](raw);
      const fkAfter = raw.prepare('PRAGMA foreign_key_check').all();
      if (fkAfter.length > fkBefore) {
        const sample = fkAfter.slice(0, 3).map((r) => `${r.table}#${r.rowid}→${r.parent}`).join('、');
        throw new Error(`迁移 v${v}→v${v + 1} 写出了 ${fkAfter.length - fkBefore} 条外键违例（如 ${sample}），已回滚，库没动`);
      }
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec('COMMIT');
      v++;
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch { /* 迁移自己已回滚 */ }
      raw.close();
      throw e;
    } finally {
      try { raw.exec('PRAGMA foreign_keys = ON'); } catch { /* 句柄已关 */ }
    }
  }

  // WAL 与外键在 schema.sql 里已 PRAGMA，但 PRAGMA foreign_keys 是**连接级**的，
  // 建库之后的每次打开都得重设——不重设则所有 FK 静默失效。
  raw.exec('PRAGMA foreign_keys = ON');
  // 开发用：状态迁移普查（见 transition-recorder.mjs）。只在设了环境变量时挂 TEMP 触发器，不落库
  if (process.env.SUPERINTERN_RECORD_TRANSITIONS) recordTransitions(raw, process.env.SUPERINTERN_RECORD_TRANSITIONS);
  return wrap(raw, path);
}

// 进程级：所有打开着的库句柄的观测，退出时统一落一次（测试会开上百个句柄，不能每个都挂一个 exit 监听）
const LIVE_METRICS = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const m of LIVE_METRICS) {
      m.flush();
      if (process.env.SUPERINTERN_RECORD_SQL) m.dumpCensus(process.env.SUPERINTERN_RECORD_SQL);
    }
  });
}

function wrap(raw, path = null) {
  let depth = 0;   // tx 的嵌套层数（见 tx）
  // 观测：每条语句计时计数、慢语句、等锁、BUSY；每分钟落一份到 <库目录>/metrics/
  const metrics = createMetrics({ path, procKind });
  LIVE_METRICS.add(metrics); hookExit();
  const flushTimer = path && path !== ':memory:' ? setInterval(() => metrics.flush(), 60_000) : null;
  flushTimer?.unref?.();
  // 预编译语句缓存：原来每次调用都重新 prepare。同一个句柄、同一段 SQL 复用（库结构变了 SQLite 会自己重新编译）
  const stmtCache = new Map();
  const stmt = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) { s = raw.prepare(sql); if (stmtCache.size >= 500) stmtCache.delete(stmtCache.keys().next().value); stmtCache.set(sql, s); }
    return s;
  };
  const db = {
    raw,
    path,
    // 写语句的字符串参数统一脱敏：凡落进库的文字 —— 审计、消息、答复、节点产出、报告、上下文装配记录…… ——
    // 都过这一道，不指望每个调用点记得。只读语句不动；连接表（密文）除外。
    run: (sql, ...a) => metrics.time(sql, () => stmt(sql).run(...redactParams(sql, a))),
    all: (sql, ...a) => metrics.time(sql, () => stmt(sql).all(...a)),
    one: (sql, ...a) => metrics.time(sql, () => stmt(sql).get(...a)),
    metrics: () => metrics.snapshot(),
    timing: (name, ms) => metrics.timing(name, ms),
    close: () => { if (flushTimer) clearInterval(flushTimer); metrics.flush(); LIVE_METRICS.delete(metrics); stmtCache.clear(); raw.close(); },

    /**
     * 事务。**不是便利函数，是护栏**：
     * 一条决策/节点与它的出处边是两条 INSERT，边总在后 —— 若不同事务，
     * 污染数据会先进入状态库、被下游装配读走，事后巡检已经晚了。
     * 凡"记录 + 出处"成对的写入一律走这里。
     */
    tx(fn, { immediate = true } = {}) {
      // 已在事务里（例：答复的钩子要替人「添加任务」，而答复本身在一个事务里）→ 并入外层：
      // 内层出错照样抛出去，由外层整体回滚 —— "要么都成、要么都不成"的口径不变。
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      // 默认 IMMEDIATE（2026-10-11 起）：先拿写锁再读。延迟事务（BEGIN）在 WAL 下"先读后写"时要把读锁升级成写锁，
      // 另一个进程已经写过就直接报 SQLITE_BUSY —— busy_timeout 管不了这种（等也没用，快照已经旧了）。
      // 我们的事务几乎都是"读现值 → 校验 → 写 + 审计"，一开始就拿写锁才对；只读的事务没必要走 tx。
      maybeFault('db.tx');   // 故障注入点：拿写锁之前
      const tw = performance.now();
      raw.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
      metrics.lockWait(performance.now() - tw);   // 拿写锁等了多久
      depth++;
      try {
        const r = fn();
        depth--;
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        depth = 0;
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db;
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用写入助手
// ═══════════════════════════════════════════════════════════════════════════

export const insertEdge = (db, from, to, relation, t = now()) =>
  db.run(`INSERT INTO edges (from_id,to_id,relation,valid_from,recorded_at) VALUES (?,?,?,?,?)`,
    from, to, relation, t, t);

/** 让某个端点上某种关系的现行边作废（不删：留着答"当初连着谁、什么时候改的"）。给 from 或 to 之一。 */
export function supersedeEdges(db, { from = null, to = null, relation, t = now() }) {
  if ((from == null) === (to == null)) throw new Error('supersedeEdges：from 与 to 恰好给一个');
  db.run(`UPDATE edges SET superseded_at=?, valid_to=? WHERE ${from != null ? 'from_id' : 'to_id'}=? AND relation=? AND superseded_at IS NULL`, t, t, from ?? to, relation);
}

/**
 * 审计轨。它是**复盘的依据**（要能仅凭审计轨 + 状态库
 * 复盘全过程，不看进程日志），所以宁可写多不写少。
 */
export const audit = (db, { actorKind, actorId = null, action, targetType = null, targetId = null, payload = {}, onBehalfOf = currentOnBehalfOf() }) =>
  onBehalfOf == null
    ? db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload,payload_v)
              VALUES (?,?,?,?,?,?,?,?)`,
      now(), actorKind, actorId, action, targetType, targetId, JSON.stringify(payload ?? {}), AUDIT_PAYLOAD_V)
    // 服务账户替人做的：actor 是服务账户本身，on_behalf_of 是它替的那个人
    : db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload,payload_v,on_behalf_of)
              VALUES (?,?,?,?,?,?,?,?,?)`,
      now(), actorKind, actorId, action, targetType, targetId, JSON.stringify(payload ?? {}), AUDIT_PAYLOAD_V, onBehalfOf);

// ═══════════════════════════════════════════════════════════════════════════
// 单用户引导
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 即使是单用户部署，`tasks.owner_id` 与"指令效力只授予认证通道"
 * 这条硬规则都要求真实的 users/tokens 行 —— 护栏在库层，绕不过去也不该绕。
 * 故这里建一个本机负责人（role=lead，权限由路由表推导）与一枚 CLI 令牌。
 *
 * ⚠️ 令牌明文只在此刻存在一次，库里只有哈希。调用方负责把它交给 CLI
 * （走 `.superintern/cli-token`）。
 */
export function ensureOwner(db, displayName = 'local-owner') {
  const existing = db.one(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL ORDER BY created_at LIMIT 1`)
    ?? db.one(`SELECT id FROM users WHERE role='lead' ORDER BY created_at LIMIT 1`);   // 全停用了也不再建一个新的
  if (existing) {
    const tk = db.one(`SELECT id FROM tokens WHERE user_id=? AND revoked_at IS NULL AND kind<>'mail'`, existing.id);
    return { userId: existing.id, tokenId: tk?.id ?? null, plaintext: null };
  }
  const userId = newId('u');
  const tokenId = newId('tk');
  const plaintext = randomBytes(24).toString('base64url');
  const t = now();
  db.tx(() => {
    db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'lead','[]',?)`, userId, displayName, t);
    db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`,
      tokenId, userId, sha256(plaintext), userId, t);
    audit(db, { actorKind: 'system', action: 'bootstrap_owner', targetType: 'user', targetId: userId });
  });
  return { userId, tokenId, plaintext };
}

/** 最后使用时刻多久记一次（每个请求都写就是每个请求都抢写锁）。 */
export const TOKEN_TOUCH_MS = 60_000;

/**
 * 令牌明文 → 认证结果 { token_id, user_id, kind, scope, user_kind }。指令效力的唯一入口。
 * 有效 = 没吊销、成员没停用、没过绝对期限、没闲置超时；会话（parent_id 非空）还要它的来源令牌也没吊销、没过期 ——
 * 吊销一枚令牌，用它登录换来的浏览器会话跟着失效。
 * 顺带记"最后在何时何处用过"（看板上"我的会话与令牌"看得到），同一枚令牌一分钟内只写一次。
 * 邮件答复令牌（kind='mail'）只在 mail=true 时认、而且那时只认它：它随邮件发出去，可能被转发，
 * 不能拿来调看板或 CLI 的接口；邮件答复那条路也不认别的令牌。
 */
export function authenticate(db, plaintext, { at = now(), ip = null, touch = true, mail = false } = {}) {
  if (!plaintext) return null;
  const r = db.one(
    `SELECT k.id AS token_id, k.user_id, k.kind, k.scope, k.last_used_at, k.last_ip, u.kind AS user_kind
     FROM tokens k JOIN users u ON u.id=k.user_id
     WHERE k.token_hash=? AND k.revoked_at IS NULL AND u.disabled_at IS NULL AND (k.kind = 'mail') = ?
       AND (k.expires_at IS NULL OR k.expires_at > ?)
       AND (k.idle_ms IS NULL OR coalesce(k.last_used_at, k.issued_at) + k.idle_ms > ?)
       AND (k.parent_id IS NULL OR EXISTS (SELECT 1 FROM tokens p WHERE p.id=k.parent_id AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)))`,
    sha256(plaintext), mail ? 1 : 0, at, at, at);
  if (!r) return null;
  if (touch && (r.last_used_at == null || at - r.last_used_at >= TOKEN_TOUCH_MS || (ip && ip !== r.last_ip))) {
    try { db.run(`UPDATE tokens SET last_used_at=?, last_ip=coalesce(?, last_ip) WHERE id=?`, at, ip, r.token_id); } catch { /* 记不上不影响认证 */ }
  }
  const { last_used_at, last_ip, ...out } = r;
  return out;
}
