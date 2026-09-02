/**
 * tests/dashboard.test.mjs
 * 覆盖 dashboard/server.mjs 的 I5 防护，按 server.mjs 文件头的**七条代码结构切分**组织：
 *   loopback / 随机端口 / 随机 token / CORS / SSE / CSP / 只读
 * + 双轨数据源（coordinator SQLite 优先、失败回退 .omz/ 文件视图）
 * + renderer 静态资产的无注入面断言。
 *
 * 逐条到用例的对照（避免"注释承诺了但没有用例"——preload 那道的原罪正是这个）：
 *   1. loopback      → describe('isLoopbackRequest') 5 例 + describe('请求流水线：loopback 门（I5-1）') 3 例
 *   2. 随机端口      → it('端口由系统分配（非 0 且 urlOf 带 token）') 断言 port > 0
 *   3. 随机 token    → 同上例断言 token.length >= 32；+ describe('checkToken / safeEqual / authResult') 5 例
 *                      + 真实 HTTP 的 401/403/200 三例
 *   4. CORS 白名单   → describe('checkOrigin / originsFor') 3 例 + it('外部 Origin 的请求返回 403')
 *                      ⚠️ **缺口**：server.mjs 第 4 条还含 checkRequestTarget() 的 absolute-form→400 分支
 *                      （请求流水线 ①bis），本文件**没有**对应用例。这里如实记着，不当已覆盖论。
 *   5. SSE 结构化    → describe('sseEncode') 6 例 + describe('SSE 真实连接') 断言 event: snapshot 且 data 可 JSON.parse
 *   6. CSP           → it('安全头齐全：CSP default-src none + script-src self…') + it('404 与 405 响应同样带全套安全头')
 *   7. 只读          → it('POST 请求返回 405 且带 Allow: GET（只读契约）') + it('DELETE / PUT 同样返回 405')
 *
 * 与 DESIGN §13.5 I5 的切分差异（条数不同但覆盖同一组防护，不是漂移）：
 *   · DESIGN 数**六道**，把「随机端口」与「随机 token」合为一条；本文件与 server.mjs 文件头把二者
 *     分列（端口来自 listen 的 port=0，token 来自 createServer 的 randomBytes(24)，断言也是分开的：
 *     见上表第 2、3 条）。
 *   · **本文件的七条不含 preload**：原七道里的第七道「preload 只暴露最小 contextBridge API」已随
 *     dashboard/preload.mjs 一起删除（sandbox: true 与 .mjs preload 互斥、renderer 零引用、删除不减少
 *     保护面），因此没有可断言的对象；本文件第七条是「只读」（405 用例）。详见 DESIGN §13.5 I5。
 *
 * 端口一律用 0；每个真起服务的用例在 t.after 里 close()。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  MAX_EVENT_ID,
  MAX_SSE_STREAMS,
  PUBLIC_PATHS,
  SECURITY_HEADERS,
  STATIC_FILES,
  authResult,
  checkOrigin,
  checkToken,
  collectSnapshot,
  createServer,
  defaultDbPath,
  isLoopbackRequest,
  originsFor,
  parseArgs,
  parseEventCursor,
  parseFileView,
  safeEqual,
  sseEncode,
  bannerLines
} from '../dashboard/server.mjs';
import { closeDb, openDb } from '../mcp/coordinator/db.mjs';
import { dagSubmit, taskClaim, teamCreate } from '../mcp/coordinator/core.mjs';

const RENDERER_DIR = fileURLToPath(new URL('../dashboard/renderer/', import.meta.url));

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-dash-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function makeRoot() {
  seq += 1;
  const root = path.join(TMP, `proj-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 构造最小假 req：只需 socket.remoteAddress / headers / url。 */
function fakeReq({ remoteAddress = '127.0.0.1', headers = {}, url = '/' } = {}) {
  return { socket: { remoteAddress }, headers, url };
}

/** token: '' 表示显式不启用鉴权（token === null 会触发随机 token 生成）。 */
const NO_TOKEN = '';

/** 起服务并注册清理；返回 handle 与 base URL。 */
async function startServer(t, options = {}) {
  const handle = createServer({ port: 0, ...options });
  const port = await handle.listen();
  t.after(async () => {
    await handle.close();
  });
  return { handle, port, base: `http://127.0.0.1:${port}` };
}

/** 最小 HTTP GET 客户端（避免 fetch 的 keep-alive 句柄拖住测试进程）。 */
function get(urlStr, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function request(urlStr, method, { headers = {} } = {}) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('isLoopbackRequest', () => {
  it('127.0.0.1 与 127.0.0.0/8 内的地址判为 loopback', () => {
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '127.0.0.1' })), true);
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '127.0.0.53' })), true);
  });

  it('IPv6 ::1 与 IPv4-mapped ::ffff:127.0.0.1 判为 loopback', () => {
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::1' })), true);
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::ffff:127.0.0.1' })), true);
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '0:0:0:0:0:0:0:1' })), true);
  });

  it('局域网地址一律判为非 loopback', () => {
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '192.168.1.5' })), false);
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '10.0.0.1' })), false);
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::ffff:192.168.1.5' })), false);
  });

  it('地址为空或未知时按拒绝处理（不放开监听面）', () => {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '' }, headers: {}, url: '/' }), false);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: undefined }, headers: {}, url: '/' }), false);
    assert.equal(isLoopbackRequest({ socket: {} }), false);
    assert.equal(isLoopbackRequest({}), false);
    assert.equal(isLoopbackRequest(undefined), false);
  });

  it('带 zone id 的 IPv6 loopback 仍被识别', () => {
    assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::1%lo0' })), true);
  });
});

describe('checkToken / safeEqual / authResult', () => {
  const TOKEN = 'a'.repeat(48);

  it('Authorization: Bearer 头携带正确 token 时通过', () => {
    assert.equal(checkToken(fakeReq({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN), true);
  });

  it('query 参数 ?token= 携带正确 token 时通过（EventSource 通道）', () => {
    assert.equal(checkToken(fakeReq({ url: `/api/events?token=${TOKEN}` }), TOKEN), true);
  });

  it('错误 token 一律拒绝', () => {
    assert.equal(checkToken(fakeReq({ headers: { authorization: `Bearer ${'b'.repeat(48)}` } }), TOKEN), false);
    assert.equal(checkToken(fakeReq({ url: `/api/snapshot?token=${'b'.repeat(48)}` }), TOKEN), false);
  });

  it('长度不同的 token 比较时不抛（timingSafeEqual 长度陷阱已处理）', () => {
    assert.doesNotThrow(() => checkToken(fakeReq({ headers: { authorization: 'Bearer short' } }), TOKEN));
    assert.equal(checkToken(fakeReq({ headers: { authorization: 'Bearer short' } }), TOKEN), false);
    assert.equal(safeEqual('abc', 'abcdef'), false);
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual(null, 'abc'), false);
  });

  it('完全未带凭据判为 missing，带了但不对判为 bad，正确判为 ok', () => {
    assert.equal(authResult(fakeReq({}), TOKEN), 'missing');
    assert.equal(authResult(fakeReq({ headers: { authorization: 'Bearer wrong' } }), TOKEN), 'bad');
    assert.equal(authResult(fakeReq({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN), 'ok');
  });
});

describe('checkOrigin / originsFor', () => {
  it('无 Origin 头（同源 fetch / curl）放行', () => {
    assert.equal(checkOrigin(fakeReq({}), originsFor(1234)), true);
    assert.equal(checkOrigin(fakeReq({ headers: { origin: '' } }), originsFor(1234)), true);
  });

  it('本机白名单里的 origin 放行', () => {
    const allowed = originsFor(1234);
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://127.0.0.1:1234' } }), allowed), true);
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://localhost:1234' } }), allowed), true);
  });

  it('外部 origin 一律拒绝，端口不匹配也拒绝', () => {
    const allowed = originsFor(1234);
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://evil.example' } }), allowed), false);
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://127.0.0.1:9999' } }), allowed), false);
  });
});

describe('sseEncode', () => {
  it('多行 data 的每一行都带独立的 data: 前缀', () => {
    const out = sseEncode('snapshot', 'line1\nline2\nline3', 7);
    const dataLines = out.split('\n').filter((l) => l.startsWith('data: '));
    assert.deepEqual(dataLines, ['data: line1', 'data: line2', 'data: line3']);
  });

  it('输出含 id: 与 event: 行', () => {
    const out = sseEncode('heartbeat', { at: 'x' }, 42);
    assert.ok(out.startsWith('id: 42\n'));
    assert.ok(out.includes('event: heartbeat\n'));
  });

  it('帧以空行结束', () => {
    assert.ok(sseEncode('e', 'a', 1).endsWith('\n\n'));
  });

  it('CRLF 被归一为 LF，不产生空的 data 行', () => {
    const out = sseEncode('e', 'a\r\nb', 1);
    const dataLines = out.split('\n').filter((l) => l.startsWith('data:'));
    assert.deepEqual(dataLines, ['data: a', 'data: b']);
  });

  it('对象型 data 被序列化为单行 JSON', () => {
    const out = sseEncode('snapshot', { a: 1, b: [1, 2] }, 1);
    assert.ok(out.includes('data: {"a":1,"b":[1,2]}'));
  });

  it('省略 id 时不输出 id 行', () => {
    assert.equal(sseEncode('e', 'x').includes('id:'), false);
  });
});

describe('真实 HTTP 端点', () => {
  it('未带 token 访问受保护端点返回 401', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: 'tok-123456' });
    const res = await get(`${base}/api/snapshot`);
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'], /Bearer/);
  });

  it('带错误 token 返回 403', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: 'tok-123456' });
    const res = await get(`${base}/api/snapshot?token=wrong`);
    assert.equal(res.status, 403);
  });

  it('带正确 token 返回 200 与 JSON 快照', async (t) => {
    const root = makeRoot();
    const { base } = await startServer(t, { projectRoot: root, token: 'tok-123456' });
    const res = await get(`${base}/api/snapshot`, { headers: { authorization: 'Bearer tok-123456' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.project_root, path.resolve(root));
    assert.ok(Array.isArray(body.tasks));
  });

  it('/healthz 免 token 即可访问', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: 'tok-123456' });
    const res = await get(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.source, 'string');
  });

  it('POST 请求返回 405 且带 Allow: GET（只读契约）', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: 'tok-123456' });
    const res = await request(`${base}/api/snapshot`, 'POST', { headers: { authorization: 'Bearer tok-123456' } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  });

  it('DELETE / PUT 同样返回 405', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const res = await request(`${base}/`, method);
      assert.equal(res.status, 405, `${method} 应被拒绝`);
    }
  });

  it('路径穿越尝试与其编码变体都返回 404', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    for (const p of ['/api/../../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/renderer/app.js']) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 404, `${p} 应 404`);
      assert.equal(res.body.includes('"name": "omz"'), false, `${p} 不得泄漏仓库文件内容`);
    }
  });

  it('未知路径返回 404', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    assert.equal((await get(`${base}/nope`)).status, 404);
  });

  it('外部 Origin 的请求返回 403', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    const res = await get(`${base}/api/snapshot`, { headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });

  it('安全头齐全：CSP default-src none + script-src self、nosniff、no-referrer、DENY', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    const res = await get(`${base}/api/snapshot`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('404 与 405 响应同样带全套安全头', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    for (const res of [await get(`${base}/nope`), await request(`${base}/`, 'POST')]) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(res.headers[k.toLowerCase()], v, `${k} 缺失`);
      }
    }
  });

  it('静态资源 / 与 /app.js 与 /app.css 均可取到且 Content-Type 正确', async (t) => {
    const { base } = await startServer(t, { projectRoot: makeRoot(), token: NO_TOKEN });
    const html = await get(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    const js = await get(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const css = await get(`${base}/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });

  it('端口由系统分配（非 0 且 urlOf 带 token）', async (t) => {
    const { handle, port } = await startServer(t, { projectRoot: makeRoot() });
    assert.ok(port > 0);
    assert.equal(handle.port, port);
    assert.ok(handle.token.length >= 32, '默认应生成随机 token');
    assert.ok(handle.urlOf('/').includes(`token=${handle.token}`));
  });
});

// I10-A 代码层同源：PUBLIC_PATHS 必须由 STATIC_FILES 派生，且是流水线唯一放行依据。
describe('I10 鉴权分层：PUBLIC_PATHS 同源性', () => {
  it('PUBLIC_PATHS 严格等于 STATIC_FILES 的键集合加 /healthz（不得手写、不得漂移）', () => {
    const expected = new Set([...STATIC_FILES.keys(), '/healthz']);
    assert.deepEqual(
      [...PUBLIC_PATHS].sort(),
      [...expected].sort(),
      'PUBLIC_PATHS 与 STATIC_FILES∪{/healthz} 不一致：有人往免鉴权集合里加/减了路径'
    );
  });

  it('PUBLIC_PATHS 里不含任何 /api/ 前缀路径（数据面永不免鉴权）', () => {
    for (const p of PUBLIC_PATHS) {
      assert.equal(p.startsWith('/api/'), false, `${p} 是数据端点，不得进免 token 集合`);
    }
    assert.equal(PUBLIC_PATHS.has('/api/snapshot'), false);
    assert.equal(PUBLIC_PATHS.has('/api/events'), false);
  });

  it('PUBLIC_PATHS 成员只有静态壳与 /healthz 两类（无第三类数据面混入）', () => {
    for (const p of PUBLIC_PATHS) {
      assert.ok(STATIC_FILES.has(p) || p === '/healthz', `${p} 既非静态壳也非 /healthz`);
    }
  });
});

// I10-B 行为层：必须在 **token 非空**（默认自动生成）的服务上跑。
// 旧用例一律用 token: '' 起服务，鉴权整体关闭 → 分层是否正确根本无法被观测，
// 把静态壳搬到 token 门之后也全过。以下用例是这条缺陷的唯一防线。
describe('I10 鉴权分层：token 非空服务上的真实放行面', () => {
  it('真实浏览器序列：带 token 取 / 得 200，随后不带任何凭据取 /app.js、/app.css 也得 200', async (t) => {
    const { handle, base } = await startServer(t, { projectRoot: makeRoot() });
    assert.ok(handle.token.length >= 32, '本用例必须跑在 token 非空的服务上');

    // ① 地址栏首个请求带 token（浏览器唯一会带上 token 的一跳）
    const shell = await get(`${base}/?token=${handle.token}`);
    assert.equal(shell.status, 200, '带 token 的 / 应 200');
    assert.match(shell.headers['content-type'], /text\/html/);

    // ② 浏览器自己发的子资源请求不携带任何凭据——若静态壳在 token 门之后，这里必然 401
    for (const [p, typeRe] of [['/app.js', /javascript/], ['/app.css', /text\/css/]]) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 200, `${p} 无凭据子资源请求应 200，实际 ${res.status}（面板会无样式无脚本）`);
      assert.match(res.headers['content-type'], typeRe);
    }
  });

  it('PUBLIC_PATHS 中每个路径不带 token 都返回 200（遍历断言，不硬编码路径列表）', async (t) => {
    const { handle, base } = await startServer(t, { projectRoot: makeRoot() });
    assert.ok(handle.token.length >= 32, '本用例必须跑在 token 非空的服务上');
    assert.ok(PUBLIC_PATHS.size >= 2, 'PUBLIC_PATHS 不应为空');
    for (const p of PUBLIC_PATHS) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 200, `${p} 在 PUBLIC_PATHS 里，无 token 应 200，实际 ${res.status}`);
    }
  });

  it('/api/snapshot 与 /api/events 在 token 非空服务上：无凭据 401、错 token 403、正确 token 200', async (t) => {
    const { handle, base } = await startServer(t, {
      projectRoot: makeRoot(),
      pollMs: 50,
      heartbeatMs: 60000
    });
    assert.ok(handle.token.length >= 32, '本用例必须跑在 token 非空的服务上');

    for (const p of ['/api/snapshot', '/api/events']) {
      const none = await get(`${base}${p}`);
      assert.equal(none.status, 401, `${p} 无凭据应 401，实际 ${none.status}`);
      assert.match(none.headers['www-authenticate'], /Bearer/);

      const bad = await get(`${base}${p}?token=wrong-token`);
      assert.equal(bad.status, 403, `${p} 错 token 应 403，实际 ${bad.status}`);
    }

    const okSnap = await get(`${base}/api/snapshot?token=${handle.token}`);
    assert.equal(okSnap.status, 200);
    assert.ok(Array.isArray(JSON.parse(okSnap.body).tasks));

    // /api/events 是长连接，取到响应头即可判定放行，随后立刻断开。
    const eventsStatus = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/events?token=${handle.token}`, { agent: false }, (res) => {
        req.destroy();
        resolve(res.statusCode);
      });
      req.on('error', (err) => {
        if (!/socket hang up|aborted|ECONNRESET/i.test(String(err.message))) reject(err);
      });
      setTimeout(() => reject(new Error('/api/events 响应超时')), 8000).unref();
    });
    assert.equal(eventsStatus, 200, '正确 token 的 /api/events 应 200');
  });

  it('token 非空时，不在 PUBLIC_PATHS 的未知路径无凭据仍走 token 门（401 而非 404）', async (t) => {
    const { handle, base } = await startServer(t, { projectRoot: makeRoot() });
    assert.ok(handle.token.length >= 32);
    // /renderer/app.js 不在白名单：它必须先被 token 门挡住，不得因「像静态资源」而被放行。
    for (const p of ['/nope', '/renderer/app.js', '/index.html/../api/snapshot']) {
      const res = await get(`${base}${p}`);
      assert.equal(res.status, 401, `${p} 不在 PUBLIC_PATHS，无凭据应 401，实际 ${res.status}`);
    }
  });
});

/**
 * 以下三组是本轮变异抽查新发现的「零防线」补齐（原先删掉实现全仓 541 用例无一变红）：
 *   · loopback 门：只有 isLoopbackRequest 的纯函数单测，请求流水线里那道门没人测；
 *   · MAX_SSE_STREAMS：常量导出但连接上限从未被真实连接触发；
 *   · parseEventCursor：函数从未被任何测试导入。
 */
describe('请求流水线：loopback 门（I5-1）', () => {
  /** 最小假 res：收集 writeHead/end，供直接向 server 派发请求用。 */
  function fakeRes() {
    const rec = { status: null, headers: {}, body: '', ended: false };
    return {
      rec,
      setHeader(k, v) {
        rec.headers[k.toLowerCase()] = v;
      },
      writeHead(code, headers = {}) {
        rec.status = code;
        for (const [k, v] of Object.entries(headers)) rec.headers[k.toLowerCase()] = v;
      },
      end(chunk) {
        if (chunk) rec.body += chunk;
        rec.ended = true;
      },
      write(chunk) {
        rec.body += String(chunk);
      },
      on() {}
    };
  }

  /**
   * 直接向 server 派发请求（不经 socket）。原因：服务只绑 127.0.0.1，
   * 真实客户端的 remoteAddress 永远是 loopback，非 loopback 分支无法用 HTTP 触发；
   * 而这道门是「来源优先于凭据」的第一道防护，必须有可失败断言。
   */
  function dispatch(handle, req) {
    const res = fakeRes();
    handle.server.emit('request', req, res);
    return res.rec;
  }

  it('非 loopback 来源在看 token 之前就被 403 并销毁 socket', async (t) => {
    const { handle } = await startServer(t, { projectRoot: makeRoot() });
    let destroyed = false;
    const rec = dispatch(handle, {
      method: 'GET',
      url: `/api/snapshot?token=${handle.token}`, // 凭据正确也不该被看一眼
      headers: {},
      socket: { remoteAddress: '192.168.1.5', destroy: () => { destroyed = true; } }
    });
    assert.equal(rec.status, 403, `非 loopback 来源应 403，实际 ${rec.status}`);
    assert.match(rec.body, /loopback/);
    assert.equal(destroyed, true, '非 loopback 连接应被 destroy');
  });

  it('同一路径来自 loopback 时正常放行（证明上一条不是被别的门挡住的）', async (t) => {
    const { handle } = await startServer(t, { projectRoot: makeRoot() });
    const rec = dispatch(handle, {
      method: 'GET',
      url: `/api/snapshot?token=${handle.token}`,
      headers: {},
      socket: { remoteAddress: '127.0.0.1', destroy: () => {} }
    });
    assert.equal(rec.status, 200, `loopback + 正确 token 应 200，实际 ${rec.status}`);
  });

  it('remoteAddress 缺失时按拒绝处理（不因未知来源放开监听面）', async (t) => {
    const { handle } = await startServer(t, { projectRoot: makeRoot() });
    const rec = dispatch(handle, {
      method: 'GET',
      url: '/healthz',
      headers: {},
      socket: { remoteAddress: undefined, destroy: () => {} }
    });
    assert.equal(rec.status, 403);
  });
});

describe('SSE 连接上限（MAX_SSE_STREAMS）', () => {
  it('在线连接达到上限后新连接返回 503 + Retry-After，未超限时正常放行', async (t) => {
    const { handle, base } = await startServer(t, {
      projectRoot: makeRoot(),
      token: NO_TOKEN,
      pollMs: 2000,
      heartbeatMs: 60000
    });
    const open = [];
    t.after(() => {
      for (const req of open) req.destroy();
    });

    /** 建一条 SSE 连接并在收到首帧后 resolve（此时它已进 streams 集合）。 */
    const connect = () =>
      new Promise((resolve, reject) => {
        const req = http.get(`${base}/api/events`, { agent: false }, (res) => {
          res.setEncoding('utf8');
          res.once('data', () => resolve(res.statusCode));
          res.on('error', () => {});
          if (res.statusCode !== 200) {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(res.statusCode));
          }
        });
        open.push(req);
        req.on('error', (err) => {
          if (!/socket hang up|aborted|ECONNRESET/i.test(String(err.message))) reject(err);
        });
        setTimeout(() => reject(new Error('SSE 连接超时')), 8000).unref();
      });

    for (let i = 0; i < MAX_SSE_STREAMS; i += 1) {
      assert.equal(await connect(), 200, `第 ${i + 1} 条连接未超限，应 200`);
    }
    assert.equal(handle.sseStats.streams, MAX_SSE_STREAMS, '在线连接数应等于上限');

    const over = await get(`${base}/api/events`);
    assert.equal(over.status, 503, `超限连接应 503，实际 ${over.status}（streams 又变成无界集合了）`);
    assert.equal(over.headers['retry-after'], '5');
    assert.match(over.body, new RegExp(String(MAX_SSE_STREAMS)));
  });
});

describe('parseEventCursor（Last-Event-ID / ?since= 的污染输入校验）', () => {
  it('合法正整数原样返回', () => {
    assert.equal(parseEventCursor('7'), 7);
    assert.equal(parseEventCursor(42), 42);
    assert.equal(parseEventCursor(String(MAX_EVENT_ID)), MAX_EVENT_ID);
  });

  it('超过 MAX_EVENT_ID 的值被归零（否则 +1 失去精度，全客户端帧 id 被钉死）', () => {
    assert.equal(parseEventCursor(String(MAX_EVENT_ID + 1)), 0);
    assert.equal(parseEventCursor(String(Number.MAX_SAFE_INTEGER)), 0);
    assert.equal(parseEventCursor('99999999999999999999'), 0);
  });

  it('0、负数、小数、非数字、空值一律归零', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', '', '  ', '1e3', '0x10', null, undefined, {}, []]) {
      assert.equal(parseEventCursor(raw), 0, `${JSON.stringify(raw)} 应被归零`);
    }
  });
});

describe('数据源与回退', () => {
  it('无 coordinator db 时 /api/snapshot 返回 200 且 source 为 files（不 500）', async (t) => {
    const root = makeRoot();
    const { base } = await startServer(t, { projectRoot: root, token: NO_TOKEN });
    const res = await get(`${base}/api/snapshot`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source, 'files');
    assert.equal(body.degraded.length >= 1, true);
    assert.match(body.degraded[0].reason, /db/);
  });

  it('coordinator db 存在时 source 为 coordinator，且 task 行有两个独立状态字段', async (t) => {
    const root = makeRoot();
    const dbPath = path.join(root, '.omz', 'runtime', 'coordinator.sqlite');
    const db = openDb(dbPath);
    const team = teamCreate(db, { name: 'dash-team' });
    const graph = dagSubmit(db, {
      team_id: team.team_id,
      tasks: [{ key: 'A', title: '甲', wave: 1 }, { key: 'B', title: '乙', wave: 2 }],
      deps: [{ from: 'A', to: 'B' }]
    });
    taskClaim(db, { graph_id: graph.graph_id, agent_ref: 'w1', lease_seconds: 300 });
    closeDb(db);
    t.after(() => {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    });

    const { base } = await startServer(t, { projectRoot: root, token: NO_TOKEN });
    const res = await get(`${base}/api/snapshot`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source, 'coordinator');
    assert.deepEqual(body.degraded, []);
    assert.equal(body.teams.length, 1);
    assert.equal(body.tasks.length, 2);
    const running = body.tasks.find((x) => x.key === 'A');
    assert.equal(running.transport_state, 'running');
    assert.equal(running.coordinator_state, 'running');
    const blocked = body.tasks.find((x) => x.key === 'B');
    assert.equal(blocked.transport_state, null);
    assert.equal(blocked.coordinator_state, 'blocked');
    assert.deepEqual(blocked.depends_on, ['A']);
    assert.equal(blocked.title, '乙');
  });

  it('指向不可读的 db 路径时回退文件视图并在 degraded 说明原因', () => {
    const root = makeRoot();
    const snap = collectSnapshot({ projectRoot: root, dbPath: path.join(root, 'nope', 'x.sqlite') });
    assert.equal(snap.source, 'files');
    assert.equal(snap.degraded.length, 1);
    assert.match(snap.degraded[0].reason, /不存在/);
    assert.equal(snap.degraded[0].fallback, '.omz/ 文件视图');
  });

  it('文件视图能反解 .omz/ 下的 team 与 task 行', () => {
    const root = makeRoot();
    const tasksDir = path.join(root, '.omz', 'runtime', 'team-file', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'T-001.json'),
      JSON.stringify({ id: 'T-001', wave: 1, status: 'done', title: '文件视图任务' }) + '\n',
      'utf8'
    );
    const snap = collectSnapshot({ projectRoot: root, dbPath: path.join(root, 'no-db.sqlite') });
    assert.equal(snap.source, 'files');
    assert.equal(snap.teams.length, 1);
    assert.equal(snap.teams[0].id, 'team-file');
    const task = snap.tasks.find((x) => x.key === 'T-001');
    assert.ok(task, '应解析出 T-001 行');
    assert.equal(task.coordinator_state, 'done');
    assert.equal(task.transport_state, null, '文件视图无传输维度，不得由调度态反推');
  });

  it('parseFileView 把表头跳过、非表格行归入 notes', () => {
    const parsed = parseFileView([
      '[boulder] active_goal=g1 status=active',
      '[team] team-x',
      '  wave | task | status | title',
      '  1 | T-1 | ready | 甲',
      '[plan] p.md'
    ]);
    assert.equal(parsed.teams.length, 1);
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.tasks[0].wave, 1);
    assert.equal(parsed.tasks[0].coordinator_state, 'ready');
    assert.deepEqual(parsed.notes, ['[boulder] active_goal=g1 status=active', '[plan] p.md']);
  });

  it('defaultDbPath 落在 <root>/.omz/runtime/coordinator.sqlite', () => {
    assert.equal(defaultDbPath(path.join('C:', 'p')), path.join('C:', 'p', '.omz', 'runtime', 'coordinator.sqlite'));
  });
});

describe('SSE 真实连接', () => {
  it('拿到 text/event-stream 且首帧格式合法，destroy 后服务可正常关闭', async (t) => {
    const root = makeRoot();
    const handle = createServer({ projectRoot: root, token: NO_TOKEN, port: 0, pollMs: 50, heartbeatMs: 60000 });
    const port = await handle.listen();
    let closed = false;
    t.after(async () => {
      if (!closed) await handle.close();
    });

    const frame = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/events`, { agent: false }, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        assert.equal(res.headers['cache-control'], 'no-store');
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('\n\n') && buf.includes('data: ')) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on('error', () => {
          /* destroy 触发的错误可忽略 */
        });
      });
      req.on('error', (err) => {
        if (!/socket hang up|aborted|ECONNRESET/i.test(String(err.message))) reject(err);
      });
      setTimeout(() => reject(new Error('SSE 首帧超时')), 8000).unref();
    });

    assert.match(frame, /retry: \d+/);
    assert.match(frame, /event: snapshot/);
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(dataLine, 'SSE 帧应含 data: 行');
    assert.doesNotThrow(() => JSON.parse(dataLine.slice('data: '.length)));

    await handle.close();
    closed = true;
    // close() 后不应再有本服务的 server 句柄挂着；给事件循环一拍收尾
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handle.port, null, 'close() 后 server 不应再有绑定端口');
  });

  it('SSE 连接期间 close() 后进程能自行退出（无残留句柄钉住事件循环）', (t) => {
    // 直接在本进程断言句柄数不可靠：SSE 的定时器已 unref，getActiveResourcesInfo 看不到它们。
    // 真正要防的回归是「dashboard 把宿主进程钉住」，因此用子进程验证：
    // 起服务 → 连 SSE → close() → 脚本自然跑到底。若有句柄泄漏，进程挂住、spawnSync 超时。
    const script = path.join(TMP, 'sse-exit-probe.mjs');
    const serverUrl = new URL('../dashboard/server.mjs', import.meta.url).href;
    const projectRoot = makeRoot();
    fs.writeFileSync(
      script,
      [
        `import http from 'node:http';`,
        `const { createServer } = await import(${JSON.stringify(serverUrl)});`,
        `const handle = createServer({ projectRoot: ${JSON.stringify(projectRoot)}, token: '', port: 0, pollMs: 30, heartbeatMs: 30 });`,
        `const port = await handle.listen();`,
        `await new Promise((resolve, reject) => {`,
        `  const req = http.get('http://127.0.0.1:' + port + '/api/events', { agent: false }, (res) => {`,
        `    res.setEncoding('utf8');`,
        `    res.once('data', () => { req.destroy(); resolve(); });`,
        `    res.on('error', () => resolve());`,
        `  });`,
        `  req.on('error', () => resolve());`,
        `});`,
        `await handle.close();`,
        `process.stdout.write('EXITED_CLEANLY');`
      ].join('\n'),
      'utf8'
    );
    t.after(() => fs.rmSync(script, { force: true }));

    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.signal, null, 'close() 后进程未能自行退出（句柄泄漏把事件循环钉住了）');
    assert.equal(r.status, 0, `子进程异常退出：${r.stderr}`);
    assert.equal(r.stdout, 'EXITED_CLEANLY');
  });
});

describe('renderer 静态资产', () => {
  it('app.js 不含任何以 HTML 字符串建 DOM 的接口，也不含 eval(', () => {
    const src = fs.readFileSync(path.join(RENDERER_DIR, 'app.js'), 'utf8');
    // 注释里提到"该类接口名"但不出现字面量；逐个字面量断言不出现
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
      assert.equal(src.includes(banned), false, `app.js 不应出现 ${banned}`);
    }
  });

  it('app.js 通过 createTextNode/textContent 落地文本（存在安全的文本路径）', () => {
    const src = fs.readFileSync(path.join(RENDERER_DIR, 'app.js'), 'utf8');
    assert.ok(src.includes('createTextNode') || src.includes('textContent'), '应存在安全的文本落地路径');
  });

  it('index.html 不含内联 <script>，只有带 src 的外部引用', () => {
    const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, '应至少有一个外部脚本引用');
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc\s*=/, '每个 <script> 必须带 src');
      assert.equal(body.trim(), '', '<script> 标签内不得有内联代码');
    }
  });

  it('index.html 不含内联事件处理属性', () => {
    const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, '不得出现 onclick 之类内联事件属性');
  });
});

describe('CLI 辅助', () => {
  it('parseArgs 解析 --project / --db / --port，缺省 port 为 0', () => {
    const a = parseArgs(['--project', 'C:/p', '--db', 'C:/p/x.sqlite', '--port', '8080']);
    assert.equal(a.projectRoot, 'C:/p');
    assert.equal(a.dbPath, 'C:/p/x.sqlite');
    assert.equal(a.port, 8080);
    assert.equal(parseArgs([]).port, 0);
    assert.equal(parseArgs([]).dbPath, null);
  });

  it('bannerLines 含只读与 loopback 声明，且 URL 行带 token', async (t) => {
    const { handle } = await startServer(t, { projectRoot: makeRoot() });
    const lines = bannerLines(handle, 'C:/p');
    assert.ok(lines.some((l) => l.includes('只读')));
    assert.ok(lines.some((l) => l.includes('127.0.0.1')));
    assert.ok(lines.some((l) => l.includes(`token=${handle.token}`)));
  });
});
