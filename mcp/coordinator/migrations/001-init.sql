-- OMZ coordinator 迁移 001：初始 schema。
-- 关系：../schema.sql 是当前完整快照（人读/diff 用），本目录是可重放迁移序列（db.mjs 实际执行）。
-- 纪律：已发布的迁移文件永不修改，结构变更只追加 002-*.sql 等新文件；
--       每个文件必须幂等（IF NOT EXISTS），以便对已存在库重复重放不报错。

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
