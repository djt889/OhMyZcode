/**
 * OMZ coordinator 纯逻辑层：全部函数签名 (db, args) => result，绝不 console.log（stdout 属 JSON-RPC）。
 * 语义（DESIGN §13.5 I3）：at-least-once，不承诺 exactly-once。
 *   - complete/fail/send/ack 一律接受幂等键，重复调用返回首次结果并标 duplicate: true。
 *   - transport_state（agents 表）与 coordinator_state（tasks.status）是两个独立维度，禁止互推。
 * 事务纪律（§7.2 / I4）：写路径只用 withImmediate 包裹纯 SQL；claim 返回即 COMMIT，
 *   外部 agent 执行期间不持有任何写事务。
 */
import crypto from 'node:crypto';
import { CoordinatorError, nowSec, withImmediate } from './db.mjs';

const TERMINAL_STATUS = new Set(['done', 'failed', 'dead']);

function rand(n) {
  return crypto.randomBytes(32).toString('hex').slice(0, n);
}

function toJson(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function parseJson(s) {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s; // 非 JSON 的历史值原样返回，不因单条脏数据拖垮整次查询
  }
}

/** 每次状态变更都追加一行 events：审计链是 I3 对账的唯一依据，不可省。 */
function addEvent(db, { team_id = null, task_id = null, agent_ref = null, kind, detail = null, now }) {
  db.prepare(
    'INSERT INTO events(team_id, task_id, agent_ref, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(team_id, task_id, agent_ref, kind, toJson(detail), now ?? nowSec());
}

function requireStr(v, name) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new CoordinatorError('BAD_ARGS', `${name} 必须是非空字符串`, { field: name });
  }
  return v;
}

function getTeam(db, teamId) {
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!row) throw new CoordinatorError('TEAM_NOT_FOUND', `team 不存在: ${teamId}`, { team_id: teamId });
  return row;
}

function getTask(db, taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!row) throw new CoordinatorError('TASK_NOT_FOUND', `task 不存在: ${taskId}`, { task_id: taskId });
  return row;
}

/** agents 行是 transport 维度的登记簿；last_seen/transport_state 只反映传输层，不反映任务状态。 */
function upsertAgent(db, { agent_ref, team_id = null, transport_state = null, now }) {
  db.prepare(
    `INSERT INTO agents(agent_ref, team_id, transport_state, last_seen, created_at)
     VALUES (?, ?, COALESCE(?, 'pending'), ?, ?)
     ON CONFLICT(agent_ref) DO UPDATE SET
       team_id = COALESCE(excluded.team_id, agents.team_id),
       transport_state = COALESCE(?, agents.transport_state),
       last_seen = excluded.last_seen`
  ).run(agent_ref, team_id, transport_state, now, now, transport_state);
}

/**
 * 幂等表读取：命中即返回首次结果，调用方必须据此短路，绝不重复产生副作用。
 * 幂等键与 (op, task_id) 双重绑定：键只对"同一操作 + 同一任务"的重放有效。
 * 若同一键被用于另一个 task，返回首次结果等于把 A 任务的结论冒充成 B 任务的结论——
 * 调用方会据此认为 B 已完成，故必须显式报错而不是静默串号。
 */
function idemLookup(db, key, op, task_id = null) {
  if (!key) return null;
  const row = db.prepare('SELECT * FROM idempotency WHERE key = ?').get(key);
  if (!row) return null;
  if (row.op !== op) {
    throw new CoordinatorError('BAD_ARGS', `idempotency_key 已用于其他操作: ${row.op}`, {
      key,
      existing_op: row.op,
    });
  }
  if (task_id !== null && row.task_id !== null && row.task_id !== task_id) {
    throw new CoordinatorError(
      'BAD_ARGS',
      `幂等键已被 task ${row.task_id} 使用，不能用于 task ${task_id}`,
      { key, existing_task_id: row.task_id, task_id }
    );
  }
  return parseJson(row.result);
}

function idemStore(db, { key, op, task_id = null, result, now }) {
  if (!key) return;
  db.prepare(
    'INSERT OR REPLACE INTO idempotency(key, op, task_id, result, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(key, op, task_id, toJson(result), now);
}

/** 建 team。team_id 由服务端生成，避免客户端自选 id 造成跨会话撞名。 */
export function teamCreate(db, { name, max_parallel = 4, metadata = {} } = {}) {
  requireStr(name, 'name');
  if (!Number.isInteger(max_parallel) || max_parallel < 1) {
    throw new CoordinatorError('BAD_ARGS', 'max_parallel 必须是 >=1 的整数', { max_parallel });
  }
  const now = nowSec();
  return withImmediate(db, (tx) => {
    let team_id = `team-${rand(8)}`;
    while (tx.prepare('SELECT 1 FROM teams WHERE id = ?').get(team_id)) team_id = `team-${rand(8)}`;
    tx.prepare(
      'INSERT INTO teams(id, name, max_parallel, metadata, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(team_id, name, max_parallel, toJson(metadata), 'active', now, now);
    addEvent(tx, { team_id, kind: 'team-created', detail: { name, max_parallel }, now });
    return { team_id, name, max_parallel, created_at: now };
  });
}

/**
 * 关闭 team。
 *   - 非 force 且仍有 running：转 'draining' —— 不杀在途工作，但立即拒绝新 claim。
 *   - force：running/ready/blocked 全标 failed（detail 记 forced），team 转 'shutdown'。
 * 两种情况下 taskClaim 都必须返回 null（team 状态非 active 即停止发牌）。
 */
export function teamShutdown(db, { team_id, force = false } = {}) {
  requireStr(team_id, 'team_id');
  const now = nowSec();
  return withImmediate(db, (tx) => {
    const team = getTeam(tx, team_id);
    const running = tx
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE team_id = ? AND status = 'running'")
      .get(team_id).c;
    const open = tx
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE team_id = ? AND status IN ('blocked','ready','running','unknown')"
      )
      .get(team_id).c;

    if (!force && running > 0) {
      tx.prepare('UPDATE teams SET status = ?, updated_at = ? WHERE id = ?').run('draining', now, team_id);
      addEvent(tx, { team_id, kind: 'team-draining', detail: { running, open_tasks: open }, now });
      return { team_id, status: 'draining', open_tasks: open };
    }

    let failed = 0;
    if (force) {
      const rows = tx
        .prepare(
          "SELECT id, status FROM tasks WHERE team_id = ? AND status IN ('blocked','ready','running','unknown')"
        )
        .all(team_id);
      for (const r of rows) {
        tx.prepare(
          "UPDATE tasks SET status = 'failed', owner_agent = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?"
        ).run('forced shutdown', now, r.id);
        addEvent(tx, {
          team_id,
          task_id: r.id,
          kind: 'task-failed',
          detail: { forced: true, previous_status: r.status },
          now,
        });
        failed += 1;
      }
    }
    tx.prepare('UPDATE teams SET status = ?, updated_at = ? WHERE id = ?').run('shutdown', now, team_id);
    addEvent(tx, {
      team_id,
      kind: 'team-shutdown',
      detail: { force, forced_failed: failed, previous_status: team.status },
      now,
    });
    const openAfter = tx
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE team_id = ? AND status IN ('blocked','ready','running','unknown')"
      )
      .get(team_id).c;
    return { team_id, status: 'shutdown', open_tasks: openAfter };
  });
}

/**
 * 提交 DAG。deps 元素 { from, to } 语义 = to 依赖 from（from 是上游）。
 * 单事务内完成：建 graph → 插 tasks → 插 deps → 算 deps_remaining → 定 ready/blocked。
 * 校验顺序：重复 key(BAD_ARGS) → 未知 key(UNKNOWN_TASK_KEY) → 自环/环(CYCLE_DETECTED)，
 * 且校验全部在写库之前完成，保证非法提交不留半个图。
 */
export function dagSubmit(db, { team_id, tasks, deps = [] } = {}) {
  requireStr(team_id, 'team_id');
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new CoordinatorError('BAD_ARGS', 'tasks 必须是非空数组');
  }
  if (!Array.isArray(deps)) throw new CoordinatorError('BAD_ARGS', 'deps 必须是数组');

  const keys = [];
  const seen = new Set();
  for (const t of tasks) {
    const k = t?.key;
    if (typeof k !== 'string' || k.length === 0) {
      throw new CoordinatorError('BAD_ARGS', 'task.key 必须是非空字符串', { task: t ?? null });
    }
    if (seen.has(k)) throw new CoordinatorError('BAD_ARGS', `重复的 task key: ${k}`, { key: k });
    seen.add(k);
    keys.push(k);
  }

  // 边归一化 + 未知 key 校验；重复边去重（同一依赖声明两次不是错误）。
  const edges = [];
  const edgeSeen = new Set();
  for (const d of deps) {
    const from = d?.from;
    const to = d?.to;
    if (!seen.has(from)) {
      throw new CoordinatorError('UNKNOWN_TASK_KEY', `deps.from 引用未知 key: ${from}`, { key: from });
    }
    if (!seen.has(to)) {
      throw new CoordinatorError('UNKNOWN_TASK_KEY', `deps.to 引用未知 key: ${to}`, { key: to });
    }
    if (from === to) {
      throw new CoordinatorError('CYCLE_DETECTED', `自环依赖: ${from}`, { cycle: [from] });
    }
    const sig = `${from}\u0000${to}`;
    if (edgeSeen.has(sig)) continue;
    edgeSeen.add(sig);
    edges.push({ from, to });
  }

  // Kahn 拓扑排序检测环：indegree = 该 key 的上游数（即 deps_remaining 初值）。
  const indeg = new Map(keys.map((k) => [k, 0]));
  const downstream = new Map(keys.map((k) => [k, []]));
  for (const e of edges) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    downstream.get(e.from).push(e.to);
  }
  const queue = keys.filter((k) => indeg.get(k) === 0);
  const work = new Map(indeg);
  let visited = 0;
  for (let i = 0; i < queue.length; i += 1) {
    visited += 1;
    for (const nxt of downstream.get(queue[i])) {
      work.set(nxt, work.get(nxt) - 1);
      if (work.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (visited !== keys.length) {
    const stuck = keys.filter((k) => work.get(k) > 0);
    throw new CoordinatorError('CYCLE_DETECTED', '依赖图存在环', { involved: stuck });
  }

  const now = nowSec();
  return withImmediate(db, (tx) => {
    getTeam(tx, team_id);
    // graph_id 与 team_id 同纪律：随机长度提到 16 hex（64 bit）并循环重试去重。
    // 只靠 32 bit 随机在同一库里跑久了会撞主键，INSERT 直接抛异常且无从重试。
    let graph_id = `graph-${rand(16)}`;
    while (tx.prepare('SELECT 1 FROM graphs WHERE id = ?').get(graph_id)) graph_id = `graph-${rand(16)}`;
    tx.prepare('INSERT INTO graphs(id, team_id, created_at) VALUES (?, ?, ?)').run(graph_id, team_id, now);

    const task_ids = {};
    const insTask = tx.prepare(
      `INSERT INTO tasks(graph_id, team_id, key, title, payload, wave, priority, status,
                         deps_remaining, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    );
    for (const t of tasks) {
      const remaining = indeg.get(t.key);
      const status = remaining === 0 ? 'ready' : 'blocked';
      const info = insTask.run(
        graph_id,
        team_id,
        t.key,
        t.title ?? null,
        toJson(t.payload ?? null),
        Number.isInteger(t.wave) ? t.wave : null,
        Number.isInteger(t.priority) ? t.priority : 0,
        status,
        remaining,
        Number.isInteger(t.max_attempts) ? t.max_attempts : 3,
        now,
        now
      );
      task_ids[t.key] = Number(info.lastInsertRowid);
    }

    const insDep = tx.prepare(
      'INSERT INTO task_deps(graph_id, upstream, downstream) VALUES (?, ?, ?)'
    );
    for (const e of edges) insDep.run(graph_id, task_ids[e.from], task_ids[e.to]);

    const ready = keys.filter((k) => indeg.get(k) === 0).map((k) => task_ids[k]);
    addEvent(tx, {
      team_id,
      kind: 'dag-submitted',
      detail: { graph_id, tasks: keys.length, deps: edges.length, ready: ready.length },
      now,
    });
    return { graph_id, task_ids, ready };
  });
}

/**
 * 认领一个 ready 任务。严格照 DESIGN §7.2 形态：BEGIN IMMEDIATE + 单条
 * UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING。RETURNING 不是锁，
 * 靠 BEGIN IMMEDIATE 的写锁串行化，因此并发 claim 不可能拿到同一行。
 * 返回后立即 COMMIT——agent 执行外部工作期间绝不持有写事务（I4）。
 * team 非 active（draining/shutdown）→ { task: null, reason: 'team-shutdown' }。
 * max_parallel 限流（§13.5 I4「超过阈值自动降并发」）：同一事务内统计该 team 的 running 数，
 *   已达上限 → { task: null, reason: 'max-parallel' }。统计必须在写事务内完成，
 *   否则"先读计数再开事务"本身就是竞态，N 个并发 claim 会同时读到未达上限。
 */
export function taskClaim(db, { graph_id, agent_ref, lease_seconds = 300, now } = {}) {
  requireStr(graph_id, 'graph_id');
  requireStr(agent_ref, 'agent_ref');
  if (!Number.isInteger(lease_seconds) || lease_seconds < 1) {
    throw new CoordinatorError('BAD_ARGS', 'lease_seconds 必须是 >=1 的整数', { lease_seconds });
  }
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const graph = tx.prepare('SELECT * FROM graphs WHERE id = ?').get(graph_id);
    if (!graph) {
      throw new CoordinatorError('GRAPH_NOT_FOUND', `graph 不存在: ${graph_id}`, { graph_id });
    }
    const team = getTeam(tx, graph.team_id);
    if (team.status !== 'active') {
      upsertAgent(tx, { agent_ref, team_id: team.id, now: ts });
      return { task: null, reason: 'team-shutdown' };
    }

    const running = Number(
      tx
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE team_id = ? AND status = 'running'")
        .get(team.id).c
    );
    if (running >= team.max_parallel) {
      upsertAgent(tx, { agent_ref, team_id: team.id, now: ts });
      return { task: null, reason: 'max-parallel', running, max_parallel: team.max_parallel };
    }

    const row = tx
      .prepare(
        `UPDATE tasks
            SET status = 'running', owner_agent = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = (
            SELECT id FROM tasks
             WHERE graph_id = ?
               AND status = 'ready'
               AND deps_remaining = 0
               AND (retry_at IS NULL OR retry_at <= ?)
             ORDER BY priority DESC, id
             LIMIT 1
          )
        RETURNING id, key, title, payload, wave, attempts, lease_until`
      )
      .get(agent_ref, ts + lease_seconds, ts, graph_id, ts);

    upsertAgent(tx, { agent_ref, team_id: team.id, transport_state: row ? 'running' : null, now: ts });
    if (!row) return { task: null };

    addEvent(tx, {
      team_id: team.id,
      task_id: row.id,
      agent_ref,
      kind: 'task-claimed',
      detail: { attempts: row.attempts, lease_until: row.lease_until },
      now: ts,
    });
    return {
      task: {
        id: row.id,
        key: row.key,
        title: row.title,
        payload: parseJson(row.payload),
        wave: row.wave,
        attempts: row.attempts,
        lease_until: row.lease_until,
      },
    };
  });
}

/** 延长 lease。只有 owner 能续；终态任务不可续（心跳不该复活已结束的任务）。 */
export function taskHeartbeat(db, { task_id, agent_ref, extend_seconds = 300, now } = {}) {
  if (!Number.isInteger(task_id)) throw new CoordinatorError('BAD_ARGS', 'task_id 必须是整数', { task_id });
  requireStr(agent_ref, 'agent_ref');
  if (!Number.isInteger(extend_seconds) || extend_seconds < 1) {
    throw new CoordinatorError('BAD_ARGS', 'extend_seconds 必须是 >=1 的整数', { extend_seconds });
  }
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const task = getTask(tx, task_id);
    if (TERMINAL_STATUS.has(task.status)) {
      throw new CoordinatorError('BAD_ARGS', `任务已是终态: ${task.status}`, {
        task_id,
        status: task.status,
      });
    }
    if (task.owner_agent !== agent_ref) {
      throw new CoordinatorError('NOT_OWNER', '仅 owner 可延长 lease', {
        task_id,
        owner: task.owner_agent,
        agent_ref,
      });
    }
    const lease_until = ts + extend_seconds;
    tx.prepare('UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?').run(lease_until, ts, task_id);
    upsertAgent(tx, { agent_ref, team_id: task.team_id, transport_state: 'running', now: ts });
    addEvent(tx, {
      team_id: task.team_id,
      task_id,
      agent_ref,
      kind: 'heartbeat',
      detail: { lease_until },
      now: ts,
    });
    return { task_id, lease_until };
  });
}

/**
 * 完成任务并原子解锁下游。
 * owner 判定取舍（I3）：lease 已过期但 owner 仍是本人 → 允许完成，events 记 late-complete；
 *   owner 已被别人接管 → NOT_OWNER（此时不能覆盖新 owner 的工作）。
 * 幂等：idempotency_key 命中即返回首次结果 + duplicate: true，绝不二次递减下游 deps_remaining。
 * 两层防重（缺一不可）：
 *   1) 终态守卫：任务已在 done/failed/dead 时直接返回 duplicate 结果，不再触碰下游。
 *      不带幂等键、或带一个「新」幂等键的重复 complete 都必须被这一层拦住，否则会把
 *      下游 deps_remaining 二次递减，令下游在上游未全部 done 时提前 ready——而且损坏后
 *      数据库自身自洽（deps_remaining=0 且 status=ready），事后无法从状态反推出错。
 *   2) 边的一次性消费：task_deps.consumed 标记该条依赖边是否已被兑付，递减只处理
 *      consumed=0 的边并同时置 1。即使守卫被绕过（历史脏数据、手工 SQL），也不会重复递减。
 */
export function taskComplete(db, { task_id, agent_ref, result_ref = null, idempotency_key = null, now } = {}) {
  if (!Number.isInteger(task_id)) throw new CoordinatorError('BAD_ARGS', 'task_id 必须是整数', { task_id });
  requireStr(agent_ref, 'agent_ref');
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const cached = idemLookup(tx, idempotency_key, 'complete', task_id);
    if (cached) return { ...cached, duplicate: true };

    const task = getTask(tx, task_id);
    // 终态守卫（第 1 层）：先于 owner 校验，因为终态任务的 owner 早已被清空，
    // 若让它落到 owner 分支会报 NOT_OWNER，掩盖"这是一次重放"的真实语义。
    if (TERMINAL_STATUS.has(task.status)) {
      return { task_id, status: task.status, unblocked: [], duplicate: true };
    }
    if (task.owner_agent !== null && task.owner_agent !== agent_ref) {
      throw new CoordinatorError('NOT_OWNER', '任务 owner 已变更，拒绝完成', {
        task_id,
        owner: task.owner_agent,
        agent_ref,
      });
    }
    if (task.owner_agent === null) {
      throw new CoordinatorError('NOT_OWNER', '任务无 owner（可能已被回收），拒绝完成', {
        task_id,
        status: task.status,
      });
    }
    const late = task.lease_until !== null && task.lease_until < ts;
    if (late) {
      addEvent(tx, {
        team_id: task.team_id,
        task_id,
        agent_ref,
        kind: 'late-complete',
        detail: { lease_until: task.lease_until, now: ts },
        now: ts,
      });
    }

    tx.prepare(
      `UPDATE tasks SET status = 'done', result_ref = ?, lease_until = NULL, retry_at = NULL, updated_at = ?
        WHERE id = ?`
    ).run(toJson(result_ref), ts, task_id);

    const unblocked = [];
    // 一次性消费（第 2 层）：只取未消费的边，取到即在同一事务内置 consumed=1。
    const downs = tx
      .prepare('SELECT downstream FROM task_deps WHERE graph_id = ? AND upstream = ? AND consumed = 0')
      .all(task.graph_id, task_id);
    for (const d of downs) {
      const marked = tx
        .prepare(
          'UPDATE task_deps SET consumed = 1 WHERE graph_id = ? AND upstream = ? AND downstream = ? AND consumed = 0'
        )
        .run(task.graph_id, task_id, d.downstream);
      if (Number(marked.changes) !== 1) continue; // 该边已被并发路径消费，不重复递减
      const after = tx
        .prepare(
          `UPDATE tasks SET deps_remaining = MAX(deps_remaining - 1, 0), updated_at = ?
            WHERE id = ? RETURNING id, status, deps_remaining`
        )
        .get(ts, d.downstream);
      if (after && after.deps_remaining === 0 && after.status === 'blocked') {
        tx.prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?").run(ts, after.id);
        unblocked.push(after.id);
        addEvent(tx, { team_id: task.team_id, task_id: after.id, kind: 'task-ready', detail: { unblocked_by: task_id }, now: ts });
      }
    }

    addEvent(tx, {
      team_id: task.team_id,
      task_id,
      agent_ref,
      kind: 'task-completed',
      detail: { result_ref, unblocked, late },
      now: ts,
    });
    const result = { task_id, status: 'done', unblocked };
    idemStore(tx, { key: idempotency_key, op: 'complete', task_id, result, now: ts });
    return { ...result, duplicate: false };
  });
}

/**
 * 失败上报。attempts < max_attempts → 回 ready（记 retry_at/last_error，清 owner/lease）；
 * 否则进 dead-letter（status='dead'，不再发牌）。同样支持幂等键。
 * 注意 attempts 在 claim 时已 +1，这里只读不加，避免重复计数。
 * 三道守卫：
 *   1) 终态守卫：done/failed/dead 的任务不可被 fail。缺了它，对已 done 的任务上报 fail 会把它
 *      复活成 ready（result_ref 被清、可被重新 claim、再次 complete → 下游二次解锁）。
 *   2) owner 校验对齐 complete：owner_agent 为 null 时一律 NOT_OWNER。此前"null 就不校验"
 *      等于开了一条任意 agent 对他人任务写 last_error / 改状态的通道。
 *   3) 只有 running 的任务可以 fail：blocked 任务（deps_remaining>0）被 fail 会被改成 ready，
 *      这是直接绕过依赖的通道，必须堵死。
 */
export function taskFail(db, { task_id, agent_ref, error = null, retry_at = null, idempotency_key = null, now } = {}) {
  if (!Number.isInteger(task_id)) throw new CoordinatorError('BAD_ARGS', 'task_id 必须是整数', { task_id });
  requireStr(agent_ref, 'agent_ref');
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const cached = idemLookup(tx, idempotency_key, 'fail', task_id);
    if (cached) return { ...cached, duplicate: true };

    const task = getTask(tx, task_id);
    if (TERMINAL_STATUS.has(task.status)) {
      return {
        task_id,
        status: task.status,
        attempts: task.attempts,
        dead_letter: task.status === 'dead',
        duplicate: true,
      };
    }
    if (task.owner_agent !== agent_ref) {
      throw new CoordinatorError('NOT_OWNER', '仅 owner 可上报失败', {
        task_id,
        owner: task.owner_agent,
        agent_ref,
        status: task.status,
      });
    }
    if (task.status !== 'running') {
      throw new CoordinatorError('BAD_ARGS', `仅 running 的任务可上报失败，当前状态: ${task.status}`, {
        task_id,
        status: task.status,
      });
    }
    const dead = task.attempts >= task.max_attempts;
    const status = dead ? 'dead' : 'ready';
    tx.prepare(
      `UPDATE tasks SET status = ?, owner_agent = NULL, lease_until = NULL, last_error = ?, retry_at = ?, updated_at = ?
        WHERE id = ?`
    ).run(status, toJson(error), dead ? null : retry_at, ts, task_id);
    addEvent(tx, {
      team_id: task.team_id,
      task_id,
      agent_ref,
      kind: dead ? 'task-dead-letter' : 'task-retry',
      detail: { attempts: task.attempts, max_attempts: task.max_attempts, error, retry_at },
      now: ts,
    });
    const result = { task_id, status, attempts: task.attempts, dead_letter: dead };
    idemStore(tx, { key: idempotency_key, op: 'fail', task_id, result, now: ts });
    return { ...result, duplicate: false };
  });
}

/**
 * 回收过期 lease（I3 的 unknown 状态处理）。
 * running 且 lease_until < now：attempts < max_attempts → ready，否则 dead。
 * 同时把原 owner 的 agents.transport_state 置 'unknown'——传输层是否还活着无法证明，
 * 只能标不可判定；这与任务的 coordinator_state 是两个独立维度，不得互推。
 */
export function reclaimExpired(db, { graph_id = null, now } = {}) {
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const rows = graph_id
      ? tx
          .prepare(
            "SELECT * FROM tasks WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ? AND graph_id = ?"
          )
          .all(ts, graph_id)
      : tx
          .prepare("SELECT * FROM tasks WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?")
          .all(ts);

    const reclaimed = [];
    for (const t of rows) {
      const dead = t.attempts >= t.max_attempts;
      const status = dead ? 'dead' : 'ready';
      tx.prepare(
        `UPDATE tasks SET status = ?, owner_agent = NULL, lease_until = NULL, last_error = ?, updated_at = ?
          WHERE id = ?`
      ).run(status, toJson({ reason: 'lease-expired', previous_owner: t.owner_agent }), ts, t.id);
      if (t.owner_agent) {
        // last_seen 必须是"本次观测发生的时刻"= ts。写 t.lease_until 是个已过去的时间戳，
        // 会让 last_seen 相对之前的心跳倒退，破坏"last_seen 单调不减"的可观测性假设。
        tx.prepare('UPDATE agents SET transport_state = ?, last_seen = ? WHERE agent_ref = ?').run(
          'unknown',
          ts,
          t.owner_agent
        );
      }
      addEvent(tx, {
        team_id: t.team_id,
        task_id: t.id,
        agent_ref: t.owner_agent,
        kind: 'lease-expired',
        detail: { previous_owner: t.owner_agent, attempts: t.attempts, new_status: status },
        now: ts,
      });
      reclaimed.push({ task_id: t.id, previous_owner: t.owner_agent, attempts: t.attempts, status });
    }
    return { reclaimed };
  });
}

/**
 * 投递消息。dedupe_key 是唯一索引，冲突即视为重发：返回已存在行 + duplicate: true。
 * seq 在事务内取 MAX(seq)+1，全局单调（BEGIN IMMEDIATE 保证无并发空洞/重号）。
 */
export function mailSend(db, { to_agent, from_agent = null, task_id = null, payload = null, dedupe_key, team_id = null, now } = {}) {
  requireStr(to_agent, 'to_agent');
  requireStr(dedupe_key, 'dedupe_key');
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const exist = tx.prepare('SELECT id, seq FROM messages WHERE dedupe_key = ?').get(dedupe_key);
    if (exist) return { message_id: exist.id, seq: exist.seq, duplicate: true };

    const seq = Number(tx.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages').get().s);
    const info = tx
      .prepare(
        `INSERT INTO messages(seq, team_id, to_agent, from_agent, task_id, payload, dedupe_key, acked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(seq, team_id, to_agent, from_agent, task_id, toJson(payload), dedupe_key, ts);
    const message_id = Number(info.lastInsertRowid);
    upsertAgent(tx, { agent_ref: to_agent, team_id, now: ts });
    addEvent(tx, {
      team_id,
      task_id,
      agent_ref: from_agent,
      kind: 'mail-sent',
      detail: { message_id, seq, to_agent },
      now: ts,
    });
    return { message_id, seq, duplicate: false };
  });
}

/** 拉取未 ack 消息（只读，按 seq 升序）。读不改 acked：ack 是显式动作，避免读丢消息。 */
export function mailReceive(db, { agent_ref, limit = 10 } = {}) {
  requireStr(agent_ref, 'agent_ref');
  const n = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const rows = db
    .prepare(
      `SELECT id, seq, from_agent, task_id, payload, created_at FROM messages
        WHERE to_agent = ? AND acked = 0 ORDER BY seq ASC LIMIT ?`
    )
    .all(agent_ref, n);
  return {
    messages: rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      from_agent: r.from_agent,
      task_id: r.task_id,
      payload: parseJson(r.payload),
      created_at: r.created_at,
    })),
  };
}

/** 幂等确认。收件人不匹配 → NOT_OWNER；已 ack → duplicate: true（重复 ack 不是错误）。 */
export function mailAck(db, { message_id, agent_ref, now } = {}) {
  if (!Number.isInteger(message_id)) {
    throw new CoordinatorError('BAD_ARGS', 'message_id 必须是整数', { message_id });
  }
  requireStr(agent_ref, 'agent_ref');
  const ts = Number.isInteger(now) ? now : nowSec();
  return withImmediate(db, (tx) => {
    const msg = tx.prepare('SELECT * FROM messages WHERE id = ?').get(message_id);
    if (!msg) {
      throw new CoordinatorError('MESSAGE_NOT_FOUND', `message 不存在: ${message_id}`, { message_id });
    }
    if (msg.to_agent !== agent_ref) {
      throw new CoordinatorError('NOT_OWNER', '仅收件人可 ack', {
        message_id,
        to_agent: msg.to_agent,
        agent_ref,
      });
    }
    if (msg.acked === 1) return { message_id, acked: true, duplicate: true };
    tx.prepare('UPDATE messages SET acked = 1, acked_at = ? WHERE id = ?').run(ts, message_id);
    addEvent(tx, {
      team_id: msg.team_id,
      task_id: msg.task_id,
      agent_ref,
      kind: 'mail-acked',
      detail: { message_id, seq: msg.seq },
      now: ts,
    });
    return { message_id, acked: true, duplicate: false };
  });
}

// tasks.status 的完整 7 态枚举。'unknown' 必须在列：status() / exportMirror() 都会在遇到该状态时
// 动态塞入这个键，若基础键集里没有它，counts 的字段集合就随数据内容漂移——调用方（dashboard、
// 渲染器、快照 diff）无法依赖一个稳定的字段集合。
const COUNT_KEYS = ['ready', 'running', 'done', 'failed', 'dead', 'blocked', 'unknown'];

/**
 * 汇总视图。I3 硬要求：transport_state（agents 表，传输层是否还在）与
 * coordinator_state（tasks.status，调度器认为的任务状态）分两个字段呈现，绝不合并成一个"状态"。
 */
export function status(db, { team_id, event_limit = 20 } = {}) {
  requireStr(team_id, 'team_id');
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) throw new CoordinatorError('TEAM_NOT_FOUND', `team 不存在: ${team_id}`, { team_id });
  const n = Number.isInteger(event_limit) && event_limit > 0 ? event_limit : 20;

  const agentRows = db
    .prepare('SELECT agent_ref, role, resume_ref, transport_state, last_seen FROM agents WHERE team_id = ? ORDER BY agent_ref')
    .all(team_id);
  const transportOf = new Map(agentRows.map((a) => [a.agent_ref, a.transport_state]));

  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const r of db
    .prepare('SELECT status, COUNT(*) AS c FROM tasks WHERE team_id = ? GROUP BY status')
    .all(team_id)) {
    counts[r.status] = Number(r.c);
  }

  const list = db
    .prepare(
      `SELECT id, key, wave, status, owner_agent, attempts FROM tasks WHERE team_id = ?
        ORDER BY COALESCE(wave, 0), id`
    )
    .all(team_id)
    .map((t) => ({
      id: t.id,
      key: t.key,
      wave: t.wave,
      status: t.status,
      owner_agent: t.owner_agent,
      attempts: t.attempts,
      // 两个独立维度：transport 未登记时为 null，不允许由 coordinator_state 推断。
      transport_state: t.owner_agent ? transportOf.get(t.owner_agent) ?? null : null,
      coordinator_state: t.status,
    }));

  const pending = Number(
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE team_id = ? AND acked = 0').get(team_id).c
  );
  const by_agent = {};
  for (const r of db
    .prepare('SELECT to_agent, COUNT(*) AS c FROM messages WHERE team_id = ? AND acked = 0 GROUP BY to_agent')
    .all(team_id)) {
    by_agent[r.to_agent] = Number(r.c);
  }

  const events = db
    .prepare('SELECT id, task_id, agent_ref, kind, detail, created_at FROM events WHERE team_id = ? ORDER BY id DESC LIMIT ?')
    .all(team_id, n)
    .map((e) => ({ ...e, detail: parseJson(e.detail) }));

  return {
    team: {
      id: team.id,
      name: team.name,
      status: team.status,
      max_parallel: team.max_parallel,
      metadata: parseJson(team.metadata),
      created_at: team.created_at,
      updated_at: team.updated_at,
    },
    agents: agentRows,
    tasks: { counts, list },
    mailbox: { pending, by_agent },
    events,
  };
}

// coordinator 7 态 → §7.3 的 4 态镜像投影（JSON 只是镜像，SQLite 才是事实源）。
// blocked/ready 都投影为 pending；dead/unknown 投影为 failed，原始态另存 coordinator_state。
const MIRROR_STATUS = {
  blocked: 'pending',
  ready: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  dead: 'failed',
  unknown: 'failed',
};

/**
 * 审计导出：DESIGN §7.3 形态的 JSON 镜像。
 *
 * 标识体系（MAJOR 9 的修复决定）：唯一约束是 UNIQUE(graph_id, key)，也就是 task key 只在**图内**唯一。
 * 同一 team 提交两个图并复用同名 key 是完全合法的，此时以 key 为关联键会让镜像串行
 * （第一个图的任务贴上第二个图的 title/depends_on）。因此：
 *   - `id`：数字 task id（全库唯一，镜像的主键，任何关联都用它）
 *   - `key` / `graph_id`：保留原始图内键与所属图，供人读与定位
 *   - `depends_on`：数字 task id 数组（消歧的那一份）
 *   - `depends_on_keys`：对应的 key 数组（保持 §7.3 的可读性）
 * §7.3 的样例里 depends_on 用 key，这里用 id 是刻意偏离：可读性由 depends_on_keys 承担，
 * 唯一性由 id 承担，两个目标不再互相牺牲。
 */
export function exportMirror(db, { team_id } = {}) {
  requireStr(team_id, 'team_id');
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) throw new CoordinatorError('TEAM_NOT_FOUND', `team 不存在: ${team_id}`, { team_id });

  const rows = db
    .prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY COALESCE(wave, 0), id')
    .all(team_id);
  const keyById = new Map(rows.map((r) => [r.id, r.key]));
  const depsByDown = new Map();
  for (const d of db
    .prepare(
      'SELECT upstream, downstream FROM task_deps WHERE graph_id IN (SELECT id FROM graphs WHERE team_id = ?)'
    )
    .all(team_id)) {
    if (!depsByDown.has(d.downstream)) depsByDown.set(d.downstream, []);
    depsByDown.get(d.downstream).push(d.upstream);
  }

  const tasks = rows.map((t) => {
    const payload = parseJson(t.payload) ?? {};
    const p = typeof payload === 'object' && payload !== null ? payload : {};
    const upstreamIds = (depsByDown.get(t.id) ?? []).slice().sort((a, b) => a - b);
    return {
      id: t.id,
      key: t.key,
      graph_id: t.graph_id,
      wave: t.wave,
      title: t.title,
      status: MIRROR_STATUS[t.status] ?? 'failed',
      coordinator_state: t.status,
      subagent_type: p.subagent_type ?? null,
      prompt: p.prompt ?? null,
      depends_on: upstreamIds,
      depends_on_keys: upstreamIds.map((id) => keyById.get(id) ?? String(id)),
      result_file: parseJson(t.result_ref),
    };
  });

  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const t of rows) counts[t.status] = (counts[t.status] ?? 0) + 1;

  return {
    state: {
      team_id: team.id,
      name: team.name,
      status: team.status,
      max_parallel: team.max_parallel,
      created_at: team.created_at,
      updated_at: team.updated_at,
      exported_at: nowSec(),
      source: 'sqlite',
      counts,
    },
    tasks,
  };
}

/**
 * DAG 不变量校验：数据损坏的检测手段（BLOCKER 1 的观测面）。
 *
 * 为什么需要它：重复递减 deps_remaining 造成的损坏是**自洽**的——
 * deps_remaining=0 且 status=ready，从状态本身看不出任何异常。唯一能揭发它的办法是
 * 拿 tasks.deps_remaining 与 task_deps 里真实的未完成上游数对账。
 *
 * 核心不变量：对每个任务，deps_remaining == 「未 done 的上游数」。
 * 附带检查（同源问题的不同表现）：
 *   - deps_remaining=0 但仍是 blocked（该 ready 却没被解锁，会永久卡死）
 *   - deps_remaining>0 却已 ready/running（上游未全完成就被派牌——ready ⟺ 上游全 done 被破坏）
 *   - consumed 标记与上游实际状态不符（边已消费但上游不是 done，或上游 done 而边未消费）
 *
 * @returns {{ ok: boolean, violations: Array<object>, checked: number }}
 */
export function verifyGraphInvariants(db, { graph_id } = {}) {
  requireStr(graph_id, 'graph_id');
  const graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(graph_id);
  if (!graph) {
    throw new CoordinatorError('GRAPH_NOT_FOUND', `graph 不存在: ${graph_id}`, { graph_id });
  }

  const tasks = db
    .prepare('SELECT id, key, status, deps_remaining FROM tasks WHERE graph_id = ? ORDER BY id')
    .all(graph_id);
  const edges = db
    .prepare('SELECT upstream, downstream, consumed FROM task_deps WHERE graph_id = ?')
    .all(graph_id);
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));

  const openUpstream = new Map(tasks.map((t) => [t.id, 0]));
  const violations = [];

  for (const e of edges) {
    const upStatus = statusById.get(e.upstream) ?? null;
    if (upStatus !== 'done') {
      openUpstream.set(e.downstream, (openUpstream.get(e.downstream) ?? 0) + 1);
    }
    // consumed=1 只应出现在上游确实 done 之后；上游 done 则该边应已被消费。
    if (Number(e.consumed) === 1 && upStatus !== 'done') {
      violations.push({
        kind: 'edge-consumed-but-upstream-not-done',
        upstream: e.upstream,
        downstream: e.downstream,
        upstream_status: upStatus,
      });
    }
    if (Number(e.consumed) === 0 && upStatus === 'done') {
      violations.push({
        kind: 'edge-unconsumed-but-upstream-done',
        upstream: e.upstream,
        downstream: e.downstream,
      });
    }
  }

  for (const t of tasks) {
    const expected = openUpstream.get(t.id) ?? 0;
    if (t.deps_remaining !== expected) {
      violations.push({
        kind: 'deps-remaining-mismatch',
        task_id: t.id,
        key: t.key,
        status: t.status,
        deps_remaining: t.deps_remaining,
        expected,
      });
    }
    if (expected > 0 && (t.status === 'ready' || t.status === 'running')) {
      violations.push({
        kind: 'dispatched-with-open-upstream',
        task_id: t.id,
        key: t.key,
        status: t.status,
        open_upstream: expected,
      });
    }
    if (expected === 0 && t.status === 'blocked') {
      violations.push({
        kind: 'blocked-with-no-open-upstream',
        task_id: t.id,
        key: t.key,
      });
    }
  }

  return { ok: violations.length === 0, violations, checked: tasks.length };
}

