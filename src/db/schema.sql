-- SuperIntern v1 状态层 schema
--
-- 约定：
--  1. 时间一律 INTEGER 毫秒 epoch。SQLite 无原生时间类型，整数最省事且可直接索引比较。
--  2. 事实型记录使用四列双时间：
--       valid_from / valid_to      —— 世界时（这条事实在现实中何时成立）
--       recorded_at / superseded_at —— 记录时（系统何时知道它、何时不再采信）
--     不用 valid_from / invalidated_at / invalidated_by 三列（单时间轴）：
--     单轴无法区分"当时以为的事实"与"现在认为当时的事实"，
--     而这恰是"当时为什么这么做"的审计核心。
--  3. 失效不删除：任何"作废"都是写 superseded_at + supersedes 边，永不 DELETE（见 trg_*_no_delete）。
--  4. 关系一律进 edges 表，业务表不留关系副本（统一 edges 表）。

--  5. **schema 版本号住在 PRAGMA user_version 里**，本文件末尾设置。新库直接跑本文件；
--     已存在的库靠 db.mjs 的 MIGRATIONS 逐级补齐。两条路径必须落到同一个形状。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 身份与权限（预置邀请令牌）
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'contributor', 'viewer')),
  domain_tags   TEXT NOT NULL DEFAULT '[]',   -- JSON: ["frontend","product"] 用于提问路由
  can_answer    TEXT NOT NULL DEFAULT '[]',   -- JSON: 可回答的问题类型
  created_at    INTEGER NOT NULL
);

CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,           -- 只存哈希，明文仅签发时返回一次
  issued_by   TEXT NOT NULL REFERENCES users(id),
  issued_at   INTEGER NOT NULL,
  revoked_at  INTEGER
);

-- 通知通道绑定（每用户在权限画像中绑定自己的通道）
CREATE TABLE user_channels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  channel     TEXT NOT NULL CHECK (channel IN ('ws', 'ntfy', 'lark', 'dingtalk', 'wecom', 'email')),
  target      TEXT NOT NULL,                  -- topic / webhook URL / 邮箱
  priority    INTEGER NOT NULL DEFAULT 100,   -- 小者优先
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- 任务与宪法块
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('planning','running','waiting','suspended','done','aborted')),
  created_at  INTEGER NOT NULL
);

-- 宪法块：版本化，仅经宪法层决策修订
CREATE TABLE constitutions (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  version           INTEGER NOT NULL,
  goal              TEXT NOT NULL,
  scope             TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  constraints       TEXT NOT NULL DEFAULT '[]',
  valid_from        INTEGER NOT NULL,
  valid_to          INTEGER,
  recorded_at       INTEGER NOT NULL,
  superseded_at     INTEGER,
  UNIQUE (task_id, version)
);

-- ---------------------------------------------------------------------------
-- DAG
-- ---------------------------------------------------------------------------

CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  title         TEXT NOT NULL,
  spec          TEXT NOT NULL,
  acceptance    TEXT NOT NULL,                -- 验收标准，验收员据此判定
  status        TEXT NOT NULL CHECK (status IN
                  ('pending','ready','running','blocked','review','done','void','failed')),
  priority      INTEGER NOT NULL DEFAULT 100,
  risk_tier     TEXT NOT NULL DEFAULT 'normal' CHECK (risk_tier IN ('low','normal','high')),
  model_tier    TEXT NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('light','standard','heavy')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  -- 重试 >= 2 自动升档；此列记录升档发生时刻，供审计
  tier_escalated_at INTEGER
);

CREATE INDEX idx_nodes_task_status ON nodes(task_id, status);

-- 统一 edges 表。所有关系走这里，业务表不留 FK 副本。
CREATE TABLE edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  relation      TEXT NOT NULL CHECK (relation IN (
                  'depends_on',    -- node  -> node    DAG 依赖
                  'derived_from',  -- any   -> any     出处边（强制）
                  'supersedes',    -- new   -> old     覆盖
                  'reply_to',      -- msg   -> msg
                  'answers',       -- msg   -> question
                  'about_node',    -- any   -> node
                  'asserted_by',   -- fact  -> node    该事实由哪个节点断言
                  'concluded_by'   -- decision -> meeting
                )),
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE INDEX idx_edges_from ON edges(from_id, relation);
CREATE INDEX idx_edges_to   ON edges(to_id, relation);

-- ---------------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  sender_id     TEXT REFERENCES users(id),    -- NULL 表示非人类来源（则 trust_label 不可能是 authenticated）
  body          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('instruction','correction','context','answer')),
  kind_source   TEXT NOT NULL CHECK (kind_source IN ('explicit','classifier')),
  urgency       TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','urgent')),
  -- 紧急度来源必须可审计——显式标记确定性生效，分类器判定需在汇报中标注
  urgency_source TEXT NOT NULL CHECK (urgency_source IN ('explicit','classifier')),
  trust_label   TEXT NOT NULL CHECK (trust_label IN
                  ('user-authenticated','agent-generated','observed-untrusted')),
  token_id      TEXT REFERENCES tokens(id),   -- 认证凭据，指令溯源的锚点
  received_at   INTEGER NOT NULL,
  consumed_at   INTEGER,
  -- 硬约束：user-authenticated 必须有签发令牌与发送人。指令效力只授予这一类
  CHECK (trust_label <> 'user-authenticated' OR (token_id IS NOT NULL AND sender_id IS NOT NULL))
);

CREATE INDEX idx_messages_unconsumed ON messages(task_id, consumed_at, urgency);

-- ---------------------------------------------------------------------------
-- 提问（三级分类）
-- ---------------------------------------------------------------------------

CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  node_id         TEXT REFERENCES nodes(id),  -- 挂起的分支；NULL = 任务级
  level           INTEGER NOT NULL CHECK (level IN (1,2,3)),
  level_source    TEXT NOT NULL CHECK (level_source IN ('hard_rule','classifier')),
  text            TEXT NOT NULL,
  default_action  TEXT,                       -- Ⅰ/Ⅱ 级的超时默认动作
  addressed_to    TEXT NOT NULL DEFAULT '[]', -- JSON: 合格应答人 user id 列表；[] = 广播
  asked_at        INTEGER NOT NULL,
  timeout_at      INTEGER,                    -- Ⅲ 级为 NULL（无限期）
  escalated_at    INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('open','escalated','answered','defaulted','withdrawn')),
  resolved_at     INTEGER,

  -- 护栏在模型外：Ⅲ 级问题在库层面就不允许存在默认动作与超时。
  -- 即便模型误判并试图给 Ⅲ 级问题挂默认，INSERT 直接失败。
  CHECK (level < 3 OR (default_action IS NULL AND timeout_at IS NULL)),
  -- Ⅰ 级必须有默认动作，否则超时行为无定义
  CHECK (level <> 1 OR default_action IS NOT NULL)
);

CREATE INDEX idx_questions_open ON questions(task_id, status, timeout_at);

-- ---------------------------------------------------------------------------
-- 决策 / 假设 / 交接（叙事层的结构化索引，正文在 Markdown+Git）
-- ---------------------------------------------------------------------------

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  node_id       TEXT REFERENCES nodes(id),
  summary       TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('agent','user','meeting')),
  actor_id      TEXT,
  layer         TEXT NOT NULL CHECK (layer IN ('execution','constitutional')),
  narrative_ref TEXT,                         -- Markdown 文件路径 + git commit
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE TABLE assumptions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  node_id       TEXT REFERENCES nodes(id),
  subject_key   TEXT NOT NULL,                -- 归一化主题键，冲突比对靠它
  statement     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','conflicted','confirmed','refuted','void')),
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER
);

-- 活跃假设的冲突检测靠这个索引：同 task 同 subject_key 有多条 active 即冲突
CREATE INDEX idx_assumptions_subject ON assumptions(task_id, subject_key, status);

CREATE TABLE handoffs (
  id                TEXT PRIMARY KEY,
  node_id           TEXT NOT NULL REFERENCES nodes(id),
  schema_version    INTEGER NOT NULL,
  artifacts         TEXT NOT NULL,            -- JSON: [{path, kind}]
  interface_contract TEXT NOT NULL,
  known_issues      TEXT NOT NULL DEFAULT '[]',
  downstream_notes  TEXT NOT NULL DEFAULT '',
  narrative_ref     TEXT NOT NULL,            -- 完整执行叙事归档（供下游"上下文考古"）
  -- 安全边界：交接记录永远是 agent-generated，不具指令效力
  trust_label       TEXT NOT NULL DEFAULT 'agent-generated'
                      CHECK (trust_label = 'agent-generated'),
  validated_at      INTEGER,                  -- schema 校验通过时刻；NULL = 节点不算完成
  created_at        INTEGER NOT NULL
);

-- 注：`briefings`（复工简报）是 v2 加的，DDL 在 db.mjs 的 MIGRATIONS 里，
-- **不在本文件**。见文件末尾"schema 版本"一节里关于唯一副本的说明。

-- ---------------------------------------------------------------------------
-- 参数治理
-- ---------------------------------------------------------------------------

CREATE TABLE params (
  id                TEXT PRIMARY KEY,
  task_id           TEXT REFERENCES tasks(id),  -- NULL = 系统级默认
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  layer             TEXT NOT NULL CHECK (layer IN ('system','task','branch')),
  governance_class  TEXT NOT NULL CHECK (governance_class IN ('execution','constitutional')),
  set_by_kind       TEXT NOT NULL CHECK (set_by_kind IN ('agent','user')),
  set_by_id         TEXT,
  valid_from        INTEGER NOT NULL,
  valid_to          INTEGER,
  recorded_at       INTEGER NOT NULL,
  superseded_at     INTEGER,
  -- 硬规则：宪法层参数 agent 永不自改。库层面拒绝，不依赖提示词。
  CHECK (governance_class <> 'constitutional' OR set_by_kind = 'user')
);

CREATE INDEX idx_params_lookup ON params(task_id, key, superseded_at);

-- ---------------------------------------------------------------------------
-- 修正五步流水线
-- ---------------------------------------------------------------------------

CREATE TABLE impact_marks (
  id            TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES messages(id),
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  mark          TEXT NOT NULL CHECK (mark IN ('unaffected','modify','void','new')),
  salvage       TEXT CHECK (salvage IN ('keep','partial','discard')),
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 会议
-- ---------------------------------------------------------------------------

CREATE TABLE meetings (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  conflict_statement TEXT NOT NULL,
  participants      TEXT NOT NULL,            -- JSON: user id 列表
  mode              TEXT NOT NULL CHECK (mode IN ('async_thread','sync')),
  status            TEXT NOT NULL CHECK (status IN ('open','concluded','arbitrated','stalled')),
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  minutes_ref       TEXT
);

-- ---------------------------------------------------------------------------
-- 预算（直接记钱，微美元整数）
-- ---------------------------------------------------------------------------
--
-- ⚠️ 本表不用"加权 token"口径
-- （input_tokens / output_tokens / k_snapshot / tier_multiplier / weighted_tokens），
-- 它与 canonical 记账口径直接冲突，两处都撑不住：
--
--  ① **两个字段装不下五项 usage**。canonical 的五字段两两互斥，缓存读/写/推理
--     各有独立单价。实测一次带缓存的 Anthropic 调用报 input_tokens=14 而真实
--     处理量 3617 —— 只记 input/output 会少算 250 倍。
--  ② **全局 k 与档位倍率无法定义**。档位可跨厂商绑定（light 走 DeepSeek、
--     heavy 走 Anthropic），"档位倍率"失去了参照物；且输出/输入价比各家不同
--     （DeepSeek 2:1，其余 5~6:1），单一 k 系数表达不了。
--
-- 预算闸门是安全机制，账本不准 = 闸门不准，故账本必须与真实计费同构。
--
CREATE TABLE usage_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  node_id            TEXT REFERENCES nodes(id),
  role               TEXT NOT NULL,           -- planner / executor / reviewer / patrol / ...
  model_tier         TEXT NOT NULL CHECK (model_tier IN ('light','standard','heavy')),
  provider           TEXT NOT NULL,           -- 接入点 id（走网关时即 'openrouter'）
  model_id           TEXT NOT NULL,           -- 型号目录键
  upstream           TEXT,                    -- 网关实际落到的上游；直连为 NULL
  -- 五个互斥的 usage 字段，与 canonical.mjs 的 EMPTY_USAGE 一一对应
  input_tokens       INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL,        -- 含推理
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,  -- 上面那笔里属于推理的部分，仅供观测
  micro_usd          INTEGER NOT NULL,        -- 整数微美元，避免浮点累加漂移
  -- 记账口径：'computed' 按目录单价算，'reported' 用网关回报的实际计费
  billing            TEXT NOT NULL CHECK (billing IN ('computed','reported')),
  -- 声明按回报计费却没拿到回报值 → 已回落到算的。账仍可用但已降级，闸门应据此告警
  billing_fallback   INTEGER NOT NULL DEFAULT 0,
  ts                 INTEGER NOT NULL
);

CREATE INDEX idx_usage_task ON usage_ledger(task_id, ts);

-- ---------------------------------------------------------------------------
-- 通知送达回执（喂给超时标定）
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  channel       TEXT NOT NULL,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('question','report','meeting')),
  subject_id    TEXT NOT NULL,
  sent_at       INTEGER NOT NULL,
  delivered_at  INTEGER,
  read_at       INTEGER,
  error         TEXT
);

-- ---------------------------------------------------------------------------
-- 审计与装配日志
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system')),
  actor_id      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  payload       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE context_assemblies (
  id                  TEXT PRIMARY KEY,
  ts                  INTEGER NOT NULL,
  role                TEXT NOT NULL,
  recipe              TEXT NOT NULL,
  constitution_version INTEGER NOT NULL,
  model_tier          TEXT NOT NULL,
  items               TEXT NOT NULL,          -- JSON: 拉取的条目 id 清单
  token_estimate      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 护栏触发器：把硬规则钉在库层，模型绕不过去
-- ---------------------------------------------------------------------------

-- 审计轨 append-only：改不得、删不得
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- 双时间表失效不删除
CREATE TRIGGER trg_decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions: supersede instead of delete'); END;

CREATE TRIGGER trg_assumptions_no_delete BEFORE DELETE ON assumptions
BEGIN SELECT RAISE(ABORT, 'assumptions: supersede instead of delete'); END;

CREATE TRIGGER trg_params_no_delete BEFORE DELETE ON params
BEGIN SELECT RAISE(ABORT, 'params: supersede instead of delete'); END;

CREATE TRIGGER trg_messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;

-- 账本 append-only：它是预算闸门的唯一真相源，可改即闸门可绕
CREATE TRIGGER trg_usage_no_update BEFORE UPDATE ON usage_ledger
BEGIN SELECT RAISE(ABORT, 'usage_ledger is append-only'); END;

CREATE TRIGGER trg_usage_no_delete BEFORE DELETE ON usage_ledger
BEGIN SELECT RAISE(ABORT, 'usage_ledger is append-only'); END;

-- 节点完成的定义：产物就绪 + 交接记录通过校验
CREATE TRIGGER trg_node_done_requires_handoff
BEFORE UPDATE OF status ON nodes
WHEN NEW.status = 'done'
  AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.node_id = NEW.id AND h.validated_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'node cannot be done without a validated handoff record');
END;

-- 同一条规则的 INSERT 侧。只挂 UPDATE OF status 的话，
-- 直接 INSERT 一个 status='done' 的节点即可绕过。规划器**正是**唯一会 INSERT
-- 节点的角色，这条路径是活的，必须同时封住。
CREATE TRIGGER trg_node_insert_done_requires_handoff
BEFORE INSERT ON nodes
WHEN NEW.status = 'done'
  AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.node_id = NEW.id AND h.validated_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'node cannot be inserted as done without a validated handoff record');
END;

-- ---------------------------------------------------------------------------
-- schema 版本。
--
-- **本文件只是 v1 基线，不是最新形状**：v1 之后的每一次改动都只写在 db.mjs 的
-- MIGRATIONS 里，新库也要跑一遍那些迁移。这样每条 DDL 全系统只有一份副本 ——
-- 把新表同时写进两个文件是行不通的，两份必然分叉，而分叉的那天两条路径建出来的
-- 库形状不同，问题会以"某些机器上莫名其妙"的形式出现。
--
-- 附带的好处：迁移路径**每次建新库都被跑一遍**，不再是只有老库升级才会走的死角
-- （否则会出现：加了张表，测试全绿，老库升级后第一句 no such table）。
--
--   v1 → 本文件：基线 schema（含 usage_ledger / 触发器）
--   v2 → MIGRATIONS[1]：briefings（复工简报）
--   v3 → MIGRATIONS[2]：assumptions 的认识论轴（verified_against / verification / must_disclose）
-- ---------------------------------------------------------------------------
PRAGMA user_version = 1;
