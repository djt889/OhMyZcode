-- OMZ coordinator 当前完整 schema 快照（唯一事实源的结构定义）。
-- 关系：本文件 = 最新状态的可读快照，仅供人阅读与 diff；
--       migrations/*.sql = 实际按文件名顺序重放的迁移序列（db.mjs 只执行 migrations/）。
-- 当前 SCHEMA_VERSION = 3（001-init + 002-task-deps-consumed + 003-task-deps-index）。
-- 约束取舍：
--   * 所有时间戳为 unix 秒整数，与 SQLite unixepoch() 一致，避免毫秒/秒混用。
--   * tasks.status 枚举：blocked | ready | running | done | failed | dead | unknown。
--     unknown 专供 I3（coordinator 与 worker 状态分叉）时的不可判定态，不由正常流程产生。
--   * transport 维度（agents.transport_state）与 coordinator 维度（tasks.status）刻意分表，
--     二者不得互推：agent 进程状态无法证明任务状态，反之亦然。
--   * task_deps.consumed 是依赖边的"一次性消费"标记：上游 complete 时只递减 consumed=0 的边
--     并同时置 1。这层保证即使终态守卫被绕过，下游 deps_remaining 也不会被重复递减。

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  max_parallel INTEGER NOT NULL DEFAULT 4,
  metadata     TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graphs (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id       TEXT NOT NULL REFERENCES graphs(id),
  team_id        TEXT NOT NULL,
  key            TEXT NOT NULL,
  title          TEXT,
  payload        TEXT,
  wave           INTEGER,
  priority       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  deps_remaining INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  owner_agent    TEXT,
  lease_until    INTEGER,
  result_ref     TEXT,
  last_error     TEXT,
  retry_at       INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(graph_id, key)
);

CREATE TABLE IF NOT EXISTS task_deps (
  graph_id   TEXT NOT NULL,
  upstream   INTEGER NOT NULL REFERENCES tasks(id),
  downstream INTEGER NOT NULL REFERENCES tasks(id),
  consumed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(graph_id, upstream, downstream)
);

CREATE TABLE IF NOT EXISTS agents (
  agent_ref       TEXT PRIMARY KEY,
  team_id         TEXT,
  role            TEXT,
  resume_ref      TEXT,
  transport_state TEXT NOT NULL DEFAULT 'pending',
  last_seen       INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seq        INTEGER NOT NULL,
  team_id    TEXT,
  to_agent   TEXT NOT NULL,
  from_agent TEXT,
  task_id    INTEGER,
  payload    TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  acked      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  acked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT PRIMARY KEY,
  op         TEXT NOT NULL,
  task_id    INTEGER,
  result     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT,
  task_id    INTEGER,
  agent_ref  TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- claim 热路径索引：与 §7.2 的选取条件同序，避免 claim 事务里发生全表扫描拉长写锁。
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(graph_id, status, deps_remaining, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, acked, seq);
CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id, id);
-- complete 热路径：按 (graph_id, upstream, consumed) 直接取未消费的下游边。
-- 该索引同时出现在 002 与 003：002 里的那条会被文件级 @skip-if-column 守卫连坐跳过（列已存在但迁移未登记的库），
-- 所以 003 单独无守卫地再建一次。`CREATE INDEX IF NOT EXISTS` 幂等，重复出现无副作用。
CREATE INDEX IF NOT EXISTS idx_task_deps_upstream ON task_deps(graph_id, upstream, consumed);
