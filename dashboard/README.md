**English** | [简体中文](./README.zh-CN.md)

# OMZ dashboard (optional presentation layer)

A read-only status panel: loopback-only HTTP + SSE, showing agents / DAG / mailbox / events / audit.
Corresponds to `DESIGN.md` §1.5 conclusion 4, §3.1, the §3.3 `dashboard` profile, §13.5 I5, §15.3, §9 M3.

**Positioning**: an optional profile that is off by default. Without a dashboard request no port is opened
(§15.3-2); if startup fails or it is off, it falls back to the **ZCode GUI task panel + `/omz-status`**, without
affecting coordinator scheduling (§15.3-5).
**Enabling**: `<project>/.zcode/config.json` → `{ "omz": { "dashboard": { "enabled": true } } }`

```bash
node dashboard/server.mjs --project /path/to/project [--db <sqlite>] [--port 0]  # pure HTTP, zero dependencies
node dashboard/main.mjs   --project /path/to/project                             # Electron shell, auto-degrades if absent

# `/path/to/project` is a placeholder and must be replaced with the **real absolute path of the project root**
# (copying it verbatim on Windows yields a path that does not exist).
# Run it right in the project root — the least troublesome form (Git Bash / PowerShell both work; quotes cover
# paths containing spaces):
node dashboard/server.mjs --project "$PWD"
# Explicit Windows path example: node dashboard/server.mjs --project "D:/work/my-project"
```

The URL (including the token) is printed to **stderr**; stdout stays clean. `Ctrl+C` shuts down gracefully.

## The read-only contract

All endpoints are GET; **any other method is always 405**. There is no write, submit, retry or command-execution
endpoint — the dashboard cannot enlarge the main agent's privileges (§15.3-4). To change state, go through the
coordinator MCP tools or `/team`.

| Path | Authentication | Returns |
|---|---|---|
| `/`, `/index.html`, `/app.js`, `/app.css` | loopback + CORS (**no token**) | the static whitelisted files (a non-whitelisted name → 404) |
| `/api/snapshot` | + **token** | the unified status snapshot JSON |
| `/api/events?since=<id>` | + **token** | the SSE stream (1500ms shared polling, pushed only on change, 15s heartbeat; capped at 8) |
| `/healthz` | loopback + CORS (**no token**) | `{ ok, source }` — no degraded detail, no paths |
| anything else / non-GET | — | 404 / 405 |

## Authentication tiering: the explicit rules (required reading before changing `PUBLIC_PATHS`)

**There is only one criterion: whether the response contains runtime data.** Not "convenience", and not "the browser
cannot carry the token so let it through" — the latter is merely the reason the static shell happens to satisfy the
criterion.

1. **The only things allowed without a token are "the static shell: bytes fixed at compile time, containing no
   tasks/paths/token"**: `/`, `/index.html`, `/app.js`, `/app.css`, all of whose data the renderer fetches later via
   `/api/*`. The reason: the browser carries the token only on **that one address-bar request** (`?token=`), and the
   subsequent subresource requests for `<link href="/app.css">`/`<script src="/app.js">` are issued by the browser
   itself, **carrying no credentials at all**; put the static shell behind the token gate and the CSS/JS are bound to
   get 401 on the default path (the token is randomly generated at every startup) → the panel is unusable.
2. **`/healthz` needs no token but must stay minimal**: it returns only `{ ok, source }`. The reason strings in
   `degraded[]` contain the absolute path of the coordinator db, which is token-required information and has been
   moved out of healthz (it is still in `/api/snapshot`). There is also a `HEALTHZ_TTL_MS` (1000ms) result cache: an
   unauthenticated endpoint must not become a CPU amplifier for the full snapshot.
3. **Any endpoint that returns runtime data (`/api/*`) must require a token**: no credentials → 401 (with
   `WWW-Authenticate: Bearer`), bad credentials → 403. They are the only surface that emits absolute paths and task
   content.
4. **The token-free set is derived from the keys of `STATIC_FILES` + `/healthz`, never hand-written as literals**:
   `PUBLIC_PATHS = new Set([...STATIC_FILES.keys(), '/healthz'])`, and it must share a source with the branch that
   actually lets requests through in the pipeline (`STATIC_FILES.has(pathname)` and `pathname === '/healthz'`). If two
   lists *can* drift from each other, they *will*.

> **A warning to future maintainers**: adding any `/api/*` path to `PUBLIC_PATHS` **means publishing a data
> endpoint**. The I10 group in `tests/dashboard.test.mjs` has same-source assertions that will stop you (strictly
> equal to the key set of `STATIC_FILES` ∪ `{/healthz}`, must not contain the `/api/` prefix, and the pass-through
> surface is verified path by path against a service with a non-empty token) — **do not try to work around them**:
> this criterion previously lived only in a code comment and in a constant nobody read, whereupon somebody added
> `/api/snapshot` to the unauthenticated set and the tests were all green.

## The rest of the I5 protections (for where each one lands see the file-header comment in `server.mjs`)

- **Bind to loopback only**: `isLoopbackRequest()` judges the origin **before** validating the token; a non-loopback
  request gets a straight 403 + `socket.destroy()`.
- **A random port + a random token at every startup**: `port = 0` lets the system allocate;
  `crypto.randomBytes(24)`, compared with `timingSafeEqual` (unequal lengths are judged false first). The token is
  process-level, never written to disk, never on stdout, and invalid the moment the process exits; the remedy for a
  leak is to restart.
- **The CORS whitelist**: only `http://127.0.0.1:<this port>` and `http://localhost:<this port>`; no `Origin`
  (same-origin/curl) is let through. `checkRequestTarget()` additionally tightens the request line: origin-form is
  let through, absolute-form must match this service's own origin or it is 400, and authority-form plus non-http
  schemes are always rejected. Static resources are looked up in the table by exact pathname and paths are never
  concatenated, so something like `/..%2fpackage.json` is merely "a key that is not in the table" → 404; path
  traversal is structurally impossible.
- **SSE only emits structured events** (`snapshot` / `heartbeat`); it does not pass terminal streams through and
  carries no commands. **CSP** `default-src 'none'` forbids inline scripts. On the renderer side, server strings go
  only through `textContent`, with ANSI and control characters stripped before rendering and truncation past 2000
  characters.
- **The Electron shell has no preload and no IPC channel whatsoever** (this item previously read "preload exposes
  only `getBootInfo()`"; it has been withdrawn, see the next section).

The first four (loopback / random port + random token / CORS / SSE+CSP+read-only) all have measured coverage in
`tests/dashboard.test.mjs`, and do not depend on whether Electron is present. The last one is a **structural fact**
(the return value of `windowOptions()` has no `preload` key), not a runtime behavior, so it is guaranteed by the code
itself rather than by an assertion.

## Why the Electron shell does not need a preload

`windowOptions()` in `main.mjs` has **no `preload` field**, and registers no IPC channel either. Because the renderer
does not need data from the main process:

1. **Both the page and the data come from the loopback HTTP service**: `index.html`/`app.js`/`app.css` are the
   server's static whitelisted files, and all runtime data is fetched by the renderer itself via `fetch('/api/*')`.
   The main process holds nothing the renderer cannot get.
2. **The token travels in the address-bar query**: `urlOf('/')` appends `?token=`, `loadURL` carries it into the
   page, and the renderer reads it from `location.search` (`token()` in `app.js`). No bridge is needed to hand over
   boot information.
3. **This shell is just a browser window that can only reach this service**: `setWindowOpenHandler` rejects all new
   windows, and `will-navigate` only allows `http://127.0.0.1:<this port>/`. There is no second capability surface
   outside the window.

The immediate reason for deleting it is that it is mutually exclusive with `sandbox: true`: Electron's official
documentation states explicitly that a sandboxed preload is loaded as an ordinary script (a non-ESM context) and
cannot use ESM imports, while the original file was `preload.mjs`. It dodged the throw with a `typeof require` guard,
at the cost that **there is no documented promise whatsoever about whether `contextBridge` is reachable under
sandbox** — which is to say, "whether this protection is in effect" simply cannot be verified. Add to that the
renderer's **zero references** to `omzDashboard` / `getBootInfo` (not one, anywhere in `app.js` or `index.html`), and
it was in fact dead code, yet it hung on the I5 list as a security promise in the shape of "preload exposes only a
minimal surface". **An unverifiable promise is worse than no promise**, so the file and the list item were withdrawn
together: with no preload there is no contextBridge surface, and no IPC entry point that could be misused.

If data from the main process is ever genuinely needed, use `preload.cjs` (loaded as CJS under sandbox) and register
the exposed surface in the list above at the same time — **do not** put an `.mjs` preload back.

## SSE: the connection cap and the single shared poller

`MAX_SSE_STREAMS = 8`, over the limit `503` + `Retry-After: 5`. All connections share **one** timer that collects and
broadcasts the same payload, decoupling CPU from the connection count (the `collectSnapshot()` frequency is the same
for 8 connections as for 1). The timer stops as soon as the last subscriber disconnects; timers are always
`unref()`ed. Frame ids are **local to each connection**: `Last-Event-ID` / `?since=` serve only as the counting start
point for this connection and are not written back to the global counter (previously passing
`Number.MAX_SAFE_INTEGER` would make `+1` lose precision and pin all clients' frame ids to the same value); the input
is validated by `parseEventCursor()` (non-numeric, non-safe-integer, `<=0`, `> MAX_EVENT_ID` all start from 0). The
resumption semantics are "the next frame is the latest full snapshot"; there is no replay.

## The dual-track data source and two synchronization disciplines

`collectSnapshot()` first opens the coordinator SQLite read-only → `source: 'coordinator'`; if the db is missing,
corrupt, or the query fails it **falls back** to the `.omz/` file view of `tools/render-status.mjs` →
`source: 'files'`, with the reason written into `degraded[]`, and **never a 500**. `transport_state` (agents) and
`coordinator_state` (tasks.status) are always two separate columns, never inferred from each other or merged (I3);
the file view has no transport dimension, so `transport_state` is always `null`. When the first-screen
`/api/snapshot` returns 401/403, SSE is **not** established (an EventSource with the same token would inevitably fail
and reconnect endlessly); it reports invalid credentials directly instead.

- **The state enums**: `STATES` in `renderer/app.js` (the only place it is defined) and the
  `.pill[data-state=...]` selectors in `app.css` must cover both the coordinator's 7 states (`blocked` `ready`
  `running` `done` `failed` `dead` `unknown`) and the file view's 2 extra states, `pending` (grey-blue) and `corrupt`
  (orange-red, bold). `corrupt` (the file cannot be read) must not be conflated with `unknown` (the state cannot be
  determined).
- **The cross-graph join key is the numeric task id**, not the key (`UNIQUE(graph_id, key)` only guarantees
  uniqueness within a graph). `buildMirrorIndex()` degrades in three tiers: numeric ids present → join by id; only
  string ids and no duplicate keys within this team → join by key (a bijection); duplicates present → **only for
  those duplicated keys** degrade to no join and write `degraded[]`. Never guess by key: a wrong join is more harmful
  than a missing field.

`isMain` compares `fileURLToPath(import.meta.url)` against `process.argv[1]`; it **must not** use
`new URL(...).pathname` (percent-encoded — never equal when the install directory contains spaces or non-ASCII
characters, and `node dashboard/server.mjs` then silently exits 0).
