#!/usr/bin/env node
/**
 * OMZ coordinator stdio MCP server：手写 JSON-RPC 2.0 over newline-delimited stdin/stdout，零依赖。
 * 铁律：stdout 只允许出现 JSON-RPC 报文，任何诊断/日志一律走 stderr（MCP stdio 传输的硬约束）。
 * 工具错误按 MCP 语义返回 isError 的 tool result，不是 JSON-RPC error——协议层没坏，是业务失败。
 * handleRequest(ctx, req) 导出供测试直接调用，无需真起进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CoordinatorError, closeDb, nowSec, openDb } from './db.mjs';
import * as core from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';

function readVersion() {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(HERE, rel), 'utf8').replace(/^\uFEFF/, ''));
      if (pkg?.version) return String(pkg.version);
    } catch {
      /* 找不到就继续下一个候选 */
    }
  }
  return '0.0.0';
}

const SERVER_INFO = { name: 'omz-coordinator', version: readVersion() };

const S = {
  str: (description) => ({ type: 'string', description }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description) => ({ type: 'boolean', description }),
  obj: (description) => ({ type: 'object', description }),
};

/**
 * 时间面纪律（BLOCKER 3）：`now` 是给 core 单元测试注入时间的参数，**绝不属于公开工具面**。
 * 暴露它等于把调度器的时钟交给调用方：任意 worker 调 omz_reclaim_expired({ now: 4000000000 })
 * 就能把别人正在跑、lease 未过期的任务判成过期并抢走（原 owner 被清空、任务回 ready），
 * 同样也能绕过 retry_at 退避与 attempts 预算。因此：
 *   - 所有 inputSchema 里都没有 now；
 *   - MCP 层调用 core 一律传服务端 nowSec()；
 *   - 只有显式设置 OMZ_TEST_TIME=1 时才接受外部 now，并在 stderr 留一行警告。
 * core.mjs 的函数签名仍保留 now 参数（测试需要确定性时间），封的只是 MCP 入口。
 */
function testTimeAllowed(env = process.env) {
  return env.OMZ_TEST_TIME === '1';
}

function resolveNow(args, env = process.env) {
  if (Number.isInteger(args?.now) && testTimeAllowed(env)) {
    process.stderr.write(
      `[omz-coordinator] WARNING: OMZ_TEST_TIME=1，接受调用方注入的 now=${args.now}（生产环境绝不可开启）\n`
    );
    return args.now;
  }
  return nowSec();
}

/** 时间敏感工具的统一入口：剥掉调用方的 now，换成服务端时钟。 */
const timed = (fn) => (db, a) => fn(db, { ...a, now: resolveNow(a) });

/** 13 个工具：§7.2 的 11 个 + reclaim_expired（I3 lease 回收）+ export_mirror（§7.3 审计镜像）。 */
export const TOOLS = [
  {
    name: 'omz_team_create',
    description: '创建 team，返回稳定 team_id 并写审计事件。',
    inputSchema: {
      type: 'object',
      properties: {
        name: S.str('team 名称'),
        max_parallel: S.int('最大并行成员数', { minimum: 1, default: 4 }),
        metadata: S.obj('任意元数据（JSON）'),
      },
      required: ['name'],
    },
    handler: (db, a) => core.teamCreate(db, a),
  },
  {
    name: 'omz_dag_submit',
    description: '事务写入任务与依赖，返回 graph_id / task_ids / ready 列表。deps 元素 {from,to} 表示 to 依赖 from。',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: S.str('目标 team'),
        tasks: {
          type: 'array',
          description: '任务列表',
          items: {
            type: 'object',
            properties: {
              key: S.str('图内唯一任务键'),
              title: S.str('标题'),
              payload: S.obj('任务载荷（含 subagent_type / prompt 等）'),
              wave: S.int('波次'),
              priority: S.int('优先级，越大越先派', { default: 0 }),
              max_attempts: S.int('最大尝试次数', { minimum: 1, default: 3 }),
            },
            required: ['key'],
          },
        },
        deps: {
          type: 'array',
          description: '依赖边列表',
          items: {
            type: 'object',
            properties: { from: S.str('上游 key'), to: S.str('下游 key（依赖 from）') },
            required: ['from', 'to'],
          },
        },
      },
      required: ['team_id', 'tasks'],
    },
    handler: (db, a) => core.dagSubmit(db, a),
  },
  {
    name: 'omz_task_claim',
    description: 'BEGIN IMMEDIATE 单事务认领一个 ready 任务；返回 task 或 null。team 非 active、或 running 数已达 max_parallel 时返回 null 并给出 reason。',
    inputSchema: {
      type: 'object',
      properties: {
        graph_id: S.str('图 id'),
        agent_ref: S.str('认领者引用'),
        lease_seconds: S.int('租约秒数', { minimum: 1, default: 300 }),
      },
      required: ['graph_id', 'agent_ref'],
    },
    handler: timed(core.taskClaim),
  },
  {
    name: 'omz_task_heartbeat',
    description: '仅 owner 可延长 lease；任务终态时报 BAD_ARGS。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: S.int('任务 id'),
        agent_ref: S.str('owner 引用'),
        extend_seconds: S.int('延长秒数', { minimum: 1, default: 300 }),
      },
      required: ['task_id', 'agent_ref'],
    },
    handler: timed(core.taskHeartbeat),
  },
  {
    name: 'omz_task_complete',
    description: '校验 owner 后置 done，并原子递减下游 deps_remaining（每条依赖边只消费一次）；任务已终态或幂等键命中时返回 duplicate。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: S.int('任务 id'),
        agent_ref: S.str('owner 引用'),
        result_ref: S.str('结果引用（如 results/T-003.json）'),
        idempotency_key: S.str('幂等键（at-least-once 必需；与该 task_id 绑定）'),
      },
      required: ['task_id', 'agent_ref'],
    },
    handler: timed(core.taskComplete),
  },
  {
    name: 'omz_task_fail',
    description: '仅 running 任务的 owner 可上报；按重试预算回 ready 或进 dead-letter。终态任务返回 duplicate。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: S.int('任务 id'),
        agent_ref: S.str('owner 引用'),
        error: S.str('错误摘要'),
        retry_at: S.int('最早重试时间（unix 秒）'),
        idempotency_key: S.str('幂等键（与该 task_id 绑定）'),
      },
      required: ['task_id', 'agent_ref'],
    },
    handler: timed(core.taskFail),
  },
  {
    name: 'omz_mail_send',
    description: 'dedupe_key 唯一的 at-least-once 投递；重复 key 返回既有消息 + duplicate。',
    inputSchema: {
      type: 'object',
      properties: {
        to_agent: S.str('收件 agent'),
        from_agent: S.str('发件 agent'),
        task_id: S.int('关联任务 id'),
        payload: S.obj('消息载荷'),
        dedupe_key: S.str('去重键'),
        team_id: S.str('所属 team'),
      },
      required: ['to_agent', 'dedupe_key'],
    },
    handler: timed(core.mailSend),
  },
  {
    name: 'omz_mail_receive',
    description: '按 seq 升序拉取未 ack 消息（只读，不自动 ack）。',
    inputSchema: {
      type: 'object',
      properties: { agent_ref: S.str('收件 agent'), limit: S.int('条数上限', { minimum: 1, default: 10 }) },
      required: ['agent_ref'],
    },
    handler: (db, a) => core.mailReceive(db, a),
  },
  {
    name: 'omz_mail_ack',
    description: '幂等确认；非收件人报 NOT_OWNER，已 ack 返回 duplicate。',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: S.int('消息 id'),
        agent_ref: S.str('收件 agent'),
      },
      required: ['message_id', 'agent_ref'],
    },
    handler: timed(core.mailAck),
  },
  {
    name: 'omz_status',
    description: '返回 team/agents/tasks/mailbox/events 汇总；transport_state 与 coordinator_state 分开呈现（I3）。',
    inputSchema: {
      type: 'object',
      properties: { team_id: S.str('team id'), event_limit: S.int('事件条数', { minimum: 1, default: 20 }) },
      required: ['team_id'],
    },
    handler: (db, a) => core.status(db, a),
  },
  {
    name: 'omz_team_shutdown',
    description: '标记终态并拒绝新 claim；非 force 且仍有 running 时转 draining。',
    inputSchema: {
      type: 'object',
      properties: { team_id: S.str('team id'), force: S.bool('强制把未完成任务标 failed') },
      required: ['team_id'],
    },
    handler: (db, a) => core.teamShutdown(db, a),
  },
  {
    name: 'omz_reclaim_expired',
    description: '回收 lease 过期的 running 任务（回 ready 或 dead），并把原 owner 的 transport_state 置 unknown。过期判定一律用服务端时间。',
    inputSchema: {
      type: 'object',
      properties: { graph_id: S.str('限定某图，省略则全库') },
      required: [],
    },
    handler: timed(core.reclaimExpired),
  },
  {
    name: 'omz_export_mirror',
    description: '导出 DESIGN §7.3 形态的 JSON 审计镜像（SQLite 是唯一事实源，JSON 只是镜像）。',
    inputSchema: {
      type: 'object',
      properties: { team_id: S.str('team id') },
      required: ['team_id'],
    },
    handler: (db, a) => core.exportMirror(db, a),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function toolListPayload() {
  return {
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
}

function errPayload(err) {
  if (err instanceof CoordinatorError) {
    return { error: { code: err.code, message: err.message, detail: err.detail } };
  }
  return { error: { code: 'INTERNAL', message: err?.message ?? String(err), detail: null } };
}

/** 纯函数式请求分发：ctx 只需 { db }。通知（无 id）返回 null，调用方不写 stdout。 */
export function handleRequest(ctx, req) {
  const isNotification = req?.id === undefined || req?.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: req.id, result });
  const fail = (code, message, data) =>
    isNotification ? null : { jsonrpc: '2.0', id: req.id ?? null, error: { code, message, data } };

  if (req?.jsonrpc !== '2.0' || typeof req?.method !== 'string') {
    return fail(-32600, 'Invalid Request');
  }

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply(toolListPayload());
    case 'tools/call': {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const tool = TOOL_MAP.get(name);
      if (!tool) {
        return reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: { code: 'UNKNOWN_TOOL', message: `未知工具: ${name}`, detail: null } },
                null,
                2
              ),
            },
          ],
          isError: true,
        });
      }
      try {
        const result = tool.handler(ctx.db, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return reply({
          content: [{ type: 'text', text: JSON.stringify(errPayload(err), null, 2) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

/** 数据库落点优先级：--db 参数 > OMZ_COORDINATOR_DB > <cwd>/.omz/runtime/coordinator.sqlite。 */
export function resolveDbPath(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const i = argv.indexOf('--db');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  for (const a of argv) {
    if (a.startsWith('--db=')) return path.resolve(a.slice(5));
  }
  if (env.OMZ_COORDINATOR_DB) return path.resolve(env.OMZ_COORDINATOR_DB);
  return path.join(cwd, '.omz', 'runtime', 'coordinator.sqlite');
}

function main() {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  const ctx = { db, dbPath };
  process.stderr.write(`[omz-coordinator] db=${dbPath} started_at=${nowSec()}\n`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (msg) => {
    if (msg) process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    let req;
    try {
      req = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // 批量请求：数组逐条处理，逐条回复（MCP 客户端极少使用，但便宜就支持）。
    if (Array.isArray(req)) {
      for (const r of req) send(handleRequest(ctx, r));
      return;
    }
    try {
      send(handleRequest(ctx, req));
    } catch (err) {
      // 兜底：分发层意外异常也不能污染 stdout 的 JSON-RPC 语法。
      process.stderr.write(`[omz-coordinator] internal: ${err?.stack ?? err}\n`);
      if (req?.id !== undefined && req?.id !== null) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'Internal error' } });
      }
    }
  });

  rl.on('close', () => {
    closeDb(db);
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
