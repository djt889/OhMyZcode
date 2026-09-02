#!/usr/bin/env node
/**
 * OMZ dashboard 服务端：loopback-only HTTP + SSE 只读状态面板
 * （DESIGN §1.5 本土化结论第 4 条 / §3.1 展示层 / §3.3 dashboard profile / §13.5 I5 / §15.3）。
 *
 * I5 防护逐条落点（本文件按**代码结构**切分为七条，每条给出真实函数落点；与 DESIGN §13.5 I5 的
 * 六道切分是同一组防护的不同粒度，对照见下方「与 DESIGN §13.5 I5 的切分差异」）：
 *   1. 只绑 loopback：listen() 里 server.listen(port, host)，host 默认 127.0.0.1，绝不 0.0.0.0；
 *      isLoopbackRequest() 在看 token 之前判来源，非 loopback 直接 403 并 destroy socket。
 *   2. 随机端口：createServer 的 port 默认 0，由系统分配，不使用固定端口。
 *   3. 每次启动随机 token：token 未显式给出时 crypto.randomBytes(24)（createServer 里的 authToken）；
 *      比较走 safeEqual() 的 timingSafeEqual（恒定时间；长度不等先判 false）。
 *   4. CORS 白名单只含 http://127.0.0.1:<本服务端口> 与 http://localhost:<本服务端口>（checkOrigin()
 *      + originsFor()）；无 Origin 头（同源 fetch/EventSource/curl）放行，其它一律 403。请求行目标
 *      另经 checkRequestTarget() 收紧：absolute-form 必须命中同一白名单，否则 400。
 *   5. SSE 只发结构化 JSON 快照事件：handleSse() 只 send 'snapshot'/'heartbeat'，sseEncode() 只编码
 *      JSON；不透传任何原始终端流或命令通道。
 *   6. CSP default-src 'none' + script-src 'self'（SECURITY_HEADERS，经 writeHead() 挂在每个响应上，
 *      含 404/405），禁 inline script；HTML 转义责任在 renderer 的 textContent。
 *   7. 只读：全部端点是 GET，任何其它方法 405（下面请求流水线的 ③）；没有任何写入或命令执行端点，
 *      本文件不 import child_process。
 *
 * 与 DESIGN §13.5 I5 的切分差异（两处条数不同但覆盖同一组防护，不是漂移，别再当漂移报一次）：
 *   · DESIGN 数**六道**，把上面的 2 与 3 合并成一条「随机端口 + 每次启动随机 token」。本文件按实现
 *     拆开：它们在代码里是两段独立逻辑（listen() 的 port 参数 vs createServer 里的 authToken），
 *     各有各的落点，合写会让注释与代码结构脱节。tests/dashboard.test.mjs 的文件头同此七条切分，
 *     并给出逐条到用例名的对照表（含唯一缺口：第 4 条的 absolute-form/400 分支目前无用例）。
 *   · **两份清单都不含 preload**：原七道里的第七道「preload 只暴露最小 contextBridge API」已随
 *     dashboard/preload.mjs 一起删除（sandbox: true 与 .mjs preload 互斥、renderer 零引用、删除不减少
 *     保护面），是**一条无法验证的承诺被撤下**而非一道防护失效；理由见 DESIGN §13.5 I5 与
 *     dashboard/README.md「为什么 Electron 壳不需要 preload」。本文件的第 7 条是「只读」，与 preload 无关。
 *   · 下方请求流水线里的圈号是**执行顺序**标记（① 来源门 → ①bis 请求行 → ② CORS → ③ 只读 →
 *     ④ 公开路径 → ⑤ token 门），与本清单的 1–7 编号无对应关系，不要按序号互相套。
 *
 * 鉴权分层（为什么静态壳不要 token）：
 *   浏览器只会把 token 带在首个地址栏请求上（?token=），随后对 <link href="/app.css"> 与
 *   <script src="/app.js"> 的子资源请求是浏览器自己发的，**不携带任何 token**。若把静态壳放在
 *   token 门之后，则默认路径（token 自动生成）下 CSS/JS 必然 401，页面无样式无脚本 → 面板不可用。
 *   因此分两层：
 *     · 静态壳（/、/index.html、/app.js、/app.css）——**免 token**。它们是编译期固定的空壳，
 *       不含任何任务、路径、token 或项目信息（全部数据由 renderer 再发 /api/* 取得），
 *       且仍受 loopback + CORS + 只读 GET + absolute-form host 白名单四重约束。
 *     · 数据端点（/api/snapshot、/api/events）——**必须 token**。它们才是唯一泄露路径与任务内容的面。
 *     · /healthz——免 token，但只回 { ok, source }：不含 degraded 细节、不含任何绝对路径，
 *       并带 HEALTHZ_TTL_MS 结果缓存，杜绝免鉴权端点被当作全量快照的 CPU 放大器。
 *
 * 故障隔离（§15.3-5）：coordinator SQLite 缺失或打不开一律回退到 tools/render-status.mjs 的
 * .omz/ 文件视图并在 degraded[] 说明原因，绝不返回 500——展示失效不得阻断调度。
 * I3 硬约束：transport_state（agents 表）与 coordinator_state（tasks.status）是两个独立维度，
 * 本层只做搬运与并列，绝不互推、绝不合并成单一「状态」字段。
 * 零第三方依赖：node:http 手写路由，不引 express。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from '../mcp/coordinator/db.mjs';
import { status as coordinatorStatus, exportMirror } from '../mcp/coordinator/core.mjs';
import { collectStatus } from '../tools/render-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(HERE, 'renderer');

// 静态资源严格白名单：只有这三个文件可被读出，任何其它 path 直接 404（杜绝路径穿越）。
// 导出供测试做「PUBLIC_PATHS 必须由 STATIC_FILES 派生」的同源断言（见 tests/dashboard.test.mjs）。
export const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }]
]);

export const SSE_POLL_MS = 1500;
export const SSE_HEARTBEAT_MS = 15000;
const EVENT_LIMIT = 40;
/** 同时在线的 SSE 连接上限；超限返回 503 + Retry-After，避免无界 Set 被拖成资源放大面。 */
export const MAX_SSE_STREAMS = 8;
/** /healthz 结果缓存 TTL：免鉴权端点不得每次请求都跑全量快照。 */
export const HEALTHZ_TTL_MS = 1000;
/** Last-Event-ID / ?since= 的合理上界：超过即视为污染输入并忽略（从 0 开始）。 */
export const MAX_EVENT_ID = 2 ** 31 - 1;

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

// ---------------------------------------------------------------- 安全原语

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * 来源是否 loopback。覆盖三种 Node 可能给出的 remoteAddress 形态：
 *   127.0.0.0/8 明文、::1、以及 IPv4-mapped 的 ::ffff:127.x.x.x。
 * 判定失败（remoteAddress 为空/未知）按拒绝处理——宁可拒绝也不放开监听面。
 */
export function isLoopbackRequest(req) {
  const raw = req?.socket?.remoteAddress;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  // 去掉 IPv6 link-local 的 zone id（fe80::1%eth0）后再比对。
  let addr = raw.split('%')[0];
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1];
  return LOOPBACK_V4.test(addr);
}

/** 恒定时间 token 比较。长度不等直接 false——timingSafeEqual 长度不等会抛，且长度本身不是秘密。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 取并校验 token：Authorization: Bearer <token> 优先，其次 ?token=。
 * query 通道是为 EventSource 保留的（浏览器 EventSource 无法设自定义头），取舍见 renderer/app.js 注释。
 */
export function checkToken(req, token) {
  if (!token) return true; // 未启用 token 的显式调用方（测试）不强制
  const header = req?.headers?.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && safeEqual(m[1], token)) return true;
  }
  const q = parseUrl(req).searchParams.get('token');
  return typeof q === 'string' ? safeEqual(q, token) : false;
}

/** CORS 白名单：只允许本服务自身端口的 127.0.0.1 / localhost 两个 origin；无 Origin 头放行。 */
export function checkOrigin(req, allowedOrigins) {
  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  return allowedOrigins.includes(origin);
}

export function originsFor(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** 解析 URL。base 固定占位符：只用 pathname/searchParams，不用 host。 */
function parseUrl(req) {
  return new URL(req?.url ?? '/', 'http://127.0.0.1');
}

/**
 * 请求行目标校验（RFC 9112 request-target）。
 * origin-form（`GET /app.js`）恒放行；absolute-form（`GET http://evil.com/app.js`）必须
 * 命中本服务自身的 origin 白名单，否则 400——否则「精确白名单」的表述与实现不一致
 * （旧实现只取 pathname，任何 host 都会被当成本机请求）。
 * authority-form / asterisk-form 与非 http(s) scheme 一律拒绝。
 */
export function checkRequestTarget(req, port) {
  const raw = typeof req?.url === 'string' ? req.url : '/';
  if (raw.startsWith('/')) return true;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  return originsFor(port).includes(`${u.protocol}//${u.host}`);
}

// ---------------------------------------------------------------- 状态快照

/** coordinator db 默认落点，与 mcp/coordinator/server.mjs 的 resolveDbPath 末级保持一致。 */
export function defaultDbPath(projectRoot) {
  return path.join(projectRoot, '.omz', 'runtime', 'coordinator.sqlite');
}

/**
 * 把 tools/render-status.mjs 的文本行反解成结构化 teams/tasks。
 * 这是 core profile 的回退视图：文件层没有 transport 维度，故 transport_state 恒为 null，
 * 绝不用 coordinator_state 反推（I3）。
 *
 * 注意本视图产出的状态取值域与 coordinator 不同：它来自 §7.3 的四态
 * （pending | running | done | failed）外加 render-status 对 JSON 解析失败标注的 corrupt，
 * 以及原始文件里缺 status 时的 '?'。renderer 的状态白名单（renderer/app.js 的 STATES）
 * 必须同时覆盖 coordinator 的 7 态与这里的 pending/corrupt，否则会把「待执行」和
 * 「文件损坏」都显示成「不可判定」。
 */
export function parseFileView(lines) {
  const teams = [];
  const tasks = [];
  const notes = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('[team] ')) {
      current = { id: line.slice(7).trim(), name: line.slice(7).trim(), status: 'file-view', max_parallel: null, counts: {} };
      teams.push(current);
      continue;
    }
    if (line.startsWith('  wave | task |')) continue; // 表头
    if (line.startsWith('  ') && line.includes(' | ')) {
      const parts = line.trim().split(' | ');
      const [wave, id, st, ...rest] = parts;
      const task = {
        team_id: current ? current.id : null,
        id,
        key: id,
        wave: wave === '?' ? null : Number.isNaN(Number(wave)) ? wave : Number(wave),
        title: rest.join(' | ') || null,
        owner_agent: null,
        attempts: null,
        transport_state: null, // 文件视图无传输维度
        coordinator_state: st
      };
      tasks.push(task);
      if (current) current.counts[st] = (current.counts[st] ?? 0) + 1;
      continue;
    }
    notes.push(line);
  }
  return { teams, tasks, notes };
}

/** 打开只读 db；成功返回句柄，失败返回 null + 原因（调用方据此回退，不抛 500）。 */
function tryOpenReadonly(dbPath) {
  if (!dbPath) return { db: null, error: 'db 未配置' };
  if (!fs.existsSync(dbPath)) return { db: null, error: `db 不存在: ${dbPath}` };
  try {
    return { db: openDb(dbPath, { readonly: true }), error: null };
  } catch (err) {
    return { db: null, error: `db 打开失败: ${err?.message ?? String(err)}` };
  }
}

/**
 * 建「status() 的 task 行 → exportMirror() 的镜像行」解析器。
 *
 * 为什么关联键必须是数字 task id：tasks 的唯一约束是 UNIQUE(graph_id, key)，即
 * **key 只在图内唯一**。同一 team 提交两个图并复用同名 key 时，按 key 关联会把第二个图的
 * title/depends_on 贴到第一个图的任务上（跨图串行）。数字 id 是 tasks 表主键，全库唯一。
 *
 * 三档策略（mcp/coordinator 的 exportMirror 正在并行演进，输出可能加上数字 id）：
 *   1. 镜像提供数字 id（t.task_id 或数字型 t.id）→ 按 id 关联，key 只作显示。**首选。**
 *   2. 镜像只有字符串 id（= key，历史形态）但本 team 内 key 互不重复 → 按 key 关联。
 *      此时 key→行是双射，关联结果可证明正确，没必要牺牲 title。
 *   3. 镜像只有字符串 id 且存在重名 key → 对**重名的那些 key** 退化为不关联（title/depends_on
 *      留空 + degraded 说明），其余 key 仍正常关联。绝不按 key 猜——错误关联比缺字段更有害，
 *      它会把审计数据静默串到另一个图上。
 *
 * 返回 { lookup(row) → 镜像行|undefined, mode: 'id'|'key'|'partial', ambiguous: string[] }。
 */
export function buildMirrorIndex(mirrorTasks) {
  const rows = Array.isArray(mirrorTasks) ? mirrorTasks.filter((t) => t && typeof t === 'object') : [];
  const numericId = (t) =>
    Number.isInteger(t.task_id) ? t.task_id : Number.isInteger(t.id) ? t.id : null;

  // 档 1：全部行都能给出数字 id 才算成立（部分给出说明结构不一致，不冒险混用）。
  if (rows.length > 0 && rows.every((t) => numericId(t) !== null)) {
    const byId = new Map(rows.map((t) => [numericId(t), t]));
    return {
      mode: 'id',
      ambiguous: [],
      lookup: (row) => (Number.isInteger(row?.id) ? byId.get(row.id) : undefined)
    };
  }

  // 档 2/3：只能用 key，先找出重名。
  const byKey = new Map();
  const dup = new Set();
  for (const t of rows) {
    const k = typeof t.id === 'string' ? t.id : typeof t.key === 'string' ? t.key : null;
    if (k === null) continue;
    if (byKey.has(k)) dup.add(k);
    else byKey.set(k, t);
  }
  for (const k of dup) byKey.delete(k);
  return {
    mode: dup.size > 0 ? 'partial' : 'key',
    ambiguous: [...dup].sort(),
    lookup: (row) => (typeof row?.key === 'string' ? byKey.get(row.key) : undefined)
  };
}

function coordinatorSnapshot(db, degraded) {
  const teamRows = db.prepare('SELECT id FROM teams ORDER BY created_at, id').all();
  const teams = [];
  const tasks = [];
  const agents = [];
  const events = [];
  let pending = 0;
  const byAgent = {};
  for (const { id } of teamRows) {
    const s = coordinatorStatus(db, { team_id: id, event_limit: EVENT_LIMIT });
    // status() 的 task 行不含 title/depends_on（它是调度视图）；exportMirror() 是审计镜像视图。
    let mirror = { lookup: () => undefined, mode: 'none', ambiguous: [] };
    try {
      const m = exportMirror(db, { team_id: id });
      mirror = buildMirrorIndex(m?.tasks);
    } catch {
      /* 镜像导出失败只丢 title/依赖，不影响主视图 */
    }
    if (mirror.ambiguous.length > 0 && Array.isArray(degraded)) {
      degraded.push({
        component: 'mirror',
        reason:
          `审计镜像未提供数字 task id，且 team ${id} 内存在跨图重名 key（${mirror.ambiguous.join(', ')}）` +
          '：无法安全关联（key 仅图内唯一，按 key 关联会跨图串行）',
        fallback: '重名 key 的 title/depends_on/result_file 留空'
      });
    }
    teams.push({
      id: s.team.id,
      name: s.team.name,
      status: s.team.status,
      max_parallel: s.team.max_parallel,
      counts: s.tasks.counts
    });
    for (const t of s.tasks.list) {
      const mt = mirror.lookup(t);
      // depends_on 走人可读的 key（§7.3 的镜像形态）：镜像的 depends_on 是数字上游 id，
      // depends_on_keys 才是 key 列表。旧版镜像只有 depends_on（当时装的是 key）——两种都兼容。
      const deps = Array.isArray(mt?.depends_on_keys) ? mt.depends_on_keys : mt?.depends_on ?? [];
      tasks.push({
        team_id: id,
        ...t,
        title: mt?.title ?? null,
        depends_on: deps,
        result_file: mt?.result_file ?? null
      });
    }
    for (const a of s.agents) agents.push({ team_id: id, ...a });
    for (const e of s.events) events.push({ team_id: id, ...e });
    pending += s.mailbox.pending;
    for (const [k, v] of Object.entries(s.mailbox.by_agent)) byAgent[k] = (byAgent[k] ?? 0) + v;
  }
  events.sort((a, b) => b.id - a.id);
  return {
    teams,
    tasks,
    agents,
    mailbox: { pending, by_agent: byAgent },
    events: events.slice(0, EVENT_LIMIT)
  };
}

/**
 * 统一状态快照。双轨数据源：coordinator SQLite 优先，任何失败回退 .omz/ 文件视图。
 * 返回的字符串字段一律原样（不做 HTML 转义）——转义是 renderer textContent 的责任（I5），
 * 服务端提前转义会把 &lt; 之类污染进审计数据。
 */
export function collectSnapshot({ projectRoot, dbPath = null } = {}) {
  const root = path.resolve(projectRoot ?? process.cwd());
  const resolvedDb = dbPath === null ? defaultDbPath(root) : dbPath;
  const degraded = [];
  const generated_at = new Date().toISOString();

  const { db, error } = tryOpenReadonly(resolvedDb);
  if (db) {
    try {
      const body = coordinatorSnapshot(db, degraded);
      return { source: 'coordinator', generated_at, db_path: resolvedDb, project_root: root, ...body, degraded };
    } catch (err) {
      degraded.push({
        component: 'coordinator',
        reason: `状态查询失败: ${err?.code ?? ''} ${err?.message ?? String(err)}`.trim(),
        fallback: '.omz/ 文件视图'
      });
    } finally {
      closeDb(db);
    }
  } else {
    degraded.push({ component: 'coordinator', reason: error, fallback: '.omz/ 文件视图' });
  }

  const lines = collectStatus(path.join(root, '.omz'));
  const { teams, tasks, notes } = parseFileView(lines);
  return {
    source: 'files',
    generated_at,
    db_path: resolvedDb,
    project_root: root,
    teams,
    tasks,
    agents: [],
    mailbox: { pending: 0, by_agent: {} },
    events: [],
    notes,
    degraded
  };
}

// ---------------------------------------------------------------- SSE 编码

/**
 * 标准 SSE 帧。协议要求：data 的每一行都要独立带 `data: ` 前缀，
 * 否则含换行的 payload 会被解析成帧结束并截断。CR 一律归一为 LF。
 * 帧以空行结束。
 */
export function sseEncode(event, data, id) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
  let out = '';
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  for (const l of lines) out += `data: ${l}\n`;
  return out + '\n';
}

// ---------------------------------------------------------------- 响应工具

function writeHead(res, code, extra = {}) {
  res.writeHead(code, { ...SECURITY_HEADERS, ...extra });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  writeHead(res, code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, code, text) {
  writeHead(res, code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/**
 * 静态资源：只按 pathname 精确查白名单表，从不用请求串拼路径。
 * 因此 `/api/../../package.json`、`/..%2fpackage.json` 等都只是「不在表里的 key」→ 404，
 * 路径穿越在结构上不可能发生（没有任何 path.join(用户输入)）。
 */
function sendStatic(res, pathname) {
  const hit = STATIC_FILES.get(pathname);
  if (!hit) return false;
  let body;
  try {
    body = fs.readFileSync(path.join(RENDERER_DIR, hit.file));
  } catch {
    sendText(res, 404, 'not found');
    return true;
  }
  writeHead(res, 200, {
    'Content-Type': hit.type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------- 鉴权判定

/**
 * 免 token 的公开路径集合 = 静态壳（STATIC_FILES 的键）+ /healthz。
 * 由 STATIC_FILES 派生而非另抄一份，避免两处清单漂移。
 * 判据不是「方便」而是「这些响应里没有任何数据」：
 *   · 静态壳是编译期固定字节，浏览器子资源请求本就带不上 token（见文件头「鉴权分层」）；
 *   · /healthz 已裁剪为 { ok, source }，无路径、无 degraded 细节。
 * 任何会吐出任务/路径/事件内容的端点都不得进这个集合。
 */
export const PUBLIC_PATHS = new Set([...STATIC_FILES.keys(), '/healthz']);

/** 'ok' | 'missing'（完全未带凭据 → 401）| 'bad'（带了但不对 → 403）。 */
export function authResult(req, token) {
  if (!token) return 'ok';
  const hasHeader = typeof req?.headers?.authorization === 'string' && req.headers.authorization.length > 0;
  const hasQuery = parseUrl(req).searchParams.has('token');
  if (!hasHeader && !hasQuery) return 'missing';
  return checkToken(req, token) ? 'ok' : 'bad';
}

/**
 * 续接游标解析：Last-Event-ID / ?since= 是**客户端可控输入**，只用于该连接的局部计数起点。
 * 非有限值、非整数、负数、0 或超过 MAX_EVENT_ID 一律忽略并从 0 开始——
 * 旧实现把它写回服务器全局 eventId，传 Number.MAX_SAFE_INTEGER 会让 `+1` 失去精度，
 * 于是所有客户端的所有帧 id 都被钉死在同一个值上。
 */
export function parseEventCursor(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 0;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_EVENT_ID) return 0;
  return n;
}

// ---------------------------------------------------------------- 服务器

/**
 * 创建 loopback-only 只读服务。
 * port=0 → 系统分配随机端口（I5）；token 未给 → 每次启动新的 24 字节随机 token（I5）。
 */
export function createServer({
  projectRoot = process.cwd(),
  dbPath = null,
  token = null,
  host = '127.0.0.1',
  port = 0,
  pollMs = SSE_POLL_MS,
  heartbeatMs = SSE_HEARTBEAT_MS
} = {}) {
  const root = path.resolve(projectRoot);
  const authToken = token === null ? crypto.randomBytes(24).toString('hex') : token;
  /**
   * 活跃 SSE 订阅者。所有连接共用**一个**轮询器（sharedTimer）广播同一份快照，
   * 因此 CPU 成本与连接数解耦：8 条连接与 1 条连接的 collectSnapshot 调用频率完全相同。
   * 最后一个订阅者断开时停掉共享定时器（无泄漏）。
   */
  const streams = new Set();
  let sharedPollTimer = null;
  let sharedBeatTimer = null;
  let sharedLastPayload = '';

  const server = http.createServer((req, res) => {
    // ① 来源优先于凭据：非 loopback 不给任何信息，直接 403 + 断开。
    if (!isLoopbackRequest(req)) {
      try {
        writeHead(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden: loopback only');
      } finally {
        req.socket.destroy();
      }
      return;
    }

    const url = parseUrl(req);
    const pathname = url.pathname;
    const boundPort = server.address()?.port ?? port;
    const allowed = originsFor(boundPort);

    // ①bis 请求行目标白名单：absolute-form 必须指向本服务自身的 host:port（MINOR 7）。
    if (!checkRequestTarget(req, boundPort)) {
      sendText(res, 400, 'bad request: unsupported request-target');
      return;
    }

    // ② CORS 白名单。
    if (!checkOrigin(req, allowed)) {
      sendText(res, 403, 'forbidden: origin not allowed');
      return;
    }
    const originHeader = req.headers.origin;
    // 白名单命中才回显 ACAO；用 setHeader 预置，之后所有 writeHead 都会带上（Node 会合并）。
    if (typeof originHeader === 'string' && allowed.includes(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }

    // ③ 只读契约：任何非 GET 一律 405，不存在写入/命令执行入口（I5）。
    if (req.method !== 'GET') {
      writeHead(res, 405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed: dashboard is read-only');
      return;
    }

    // ④ 公开路径先于 token 门（BLOCKER 1 / I10）：浏览器对 /app.css、/app.js 的子资源请求不带
    //    token，放在 token 门后会导致默认配置下页面无样式无脚本。见文件头「鉴权分层」。
    //
    //    这里**直接**用 PUBLIC_PATHS 判定，不再另写一份 `STATIC_FILES.has(...) || pathname === '/healthz'`：
    //    曾经导出的 PUBLIC_PATHS 只是文档性常量，真正放行的是流水线里的第二份判断，两者可以任意漂移
    //    而无人发现（把 /api/snapshot 加进 PUBLIC_PATHS 不会有任何测试变红）。现在放行面与导出的
    //    集合是同一个对象，任何对 PUBLIC_PATHS 的改动都立刻改变真实鉴权行为，可被测试抓住。
    if (PUBLIC_PATHS.has(pathname)) {
      // 静态壳：编译期固定字节，无任务/路径/token 信息。
      if (sendStatic(res, pathname)) return;
      // 其余公开路径只有 /healthz：只回 { ok, source }，不含 degraded 细节、不含任何绝对路径；
      // 并带 TTL 缓存，避免被当成免鉴权的全量快照放大器。
      sendJson(res, 200, healthz());
      return;
    }

    // ⑤ 数据端点（/api/*）：必须 token。这里才是唯一会吐出路径与任务内容的面。
    //    （圈号是流水线执行顺序，与文件头 I5 清单的 1–7 无关；此前写作 ⑥ 而序列里没有 ⑤，
    //     看着像有一步被删过——实际没有，故补顺。）
    const auth = authResult(req, authToken);
    if (auth === 'missing') {
      writeHead(res, 401, {
        'WWW-Authenticate': 'Bearer realm="omz-dashboard"',
        'Content-Type': 'text/plain; charset=utf-8'
      });
      res.end('unauthorized: token required');
      return;
    }
    if (auth === 'bad') {
      sendText(res, 403, 'forbidden: bad token');
      return;
    }

    if (pathname === '/api/snapshot') {
      sendJson(res, 200, collectSnapshot({ projectRoot: root, dbPath }));
      return;
    }

    if (pathname === '/api/events') {
      // SSE 连接数上限：streams 曾是无界 Set，60 条连接会被全部接受。超限即 503 + Retry-After。
      if (streams.size >= MAX_SSE_STREAMS) {
        writeHead(res, 503, {
          'Retry-After': '5',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(`service unavailable: too many SSE streams (max ${MAX_SSE_STREAMS})`);
        return;
      }
      handleSse(req, res, { since: url.searchParams.get('since') });
      return;
    }

    sendText(res, 404, 'not found');
  });

  // ---- /healthz 缓存：免鉴权端点不得每次请求都触发全量快照（2000 任务库上约 65ms/次）。
  let healthCache = null;
  function healthz() {
    const now = Date.now();
    if (healthCache && now - healthCache.at < HEALTHZ_TTL_MS) return healthCache.body;
    const snap = collectSnapshot({ projectRoot: root, dbPath });
    // 只回 ok/source：degraded 的 reason 里含 db 绝对路径，属于需 token 的信息（见 /api/snapshot）。
    const body = { ok: true, source: snap.source };
    healthCache = { at: now, body };
    return body;
  }

  // ---- 共享快照缓存 + 单一轮询器（所有 SSE 订阅者共用，CPU 与连接数解耦）
  let snapCache = null; // { at, snap, payload }

  function refreshSnapshot() {
    const snap = collectSnapshot({ projectRoot: root, dbPath });
    // generated_at 每次都变，比较时剔除，否则「只在变化时推」会退化为每轮都推。
    const { generated_at, ...stable } = snap;
    snapCache = { at: Date.now(), snap, payload: JSON.stringify(stable) };
    return snapCache;
  }

  /** 新订阅者的首帧：一个轮询周期内复用共享快照，避免 N 个连接触发 N 次全量采集。 */
  function cachedSnapshot() {
    if (snapCache && Date.now() - snapCache.at < pollMs) return snapCache;
    return refreshSnapshot();
  }

  function broadcast(event, data) {
    for (const sub of [...streams]) sub.send(event, data);
  }

  function startShared() {
    if (sharedPollTimer) return;
    sharedPollTimer = setInterval(() => {
      const c = refreshSnapshot();
      if (c.payload === sharedLastPayload) return;
      sharedLastPayload = c.payload;
      broadcast('snapshot', c.snap);
    }, pollMs);
    sharedBeatTimer = setInterval(() => broadcast('heartbeat', { at: new Date().toISOString() }), heartbeatMs);
    // 定时器不应把进程钉住：dashboard 是展示层，不得延长宿主进程生命周期（§15.3）。
    sharedPollTimer.unref?.();
    sharedBeatTimer.unref?.();
  }

  /** 最后一个订阅者断开即停共享定时器：不留悬挂 interval（close() 后进程可自然退出）。 */
  function stopShared() {
    if (sharedPollTimer) clearInterval(sharedPollTimer);
    if (sharedBeatTimer) clearInterval(sharedBeatTimer);
    sharedPollTimer = null;
    sharedBeatTimer = null;
    sharedLastPayload = '';
  }

  /**
   * SSE：单一共享轮询器广播快照（仅在序列化结果变化时推）+ 共享心跳。
   * 帧 id 是**每连接局部**计数：Last-Event-ID / ?since= 只影响本连接的起点，
   * 绝不写回服务器全局状态（旧实现被 Number.MAX_SAFE_INTEGER 污染后所有客户端的 id 全部钉死）。
   * 续接语义 = 下一帧即最新全量，不做历史回放——只读面板不需要事件重放，也避免在内存里存历史。
   * 清理：close/error/aborted 任一触发即出集合；集合空则停共享定时器，无泄漏。
   */
  function handleSse(req, res, { since } = {}) {
    // 客户端可控输入：只做本连接的起点，且经上界/类型校验（非法一律从 0 开始）。
    let localId = parseEventCursor(req.headers['last-event-id'] ?? since ?? '');
    let closed = false;

    writeHead(res, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // 建议客户端重连间隔；EventSource 原生按此值退避。
    res.write('retry: 2000\n\n');

    const sub = {
      send(event, data) {
        if (closed) return;
        localId += 1;
        try {
          res.write(sseEncode(event, data, localId));
        } catch {
          cleanup(); // 写失败等价于连接已断
        }
      },
      cleanup: () => cleanup()
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      streams.delete(sub);
      if (streams.size === 0) stopShared();
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    }

    streams.add(sub);
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    startShared();
    // 首帧立即给一次（复用共享快照），客户端不必等一个轮询周期。
    // 只有「第一个订阅者」才把它登记为共享基线：否则后来者的加入会覆盖基线，
    // 让已在线订阅者错过这一次变化。
    const c = cachedSnapshot();
    if (sharedLastPayload === '') sharedLastPayload = c.payload;
    sub.send('snapshot', c.snap);
  }

  return {
    server,
    token: authToken,
    get port() {
      return server.address()?.port ?? null;
    },
    /** 仅用于测试/诊断：当前在线 SSE 订阅者数量与共享定时器是否存活。 */
    get sseStats() {
      return { streams: streams.size, sharedTimer: sharedPollTimer !== null };
    },
    urlOf(pathname = '/') {
      const p = server.address()?.port;
      return `http://${host}:${p ?? port}${pathname}${pathname.includes('?') ? '&' : '?'}token=${authToken}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // 只绑 loopback：host 默认 127.0.0.1，绝不 0.0.0.0（I5）。
        server.listen(port, host, () => resolve(server.address()?.port));
      });
    },
    close() {
      for (const h of [...streams]) h.cleanup();
      stopShared();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const out = { projectRoot: process.cwd(), dbPath: null, port: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) out.projectRoot = argv[(i += 1)];
    else if (a === '--db' && argv[i + 1]) out.dbPath = argv[(i += 1)];
    else if (a === '--port' && argv[i + 1]) out.port = Number.parseInt(argv[(i += 1)], 10) || 0;
  }
  return out;
}

/** 启动横幅一律走 stderr：stdout 留给可被管道消费的结构化输出，且 URL 含 token 不应污染管道。 */
export function bannerLines(handle, projectRoot) {
  return [
    '[omz-dashboard] 已启动（只读状态面板）',
    `[omz-dashboard] project=${projectRoot}`,
    `[omz-dashboard] url=${handle.urlOf('/')}`,
    '[omz-dashboard] 仅本机可访问：服务只绑定 127.0.0.1，非 loopback 请求一律 403；端口随机、token 每次启动重新生成。',
    '[omz-dashboard] 只读：所有端点均为 GET，无任何写入或命令执行入口。Ctrl+C 退出。'
  ];
}

// isMain 判定必须用 fileURLToPath：new URL(...).pathname 是 **percent-encoded** 的，
// 插件目录含空格或非 ASCII（Windows 极常见：C:\Program Files\、C:\Users\张三\）时
// pathname 里是 %20 / %E5%BC%A0，与 process.argv[1] 的真实路径永不相等 → isMain 恒 false，
// `node dashboard/server.mjs` 会静默 exit 0 什么都不做。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const handle = createServer({ projectRoot: args.projectRoot, dbPath: args.dbPath, port: args.port });
  handle.listen().then(
    () => {
      for (const l of bannerLines(handle, path.resolve(args.projectRoot))) process.stderr.write(l + '\n');
      // 有活跃 SSE 时定时器已 unref，靠 server 句柄保持进程存活；关闭 server 即可自然退出。
      const bye = () => {
        process.stderr.write('[omz-dashboard] 收到 SIGINT，正在优雅关闭…\n');
        handle.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
    },
    (err) => {
      process.stderr.write(`[omz-dashboard] 启动失败: ${err?.message ?? String(err)}\n`);
      process.exit(1);
    }
  );
}
