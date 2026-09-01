# OMZ dashboard（可选展示层）

只读状态面板：loopback-only HTTP + SSE，展示 agents / DAG / mailbox / events / audit。
对应 `DESIGN.md` §1.5 结论 4、§3.1、§3.3 `dashboard` profile、§13.5 I5、§15.3、§9 M3。

**定位**：默认关闭的可选 profile。没有 dashboard 请求就不启动端口（§15.3-2）；启动失败或关闭时回退
**ZCode GUI 任务面板 + `/omz-status`**，不影响 coordinator 调度（§15.3-5）。
**启用**：`<project>/.zcode/config.json` → `{ "omz": { "dashboard": { "enabled": true } } }`

```bash
node dashboard/server.mjs --project /path/to/project [--db <sqlite>] [--port 0]  # 纯 HTTP，零依赖
node dashboard/main.mjs   --project /path/to/project                             # Electron 壳，缺失则自动降级

# `/path/to/project` 是占位符，必须换成**项目根的真实绝对路径**（Windows 上逐字复制会得到不存在的路径）。
# 在项目根里直接跑，最省事的形态（Git Bash / PowerShell 均可，路径含空格靠引号兜住）：
node dashboard/server.mjs --project "$PWD"
# Windows 显式路径示例：node dashboard/server.mjs --project "D:/work/my-project"
```

URL（含 token）打印到 **stderr**，stdout 保持干净。`Ctrl+C` 优雅关闭。

## 只读契约

所有端点都是 GET，**任何其它方法一律 405**。没有写入、提交、重试或命令执行端点——dashboard 不能扩大主 agent
权限（§15.3-4）。改状态请走 coordinator MCP 工具或 `/team`。

| 路径 | 鉴权 | 返回 |
|---|---|---|
| `/`、`/index.html`、`/app.js`、`/app.css` | loopback + CORS（**免 token**） | 静态白名单文件（非白名单名 → 404） |
| `/api/snapshot` | + **token** | 统一状态快照 JSON |
| `/api/events?since=<id>` | + **token** | SSE 流（1500ms 共享轮询、仅变化时推、15s 心跳；上限 8 条） |
| `/healthz` | loopback + CORS（**免 token**） | `{ ok, source }` —— 无 degraded 细节、无路径 |
| 其它 / 非 GET | — | 404 / 405 |

## 鉴权分层：明文规则（改 `PUBLIC_PATHS` 前必读）

**判据只有一条：响应里有没有运行时数据。** 不是「方便」，也不是「浏览器带不上 token 所以放行」——后者只是
静态壳恰好满足判据的原因。

1. **免 token 的只能是「编译期固定字节、不含任务/路径/token 的静态壳」**：`/`、`/index.html`、`/app.js`、
   `/app.css`，其全部数据由 renderer 再发 `/api/*` 取得。理由：浏览器只把 token 带在**地址栏那一个请求**上
   （`?token=`），随后 `<link href="/app.css">`/`<script src="/app.js">` 的子资源请求由浏览器自己发出，**不带
   任何凭据**；静态壳放到 token 门之后，默认路径（token 每次启动随机生成）下 CSS/JS 必然 401 → 面板不可用。
2. **`/healthz` 免 token 但必须保持最小化**：只回 `{ ok, source }`。`degraded[]` 的 reason 含 coordinator db 绝对
   路径，属需 token 信息，已移出 healthz（仍在 `/api/snapshot`）。另有 `HEALTHZ_TTL_MS`（1000ms）结果缓存，
   免鉴权端点不得成为全量快照的 CPU 放大器。
3. **任何返回运行时数据的端点（`/api/*`）必须 token**：无凭据 401（带 `WWW-Authenticate: Bearer`），坏凭据 403。
   它们是唯一会吐出绝对路径与任务内容的面。
4. **免 token 集合由 `STATIC_FILES` 的 key + `/healthz` 派生，不手写字面量**：
   `PUBLIC_PATHS = new Set([...STATIC_FILES.keys(), '/healthz'])`，且必须与流水线里实际放行的分支同源
   （`STATIC_FILES.has(pathname)` 与 `pathname === '/healthz'`）。两份清单只要能各自漂移，就一定会漂移。

> **给未来维护者的告警**：往 `PUBLIC_PATHS` 里加任何 `/api/*` 路径**等于把数据端点公开**。
> `tests/dashboard.test.mjs` 的 I10 组有同源断言会拦住（严格等于 `STATIC_FILES` 键集 ∪ `{/healthz}`、不得含
> `/api/` 前缀、并在 token 非空的服务上逐路径验放行面），**不要试图绕过它**：这条判据此前只活在代码注释和
> 一个没人读的常量里，于是有人把 `/api/snapshot` 加进免鉴权集合而测试全绿。

## 其余 I5 防护（逐条落点见 `server.mjs` 文件头注释）

- **只绑 loopback**：`isLoopbackRequest()` 在校验 token **之前**判来源，非 loopback 直接 403 + `socket.destroy()`。
- **随机端口 + 每次启动随机 token**：`port = 0` 系统分配；`crypto.randomBytes(24)`，比较用 `timingSafeEqual`
  （长度不等先判 false）。token 进程级、不落盘、不进 stdout、退出即失效，泄露的补救就是重启。
- **CORS 白名单**：仅 `http://127.0.0.1:<本端口>` 与 `http://localhost:<本端口>`；无 `Origin`（同源/curl）放行。
  `checkRequestTarget()` 另收紧请求行：origin-form 放行，absolute-form 必须命中本服务自身 origin 否则 400，
  authority-form 与非 http scheme 一律拒绝。静态资源只按 pathname 精确查表、从不拼路径，故 `/..%2fpackage.json`
  之类只是「不在表里的 key」→ 404，路径穿越在结构上不可能。
- **SSE 只发结构化事件**（`snapshot` / `heartbeat`），不透传终端流、不承载命令；**CSP** `default-src 'none'` 禁
  内联脚本。renderer 侧服务端字符串只经 `textContent`，渲染前剥 ANSI 与控制字符、>2000 字符截断。
- **Electron 壳没有 preload、也没有任何 IPC 通道**（这条此前写作"preload 只暴露 `getBootInfo()`"，已撤下，见下节）。

前四条（loopback / 随机端口+随机 token / CORS / SSE+CSP+只读）都在 `tests/dashboard.test.mjs` 里有实测覆盖，
且不依赖 Electron 是否存在。最后一条是**结构性事实**（`windowOptions()` 的返回值里没有 `preload` 键），
不是运行时行为，因此靠代码本身而不是断言保证。

## 为什么 Electron 壳不需要 preload

`main.mjs` 的 `windowOptions()` 里**没有 `preload` 字段**，也不注册任何 IPC 通道。因为 renderer 不需要主进程数据：

1. **页面与数据都来自 loopback HTTP 服务**：`index.html`/`app.js`/`app.css` 是服务端静态白名单文件，运行时数据全由
   renderer 自己 `fetch('/api/*')` 取得。主进程手上没有 renderer 拿不到的东西。
2. **token 走地址栏 query**：`urlOf('/')` 拼 `?token=`，`loadURL` 把它带进页面，renderer 从 `location.search` 读
   （`app.js` 的 `token()`）。不需要一个桥来交接启动信息。
3. **这个壳就是个只能访问本服务的浏览器窗口**：`setWindowOpenHandler` 拒绝所有新窗口，`will-navigate` 只放行
   `http://127.0.0.1:<本端口>/`。窗口之外没有第二套能力面。

删掉它的直接原因是它与 `sandbox: true` 互相排斥：Electron 官方文档明确 sandboxed preload 以普通脚本（非 ESM 上下文）
加载、不能用 ESM import，而原文件是 `preload.mjs`。它靠 `typeof require` 守卫躲开了抛错，代价是**sandbox 下
`contextBridge` 是否可达没有任何文档承诺**——也就是说"这道防护是否生效"根本无法验证。加上 renderer 对
`omzDashboard` / `getBootInfo` **零引用**（`app.js` 与 `index.html` 里一处都没有），它实际是死代码，却以"preload 只
暴露最小面"的形式挂在 I5 清单里充当安全承诺。**无法验证的承诺比没有承诺更坏**，所以连文件带清单条目一起撤下：
没有 preload 就没有 contextBridge 面，也没有可被误用的 IPC 入口。

将来若真需要主进程数据，用 `preload.cjs`（sandbox 下按 CJS 加载）并在上面的清单里同步登记暴露面——**不要**再放
`.mjs` preload。

## SSE：连接上限与单一共享轮询器

`MAX_SSE_STREAMS = 8`，超限 `503` + `Retry-After: 5`。所有连接共用**一个**定时器采集并广播同一份 payload，
CPU 与连接数解耦（8 条与 1 条的 `collectSnapshot()` 频率相同）。最后一个订阅者断开即停定时器；定时器一律
`unref()`。帧 id **每连接局部**：`Last-Event-ID` / `?since=` 只作本连接计数起点，不写回全局计数器（此前传
`Number.MAX_SAFE_INTEGER` 会让 `+1` 失去精度，把所有客户端帧 id 钉死在同一值）；入参经 `parseEventCursor()`
校验（非纯数字、非安全整数、`<=0`、`> MAX_EVENT_ID` 一律从 0 开始）。续接语义是「下一帧即最新全量」，不回放。

## 数据源双轨与两处同步纪律

`collectSnapshot()` 优先只读打开 coordinator SQLite → `source: 'coordinator'`；db 缺失/损坏/查询失败则**回退**
`tools/render-status.mjs` 的 `.omz/` 文件视图 → `source: 'files'`，原因写进 `degraded[]`，**绝不 500**。
`transport_state`（agents）与 `coordinator_state`（tasks.status）永远分两列，不互推不合并（I3）；文件视图无传输
维度，`transport_state` 恒 `null`。首屏 `/api/snapshot` 返回 401/403 时**不**建立 SSE（同 token 的 EventSource
必然失败且会无限重连），直接提示凭据无效。

- **状态枚举**：`renderer/app.js` 的 `STATES`（唯一定义处）与 `app.css` 的 `.pill[data-state=...]` 必须同时覆盖
  coordinator 7 态（`blocked` `ready` `running` `done` `failed` `dead` `unknown`）与文件视图额外 2 态
  `pending`（灰蓝）、`corrupt`（橙红加粗）。`corrupt`（文件读不出来）不得与 `unknown`（状态不可判定）混为一谈。
- **跨图关联键是数字 task id**，不是 key（`UNIQUE(graph_id, key)` 只保证图内唯一）。`buildMirrorIndex()` 三档
  降级：有数字 id → 按 id；只有字符串 id 且本 team 内 key 无重名 → 按 key（双射）；有重名 → **只对重名的那些
  key** 退化为不关联并写 `degraded[]`。绝不按 key 猜：错误关联比缺字段更有害。

`isMain` 用 `fileURLToPath(import.meta.url)` 比对 `process.argv[1]`，**不能**用 `new URL(...).pathname`（
percent-encoded，安装目录含空格或非 ASCII 时永不相等，`node dashboard/server.mjs` 会静默 exit 0）。
