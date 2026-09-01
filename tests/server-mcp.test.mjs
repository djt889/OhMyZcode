/**
 * tests/server-mcp.test.mjs
 * 覆盖 mcp/coordinator/server.mjs 的 handleRequest 分发（直接调函数，不起进程）
 * + 一个进程级 stdio smoke：stdout 只允许 JSON-RPC 报文，这是 MCP stdio 的铁律。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { closeDb, openDb } from '../mcp/coordinator/db.mjs';
import { TOOLS, handleRequest, resolveDbPath } from '../mcp/coordinator/server.mjs';

const SERVER_PATH = fileURLToPath(new URL('../mcp/coordinator/server.mjs', import.meta.url));

function freshCtx(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-mcp-'));
  const dbPath = path.join(dir, 'coordinator.sqlite');
  const db = openDb(dbPath);
  t.after(() => {
    closeDb(db);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ctx: { db, dbPath }, dir, dbPath };
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

/** tools/call 的文本载荷解析成对象（MCP 约定 content[0].text 是 JSON 字符串）。 */
function callText(res) {
  assert.equal(res.result.content[0].type, 'text');
  return JSON.parse(res.result.content[0].text);
}

describe('initialize', () => {
  it('返回协议版本与 omz-coordinator 服务标识', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('initialize', {}));
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(typeof res.result.protocolVersion, 'string');
    assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(res.result.serverInfo.name, 'omz-coordinator');
    assert.equal(typeof res.result.serverInfo.version, 'string');
    assert.deepEqual(res.result.capabilities, { tools: {} });
  });
});

describe('tools/list', () => {
  it('返回 13 个工具', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/list', {}));
    assert.equal(res.result.tools.length, 13);
    assert.equal(TOOLS.length, 13);
  });

  it('每个工具都有非空 name / description，且 inputSchema.type 为 object', (t) => {
    const { ctx } = freshCtx(t);
    const { tools } = handleRequest(ctx, rpc('tools/list', {})).result;
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.name.length > 0);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
      assert.ok(tool.inputSchema, `${tool.name} 缺 inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema.type 应为 object`);
    }
  });

  it('工具名唯一且不向外泄漏 handler 字段', (t) => {
    const { ctx } = freshCtx(t);
    const { tools } = handleRequest(ctx, rpc('tools/list', {})).result;
    const names = tools.map((x) => x.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
  });

  it('工具清单覆盖 §7.2 的 11 个 + reclaim_expired + export_mirror', (t) => {
    const { ctx } = freshCtx(t);
    const names = handleRequest(ctx, rpc('tools/list', {})).result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, [
      'omz_dag_submit',
      'omz_export_mirror',
      'omz_mail_ack',
      'omz_mail_receive',
      'omz_mail_send',
      'omz_reclaim_expired',
      'omz_status',
      'omz_task_claim',
      'omz_task_complete',
      'omz_task_fail',
      'omz_task_heartbeat',
      'omz_team_create',
      'omz_team_shutdown'
    ]);
  });
});

/**
 * 时间面纪律（blocker 级缺陷的回归防线）。
 * `now` 是给 core 单元测试注入确定性时间的参数，绝不属于公开工具面：一旦出现在 inputSchema，
 * 任意 worker 调 omz_reclaim_expired({ now: 4000000000 }) 就能把别人正在跑、lease 未过期的任务
 * 判成过期并抢走（原 owner 被清空、任务回 ready），也能顺手绕过 retry_at 退避与 attempts 预算。
 * 因此：① 13 个工具的 schema 里都不得有 now；② handleRequest 在未开 OMZ_TEST_TIME 时必须忽略外部 now。
 */
describe('now 不得出现在对外 MCP 工具面', () => {
  it('tools/list 的全部 13 个工具的 inputSchema.properties 都不含 now', (t) => {
    const { ctx } = freshCtx(t);
    const { tools } = handleRequest(ctx, rpc('tools/list', {})).result;
    assert.equal(tools.length, 13);
    const offenders = tools.filter((x) => Object.prototype.hasOwnProperty.call(x.inputSchema.properties ?? {}, 'now'));
    assert.deepEqual(
      offenders.map((x) => x.name),
      [],
      '暴露 now 等于把调度器时钟交给调用方，可抢走他人未过期的 lease'
    );
  });

  it('任何工具的 required 列表里也不得出现 now', (t) => {
    const { ctx } = freshCtx(t);
    const { tools } = handleRequest(ctx, rpc('tools/list', {})).result;
    for (const tool of tools) {
      assert.equal((tool.inputSchema.required ?? []).includes('now'), false, `${tool.name} 的 required 含 now`);
    }
  });

  it('inputSchema 全树递归扫描都不含名为 now 的属性（含数组 items 的嵌套 schema）', (t) => {
    const { ctx } = freshCtx(t);
    const { tools } = handleRequest(ctx, rpc('tools/list', {})).result;
    const hits = [];
    const walk = (node, trail) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${trail}[${i}]`));
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'now') hits.push(`${trail}.now`);
        walk(v, `${trail}.${k}`);
      }
    };
    for (const tool of tools) walk(tool.inputSchema, tool.name);
    assert.deepEqual(hits, [], 'now 在嵌套 schema 里同样不得出现');
  });

  it('TOOLS 常量与 tools/list 输出对 now 的封堵一致（不留只在导出里的后门）', () => {
    for (const tool of TOOLS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties ?? {}, 'now'),
        false,
        `${tool.name} 的 TOOLS 定义里含 now`
      );
    }
  });

  it('未设 OMZ_TEST_TIME 时 task_claim 传入的 now 被忽略，lease 按服务端时钟计算', (t) => {
    const { ctx } = freshCtx(t);
    const before = Math.floor(Date.now() / 1000);
    const team = callText(handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: { name: 'clock' } })));
    const graph = callText(
      handleRequest(ctx, rpc('tools/call', { name: 'omz_dag_submit', arguments: { team_id: team.team_id, tasks: [{ key: 'A' }] } }))
    );
    // 注入一个 2065 年的时间戳：若被采信，lease_until 会落在 30 亿秒量级
    const claimed = callText(
      handleRequest(
        ctx,
        rpc('tools/call', {
          name: 'omz_task_claim',
          arguments: { graph_id: graph.graph_id, agent_ref: 'w1', lease_seconds: 300, now: 3000000000 }
        })
      )
    );
    const after = Math.floor(Date.now() / 1000);
    assert.ok(claimed.task, '认领应成功');
    assert.ok(
      claimed.task.lease_until >= before + 300 && claimed.task.lease_until <= after + 301,
      `lease_until 必须来自服务端时钟，实际 ${claimed.task.lease_until}（期望 ${before + 300}..${after + 301}）`
    );
    assert.ok(claimed.task.lease_until < 3000000000, '外部注入的未来时间戳被采信即为 blocker 级缺陷');
  });

  it('未设 OMZ_TEST_TIME 时 reclaim_expired 传入未来 now 无法抢走未过期的 lease', (t) => {
    const { ctx } = freshCtx(t);
    const team = callText(handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: { name: 'steal' } })));
    const graph = callText(
      handleRequest(ctx, rpc('tools/call', { name: 'omz_dag_submit', arguments: { team_id: team.team_id, tasks: [{ key: 'A' }] } }))
    );
    const claimed = callText(
      handleRequest(
        ctx,
        rpc('tools/call', { name: 'omz_task_claim', arguments: { graph_id: graph.graph_id, agent_ref: 'victim', lease_seconds: 3600 } })
      )
    );
    assert.ok(claimed.task);

    // 攻击面：把 now 推到远未来，试图把 victim 的任务判成过期
    const reclaimed = callText(
      handleRequest(
        ctx,
        rpc('tools/call', { name: 'omz_reclaim_expired', arguments: { graph_id: graph.graph_id, now: 4000000000 } })
      )
    );
    assert.deepEqual(reclaimed.reclaimed, [], '未过期的 lease 不得被外部 now 判成过期');
    const row = ctx.db.prepare('SELECT status, owner_agent FROM tasks WHERE id = ?').get(claimed.task.id);
    assert.equal(row.status, 'running');
    assert.equal(row.owner_agent, 'victim', '原 owner 不得被清空');
  });

  it('未设 OMZ_TEST_TIME 时 task_fail 的 retry_at 仍按服务端时钟生效（退避不可绕过）', (t) => {
    const { ctx } = freshCtx(t);
    const team = callText(handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: { name: 'backoff' } })));
    const graph = callText(
      handleRequest(
        ctx,
        rpc('tools/call', { name: 'omz_dag_submit', arguments: { team_id: team.team_id, tasks: [{ key: 'A', max_attempts: 5 }] } })
      )
    );
    const claimed = callText(
      handleRequest(ctx, rpc('tools/call', { name: 'omz_task_claim', arguments: { graph_id: graph.graph_id, agent_ref: 'w1' } }))
    );
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    callText(
      handleRequest(
        ctx,
        rpc('tools/call', {
          name: 'omz_task_fail',
          arguments: { task_id: claimed.task.id, agent_ref: 'w1', error: 'x', retry_at: farFuture, now: 4000000000 }
        })
      )
    );
    // retry_at 在一天后：此刻再 claim 必须拿不到任务（否则退避被绕过）
    const again = callText(
      handleRequest(ctx, rpc('tools/call', { name: 'omz_task_claim', arguments: { graph_id: graph.graph_id, agent_ref: 'w2' } }))
    );
    assert.equal(again.task, null, 'retry_at 未到就派牌等于退避被绕过');
  });

  it('server.mjs 源码里明确记录了封 now 的理由（改动者必须看到代价）', () => {
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    assert.match(src, /inputSchema 里都没有 now|所有 inputSchema 里都没有 now/);
    assert.match(src, /OMZ_TEST_TIME/);
    assert.ok(src.includes('nowSec()'), 'MCP 层必须显式改用服务端 nowSec()');
  });
});

describe('tools/call', () => {
  it('正常调用返回 text 型 content 且内容是可解析 JSON', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: { name: 'alpha' } }));
    assert.equal(res.result.isError, undefined);
    const payload = callText(res);
    assert.match(payload.team_id, /^team-[0-9a-f]{8}$/);
    assert.equal(payload.name, 'alpha');
  });

  it('未知工具返回 isError:true 且错误文本含 UNKNOWN_TOOL', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/call', { name: 'omz_does_not_exist', arguments: {} }));
    assert.equal(res.result.isError, true);
    const payload = callText(res);
    assert.equal(payload.error.code, 'UNKNOWN_TOOL');
  });

  it('缺必填参数时返回 isError:true 而不是抛异常崩溃', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: {} }));
    assert.equal(res.result.isError, true);
    assert.equal(callText(res).error.code, 'BAD_ARGS');
  });

  it('业务错误按 code 分支返回（不存在的 team 报 TEAM_NOT_FOUND）', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/call', { name: 'omz_status', arguments: { team_id: 'team-ghost' } }));
    assert.equal(res.result.isError, true);
    assert.equal(callText(res).error.code, 'TEAM_NOT_FOUND');
  });

  it('省略 arguments 时按空参数处理并给出 isError 而非崩溃', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('tools/call', { name: 'omz_dag_submit' }));
    assert.equal(res.result.isError, true);
    assert.equal(typeof callText(res).error.code, 'string');
  });

  it('端到端串联 team_create → dag_submit → task_claim 都走通工具层', (t) => {
    const { ctx } = freshCtx(t);
    const team = callText(handleRequest(ctx, rpc('tools/call', { name: 'omz_team_create', arguments: { name: 'e2e' } })));
    const graph = callText(
      handleRequest(
        ctx,
        rpc('tools/call', {
          name: 'omz_dag_submit',
          arguments: { team_id: team.team_id, tasks: [{ key: 'A' }, { key: 'B' }], deps: [{ from: 'A', to: 'B' }] }
        })
      )
    );
    assert.equal(Object.keys(graph.task_ids).length, 2);
    const claimed = callText(
      handleRequest(
        ctx,
        rpc('tools/call', { name: 'omz_task_claim', arguments: { graph_id: graph.graph_id, agent_ref: 'w1' } })
      )
    );
    assert.equal(claimed.task.key, 'A');
  });
});

describe('JSON-RPC 协议层', () => {
  it('未知方法返回 -32601', (t) => {
    const { ctx } = freshCtx(t);
    const res = handleRequest(ctx, rpc('no/such/method', {}));
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /Method not found/);
  });

  it('jsonrpc 版本或 method 类型不合法时返回 -32600', (t) => {
    const { ctx } = freshCtx(t);
    assert.equal(handleRequest(ctx, { jsonrpc: '1.0', id: 1, method: 'ping' }).error.code, -32600);
    assert.equal(handleRequest(ctx, { jsonrpc: '2.0', id: 1, method: 42 }).error.code, -32600);
  });

  it('notifications/initialized 无响应（返回 null）', (t) => {
    const { ctx } = freshCtx(t);
    assert.equal(handleRequest(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(handleRequest(ctx, { jsonrpc: '2.0', method: 'initialized' }), null);
  });

  it('无 id 的普通请求也被视为通知而不产生响应', (t) => {
    const { ctx } = freshCtx(t);
    assert.equal(handleRequest(ctx, { jsonrpc: '2.0', method: 'ping' }), null);
    assert.equal(handleRequest(ctx, { jsonrpc: '2.0', method: 'no/such' }), null);
  });

  it('ping 返回空结果对象', (t) => {
    const { ctx } = freshCtx(t);
    assert.deepEqual(handleRequest(ctx, rpc('ping', {})).result, {});
  });

  it('响应始终回显请求 id', (t) => {
    const { ctx } = freshCtx(t);
    assert.equal(handleRequest(ctx, rpc('ping', {}, 'abc')).id, 'abc');
    assert.equal(handleRequest(ctx, rpc('ping', {}, 99)).id, 99);
  });
});

describe('resolveDbPath', () => {
  it('--db 参数优先级最高', () => {
    const p = resolveDbPath(['--db', 'C:/tmp/x.sqlite'], {}, 'C:/work');
    assert.equal(path.resolve(p), path.resolve('C:/tmp/x.sqlite'));
  });

  it('支持 --db=<path> 形式', () => {
    const p = resolveDbPath(['--db=C:/tmp/y.sqlite'], {}, 'C:/work');
    assert.equal(path.resolve(p), path.resolve('C:/tmp/y.sqlite'));
  });

  it('无参数时用 OMZ_COORDINATOR_DB 环境变量', () => {
    const p = resolveDbPath([], { OMZ_COORDINATOR_DB: 'C:/tmp/env.sqlite' }, 'C:/work');
    assert.equal(path.resolve(p), path.resolve('C:/tmp/env.sqlite'));
  });

  it('都没有时落到 <cwd>/.omz/runtime/coordinator.sqlite', () => {
    const p = resolveDbPath([], {}, path.join('C:', 'work'));
    assert.equal(p, path.join('C:', 'work', '.omz', 'runtime', 'coordinator.sqlite'));
  });
});

describe('进程级 stdio smoke', () => {
  it('stdout 每一行都是合法 JSON、无任何非 JSON 噪声，非法输入得到 -32700', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-mcp-proc-'));
    const dbPath = path.join(dir, 'coordinator.sqlite');
    t.after(() => {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '{ this is not json'
    ].join('\n') + '\n';

    const r = spawnSync(process.execPath, [SERVER_PATH, '--db', dbPath], {
      input,
      encoding: 'utf8',
      timeout: 30000
    });

    assert.equal(r.status, 0, `server 应正常退出，stderr=${r.stderr}`);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3, `期望 3 行响应，实际 ${lines.length}：${r.stdout}`);

    const parsed = lines.map((line, i) => {
      let obj;
      assert.doesNotThrow(() => {
        obj = JSON.parse(line);
      }, `stdout 第 ${i + 1} 行不是合法 JSON：${line}`);
      assert.equal(obj.jsonrpc, '2.0');
      return obj;
    });

    assert.equal(parsed[0].result.serverInfo.name, 'omz-coordinator');
    assert.equal(parsed[1].result.tools.length, 13);
    assert.equal(parsed[2].error.code, -32700);
    assert.equal(parsed[2].id, null);

    // 诊断信息必须只出现在 stderr，stdout 不得有横幅之类噪声
    assert.match(r.stderr, /omz-coordinator/);
    assert.equal(r.stdout.includes('[omz-coordinator]'), false);
  });

  it('批量请求（数组）逐条回复且仍每行一个 JSON', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-mcp-batch-'));
    const dbPath = path.join(dir, 'coordinator.sqlite');
    t.after(() => {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' }
    ]);
    const r = spawnSync(process.execPath, [SERVER_PATH, '--db', dbPath], {
      input: batch + '\n',
      encoding: 'utf8',
      timeout: 30000
    });
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    // 通知不产生响应，故只应有 2 行
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
  });
});
