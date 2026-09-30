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
import { guessDecisionType } from '../core/routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

export const now = () => Date.now();
export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 迁移表：`MIGRATIONS[v]` 把一个 user_version=v 的库带到 v+1。
 *
 * 为什么需要它：如果只在库文件不存在时跑 schema.sql，
 * 加一张表之后，**已存在的库永远拿不到它**。而离线测试都用新建的
 * `:memory:` 库，所以测试全绿、真库第一句就 `no such table`。
 *
 * 更要命的是它伤的正是最贵的东西：实际运行攒下的历史（花费、审计轨、交接记录）
 * 只此一份。schema 不保证不改 —— 那就必须有一条不毁掉证据的改法。
 *
 * **schema.sql 只是 v1 基线**，v1 之后的 DDL 只写在这里，新库同样要跑一遍。
 * 每条 DDL 全系统一份副本，且迁移路径每次建库都被走一遍——不再是只有老库
 * 才会踩到的死角。
 *
 * ⚠️ 起点是 0 而不是 1：最早的库压根没设过 user_version。
 */
const MIGRATIONS = [
  // 0 → 1：最早的老库本就含 v1 的全部表，只是没有版本号。空迁移，认领版本。
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
      raw.exec(`BEGIN;
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
    COMMIT;`);
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
      raw.exec(`BEGIN;
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
    COMMIT;`);
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
      raw.exec(`BEGIN;
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
    COMMIT;`);
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
      raw.exec(`BEGIN;
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
    COMMIT;`);
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
    raw.exec('BEGIN');
    try {
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
      raw.exec('COMMIT');
    } catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
  // v21 → v22（0.2.0 多语言）：每人的界面语言。NULL = 跟随部署的内容语言（设置 deploy.content_lang）。
  // 先看列在不在：测试会把新库的版本号拨回去重跑某一段迁移，已有的列再加一次会报 duplicate column。
  (raw) => { if (!raw.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='lang'`).get()) raw.exec(`ALTER TABLE users ADD COLUMN lang TEXT CHECK (lang IS NULL OR lang IN ('zh','en'))`); },
];

/**
 * 打开（必要时建立）状态库。
 * @param {string} path  文件路径；':memory:' 用于测试
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  const exists = raw.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='tasks'`).get().n > 0;
  if (!exists) raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  // 逐级补齐。新库跑完 schema.sql 已经是最新版，这个循环一次也不转——
  // 两条路径（建库 / 迁移）必须落到同一形状，靠 tests 里的形状比对钉住。
  let v = raw.prepare('PRAGMA user_version').get().user_version;
  if (v > MIGRATIONS.length) {
    // ⚠️ 先关句柄再抛。带着打开的句柄抛异常，在 Windows 上会把库文件锁到进程退出，
    // 调用方连"换个库重试"或"删掉重建"都做不了。
    raw.close();
    throw new Error(`状态库版本 ${v} 比本代码认识的 ${MIGRATIONS.length} 还新 —— `
      + `这是一个更新的 SuperIntern 建的库，用旧代码打开会静默写坏数据，拒绝打开。`);
  }
  while (v < MIGRATIONS.length) {
    try { MIGRATIONS[v](raw); } catch (e) { raw.close(); throw e; }
    raw.exec(`PRAGMA user_version = ${++v}`);
  }

  // WAL 与外键在 schema.sql 里已 PRAGMA，但 PRAGMA foreign_keys 是**连接级**的，
  // 建库之后的每次打开都得重设——不重设则所有 FK 静默失效。
  raw.exec('PRAGMA foreign_keys = ON');
  return wrap(raw);
}

function wrap(raw) {
  let depth = 0;   // tx 的嵌套层数（见 tx）
  const db = {
    raw,
    run: (sql, ...a) => raw.prepare(sql).run(...a),
    all: (sql, ...a) => raw.prepare(sql).all(...a),
    one: (sql, ...a) => raw.prepare(sql).get(...a),
    close: () => raw.close(),

    /**
     * 事务。**不是便利函数，是护栏**：
     * 一条决策/节点与它的出处边是两条 INSERT，边总在后 —— 若不同事务，
     * 污染数据会先进入状态库、被下游装配读走，事后巡检已经晚了。
     * 凡"记录 + 出处"成对的写入一律走这里。
     */
    tx(fn, { immediate = false } = {}) {
      // 已在事务里（例：答复的钩子要替人「添加任务」，而答复本身在一个事务里）→ 并入外层：
      // 内层出错照样抛出去，由外层整体回滚 —— "要么都成、要么都不成"的口径不变。
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      // immediate：先拿写锁再读。"读现值 → 校验 → 写 + 审计"要在一把锁里的地方用（注册表的护栏检查），
      // 否则另一个进程（CLI 与看板）能在读和写之间改掉被检查的东西。
      raw.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
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

/**
 * 审计轨。它是**复盘的依据**（要能仅凭审计轨 + 状态库
 * 复盘全过程，不看进程日志），所以宁可写多不写少。
 */
export const audit = (db, { actorKind, actorId = null, action, targetType = null, targetId = null, payload = {} }) =>
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload)
          VALUES (?,?,?,?,?,?,?)`,
    now(), actorKind, actorId, action, targetType, targetId, JSON.stringify(payload));

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
    const tk = db.one(`SELECT id FROM tokens WHERE user_id=? AND revoked_at IS NULL`, existing.id);
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

/** 令牌明文 → 认证结果。指令效力的唯一入口。 */
export function authenticate(db, plaintext) {
  if (!plaintext) return null;
  return db.one(
    `SELECT k.id AS token_id, k.user_id FROM tokens k JOIN users u ON u.id=k.user_id
     WHERE k.token_hash=? AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
    sha256(plaintext)) ?? null;
}
