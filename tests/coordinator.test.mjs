/**
 * tests/coordinator.test.mjs
 * 覆盖 mcp/coordinator/db.mjs + core.mjs 全部导出。
 * 纪律：每个 test 独立临时 db（含 -wal/-shm 清理）；时间一律注入 now；不触碰仓库文件。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoordinatorError, SCHEMA_VERSION, closeDb, nowSec, openDb, withImmediate } from '../mcp/coordinator/db.mjs';
import {
  teamCreate,
  teamShutdown,
  dagSubmit,
  taskClaim,
  taskHeartbeat,
  taskComplete,
  taskFail,
  reclaimExpired,
  mailSend,
  mailReceive,
  mailAck,
  status,
  exportMirror,
  verifyGraphInvariants
} from '../mcp/coordinator/core.mjs';

const T0 = 1735689600; // 2025-01-01T00:00:00Z，unix 秒

/** 每个 test 独立临时目录 + db；t.after 里关句柄、删 db 及 -wal/-shm，最后删目录。 */
function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-coord-'));
  const dbPath = path.join(dir, 'coordinator.sqlite');
  const db = openDb(dbPath);
  t.after(() => {
    closeDb(db);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dbPath, dir };
}

/** SQLite 行是 null-prototype 对象，断言前统一转成普通对象。 */
function plain(row) {
  return row === null || row === undefined ? row : { ...row };
}

/** 常用夹具：一个 team + 一个图。deps 用 {from,to}（to 依赖 from）。 */
function seedGraph(db, { tasks, deps = [], name = 'fixture' } = {}) {
  const team = teamCreate(db, { name });
  const graph = dagSubmit(db, { team_id: team.team_id, tasks, deps });
  return { team_id: team.team_id, ...graph };
}

/** 循环 claim 直到 null，返回 claim 到的 task 数组。 */
function drainClaims(db, graph_id, { agentPrefix = 'w', now = T0, limit = 50 } = {}) {
  const out = [];
  for (let i = 0; i < limit; i += 1) {
    const r = taskClaim(db, { graph_id, agent_ref: `${agentPrefix}${i}`, lease_seconds: 300, now });
    if (!r.task) return out;
    out.push(r.task);
  }
  throw new Error('drainClaims 超过上限，可能存在死循环');
}

describe('openDb / 迁移', () => {
  it('新建库时表结构齐全且可写入', (t) => {
    const { db } = freshDb(t);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const expected of ['agents', 'events', 'graphs', 'idempotency', 'messages', 'schema_meta', 'task_deps', 'tasks', 'teams']) {
      assert.ok(names.includes(expected), `缺表 ${expected}`);
    }
  });

  it('journal_mode PRAGMA 生效为 wal', (t) => {
    const { db } = freshDb(t);
    const mode = db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
  });

  it('foreign_keys PRAGMA 已开启', (t) => {
    const { db } = freshDb(t);
    const row = db.prepare('PRAGMA foreign_keys').get();
    assert.equal(Number(Object.values(row)[0]), 1);
  });

  it('同一库连开两次不报错且 schema_meta.version 保持正确（迁移只生效一次）', (t) => {
    const { db, dbPath } = freshDb(t);
    const first = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
    assert.equal(Number(first.value), SCHEMA_VERSION);
    const applied1 = db.prepare("SELECT COUNT(*) AS c FROM schema_meta WHERE key LIKE 'migration:%'").get().c;

    // 第二个句柄必须在本 test 内显式关闭：t.after 顺序是注册序，晚关会让删库 EBUSY。
    const db2 = openDb(dbPath);
    try {
      const applied2 = db2.prepare("SELECT COUNT(*) AS c FROM schema_meta WHERE key LIKE 'migration:%'").get().c;
      assert.equal(Number(applied2), Number(applied1));
      assert.equal(Number(db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value), SCHEMA_VERSION);
    } finally {
      closeDb(db2);
    }
  });

  it('dbPath 非字符串或空串时抛 BAD_ARGS', () => {
    assert.throws(() => openDb(''), (err) => err instanceof CoordinatorError && err.code === 'BAD_ARGS');
    assert.throws(() => openDb(null), (err) => err.code === 'BAD_ARGS');
  });

  it('nowSec 返回整数秒且与系统时间同刻度', () => {
    const n = nowSec();
    assert.equal(Number.isInteger(n), true);
    assert.ok(Math.abs(n - Math.floor(Date.now() / 1000)) <= 2);
  });
});

describe('CoordinatorError', () => {
  it('携带稳定的 code 字段并可序列化为 JSON 契约', () => {
    const err = new CoordinatorError('NOT_OWNER', '仅 owner 可操作', { task_id: 3 });
    assert.equal(err.code, 'NOT_OWNER');
    assert.equal(err.name, 'CoordinatorError');
    assert.ok(err instanceof Error);
    assert.deepEqual(err.toJSON(), { code: 'NOT_OWNER', message: '仅 owner 可操作', detail: { task_id: 3 } });
  });
});

describe('withImmediate', () => {
  it('回调抛异常时事务回滚，中途写入的数据不落库', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => {
      withImmediate(db, (tx) => {
        tx.prepare('INSERT INTO teams(id, name, max_parallel, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
          'team-rollback',
          'x',
          1,
          null,
          'active',
          T0,
          T0
        );
        throw new Error('中途失败');
      });
    }, /中途失败/);
    const row = db.prepare('SELECT COUNT(*) AS c FROM teams WHERE id = ?').get('team-rollback');
    assert.equal(Number(row.c), 0);
  });

  it('回调正常返回时提交并透传返回值', (t) => {
    const { db } = freshDb(t);
    const out = withImmediate(db, (tx) => {
      tx.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?)').run('probe', 'v1');
      return 'done';
    });
    assert.equal(out, 'done');
    assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='probe'").get().value, 'v1');
  });
});

describe('teamCreate / teamShutdown', () => {
  it('创建 team 返回服务端生成的 team_id 并写入 team-created 事件', (t) => {
    const { db } = freshDb(t);
    const r = teamCreate(db, { name: 'alpha', max_parallel: 3 });
    assert.match(r.team_id, /^team-[0-9a-f]{8}$/);
    assert.equal(r.name, 'alpha');
    assert.equal(r.max_parallel, 3);
    const ev = db.prepare("SELECT COUNT(*) AS c FROM events WHERE team_id = ? AND kind = 'team-created'").get(r.team_id);
    assert.equal(Number(ev.c), 1);
  });

  it('name 缺失或 max_parallel 非法时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => teamCreate(db, {}), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => teamCreate(db, { name: 'x', max_parallel: 0 }), (e) => e.code === 'BAD_ARGS');
  });

  it('非 force 关闭且仍有 running 任务时转 draining，且之后 claim 返回 null', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }] });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });

    const r = teamShutdown(db, { team_id: g.team_id, force: false });
    assert.equal(r.status, 'draining');
    assert.ok(r.open_tasks >= 1);

    const claimed = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 });
    assert.equal(claimed.task, null);
    assert.equal(claimed.reason, 'team-shutdown');
  });

  it('force 关闭把 running/ready/blocked 任务全部标 failed', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }]
    });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 }); // A running
    const r = teamShutdown(db, { team_id: g.team_id, force: true });
    assert.equal(r.status, 'shutdown');
    assert.equal(r.open_tasks, 0);
    const rows = db.prepare('SELECT status FROM tasks WHERE team_id = ?').all(g.team_id);
    assert.equal(rows.length, 3);
    assert.equal(rows.every((x) => x.status === 'failed'), true);
  });

  it('无 running 任务时非 force 关闭直接进 shutdown', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const r = teamShutdown(db, { team_id: g.team_id });
    assert.equal(r.status, 'shutdown');
  });

  it('关闭不存在的 team 抛 TEAM_NOT_FOUND', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => teamShutdown(db, { team_id: 'team-ghost' }), (e) => e.code === 'TEAM_NOT_FOUND');
  });
});

describe('dagSubmit', () => {
  it('无依赖的任务置 ready、有上游的置 blocked，且 deps_remaining 等于上游数', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
    });
    const rows = db
      .prepare('SELECT key, status, deps_remaining FROM tasks WHERE graph_id = ? ORDER BY key')
      .all(g.graph_id)
      .map(plain);
    assert.deepEqual(rows, [
      { key: 'A', status: 'ready', deps_remaining: 0 },
      { key: 'B', status: 'ready', deps_remaining: 0 },
      { key: 'C', status: 'blocked', deps_remaining: 2 }
    ]);
    assert.equal(g.ready.length, 2);
    assert.deepEqual([...g.ready].sort((a, b) => a - b), [g.task_ids.A, g.task_ids.B].sort((a, b) => a - b));
  });

  it('task_ids 映射覆盖每一个提交的 key', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] });
    assert.deepEqual(Object.keys(g.task_ids).sort(), ['A', 'B', 'C']);
    assert.equal(Object.values(g.task_ids).every((v) => Number.isInteger(v) && v > 0), true);
  });

  it('title / payload / wave / priority / max_attempts 被完整写入', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A', title: '任务甲', payload: { subagent_type: 'omz-junior' }, wave: 2, priority: 7, max_attempts: 5 }]
    });
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(g.task_ids.A);
    assert.equal(row.title, '任务甲');
    assert.deepEqual(JSON.parse(row.payload), { subagent_type: 'omz-junior' });
    assert.equal(row.wave, 2);
    assert.equal(row.priority, 7);
    assert.equal(row.max_attempts, 5);
  });

  it('重复声明的同一条依赖边被去重而不报错', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }],
      deps: [{ from: 'A', to: 'B' }, { from: 'A', to: 'B' }]
    });
    const row = db.prepare('SELECT deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.B);
    assert.equal(row.deps_remaining, 1);
  });

  it('deps 引用未知 key 时抛 UNKNOWN_TASK_KEY', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(
      () => dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }], deps: [{ from: 'A', to: 'ZZZ' }] }),
      (e) => e.code === 'UNKNOWN_TASK_KEY'
    );
  });

  it('自环依赖抛 CYCLE_DETECTED', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(
      () => dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }], deps: [{ from: 'A', to: 'A' }] }),
      (e) => e.code === 'CYCLE_DETECTED'
    );
  });

  it('A→B→C→A 三节点环抛 CYCLE_DETECTED', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(
      () =>
        dagSubmit(db, {
          team_id: team.team_id,
          tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
          deps: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }]
        }),
      (e) => e.code === 'CYCLE_DETECTED'
    );
  });

  it('重复的 task key 抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(
      () => dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }, { key: 'A' }] }),
      (e) => e.code === 'BAD_ARGS'
    );
  });

  it('非法提交不留下半个图（校验先于写库）', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(() =>
      dagSubmit(db, {
        team_id: team.team_id,
        tasks: [{ key: 'A' }, { key: 'B' }],
        deps: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]
      })
    );
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM graphs').get().c), 0);
  });

  it('tasks 为空数组或 key 非字符串时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'x' });
    assert.throws(() => dagSubmit(db, { team_id: team.team_id, tasks: [] }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 42 }] }), (e) => e.code === 'BAD_ARGS');
  });

  it('向不存在的 team 提交图时抛 TEAM_NOT_FOUND', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => dagSubmit(db, { team_id: 'team-ghost', tasks: [{ key: 'A' }] }), (e) => e.code === 'TEAM_NOT_FOUND');
  });
});

describe('taskClaim', () => {
  it('循环认领到 null 时得到的任务 id 无重复且数量等于 ready 数', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }, { key: 'D' }],
      deps: [{ from: 'A', to: 'D' }]
    });
    const claimed = drainClaims(db, g.graph_id);
    const ids = claimed.map((c) => c.id);
    assert.equal(ids.length, 3); // A/B/C ready，D blocked
    assert.equal(new Set(ids).size, ids.length, '同一任务不得被认领两次');
    assert.equal(ids.includes(g.task_ids.D), false);
  });

  it('高 priority 的 ready 任务先被派出', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'low', priority: 1 }, { key: 'high', priority: 9 }] });
    const first = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.equal(first.task.key, 'high');
    const second = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 });
    assert.equal(second.task.key, 'low');
  });

  it('retry_at 在未来的任务被跳过，到点后可被认领', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const claimed = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskFail(db, { task_id: claimed.task.id, agent_ref: 'w1', error: 'boom', retry_at: T0 + 600, now: T0 });

    const tooEarly = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 100 });
    assert.equal(tooEarly.task, null);

    const later = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 + 600 });
    assert.equal(later.task.id, claimed.task.id);
  });

  it('认领后 attempts 递增且 lease_until 为 now + lease_seconds', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const r = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 120, now: T0 });
    assert.equal(r.task.attempts, 1);
    assert.equal(r.task.lease_until, T0 + 120);
  });

  it('认领同时在 agents 表登记该 agent 且 transport_state 为 running', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const row = db.prepare('SELECT * FROM agents WHERE agent_ref = ?').get('w1');
    assert.equal(row.transport_state, 'running');
    assert.equal(row.team_id, g.team_id);
  });

  it('graph 不存在时抛 GRAPH_NOT_FOUND；参数非法时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => taskClaim(db, { graph_id: 'graph-ghost', agent_ref: 'w' }), (e) => e.code === 'GRAPH_NOT_FOUND');
    assert.throws(() => taskClaim(db, { graph_id: 'g', agent_ref: '' }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => taskClaim(db, { graph_id: 'g', agent_ref: 'w', lease_seconds: 0 }), (e) => e.code === 'BAD_ARGS');
  });

  it('payload 被反序列化为对象返回', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', payload: { subagent_type: 'omz-deep', prompt: { task: 'x' } } }] });
    const r = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.deepEqual(r.task.payload, { subagent_type: 'omz-deep', prompt: { task: 'x' } });
  });
});

describe('taskHeartbeat', () => {
  it('owner 可延长 lease 到 now + extend_seconds', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 60, now: T0 });
    const r = taskHeartbeat(db, { task_id: c.task.id, agent_ref: 'w1', extend_seconds: 300, now: T0 + 30 });
    assert.equal(r.lease_until, T0 + 330);
    assert.equal(db.prepare('SELECT lease_until FROM tasks WHERE id = ?').get(c.task.id).lease_until, T0 + 330);
  });

  it('非 owner 延长 lease 时抛 NOT_OWNER', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.throws(
      () => taskHeartbeat(db, { task_id: c.task.id, agent_ref: 'intruder', now: T0 + 1 }),
      (e) => e.code === 'NOT_OWNER'
    );
  });

  it('终态任务的心跳被拒（抛 BAD_ARGS，不复活已结束任务）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 5 });
    assert.throws(
      () => taskHeartbeat(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 10 }),
      (e) => e.code === 'BAD_ARGS'
    );
  });

  it('task_id 非整数或 extend_seconds 非法时抛 BAD_ARGS；任务不存在时抛 TASK_NOT_FOUND', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => taskHeartbeat(db, { task_id: 'x', agent_ref: 'w' }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => taskHeartbeat(db, { task_id: 1, agent_ref: 'w', extend_seconds: 0 }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => taskHeartbeat(db, { task_id: 9999, agent_ref: 'w' }), (e) => e.code === 'TASK_NOT_FOUND');
  });
});

describe('taskComplete', () => {
  it('完成上游后下游 deps_remaining 递减，减到 0 时转 ready 且列入 unblocked', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }], deps: [{ from: 'A', to: 'B' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const r = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', result_ref: 'results/A.json', now: T0 + 10 });
    assert.equal(r.status, 'done');
    assert.deepEqual(r.unblocked, [g.task_ids.B]);
    const b = db.prepare('SELECT status, deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.B);
    assert.equal(b.status, 'ready');
    assert.equal(b.deps_remaining, 0);
  });

  it('多上游任务只有在全部上游完成后才转 ready', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
    });
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const r1 = taskComplete(db, { task_id: c1.task.id, agent_ref: 'w1', now: T0 + 1 });
    assert.deepEqual(r1.unblocked, []);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(g.task_ids.C).status, 'blocked');

    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 2 });
    const r2 = taskComplete(db, { task_id: c2.task.id, agent_ref: 'w2', now: T0 + 3 });
    assert.deepEqual(r2.unblocked, [g.task_ids.C]);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(g.task_ids.C).status, 'ready');
  });

  it('同一幂等键二次调用返回 duplicate:true 且与首次结果一致', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }], deps: [{ from: 'A', to: 'B' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const first = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k1', now: T0 + 1 });
    const second = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k1', now: T0 + 2 });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.status, first.status);
    assert.deepEqual(second.unblocked, first.unblocked);
  });

  it('幂等重放不二次解锁下游（deps_remaining 不被重复递减）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
    });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k1', now: T0 + 1 });
    const afterFirst = db.prepare('SELECT deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C).deps_remaining;
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k1', now: T0 + 2 });
    const afterSecond = db.prepare('SELECT deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C).deps_remaining;
    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1, '幂等重放后下游剩余依赖数不得再减');
    assert.ok(afterSecond >= 0);
  });

  it('别人的 agent_ref 完成任务时抛 NOT_OWNER', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.throws(
      () => taskComplete(db, { task_id: c.task.id, agent_ref: 'intruder', now: T0 + 1 }),
      (e) => e.code === 'NOT_OWNER'
    );
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.task.id).status, 'running');
  });

  it('无 owner 的任务不能被完成（可能已被回收）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    assert.throws(
      () => taskComplete(db, { task_id: g.task_ids.A, agent_ref: 'w1', now: T0 }),
      (e) => e.code === 'NOT_OWNER'
    );
  });

  it('lease 过期后原 owner 仍可完成，且 events 里留下 late-complete 记录', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 60, now: T0 });
    const r = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 5000 });
    assert.equal(r.status, 'done');
    const late = db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'late-complete'")
      .get(c.task.id);
    assert.equal(Number(late.c), 1);
  });

  it('task_id 非整数时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => taskComplete(db, { task_id: '1', agent_ref: 'w' }), (e) => e.code === 'BAD_ARGS');
  });
});

describe('taskFail', () => {
  it('未达 max_attempts 时回 ready 并记录 retry_at 与 last_error', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 3 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const r = taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: '编译失败', retry_at: T0 + 60, now: T0 + 5 });
    assert.equal(r.status, 'ready');
    assert.equal(r.dead_letter, false);
    const row = plain(db.prepare('SELECT status, retry_at, last_error, owner_agent, lease_until FROM tasks WHERE id = ?').get(c.task.id));
    assert.equal(row.status, 'ready');
    assert.equal(row.retry_at, T0 + 60);
    assert.equal(row.last_error, '编译失败');
    assert.equal(row.owner_agent, null);
    assert.equal(row.lease_until, null);
  });

  it('达到 max_attempts 时进 dead-letter 且 dead_letter:true', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 1 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const r = taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: '始终失败', now: T0 + 1 });
    assert.equal(r.status, 'dead');
    assert.equal(r.dead_letter, true);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.task.id).status, 'dead');
  });

  it('dead 的任务不再被 claim 派出', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 1 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: 'x', now: T0 + 1 });
    const again = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 10000 });
    assert.equal(again.task, null);
  });

  it('dead-letter 时 retry_at 被清空（不给已死任务留重试时间）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 1 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: 'x', retry_at: T0 + 60, now: T0 + 1 });
    assert.equal(db.prepare('SELECT retry_at FROM tasks WHERE id = ?').get(c.task.id).retry_at, null);
  });

  it('幂等键生效：二次上报返回 duplicate:true 且结果一致', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 3 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const first = taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: 'e', idempotency_key: 'f1', now: T0 + 1 });
    const second = taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: 'e', idempotency_key: 'f1', now: T0 + 2 });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.status, first.status);
    assert.equal(second.attempts, first.attempts);
  });

  it('别人的 agent_ref 上报失败时抛 NOT_OWNER', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.throws(
      () => taskFail(db, { task_id: c.task.id, agent_ref: 'other', now: T0 + 1 }),
      (e) => e.code === 'NOT_OWNER'
    );
  });

  it('同一幂等键用于不同操作时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }] });
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c1.task.id, agent_ref: 'w1', idempotency_key: 'shared', now: T0 + 1 });
    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 2 });
    assert.throws(
      () => taskFail(db, { task_id: c2.task.id, agent_ref: 'w2', idempotency_key: 'shared', now: T0 + 3 }),
      (e) => e.code === 'BAD_ARGS'
    );
  });

  /**
   * owner 校验在 complete 与 fail 两侧**对齐**（本轮审计裁决）。
   * 旧用例刻意固定了「fail 允许无 owner 时上报」的不对称，理由是「迟到的失败汇报仍应被记录」。
   * 但 owner_agent 为 null 时不校验身份 = 任何 agent 都能改他人任务的 last_error 与状态，
   * 这是一条越权写入通道，代价远大于「保留一条迟到日志」的收益。at-least-once 语义不要求
   * 接受越权写入——迟到汇报的可观测性由 events 里的 lease-expired 记录承担。
   * 因此两侧统一为 NOT_OWNER。
   */
  it('lease 被回收后原 owner 迟到的失败上报被拒（与 complete 的 owner 校验对齐）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 5 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    assert.equal(db.prepare('SELECT owner_agent FROM tasks WHERE id = ?').get(c.task.id).owner_agent, null);

    assert.throws(
      () => taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: '迟到的失败汇报', now: T0 + 40 }),
      (e) => e.code === 'NOT_OWNER'
    );
    // 同一场景下 complete 也被拒——两侧行为一致，不再有不对称
    assert.throws(
      () => taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 41 }),
      (e) => e.code === 'NOT_OWNER'
    );

    // 被拒的越权写入不得留痕：状态仍是回收后的 ready，last_error 仍是回收原因
    const row = plain(db.prepare('SELECT status, last_error FROM tasks WHERE id = ?').get(c.task.id));
    assert.equal(row.status, 'ready');
    assert.equal(row.last_error.includes('迟到的失败汇报'), false, '越权 fail 不得写入 last_error');
    assert.match(row.last_error, /lease-expired/);
  });

  it('陌生 agent 对已回收任务上报失败同样是 NOT_OWNER（通则而非特例）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 5 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    assert.throws(
      () => taskFail(db, { task_id: c.task.id, agent_ref: 'stranger', error: 'x', now: T0 + 40 }),
      (e) => e.code === 'NOT_OWNER'
    );
  });
});

describe('reclaimExpired', () => {
  it('过期 running 任务回 ready、attempts 保留，且原 owner 的 transport_state 变 unknown', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 3 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 60, now: T0 });
    const r = reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 61 });
    assert.equal(r.reclaimed.length, 1);
    assert.deepEqual(plain(r.reclaimed[0]), { task_id: c.task.id, previous_owner: 'w1', attempts: 1, status: 'ready' });
    const row = plain(db.prepare('SELECT status, attempts, owner_agent, lease_until FROM tasks WHERE id = ?').get(c.task.id));
    assert.equal(row.status, 'ready');
    assert.equal(row.attempts, 1, 'attempts 必须保留，重试预算不得被回收重置');
    assert.equal(row.owner_agent, null);
    assert.equal(row.lease_until, null);
    assert.equal(db.prepare('SELECT transport_state FROM agents WHERE agent_ref = ?').get('w1').transport_state, 'unknown');
  });

  it('未过期的 running 任务不被回收', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 600, now: T0 });
    const r = reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 599 });
    assert.deepEqual(r.reclaimed, []);
    assert.equal(db.prepare('SELECT status, owner_agent FROM tasks WHERE id = ?').get(c.task.id).owner_agent, 'w1');
  });

  it('attempts 已达上限的过期任务被回收为 dead', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 1 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    const r = reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    assert.equal(r.reclaimed[0].status, 'dead');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.task.id).status, 'dead');
  });

  it('省略 graph_id 时全库回收，回收后写 lease-expired 事件', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }] });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 10, now: T0 });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', lease_seconds: 10, now: T0 });
    const r = reclaimExpired(db, { now: T0 + 11 });
    assert.equal(r.reclaimed.length, 2);
    const ev = db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'lease-expired'").get();
    assert.equal(Number(ev.c), 2);
  });

  it('无过期任务时返回空列表且不抛', (t) => {
    const { db } = freshDb(t);
    assert.deepEqual(reclaimExpired(db, { now: T0 }).reclaimed, []);
  });
});

describe('mailSend / mailReceive / mailAck', () => {
  it('发送→拉取→确认全流程可用，ack 后不再出现在收件箱', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'mail' });
    const sent = mailSend(db, {
      to_agent: 'w1',
      from_agent: 'main',
      payload: { kind: 'ping' },
      dedupe_key: 'd1',
      team_id: team.team_id,
      now: T0
    });
    assert.equal(sent.duplicate, false);
    const box = mailReceive(db, { agent_ref: 'w1' });
    assert.equal(box.messages.length, 1);
    assert.deepEqual(box.messages[0].payload, { kind: 'ping' });

    const acked = mailAck(db, { message_id: sent.message_id, agent_ref: 'w1', now: T0 + 1 });
    assert.equal(acked.acked, true);
    assert.equal(acked.duplicate, false);
    assert.deepEqual(mailReceive(db, { agent_ref: 'w1' }).messages, []);
  });

  it('重复 dedupe_key 返回同一 message_id 并标 duplicate', (t) => {
    const { db } = freshDb(t);
    const a = mailSend(db, { to_agent: 'w1', dedupe_key: 'same', payload: { v: 1 }, now: T0 });
    const b = mailSend(db, { to_agent: 'w1', dedupe_key: 'same', payload: { v: 2 }, now: T0 + 1 });
    assert.equal(b.message_id, a.message_id);
    assert.equal(b.seq, a.seq);
    assert.equal(b.duplicate, true);
    assert.equal(mailReceive(db, { agent_ref: 'w1' }).messages.length, 1);
  });

  it('seq 单调递增', (t) => {
    const { db } = freshDb(t);
    const seqs = [];
    for (let i = 0; i < 4; i += 1) {
      seqs.push(mailSend(db, { to_agent: 'w1', dedupe_key: `k${i}`, now: T0 + i }).seq);
    }
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], `seq 必须递增：${seqs}`);
  });

  it('receive 只返回未 ack 的消息并按 seq 升序排列', (t) => {
    const { db } = freshDb(t);
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(mailSend(db, { to_agent: 'w1', dedupe_key: `k${i}`, now: T0 + i }));
    mailAck(db, { message_id: ids[1].message_id, agent_ref: 'w1', now: T0 + 10 });
    const got = mailReceive(db, { agent_ref: 'w1' });
    assert.deepEqual(got.messages.map((m) => m.id), [ids[0].message_id, ids[2].message_id]);
    assert.ok(got.messages[0].seq < got.messages[1].seq);
  });

  it('limit 限制返回条数', (t) => {
    const { db } = freshDb(t);
    for (let i = 0; i < 5; i += 1) mailSend(db, { to_agent: 'w1', dedupe_key: `k${i}`, now: T0 + i });
    assert.equal(mailReceive(db, { agent_ref: 'w1', limit: 2 }).messages.length, 2);
    assert.equal(mailReceive(db, { agent_ref: 'w1', limit: 99 }).messages.length, 5);
  });

  it('收件箱按 agent 隔离：别人的消息拉不到', (t) => {
    const { db } = freshDb(t);
    mailSend(db, { to_agent: 'w1', dedupe_key: 'a', now: T0 });
    mailSend(db, { to_agent: 'w2', dedupe_key: 'b', now: T0 });
    assert.equal(mailReceive(db, { agent_ref: 'w1' }).messages.length, 1);
    assert.equal(mailReceive(db, { agent_ref: 'w2' }).messages.length, 1);
  });

  it('非收件人 ack 时抛 NOT_OWNER', (t) => {
    const { db } = freshDb(t);
    const m = mailSend(db, { to_agent: 'w1', dedupe_key: 'x', now: T0 });
    assert.throws(
      () => mailAck(db, { message_id: m.message_id, agent_ref: 'w2', now: T0 + 1 }),
      (e) => e.code === 'NOT_OWNER'
    );
  });

  it('重复 ack 返回 duplicate:true 而非报错', (t) => {
    const { db } = freshDb(t);
    const m = mailSend(db, { to_agent: 'w1', dedupe_key: 'x', now: T0 });
    mailAck(db, { message_id: m.message_id, agent_ref: 'w1', now: T0 + 1 });
    const again = mailAck(db, { message_id: m.message_id, agent_ref: 'w1', now: T0 + 2 });
    assert.equal(again.duplicate, true);
    assert.equal(again.acked, true);
  });

  it('缺 to_agent/dedupe_key 抛 BAD_ARGS；ack 不存在的消息抛 MESSAGE_NOT_FOUND', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => mailSend(db, { dedupe_key: 'x' }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => mailSend(db, { to_agent: 'w1' }), (e) => e.code === 'BAD_ARGS');
    assert.throws(() => mailAck(db, { message_id: 999, agent_ref: 'w1' }), (e) => e.code === 'MESSAGE_NOT_FOUND');
    assert.throws(() => mailAck(db, { message_id: 'x', agent_ref: 'w1' }), (e) => e.code === 'BAD_ARGS');
  });
});

describe('status', () => {
  it('counts 七个状态键齐全，未出现的状态计为 0', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }], deps: [{ from: 'A', to: 'B' }] });
    const s = status(db, { team_id: g.team_id });
    // 'unknown' 必须在基础键集里：status()/exportMirror() 遇到该状态会动态塞键，
    // 若基础集少了它，counts 的字段集合就随数据内容漂移，调用方（dashboard/渲染器/快照 diff）
    // 无法依赖一个稳定的字段集合。
    assert.deepEqual(Object.keys(s.tasks.counts).sort(), [
      'blocked',
      'dead',
      'done',
      'failed',
      'ready',
      'running',
      'unknown'
    ]);
    assert.equal(s.tasks.counts.ready, 1);
    assert.equal(s.tasks.counts.blocked, 1);
    assert.equal(s.tasks.counts.dead, 0);
    assert.equal(s.tasks.counts.unknown, 0);
  });

  it('每个 task 行同时给出 transport_state 与 coordinator_state 两个独立字段', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const s = status(db, { team_id: g.team_id });
    const row = s.tasks.list[0];
    assert.ok('transport_state' in row);
    assert.ok('coordinator_state' in row);
    assert.equal(row.transport_state, 'running');
    assert.equal(row.coordinator_state, 'running');
  });

  it('两个维度可以不同：transport_state=unknown 而 coordinator_state=ready 并存（I3）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A', max_attempts: 5 }] });
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 10, now: T0 });
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 11 });
    // 回收后任务回 ready、owner 清空；重新派给同一 agent 前把 owner 手工指回以呈现两维度差异
    db.prepare('UPDATE tasks SET owner_agent = ? WHERE id = ?').run('w1', c.task.id);

    const s = status(db, { team_id: g.team_id });
    const row = s.tasks.list.find((x) => x.id === c.task.id);
    assert.equal(row.coordinator_state, 'ready');
    assert.equal(row.transport_state, 'unknown');
    assert.notEqual(row.transport_state, row.coordinator_state);
  });

  it('无 owner 的任务 transport_state 为 null，不由 coordinator_state 反推', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const s = status(db, { team_id: g.team_id });
    assert.equal(s.tasks.list[0].transport_state, null);
    assert.equal(s.tasks.list[0].coordinator_state, 'ready');
  });

  it('mailbox 统计未 ack 数量并按 agent 分组', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'm' });
    mailSend(db, { to_agent: 'w1', dedupe_key: 'a', team_id: team.team_id, now: T0 });
    mailSend(db, { to_agent: 'w1', dedupe_key: 'b', team_id: team.team_id, now: T0 });
    mailSend(db, { to_agent: 'w2', dedupe_key: 'c', team_id: team.team_id, now: T0 });
    const s = status(db, { team_id: team.team_id });
    assert.equal(s.mailbox.pending, 3);
    assert.deepEqual(plain(s.mailbox.by_agent), { w1: 2, w2: 1 });
  });

  it('events 按 id 倒序返回且受 event_limit 限制', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] });
    drainClaims(db, g.graph_id);
    const s = status(db, { team_id: g.team_id, event_limit: 2 });
    assert.equal(s.events.length, 2);
    assert.ok(s.events[0].id > s.events[1].id);
  });

  it('team 不存在时抛 TEAM_NOT_FOUND', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => status(db, { team_id: 'team-ghost' }), (e) => e.code === 'TEAM_NOT_FOUND');
  });
});

/**
 * 标识体系的裁决（本轮审计）：旧断言把 `id` 当 task key、`depends_on` 用 key 数组。
 * 但唯一约束是 UNIQUE(graph_id, key) —— key 只在**图内**唯一，同一 team 提交两个图并复用同名
 * key 完全合法。以 key 为关联键会让镜像串行（第一个图的任务贴上第二个图的 depends_on）。
 * 新契约：`id` 用全库唯一的数字 task id，`key`/`graph_id` 保留可读定位，
 * `depends_on` 用数字 id 数组（消歧），`depends_on_keys` 用 key 数组（保留 §7.3 可读性）。
 */
describe('exportMirror', () => {
  it('depends_on 用数字 task id，depends_on_keys 并列给出可读的 key', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
    });
    const m = exportMirror(db, { team_id: g.team_id });
    const c = m.tasks.find((x) => x.key === 'C');
    assert.equal(c.id, g.task_ids.C);
    assert.deepEqual(c.depends_on, [g.task_ids.A, g.task_ids.B].sort((a, b) => a - b));
    assert.equal(c.depends_on.every((d) => Number.isInteger(d)), true, 'depends_on 必须全是数字 id');
    assert.deepEqual(c.depends_on_keys, ['A', 'B']);
    assert.equal(c.graph_id, g.graph_id);
  });

  it('同 team 两个图复用同名 key 时镜像不串行（消歧靠数字 id）', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'dual-graph' });
    // 两个图用**完全相同**的 key 集合与依赖形态，只有 title 不同
    const g1 = dagSubmit(db, {
      team_id: team.team_id,
      tasks: [{ key: 'A', title: '图1-A' }, { key: 'B', title: '图1-B' }],
      deps: [{ from: 'A', to: 'B' }]
    });
    const g2 = dagSubmit(db, {
      team_id: team.team_id,
      tasks: [{ key: 'A', title: '图2-A' }, { key: 'B', title: '图2-B' }],
      deps: [{ from: 'A', to: 'B' }]
    });
    assert.notEqual(g1.task_ids.A, g2.task_ids.A, '两个图的同名 key 必须是不同的数字 id');

    const m = exportMirror(db, { team_id: team.team_id });
    assert.equal(m.tasks.length, 4);
    const byId = new Map(m.tasks.map((x) => [x.id, x]));

    // 每个任务的 title / graph_id / depends_on 都必须归属自己的图，绝不串到另一个图
    assert.equal(byId.get(g1.task_ids.A).title, '图1-A');
    assert.equal(byId.get(g2.task_ids.A).title, '图2-A');
    assert.equal(byId.get(g1.task_ids.B).graph_id, g1.graph_id);
    assert.equal(byId.get(g2.task_ids.B).graph_id, g2.graph_id);
    assert.deepEqual(byId.get(g1.task_ids.B).depends_on, [g1.task_ids.A]);
    assert.deepEqual(byId.get(g2.task_ids.B).depends_on, [g2.task_ids.A]);
    // depends_on_keys 两边都是 ['A']——正因为它有歧义，唯一性才必须由 id 承担
    assert.deepEqual(byId.get(g1.task_ids.B).depends_on_keys, ['A']);
    assert.deepEqual(byId.get(g2.task_ids.B).depends_on_keys, ['A']);
  });

  it('task 字段名符合 §7.3 镜像形态且 coordinator_state 与投影 status 并存', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, {
      tasks: [{ key: 'A', title: '甲', wave: 1, payload: { subagent_type: 'omz-junior', prompt: { task: 'do' } } }]
    });
    const m = exportMirror(db, { team_id: g.team_id });
    assert.deepEqual(Object.keys(m.tasks[0]).sort(), [
      'coordinator_state',
      'depends_on',
      'depends_on_keys',
      'graph_id',
      'id',
      'key',
      'prompt',
      'result_file',
      'status',
      'subagent_type',
      'title',
      'wave'
    ]);
    assert.equal(m.tasks[0].id, g.task_ids.A);
    assert.equal(m.tasks[0].key, 'A');
    assert.equal(m.tasks[0].title, '甲');
    assert.equal(m.tasks[0].wave, 1);
    assert.equal(m.tasks[0].subagent_type, 'omz-junior');
    assert.deepEqual(m.tasks[0].prompt, { task: 'do' });
    assert.equal(m.tasks[0].status, 'pending'); // ready → pending 的四态投影
    assert.equal(m.tasks[0].coordinator_state, 'ready');
    assert.deepEqual(m.tasks[0].depends_on, []);
    assert.deepEqual(m.tasks[0].depends_on_keys, []);
  });

  it('state 段带 team 元信息、source=sqlite 与 counts', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }], name: 'mirror-team' });
    const m = exportMirror(db, { team_id: g.team_id });
    assert.equal(m.state.team_id, g.team_id);
    assert.equal(m.state.name, 'mirror-team');
    assert.equal(m.state.source, 'sqlite');
    assert.equal(m.state.counts.ready, 1);
    assert.equal(Number.isInteger(m.state.exported_at), true);
  });

  it('state.counts 与 status() 用同一套 7 键（字段集合稳定）', (t) => {
    const { db } = freshDb(t);
    const g = seedGraph(db, { tasks: [{ key: 'A' }] });
    const m = exportMirror(db, { team_id: g.team_id });
    assert.deepEqual(
      Object.keys(m.state.counts).sort(),
      Object.keys(status(db, { team_id: g.team_id }).tasks.counts).sort()
    );
  });

  it('七态被正确投影为四态（dead → failed，running/done 原样）', (t) => {
    const { db } = freshDb(t);
    // priority 决定派发顺序（priority DESC, id），据此确定性地把三个任务推入不同终态
    const g = seedGraph(db, {
      tasks: [{ key: 'D', max_attempts: 1, priority: 3 }, { key: 'K', priority: 2 }, { key: 'R', priority: 1 }]
    });
    const cd = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    assert.equal(cd.task.key, 'D');
    taskFail(db, { task_id: cd.task.id, agent_ref: 'w1', error: 'x', now: T0 + 1 });
    const ck = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 2 });
    assert.equal(ck.task.key, 'K');
    taskComplete(db, { task_id: ck.task.id, agent_ref: 'w2', result_ref: 'results/k.json', now: T0 + 3 });
    const cr = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 + 4 });
    assert.equal(cr.task.key, 'R');

    const m = exportMirror(db, { team_id: g.team_id });
    const byKey = new Map(m.tasks.map((x) => [x.key, x]));
    assert.equal(byKey.get('D').status, 'failed');
    assert.equal(byKey.get('D').coordinator_state, 'dead');
    assert.equal(byKey.get('K').status, 'done');
    assert.equal(byKey.get('K').result_file, 'results/k.json');
    assert.equal(byKey.get('R').status, 'running');
  });

  it('team 不存在时抛 TEAM_NOT_FOUND；team_id 缺失时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => exportMirror(db, { team_id: 'team-ghost' }), (e) => e.code === 'TEAM_NOT_FOUND');
    assert.throws(() => exportMirror(db, {}), (e) => e.code === 'BAD_ARGS');
  });
});

/**
 * DAG 不变量校验（BLOCKER 1 的观测面）。
 * 重复递减 deps_remaining 造成的损坏是**自洽**的（deps_remaining=0 且 status=ready），
 * 从状态本身看不出异常，唯一的揭发手段就是拿 tasks.deps_remaining 与 task_deps 里
 * 真实的未完成上游数对账。下面逐个覆盖 at-least-once 的现实重放组合。
 */
describe('verifyGraphInvariants', () => {
  /** 造一个 A,B → C 的菱形上半段：C 有两个上游，最容易暴露重复递减。 */
  function seedDiamond(db) {
    return seedGraph(db, {
      tasks: [{ key: 'A', priority: 3, max_attempts: 5 }, { key: 'B', priority: 2, max_attempts: 5 }, { key: 'C' }],
      deps: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
    });
  }

  it('刚提交的图不变量成立', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(r.checked, 3);
    assert.deepEqual(r.violations, []);
  });

  it('不带 idempotency_key 重复 complete 后不变量仍成立（终态守卫拦住二次递减）', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 1 });
    const again = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 2 });
    assert.equal(again.duplicate, true);

    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    // C 仍有 1 个未完成上游，必须还是 blocked
    const cRow = plain(db.prepare('SELECT status, deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C));
    assert.equal(cRow.deps_remaining, 1);
    assert.equal(cRow.status, 'blocked');
  });

  it('带不同 idempotency_key 重复 complete 后不变量仍成立（新键绕不过终态守卫）', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k1', now: T0 + 1 });
    const again = taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', idempotency_key: 'k2-different', now: T0 + 2 });
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.unblocked, []);

    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(db.prepare('SELECT deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C).deps_remaining, 1);
  });

  it('对 done 任务上报 fail 后不变量仍成立（终态任务不得被复活）', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', result_ref: 'results/A.json', now: T0 + 1 });
    const failed = taskFail(db, { task_id: c.task.id, agent_ref: 'w1', error: '迟到的失败', now: T0 + 2 });
    assert.equal(failed.duplicate, true);
    assert.equal(failed.status, 'done');

    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.task.id).status, 'done');
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
  });

  it('陌生 agent 对 blocked 任务上报 fail 被拒且不变量仍成立（不得绕过依赖）', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    assert.throws(
      () => taskFail(db, { task_id: g.task_ids.C, agent_ref: 'stranger', error: 'x', now: T0 + 1 }),
      (e) => e.code === 'NOT_OWNER'
    );
    const cRow = plain(db.prepare('SELECT status, deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C));
    assert.equal(cRow.status, 'blocked', 'blocked 任务被 fail 改成 ready 就是绕过依赖');
    assert.equal(cRow.deps_remaining, 2);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
  });

  it('reclaim 后原 owner 迟到 complete 被拒且不变量仍成立', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    assert.throws(
      () => taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 40 }),
      (e) => e.code === 'NOT_OWNER'
    );
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(db.prepare('SELECT deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C).deps_remaining, 2);
  });

  it('reclaim 后重新认领并完成，下游只被解锁一次', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 32 });
    assert.equal(c2.task.id, c1.task.id, '回收后应重新派出同一任务');
    taskComplete(db, { task_id: c2.task.id, agent_ref: 'w2', now: T0 + 33 });

    const cb = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 + 34 });
    taskComplete(db, { task_id: cb.task.id, agent_ref: 'w3', now: T0 + 35 });

    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const cRow = plain(db.prepare('SELECT status, deps_remaining FROM tasks WHERE id = ?').get(g.task_ids.C));
    assert.equal(cRow.deps_remaining, 0);
    assert.equal(cRow.status, 'ready');
  });

  it('全图跑完后不变量成立（所有边 consumed、所有 deps_remaining 归零）', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    for (let i = 0; i < 3; i += 1) {
      const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: `w${i}`, now: T0 + i * 10 });
      assert.ok(c.task, `第 ${i} 轮应有任务可派`);
      taskComplete(db, { task_id: c.task.id, agent_ref: `w${i}`, now: T0 + i * 10 + 1 });
    }
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_deps WHERE graph_id = ? AND consumed = 0").get(g.graph_id).c, 0);
  });

  /**
   * 检测器自身的有效性证明：如果 verifyGraphInvariants 永远返回 ok，上面那些用例就毫无价值。
   * 这里人为把库改坏，要求它必须报出违规。
   */
  it('人为损坏 deps_remaining 后能检出 deps-remaining-mismatch', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    db.prepare('UPDATE tasks SET deps_remaining = 5 WHERE id = ?').run(g.task_ids.C);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, false, '检测器必须报出这次损坏，否则它形同虚设');
    const v = r.violations.find((x) => x.kind === 'deps-remaining-mismatch');
    assert.ok(v, `缺 deps-remaining-mismatch：${JSON.stringify(r.violations)}`);
    assert.equal(v.task_id, g.task_ids.C);
    assert.equal(v.deps_remaining, 5);
    assert.equal(v.expected, 2);
  });

  it('人为把 deps_remaining 归零但仍 blocked 时检出 blocked-with-no-open-upstream', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    // 上游全 done、边全消费，但下游被卡在 blocked —— 这正是「该 ready 却永久卡死」的形态
    for (const key of ['A', 'B']) {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(g.task_ids[key]);
    }
    db.prepare('UPDATE task_deps SET consumed = 1 WHERE graph_id = ?').run(g.graph_id);
    db.prepare("UPDATE tasks SET deps_remaining = 0, status = 'blocked' WHERE id = ?").run(g.task_ids.C);

    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.kind === 'blocked-with-no-open-upstream' && x.task_id === g.task_ids.C));
  });

  it('上游未 done 却把任务改成 ready 时检出 dispatched-with-open-upstream', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(g.task_ids.C);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.kind === 'dispatched-with-open-upstream' && x.task_id === g.task_ids.C));
  });

  it('边被标 consumed 但上游未 done 时检出 edge-consumed-but-upstream-not-done', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    db.prepare('UPDATE task_deps SET consumed = 1 WHERE graph_id = ? AND upstream = ?').run(g.graph_id, g.task_ids.A);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.kind === 'edge-consumed-but-upstream-not-done'));
  });

  it('上游 done 但边未消费时检出 edge-unconsumed-but-upstream-done', (t) => {
    const { db } = freshDb(t);
    const g = seedDiamond(db);
    const c = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskComplete(db, { task_id: c.task.id, agent_ref: 'w1', now: T0 + 1 });
    // 手工把已消费的边回退成未消费：模拟历史脏数据
    db.prepare('UPDATE task_deps SET consumed = 0 WHERE graph_id = ? AND upstream = ?').run(g.graph_id, c.task.id);
    const r = verifyGraphInvariants(db, { graph_id: g.graph_id });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.kind === 'edge-unconsumed-but-upstream-done'));
  });

  it('graph 不存在时抛 GRAPH_NOT_FOUND；graph_id 缺失时抛 BAD_ARGS', (t) => {
    const { db } = freshDb(t);
    assert.throws(() => verifyGraphInvariants(db, { graph_id: 'graph-ghost' }), (e) => e.code === 'GRAPH_NOT_FOUND');
    assert.throws(() => verifyGraphInvariants(db, {}), (e) => e.code === 'BAD_ARGS');
  });
});

/** max_parallel 限流（§13.5 I4「超过阈值自动降并发」）：统计必须在写事务内完成。 */
describe('max_parallel 限流', () => {
  it('max_parallel=2 时第 3 次 claim 返回 reason=max-parallel 而不是任务', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'mp', max_parallel: 2 });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] });

    assert.ok(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 }).task);
    assert.ok(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 }).task);
    const third = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 });
    assert.equal(third.task, null);
    assert.equal(third.reason, 'max-parallel');
    assert.equal(third.running, 2);
    assert.equal(third.max_parallel, 2);
    // C 仍是 ready（被限流不等于被消耗掉）
    assert.equal(db.prepare('SELECT status, attempts FROM tasks WHERE id = ?').get(g.task_ids.C).status, 'ready');
    assert.equal(db.prepare('SELECT attempts FROM tasks WHERE id = ?').get(g.task_ids.C).attempts, 0);
  });

  it('完成一个任务后名额释放，第 3 个任务可被认领', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'mp-release', max_parallel: 2 });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] });

    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 });
    assert.equal(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 }).reason, 'max-parallel');

    taskComplete(db, { task_id: c1.task.id, agent_ref: 'w1', now: T0 + 1 });
    const third = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w3', now: T0 + 2 });
    assert.ok(third.task, '名额释放后应能派出第 3 个任务');
    assert.equal(third.reason, undefined);
  });

  it('lease 回收也释放名额（回收后 running 数下降）', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'mp-reclaim', max_parallel: 1 });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A', max_attempts: 5 }, { key: 'B' }] });

    taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', lease_seconds: 30, now: T0 });
    assert.equal(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 1 }).reason, 'max-parallel');
    reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 31 });
    assert.ok(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 + 32 }).task);
  });

  it('max_parallel 是 team 级而非 graph 级（同 team 的两个图共享名额）', (t) => {
    const { db } = freshDb(t);
    const team = teamCreate(db, { name: 'mp-team-wide', max_parallel: 1 });
    const g1 = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }] });
    const g2 = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A' }] });

    assert.ok(taskClaim(db, { graph_id: g1.graph_id, agent_ref: 'w1', now: T0 }).task);
    const other = taskClaim(db, { graph_id: g2.graph_id, agent_ref: 'w2', now: T0 });
    assert.equal(other.task, null);
    assert.equal(other.reason, 'max-parallel');
  });
});
