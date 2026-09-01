/**
 * OMZ coordinator 数据库层：连接、PRAGMA、迁移、写事务与结构化错误。
 * 硬约束（DESIGN §7.2 / §13.5 I4）：
 *   - 零第三方依赖，仅用 Node 内置 node:sqlite（会打 ExperimentalWarning，属正常）。
 *   - 写路径一律 BEGIN IMMEDIATE 取写事务；RETURNING 不是锁。
 *   - 外部 agent 工作期间绝不持有写事务，事务只包裹纯 SQL。
 *   - WAL 仍是 single-writer：busy_timeout 之外再加有界指数退避，超限抛 BUSY_TIMEOUT。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

// 退避参数：基数 25ms、最多 5 次重试，加 jitter 打散多写者同步碰撞。
const RETRY_MAX = 5;
const RETRY_BASE_MS = 25;

/** 结构化错误：code 是稳定字符串契约，调用方（MCP 工具层）按 code 分支，不解析 message。 */
export class CoordinatorError extends Error {
  constructor(code, message, detail = null) {
    super(message ?? code);
    this.name = 'CoordinatorError';
    this.code = code;
    this.detail = detail;
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** unix 秒（整数），与 SQLite unixepoch() 同刻度；全库禁止毫秒时间戳。 */
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isBusy(err) {
  const s = `${err?.code ?? ''} ${err?.errcode ?? ''} ${err?.message ?? ''}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(s);
}

function sleepSync(ms) {
  // 同步退避：node:sqlite 是同步 API，异步等待无法阻塞已开启的事务窗口，故用 Atomics.wait。
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function backoffDelay(attempt) {
  const base = RETRY_BASE_MS * 2 ** attempt;
  return Math.round(base + Math.random() * RETRY_BASE_MS);
}

function listMigrations() {
  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  } catch {
    return [];
  }
  // 按文件名排序即为重放顺序（001-、002- 前缀保证字典序 == 时间序）。
  return files.sort().map((f) => ({ name: f, file: path.join(MIGRATIONS_DIR, f) }));
}

function appliedSet(db) {
  const applied = new Set();
  try {
    const rows = db.prepare("SELECT key FROM schema_meta WHERE key LIKE 'migration:%'").all();
    for (const r of rows) applied.add(String(r.key).slice('migration:'.length));
  } catch {
    // schema_meta 尚不存在（全新库），视为无已应用迁移。
  }
  return applied;
}

/**
 * 迁移守卫指令：文件首部的 `-- @skip-if-column <table>.<column>`。
 * SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，无法在纯 SQL 里做幂等自守卫；
 * 而"迁移必须可对任意状态的旧库重放"是硬纪律。于是把该判断上移到执行器：
 * 目标列已存在 → 跳过文件体，但仍登记为已应用（否则每次 openDb 都会重试并抛错）。
 *
 * **粒度是文件级，这是它的已知代价**：命中守卫时该文件里的每条语句都不执行，包括本来幂等、
 * 本来必须跑的 CREATE INDEX / UPDATE 回填。002 就踩过这个坑——对"列已存在但迁移未登记"的库
 * （有人手工 ALTER TABLE 过），002 里的 idx_task_deps_upstream 被连坐跳过且不留告警，
 * 修复是新增 003（见 migrations/003-task-deps-index.sql），而不是给执行器加语句级解析。
 *
 * 因此纪律是：**带 @skip-if-column 的文件里只放那条 ADD COLUMN 与它的直接回填**，
 * 索引之类天然幂等的语句放进不带守卫的独立迁移文件。执行器不做 SQL 语句切分——
 * 在这里手写 SQL 分号切分器（要正确处理字符串字面量、注释、BEGIN...END 触发器体）
 * 是把一个可以靠文件划分解决的问题换成一个更难正确的解析问题。
 */
function migrationSkipped(db, sql) {
  const m = /^\s*--\s*@skip-if-column\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*$/m.exec(sql);
  if (!m) return false;
  const [, table, column] = m;
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => String(c.name) === column);
  } catch {
    // 表还不存在 → 该列自然也不存在，不跳过（本次迁移里若含建表语句会补上）。
    return false;
  }
}

function runMigrations(db) {
  const migrations = listMigrations();
  if (migrations.length === 0) return;
  const applied = appliedSet(db);
  const ts = nowSec();
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    const sql = fs.readFileSync(m.file, 'utf8').replace(/^\uFEFF/, '');
    // 每个迁移单独一个写事务：部分失败不留半套结构。
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!migrationSkipped(db, sql)) db.exec(sql);
      db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run(
        `migration:${m.name}`,
        String(ts)
      );
      db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run(
        'version',
        String(SCHEMA_VERSION)
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务可能已被 SQLite 自动回滚 */
      }
      throw new CoordinatorError('MIGRATION_FAILED', `迁移 ${m.name} 失败: ${err.message}`, {
        migration: m.name,
      });
    }
  }
}

/**
 * 打开（并按需初始化）coordinator 数据库。
 * readonly=true 时不建目录、不跑迁移——只读用于 status/导出场景，避免只读调用者升级 schema。
 */
export function openDb(dbPath, { readonly = false } = {}) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new CoordinatorError('BAD_ARGS', 'dbPath 必须是非空字符串');
  }
  if (!readonly) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  // WAL 提升读写并发；busy_timeout 是第一层等待，退避重试是第二层；外键必须显式开启。
  if (!readonly) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (!readonly) runMigrations(db);
  return db;
}

export function closeDb(db) {
  try {
    db?.close();
  } catch {
    /* 已关闭或句柄失效时静默：关闭失败不该掩盖上游真实错误 */
  }
}

/**
 * 写事务包装：BEGIN IMMEDIATE → fn(db) → COMMIT；异常 ROLLBACK 并重抛。
 * SQLITE_BUSY 时整个事务（含 fn）重放，因此 fn 必须是纯 SQL、可重入、无外部副作用。
 */
export function withImmediate(db, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusy(err) && attempt < RETRY_MAX) {
        lastErr = err;
        sleepSync(backoffDelay(attempt));
        continue;
      }
      if (isBusy(err)) {
        throw new CoordinatorError('BUSY_TIMEOUT', `获取写事务失败（重试 ${RETRY_MAX} 次）`, {
          attempts: attempt + 1,
        });
      }
      throw err;
    }
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务已结束 */
      }
      if (isBusy(err) && attempt < RETRY_MAX) {
        lastErr = err;
        sleepSync(backoffDelay(attempt));
        continue;
      }
      if (isBusy(err)) {
        throw new CoordinatorError('BUSY_TIMEOUT', `事务提交冲突（重试 ${RETRY_MAX} 次）`, {
          attempts: attempt + 1,
          cause: err.message,
        });
      }
      throw err;
    }
  }
  throw new CoordinatorError('BUSY_TIMEOUT', '写事务重试耗尽', { cause: lastErr?.message ?? null });
}
