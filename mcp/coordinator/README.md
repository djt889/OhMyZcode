**English** | [简体中文](./README.zh-CN.md)

# OMZ coordinator (stdio MCP sidecar)

SQLite-backed team registry / DAG scheduling / lease / heartbeat / mailbox / retry. Zero third-party dependencies,
only the built-in `node:sqlite` (**Node >= 22.13** — on 22.5–22.12 that module sits behind the
`--experimental-sqlite` flag, and importing it directly exits with an `ERR_UNKNOWN_BUILTIN_MODULE` crash stack; from
22.13.0 on it is available by default, and the ExperimentalWarning printed at startup is normal).
**The complete design, the per-tool inputs and all the invariants are in `DESIGN.md` §7**; this document covers only
what an operator needs to know on the spot.

## Database location

Priority: `--db <path>` > env `OMZ_COORDINATOR_DB` > `<cwd>/.omz/runtime/coordinator.sqlite`. **One database for many
teams, not one database per team** (the §3.5 v1.4 revision: the `teams` table is itself a multi-team registry, and
splitting databases would cut off cross-team audit queries); isolation is carried by the per-team file area plus the
`team_id` foreign key inside the database. When physical isolation is needed (for load testing, say), the mounting
side points `--db`/env at any path; the server assumes nothing about the database's location.
SQLite is the **single source of truth** for tasks/dependencies/leases/mailbox; the JSON from `omz_export_mirror` is
only a mirror and audit export and must not be written back.

> **Without `--db` it creates the database in cwd**: running `npm run coordinator` at the repository root produces
> `./.omz/runtime/coordinator.sqlite`. `.omz/` is already gitignored, but it is still an accidental artifact.
> Pass `--db` explicitly for manual trial runs.

## The tools (13) and tool names

`omz_team_create` / `omz_dag_submit` / `omz_task_claim` / `omz_task_heartbeat` / `omz_task_complete` /
`omz_task_fail` / `omz_mail_send` / `omz_mail_receive` / `omz_mail_ack` / `omz_status` / `omz_team_shutdown` /
`omz_reclaim_expired` / `omz_export_mirror`. `tools/list` is the only authoritative list.

The names above are the **bare names** on the core side. When mounted as a plugin the engine prepends a namespace, so
the actual name on the main agent side looks like `mcp__plugin_omz_omz-coordinator__omz_team_create` — callers should
list the tools first and match by suffix, not hard-code the bare names.

`verifyGraphInvariants(db, { graph_id })` is an exported function of core (**not an MCP tool**), read-only, usable on
a readonly handle, meant to be called by doctor / reconciliation scripts. It returns `{ ok, violations, checked }`
and covers 4 kinds of violation (deps count mismatch, dispatched although an upstream is not done, should be ready
but stuck, edge `consumed` inconsistent with the upstream's status).

## Three disciplines that are easy to break

1. **`now` is not exposed.** It is only a test-injection parameter on the core signature, **not in any tool's
   `inputSchema`**, and the MCP layer always passes the server's `nowSec()`. Exposing it is a full attack surface:
   `omz_reclaim_expired({ now: <future> })` can steal tasks whose lease has not expired, and can also bypass the
   `retry_at` backoff and the `attempts` budget. Injection is accepted only when `OMZ_TEST_TIME=1`, and every
   acceptance prints a WARNING to stderr.
2. **Two layers of duplicate protection for unblocking downstream** (invariant: downstream ready ⟺ all upstreams
   done). Once a repeated decrement of `deps_remaining` breaks it, **the database itself is still self-consistent**
   and nothing can be inferred after the fact, so it can only be sealed off on the write side: ① the terminal-state
   guard — `taskComplete`/`taskFail` check the status right after `idemLookup`, and if it is already terminal they
   return `duplicate: true` without touching downstream (this catches repeated calls "with no idempotency key" and
   "with a brand-new idempotency key", which the idempotency table is blind to); ② `task_deps.consumed`
   (migration 002) — the decrement only processes rows with `consumed = 0` and sets it to 1 in the same transaction.
   `taskFail` has three more guards: a terminal task cannot be failed, an owner mismatch is `NOT_OWNER` (**including
   an owner of null**), and only a `running` task may be failed (failing a `blocked` one would turn it into `ready`,
   bypassing dependencies).
3. **claim must use `BEGIN IMMEDIATE`.** `RETURNING` is not a lock; without it two writers will read the same ready
   row. The running count for max_parallel must also be done inside that same write transaction — "read the count
   first, then open the transaction" is itself a race; the counting scope is the **entire team** (across graphs).

## Caller conventions

- When `taskClaim` returns `task: null`, branch on `reason`: no `reason` = nothing ready for now; `max-parallel` =
  the quota is full, retry later; `team-shutdown` = no more cards are being dealt, stop polling.
- The **idempotency key** is doubly bound to `(op, task_id)`: a key used for another `op` or another task is
  `BAD_ARGS`. Otherwise `idemLookup` would return A's first result as B's result. For at-least-once semantics see
  §13.5 I3.
- **The mirror's join key is the numeric `id`, not the key**: the unique constraint is `UNIQUE(graph_id, key)`, so a
  key is unique only within a graph, and it is legal for two graphs of the same team to reuse the same key.
  `depends_on` is an array of numeric ids; `key`/`depends_on_keys` are for humans to read (a deliberate deviation
  from the §7.3 sample).
- `transport_state` (agents) and `coordinator_state` (tasks.status) are independent dimensions and must not be
  inferred from each other or merged in the display. The `counts` of `status()`/`exportMirror()` are a constant 7
  states (including `unknown`) and do not drift with the states actually present in the database, so you can rely on
  them for diffs.
- Migrations: `migrations/*.sql` are replayed in lexicographic order, published files are **never modified**, changes
  are append-only and must be safe to replay against any old database. `ADD COLUMN` has no `IF NOT EXISTS`, hence the
  support for a leading `-- @skip-if-column <table>.<column>` (it skips the file body but still registers it as
  applied; otherwise every `openDb` would retry and throw `MIGRATION_FAILED`). 002 is exactly what uses it.
  **The granularity of that guard is the whole file**: when it triggers, the entire file body is skipped, including
  statements in it that were idempotent to begin with and that had to run. The discipline is therefore
  **a guarded file contains only that one `ADD COLUMN` and its direct backfill**, and statements that are naturally
  idempotent, such as indexes, go into a separate unguarded file.
  002 violates this rule (it contains `CREATE INDEX idx_task_deps_upstream`): for a database where "the column
  already exists but 002 is not registered" (someone ran `ALTER TABLE task_deps ADD COLUMN consumed` by hand), the
  index is skipped by association without leaving any warning, and the downstream-decrement hot path of
  `taskComplete` degrades into a full table scan. The fix is to add **003-task-deps-index.sql** (unguarded, its two
  statements naturally idempotent), not to modify 002 — a registered migration is not replayed, so changing 002 both
  breaks the discipline and has no effect.

## Mounting it in ZCode

```json
{
  "mcpServers": {
    "omz-coordinator": {
      "type": "stdio",
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/mcp/coordinator/server.mjs"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": { "OMZ_COORDINATOR_DB": "${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite" }
    }
  }
}
```

Consistent with how `.zcode-plugin/plugin.json` actually writes it. **The engine expands exactly these eleven
variables**: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`,
`CLAUDE_SESSION_ID`, `CLAUDE_SKILL_DIR`, `ZCODE_PLUGIN_DATA`, `ZCODE_PLUGIN_ROOT`, `ZCODE_PROJECT_DIR`,
`ZCODE_SESSION_ID`, `ZCODE_SKILL_DIR` (plugin MCP additionally supports `${user_config.KEY}`). A misspelled variable
name **does not raise an error and is not blanked out; it silently leaves the literal behind**, and the path is bound
to be broken — `${pluginDir}`/`${workspaceFolder}` are not engine variables (§10.3, item 1).

Only JSON-RPC is allowed on stdout; all logs go to stderr. A tool-level failure returns a tool result with
`isError: true` (not a JSON-RPC error); an unknown method is `-32601`, a parse failure `-32700`.

## Manual smoke test

```bash
# Give the db path explicitly to avoid leaving a database in the repository. Under Git Bash do not write /tmp:
# MSYS converts it into <current drive>:\tmp\...
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"omz_team_create","arguments":{"name":"smoke"}}}' \
  | node mcp/coordinator/server.mjs --db "$TEMP/omz-smoke.sqlite"   # cmd uses %TEMP%\omz-smoke.sqlite
```

Expect three lines of valid JSON on stdout, with `tools/list` containing 13 tools. Delete `omz-smoke.sqlite*`
(including `-wal`/`-shm`) afterwards.
