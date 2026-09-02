**English** | [简体中文](./DESIGN.zh-CN.md)

# OMZ (Oh My ZCode) Design Document

- **Version**: **v1.5 (the installed-environment acceptance revision)** — the plugin is already installed into ZCode (`plugins.dirs` points at this directory, `omz@inline` enabled); after restarting the session all three acceptance items were run to completion (`/omz-doctor`, `/omz-status`, `/ulw`), and this revision writes back the empirical evidence gathered inside a real session
- **Status**: every specification of v1.3 has been implemented (9 agent files + 5 commands + 4 skills + hooks + coordinator MCP + dashboard + adapters + tools), 573 tests pass, `/omz-doctor` reports no FAIL, hook self-test 30/30. **v1.5 completes the real-session acceptance after installation**: `/omz-doctor` spawned all 9 agents one by one inside the session, **9/9 returned `OMZ-PONG`** (V12 closed), the read-only whitelist obtained behavior-level confirmation, and all four OMZ skills are visible on the subagent side (**B16 closed**); five new engine/runtime facts were obtained as well (§10.3 items 11–14, the V6 revision in §10.1). `/ulw` ran an end-to-end smoke test through one complete lifecycle (two review gates, dual evidence, final verification `confirmed`; the reproducible chain is in §18). The items still unverified in a real environment drop from six to **five** (V3/V4/V8′/V10/V11, §10.2).
- **Date**: 2026-09-01
- **Benchmark project**: [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) (68.5k★, hosted on OpenCode/Codex CLI)
- **Target host**: ZCode Desktop 3.10.2+ (the glm engine `zcode.cjs`)
- **Nature of the project**: a complete port of OmO's orchestration capabilities — capability parity, not code transplantation.
- **Why do it**: to make projects on ZCode turn out better. Parallel throughput (faster), specialized division of roles (deeper), independent review plus dual evidence (more reliable), and interview-driven planning (more accurate) all serve that one purpose; they are weighted equally, and none of them is merely a means to the others.
- **One-line positioning**: reimplement OmO's orchestration semantics according to ZCode's interaction model.

---

## 1. Design principles

1. **Serve better projects**: every design decision has to answer "does this make the project's output better?" Parallel throughput, division of roles, independent review plus dual evidence, and interview-driven planning are weighted equally; only a mechanism that improves neither speed nor quality gets demoted (flashy visualization is last).
2. **Use only verified ZCode mechanisms**: subagents in `agents/*.md`, the five plugin extension points, the built-in Agent tool (parallel spawn, background, resume), TodoWrite, and filesystem-shared state. Anything marked "engine-confirmed" has symbol-level evidence in zcode.cjs or an official plugin instance; anything "pending empirical verification" is listed in §10.
3. **Files are the protocol**: OmO Ultimate's agents are TS modules and ZCode has no equivalent plugin API; ZCode subagents have the full tool set (including file read/write), so state shared across agents always goes through agreed file formats in the in-project `.omz/` directory.
4. **The main agent *is* Sisyphus**: the main session is resident by nature, so the ultrawork mode prompt (injected into the main agent) carries the orchestration role, and no separate "main orchestration agent" is defined.
5. **Fit ZCode rather than imitate OpenCode**: whenever an OmO mechanism depends on an OpenCode-specific capability (primary mode, resident members, the `category` parameter of `task`), it is rewritten into a ZCode-equivalent form — better to degrade than to fake (the full difference table is in §1.5, the gap list in §11).
6. **Cost awareness**: multi-agent orchestration is a token amplifier (§12.1), so throttle valves are placed everywhere in the design — a description budget, no spawn for the quick class, results written to files instead of returned in full.

## 1.5 Environment and interaction differences between ZCode and OpenCode (the design basis)

Sources of evidence: symbol-level reverse-lookup in `zcode.cjs` (2026-08-31/09-01), the physical sample of the official plugin document-skills, and the official PLUGIN_DEVELOPMENT.md.

### 1.5.1 Runtime environment differences

| Dimension | OpenCode (OmO's host) | ZCode (this project's host) | Impact on OMZ |
|---|---|---|---|
| Operating system | Mostly Linux/macOS, tmux resident | Windows (Git Bash is the default shell; PowerShell scripts have a UTF-8 BOM trap; no tmux) | hook/state scripts are all implemented in node to sidestep shell differences; the presentation layer uses an Electron dashboard + the GUI task panel + `/omz-status` (§3.1, §3.3) |
| Host form | TUI terminal + tmux pane splitting | Electron GUI; the task panel natively displays background subagents, and Settings → Subagents manages agents graphically | Visualization runs on two tracks: "GUI task panel + the /omz-status text board" |
| Engine | A standalone opencode process, configured under `~/.config/opencode/` | The glm engine (`<ZCode install dir>/resources/glm/zcode.cjs`), one of several managed engines; model providers are configured in `~/.zcode/v2/config.json` | OMZ does not touch engine configuration; model tiering references the provider models the user has already registered (§5.3) |

### 1.5.2 Interaction model differences

| Dimension | OpenCode (OmO's host) | ZCode (this project's host) | Impact on the OMZ design |
|---|---|---|---|
| **agent definition** | TS modules + a plugin API: `AgentConfig` carries rich fields such as `mode`/`teammate`/`category`/`prompt_append`/`fallback_models` | markdown `agents/*.md`; the frontmatter fields empirically supported (the judge.md sample + the engine parse chain) are `name` / `description` / `tools` (**a YAML array**, e.g. `[Read, Bash]`) / `model` / `thoughtLevel` / `permissionMode` / `maxTurns` / `memory` / `color` / `mcpServers`. There are three load sources: `loadZCodeAgentProfiles` reads `<storageRoot>/agents` (source=user) and `<workingDirectory>/.zcode/agents` (source=project), and `loadPluginAgentProfiles` reads `<pluginRoot>/agents/<name>.md` (source=plugin). **For the project source, `permissionMode` is deleted outright by `sanitizeProjectAgentProfile`** (it is not "rewritten/specially handled" — the field is stripped and the agent falls back to the session's default permission surface) | The field set is richer than expected: maxTurns serves as a runaway guardrail, thoughtLevel tiers thinking, permissionMode controls the permission surface (though project-level agents cannot use it, which does not affect OMZ since it ships as a plugin); there is no per-agent runtime override configuration |
| **role switching for the main session** | `AgentMode: "primary"` — the user can pick an agent to *be* the main role (saving a layer of orchestration and relay) | **No primary concept**: the main session is fixed and subagents can only be spawned | Deep execution must pass through the main agent's relay (the CONTEXT redundancy protocol, §12.4) |
| **delegation tool** | The `task` tool: the two parameters `category` + `subagent_type`, explicit `load_skills` injection, `task_id` continuation | The `Agent` tool: only `subagent_type` + `prompt` + `description` + `run_in_background` | category collapses into a mapping table inside the /ulw prompt (§5); skills rely on subagent auto-discovery (the engine confirms the subagent context contains `skills` + `skillMetadataBudget`) |
| **subagent lifecycle** | Team Mode members are resident at the process level, polling a mailbox, claiming actively, and messaging each other | The public documentation confirms task-level isolated contexts, results from foreground and background returning to the main conversation, and a prohibition on subagents spawning further; this time SendMessage/agent id were visible at the tool layer, but the official documentation promises no stable resume token, cancellation, progress or P2P API | Task-level workers are the baseline; resume is only an optional adapter enhancement and cannot be a guarantee across restarts (§7.4, §13.5 I3) |
| **model routing** | category→model+fallback chain hardcoded | frontmatter `model` (the engine has a complete `SubagentModelRef` parse chain + an Inherited inheritance factory); **frontmatter `thoughtLevel` can set the thinking tier per agent** (parsing engine-confirmed); no fallback chain | A single model connected directly plus re-dispatch on failure; thinking tiers come from frontmatter rather than spawn parameters (§5.3) |
| **mode triggering** | The keyword-detector hook (IntentGate) | Native slash commands (`$ARGUMENTS` + `$1/$N` positional parameters + `` !`cmd` `` inline execution + ` ```! ` multi-line execution blocks, engine-confirmed); the `additionalContext` injection of the UserPromptSubmit hook **is confirmed to exist** in the engine hook schema (behavior pending empirical verification) | M1 slash commands as the floor; M2 keyword hook with upgraded evidence (§8.2); /omz-status can render state directly with an inline execution block |
| **hooks** | 54+ lifecycle hooks | 7 events (SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop); **the schema shapes of the two sources differ and must not be mixed** (corrected in the last round of v1.4): **① config-file hooks** (the `hooks` key of `~/.zcode/cli/config.json`) are organized as `hooks.events.<Event>` and carry additional runtime parameters such as `enabled`/`timeoutMs`/`maxOutputBytes`; **② plugin hooks** (`<pluginRoot>/hooks/hooks.json`) are wrapped in an outer `hooks` (the engine reads `rawHooks.hooks`) and are **keyed directly by event name, with no `events` intermediate layer** — writing `events` into a plugin hooks.json silently has no effect (§10.3 item 4). PreToolUse can return `permissionDecision`/`updatedInput`, and several events can return `additionalContext` | Fewer events, but the core injection/interception semantics are preserved; OMZ in plugin form only uses shape ② (the three switch layers in §8.2 explain which fields are actually read); async is handled with synchronous semantics, and the fallback for abnormal termination relies on the Stop hook (M4) |

**Localization conclusion (v1.1)**: the original text was inaccurate in calling codegraph, teammode, dag and tmux all "degradations". The four should be split across four layers:

1. **Semantic layer: codegraph can be connected directly**. The `codegraph_explore` OmO uses actually comes from the independent open-source project [`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph), not from an OmO-private tool; upstream is MIT, Windows x64/arm64, and provides `codegraph serve --mcp` as a stdio MCP that exposes `codegraph_explore(query, maxFiles?, projectPath?)` by default. ZCode officially supports stdio MCP and connects automatically at session start, so this is a configuration/installation item, not a capability degradation. OmO's `@sisyphuslabs/codex-codegraph` only does process resolution, provisioning and a JSON-RPC bridge; its Codex hook should not be ported directly — connecting ZCode to upstream is cleaner.
2. **Scheduling layer: teammode can be rebuilt locally**. ZCode's official public documentation confirms isolated subagent contexts, foreground and background execution, automatic return of completion results to the main conversation, and a prohibition on subagents spawning further; it does not publish a stable Team API, agent ID, resume token, mailbox or agent-to-agent communication. OMZ therefore uses the ZCode Agent as a short-lived worker transport and manages agent registry/mailbox/lease/heartbeat/resume_ref in its own coordinator MCP. The scheduling semantics can be filled in; native resident memory and direct P2P are not promised to be equivalent.
3. **Dependency layer: the DAG can be implemented locally**. Do not mistake ZCode's "idle-time tasks" for a DAG: the official idle-time task feature is a persistent FIFO queue that does not retry failures automatically and offers plugins no claim/dependency API. The OMZ coordinator implements the DAG with SQLite WAL + the `tasks`/`task_deps` tables; a claim must use `BEGIN IMMEDIATE` + a single-transaction `UPDATE ... RETURNING`, and no write transaction may be held while an external agent works; SQLite is still single-writer, so set `busy_timeout` and use at-least-once plus an idempotency key. Optionally reuse the MIT-licensed `vardiya` (Node >=22, SQLite WAL, atomic claim, heartbeat/stalled recovery, retry/backoff/DLQ, priority/delay/cron; it has Windows benchmarks but full compatibility still needs acceptance), or build a smaller coordinator MCP.
4. **Presentation layer: tmux can be replaced locally**. Windows Terminal's `wt split-pane` serves only as an external debugging bypass; building a ConPTY terminal host is too expensive. The recommendation is an Electron `BrowserWindow` + an independent `utilityProcess`/stdio MCP sidecar + a localhost HTTP/SSE dashboard: showing agents, the DAG, the mailbox, logs and event sequence numbers; SSE carries only events, commands go through fetch/IPC, and it uses loopback, a random port, a token and a CORS whitelist. The ZCode GUI task panel is still the default entry point. The interactive terminal of a native tmux pane is not equivalent, but state and audit can suit ZCode better. **v1.5 implementation correction**: v1.1–v1.2 also recommended `preload/contextBridge` here, but the implementation ended up **not using preload** — the renderer's page and data all come from the loopback HTTP service, the token travels in the address bar query, and the main process holds nothing the renderer cannot obtain; besides, `sandbox: true` and an ESM preload are mutually exclusive (rationale and evidence in §13.5 I5).

**Final grading**:

| Capability | Conclusion | Local ZCode implementation | Difference from OmO |
|---|---|---|---|
| `codegraph_explore` | **Direct connection** | The upstream CodeGraph stdio MCP | No OmO-specific bridge; the tool returns a text ToolResult, not strongly-typed JSON |
| Team Mode semantics | **Can be filled in** | coordinator MCP + ZCode Agent workers + SQLite mailbox/lease | No official resident Team API; no guaranteed direct agent-to-agent link |
| DAG scheduling | **Can be filled in** | coordinator MCP + SQLite WAL + atomic claim/deps/retry | Has to carry its own scheduling state; does not depend on ZCode's idle-time task FIFO |
| tmux presentation | **Can be replaced** | Electron dashboard + SSE + the GUI task panel | No native panes; Windows Terminal is only a bypass |



---

## 2. Master capability mapping table (OmO → OMZ)

| # | OmO mechanism | ZCode-equivalent implementation | Feasibility |
|---|---|---|---|
| 1 | 11 Discipline Agents | 9 `agents/*.md` + reuse of the built-in `Explore` (10 roles in total) + the main agent playing Sisyphus | ✅ native |
| 2 | IntentGate keyword detection | M1: slash commands; M2: UserPromptSubmit hook injection (schema confirmed, behavior pending empirical verification; includes dedupe and slash-command exclusion) | ✅ M1 native, M2 pending empirical verification |
| 3 | `task(category=...)` routing across 8 classes + fallback chain | A category → subagent_type mapping table (the /ulw prompt); model and thinking tier come from frontmatter `model`/`thoughtLevel` | ⚠️ routing works; no fallback chain |
| 4 | The 8 steps of the ultrawork lifecycle | The /ulw command system prompt + `.omz/goal/` + `.omz/plans/` | ✅ fully portable at the prompt layer |
| 5 | Team Mode (lead + 8 members, mailbox, tmux) | **Locally rebuilt**: ZCode background Agents as the worker transport + the OMZ coordinator MCP (SQLite registry/mailbox/lease) + resume metadata + /omz-status; does not depend on any unpublished official team API | ⚠️ semantics can be filled in; native residency/direct P2P are not equivalent |
| 6 | 12 `team_*` tools | The coordinator MCP exposes 13 `omz_*` tools (§7.2: team_create/dag_submit/task_claim/heartbeat/complete/fail, mail_send/receive/ack, status, team_shutdown, reclaim_expired, export_mirror; **the real names carry the prefix `mcp__plugin_omz_omz-coordinator__`, and the bare names cannot be called directly**); the main agent calls them through MCP, and workers only handle tasks | ✅ scheduling semantics can be filled in; the underlying worker launch is still done by the main agent's Agent tool |
| 7 | 17 skills | The 4 core ones are ported: ulw-plan, ulw-execute, ulw-research, review-work | ✅ SKILL.md is isomorphic |
| 8 | boulder.json session continuation | `.omz/boulder.json` (**`active_goal` is the single authoritative pointer**, §13 B30) + the main agent writing it actively after each wave collection point (the Stop hook is not implemented, §17 ruling 4); persistent task state lives in the coordinator's SQLite, and Boulder only stores the pointer to the current work | ✅ state can be persisted; automatic resume across restarts depends on an unpublished ZCode API, so a human or the main agent must restart workers |
| 9 | tmux visualization | **Locally rebuilt**: a standalone localhost dashboard (Electron BrowserWindow/utilityProcess + HTTP/SSE; **the implementation does not use preload**, and the renderer only fetches data over loopback HTTP, §13.5 I5); the ZCode GUI task panel is the default entry point, and Windows Terminal's `wt split-pane` is only a debugging bypass | ⚠️ state can be equivalent; native pane interaction is not |
| 10 | 54+ hooks | Keep ZCode's seven events; do not depend on OmO's hook count. The context/decision capabilities of `UserPromptSubmit`/`PreToolUse` are usable, but async behavior is treated as synchronous, to be enabled only after a runtime probe | ⚠️ fewer events; the core injection/interception semantics can be preserved |
| 11 | 5 built-in MCPs | CodeGraph and the coordinator are optional OMZ MCPs; the rest are installed on demand, without stuffing external dependencies into the core | ✅ pluggable |

---

## 3. Overall architecture

### 3.1 The four-layer architecture (localized implementation)

```
┌──────────────────────────────────────────────────────────┐
│ Presentation: ZCode GUI task panel + optional Electron    │
│ dashboard/SSE — agents / DAG / mailbox / events / audit   │
├──────────────────────────────────────────────────────────┤
│ Scheduling: OMZ coordinator MCP (stdio, ZCode plugin-host)│
│ registry / task DAG / lease / heartbeat / mailbox / retry  │
├──────────────────────────────────────────────────────────┤
│ Semantics: CodeGraph MCP (upstream @colbymchenry/codegraph)│
│ codegraph_explore: call chains / impact scope / sources    │
├──────────────────────────────────────────────────────────┤
│ Execution: ZCode Agent (short-lived workers) + 9 OMZ       │
│ agents/*.md + the built-in Explore (10 roles); the main    │
│ agent plays Sisyphus. ZCode natively handles spawn/return  │
└──────────────────────────────────────────────────────────┘
```

**The core boundary**: the scheduling layer does not pretend to be an official ZCode Team API. The ZCode Agent is responsible for actually launching workers, and the coordinator MCP only handles persistable identity, tasks, dependencies, leases, messages and audit; the two are related through `agent_ref`/`task_id`. When any enhancement layer is unavailable, the main agent's ordinary single-round delegation still works (feature flag + M1 fallback).

### 3.2 Components and data flow

1. The main agent reads the `/ulw` or `/team` protocol and decides whether CodeGraph, the DAG and Team semantics are needed.
2. If code relationships are needed it calls `codegraph_explore`; when there is no index it first returns initialization guidance rather than silently treating an incomplete result as fact.
3. After creating a team/graph the main agent calls the coordinator MCP's `omz_team_create`/`omz_dag_submit`; the coordinator generates stable `team_id`/`graph_id`/`task_id` but does not launch ZCode agents itself.
4. The main agent calls the ZCode Agent for each ready task and records the returned `agent_ref`; a worker only handles its bound task and submits a `complete`/`fail` result.
5. The coordinator atomically updates dependencies and the lease and immediately releases newly ready tasks; expired leases are reclaimed and re-dispatched by `omz_reclaim_expired` (§7.2); once the main agent receives a background notification it reads state, and does not treat the notification itself as evidence of completion.
6. The dashboard only reads the coordinator's state API; a broken presentation layer does not block scheduling.


### 3.3 Optional capability profiles and dependency isolation

OMZ does not tie every enhancement to a single startup path; it offers four profiles instead:

| Profile | Default | Dependencies | On failure |
|---|---|---|---|
| `core` | ✅ | ZCode-native agents/commands/skills + main-agent orchestration | Unaffected by external services |
| `graph` | optional | Upstream `@colbymchenry/codegraph` (MIT, Windows x64/arm64, bundled Node runtime) + the `.codegraph/` project index | Falls back to Explore + Bash grep/rg; an incomplete index must not be treated as fact |
| `orchestration` | optional | The OMZ coordinator stdio MCP + SQLite WAL (self-built, or `vardiya` after evaluation) | Falls back to ZCode-native background spawn + wave parallelism; core is unaffected |
| `dashboard` | optional | Electron BrowserWindow/utilityProcess + loopback HTTP/SSE | Falls back to the ZCode GUI task panel + `/omz-status` |

Enabling rules: `core` must hold first; `graph` and `orchestration` can be enabled independently and in parallel; `dashboard` should only be enabled once the coordinator's state interface is stable, but it does not depend on CodeGraph. Every layer must be able to be switched off on its own. The MCP connection configuration for CodeGraph and the coordinator lives in the workspace `.zcode/config.json` or in the plugin manifest's `mcpServers`; it does not modify the ZCode core and does not overwrite the user's existing MCPs.

**Configuration precedence (the v1.4 implementation ruling, §17 ruling 12)**: profile switches are overridden layer by layer along `built-in defaults → the omz key of .zcode/config.json → .omz/config.json (the whole file *is* the omz configuration)`, and **the last has the highest precedence**. One side effect must be known: `.omz/` is gitignored (§13 B14), so `.omz/config.json` is a **machine-private override**; to share profile switches with the team through the repository they must be written in `.zcode/config.json`. The doctor output reports hits/skips layer by layer, avoiding "I changed the config and nothing happened".

**CodeGraph fact boundary**: OmO's `codegraph_explore` has only one MCP tool by default, whose parameters are `query` (required), `maxFiles` (optional, default 12) and `projectPath` (optional); it returns standard MCP text content, possibly with `isError`, and not stable strongly-typed JSON. The hidden `search/callers/callees/impact/node/files/status` tools have to be enabled explicitly. The first version of OMZ depends only on `codegraph_explore`, works mainly from text, and requires agents to cite the source file/line numbers; do not depend on the hidden tools that are not enabled or assume the return is a JSON schema.

---

### 3.4 Plugin package layout

It is distributed as a standard ZCode plugin. The base plugin can enable only agents/commands/skills; CodeGraph and the coordinator are **optional MCP profiles** connected according to feature flags, so external dependencies cannot block the core flow. The physical sample of the official ZCode plugin (document-skills) confirms that `.zcode-plugin/plugin.json` can declare `skills` and `mcpServers`; local stdio servers are launched by the ZCode plugin-host (`ELECTRON_RUN_AS_NODE=1`). Below is the **structure actually on disk in v1.4**:

```
├── .zcode-plugin/plugin.json      # manifest: agents/commands/skills/hooks/mcpServers
├── package.json                   # metadata (aligned with official plugin convention)
├── agents/                        # 9 subagents (§4; the 10th role reuses the built-in Explore)
│   ├── omz-planner.md             # Prometheus
│   ├── omz-critic.md              # Metis
│   ├── omz-deep.md                # Hephaestus
│   ├── omz-junior.md              # Sisyphus-Junior
│   ├── omz-atlas.md               # Atlas (wave state machine + dispatch-proposal generator, §17 ruling 1)
│   ├── omz-oracle.md              # Oracle
│   ├── omz-reviewer.md            # Momus
│   ├── omz-librarian.md           # Librarian
│   └── omz-looker.md              # Multimodal Looker
├── commands/                      # the mode trigger layer (§8)
│   ├── ulw.md                     # /ulw = the ultrawork mode prompt ($ARGUMENTS takes the goal)
│   ├── team.md                    # /team = Team Mode orchestration instructions
│   ├── hyperplan.md               # /hyperplan = planning-only mode
│   ├── omz-status.md              # /omz-status = the status board (a ```! inline execution block renders .omz/)
│   └── omz-doctor.md              # /omz-doctor = self-check (§13 B10/B12/B14: agent reachability + model validation + gitignore check)
├── skills/
│   ├── ulw-plan/SKILL.md          # the interview-driven planning flow (+ three references/)
│   ├── ulw-execute/SKILL.md       # the plan execution protocol
│   ├── ulw-research/SKILL.md      # the parallel research protocol (+ six references/)
│   └── review-work/SKILL.md       # the dual-evidence acceptance protocol (+ two references/)
├── hooks/
│   ├── hooks.json                 # M2: UserPromptSubmit keyword detection (the real gate is omz.keyword_hook, §8.2)
│   └── keyword-detect.mjs         # the node implementation, --self-test with 30 cases
├── mcp/
│   └── coordinator/               # implemented: a stdio MCP, SQLite registry/mailbox/DAG/lease
│       ├── server.mjs             # 13 tools (§7.2)
│       ├── core.mjs               # transactions and invariants (including verifyGraphInvariants)
│       ├── db.mjs
│       ├── schema.sql
│       └── migrations/
├── dashboard/                     # implemented: the Electron/localhost SSE presentation layer
│   ├── main.mjs                   # the Electron host (degrades when electron is absent); no preload, no IPC channel (§13.5 I5)
│   ├── server.mjs                 # loopback HTTP/SSE + the token gate (the tiering of §13.5 I10)
│   └── renderer/
├── adapters/zcode/                # host-difference isolation: transport/capability/fallback/path
├── tools/                         # operations scripts
│   ├── doctor.mjs                 # the /omz-doctor backend
│   ├── render-status.mjs          # /omz-status rendering (numeric wave ordering B28, inline injection guard B27)
│   ├── validate-frontmatter.mjs   # YAML/tool-name validation (B23/B24)
│   ├── sync-omo-skills.mjs        # the §16.3 selective upstream sync
│   └── lib/is-main.mjs            # CLI entry-point detection (the shared implementation for B22)
├── tests/                         # 102 suites / 573 tests
└── upstream/                      # omo-sources.lock.json + porting records (§16.4)
```

**Template-variable discipline (engine-confirmed, §10.3)**: paths in the manifest and in hooks.json may only use variables the engine expands. OMZ uniformly uses `${ZCODE_PLUGIN_ROOT}` and `${ZCODE_PROJECT_DIR}`; `${pluginDir}` **is not an engine variable** (the v1.3 and earlier text used it by mistake, and the implementation has corrected this) — writing it leaves it verbatim in place and the path is certain to break. `ZCODE_SKILL_DIR`/`CLAUDE_SKILL_DIR` are forbidden in hook contexts (the engine throws outright).

Naming rule: subagent_type always carries the `omz-` prefix. The engine's `loadPluginAgentProfiles` **forces a namespace prefix onto plugin agents**, `<pluginName>:<bareName>` (e.g. `omz:omz-planner`), and **additionally registers a bare-name alias** when that bareName is globally unique and does not collide with a reserved name (`general-purpose`/`Explore`); a bareName collision or a clash with a reserved name produces an `agent_ambiguous_name` diagnostic and loses the alias. So OMZ's 9 agents can currently be addressed both as `omz:omz-planner` and by the bare name `omz-planner` — the `omz-` prefix policy is confirmed correct by engine behavior: it guarantees the bare name is unique, whereas generic names like `planner`/`oracle` would lose their alias the moment another plugin took them (details in §10.3).

### 3.5 The runtime state directory (inside the project)

```
.omz/
├── config.json                    # optional: a machine-private profile override (highest precedence, §3.3; gitignored)
├── goal/<stem>.json               # the ultrawork goal (outcome + binary success criteria + termination conditions + the constitution checklist)
│                                  # stem takes two forms (§13 B30): ① the real sessionId; ② when it cannot be obtained,
│                                  # `<ISO timestamp>-<short git HEAD hash>` (the hash slot is `nogit` outside a git repo)
│                                  # locating a goal always goes through boulder.json's active_goal pointer, never inferred from the filename
├── drafts/<slug>.md               # ulw-plan's draft/approval-gate record (the dual-artifact semantics of §7.5.1)
├── plans/<slug>.md                # the wave-partitioned plan produced by the planner (waves delimited by `## Wave <n>`, §7.5.1)
├── research/<slug>/               # ulw-research output (intent.md + report.md/html/pdf/docx)
├── ulw-execute/ledger.jsonl       # the per-event append ledger of execution orchestration (§7.5.2)
├── runtime/
│   ├── coordinator.sqlite         # the persistent state database of the orchestration profile (**one database, many teams**, v1.4 revision below)
│   └── <teamId>/                  # the per-team file area of Team Mode (§7.3)
│       ├── state.json             # the lightweight state mirror/recovery index of the core profile (including the agent_ref↔task_id map)
│       ├── tasks/<taskId>.json    # fallback task files when there is no coordinator
│       ├── inboxes/<member>/<uuid>.json
│       └── results/<taskId>.json  # member completion reports
├── .mode-injected-<sessionId>     # the session-level dedupe marker of the M2 hook (§8.2)
└── boulder.json                   # session continuation state (written actively by the main agent after each wave collection point, §17 ruling 4)
```

**v1.4 revision: the coordinator is one database for many teams, not one database per team.** v1.3 drew `coordinator.sqlite` under `runtime/<teamId>/`, implying a database per team; the implementation chose a single database — the `teams` table + `omz_status(team_id)` *is* a multi-team registry, `omz_team_create` generates `team_id` server-side, and splitting databases would instead make cross-team audit queries (beyond "only one active team at a time", §12.5) impossible. `OMZ_COORDINATOR_DB` in `.zcode-plugin/plugin.json` therefore points at `${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite`. If isolation is genuinely required (for load testing, say), the mounting side can point `--db` / `OMZ_COORDINATOR_DB` at any path; the server assumes nothing about where the database lives. The §12.5 argument for "runtime isolated by teamId" is therefore restated as depending on **the per-team file area + the in-database `team_id` foreign key**, not on separate databases.

When the coordinator is enabled, SQLite is the single source of truth for tasks/dependencies/leases/mailbox, and the JSON directories serve only as a readable mirror and audit export; the file fallback is only enabled when the coordinator is unavailable, and writing to both state stores at once (which would fork state) is forbidden. Plan filenames always use `<slug>.md` (unified in v1.4: v1.3's §6 wrote `<id>.md` and this section wrote `<planId>.md`, while the implementation uses `<slug>.md`).


---

## 4. The role system (9 agent files + reuse of the built-in Explore, 10 roles in total)

The full set of frontmatter fields empirically available (confirmed by the judge.md sample + the engine parse chain): `name` / `description` / `tools` (a YAML array) / `model` / `thoughtLevel` / `permissionMode` / `maxTurns` / `memory` / `color` / `mcpServers`.

| subagent_type | OmO counterpart | Responsibility | tools | maxTurns | thoughtLevel | color |
|---|---|---|---|---|---|---|
| `omz-reviewer` | Momus | The review gate: pick holes in completed work, graded blocker/major/minor + line-number citations; at most 2 re-reviews | `[Read, Bash]` (no Edit/Write = a structural constraint, confirmed at the behavior level in v1.5; Bash being read-only is a disciplinary constraint, see below) | medium | high | red |
| `omz-oracle` | Oracle | Architecture consulting and hard debugging: analyzes and proposes, never touches code | `[Read, Bash]`, same three-layer model | medium | max | purple |
| `omz-critic` | Metis | Gap analysis before a plan is finalized: missing scenarios, implicit assumptions, dependency risks | `[Read, Bash]`, same three-layer model | low | high | orange |
| `omz-planner` | Prometheus | Interview-driven strategic planning: asks clarifying questions first, then produces a wave-partitioned plan written into `.omz/plans/` | `[Read, Bash, Write]` | medium | high | blue |
| `omz-deep` | Hephaestus | Deep autonomous coding: given the goal, not the steps, implements end to end; explores the codebase first (via Bash grep/find; subagents cannot spawn) | full tool set | **high but bounded** (the runaway guardrail) | high | green |
| `omz-junior` | Sisyphus-Junior | A focused single-task executor; a leaf executor (no Agent in its tool surface, so delegation is structurally impossible) | full tool set | medium | medium | green |
| `omz-atlas` | Atlas | The /ulw-execute execution session: **wave state machine + dispatch-proposal generator + reporter** (does not spawn, does not implement, §17 ruling 1) | full tool set | medium-high | high | green |
| `omz-librarian` | Librarian | Document and code retrieval: fetches the full text of known URLs + local evidence, with source citations (**no WebSearch**, §17 ruling 2) | `[Read, Bash, WebFetch]` | low | low | cyan |
| `omz-looker` | Multimodal Looker | Multimodal analysis: screenshots/PDF page images/charts, serving visual-qa; Bash is only for enumerating image paths (no format conversion) | `[Read, Bash]` | low (15) | — | yellow |
| `Explore` (built-in, reused) | Explore | Fast repository scans; the built-in role is not redefined (its read-only tool set inherently has no Agent tool, so nesting is empirically structurally impossible) | engine built-in | — | — | — |

Note (the v0.5 empirical revision): the subagent tool list has **no standalone Grep/Glob tools** (B20), so file search goes through Bash's grep/find/rg; that is why the read-only roles all carry Bash instead of Grep/Glob. Subagents have **no Agent tool** (empirically verified in V5), so nested delegation is structurally impossible at the tool layer — "no further delegation" is upgraded from prompt discipline to a structural guarantee.

Note (the v1.4 implementation revision): ① `omz-atlas` shifts semantically from "dispatcher" to "dispatch-proposal generator" — it is itself the party being spawned, so being unable to spawn while also being forbidden to implement made the whole role unexecutable under the old semantics (§17 ruling 1); ② `omz-librarian` drops `WebSearch` — the engine has the tool name and classifies it under `isReadOnlyTool`, but **it is absent from the actual tool surface of the current deployment** (§17 ruling 2, §13 B24); ③ `omz-looker` gains `Bash` and its maxTurns rises to 15 — it originally had only `Read`, and since Read needs exact paths, without Bash it cannot enumerate the images to inspect and is effectively unusable; the price is that it is no longer "completely structurally read-only", and its body text mandates that Bash be limited to `ls`/`find` enumeration.

Note (the v1.5 installed-environment empirical confirmation): the tools column of this table has been **checked by spawning each agent inside a real session** (V12, §10.1) — the measured tool surfaces of the five restricted roles (critic/oracle/reviewer/librarian/looker) **all lack Edit**, the three full-tool roles (deep/junior/atlas) **have Edit**, and each matches its frontmatter declaration item by item; **none of the 9 roles holds `Agent`** (a behavior-level re-verification of V5), **none holds `Grep`/`Glob`** (a re-verification of B20), and **not even the full-tool roles have `WebSearch`** (behavior-level confirmation of §17 ruling 2). At the same time the tool surface was found to contain **one extra tool never declared in frontmatter, `RespondToCoordinator`** — engine-injected and not bound by the whitelist (the third layer below, §10.3 item 11).

Design points:

- **The read-only nature of the quality roles is three-layered, not a single "structural guarantee"** (v1.4 split out the first two layers per §17 ruling 3; v1.5's installed-environment measurements added the third):
  - **Structural constraint (hard)**: the `tools` whitelist excludes `Edit`/`Write`/`ApplyPatch`, so at the engine level those tools cannot be obtained and the reviewer cannot change code with an editing tool. **v1.5 has obtained behavior-level confirmation**: the measured tool surfaces of the five restricted roles indeed lack Edit (previously there was only static validation + inference from the engine parse chain, §10.1 V12).
  - **Disciplinary constraint (soft)**: `Bash` is classified by the engine as `isWriteTool` **and** `isDestructiveTool` (§10.3 item 5), and `>` redirection, `node -e fs.writeFileSync` and `git checkout` can all change files. So "the reviewer physically cannot change code" is **wrong**; the accurate statement is "the reviewer has no editing tool, and its prompt explicitly forbids writing through Bash". **All 5 quality roles (critic/oracle/reviewer/librarian/looker) hold Bash and are therefore all subject to this layer — before v1.4 `omz-looker` was the one pure `[Read]` role, but that left it unable to obtain image paths and thus unusable (revision note ③ of this section).**
  - **The engine-injected surface (uncontrollable, added by v1.5's installed-environment measurements)**: **the real tool surface of a read-only role = the frontmatter whitelist ∪ the engine-injected tools**. The measured tool surfaces of all 9 subagents **contain `RespondToCoordinator`**, including the narrowest form `tools: [Read, Bash]` — that tool is **declared in no frontmatter and is not bound by the whitelist** (§10.3 item 11). The implication: the whitelist is the upper bound on "what we can declare", **not the entirety of the tool surface**; any inference of the form "this role only has N tools" must leave room for engine injection. `RespondToCoordinator` currently only replies and writes no files, so it does not weaken read-only-ness; but **what the engine injects in the future is the engine's decision, and this layer has no control point on the OMZ side** — it can only be discovered by re-measuring the tool surface after installation (the doctor's spawn ping already has that capability).
  - **A path to tightening: there is none (fixed as terminal in the last round of v1.4)**. The `permissionMode` enum has been extracted by engine reverse-lookup (§10.1 V8), and **no value in it can remove an individual tool** — the closest, `plan`, is a global mode rather than a tool whitelist, and using it would collaterally destroy the necessary read-only Bash usages such as looker enumerating image paths and librarian gathering local evidence. So the three-layer model (Edit/Write structural + Bash disciplinary + an uncontrollable engine-injected surface) **is terminal, not transitional**, and agent body text must state the nature of this constraint (already implemented); do not keep hoping some frontmatter field will complete it into a structural guarantee (§17 ruling 3).
- **maxTurns set for everyone**: the engine confirms it is configurable per agent, and this is a far harder runaway guardrail than prompt discipline (§13 B6).
- **thoughtLevel tiering**: librarian uses low (fast retrieval), oracle uses max (deep reasoning), junior uses medium — the thinking tier is specified in frontmatter (engine-confirmed) and needs no spawn parameter.
- **description budget discipline**: the 9 descriptions are resident in the main session's system prompt (a fixed token tax). Each is ≤2 sentences, the first sentence must be the trigger condition ("delegate to this agent when…"), and the total is kept to roughly 400 tokens. judge.md proves the engine does not limit description length, but the cost and the risk of mis-dispatch are ours to control; role details all live in the body (loaded only when spawned).
- **The delegation protocol** (written into the /ulw prompt, derived from OmO's 7 task elements): `TASK / EXPECTED OUTCOME / REQUIRED SKILLS / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT`. CONTEXT must be self-sufficient (a subagent has a brand-new context and cannot see the main session's history, §12.4).

---

## 5. The category routing system

### 5.1 The eight categories (criteria taken verbatim from OmO)

| category | Criterion | Where it lands in OMZ |
|---|---|---|
| `visual-engineering` | Frontend, UI, CSS, design | `omz-junior` + omz-looker acceptance |
| `ultrabrain` | Hard problems, architecture decisions | Consult `omz-oracle` first, then `omz-junior` executes |
| `deep` | Deep coding, complex logic | `omz-deep` |
| `artistry` | Creative, novel approaches | `omz-junior` (the prompt allows aggressive options) |
| `quick` | Single file, typo-level edits | **The main agent does it itself, no spawn** (the throttle valve) |
| `unspecified-low` | General standard work | `omz-junior` |
| `unspecified-high` | General complex work | `omz-junior` |
| `writing` | Text, documentation | `omz-junior` (simple docs the main agent writes directly) |

Direct channels: exploration goes to the built-in `Explore`, retrieval to `omz-librarian`, planning to `omz-planner`, consulting to `omz-oracle`, **review to `omz-reviewer`**, visual inspection to `omz-looker`, and wave-by-wave driving of an approved plan to `omz-atlas` (filled in by v1.4: the implemented channels are a superset of this table, and the v1.3 specification omitted them).

### 5.2 Where the routing table lives

The mapping table is written into the /ulw command prompt (an orchestration-layer decision) and is not hardcoded into any agent — adjusting routing means changing one file.

### 5.3 Models and thinking tiers (corrected in v0.3)

v0.2 once asserted that "the thinking level cannot be specified per spawn" — there is indeed no spawn parameter, but the engine confirms that **frontmatter `thoughtLevel` can be specified per agent**, so the correction is:

- **Model**: frontmatter `model` takes a provider model ID (the engine has a complete SubagentModelRef parse chain + an Inherited inheritance factory; high confidence, V2 empirically wrapped up). If not written, the main session's model is inherited.
- **Thinking tier**: frontmatter `thoughtLevel` specified per agent (off/low/medium/high/max, provided the provider supports it).
- **Fallback chain**: ZCode has no such mechanism, so it is abandoned — a single model connected directly, and on failure the main agent re-dispatches to a different subagent_type.
- **The conservative tier (v1, if V2 fails)**: everyone inherits the main session's model and category only decides the routed role; thinking-tier differences likewise stop working, and the throttle valve still applies.

---

## 6. The ultrawork lifecycle (/ulw)

The body of the /ulw command *is* the ported ultrawork system prompt (a ZCode rewrite of OmO's `prompts/ultrawork/default.md`). All eight steps are preserved, and steps 6/7/8 are the core of the quality protocol:

**On "the eight steps" and the implementation's "step zero" (made explicit in the last round of v1.4)**: `commands/ulw.md` now has an extra **step zero: the session identifier** (the fix for B30), and the numbering of steps one through eight is unchanged. **This document keeps referring to the lifecycle as "the eight steps"** — the eight are **semantic phases** (activation → registration → inventory → certainty → planning → execution → verification → review and submission), while step zero is a **mechanism step at the implementation layer** (using an inline execution block at command expansion time to fetch one engine variable and produce the filename stem later steps need); it is neither a working phase nor a producer of any deliverable, so it does not count towards the phases. The reasons for choosing this wording over renaming it "nine steps": ① the eight steps come from OmO's ultrawork protocol and are the anchor for the item-by-item comparison in §7.5, so changing the number would desynchronize the porting comparison tables and the wording in the skills; ② the existence of step zero depends on the host (if the engine ever provides sessionId in `<env>`, it should disappear), and mixing host-adaptation detail into the semantic phase numbering would make the protocol drift with the host. Wherever implementation detail is involved (appendix B, `commands/ulw.md`), the wording is explicitly "the eight steps + step zero, the session identifier, in front".

1. **Activation**: output `ULTRAWORK MODE ENABLED!` and load this prompt as the working constitution.
2. **Goal registration**: the goal is written into `.omz/goal/<stem>.json` — outcome-first, with **binary success criteria that can fail** and explicit termination conditions. **There is exactly one source for stem** (corrected in the last round of v1.4, §13 B30): the `OMZ_GOAL_STEM` output by the ` ```! ` inline execution block of `/ulw`'s **step zero: the session identifier**. Two naming forms — ① when the real sessionId is obtained, stem *is* the sessionId (`.omz/goal/<sessionId>.json`); ② when it cannot be obtained, a deterministic fallback of **`<ISO timestamp>-<short git HEAD hash>`** (outside a git repo the hash slot is written as `nogit`). **That the main agent cannot obtain the sessionId is an established fact** — `${ZCODE_SESSION_ID}` is only expanded in hook/MCP/command-execution-block contexts, and neither the Bash tool's env nor the system prompt's `<env>` block has it, so **fabrication is strictly forbidden** (things like `sess_x`/a timestamp/`unknown` are self-consistent within the round, the board still renders, the doctor cannot detect it — a false success with exit code 0, B30); if the whole execution block fails, stop and ask the user. The same goal file stores the "constitution checklist" (review-gate trigger conditions, dual-evidence requirements, throttle-valve rules), which the lead self-checks before every submission point (§13 B17, guarding against quality decay). **Immediately** after writing the goal, create/update `.omz/boulder.json`: **`active_goal` (a forward-slash relative path) is the single authoritative pointer for finding the goal again across sessions**, while `session_ids` is only an audit clue and **never participates in locating files, at any time**. When continuing, open the old goal file strictly by `active_goal`; do not guess from the current sessionId and do not reverse-engineer a filename from `session_ids` — a new session's stem is necessarily different, so guessing is necessarily wrong (§13 B18/B30).
3. **Skill inventory**: enumerate the available skills (OMZ's 4 + whatever the user has installed) and state which are chosen and why.
4. **Certainty assurance**: no code may be written before being 100% certain. Dig into intent → spawn the built-in `Explore` in parallel → if doubt remains, consult `omz-oracle`; ambiguity that cannot be removed must be taken to the user.
5. **Planning**: meeting any one condition (≥2 steps / multiple files / contains an architecture decision) forces dispatching `omz-planner` for interview-driven planning, producing `.omz/plans/<slug>.md` (waves delimited by `## Wave <n>` headings, §7.5.1); it is finalized after gap analysis by `omz-critic`. **Tests and implementation for the same scenario must never run in parallel.**
6. **Execution**: the main agent only orchestrates and does not implement (trivia excepted). TODOs use the uniform format `path: <action> for <scenario> — verify by <check>`, TodoWrite keeps a single in_progress; delegation follows the 7 elements; omz-junior is the leaf executor (its tool surface makes further delegation structurally impossible).
7. **Verification**: RED→GREEN→SURFACE→REFACTOR→REGRESSION is mandatory; **dual-evidence acceptance** — ① test output (test ID + assertion message, both states) + ② a real artifact (command transcript / curl status code + body / screenshot). Written out in plain text: "tests pass" alone is NOT evidence. QA resources (ports, temporary directories, background processes) are cleaned up and a receipt is kept.
8. **The review gate and submission**: when a trigger condition is met (strict task wording / ≥3 files / ≥20 turns / ≥30 minutes / refactor, migration, performance or security work), dispatch `omz-reviewer`, **at most 2 re-reviews**; if blockers remain, stop and report to the user; every verified minimal increment gets one atomic commit (before committing, `git log --oneline -20` to imitate the history's style).

**Wrap-up persistence (corrected in v1.4, §17 ruling 4)**: `.omz/boulder.json` is **written actively by the main agent after each wave collection point** — the Stop hook is **not implemented** (hooks.json only registers `UserPromptSubmit`), so "the Stop hook persists it on abnormal termination" is an unimplemented M4 item. The continuation guarantee therefore currently comes from the frequency of active persistence rather than from a termination hook; abnormal termination (the process being killed, the session crashing) loses whatever progress followed the last collection point, and this is a known gap (§13 B17).


---

## 7. Team Mode (/team)

### 7.1 Mechanism differences from OmO (updated for the local coordinator design)

| OmO | The local OMZ implementation |
|---|---|
| Members are resident and poll a mailbox | ZCode Agents as short-lived workers; the coordinator persists `agent_registry`, `resume_ref` and the lease; if resume works it is reused, otherwise the original results rebuild the worker |
| Members claim tasks actively | The coordinator MCP's `omz_task_claim` makes an atomic claim; the main agent is responsible for binding ready tasks to ZCode Agents, and it may not assume a worker will call MCP on its own |
| P2P communication between members | The coordinator MCP's `send/receive/ack` provides a semantically equivalent mailbox; it is **not** a ZCode-native agent-to-agent channel |
| Mailbox file delivery (3s polling) | A SQLite mailbox + MCP pulls; without a coordinator it falls back to JSON inboxes, and notifications serve only as reminders |
| tmux pane visualization | /omz-status + an optional Electron dashboard/SSE + the GUI task panel |

**The boundary**: the coordinator can make identity, tasks, messages and audit persist across processes, but it cannot keep the memory and native context of an already-exited ZCode agent resident forever; and it cannot promise automatic wake-up or resume across restarts, which the official ZCode API does not publish.

### 7.2 The coordinator MCP and the DAG protocol (new)

The coordinator is OMZ's own stdio MCP sidecar, launched by the ZCode plugin-host; it is not an official ZCode Team API. The tool set comprises **13** tools (the v1.3 specification listed 11, and the implementation added 2, §17 ruling 9):

**The tool names in the table below are logical (bare) names, not real names that can be called directly (corrected in the last round of v1.4).** The engine names a plugin MCP server `plugin:<pluginName>:<serverKey>`, and the tool name exposed to the model is `mcp__plugin_<pluginName>_<serverKey>__<toolName>`. For this plugin `pluginName=omz` and `serverKey=omz-coordinator` (`.zcode-plugin/plugin.json`), so the real name of `omz_team_create` is **`mcp__plugin_omz_omz-coordinator__omz_team_create`**.

- **Bare names are kept in the table purely for readability** (13 rows of long names would blow the table apart, and the cross-references in §7.3/§13.5 all use bare names).
- **The caller (the main agent) must match by suffix against its own tool list to obtain the real name on the spot** (as in "the one ending in `__omz_task_claim`") and **must not hardcode the long name** — one change in the plugin name or the serverKey and a hardcoded name is wrong again.
- **Calling a literal bare name gives tool-not-found**. This failure mode is hard to diagnose: `/team` has the core wave-parallel fallback, so the symptom is not an error but "orchestration is clearly enabled yet everything keeps running in the degraded tier". The correct reaction to a missing tool is to judge that the profile is not enabled / the MCP is not connected (`mcpServers.omz-coordinator.enabled` defaults to `false`), take the fallback directly and **tell the user explicitly that this is the degraded tier and why**, rather than guessing at names.
- `commands/team.md` is already implemented this way (bare names in writing + suffix matching to get the real name + degrade and inform when not found).
- **That workers can see MCP tools is an established fact (empirically measured in v1.5 after installation)**: the measured tool surface of full-tool subagents contains the complete `mcp__openviking__*` (11 tools) and `mcp__node_repl__js*` (3 tools) (§10.3 item 12). So **stop using "workers cannot see MCP" as a reason** — once the coordinator MCP is enabled, the worker side is very likely to see the entire `mcp__plugin_omz_omz-coordinator__*` tool set directly, including tools such as `omz_task_claim`/`omz_task_complete` that **change scheduling state**.
  - **The constraint in step 4 of `commands/team.md`, "do not assume a worker will call MCP on its own", still holds and must be kept**, but **its reason has to change**: not "it cannot see them" but "**the semantics of claiming and reporting are controlled by the main agent**". The protocol constrains the right to call through **discipline**, not through visibility (the same wording is in §7.4).
  - **Why the distinction matters**: a constraint propped up by "cannot see it" is a **fake structural guarantee** — it will fail silently under some engine change or profile combination, whereas a discipline-based constraint is at least explicit and auditable in the prompt. This shares its root with the three-layer conclusion of the read-only model in §4: **visibility is not permission**.
  - **Residual risk and backstops**: if a worker overreaches and claims/completes directly, the coordinator side still has owner validation (§13.5 I8), the terminal-state guard and one-time consumption (I7), and idempotency keys bound to the task (I9) to stop damage at the data layer; but **disorder at the semantic layer** (marking something done without going through the main agent's collection point) is not caught by those three, and can only be prevented by explicit MUST NOT DO clauses in the 8-element prompt plus collection points that only recognize results files (§7.3).

| Tool (logical name) | Input | Atomicity guarantee / output |
|---|---|---|
| `omz_team_create` | `name`, `max_parallel`, `metadata` | Generates a stable `team_id`, builds the graph and the audit event |
| `omz_dag_submit` | `team_id`, `tasks[]`, `deps[]` | Transactionally writes tasks and dependencies, returns `graph_id` |
| `omz_task_claim` | `graph_id`, `agent_ref`, `lease_seconds` | `BEGIN IMMEDIATE` + a single-transaction claim, returns one ready task or nothing; **`attempts += 1` at claim time** |
| `omz_task_heartbeat` | `task_id`, `agent_ref`, `extend_seconds` | Only the owner can extend the lease |
| `omz_task_complete` | `task_id`, `agent_ref`, `result_ref`, `idempotency_key` | Validates the owner + the **terminal-state guard**, completes the task, and decrements downstream `deps_remaining` **exactly once** (§13.5 I7) |
| `omz_task_fail` | `task_id`, `agent_ref`, `error`, `retry_at` | Validates the owner (aligned with complete, §13.5 I8); only allowed on `running`; either becomes ready again per the retry budget or enters the dead-letter |
| `omz_mail_send` | `to_agent`, `from_agent`, `task_id`, `payload`, `dedupe_key` | `dedupe_key` is unique, at-least-once delivery |
| `omz_mail_receive` | `agent_ref`, `limit` | Pulls unacked messages in seq order |
| `omz_mail_ack` | `message_id`, `agent_ref` | Idempotent acknowledgement |
| `omz_status` | `team_id` | Returns an agents/tasks/mailbox/events summary (7-state counts + the transport/coordinator dimensions) |
| `omz_team_shutdown` | `team_id`, `force` | Marks the terminal state, refuses new claims |
| **`omz_reclaim_expired`** | `graph_id` (optional), `limit` | **New in v1.4**: reclaims tasks whose lease has expired (over budget goes to the dead-letter, otherwise back to ready) and sets the original owner's `transport_state` to `unknown`. The original §7.2 table had no entry point for lease reclamation, yet both I3 and I4 require "an expired lease may only be re-dispatched" — **with no entry point an expired task is stuck in running forever** and the DAG deadlocks outright |
| **`omz_export_mirror`** | `team_id` | **New in v1.4**: projects the SQLite source of truth into the JSON mirror of §7.3 (4 states + the raw `coordinator_state`), for audit and for `/omz-status` to read |

**Transaction boundaries SQLite must obey** (v1.4 corrected two defects in the v1.3 example):

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;
UPDATE tasks
SET status = 'running', owner_agent = :agent,
    lease_until = :now + :lease_seconds,     -- a parameterized timestamp, not the DB-side unixepoch()
    attempts = attempts + 1,                 -- the counting point is the claim (see below)
    updated_at = :now
WHERE id = (
  SELECT id FROM tasks
  WHERE graph_id = :graph
    AND status = 'ready'
    AND deps_remaining = 0
    AND (retry_at IS NULL OR retry_at <= :now)   -- tasks inside a backoff window must be filtered out
  ORDER BY priority DESC, id
  LIMIT 1
)
RETURNING id, payload, lease_until, attempts;
COMMIT;
```

- **The `retry_at` filter cannot be omitted** (§17 ruling 10): the v1.3 example lacked this line, and copying it verbatim makes failed tasks inside their backoff window be re-dispatched immediately, leaving backoff a dead letter.
- **Timestamps are always parameterized**: v1.3 used the DB-side `unixepoch()`, which conflicts with testability (a fixed clock cannot be injected for deterministic assertions). The implementation has the caller pass `now`.
- **`now` must never appear in the inputSchema of an outward-facing MCP tool**: during implementation this turned out to be an attack surface any worker could exploit — `omz_reclaim_expired({now: <a future timestamp>})` can judge **someone else's unexpired lease** to be expired and steal it, which amounts to handing the scheduler's clock to the caller. The rule: time is only taken by the server process itself, and `now` is only an internal function parameter (§13.5 I3 is synchronized with this).
- **The counting point for `attempts` is the claim** (§17 rulings 9/8): `max_attempts = N` means **N executions in total** (not "N retries" = N+1 executions). v1.3 did not define the counting point, and the two readings differ by one execution.

`RETURNING` is not itself a lock; `BEGIN IMMEDIATE` is what takes the write transaction. A worker **must not hold a SQLite write transaction** while doing external work; completion opens another short transaction. WAL is still single-writer, and on `SQLITE_BUSY` it retries with bounded backoff. All `complete/fail/send/ack` use idempotency keys, the semantics are at-least-once, and exactly-once is not promised; an idempotency key **must be validated as bound to its task** (§13.5 I9).

**Recommended choices**:

- **CodeGraph**: prefer connecting `@colbymchenry/codegraph` directly (MIT, Windows x64/arm64, bundled Node runtime, `codegraph init` creates `.codegraph/`, `codegraph serve --mcp` provides `codegraph_explore`). Sources: [the upstream README](https://github.com/colbymchenry/codegraph), [MCP tools](https://github.com/colbymchenry/codegraph/blob/main/src/mcp/tools.ts), [the OmO bridge](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/codegraph).
- **Task queue**: evaluate `vardiya` first (MIT, Node >=22, SQLite WAL, atomic claim, heartbeat/stalled recovery, retry/backoff/DLQ, priority/delay/cron; it has Windows benchmarks, but full support still requires M1 acceptance). If its API/dependencies are too heavy, use the self-built coordinator; do not default to the LGPL-licensed sidequest or the GPL-licensed Dagu.
- **Mailbox reference**: `MCP Agent Mail` (open source, Git archive + SQLite FTS5 + registration/send/fetch/ack/reservation) is worth borrowing from for its protocol and audit model; its Windows support/license are not fully verified in the current evidence, so it is not a default dependency for now.

### 7.3 State file formats (the core-profile fallback format / the coordinator mirror format)

**The two-layer state model (made explicit in v1.4, §17 ruling 6)**: the coordinator's `tasks.status` is a **7-state source of truth** — `blocked | ready | running | done | failed | dead | unknown`. Scheduling needs `blocked/ready` (to distinguish "dependencies not met" from "can be dealt out") and `dead` (the dead-letter), and §13.5 I3 additionally requires `unknown` (the transport layer is undecidable after a lease expires). The 4 states v1.3's §7.3 listed (`pending|running|done|failed`) are not the source of truth but a **mirror projection**:

| Coordinator fact state (7) | Mirror projection state (4) | Notes |
|---|---|---|
| `blocked` / `ready` | `pending` | Neither has started; a human reader need not distinguish them |
| `running` | `running` | — |
| `done` | `done` | — |
| `failed` / `dead` / `unknown` | `failed` | All three read as "did not make it" to a human, but **they must be distinguished through `coordinator_state`** |

The projection **must preserve the original state as well**: for each task `exportMirror()` writes, besides `status` (4 states), a `coordinator_state` (the raw 7-state value). Otherwise the audit mirror loses the distinction between dead-letter (the retry budget is exhausted and it will never be dealt out again) and unknown (reclaimable and re-dispatchable) — and the operational action for those two is completely different. Likewise, `transport_state` (in the agents table: whether the ZCode agent is still alive) and `coordinator_state` are two independent dimensions and must never be inferred from each other (§13.5 I3).

**The identifier scheme uses numeric task ids (corrected in v1.4, §17 ruling 7)**: the v1.3 example's `depends_on` used the task key, but the unique constraint is `UNIQUE(graph_id, key)` — **reusing the same key across graphs within one team makes the mirror chain tasks from different graphs together**. The implementation switched to expressing relationships with `id` (numeric, globally unique), keeping `key` as the in-graph business identifier and `depends_on_keys` for humans only:

```jsonc
{
  "id": 42,                              // the numeric primary key, the unique identifier inside the mirror
  "key": "T-003",                        // the in-graph business key (UNIQUE(graph_id, key))
  "graph_id": 7,
  "team_id": 3,
  "wave": 2,
  "title": "……",                         // \r\n\t stripped, | replaced, truncated before it lands in the table (§13 B27)
  "status": "pending | running | done | failed",   // the 4-state projection
  "coordinator_state": "blocked | ready | running | done | failed | dead | unknown",
  "subagent_type": "omz-junior",
  "attempts": 1,                          // +1 at claim time; max_attempts=N means N executions in total
  "prompt": { "task": "...", "expected_outcome": "...", "must_do": [], "must_not_do": [], "context": "..." },
  "depends_on": [40, 41],                 // an array of numeric ids (for machines)
  "depends_on_keys": ["T-001", "T-002"],  // the corresponding keys (for humans)
  "result_file": "runtime/<teamId>/results/42.json"   // a forward-slash relative path (B3/B25/B26)
}
```

Without a coordinator, `.omz/runtime/<teamId>/tasks/<taskId>.json` uses a subset of the same schema (no `graph_id`/`coordinator_state`, and `status` is directly the 4 states); once the coordinator is enabled, SQLite is the single source of truth, the JSON is generated only by `omz_export_mirror`, and hand-editing it is forbidden.

### 7.4 The resume adapter (an optional enhancement, not an official stable contract)

This time `agent_id` and a SendMessage continuation entry point were visible at ZCode's tool layer, and background agent completion notifications were observed in an actual session; but ZCode's official public subagent documentation promises no resume token, no recovery across restarts, no cancellation, no progress and no agent-to-agent API. Therefore:

- **Baseline**: task-level workers; each task is spawn → execute → return → coordinator `complete/fail`, with no dependence on resume.
- **Optional path**: if SendMessage is available for that `agent_id` within the same run, append clarifications or reuse the context; every resume association is written into `resume_ref`, and on failure a new worker is rebuilt from the results.
- **Forbidden promises**: do not describe resume as resident memory, automatic recovery across restarts, or exactly-once; recovery in a new session relies on coordinator state + a fresh spawn.
- **Boundary**: when resume fails (the session has been reclaimed, etc.), fall back to spawning again and merge the contents of the original results file into the new prompt's CONTEXT (§13 B9); a resume that is being waited on must be registered in TodoWrite.
- **Visibility is not the right to call (made explicit after v1.5's installed-environment measurements)**: the worker side **can see MCP tools** (measured: full-tool roles see the complete `mcp__openviking__*`, 11 tools, + `mcp__node_repl__js*`, 3 tools, §10.3 item 12), and subagents additionally hold the engine-injected `RespondToCoordinator` (§10.3 item 11). So clauses in the coordinator protocol such as "workers do not claim/complete on their own, and state comes from the main agent's collection points" **cannot be backed by "it cannot see the tools"** — it can. These are **disciplinary clauses**, they must be spelled out one by one in the MUST NOT DO of the 8-element prompt, and the data layer must be backstopped by owner validation (§13.5 I8) / the terminal-state guard (I7) / idempotency binding (I9) on the coordinator side. **V4 being unverified does not change this**: whether or not resume works, the boundary of the right to call is defined by protocol discipline.
- Engineering behavior (notification timing, whether resume can happen more than once, the validity period after a session closes) is pending empirical verification in an installed environment (V4, §10.2; the v1.5 smoke test used a fresh task-level spawn throughout and never touched the resume path).


---

## 7.5 The skill layer compared: OmO's original protocols → the OMZ port

What follows is an item-by-item comparison based on the **original text** of the four SKILL.md files under OmO's `packages/shared-skills/skills/` (fetched 2026-09-01 from the dev branch). These four skills are the actual carriers of OmO's orchestration capability — more central than the agent role definitions.

### 7.5.1 ulw-plan (Prometheus, the planning advisor) → the OMZ ulw-plan skill

| OmO original mechanism | The OMZ port | Status |
|---|---|---|
| Trigger strictness: activates only when the user explicitly says ulw-plan / asks for a work plan; "a bare ulw run is not a request"; metis/momus review is locked behind the two conditions "the user asked" + "a written plan file" | The trigger semantics are copied verbatim into the SKILL.md description (to prevent false triggering); the review lock conditions are written into the descriptions of omz-critic/reviewer | ✅ directly portable |
| Mode stickiness: within the session, "do X"/"fix X" are all handled as "plan X"; "delegated implementation is still implementation" | Written into the skill body as well | ✅ |
| Intent routing CLEAR/UNCLEAR + the `review_required` flag + review-modifier gate triggers ("high accuracy" etc. → force dual review) | All preserved; dual review maps to two spawns, omz-reviewer + omz-oracle | ✅ |
| Draft/plan dual artifacts: `.omo/drafts/<slug>.md` (the recovery point) → after approval `.omo/plans/<slug>.md`; produced by the scaffold-plan.mjs script | **Simplified**: a single `.omz/plans/<slug>.md` + `.omz/drafts/<slug>.md` (the dual-artifact semantics are preserved, and the draft doubles as the approval-gate record); the script becomes a command template (ZCode has no precedent for a skill shipping a scaffolding script, so the agent writes the file from the template by hand — behaviorally equivalent, one dependency fewer) | ⚠️ simplified |
| Plan artifact syntax: zero-column checkboxes `- [ ] N. <title>` / final-verification lines `- [ ] F<n>. <title>` / the nested `Recommended task executor category:` annotation | **Ported verbatim** (this is the machine contract between ulw-plan and ulw-execute, not one character changes); the annotation values map to the category table of §5.1 | ✅ |
| Wave delimiter | **`## Wave <n>` (a Markdown level-2 heading, an additional rule in v1.4)** — v1.3 only specified the checkboxes and the category annotation and never fixed the wave delimiter, so during implementation both `Wave <n>:` and `## Wave <n>` appeared. Like the checkboxes it is a machine contract between ulw-plan and ulw-execute (Atlas splits waves by it, `/omz-status` groups by it), so it must be unique | ✅ contract fixed in v1.4 |
| Spawning read-only subagents explore/librarian/metis/momus + the four elements "TASK/DELIVERABLE/SCOPE/VERIFY" | Mapped to the built-in Explore / omz-librarian / omz-critic / omz-reviewer; the four elements are merged into the 7-element protocol. **Prometheus is itself the party being spawned and cannot spawn** (V5) — its "spawning" is in fact **producing a dispatch proposal + handing back to the main agent**, made explicit by the skill body and the agent body (§17 ruling 1) | ✅ semantically equivalent (rewritten as handing back to the main agent) |
| Two filters (already-collected evidence can answer → explore; intent + a defensible default can answer → adopt without asking) + owner-decisions must be asked | Copied verbatim | ✅ |
| OmO prefers codegraph_explore | ZCode can connect the upstream `@colbymchenry/codegraph` stdio MCP directly; only when the graph profile is not enabled does it fall back to the built-in Explore + Bash grep/rg | ✅ graph profile; core profile has an explicit fallback |

### 7.5.2 ulw-execute (the plan execution orchestrator) → the OMZ ulw-execute skill + /ulw

**Precondition (v1.4, §17 ruling 1)**: every occurrence of "dispatch/spawn" in this table must be read in OMZ as "**produce a dispatch proposal + hand back to the main agent**". `omz-atlas` is a spawned subagent whose tool surface has no Agent (V5); it is both forbidden to implement personally and unable to delegate — under v1.3's literal semantics that role **necessarily violates something the moment it is spawned** (either ORCHESTRATOR-NEVER-IMPLEMENTER, or it can do nothing at all). The implementation has rewritten it as "wave state machine + dispatch-proposal generator + reporter": it manages the ledger, the grading, the five gates and the ledger file, and produces directly pasteable 8-element prompts handed back to the main agent, which performs the spawn and receives the notifications. Only when **the main agent itself** runs the ulw-execute protocol is "dispatch" a literal spawn.

| OmO original mechanism | The OMZ port | Status |
|---|---|---|
| "ORCHESTRATOR — NEVER THE IMPLEMENTER": the root agent does zero implementation, zero product-file edits, zero personal QA | Copied verbatim into the /ulw constitution (merged with the exception wording of B21) | ✅ |
| Boulder state schema v2 (works/active_plan/session_ids/status/worktree_path) | **Adopted verbatim** (`.omz/boulder.json`, field names unchanged) + the OMZ extensions `active_goal`/`active_team`/`finished_at`. **The persistence moment changes to the main agent writing it actively after each wave collection point** — the Stop hook is not implemented (§17 ruling 4). **`active_goal` is the single authoritative pointer for finding the goal again across sessions; `session_ids` is only an audit clue and may be an empty array** — neither the main agent nor the subagents can obtain the real sessionId (§13 B30) | ✅ fields equivalent; persistence mechanism degraded; pointer semantics strengthened |
| git worktree discipline (PR/branch work must happen in a task-specific worktree; the main worktree is read-only) | Copied verbatim (Windows Git Bash fully supports git worktree); the same `git worktree lock --reason` review lock | ✅ |
| LIGHT/HEAVY grading (LIGHT by default; six classes of fact trigger HEAVY; never downgrade) | Copied verbatim | ✅ |
| The 8 dispatch elements (goal+scope / baseline characterization test + failing-first / constraints / verification commands / the Manual-QA channel / adversarial classes / artifact paths + cleanup receipts / tool expectations) | Merged into the 7-element protocol, expanded to 8 (adding the "baseline and failing-first proof" element). **Atlas only generates this 8-element text and does not perform the dispatch** (see the precondition of this section) | ✅ merged; the dispatching party becomes the main agent |
| The 9 ultraqa adversarial classes (malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions) | **Ported in full** (the trigger mapping table is copied verbatim; the rule "explore if applicable, record the reason if excluded" is copied verbatim) | ✅ |
| **The Sisyphus completion contract**: DoneClaim (task/changed_files/tests/manual_qa/cleanup/risks) → an independent AdversarialVerify (confirmed/false-positive/needs-fix/needs-human-review + evidence + repro + confidence); confirmed is the only pass; failure bounces back for re-dispatch | **Ported in full** — this is the nucleus of OmO's quality protocol. Verifier independence is satisfied naturally in OMZ (omz-reviewer and the executor are different spawn instances); the JSON schema is preserved verbatim in the review-work skill | ✅ |
| The watcher hangs on state, not on the clock; never poll/sleep; watcher trigger + verified evidence = tick the box | Adapted: ZCode's background notification mechanism (already demonstrated) + results files as the double confirmation = the watcher equivalent; "tick only after both notification and file confirm" is merged with the single-source-of-truth principle of B8. **Note that Atlas does not receive background notifications** (they only reach the main agent), so its only collection-point criterion is the results file | ✅ semantically equivalent; a single source of evidence on the Atlas side |
| Plan checkbox flipping + per-event append to ledger.jsonl | Copied verbatim (all fields of `.omz/ulw-execute/ledger.jsonl` are preserved, and the path is registered in §3.5) | ✅ |
| 10 hard rules (failing-first first / no dry-run / no tests-only / zero implementation by the orchestrator / adversarial classes must be explored / worktree discipline / session id prefix / no stale-memory) | Copied in full into the /ulw constitution checklist | ✅ |
| The delegation router's 8 categories + the Codex tier mapping | The category table is already in §5.1; the tier mapping is replaced by OMZ subagent_types | ✅ |
| mass-ulw / dag native tools | ZCode has no tools of the same name, but the coordinator MCP's `omz_dag_submit` + the SQLite `task_deps` provide a local DAG; only when the orchestration profile is not enabled does it fall back to serial wave dependencies | ✅ locally implemented; the native tool names differ |
| No-plan bootstrap (with no plan to choose, treat the user's words as the approval and call ulw-plan in reverse) | Copied verbatim | ✅ |

### 7.5.3 ulw-research (maximum-saturation research) → the OMZ ulw-research skill

| OmO original mechanism | The OMZ port | Status |
|---|---|---|
| The activation threshold (only an explicit research request) + overriding the exploration-bounding defaults | The trigger semantics are copied verbatim into the description | ✅ |
| The 5 epistemology documents (intent-diff / claim-graph / observation-manifest / verification-economics / cause-disappearance) | **Ported in full** (the document templates go into the skill's references/; the rule "a synthesis may only cite verified-claims that passed the gate" is copied verbatim) | ✅ |
| The scaling-floor table (a single-topic codebase starts at 3 explores / a full due diligence takes 15 workers) | The table is copied verbatim; but ZCode's parallel spawn has no notion of a team roster — the counts in the table are spawned directly as parallel background agents (V4's notification mechanism is already demonstrated to support this) | ✅ adapted |
| The EXPAND tail protocol (every worker reply must carry a `## EXPAND` LEAD/DEAD END; a missing tail = an incomplete reply) | Copied verbatim (this is a free recursive expansion mechanism, purely at the prompt layer, with no host dependency) | ✅ |
| Bounded excursion detours (four ENTER triggers / four EXIT / depth 3 escalates) | Copied verbatim | ✅ |
| Convergence rules (multi-faceted queries need ≥2 expansion waves; zero unexplored leads / 3 consecutive waves with no new lead / a 5-wave cap then ask the user) | Copied verbatim | ✅ |
| Phase 3 executes code to verify disputed claims (a minimal script + full output + CONFIRMED/REFUTED/PARTIAL) | Copied verbatim (subagents have Bash and can execute) | ✅ |
| Gating for non-code claims (≥2 independent source domains / ≥2 independent observation groups converging / a counter-search / a primary source / temporal evidence) | Copied verbatim | ✅ |
| teammode at full strength / one axis per member / layered mixing | There is no official ZCode team runtime, but the coordinator MCP provides team/registry/mailbox/lease; short-lived ZCode Agents are started per axis and parallelized to the scaling floor; resident memory and autonomous worker claiming cannot be promised | ⚠️ scheduling semantics filled in locally; not equivalent to an official Team API |
| PDF+DOCX dual output + chrome headless printing + pandoc | The toolchain is copied verbatim (both chrome and pandoc are available on Windows; the specific dependencies are verified at M1 installation) | ✅ |
| visual-QA always runs + the proofread gate (a dedicated writing worker proofreads) | Copied verbatim; visual-QA is carried by omz-looker, and proofreading goes through a writing-class delegation | ✅ |

### 7.5.4 review-work (5 agents reviewing in parallel) → the OMZ review-work skill

| OmO original mechanism | The OMZ port | Status |
|---|---|---|
| The 5-lane structure: Goal Verifier(oracle) / QA Executor(unspecified-high) / Code Reviewer(oracle) / Security(oracle) / Context Miner(unspecified-high); PASS only if all PASS | **Ported in full**: lanes 1/3/4 → omz-oracle ×2 + omz-reviewer; lanes 2/5 → omz-junior ×2 (or routed by category). All 5 spawned in parallel in one round (V4's background mechanism is already demonstrated) | ✅ |
| "The Oracle cannot read files — everything goes into the prompt" (DIFF+FILE_CONTENTS given in full directly) | Adapted: OMZ's omz-oracle **has Read/Bash** (empirically verified in V2) and can read for itself — but "critical context goes into the prompt" is kept for safety (the oracle's Read is for digging deeper, the prompt is for required reading) | ✅ enhanced |
| The Context Miner always searches git history (log/blame/--grep/reverted commits) | Copied verbatim (Bash git is available) | ✅ |
| Lanes are leaf agents, one verdict is final, a re-review is a brand-new spawn with scope limited to the delta | Copied verbatim (naturally consistent with V5's structural prevention of nesting) | ✅ |
| INCONCLUSIVE does not count as PASS; a silent lane → re-spawn a smaller reviewer → still failing → close safely and name it | Copied verbatim (adapted: ZCode background agents have TaskOutput/TaskStop as management primitives) | ✅ |
| Review worktree discipline (add → lock --reason → unlock+remove when done) | Copied verbatim | ✅ |

### 7.5.5 Summary of the comparison

**Directly connectable**: `codegraph_explore` (the upstream MIT CodeGraph MCP).
**Rebuildable locally into equivalent semantics**: Team Mode's tasks/identity/mailbox/lease/heartbeat/DAG/retry (the OMZ coordinator MCP + SQLite WAL), and the state and audit presentation of the Electron dashboard.
**Interaction differences that remain**: ZCode officially publishes no Team API, agent ID/resume token or native agent-to-agent communication; the coordinator can only persist that metadata and cannot keep the memory of an already-exited ZCode agent resident forever. The interactive native pane of tmux cannot be fully replicated, and Windows Terminal is only a debugging bypass.
**The core fallback**: with any optional profile switched off or broken, fall back to the native ZCode Agent + `/ulw` + wave parallelism; do not let an external dependency become a single point of failure in the main flow.

Conclusion: the skill layer is the **highest-fidelity** part of the whole port — OmO's four skills are themselves orchestration protocols written for an LLM (rather than code calling host APIs), so the host differences are mostly absorbed by the interaction-model differences already identified in §1.5.


---

## 8. Trigger mechanisms

### 8.1 M1: slash commands (zero risk, usable immediately)

- `/ulw <goal>` → the ultrawork mode prompt (`$ARGUMENTS` takes the goal)
- `/team <goal>` → Team Mode orchestration instructions
- `/hyperplan` → planning only (omz-planner + omz-critic), no execution
- `/omz-status` → the status board: a ```` ```! ```` multi-line execution block (engine-confirmed) runs a node script that reads `.omz/` and renders the wave × task × status table — it executes at command expansion time and does not depend on the main agent reading files; the render cap is 40 lines (the overflow is aggregated into a count summary) to keep inline execution output from inflating the context. **On injection sanitization the inline block is weaker than `tools/render-status.mjs` (a capability gap measured in v1.5, not a disclaimer)**: given the same malicious title containing a newline and a pipe, the inline block **renders one extra forged task row** (41 lines, with `T-999` on its own line), whereas `render-status.mjs`'s `cell()` squashes it into one line inside a cell (a constant 40 lines, with the pipe replaced by `¦`). So **any collection-point judgement must rely on the output of `render-status.mjs`**, and the inline block is only for a quick glance; the inline block deliberately stays a minimal fallback implementation without sanitization (the rationale and the measurements are in §13 B27)
- `/omz-doctor` → the self-check: spawn each agent for a ping, validate that the frontmatter model matches the registered provider models, and check whether `.omz/` is in .gitignore. **v1.5 installed-environment measurement: 9/9 spawn pings inside the session returned the passphrase** (V12 closed, §10.1); the spawn receipts also bring back each subagent's **self-reported tool surface and self-reported visible skill list**, which are the routine probes for the behavior-level verification of the B1 whitelist, B16 skill visibility, and changes in the "engine-injected surface" third layer of §4

### 8.2 M2: the UserPromptSubmit hook's keyword detection (a replica of IntentGate)

The engine hook schema is confirmed to allow UserPromptSubmit to return `additionalContext` (the injection capability exists; the behavior is pending empirical verification, V3). The design: a single-file node script scans the prompt for the keywords `ulw`/`ultrawork`/`team`/`hyperplan` and, on a hit, injects the corresponding mode prompt.

- **`matcher` plays no part in filtering on `UserPromptSubmit` (confirmed by engine reverse-lookup in the last round of v1.4, which **overturns this item's original v1.4 claim about "saving overhead"**)**: the engine's `hookRunner.run(t, r = {})` decides matching with `n6r(r, c.matcher)` — **the match value comes from the second parameter (options), not from the event payload**; and `runUserPromptSubmitHooks` (the engine symbol `RUr`) passes only `{ signal }` as options and **passes no `matchValue`/`matchValues`**. The implementation of `n6r(e, t)` is `if (!t) return true; let r = [...e.matchValues ?? [], ...e.matchValue ? [e.matchValue] : []]; return r.length === 0 ? true : [...new Set(r)].some(n => r6r(n, t))` — when a matcher exists but the match values are empty it hits the `r.length === 0` branch and **returns true unconditionally**. So the case-expanded regex `[Uu][Ll][Ww]|[Uu][Ll][Tt][Rr][Aa]|[Tt][Ee][Aa][Mm]|[Hh][Yy][Pp][Ee][Rr]` **never blocks a single prompt** on this event. Keeping it is a **harmless declaration of intent** (the same schema is used for tool-class events, where the matcher does apply to tool names, and the engine's matcher is case-sensitive, §1.5.2, so the character-class expansion is not wrong in itself), but **it must no longer be claimed to save overhead** — no matching happens at all.
- **The fixed cost once enabled (measured)**: with no coarse filter, enabling `keyword_hook` means **every user message starts one node process**, whether or not a keyword hits. The hook process is measured at about **126–132ms** (against a bare `node -e 0` baseline of 85–91ms on the same machine, i.e. roughly 40ms is the script itself and the rest is Node startup tax). That is the fixed entry fee for M2; leaving `keyword_hook` off by default is therefore not only conservatism about "the injection behavior is unverified" but also a cost decision. All the real decisions live inside the script (the precise judgement).
- **Standalone word boundaries and code-context exclusion**: a keyword must be a standalone word (neither side an ASCII letter/digit/underscore/hyphen — `\b` is unreliable for Chinese) and must fall **outside** inline backticks, triple-backtick blocks, quoted strings, and path tokens containing `/` or `.`. When several modes hit at once the priority is `hyperplan > team > ulw` (the more specific wins).
- **The index trap of case normalization (measured in v1.4)**: one must **`toLowerCase()` first and mask afterwards** (a single string). An earlier version masked the original string and compared indices after lowercasing each separately, but `toLowerCase` can change string length (e.g. `İ` → 2 characters), so once such a character appears before the masked region the indices shift and the real intent is silently swallowed.
- **The scan budget (new in v1.4, B29)**: the input window for masking analysis is `MAX_SCAN = 32KB` (the leading 24KB + the trailing 8KB analyzed as two independent segments, so an unclosed triple backtick in the head window cannot straddle the splice point and swallow the tail window), with a self-imposed time budget of `SCAN_BUDGET_MS = 1500` (half of `timeoutMs: 3000`); over budget it returns no injection plus `reason: 'budget-exceeded'`. Better to miss a detection once (the user can still type `/ulw` explicitly) than to be killed by the engine's timeout and emit zero bytes.
- **The injected-body budget (rewritten in v1.5 from engine forensics)**: the decision object is **the complete JSON payload on stdout** — `payloadBytes(text) = Buffer.byteLength(JSON.stringify({additionalContext}), 'utf8')` — not the `additionalContext` string. The engine's default `maxOutputBytes` is **32768** (five identical defaults in this machine's `zcode.cjs`; the `65536` of the earlier text came from the dead top-level field of `hooks.json` that the engine never reads and that v1.4 deleted), so the self-imposed budget is `MAX_PAYLOAD_BYTES = 24576` (32768 − 8192, a 25% margin, because a user or workspace config may lower `maxOutputBytes` and the hook process cannot read that value). **Over the limit nothing is truncated — the whole injection disappears silently**: `OutputCollector.append()` drops the remaining chunks once `inlineBytes >= maxInlineBytes` (it only sets a `truncated` flag that the hook path never reads), and `parseHookStdout()` then runs `try{JSON.parse(r)}catch{return}` on half a JSON document → `undefined`, with no kill, no non-zero exit code and no error whatsoever; the only symptom is "the hook seems to have had no effect". Degradation therefore has three levels — `full` → `headings` (the head + the complete section-heading list + a prompt) → `minimal` (the head + one line telling the user to run `/<mode>` explicitly) — with `fitToPayload()` as a hard-trim backstop at the end, so no return path can be "degraded but still over the limit"; the head-window size comes from a **binary search on the measured payload** (on escape-dense input a linear back-off cuts the head window to 0 in one step). `MAX_CONTEXT_BYTES` survives only as a **derived reference value** (`MAX_PAYLOAD_BYTES - 24` = 24552) and **takes part in no decision at all**. Measured: `ulw.md` yields a payload of **11372** bytes, leaving 2.16x headroom against the budget (2.88x against the engine default); `tests/hooks.test.mjs` pins down both the invariant (budget + margin ≤ the engine default) and a regression sentinel on that headroom.
- **Dedupe**: a session-level marker `.omz/.mode-injected-<sessionId>`, so the same mode is injected only once per session; both `sessionId` and `projectRoot` must be path-sanitized (the same traversal surface as B22).
- **Slash-command exclusion**: when the input starts with `/` nothing is injected (the command has already been expanded, preventing double injection, §13 B5).
- **The Windows implementation**: the hook uses `type: "process"` + `args[]` (**no shell**, eliminating B15's path-space and shell-parsing differences at the root; this is stronger than v1.3's "quote the command string"); the interpreter is written as `node` and the script path uses `${ZCODE_PLUGIN_ROOT}`.
- **A strict output schema**: the engine validates hook stdout strictly, and **one extra key discards the whole thing and records it as failed**. So when nothing is injected the output is a bare `{}`, and when something is injected it carries only the single key `additionalContext`; diagnostics such as `mode`/`reason` always go to stderr.
- **Three switch layers, only the last two of which are real gates (confirmed in the last round of v1.4, replacing the earlier doubtful "two switches" wording)**:
  1. **The top-level `enabled: false` in `hooks.json` — purely decorative**. `parsePluginHookEvents` reads only `rawHooks.hooks` and **never touches the top-level `enabled` anywhere**; moreover, as soon as any plugin hook exists the engine **forces** the hook runner to `enabled: true`. So this field is neither read by the plugin load chain nor able to make the engine register one hook fewer — it is a declaration of intent for human readers (harmless to keep, but do not expect it to switch anything off).
  2. **An element-level `enabled: false` inside the hooks array — the real gate at the runtime layer**. This field inside an individual hook object **is read** (the load chain has `o.enabled === false ? [] : ...`, removing that hook from the contribution list outright). It is the only place that can keep the node process from starting **at the engine level**, and therefore the only switch that can save the 126–132ms fixed cost of the previous item.
  3. **`omz.keyword_hook !== true` — the real gate at the semantic layer**. The script reads the configuration itself (the defaults of §15.5) and, when not enabled, prints a bare `{}` and exits immediately. The process still starts (the cost is already paid) but nothing is injected.
  **To switch it off completely**: add `"enabled": false` to the object at `UserPromptSubmit[0].hooks[0]` in `hooks/hooks.json` (then the process never starts), or delete that hook entry; leaving the top-level `enabled` as `false` **is not switching it off** — its actual effect today is merely "the config says we do not want it on". The default shipping state satisfies layer 3 of layers 2 and 3 (`keyword_hook: false`); to save the cost as well, add layer 2 too.
- **Degradation**: if V3's empirical verification fails, M1 becomes permanent.

---

## 9. The phased implementation plan

**The status column reflects what was actually completed as of v1.5** (all v1.3 specifications are implemented and pass 573 tests; **v1.5 adds the real-session acceptance after installation**).

| Milestone | Content | Verification criterion | Actual status at v1.5 |
|---|---|---|---|
| **M0 verification** (half a day) | The §10 verification list (8 items empirically verified + V9/V12 closed, V3/V4/V8′ pending a real session) | Each conclusion is written into this document | ✅ **complete** (8 items measured + three rounds of engine reverse-lookup + **v1.5's fourth round of behavior-level measurement after installation**, §10.3); V3/V4/V8′ still await a real session (this acceptance run's path does not intersect them, §10.2) |
| **M1 core loop** | 9 agents + the built-in Explore + /ulw + /hyperplan + /omz-status + /omz-doctor + .omz/ + the boulder.json cross-session pointer | `/ulw <a small feature spanning 2 files>` runs the whole flow (including the review gate and dual evidence; the quick class does not spawn per the throttle valve and is a self-check item); omz-doctor all green; a new session can continue after an interruption (B18) | ✅ **complete (the v1.5 installed-environment acceptance)**: ① `/omz-doctor` got **9/9 spawn pings returning the passphrase** inside a real session (V12 closed, B16 closed along with it, and behavior-level confirmation for B1, §10.1); ② **the `/ulw` smoke test ran the whole flow** — two review gates (critic sent it back with 4 blockers + reviewer `needs-fix` → re-review `confirmed`), dual evidence, AdversarialVerify returning `confirmed`, and a final state of 8/8/0 tests green (the reproducible chain is in §18). Remaining items: B18's "continue in a new session after an interruption" was not exercised separately in this smoke test (it ran through in one go with no interruption staged), while step zero's deterministic fallback and the `active_goal` pointer are empirically effective (§13 B30) |
| **M1-G graph profile** | Install a locked CodeGraph version; `codegraph init` in every target project; the ZCode workspace stdio MCP connects automatically | `codegraph_explore` returns source relevant to the correct project/HEAD; when the index is stale the doctor warns and falls back | ⏳ **pending installation**: this machine has no codegraph (the doctor reports WARN); the `.cmd` shim problem in `probeCommand` is fixed; V10 awaits verification |
| **M2 orchestration** | coordinator MCP + SQLite WAL + DAG/mailbox/lease/heartbeat/retry; 3 dependency-free tasks in parallel | No duplicate claims under load; a dead worker can be reclaimed; state reconciles with the DoneClaim; a coordinator failure falls back to core | ✅ **code complete + the concurrency load test passed**: 13 tools, the 7-state machine, the terminal-state guard/one-time consumption/invariant detector are all implemented and tested; **8 processes competing for 200 tasks gave duplicate claims = 0, `SQLITE_BUSY` retries = 0, 0 invariant violations** (§10.1 V9; the I4 clause is discharged). Remaining: the `SQLITE_BUSY` backoff path was not triggered under that load (a coverage gap, not a correctness gap); **new caution in v1.5**: the worker side can see MCP tools (§10.3 item 12), so the right to call is constrained by discipline (§7.2/§7.4) |
| **M2 trigger enhancement** | The keyword hook (enabled if V3 passes) | Saying "ulw ..." without a slash triggers it; a hook failure still leaves slash commands usable | ⚠️ **code complete, pending V3**: the hook is implemented (including the B29 fix) with self-test 30/30; the default is `keyword_hook: false` (the semantic-layer real gate, the three switch layers of §8.2), and the injection behavior awaits a real session; once enabled, every message pays a fixed 126–132ms (the matcher does not filter, §8.2). **The v1.5 smoke test went down the slash-command path and never triggered the hook, so V3 was not closed along with it** |
| **M3 dashboard** | The Electron dashboard/SSE + the GUI task panel; shows agents/DAG/mailbox/audit | Non-loopback is refused; XSS/ANSI/oversized payloads are safe; closing the dashboard does not affect scheduling | ⚠️ **code complete, pending real Electron hardware**: on the server side the authentication tiering (I10), the connection cap, and field sanitization (B27) are tested; this machine has no electron, so only the degraded branch was verified (V11) |
| **M4 polish** | The Stop hook's termination check (constitution-checklist completeness), the review-work skill, model tiering | On abnormal termination, work below standard does not produce a "complete" conclusion | ❌ **the Stop hook is not implemented** (§17 ruling 4); the review-work skill ✅ is on disk; model tiering awaits the user filling frontmatter `model` with their own registered models |

## 10. The verification list (M0: 8 items empirically verified + V9/V12 + the `/ulw` end-to-end smoke test closed; V3/V4 + V8′/V10/V11 pending)

Since v0.5 this table has been a **table of empirical results**. On 2026-09-01 six live verifications were completed on real ZCode 3.10.2 hardware (method: a user-level probe agent `omz-probe` + a nested-spawn experiment + reverse-lookup in the engine's `zcode.cjs`). v1.4 added the conclusions of the second round of symbol-level reverse-lookup during implementation (§10.3) and four new pending items (V9–V12); the last round of v1.4 added a third round of reverse-lookup (§10.3 items 7–10) and moved V8's enum part and V9's concurrency load test into the verified section. **v1.5 completed three acceptance items inside a real ZCode session after installation** (`/omz-doctor`, `/omz-status`, `/ulw`): **V12 is closed and moved into §10.1** (closing B16 along with it, giving behavior-level confirmation of B1, and re-verifying V5/B20/§17 ruling 2), the `/ulw` end-to-end smoke test passed as the M1 verification criterion (the chain is in §18), and **five new facts** were obtained (§10.3 items 11–14 + the V6 revision in §10.1). §10.2 now holds only **five** items that genuinely need a real session/real hardware/an installation.

### 10.1 Conclusions already verified empirically

| # | Verification item | Conclusion | Empirical evidence |
|---|---|---|---|
| V1 | Discovery of the user-level/project-level agents directories | ✅ **the code path is confirmed**: agent `.md` files are loaded from two filesystem sources (`loadZCodeAgentProfiles`) — `storageRoot/agents` (storage.dir defaults to `~/.zcode`, i.e. **`~/.zcode/agents/*.md`**) and `<workspace>/.zcode/agents/*.md` (source=project), plus the plugin's `agents/` (source=plugin, loaded separately by `loadPluginAgentProfiles`) | Engine code: `[{path:join(storageRoot,"agents"),source:"user"},{path:join(workingDirectory,".zcode","agents"),source:"project"}]`. **Boundary finding**: spawning `omz-probe` in this session reported not found (the available list = general-purpose/Explore/judge, identical to before the file was created) — **the agent list is a snapshot taken at session start, and files added while running are invisible to the current session** (details in §13 B19). The file itself is valid (a nested subagent checked the frontmatter/format and found no error), and a new session should discover it |
| V2 | Whether frontmatter fields take effect | ✅ **the parse chain is confirmed** (at the code level): it parses `name` (required) / `description` (required; when missing it reports the diagnostic codes `agent_missing_frontmatter`/`agent_invalid_*`) / `tools` / `model` / `thoughtLevel` / `permissionMode` / `maxTurns` / `memory` (the enum user/project/local) / `color` / **`mcpServers`** (an agent-level MCP whitelist, newly discovered). tools is in array form (demonstrated by judge.md). **For the project source, `permissionMode` is stripped by `sanitizeProjectAgentProfile`** (made precise in v1.4: v1.2's "special handling/forced override" was inaccurate — the field is deleted, not rewritten; this does not affect OMZ, which ships as a plugin). An inheritance factory exists (with no model written, the main session's is inherited). **v1.5 adds behavior-level confirmation**: the `tools` whitelist takes effect per agent inside a real session (V12), no longer merely an inference from the parse chain | The three engine functions `loadZCodeAgentProfiles` / `loadPluginAgentProfiles` / `sanitizeProjectAgentProfile` + the judge.md sample. **The behavior-level confirmation after installation is complete** (§10.1 V12: the measured tool surfaces of the 9 agents match their frontmatter item by item) |
| V5 | Subagent nesting | ✅ **structurally blocked, confirmed**: a subagent session **does not expose the Agent tool** (the measured tool list: AskUserQuestion/Bash/Edit/Read/Skill/TaskOutput/TaskStop/TodoRead/TodoWrite/WebFetch/Write/ReadSessionContext + RespondToCoordinator + the MCP group, with no Agent tool). Nested spawning is simply impossible at the tool layer — OmO's depth-limit problem **does not exist** on ZCode (preventing infinite delegation loops is a structural guarantee, not prompt discipline) | The nesting experiment of 2026-09-01: the subagent reported "no Agent tool, a spawn cannot be initiated". This simultaneously overturns v0.2's V5 assumption (preventing loops via the prompt) into **no protection needed**. **v1.5 re-verification after installation**: spawning the 9 OMZ agents one by one inside a real session, **not one holds the `Agent` tool** (including the three full-tool roles), so the structural block holds for OMZ's own roles too (§10.1 V12) |
| V6 | Subagent skill visibility | ✅ **visible, but the count varies by role (v1.5's installed-environment measurement revises v0.5's "all visible")**: v0.5 measured "a complete skill list of 36"; v1.5's per-role spawns inside the session gave **three tiers** — `omz-junior`/`omz-atlas` see **40**, `omz-deep`/`omz-reviewer` see **34**, and the other five (planner/critic/oracle/librarian/looker) see **33**. **The tiering mechanism has not been pinned down** (possibly related to the tool surface or to `skillMetadataBudget`; it does not affect the conclusion). **No impact on OMZ**: the four own skills (`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`) are **visible in every tier** and carry the `omz:` namespace prefix (each confirmed individually) → B16 closed | The v0.5 nesting experiment (36) + **v1.5's self-reported lists from the 9 spawns of `/omz-doctor` inside the session (the three tiers 33/34/40)**. The conclusion changes from "all visible" to "visible, but the count varies by role, and OMZ's own skills are visible in every tier"; delegation prompts **do not need** an inline skill summary (B16's fallback plan is void) |
| V7 | TodoWrite session isolation | ✅ **a shared implementation is confirmed**: subagents have the TodoWrite tool (it appears in the measured tool list), and the engine's `subagentNames` schema folds subagent tasks into the projection. **The protocol stipulates that member progress is written only to results files and that TodoWrite is used only internally by each agent** (B7's original plan), so the design is immune by construction | The tool list evidence + the engine schema. The precise boundary of cross-session visibility (whether a subagent's todos are projected into the main agent's view) does not affect the design — the protocol does not depend on it |
| V8 | The frontmatter `permissionMode` **enum values** | ✅ **the enum has been extracted directly (engine reverse-lookup in the last round of v1.4)**: `["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]` (the engine symbol `XQo`); the subagent mapping (`Fsi`) is `bypassPermissions`/`dontAsk` → yolo, `acceptEdits` → edit, `auto` → auto, `plan` → plan, `default`/unwritten → **inherit the session**. **No installation is needed any more**. **The key inference**: **no value in the enum can remove an individual tool** — the closest, `plan`, is a global mode rather than a tool whitelist, so "use `permissionMode` to turn the read-only roles' Bash into a structural constraint" **does not work** (§17 ruling 3 has been rewritten as a terminal conclusion accordingly). The only thing left pending is the dialog behavior during parallel spawn (→ §10.2 V8′, §13 B2) | The engine `zcode.cjs` symbols `XQo` (the enum) and `Fsi` (the subagent permission mapping). For the project source the field is deleted by `sanitizeProjectAgentProfile` (V2); the plugin form is unaffected |
| V9 | Multi-process concurrent claim load test | ✅ **complete (measured on this machine in the last round of v1.4)**: **8 independent node processes** competed for **200 tasks** in one graph → 200 claims completed within **730ms**, **unique = 200, duplicate claims = 0**, **`SQLITE_BUSY` retries 0**, and `verifyGraphInvariants` returned `ok=true / 0 violations / checked=200`. A separate 40-task graph with `max_parallel=8`: after one process took 8, the remaining **52 attempts all returned `reason:'max-parallel'`**, so throttling works. `busy_timeout=5000` + `BEGIN IMMEDIATE` **never entered the backoff path** under that load | The load-test artifacts on this machine. **An honest boundary**: the `SQLITE_BUSY` backoff code path itself is **still not covered by any trigger** — that is not a defect but simply the fact that this load (short transactions + 8 processes on one machine) never triggers it; the backoff behavior under higher contention or on slow disks remains inference. I4's clause "load-test before going to 8-way parallelism" is thereby **discharged** |
| V12 | 9 agent spawn pings inside a real ZCode session | ✅ **complete (measured in a real session after v1.5 installation)**: `/omz-doctor` spawned the 9 agents one by one inside the session, and **9/9 returned `OMZ-PONG`**, none not found. ① **Both entry points work**: both the bareName and the `omz:` namespace prefix can spawn (measured with the **bare name** `omz-planner` and others succeeding, confirming the "unique bare-name alias" rule of §10.3 item 2); ② **the read-only whitelist works at the behavior level** (confirmation for B1, where previously there was only static validation): the measured tool surfaces of the five restricted roles critic/oracle/reviewer/librarian/looker **all lack Edit**, the three full-tool roles deep/junior/atlas **have Edit**, matching frontmatter item by item — `omz-planner` → `Bash, Read, Write`; `omz-critic`/`omz-oracle`/`omz-reviewer`/`omz-looker` → `Bash, Read`; `omz-librarian` → `Bash, Read, WebFetch`; `omz-deep`/`omz-junior`/`omz-atlas` → the full tool set (including Edit/Write/Skill/TodoWrite/TaskOutput/TaskStop/AskUserQuestion/ReadSessionContext/WebFetch + the MCP group); ③ **all 9 lack `Agent`** (behavior-level re-verification of V5), **all lack `Grep`/`Glob`** (re-verification of B20), and **not even the full-tool roles have `WebSearch`** (behavior-level confirmation of §17 ruling 2: the engine has the tool name and classifies it under `isReadOnlyTool`, but it really is absent from the current deployment's actual tool surface); ④ **all four OMZ skills are visible on the subagent side** with the `omz:` prefix → **B16 closed** (delegation prompts need no inline skill summary); ⑤ **a new fact**: all 9 tool surfaces **carry an extra `RespondToCoordinator`** (undeclared in frontmatter, not bound by the whitelist, §10.3 item 11, the third layer of §4) | Restarting the session after installation (B19) → the 9 spawn receipts of item ① of `/omz-doctor` (each containing the passphrase + the self-reported tool surface + the self-reported visible skill list). **This single item closes V12 itself, B16, and the behavior-level verification of B1, and re-verifies V5/B20/ruling 2** |
| — | Background agent completion notifications (a prerequisite for V4) | ✅ **confirmed**: after a background subagent finishes, a `<task-notification>` arrives asynchronously at the main agent with a complete result summary and usage (the evidence in this very section was produced by the completion notification of a background Explore agent) | Two background-agent measurements on 2026-09-01 (both the research agent and the nesting-experiment agent produced completion notifications in the main session) |
| — | The `/ulw` end-to-end lifecycle (the M1 smoke criterion) | ✅ **passed (a real session after v1.5 installation)**: on a real Node ESM project it ran planner → critic (sent back with 4 blockers) → rev2 → two rounds of junior execution (failing-first really went red) → reviewer (first round `needs-fix`) → re-review after fixes `confirmed`; the final state was `npm test` 8/8/0, all four SCs done, boulder `status: done`, and a hygiene scan of `.omz/` with zero defects | The complete reproducible chain is in **§18** (including the specific findings of critic/reviewer, the in-memory replay evidence method, and the evidence-defect criterion). **The plugin repository was not polluted**: everything ran in the system temporary directory, and `<plugin repo root>/.omz/` does not exist |


### 10.2 Held over, pending empirical verification (2 design-era leftovers + 2 awaiting real hardware/installation + 1 partly complete, five in all)

The two design-era items (V3/V4) are **still unverified** for the same reason: both must be executed **inside a real ZCode session** — hook injection behavior requires seeing which context layer the engine puts `additionalContext` into, and resume requires a live `agent_id`; an offline environment (running scripts under node + unit tests) cannot substitute. **What changed in the last round of v1.4**: V8's enum values were extracted directly by engine reverse-lookup (only the dialog behavior remains), and V9's concurrency load test **was completed on this machine** (moved down to §10.1). **What changed with the v1.5 installation**: **V12 was closed inside a real session** (9/9 spawn pings all returned the passphrase, moved down to §10.1), so this table drops from six rows to **five**; V3/V4 were not closed along with it — `/omz-doctor` and `/ulw` both go down the slash-command path (which does not trigger hook injection), and the smoke test used fresh task-level spawns throughout (which does not trigger resume), so those two **do not intersect** this acceptance run's execution path.

| # | Verification item | Existing evidence | Verification method | Fallback on failure |
|---|---|---|---|---|
| V3 | The actual injection behavior of the UserPromptSubmit hook's `additionalContext` | The engine hook schema confirms the field exists; the OMZ hook is implemented and `--self-test` passes 30/30 (input parsing/keyword judgement/the dedupe marker/budget control all green), but **whether the injection is actually seen by the main agent is unverified** | Enable the hook inside a real session (note: the top-level `enabled` is not read, and the real gates are the element-level `enabled` and `omz.keyword_hook`, §8.2), say a bare `ulw ...` and observe whether ultrawork is entered | Permanent M1 slash commands (slash commands are demonstrated to be zero risk); not enabling `keyword_hook` *is* the normal form of this fallback |
| V4 | Resume adapter behavior (continuation within one run, notification timing, context retention, the session-close boundary) | `agent_id`/`SendMessage` are visible at the tool layer; the official public documentation promises no stable resume API | Inside a real session, spawn → complete → SendMessage → append a task; then close/reopen the session to test the boundary | Fresh task-level spawns + coordinator state recovery, with no dependence on resume (the current implementation *is* that baseline form) |
| V8′ | **Only what remains: the permission dialog behavior during parallel spawn** (the enum values are known, see §10.1 V8) | The enum and the subagent mapping have been extracted directly by engine symbol reverse-lookup (`XQo`/`Fsi`, §10.1); **the dialog timing / whether it blocks other spawns is unverified** | Inside a real session, define agents with different `permissionMode` values, spawn them in parallel, and observe whether the dialogs block serially | Have the user widen the session permission mode before using /team (the §13 B2 backstop). **Note**: this item **no longer carries the expectation of "tightening the read-only roles' Bash"** — no value in the enum can remove an individual tool (§17 ruling 3) |
| V10 | The real returns of `codegraph_explore` after installing CodeGraph and the index-freshness judgement | Cross-verified against the upstream README/the MCP tools source; this machine has **no codegraph executable** (the doctor reports WARN). The Windows `.cmd` shim lookup problem in `probeCommand` is fixed (searching suffix by suffix per PATHEXT) | Install the locked version → `codegraph init` → query, then change a file without rebuilding the index and confirm the doctor can report stale; after rebuilding, the return contains the new content (§13.5 I1) | Keep the graph profile off, fall back to Explore + Bash grep/rg |
| V11 | Real-hardware rendering of the Electron dashboard and the actual interception effect of CSP | This machine has no electron, so **only the degraded branch was verified** (`dashboard/main.mjs` falls back to a pure HTTP server when electron is absent; the token gate/loopback binding/static-shell tiering on the server side already have tests) | After installing electron, open the window and inject `<script>`/ANSI/an oversized payload, confirming CSP interception, no execution and no layout collapse (§13.5 I5) | Keep the dashboard profile off, fall back to the ZCode GUI task panel + `/omz-status` |

### 10.3 Supplementary engine evidence

**Round one (the v0.5/v1.2 period)**:

- **The default of storage.dir = `~/.zcode`** (`join(homedir,".zcode")`), overridable by `storage.dir` in `~/.zcode/cli/config.json` and by environment variables — so the user-level agent directory is exactly `~/.zcode/agents/` (correcting v0.2's misidentification of a "run-trace directory": `~/.zcode/cli/agents/sess_*/` is subagent runtime output, while the definition files live in `~/.zcode/agents/`).
- **agent frontmatter supports `mcpServers`** (an agent-level MCP whitelist) — OMZ could give looker a dedicated vision-model MCP, a capability beyond the original design assumption.
- **The slash-command expansion chain**: `expandCustomCommandPrompt` handles `$ARGUMENTS`/`$1..$N`/`` `!cmd` ``/` ```! ` execution blocks.
- **The subagent tool list** (measured): no Agent tool (nesting prevention), no standalone Glob/Grep tools (file search goes through Bash), Skill/TodoWrite/TaskOutput/TaskStop present, the MCP tool group available (**v1.5 re-verification after installation: full-tool roles see the complete `mcp__openviking__*`, 11 tools, + `mcp__node_repl__js*`, 3 tools**, see item 12 below), **plus the engine-injected `RespondToCoordinator`** (not bound by the whitelist, new in v1.5, see item 11 below).
- **The subagent_type list of the Agent tool is a session-level snapshot** (B19, details in §13).

**Round two (symbol-level reverse-lookup during v1.4 implementation — code-level evidence, harder than the design era's inferences)**:

1. **The complete set of plugin template variables is confirmed**. The engine's expansion regex is exactly:

   ```
   ${(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)}
   ```

   Plugin MCPs additionally support `${user_config.KEY}`. **`${pluginDir}` is not among them** — an unrecognized variable is **kept verbatim** (no error, not emptied), so the path is certain to break and hard to diagnose; the v1.3 and earlier text used `${pluginDir}` around §3.4, which was a specification error, and the implementation uniformly uses `${ZCODE_PLUGIN_ROOT}`. `ZCODE_SKILL_DIR`/`CLAUDE_SKILL_DIR` **throw** in a hook context (the engine explicitly throws `Hook variable requires a skill context`) and can only be used in a skill context.
2. **The plugin agent load chain is confirmed** (`loadPluginAgentProfiles`): it reads `<pluginRoot>/agents/<name>.md`, and after parsing **forces the namespace prefix** `<pluginName>:<bareName>`; if that bareName is unique across all plugins and does not collide with a reserved name, **an additional bare-name alias is registered**. The reserved-name set = `new Set(["general-purpose","Explore"])`. A bareName collision or a clash with a reserved name produces an `agent_ambiguous_name` diagnostic (the alias is lost, the namespaced name still works). → For OMZ: `omz-planner` works both as `omz:omz-planner` and by the bare name; the `omz-` prefix policy is confirmed correct (the naming rule of §3.4).
3. **The user-level/project-level agent load chain** (`loadZCodeAgentProfiles`) confirms the design-era conclusion, with the precise form in §10.1 V1; `sanitizeProjectAgentProfile` **deletes the `permissionMode` field** for the project source (§10.1 V2, and §1.5.2 has been corrected to this wording).
4. **The plugin hooks load chain** (`collectPluginHookEvents`): `<pluginRoot>/hooks/hooks.json` needs the outer `hooks` wrapper (the engine reads `rawHooks.hooks`); the manifest's `hooks` field may be a path string, an array of paths or an inline object; an unsupported event name produces only a `plugin_hook_unsupported_event` **warning**, not a fatal error (so a misspelled event name silently has no effect — the doctor should self-check against the supported-event table). **Three additions in the last round of v1.4 (§8.2 has been rewritten accordingly)**:
   - **Plugin hooks and config-file hooks have different schema shapes**: the config-file side is `hooks.events.<Event>`, the plugin side is `hooks.<Event>` (**no `events` intermediate layer**). Writing an `events` key into a plugin hooks.json → an empty event table → silently no hooks.
   - **The top-level `enabled` is not read**: `parsePluginHookEvents` takes only `rawHooks.hooks` and never touches the top-level `enabled` anywhere; and as soon as any plugin hook exists the engine **forces** the hook runner to `enabled: true`. What is actually read is the **element-level** `enabled` inside the hooks array (`o.enabled === false ? [] : ...`, removing that hook entirely).
   - **`matcher` has no effect on `UserPromptSubmit`**: `hookRunner.run(t, r = {})` decides with `n6r(r, c.matcher)`, and the match value comes from the second parameter, options; `runUserPromptSubmitHooks` (`RUr`) passes only `{ signal }`. `n6r` **returns true unconditionally** when the match-value set is empty (`r.length === 0 ? true : ...`). So on this event the matcher filters nothing, and "a miss does not even start a process" is wrong (§8.2 gives the measured fixed cost).
5. **The engine's own definitions of tool classes**:
   - `isReadOnlyTool` = `new Set(["Read","Glob","Grep","WebSearch","WebFetch","TodoRead","TodoWrite","AskUserQuestion","Agent","Task","Skill"])`
   - `isWriteTool` = `["Write","Edit","ApplyPatch","Bash"]`
   - `isDestructiveTool` = `["Bash"]`

   → **The engine itself classifies Bash as write + destructive.** This directly refutes v1.3's §4 claim that "the read-only roles' tool whitelist is a structural guarantee": a role with `tools: [Read, Bash]` **can write files** (`>` redirection, `node -e fs.writeFileSync`, `git checkout`). It has been rewritten as a layered statement per §17 ruling 3 (Edit/Write a structural constraint + Bash read-only a disciplinary constraint; v1.5's installed-environment measurements add a third layer, "the engine-injected surface", see item 11 below and §4).
6. **A plugin manifest's `agents` field and the `agents/` directory are not the same thing**: this machine's `diagnosing-plugins` guide says `agents` is "recorded but not executed", which is easily read as "plugin agents do not work". The accurate relationship is: the **key-value mapping form (an inline declaration)** of `agents` in the manifest is not executed, but the `agents/` **directory is scanned and registered by `loadPluginAgentProfiles`**. OMZ uses the directory form (the manifest writes `"agents": "agents"` pointing at the directory), which holds. This difference is recorded so nobody later deletes the directory or misjudges the feature as broken.

**Round three (the final v1.4 re-check — two items overturn existing statements, two give new facts)**:

7. **The `permissionMode` enum and the subagent mapping have been extracted directly**: the enum (the engine symbol `XQo`) = `["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`; the subagent permission mapping (`Fsi`): `bypassPermissions`/`dontAsk` → yolo, `acceptEdits` → edit, `auto` → auto, `plan` → plan, `default` or unwritten → **inherit the session**. → **V8's enum part no longer needs an installation** (§10.1 V8). **The key inference**: the enum tunes "how strict approval actions are" and **no value can remove an individual tool**, so it **cannot** be used to turn the read-only roles' Bash into a structural constraint (§17 ruling 3 has been rewritten as a terminal conclusion); using it to **widen** permissions (mitigating B2's dialog blocking) is feasible.
8. **Where `matcher`'s match value comes from, and the actual behavior of `UserPromptSubmit`**: `hookRunner.run(t, r = {})` decides with `n6r(r, c.matcher)` and the match value is taken from the **second parameter (options)**; `runUserPromptSubmitHooks` (`RUr`) passes only `{ signal }` and no `matchValue`/`matchValues`; `n6r(e, t)` = `if (!t) return true; let r = [...e.matchValues ?? [], ...e.matchValue ? [e.matchValue] : []]; return r.length === 0 ? true : [...new Set(r)].some(n => r6r(n, t))` — an empty set **returns true unconditionally**. → On this event the matcher **plays no part in filtering**, so v1.4's §8.2 claim that "a miss does not even start a node process (saving overhead)" is **wrong**; it has been withdrawn and the measured fixed cost added (126–132ms per message).
9. **The main agent's context contains no sessionId**: `${ZCODE_SESSION_ID}` belongs to the template-variable table of item 1 and is only expanded in **hook / MCP server / a command's shell execution block** contexts; **the Bash tool's env does not have it**, and the system prompt's `<env>` block has only cwd/git/platform/shell/osVersion. → Any specification requiring the main agent to "name files by sessionId" will be satisfied by the model with a fabricated value (the false-success mechanism of §13 B30); `/ulw` switched to fetching the value with a ` ```! ` execution block plus a deterministic fallback.
10. **The naming rule of plugin MCPs**: the engine names a plugin MCP server `plugin:<pluginName>:<serverKey>`, and the tool's exposed name is `mcp__plugin_<pluginName>_<serverKey>__<toolName>`. → The real name of OMZ's `omz_team_create` is `mcp__plugin_omz_omz-coordinator__omz_team_create`; the bare names in the documentation tables are logical names, and callers must match by suffix against their own tool list to obtain the real name on the spot (the preamble of §7.2).

**Round four (real-session measurements after v1.5 installation, four **behavior-level** new facts — sourced from the 9 spawn receipts of `/omz-doctor` and the controlled experiment of `/omz-status`, not from engine reverse-lookup)**:

11. **Subagents have `RespondToCoordinator`, and it is not bound by the frontmatter `tools` whitelist**. The measured tool surfaces of all 9 subagents **contain `RespondToCoordinator`** — including the narrowest form `tools: [Read, Bash]` (`omz-critic`/`omz-oracle`/`omz-reviewer`/`omz-looker`). That tool is **declared in no agent's frontmatter**; it is **engine-injected**.
    - **The conclusive statement**: **the real tool surface of a read-only role = the frontmatter whitelist ∪ the engine-injected tools**. The whitelist is the upper bound on "what we can declare", **not the entirety of the tool surface**; the latter is decided by the engine, and OMZ has no control point over it. This is an additional dimension for the read-only model of §4 (**the third layer: the engine-injected surface**) and has been written into §4.
    - **The impact on `tools/validate-frontmatter.mjs`**: the `SUBAGENT_TOOLS` list **does not contain `RespondToCoordinator`**, so the list is **incomplete**. **This is currently not a problem** — it is engine-injected, nobody would declare it in frontmatter, and so the validator will not produce a false report because of the missing entry (only actually writing it would fall into the `unknown` branch). The point of recording this fact is that the list's semantics are "the declarable tool surface", not "the tool surface a subagent actually holds", and the two must not be conflated; if that list is ever used to infer "the entirety of the tool surface", the engine-injected entries must be filled in first.
    - **Corroboration**: the note for `ENGINE_ONLY_TOOLS.SendMessage` already said "a subagent replies via RespondToCoordinator/its final output", which shows the tool's existence was known before — it just **was never registered in `SUBAGENT_TOOLS`, nor written into this design document's tool-surface list**.
12. **Subagents can see the MCP tool group (in full, not a subset)**. The measured tool surface of the full-tool roles (`omz-deep`/`omz-junior`/`omz-atlas`) contains the complete `mcp__openviking__*` (**11 tools**) and `mcp__node_repl__js*` (**3 tools**).
    - **The premise that is overturned**: the **reason** given for that constraint in step 4 of `commands/team.md` said "a subagent may not see it in its tool surface" — **the premise "workers cannot see MCP" does not hold**. If the coordinator MCP is enabled, the worker side is **very likely to see** the entire `mcp__plugin_omz_omz-coordinator__*` tool set directly.
    - **The constraint itself should still be kept** (§7.2/§7.4 have been amended accordingly): being able to see ≠ being the one to call. The semantics of claiming and reporting are controlled by the main agent — **the protocol constrains the right to call through discipline, not visibility**. This is a correction of the form "the reason was wrong but the conclusion was right": the behavior does not change, the why does.
13. **The number of skills visible to a subagent varies by role** (revising v0.5's "all 36 visible"): `omz-junior`/`omz-atlas` **40**, `omz-deep`/`omz-reviewer` **34**, the other five **33**. The tiering mechanism has **not been pinned down** (possibly related to the tool surface or to `skillMetadataBudget`). **No impact on OMZ**: the four own skills are visible in every tier and carry the `omz:` prefix (each confirmed individually) → the §10.1 V6 conclusion has been rewritten and B16 is closed.
14. **There is an observable capability gap between the inline execution block and `tools/render-status.mjs` in injection sanitization** (behavior-level data for B27): given the same malicious title, the inline block **renders one extra forged task row**, while `render-status.mjs`'s `cell()` squashes it into one line inside a cell. → "Take `render-status.mjs` as authoritative" in `commands/omz-status.md` **is not a disclaimer; it is a real capability gap** (the inline block is a minimal fallback implementation and does not include `cell()` sanitization). The measurements and the conclusion are in §13 B27 and the `/omz-status` entry of §8.1.

## 11. Gaps versus OmO and the boundary of local fill-in

**It should no longer be called "degradation only"**: `codegraph_explore` can connect directly to the upstream CodeGraph MCP, and the semantics of Team/DAG/dashboard can be filled in with the OMZ coordinator and Electron components (§3.4, §7.2).

| Capability | Current local status | The real differences that remain |
|---|---|---|
| codegraph | The graph profile connects directly to the MIT `@colbymchenry/codegraph`; the core profile falls back to Explore+Bash | Upstream returns a text ToolResult; index freshness must be validated by us; OmO's Codex bridge is not copied |
| Team Mode | coordinator MCP + ZCode Agent workers + SQLite registry/mailbox/lease/heartbeat | No official Team API; workers are not resident in memory; native P2P or automatic resume across restarts cannot be guaranteed |
| DAG | The coordinator's SQLite `task_deps` + atomic claim + lease/retry; wave fallback when there is no coordinator | The tool names differ; single-machine SQLite is single-writer; ZCode's idle-time task FIFO is not passed off as a DAG |
| tmux | Electron dashboard/SSE + the ZCode GUI task panel; Windows Terminal as a debugging bypass | No interactive terminal of a native tmux pane; the dashboard is an independent optional component |
| Model fallback chain | frontmatter `model`/`thoughtLevel` + doctor validation; re-dispatch on failure | ZCode has no automatic fallback chain equivalent to OmO's |
| The primary main-session role | The main agent is fixed, and roles are spawned through the Agent tool | No OpenCode primary mode |
| hooks | ZCode's seven events are kept; implemented with synchronous semantics | Fewer events; the web page's async description conflicts with this machine's guide, so async is not relied on before verification |
| Dynamic Agent | A fixed 9 agent files + the built-in Explore (10 roles) + category routing | No OmO dynamic prompt builder |

**OmO core protocols that are preserved**: the whole ultrawork lifecycle, category routing, interview-driven planning, the review gate, dual evidence, DoneClaim/AdversarialVerify, the 9 adversarial classes, LIGHT/HEAVY, checkbox/EXPAND/claim gating, the 5-lane review, and Boulder plus worktree discipline.

**Enhancements on the ZCode side**: subagents have real Read/Bash; nested delegation is structurally blocked at the tool layer; skills are fully visible (empirically verified in V5/V6); CodeGraph, the coordinator and the dashboard can each be started and stopped independently by profile without polluting core.

## 12. Negative impacts and the cost model

Multi-agent orchestration is a token amplifier and also an amplifier of the runaway surface. Read this before installing OMZ:

### 12.1 Multiplied token cost
- **The fixed tax**: 9 descriptions resident in the system prompt (the §4 budget discipline, ~400 tokens; the 10th role is the built-in Explore and is not taxed extra).
- **The amplification tax**: every subagent gets a brand-new context (system prompt + the 7-element prompt + files it reads itself), so N parallel members ≈ N times the context construction; the main agent also has to digest the returned summaries.
- **The mode tax**: the /ulw prompt itself is long (the whole eight-step lifecycle is injected).
- **The trigger tax (measured, added in the last round of v1.4)**: once the M2 keyword hook is enabled, **every user message** starts one node process (about **126–132ms**, against a bare `node -e 0` baseline of 85–91ms) — `matcher` plays no part in filtering on `UserPromptSubmit`, so this latency is unrelated to whether a keyword hits (§8.2). It is wall-clock latency rather than tokens, but it is equally a fixed cost of the "you keep paying it once installed" kind, and one of the reasons `keyword_hook` is off by default.
- **The throttle valve (built in)**: ① the main agent does `quick`-class work itself; ② the returned body is a summary of ≤20 lines and the full text goes to a results file; ③ the main agent writes simple `writing` output directly; ④ dependency-free exploration uses the lightest built-in `Explore`.

### 12.2 Context inflation and pollution
Background agent completion notifications are inserted asynchronously and interleave when several members run in parallel — TodoWrite registers "waiting"; the M2 hook dedupes (§8.2); and the larger choice space of 10 roles makes weak models over-delegate — the throttle valve is written as a MUST rule.

### 12.3 resume and notification timing
A resumed member runs in the background while its notification returns asynchronously, competing with the synchronous wave collection point. The rule: **wave advancement is judged by results files, not by notifications**; a resume being waited on is registered in TodoWrite; on timeout (10 minutes) the state file is checked actively.

### 12.4 Relay loss without a primary mode
Deep execution must go through the main agent's relay — an incomplete relay makes the subagent work blind (the most common quality accident). Mitigation: CONTEXT must contain "a list of key file paths + confirmed facts + relevant historical decisions", better redundant than short; omz-deep re-checks the relay as its first step and reports a gap immediately instead of guessing.

### 12.5 State file races
One writer per file is the discipline (§3.3). Residual risk: concurrency by the lead itself (two `/team` runs at once) — mitigated by the per-team file area of `.omz/runtime/<teamId>/` + isolation through the in-database `team_id` foreign key (**not separate databases**, the v1.4 revision in §3.5) + the /team prompt's rule that only one team may be active at a time.

### 12.6 The runaway surface of deep execution
omz-deep has the full tool set, runs in the background, and is autonomous for a long time. Guardrails (strengthened in v0.3): ① a hard cap via frontmatter `maxTurns` (structural, not a prompt convention); ② a `max_wall_clock_minutes` budget (default 120); ③ MUST NOT DO must state the forbidden zones (e.g. "do not delete any file outside .omz"); ④ the Stop hook (M4) persists boulder.json on abnormal termination for a human to take over; ⑤ high-risk operations (destructive commands, anything publishing externally) are executed by the main agent itself.

### 12.7 Environment and compatibility
Windows has no native tmux pane, but the presentation layer has the dashboard/GUI fallback; hooks are all implemented in node; `.omz/` must go into .gitignore (/omz-doctor checks automatically and offers to append it); state file paths uniformly use forward-slash relative paths (§13 B3); CodeGraph/coordinator/dashboard are only enabled under their respective profiles and do not affect core; it coexists with existing plugins (document-skills' judge reviews rendering artifacts while omz-reviewer reviews code changes — disjoint responsibilities; the omz- prefix prevents name collisions).


---

## 13. Porting bug contingencies and empirically found defects (B1–B30)

Ordered by severity and by when they were found. Each one: **symptom → root cause → solution → verification/backstop**. B1–B18 are contingencies written during the design era (checked one by one while implementing M0/M1, and handled per the contingency when hit); B19–B21 were found by the v0.5 measurements/audit; **B22–B30 are defects actually hit during v1.4 implementation and auditing** (not speculation — each has a corresponding test or an already-applied fix).

### B1 [high] A wrongly formatted tools field makes agent loading fail or the whitelist not apply
- **Symptom**: omz-reviewer can still change code (the whitelist has no effect), or the whole agents directory fails to load.
- **Root cause**: in the engine's message schema tools is a `record<string,boolean>`, but **the agent file's frontmatter is a YAML array** (`tools: [Read, Bash]`, demonstrated by judge.md). The two forms are extremely easy to confuse.
- **Solution**: write the array strictly per the judge.md sample; add to the omz-doctor self-check an assertion that "after spawning, actually calling a forbidden tool must be refused".
- **Verification**: ✅ **behavior-level confirmation is complete (measured in v1.5 after installation)** — previously there was only the static validation of `validate-frontmatter.mjs` (YAML array parsing + tool-name classification). Spawning the 9 agents one by one inside a real session, the measured tool surfaces **match the frontmatter declarations item by item**: the five restricted roles (critic/oracle/reviewer/librarian/looker) **all lack Edit**, the three full-tool roles (deep/junior/atlas) **have Edit**, planner is exactly `Bash, Read, Write`, and librarian is exactly `Bash, Read, WebFetch` (§10.1 V12). The whitelist does take effect; it is not "declared but never read by the engine". **Boundary**: the whitelist only constrains "what can be declared", the tool surface also contains engine-injected entries (`RespondToCoordinator`, §10.3 item 11, the third layer of §4), and Bash is still the disciplinary layer (§17 ruling 3).

### B2 [high] Permission dialogs during parallel spawn block orchestration
- **Symptom**: /team runs 4 members in parallel, the very first Bash call hangs waiting for GUI confirmation, later members queue up, and wave advancement deadlocks.
- **Root cause**: ZCode tools run under a permission mode, subagent tool calls may inherit the confirmation flow, and Windows GUI dialogs are modal.
- **Solution**: ① the read-only roles' tools whitelist naturally avoids high-risk tools (Bash may still prompt); ② widen frontmatter `permissionMode` per agent — the enum is known (§10.1 V8): `acceptEdits`/`auto`/`bypassPermissions`/`dontAsk`/`plan`/`default`, with the subagent mapping `bypassPermissions`|`dontAsk` → yolo, `acceptEdits` → edit, `auto` → auto, `default`/unwritten → inherit the session; **widening is a viable path (this is the "widening" direction)**, and all that remains pending is the dialog timing under parallelism (§10.2 V8′); ③ the documentation states plainly: widen the session permission mode appropriately before running /team; ④ MUST DO stipulates that members prefer confirmation-free paths such as Read and read-only Bash commands.
- **Backstop**: if V8′ measurements show the dialogs still block serially, Team Mode degrades to "parallelism 2 + serial confirmation is acceptable".

### B3 [high] Windows path separators tear apart
- **Symptom**: a member writes the path `E:\AI\project\src\main.rs` into results, the lead or the next wave's member reads it in Git Bash and concatenates a command, the backslashes are taken as escapes, and every file operation fails.
- **Root cause**: ZCode runs on Windows and the toolchain straddles two worlds, win32-native (backslashes) and Git Bash (forward slashes).
- **Solution**: the protocol stipulates that state files **always store forward-slash relative paths** (relative to the project root); this rule is written explicitly into the /ulw and /team prompts; omz-doctor scans the JSON under .omz/ and warns on any backslash absolute path.
- **Verification**: covered by the M1 end-to-end run.

### B4 [high] State-file JSON encoding corruption (BOM/CRLF)
- **Symptom**: member B reads the results member A wrote and JSON.parse throws, interrupting wave advancement.
- **Root cause**: on Windows, PowerShell's `Set-Content` writes UTF-8 with a BOM by default; some tools write CRLF; a JSON parser fails outright on a BOM.
- **Solution**: the protocol stipulates that files under `.omz/` are always written with the Write tool or node (`fs.writeFileSync` writes no BOM by default) and **forbids writing state files with PowerShell**; the hook script's node implementation follows the same rule; tolerance on the reading side (strip the BOM before parsing) is written into the /omz-status rendering script.
- **Verification**: covered by M1; omz-doctor adds a BOM scan.

### B5 [medium] Double injection between the /ulw command and the M2 hook
- **Symptom**: the user types `/ulw fix the login bug`, command expansion injects the ultrawork prompt once, and the hook detects the "ulw" keyword and injects it again — duplicated context pollution, wasted tokens, and possibly self-contradiction.
- **Root cause**: the two trigger layers (command expansion and hook detection) work independently with no mutual exclusion.
- **Solution**: the hook script's first rule — if the input starts with `/`, return without injecting (the command system has handled it); the session-level marker is the second line of defence (the dedupe of §8.2).
- **Verification**: when M2 goes live, specifically test the three inputs `/ulw`, a bare `ulw`, and a normal sentence containing the word "ultrawork".

### B6 [medium] omz-deep runs away and burns tokens (long loops/repeated retries)
- **Symptom**: a background omz-deep runs 40 minutes without returning, and the transcript shows it retrying on the same error in a loop.
- **Root cause**: with the full tool set, autonomy, and no hard turn cap, the model can fall into a repair loop.
- **Solution**: ① a hard cap via frontmatter `maxTurns` (engine-confirmed, a structural guardrail); ② a 120-minute wall-clock budget; ③ the prompt stipulates "after 3 consecutive failed repairs of the same error you must stop and report, not continue"; ④ for background tasks the main agent relies mainly on notifications and looks at TaskOutput only once, when a mid-course decision genuinely depends on it (no unbounded polling).
- **Verification**: dedicated load tests for M1/M2 Team and the coordinator.

### B7 [medium] A wrong assumption about TodoWrite session isolation
- **Symptom**: if a subagent's TodoWrite shares one list with the main agent, parallel members overwrite each other's todos and the orchestration state goes wrong; if it is independent (as expected), member progress is invisible to the lead and the lead can only rely on results files.
- **Root cause**: the semantics of "current session" were unverified, and the two behaviors have exactly opposite implications for the design.
- **Solution**: let the V7 measurement set the direction first. Whatever the result, the protocol uniformly stipulates: **member progress is written only to results files, and TodoWrite is used only inside each agent's own session** — the design depends on no particular TodoWrite semantics and is immune by construction.
- **Verification**: M0-V7.

### B8 [medium] Notification timing races with wave advancement (collection-point drift)
- **Symptom**: member A of wave-1 is still running (its notification is delayed), the lead believes the wave is complete and has moved to wave-2, A's result is inserted later, and the final summary is missing A or the state is wrong.
- **Root cause**: background completion notifications are asynchronous events that race with the lead's synchronous advancement logic.
- **Solution**: **the single-source-of-truth principle** — the condition for wave advancement is "every tasks/*.json in this wave has a terminal status and its results file exists", and notifications are only reminders, never the basis; the lead does a final `ls` check of the results directory before advancing.
- **Verification**: the main verification item of M3.

### B9 [medium] The resume adapter is unavailable or the session has been reclaimed
- **Symptom**: SendMessage to an already-finished agent gets silence or an error, and the lead waits forever.
- **Root cause**: ZCode's official public documentation has no agent ID, resume token, or cancel/progress API; the `agent_id`/`SendMessage` present at the tool layer cannot be treated as a contract stable across versions.
- **Solution**: resume carries a 10-minute timeout; on timeout, fall back to spawning again and merge the original results file's contents into the new prompt's CONTEXT (no information is lost); state.json records the agent_id↔task_id mapping to ease rebuilding.
- **Verification**: M1 installation V4: three test groups — continuation within one run, timeout fallback, and the new-session boundary.

### B10 [medium] A YAML error in one agent file drags down the whole plugin
- **Symptom**: one omz-*.md has an unescaped colon or quote in its frontmatter, and after installing the plugin all 9 agents disappear.
- **Root cause**: the granularity of the engine's fault tolerance when loading the agents directory is unknown (skip one file, or fail the whole directory).
- **Solution**: add YAML lint to the release process (a CI script); omz-doctor spawn-pings each agent as a post-install self-check; a description containing a colon is quoted as a whole (as the judge.md sample does).
- **Verification**: the omz-doctor of M1.

### B11 [medium] The review gate is a dead letter
- **Symptom**: omz-reviewer shares a model and lineage with the executor, and every review report reads "generally good, minor suggestions" — the process ran, the code quality did not improve.
- **Root cause**: there is no structural difference between reviewer and executor; and prompt bias (a gently worded reviewer prompt) amplifies conformity.
- **Solution** (v1.4 corrects the nature of the defences): ① **the tool whitelist** — excluding Edit/Write is a **structural constraint** (the reviewer cannot obtain editing tools); but Bash is write+destructive in the engine (§10.3 item 5), so "do not use Bash to write files" can only be a **disciplinary constraint**, written into the reviewer's body text (§17 ruling 3); ② the reviewer prompt forces a negative output format: every finding must contain `[level] file:line problem description fix suggestion`, and it **must explicitly answer "I found no problems of class X" for each class in turn** — an empty report must be the conclusion of an exhaustive pass, not a brush-off; ③ at most 2 re-reviews (preventing an endless tug-of-war between reviewer and executor); ④ entering the submission step with blockers outstanding is forbidden (written into the /ulw constitution checklist).
- **Defence strength (stated honestly)**: of the four defences, ②③④ are structural/process constraints and ① is "half a defence" — **three structural + one disciplinary**. **This is terminal**: no value in the `permissionMode` enum can remove an individual tool (§10.1 V8, §17 ruling 3), so there is no path along which ① becomes a structural constraint once some measurement passes, and the disciplinary constraint must be sustained long-term by the spot checks below.
- **Verification**: from M1 onwards, sample-review the reviewer's output quality by hand at every review gate; if reports keep coming back empty, upgrade the prompt (adding "you must raise at least 3 doubts or explicitly state that you exhausted the classes"). **Additionally**: spot-check whether the reviewer's Bash calls contain only read commands (a disciplinary constraint needs spot-check backstops; a structural constraint does not).

### B12 [medium] A frontmatter model pointing at an unregistered model
- **Symptom**: spawning omz-oracle fails immediately, or silently falls back to the main session's model (the tiering stops working without an error).
- **Root cause**: frontmatter model names a model ID not registered in `~/.zcode/v2/config.json` (a typo, a provider rename, the user changed keys).
- **Solution**: omz-doctor validates every agent's model field against the list of registered provider models and lists the differences; re-running the doctor is recommended after a model configuration change.
- **Verification**: the omz-doctor of M1.

### B13 [low] quick-class tasks get over-delegated
- **Symptom**: the main agent spawns omz-junior even for a typo fix, doubling tokens with no quality gain.
- **Root cause**: the delegation choice space is large, weak models tend to "use a role because one exists", and the throttle valve is ignored as a suggestion.
- **Solution**: the /ulw prompt writes the throttle valve as a MUST rule ("quick-class tasks you fix yourself; delegating them is a violation"); descriptions carry reverse trigger conditions ("only for…, do not dispatch single-file small edits").
- **Verification**: observe the delegation log in M1.

### B14 [low] `.omz/` gets committed to git by mistake
- **Symptom**: interim products such as goal/plans/runtime get mixed into commits and pollute the repository history.
- **Root cause**: the directory sits under the project root and nobody remembers to add it to .gitignore.
- **Solution**: on its first run /ulw checks .gitignore and, with no `.omz/` entry, appends it automatically and says so; omz-doctor checks routinely.
- **Verification**: M1.

### B15 [low] The hook script fails to execute on Windows
- **Symptom**: hooks.json configures a bash script, on Windows the interpreter is not found or a path containing spaces fails to parse, and M2 silently does not work.
- **Root cause**: Windows has no notion of an execute bit, and shell parsing differs.
- **Solution**: the hook command is uniformly `node "<absolute path>/hook.js"` (ZCode ships node); paths containing spaces are fully quoted; a hook failure does not block the main flow (the engine's hooks have timeoutMs and fault tolerance).
- **Verification**: M0-V3.

### B16 [low] Subagents cannot see the OMZ skills — **✅ closed (measured in v1.5 after installation)**
- **Symptom**: the skill named in REQUIRED SKILLS is invisible on the member side, and the member reinvents the process.
- **Root cause**: skillMetadataBudget is limited, or plugin skills are not delivered to subagents (v0.5's V6 only measured "36 skills visible in the current session", and OMZ's own 4 were not yet installed then).
- **Empirical conclusion (the basis for closing)**: `/omz-doctor` spawned the 9 agents one by one inside a real session, and **the four OMZ skills (`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`) are visible on all 9 subagents**, carrying the `omz:` namespace prefix (consistent with the plugin namespace rule of §10.3 item 2). **The total number of visible skills varies by role** (junior/atlas 40, deep/reviewer 34, the other five 33, §10.3 item 13), but **OMZ's own 4 are present in every tier** — the tiering does not squeeze them out.
- **Ruling**: **the fallback plan is void** — delegation prompts **do not need** an inline skill summary (the original plan cost about 10 lines per dispatch, a continuous token tax across 9 roles, and that cost is now saved). The REQUIRED SKILLS field can name a skill directly and the member can load it itself.
- **Residual caution**: the tiering mechanism has not been pinned down (§10.3 item 13), so "the skill is certainly visible" is **an empirical conclusion about the current deployment, not an engine promise**. If user-level skills ever expand greatly (the measured baseline here is already 33–40), there is a theoretical possibility of being squeezed out by the budget — `/omz-doctor`'s spawn ping already folds "the subagent's self-reported visible skill list" into the receipt, and that is the routine probe for this risk.
- **Verification**: ✅ complete — the 9 spawn receipts of item ① of `/omz-doctor` (each containing the self-reported visible skill list, with the four OMZ skills confirmed present one by one, §10.1 V12).

### B17 [low] Quality decay of the orchestration layer in long sessions
- **Symptom**: after a /ulw session runs for 2 hours, the main agent's context inflates and it starts skipping the review gate, forgetting the dual-evidence requirement, and committing directly.
- **Root cause**: the mode prompt is injected early in the session, and its binding force is diluted as the context grows.
- **Solution**: goal.json stores the "constitution checklist" (review-gate conditions/dual-evidence requirements/the throttle valve), and **the lead is forced to self-check it before every submission point**; **after every wave collection point the main agent actively writes progress into `.omz/boulder.json`** (§17 ruling 4).
- **The v1.4 gap**: the Stop hook is **not implemented** (hooks.json only registers `UserPromptSubmit`), so "check checklist completeness on termination and write gaps into boulder.json to block a 'complete' conclusion" is an **unimplemented M4 item**. Abnormal termination (the process killed/the session crashing) therefore loses whatever progress followed the last collection point and will not automatically block a "complete" conclusion — for now only the frequency of active persistence covers this.
- **Verification**: M4 (once the Stop hook is implemented). Until then, the active persistence of the §6 wrap-up clause + manual checking.

### B18 [medium] A changing session ID loses track of the goal and team state
- **Symptom**: /ulw is interrupted halfway, the user opens a new session and says "continue" — the new session's stem differs from the old `goal/<stem>.json` (both naming forms of B30 change), so the main agent cannot find the old goal, registers a new one, and every completed wave is redone.
- **Root cause**: naming goals per session is inherently fragmenting; and if the cross-session pointer boulder.json lags behind, there is a vacuum. **An addition from the last round of v1.4**: the fragmentation is worse than the design era assumed — the main agent cannot even obtain the real sessionId (B30), so the name is either a real sessionId or a timestamp fallback, and both forms change in a new session.
- **Solution**: ① boulder.json's **`active_goal` is the single authoritative pointer** (the forward-slash relative path of the active goal file, the active teamId, and unfinished TODOs), updated by the lead after every wave advance; **open the file by its literal value, and never infer a filename from the current session or reverse-engineer one from `session_ids`** (B30); ② when a new /ulw detects an unclosed old goal (no done marker) it must first ask the user "continue or abandon" and must not silently start over; ③ teams in a terminal state are archived (a copy is kept in runtime) to prevent continuing the wrong one.
- **Verification**: the M1 interruption-and-continue test. Because locating goes only through `active_goal`, **continuation stays exact even if the sessionId is forever unobtainable**.

### B19 [high] The agent list is a session-start snapshot (found by v0.5 measurement)
- **Symptom**: the user puts omz-planner.md into `~/.zcode/agents/` and says "use planner" in an already-open session — not found; the user concludes the plugin is broken.
- **Root cause**: measurement confirms that the list of subagent_types available to the Agent tool is **snapshotted at session start**, and agent files added while running are invisible to the current session.
- **Solution**: ① after installing/updating OMZ one must **restart the session (or open a new one)** for it to take effect — written into the README's installation steps and into /omz-doctor's checks (which prompt for a restart when an agent file's mtime is later than the session start time); ② project-level agents (`.zcode/agents/`) travel with the repository and arrive on clone, requiring no user action; ③ make the failure message actionable: omz-doctor says "the file is in place but invisible to this session, please open a new session" rather than a vague not found.
- **Verification**: after M1 installation, spawning omz-probe in a new session should return PROBE-OK.

### B20 [medium] Subagents have no standalone Grep/Glob tools (found by v0.5 measurement)
- **Symptom**: following the v0.3 role table, omz-librarian was given `tools: [Read, Grep, Glob, WebFetch, WebSearch]` — after spawning, the Grep/Glob calls fail (the tools do not exist) and the retrieval agent is paralysed.
- **Root cause**: measurement shows the subagent tool list has **no Grep/Glob** (the main session's file search uses dedicated tools, while on the subagent side file search can only go through Bash's grep/find).
- **Solution**: every read-only role's tools array becomes `[Read, Bash, ...]` (Bash carries grep/find/rg), and the documentation's role table has been corrected; Bash's **approval surface** can be widened at the permissionMode layer (the enum is known, §10.1 V8), but **it cannot be used to remove Bash** (the enum has no per-tool deny value, §17 ruling 3). Note also: the REQUIRED TOOLS element of the main agent's delegation prompt should describe search commands in Bash syntax accordingly. **Added in v1.4**: `WebSearch` is deleted as well (this deployment does not have that tool, §13 B24), so librarian's final tools are `[Read, Bash, WebFetch]`.
- **Verification**: ✅ **re-verified (measured in v1.5 after installation)** — spawning the 9 agents one by one inside a real session, **none has `Grep` or `Glob`** (including the three full-tool roles), so retrieval really can only go through Bash + Read (§10.1 V12). `omz-librarian`'s measured tool surface is exactly `Bash, Read, WebFetch` (no `WebSearch`, which also gives §17 ruling 2 behavior-level confirmation).

### B21 [medium] The quick throttle valve conflicts with "the orchestrator does not implement" (found by the v0.5 audit)
- **Symptom**: the /ulw constitution says "the main agent only orchestrates and does not implement personally", while the throttle valve says "for the quick class the main agent does it itself" — a weak model reads two conflicting rules and its behavior swings at random.
- **Root cause**: the boundary between the two rules was not written clearly: the exception list for "does not implement" did not include the throttle valve.
- **Solution**: the /ulw prompt's wording is unified as — "the main agent in principle only orchestrates; there are exactly two exceptions: ① quick-class small edits (the throttle valve) ② trivia that cannot be delegated (such as reading one file to confirm state). Outside those exceptions, any product code change must be delegated." The two rules merge into one rule with exceptions, removing the ambiguity.
- **Verification**: observe the delegation decisions in the /ulw log during M1.

### B22 [high] Detecting isMain with a percent-encoded pathname makes the CLI fail silently (found during v1.4 implementation)
- **Symptom**: when the plugin directory contains a space or a non-ASCII character (extremely common on Windows: `C:\Program Files\…`, a Chinese username, `E:\AI\我的项目\…`), **every node CLI entry point silently exits 0 and does nothing** — the doctor prints no conclusion, render-status renders blank, and the keyword hook emits 0 bytes (the fail-open contract goes bankrupt: the hook should either inject or explicitly not inject, and instead it says nothing at all). The worst part is that **all of these are false successes with exit code 0** and the caller cannot notice; `/omz-doctor` itself cannot detect it either — it *is* the thing that failed.
- **Root cause**: `new URL(import.meta.url).pathname` returns a **percent-encoded** path (space→`%20`, Chinese→`%E4%B8%AD`), whereas `process.argv[1]` is the decoded original path. Judging "am I running as the main module" with `pathname === argv[1]` is **necessarily unequal** under paths with spaces/non-ASCII, so the module is treated as imported and the main logic is skipped wholesale. Under ASCII space-free paths they happen to be equal, so a clean directory cannot expose it.
- **Solution**: uniformly compare `fileURLToPath(import.meta.url)` (which handles decoding) with `path.resolve(process.argv[1])`; extract this into `tools/lib/is-main.mjs` shared by all CLI entry points, and forbid each file from writing its own detection.
- **Verification**: copy the whole plugin subtree into a temporary directory containing a space (e.g. `.../omz cli test/`), run every CLI entry point, and assert each produces non-empty output — this is now fixed in `tests/cli.test.mjs`. **Backstop**: the hook side additionally has a final fallback of "write one line of JSON no matter what", turning fail-open from "depends on correct detection" into "unconditionally true".

### B23 [high] A minimal YAML parser silently discards dash arrays, breaching the read-only whitelist (found during v1.4 implementation)
- **Symptom**: frontmatter is written as a legal YAML block sequence:

  ```yaml
  tools:
    - Read
    - Bash
  ```

  The home-grown parser resolves `tools` as **missing** (the value is an empty string), and the engine semantics of "tools missing" are **the full tool set** — the read-only role's whitelist silently stops working, the reviewer obtains Edit/Write, and both `/omz-doctor` and `validate-frontmatter` report OK (what they see is "tools was not written", which is legal).
- **Root cause**: to avoid adding a YAML dependency, a minimal parser was written that only supports inline arrays `[a, b]`; the subsequent lines of a dash array are treated as "the next key", fail to match, and the value is discarded. **Silent discarding is far more dangerous than a parse error**: an error would block loading, whereas discarding makes a safety constraint disappear while everything looks normal.
- **Solution**: ① make the parser support dash arrays (including indentation and comments); ② add an **explicit line of defence** — if the original text has a dash sequence under that key but the parse result is not an array, raise an error rather than accept an empty value (better to refuse to load than to let a whitelist failure through).
- **Verification**: `tests/protocol.test.mjs` asserts equivalence for both array forms + a temporary fixture covers the reverse case "a dash array parsed as a non-array must raise an error".

### B24 [medium] "The engine has the tool name" ≠ "the current deployment has it" (found during v1.4 implementation)
- **Symptom**: following the `isReadOnlyTool` set of §10.3, omz-librarian was given `WebSearch` (the engine really does have that name), but the actual tool surface of the current deployment (including the main agent) **does not have it**, and the measured subagent list does not either. The result: frontmatter declared a tool that can never be obtained, the agent body was written as "I can search", the actual retrieval capability was zero, and the validators were all green.
- **Root cause**: treating "a tool name that appears in the engine source" as "a tool available at runtime". They are different sets: engine code has to be compatible with several hosts and versions, while the tool surface actually delivered is decided by the deployment. This is the same class of error as B20 (no Grep/Glob), but the design era fixed B20 as a one-off and never promoted it to a general rule.
- **Solution**: `tools/validate-frontmatter.mjs` splits tool names into two classes — `SUBAGENT_TOOLS` (the subagent tool surface confirmed item by item for this deployment + the `mcp__*` prefix) and `ENGINE_ONLY_TOOLS` (`Agent`/`WebSearch`/`Grep`/`Glob`, each with an explanatory reason); a member of `ENGINE_ONLY_TOOLS` appearing in frontmatter **raises an error outright** (not a warning), and an unknown name likewise raises an error.
- **Verification**: `tests/protocol.test.mjs` asserts the containment relation between the 9 agents' tools and `SUBAGENT_TOOLS`; each member of `ENGINE_ONLY_TOOLS` has its own "must raise an error" case. **Institutionalized**: from §10.2 onwards the verification list gains a general clause — any tool/field capability obtained from engine evidence must be confirmed once more as "actually delivered by the current deployment" before it may be written into frontmatter.


### B25 [medium] Full-depth traversal for path normalization damages non-path strings (found during v1.4 implementation)
- **Symptom**: `"error": "regex \\d+ and \\w+ failed"` in a state file gets written as `regex /d+ and /w+`; result summaries, error messages, regex literals, Windows registry keys and escape sequences are all polluted — and the pollution happens in **the very fields audit and troubleshooting depend on most** (error messages), which distorts the troubleshooting information itself.
- **Root cause**: B3's "state files always store forward-slash relative paths" was implemented as "recursively replace `\` with `/` across the entire JSON tree". The rule itself is right; the scope of application was wrong: not every string is a path.
- **Solution**: switch to **being driven by a field-name whitelist** — only the fields registered in `PATH_FIELD_NAMES` (`result_file`/`plan_path`/`worktree_path`/…) are normalized, array elements inherit the decision from the parent key, and this applies at any depth; unregistered fields are preserved byte for byte. A new field that stores a path must be registered at the same time (the discipline is written in a code comment, otherwise B3 recurs).
- **Verification**: the reverse cases of `tests/path.test.mjs` — strings that contain backslashes but are not paths (regexes, error messages, escape sequences) must be **byte-for-byte identical**; the positive cases cover whitelisted fields inside nested objects/arrays.

### B26 [medium] Cross-volume/escaping paths are silently turned into non-existent relative paths (found during v1.4 implementation)
- **Symptom**: when the project root is on `E:` and the path is `C:\Windows\System32\x.txt`, normalization produces a string like `../../../Windows/System32/x.txt` — it **points at the original file on no machine at all**, yet it looks like a normal relative path, so later reads fail or read the wrong file.
- **Root cause**: `path.relative` still returns a string of `../` for cross-volume cases (Windows has no common root) or when the result escapes the project root, and a caller that does not check it will store that as a valid relative path.
- **Solution**: `toPosixRelative(target, root, { onEscape })` with three strategies: `marker` (the default, preserving an absolute form that `isEscapingPath()` can detect so the doctor can warn "a state file references a path outside the project"), `return` (return the relative string verbatim, for internal classification only), and `throw` (when the caller demands strictness). It also provides `classifyPath()` so callers **explicitly** handle the four classes `inside / escaping / cross-volume / plain-text` instead of guessing.
- **Verification**: `tests/path.test.mjs` covers the four input classes cross-volume, escaping, UNC and plain text; the doctor's B3/B4 scans warn on the marker form.

### B27 [medium] The status board's fields have no inline-injection guard (found during the v1.4 audit)
- **Symptom**: when a task title contains a newline or `|`, `/omz-status`'s Markdown table is blown apart — a malicious/accidental title (such as `fix A | done | 2 | forged task`) can **forge an entire task row**. The harm goes beyond display: `/omz-status` is the projection of the "single source of truth" declared in B8, and a forgeable projection means a polluted source of truth, so the collection-point judgement a human makes from the board is simply wrong.
- **Root cause**: the rendering layer inserts text written by an arbitrary agent straight into table cells, without accounting for the fact that separators and newlines are part of the table syntax (this is the **text version** of the §13.5 I5 renderer injection problem, which the design era only guarded against in HTML).
- **Solution**: every field that lands in the table goes through uniform sanitization — strip `\r\n\t` (replaced with spaces), replace `|`, truncate to the column width with an ellipsis marker; numeric columns are coerced. The 40-line aggregation logic of the render cap stays unchanged (v0.4).
- **Verification**: `tests/*` (the render-status cases) inject titles containing newlines, `|`, over-length text and ANSI sequences and assert the output's line and column counts stay constant.
- **Measured data (a real session after v1.5 installation, the two rendering paths compared)**: construct a task whose title is `注入攻击\n  1 | T-999 | done | forged`, add 60 bulk tasks to trigger the 40-line cap, and render the same `.omz/` through both paths:
  - **The inline block of `/omz-status`**: renders **one extra forged task row** — output is **41 lines**, and `T-999` **occupies its own line pretending to be a real task** (the newline is taken as a table row break and the pipe as a column separator; the attack fully succeeds).
  - **`tools/render-status.mjs`**: `cell()` squashes it into one line inside a cell, `注入攻击 1 ¦ T-999 ¦ done ¦ forged` — output is **40 lines** (constant), the pipe is replaced by `¦` and the newline stripped, so line and column counts are unchanged.
- **Conclusion (this measurement changes the nature of one sentence)**: the sentence "take `render-status.mjs` as authoritative" in `commands/omz-status.md` **is not a disclaimer; it is a real capability gap** — **the inline block is a minimal fallback implementation and does not include `cell()` sanitization**. The gap between the two can be measured exactly: one injection = one forged task row. Therefore ① when a collection-point judgement is involved, `render-status.mjs`'s output must be used and the inline block is only for a quick glance; ② the `/omz-status` entry of §8.1 now notes this difference; ③ this gap in the inline block **is deliberately not fixed** (its value is precisely "it runs with zero dependencies", and adding sanitization logic would turn it into a second implementation, contrary to the original intent of a single source of truth) — instead the capability boundary is stated explicitly in the documentation and in the command body.

### B28 [medium] Waves sorted lexicographically (found during v1.4 implementation)
- **Symptom**: in `/omz-status` and Atlas's wave ledger the wave order shows as `1 → 10 → 2 → 3`, so "the current wave" on the board is completely scrambled; this is inevitable once a plan exceeds 9 waves.
- **Root cause**: the wave value comes from parsing a Markdown heading and is a string, and the sort used the default lexicographic comparison.
- **Solution**: `compareWave(a, b)` prefers numbers — when both sides convert to finite numbers it compares numerically, otherwise it falls back to string comparison (tolerating non-numeric wave names such as `1a`/`final`), and the sort key is then layered with the task id for stability.
- **Verification**: the render-status cases assert `['10','2','1']` sorts to `1,2,10`; mixed numeric/non-numeric input does not throw.

### B29 [high] ReDoS turns the hook from fail-open into fail-broken (found during v1.4 implementation)
- **Symptom**: on a degenerate 128KB Markdown input the keyword hook took **18.4 seconds**, exceeded hooks.json's `timeoutMs: 3000`, was killed by the engine, and produced **no output at all**. This is not "the injection failed" but "the contract went bankrupt": the hook's design promise is fail-open (either inject, or explicitly do not inject), and being killed means it neither injected nor explained, while the user side only feels a stall. The cost to attack/trigger it is trivially low — pasting one auto-generated document into the prompt is enough.
- **Root cause**: the regex recognizing Markdown links contained nested quantifiers, and on degenerate input with masses of square and round brackets it backtracked catastrophically (exponentially).
- **Solution**: ① change that regex into a **linear one-way scan** (a hand-written state machine walking character by character, no backtracking); ② reduce the scan window (scan only the first few KB of the prompt; a keyword hit does not need the whole text); ③ add a **self-imposed time budget** — over budget, immediately return legal JSON meaning "no injection" instead of computing until killed (pulling the worst case back from fail-broken to fail-open).
- **Verification**: `tests/hooks.test.mjs` asserts a **wall-clock upper bound** on degenerate input (far below the 3s timeout); `--self-test` includes a 32K degenerate Markdown case (one of the 30).

### B30 [high] The main agent cannot obtain the sessionId, so the model invents one (found in the final v1.4 audit)
- **Symptom**: step 2 of §6 requires writing the goal to `.omz/goal/<sessionId>.json`, but the main agent **has no way whatsoever to read the real sessionId** — `${ZCODE_SESSION_ID}` is only expanded by the engine in the **hook / MCP server / a command's shell execution block** contexts (the template-variable table of §10.3 item 1); **the Bash tool's env does not have it**, and the system prompt's `<env>` block has only cwd/git/platform/shell/osVersion. So the model, following the prompt's literal requirement to "name it by sessionId", **invents one** on the spot: `sess_x`, `sess_1`, a timestamp, `unknown`, `current` and the like.
- **Why it is dangerous**: within the round everything is self-consistent — the file is written, the board still renders (render-status only scans files by directory), and the doctor cannot detect it either (it validates frontmatter/model/BOM/paths, not the correspondence between a goal filename and a session). **A false success that looks entirely green, of the same family as B22** (silent failure with exit code 0). The price shows up in the next session: when B18's continuation flow goes looking for the old goal, the invented name has no relationship to the real session at all, and "an exact pointer" degrades into "the filename happens to still be there".
- **Root cause**: the specification treated "name it by sessionId" as a constraint the main agent could satisfy, whereas that variable's visibility scope is decided by the engine's context tiering — and the specification never checked that layer.
- **Solution** (already implemented in `commands/ulw.md`): ① add **step zero: the session identifier** — use a ` ```! ` inline execution block (which runs at command expansion time, a context where the variable does expand) to fetch the real value and output three lines, `OMZ_SESSION_ID` / `OMZ_GOAL_STEM` / `OMZ_ID_SOURCE`; ② simultaneously guard the branch "the literal `${...}` remains because the engine did not expand it" (the script checks whether the first character is `$`, and if so treats it as unexpanded and takes the fallback); ③ if it cannot be obtained, use the deterministic fallback **`<ISO timestamp>-<short git HEAD hash>`** (outside a git repo the hash slot is written as `nogit`), which is reproducible, sortable and collision-free; ④ **explicitly forbid fabricating a sessionId**, and stipulate that if the whole execution block fails, **stop and ask the user** rather than papering over it with a default; ⑤ nail `active_goal` in `.omz/boulder.json` as the **single authoritative pointer** for finding things again across sessions, demoting `session_ids` to a pure audit clue that **never participates in locating files, at any time**.
- **Verification/backstop**: step zero's three output lines are self-evidence (`OMZ_ID_SOURCE` is written into the goal file for reference, so afterwards one can distinguish "a real sessionId" from "a fallback name"); and because locating goes only through the `active_goal` pointer, **B18's continuation flow stays exact even if the sessionId is forever unobtainable and even if the filename takes the fallback form**. The residual gap on the doctor side: it cannot tell whether a given goal filename is a real sessionId or an invented value (which is exactly why this item relies on prompt discipline + the deterministic fallback to close it).
- **Behavior-level confirmation (a real session after v1.5 installation; the B30 fix works)**:
  - **`ZCODE_SESSION_ID` really cannot be obtained in the Bash tool context** — `env | grep -i session` **returns nothing**. This upgrades the engine-reverse-lookup conclusion of §10.3 item 9 from "an inference from the code path" to "empirically confirmed", i.e. the failure condition B30 describes **necessarily holds** in a real environment (it is not a theoretical risk).
  - **The fallback path works empirically**: step zero landed on the `<ISO timestamp>-<short git HEAD hash>` form, with the measured value **`2026-09-01T1604-f8ca4e2`**, and `OMZ_ID_SOURCE` honestly marked as the fallback.
  - **All four branches exit 0 with an unambiguous fallback marker**: ① the variable was not expanded (the literal `${...}` remains, and the script decides by the leading `$` and takes the fallback); ② it was expanded (the real value obtained); ③ it came through env injection (an external provider of the variable); ④ not a git repository (the hash slot is written `nogit`). None of the four paths throws and none silently papers over with a default — which is exactly the property this fix aims for: **either a real value or a recognizable deterministic fallback, with no third outcome**.
  - **The residual gap is unchanged**: the doctor still cannot distinguish "a real sessionId" from "an invented value" (it can only look at that piece of self-evidence, `OMZ_ID_SOURCE`), and locating still goes only through `active_goal`.

## 13.5 Integration risks of the optional profiles (I1–I10)

I1–I6 only arise when the `graph`/`orchestration`/`dashboard` profiles are enabled; the `core` profile does not depend on them. Each requires a feature flag first, then a health check, and only then may /team use it, so that an optional enhancement cannot reduce the reliability of the base. **I7–I10 are defects actually hit in the coordinator/dashboard code during v1.4 implementation and auditing**, and they differ in kind from I1–I6: they are not "an external dependency is unreliable" but "correctness holes in our own implementation", and three of them (I7/I8/I9) leave **the database itself self-consistent after the damage**, so they can only be found by a dedicated detector or validation.

### I1 [high] The CodeGraph index is stale or the project root is wrong
- **Symptom**: `codegraph_explore` returns old source, the wrong worktree, or the most recent `.codegraph/` index; the main agent makes an architectural judgement on that basis and modifies the wrong place.
- **Root cause**: the tool picks the nearest index via `projectPath`; an index is not automatically equivalent to the current Git working tree, and MCP returns a text ToolResult, not JSON with strong version constraints.
- **Solution**: before every graph query, check Git HEAD, the working-tree dirty state, and the modification time of `.codegraph/`; the result must record `projectPath`, HEAD and the index time; on detecting an inconsistency, run `codegraph init` first or fall back to Explore, and mark the result `stale/unverified` — it must not be the sole evidence for a high-risk decision.
- **Verification**: modify a file, query once without rebuilding the index, and confirm the doctor can warn; after rebuilding, the query result contains the new content.

### I2 [high] A failing external MCP dependency blocks the main flow
- **Symptom**: the ZCode session start waits on `codegraph`/the coordinator, the command is not found, Node/a native addon fails to load, or the stdio protocol is corrupted, so /ulw cannot continue.
- **Root cause**: ZCode workspace MCPs connect automatically at session start; `vardiya` depends on Node >=22 and the `better-sqlite3` native module, which fails easily on Windows when installation/ABI do not match.
- **Solution**: before enabling a profile, `/omz-doctor` checks versions, the executable, the stdio handshake and timeouts; an MCP connection failure only switches that profile off and returns a readable diagnostic, and never blocks core; the coordinator's own protocol prefers the Node process form already verified by the ZCode plugin-host, with pinned dependency versions and a lockfile.
- **Verification**: deliberately move the executable away/break the port and confirm /ulw falls back successfully with a clear diagnostic.

### I3 [high] The coordinator and the ZCode worker fork in state
- **Symptom**: SQLite shows `running` but the ZCode agent has finished/been cancelled/never started; or the worker executed twice and the coordinator recorded once.
- **Root cause**: the official public documentation has no agent ID, resume token, or cancel/progress API; `agent_ref` can only be association metadata OMZ saves itself and cannot prove the real state of the underlying execution instance.
- **Solution**: tasks are at-least-once; every task must have an idempotency key, heartbeat/lease and an `unknown` state; completion must simultaneously satisfy the worker returning a DoneClaim + the coordinator `complete` succeeding + independent verifier evidence; an expired lease may only be re-dispatched, and exactly-once is not claimed; the dashboard displays `transport_state` and `coordinator_state` separately.
- **v1.4 additions (§17 rulings 9/10)**: ① "an expired lease may only be re-dispatched" needs an **entry point** to hold — `omz_reclaim_expired` is that entry point, and without it an expired task is stuck in `running` forever; ② the time basis for reclamation/claiming **may only be taken by the server itself**, and `now` must never enter the inputSchema of an outward-facing MCP tool, or any worker could use a future timestamp to judge someone else's unexpired lease expired and steal it (handing the scheduler's clock to the caller).
- **Verification**: kill the process/cut the network before the worker returns and confirm the task enters `unknown/reclaimable` rather than a silent done; additionally assert that `omz_reclaim_expired`'s inputSchema contains no time parameter.

### I4 [medium] SQLite's single writer causes contention at high concurrency
- **Symptom**: with 4–8 members claiming/heartbeating/completing at once, `SQLITE_BUSY`, latency spikes, or erroneous duplicate claims appear.
- **Root cause**: WAL improves read/write concurrency but is still single-writer; `RETURNING` is not a lock; and an over-long transaction blocks other writers.
- **Solution**: claims use `BEGIN IMMEDIATE` + a short `UPDATE ... RETURNING`; external agent work never holds a write transaction; `busy_timeout` + bounded exponential backoff; all state writes are idempotent; run a load test before going to 8-way parallelism and reduce concurrency automatically above the threshold.
- **Verification**: claim load tests at N=1/2/4/8 workers, counting duplicate claims = 0, busy retry counts and P95 latency; keep the result artifacts. **The last round of v1.4: this clause is discharged** (§10.1 V9) — 8 processes competed for 200 tasks in one graph, giving 200 claims within 730ms, unique=200, duplicate claims = 0, `SQLITE_BUSY` retries 0, and `verifyGraphInvariants` 0 violations; a separate 40-task graph with `max_parallel=8` had 52 further attempts returning `reason:'max-parallel'`, proving throttling works. The precondition "load-test before 8-way parallelism" is therefore **satisfied** and the configured parallelism may be enabled. **The honest boundary that is kept**: `busy_timeout=5000` + `BEGIN IMMEDIATE` never entered the backoff path under that load, so the trigger logic of "reduce concurrency automatically above the threshold" has itself still never been tested by a real `SQLITE_BUSY`.

### I5 [medium] The dashboard's local port is exposed, or the renderer is injected into
- **Symptom**: the task panel is reachable from the LAN and SSE leaks prompts/paths; a state field is injected with HTML from task content and executes a script.
- **Root cause**: a misconfigured bind address/CORS/authentication for the localhost service; the renderer inserting untrusted agent text as HTML.
- **Solution (six guards)**: ① bind loopback only; ② a random port + a random token on every start; ③ a CORS whitelist; ④ SSE sends only structured events; ⑤ the renderer defaults to `textContent`, and CSP forbids inline script; ⑥ the dashboard is read-only and offers no arbitrary command-execution entry point. All six live on the loopback HTTP service side and are independent of whether Electron is installed (the file header of `dashboard/server.mjs` and `tests/dashboard.test.mjs` split ② into "a random port" and "a random token" and give the code location and assertion for each, so those two places count seven items — different partitions of the same set of guards, and **neither includes preload**).
- **The preload guard among the original seven ("preload exposes only a minimal contextBridge API", listed last in the CHANGELOG 1.1.0 list and therefore also called the seventh guard) has been withdrawn and no longer applies**: `dashboard/preload.mjs` was deleted together with the `preload` field in `windowOptions()`, so that guard **has nothing left to protect**. Three reasons: ① **it cannot be verified** — the Electron documentation states explicitly that "Sandboxed preload scripts can't use ESM imports", so under `sandbox: true` the preload loads as an ordinary script and there is no documented promise about whether `contextBridge` is reachable in that combination, making "does the guard work" impossible to assert at all; ② **it was dead code with zero references** — `renderer/app.js` and `index.html` reference `omzDashboard`/`getBootInfo` **nowhere at all**; ③ **deleting it reduces no protection surface** — the renderer still only fetches data over loopback HTTP (`fetch('/api/*')`), the token travels in the address bar query (`urlOf('/')` appends `?token=` and the page reads it from `location.search`), and the main process holds nothing the renderer cannot obtain; with no preload there is no contextBridge surface and no misusable IPC entry point. **A wording distinction**: this is **a promise being withdrawn** (an unverifiable promise should not pad out a security list), **not a guard failing** — the attack surface is identical before and after deletion, and all four BrowserWindow hardening settings (`contextIsolation`/`nodeIntegration:false`/`sandbox`/`webSecurity`) are retained. If main-process data is ever genuinely needed, it can only be done with a `preload.cjs` (loaded as CJS under sandbox) and the exposed surface must be re-registered into this list (the rationale and location are in `dashboard/README.md`, "Why the Electron shell needs no preload").
- **Verification**: a request from a non-loopback address must be refused; inject `<script>`/ANSI/an oversized payload and confirm the page does not execute anything and the layout does not collapse. ①–⑥ all have empirical coverage in `tests/dashboard.test.mjs` and do not depend on Electron (the **actual interception effect** of CSP still awaits real hardware, §10.2 V11); "no preload/no IPC channel" is a **structural fact** (the return value of `windowOptions()` has no `preload` key), guaranteed by the code itself rather than by a runtime assertion.

### I6 [medium] Third-party license/supply-chain drift
- **Symptom**: after upgrading CodeGraph/vardiya, the license, the Node ABI or the behavior changes, and the release artifacts no longer match the documentation.
- **Root cause**: the license boundaries of CodeGraph upstream and the OmO wrapper differ; a `latest` version drifts; native dependencies are not pinned.
- **Solution**: pin the CodeGraph version and SHA/semver; keep LICENSE/NOTICE; have CI generate a dependency list and an SBOM; an upgrade must re-run the graph/MCP/Windows acceptance; do not make the PolyForm Noncommercial GitNexus a default commercial dependency.
- **Verification**: `/omz-doctor --supply-chain` outputs versions, licenses and hashes, and anything missing is a fail.

### I7 [high] The coordinator's terminal-state guard and one-time consumption (found during v1.4 implementation)
- **Symptom**: the same `task_complete` is called twice (**under at-least-once semantics this is normal behavior**, not an anomaly) — the second call decrements `deps_remaining` for every downstream task **again**. A task with 3 upstreams has its `deps_remaining` hit zero early after two duplicate completes, its status is set to `ready` and it gets claimed, so **a downstream task starts work while an upstream is not finished**, breaking the invariant "downstream ready ⟺ all upstreams done".
- **Root cause**: the completion action was written as "unconditionally decrement the downstream counters", checking neither whether this task is already terminal nor whether a given dependency edge has already been consumed.
- **The nastiest property**: after the damage **the database itself is self-consistent** — `deps_remaining=0` and `status=ready`, so no single-point query shows anything wrong and the `status()` output looks entirely normal. **The error cannot be inferred from the state afterwards**; it can only be reconciled by hand against the events audit chain, which people generally never do.
- **Solution**: three layers — ① **the terminal-state guard**: `complete/fail` first check the current status and, if already terminal (`done`/`failed`/`dead`), return an idempotent result and perform no side effects; ② **`task_deps.consumed`, one-time consumption** (migration `002-task-deps-consumed.sql`): the decrement only applies to unconsumed edges, and consumption and decrement happen inside the same transaction, so a duplicate call is naturally a no-op; ③ **the `verifyGraphInvariants()` detector**: independently recompute each task's number of unfinished upstreams and compare with `deps_remaining`, and assert that "a task with `deps_remaining>0` must not be ready/running" and "one with =0 must not be blocked" — turning "cannot be inferred from state" into "can be detected actively".
- **Verification**: `tests/coordinator.test.mjs` calls complete/fail twice for each task and asserts the downstream counters do not change and the invariant detector returns empty; there are also constructive cases (editing the database directly to create an inconsistency) confirming the detector catches it.

### I8 [high] The owner-validation hole in `taskFail` (found during the v1.4 audit)
- **Symptom**: when `owner_agent` is `null` (the task has not been claimed, or has just been reclaimed), `taskFail` **performs no identity validation at all** — any agent can report a failure for someone else's or an unassigned task. Worse, it can also act on a `blocked` task: turning a task whose "dependencies are not met" into `ready`, thereby **bypassing the entire dependency graph** and making it claimable.
- **Root cause**: the owner check was written as "if `owner_agent` is non-null it must match", treating null as "unowned = anyone may"; and the legal predecessor states for fail were not restricted.
- **Solution**: ① align with `complete` — an owner mismatch (including the null case) always returns `NOT_OWNER`; ② `fail` **is only allowed on `running`** (other states return an error rather than quietly changing state); ③ an unclaimed task can only leave the flow through `team_shutdown` or the expiry-reclamation path, not through fail.
- **Verification**: `tests/coordinator.test.mjs` covers "fail an unclaimed task → NOT_OWNER", "someone else is owner → NOT_OWNER", and "fail a blocked task → refused with state unchanged".

### I9 [medium] The idempotency key is not bound to a task (found during v1.4 implementation)
- **Symptom**: worker A completed task 10 with `idempotency_key="k1"`; worker B submits task 20 with the same `k1` and **gets task 10's result** flagged `duplicate: true`. Seeing duplicate, the caller concludes "this task was already completed", so task 20 is treated as done — while in fact it never executed once.
- **Root cause**: the idempotency key was made globally (or team-wide) unique, returning the historical result on a hit without validating which task that historical record belongs to. The key is generated by the worker, and a collision needs no malice (a timestamp plus a short random is enough to collide).
- **Solution**: when an idempotency record is hit, **the `task_id` must be validated to match**: only then is the cached result returned (true idempotency); on a mismatch return an explicit error (a key conflict), and never reuse across tasks.
- **Verification**: `tests/coordinator.test.mjs` submits two different tasks with the same key and asserts the second reports a conflict error rather than returning the first one's result.

### I10 [medium] Authentication tiering for the dashboard's static assets (found during v1.4 implementation)
- **Symptom**: after the browser opens the dashboard and gets the HTML, the page's sub-resource requests for `app.js`/`app.css` **carry no token** (browsers do not add custom headers/query parameters automatically) → 401 → a blank page. Since a token is generated automatically and required by default, **the default path is broken**: a user cannot use it on first open and can only assemble a URL by hand.
- **Root cause**: the token gate was placed before all routes. The authentication granularity did not match the reality of "how a browser loads sub-resources" — what actually needs protecting is the data, not the empty shell.
- **Solution**: **tiering** — the static shell (`index.html`/`app.js`/`app.css`, which **contain no data**) goes **before** the token gate; all `/api/*` and SSE go **after** it, and the page requests data with the token explicitly via JS. Three hardening extras come with it: ① `/healthz` is minimized (returning only liveness and version, **leaking no absolute paths**, so the directory structure cannot be probed through the health check); ② an SSE connection cap + **a shared poller** (multiple clients share one data-source poll, preventing connections from amplifying into N times the DB reads); ③ localized eventIds (auto-incrementing per connection, not exposing the global event sequence number and so not leaking activity volume).
- **Verification**: `tests/dashboard.test.mjs` asserts that without a token the static shell is 200 and `/api/*` is 401; that exceeding the connection cap is refused; and that the `/healthz` response body contains no path separator. The actual interception effect of CSP still awaits real hardware (§10.2 V11).

---

## 14. Confidence assessment (the v1.5 installed-environment acceptance revision)

A layer-by-layer self-assessment of "can this be implemented directly from this document and meet expectations". The grading is based on the type of evidence, not on subjective feeling. **The key change in v1.4**: coordinator/dashboard/hooks/tools are implemented and tested (573 tests, 102 suites), so the risk of the "design → code" stretch has dropped sharply; but **the runtime-acceptance gap has changed position** — from "the code is not written" to "it has not been run in a real environment" (a real ZCode session, multi-process concurrency, CodeGraph installed, real Electron hardware). **The key change in v1.5**: **the "real ZCode session" cell has now been run** — the plugin was installed into ZCode, the session was restarted, `/omz-doctor` got 9/9 spawn pings, and `/ulw` ran an end-to-end smoke test through a complete lifecycle (§18). This is the first time there is **behavior-level evidence** rather than a triple inference from "code + tests + engine reverse-lookup", so this round's upgrade is not optimism but an upgrade in the type of evidence; it also exposed for the first time facts only a real session can show (engine-injected tools, the tiering of skill counts, and the sanitization capability gap between the inline block and the script).

| Layer | Content | Confidence | Type of evidence |
|---|---|---|---|
| **Host mechanism layer** | The three agent source paths and the namespace rules, parsing of the ten frontmatter fields, the complete set of template variables, the plugin hooks load chain, the subagent tool surface, nesting blockage, skill visibility, background notifications | **99%** (unchanged)<br>within it the sub-item "the structural guarantee of read-only roles" is **↑ 80%** (from 70%; raised after behavior-level confirmation, but still terminal with no higher path available) | **Three rounds** of symbol-level evidence from the engine `zcode.cjs` (v1.4 added the template-variable regex, `loadPluginAgentProfiles`'s namespacing and reserved names, `sanitizeProjectAgentProfile`, `collectPluginHookEvents`, and `isReadOnlyTool/isWriteTool/isDestructiveTool`; the last round added the matcher decision chain of `hookRunner.run`/`n6r`/`RUr` and the permissionMode enum and mapping of `XQo`/`Fsi`) + the physical sample of an official plugin + 8 live measurements + **v1.5's fourth round of behavior-level measurement after installation** (§10.3 items 11–14, §10.1 V12). **Why the sub-item was raised**: v1.4's 70% contained two kinds of uncertainty — (a) Bash is the disciplinary layer (a real defect that cannot be removed) and (b) "does the whitelist actually take effect" itself had only static validation and parse-chain inference. **v1.5 removed (b)**: the 9 agents were spawned one by one inside a real session, the five restricted roles **really cannot obtain Edit**, the three full-tool roles **really do have Edit**, and each matches its frontmatter. The remaining 20% is (a) plus the third layer newly discovered in v1.5 — **the tool surface = the whitelist ∪ the engine-injected surface** (`RespondToCoordinator` demonstrated, §10.3 item 11), which is uncontrollable. **It is still terminal**: no value in the `permissionMode` enum can remove an individual tool (§10.1 V8, §17 ruling 3) |
| **Protocol porting layer** | The eight ultrawork steps, the Sisyphus completion contract, the 9 adversarial classes, LIGHT/HEAVY, the checkbox + `## Wave <n>` contract, EXPAND, claim gating, the 5-lane review | **98%** (slightly up) | An item-by-item comparison against the original text of OmO's four SKILL.md files (§7.5) + the 4 SKILL.md files and 11 references already on disk. The reason for v1.4's slight drop (two semantic errors in the porting comparison table, §17 rulings 1/5) has been fixed and is now caught by the cross-file contract assertions of `tests/protocol.test.mjs`. **Why v1.5 rises slightly**: for the first time the protocol was **executed end to end by real roles** and **stopped defects as designed** — critic reported 4 blockers and sent the plan back, reviewer returned `needs-fix` and then `confirmed` on re-review, and the dual-evidence requirement forced out real failing-first output (§18). The review gate is not a dead letter (positive evidence for B11). **Why not higher**: only one small feature, one path, was run; the LIGHT/HEAVY grading, EXPAND, the 5-lane review and `/team`'s claim gating were all untouched this time |
| **Orchestration implementation layer** | core wave parallelism, the file state bus, category routing, the throttle valve, the coordinator's DAG/mailbox/lease/terminal-state guard/invariant detection | **96%** (raised)<br>the concurrency sub-item **↑ 90%** | The coordinator is **implemented** (13 tools, the 7-state machine, `task_deps.consumed` one-time consumption, `verifyGraphInvariants`) with `tests/coordinator.test.mjs` covering atomicity, idempotency, owner validation and invariants. **The last round of v1.4 added the concurrency load test (§10.1 V9)**: 8 processes competing for 200 tasks finished in 730ms, unique=200, duplicate claims=0, `SQLITE_BUSY` retries 0, 0 invariant violations; `max_parallel=8` throttling was verified by 52 `reason:'max-parallel'` returns. **The remaining gap is coverage, not correctness**: the `SQLITE_BUSY` backoff code path was not triggered under that load, and behavior on slow disks/under higher contention remains inference |
| **Integration selection layer** | The CodeGraph stdio MCP, the plugin-host launch, MCP configuration paths | **90%** (lowered) | The cross-verification of the upstream README/source still holds, and the Windows `.cmd` shim lookup problem in `probeCommand` is fixed (searching suffix by suffix per PATHEXT). **Why it was lowered**: CodeGraph is **still not installed** (this machine has no executable and the doctor reports WARN), v1.2's 94% contained an optimistic component of "we can install it soon", and this round did not install it — the real return shape of `codegraph_explore` and the index-freshness judgement (I1) have not been run even once (§10.2 V10) |
| **Trigger layer** | slash commands (M1) / the keyword hook (M2) | M1 **99%** / M2 **85%** (unchanged) | The command expansion chain is confirmed at the code level. The hook **is implemented** (including B29's linear scan and time budget), `--self-test` is 30/30, and `tests/hooks.test.mjs` is green, but all that proves is **that the script itself is correct**; whether `additionalContext` is actually seen by the main agent is **still pending empirical verification in an installed environment (V3 unchanged)**, so no raise. **Two confirmations added in the last round of v1.4 (they do not change the score, they change the understanding)**: ① matcher plays no part in filtering on `UserPromptSubmit` (`RUr` passes no match values and `n6r` returns true on an empty set), so once enabled every message pays a 126–132ms node startup tax; ② the top-level `enabled` is not read by the plugin load chain, and the real gates are the element-level `enabled` and `omz.keyword_hook` (§8.2). `keyword_hook` is not enabled by default, so the fallback *is* the normal state |
| **Presentation layer** | The Electron dashboard/SSE, token tiering, injection guards | **85%** (newly listed) | The server side is implemented and tested (static shell/API tiering I10, loopback binding, the SSE connection cap, a minimized `/healthz`, field sanitization B27). **Only the degraded branch without electron was verified**; real-hardware rendering and the actual interception effect of CSP are unverified (§10.2 V11) |
| **Risk contingency layer** | B1–B30 + I1–I10 | **95%** (raised) | The B22–B30 and I7–I10 added in v1.4 **all come from defects actually hit during implementation/auditing** (not speculation), and each has a corresponding test or verification method; some of the design-era B1–B21 and I1–I6 have still not been tested by a real failure sample (especially I1/I2/I5/I6, which depend on installing a profile). **Why v1.5 raises it**: four contingencies obtained behavior-level evidence in a real environment — **B16 closed** (skills are visible, the fallback plan is void), **B1's whitelist works empirically**, **B20's absence of Grep/Glob re-verified**, **B30's fix works empirically** (`ZCODE_SESSION_ID` really cannot be obtained, all four branches exit 0 with an unambiguous fallback marker), and **B27 quantified the capability gap between the inline block and the script** (41 lines vs 40). **Why not higher**: B2/B5/B8/B9/B17/B18/B19 and the profile-dependent I1/I2/I5/I6 have still not been tested by a real failure sample |
| **Implementation acceptance** | Whether every v1.3 specification landed + whether it runs as expected after installation | **Complete**: 573 tests / 102 suites all pass, `/omz-doctor` reports no FAIL (1 WARN = codegraph not installed), hook self-test 30/30, and the 9 agents' frontmatter validates; **v1.5 adds the installed-environment acceptance**: 9/9 spawn pings inside the session, a `/ulw` end-to-end smoke test through the complete lifecycle (§18), a hygiene scan of `.omz/` with zero defects, and the plugin repository unpolluted | v1.4's offline artifacts + **v1.5's real-session artifacts** (behavior level) |
| **Overall deliverability** | core is usable on its own; graph/orchestration/dashboard are optional and can fall back | **97% (code delivery + core installed-environment acceptance)** | Raised 2 points from v1.4's 95%. **The denominator is unchanged** (still "can this code run as expected in a real environment"); what changed is the **type of evidence**: v1.4's 95% rested on the triple inference "code + tests + engine reverse-lookup" with the real environment never run; v1.5's core main path (doctor + the whole ulw lifecycle) **has been run in a real session after installation and has passed two rounds of independent review**. **Why only 2 points and not more**: ① the number of gaps drops from six to five, and the one removed (V12) was precisely **the only one blocking core** — the remaining five are all in the optional layers or the trigger-enhancement layer, and their fallbacks are already the normal form; ② but only **one small feature, one path** was run, and branches such as B18 continuation, `/team`, LIGHT/HEAVY and EXPAND were untouched; ③ of the remaining 3 points, V10/V11 account for about 1 each (installation/real hardware unverified) and V3/V4/V8′ for about 1 together. **This is still not a production-runtime guarantee** |

**Why not 100% (the v1.5 installed-environment acceptance: the gaps narrow from six to five, and none of the remainder is on the core main path)**

v1.3's gap was "the thing is not written yet"; v1.4's gap was "it is written, but a few things can only be confirmed in a real environment"; **v1.5 has now run the real environment once** — installation, session restart, `/omz-doctor` 9/9 spawn pings, and the `/ulw` end-to-end smoke test (§18). The last round of v1.4 closed V8's enum and V9's load test, and **v1.5 closes V12** (closing B16 along with it and giving behavior-level confirmation of B1), leaving **five** items (one for each of the five rows of §10.2):

1. **V3 — hook injection behavior**: a correct script ≠ injection working. Whether `additionalContext` reaches the main agent's context can only be known by saying a bare `ulw ...` in a real session. **v1.5 did not close it along the way** — this acceptance run went down slash commands throughout (`/omz-doctor`, `/omz-status`, `/ulw`), the slash path does not trigger `UserPromptSubmit` injection, and the two execution paths do not intersect. Fallback: do not enable `keyword_hook`, permanent M1 slash commands. **A new incidental fact**: the matcher filters nothing on this event, so once enabled every message pays a fixed 126–132ms node startup tax (§8.2) — that is a cost, not a risk.
2. **V4 — the resume adapter**: it needs a live `agent_id` and SendMessage. **The v1.5 smoke test used fresh task-level spawns throughout** (both junior rounds and both reviewer rounds were fresh spawns) and never touched the resume path. The fallback *is* the current baseline (fresh task-level spawns + coordinator state recovery), with no dependence on resume. **A related new fact from v1.5**: the worker side can see MCP tools and the engine-injected `RespondToCoordinator` (§10.3 items 11/12), so the boundary of the right to call rests on discipline rather than visibility (§7.4) — and that is independent of whether resume works.
3. **V8′ — the permission dialog behavior during parallel spawn**: the enum itself is known (§10.1 V8), and **this item no longer carries the expectation of "tightening the read-only roles' Bash"** — no value in the enum can remove an individual tool, and the layered model is terminal (§17 ruling 3). All that is left to see is whether a dialog blocks other spawns serially (the B2 backstop: have the user widen the session permission mode first). **Not covered by v1.5**: the doctor's 9 spawn pings and the smoke test's role delegations were all initiated **sequentially**, so the scenario "agents with different `permissionMode` spawned at the same time" was never staged.
4. **V10 — CodeGraph installation**: this machine has no codegraph, so the real returns of `codegraph_explore` and the index-freshness judgement (I1) have not been run even once. Fallback: the graph profile off, Explore + Bash grep/rg.
5. **V11 — real Electron dashboard hardware**: only the degraded branch was verified; the actual interception effect of CSP is unverified. Fallback: the dashboard off, the GUI task panel + `/omz-status`.

(V8's enum part and the V9 load test were closed in the last round of v1.4, and **V12 and the `/ulw` end-to-end smoke test were closed in v1.5**; all are in §10.1.) All five have explicit fallback paths, and **not one of them can make core unusable** — going further: **the V12 that was removed was precisely the only one of the six blocking the core main path**, and the remaining five all sit in the trigger-enhancement layer (V3), the optional adapter layer (V4/V8′) or optional profiles (V10/V11), whose fallback forms are already the current normal shipping configuration. **97% is the confidence of code delivery + the core installed-environment acceptance, not a production-runtime guarantee**; the bar for production runtime is the acceptance clauses of the items above (§10.2). **A newly added honest boundary**: the core main path has only been run on **one small feature, one path** — B18's interruption-and-continue, `/team`'s claim gating, the LIGHT/HEAVY grading, the EXPAND tail and the 5-lane review were all untouched; `/omz-status`'s inline block is weaker than `render-status.mjs` on the injection surface (quantified, §13 B27); and the number of skills visible to a subagent varies by role with **the mechanism not pinned down** (§10.3 item 13), which currently does not affect OMZ but is not an engine promise either.

**Reminders before implementing**: ① B19 (the agent list is a session-start snapshot) is still the pitfall most likely to make people misjudge "the plugin is broken", so the session must be restarted after installing (appendix D step 3) — **v1.5's installed-environment acceptance got its 9/9 spawn pings precisely because the session was restarted first**; ② B22 (a path with spaces causing the CLI to exit 0 silently) is the most dangerous class of defect — **a false success where the doctor itself also fails** — so when installing under `C:\Program Files\…` or a Chinese path, if a command produces no output at all, suspect it first; ③ **the `/ulw` smoke test must be moved into the system temporary directory** and not run inside the plugin repository (`.omz/` lands in the working directory and would pollute the plugin package awaiting distribution, the hygiene precondition of §18); ④ when a collection-point judgement is involved, look at `render-status.mjs`'s output rather than only the `/omz-status` inline block — the two have a measured capability gap in injection sanitization (§13 B27).

---

## Appendix A: the complete frontmatter specification for the agents

The following 9 definitions are the direct source-file specification for implementation (the 10th role reuses the engine's built-in `Explore` and has no file). The format is aligned with the engine's empirically verified fields (§10.1 V2); descriptions follow the budget discipline (the first sentence = the trigger condition, ≤2 sentences); the body system prompts are given here as skeletons (expanded per the §7.5 protocols during implementation). v1.4 has updated the wording for atlas, librarian and the read-only roles per §17 rulings 1/2/3.

**The last round of v1.4: this appendix has been aligned field by field with the actual `agents/*.md` files.** The appendix calls itself "the direct source-file specification", so the moment it drifts from the files on disk, anyone copying it will recreate defects that have already been fixed (this round the hit was exactly `omz-looker`: the appendix still said `tools: [Read]` / `maxTurns: 10`, while the actual file had long been `[Read, Bash]` / `15`; §17 ruling 3, note ③ of §4 and item 8 of the v1.4 version history all record that change). The differences synchronized this round: ① looker's `tools`/`maxTurns`/the tool-surface discipline in its body; ② the four descriptions of planner/deep/junior/reviewer — the actual files added **negative trigger sentences** ("do not dispatch single-step single-file tasks" / "do not dispatch standard tasks with a clear scope, use junior" / "do not dispatch single-file typo-level edits" / "do not dispatch when the gate has not triggered"), which is the better version (a negative clause suppresses mis-dispatch directly at a cost of a few tokens), so the appendix is written back from the actual files.

```markdown
# agents/omz-planner.md
---
name: omz-planner
description: "当任务满足规划门槛(≥2 步骤/多文件/含架构决策)或用户要求工作计划/访谈时委派。访谈式规划顾问:产出分波次计划,自己绝不实现;单步骤单文件任务勿派。"
color: blue
tools: [Read, Bash, Write]
maxTurns: 30
thoughtLevel: high
---
你是 Prometheus(OMZ 版),规划顾问。移植自 OmO ulw-plan 协议(§7.5.1):
[意图路由 CLEAR/UNCLEAR → 两道过滤器 → owner-decision 必问 → 计划工件语法(零列 checkbox
-N./终验 F<n>./嵌套 category 注解) → 批准门等待 → 绝不执行]
```

```markdown
# agents/omz-critic.md
---
name: omz-critic
description: "当一份计划草稿成形、尚未批准执行时委派。计划差距分析师:找遗漏场景/隐含假设/依赖风险,只评审不修改。"
color: orange
tools: [Read, Bash]
maxTurns: 15
thoughtLevel: high
---
你是 Metis。逐节审查计划:决策完备性(执行者零判断点)、范围完整性、依赖矩阵一致性、
验收标准可证伪性。输出分级清单(blocker/major/minor+行号)。
```

```markdown
# agents/omz-deep.md
---
name: omz-deep
description: "当任务属于 deep 类(棘手调试/研究密集/微妙跨模块)且需要端到端自主实现时委派。给目标不给步骤的深度自主编码者;范围清晰的标准任务勿派,用 junior。"
color: green
# 全工具 = 完全不写 tools 这一行。切勿写成 `tools: []`——空数组是"空白名单"（拿不到任何工具），
# 与"省略字段=继承全工具"语义相反。B23 的教训正是解析器对 tools 的语义差异极敏感。
maxTurns: 80
thoughtLevel: high
---
你是 Hephaestus。收到的是目标而非配方:
[开工先做代码库探索(经 Bash grep/rg;你不能 spawn Explore) → failing-first 证明 → 实现 →
基线表征测试 → 自测双证据 → DoneClaim JSON 返回]
同一错误连续 3 次修复失败必须停下回报(B6)。未经派发单授权不得删除任何文件。
```

```markdown
# agents/omz-junior.md
---
name: omz-junior
description: "当任务可独立完成、范围清晰、属单 lane 执行类(标准特性/文档/UI 组件等)时委派。聚焦单任务执行器,禁止再委派;单文件 typo 级小改勿派,主 agent 自己干。"
color: green
# 全工具 = 省略 tools 行（不要写 `tools: []`，见 omz-deep 的说明）
maxTurns: 40
thoughtLevel: medium
---
你是 Sisyphus-Junior。铁律:你是叶子执行者——你的工具清单没有 Agent 工具,
结构上不可能委派,也不要求。收到 8 要素 prompt:按约束实现,返回 DoneClaim。
```

```markdown
# agents/omz-atlas.md
---
name: omz-atlas
description: "当需要按已批准计划逐波驱动执行(/ulw-execute 场景)时委派。波次状态机与派单建议生成器,沟通型汇报;自己不 spawn 不实现。"
color: green
maxTurns: 60
thoughtLevel: high
---
你是 Atlas,ulw-execute 的**波次状态机 + 派单建议生成器 + 汇报器**(§7.5.2、§17 裁决 1):
[计划选择(按 `## Wave <n>` 切波) → Boulder 更新 → 逐 checkbox LIGHT/HEAVY 分级 →
**产出 8 要素派单建议(不 spawn,交还主 agent)** → 收点判定(只认 results 文件;你收不到后台通知) →
五 gate 验证 → ledger append → checkbox 翻转]
ORCHESTRATOR-NEVER-IMPLEMENTER 铁律 + 10 条 Hard rules 全文照搬。
遇到需要实现的活:既不自己写也不 spawn,一律写成派单建议回请主 agent。
```

```markdown
# agents/omz-oracle.md
---
name: omz-oracle
description: "当遇到架构决策/疑难调试/需要第二意见的技术判断时委派。资深架构顾问:只分析给方案,不动任何代码。"
color: purple
tools: [Read, Bash]
maxTurns: 20
thoughtLevel: max
---
你是 Oracle。咨询模式:读代码(Bash grep/rg + Read)、给判断、给方案、给权衡,
输出固定格式(结论先行/论据带 file:line/反方视角)。绝不修改文件。
```

```markdown
# agents/omz-reviewer.md
---
name: omz-reviewer
description: "当评审门触发(措辞严格/≥3 文件/≥20 轮/≥30 分钟/重构迁移性能安全)或需 AdversarialVerify 裁决 DoneClaim 时委派。独立只读对抗评审,分级 blocker/major/minor;门未触发勿派。"
color: red
tools: [Read, Bash]
maxTurns: 25
thoughtLevel: high
---
你是 Momus,对抗性评审者。每条发现必须含 [级别] 文件:行号 问题 修复建议;
必须显式回答"未发现 X 类问题"(穷举式排查,空报告是结论不是敷衍);
confirmed 是唯一通过裁决(§7.5.2 Sisyphus 完成契约)。复审上限 2 次。
**只读性是分层的**(§17 裁决 3、§4 三层模型):你没有 Edit/Write(结构约束,v1.5 已实测确证),但 Bash 能写文件——
禁止用 `>` 重定向、`node -e fs.*`、`git checkout/apply` 等任何方式改动仓库(纪律约束)。
发现问题只报不改。
```

```markdown
# agents/omz-librarian.md
---
name: omz-librarian
description: "当需要查外部文档/API 用法/版本兼容/第三方库资料时委派。检索员:按 URL 抓全文,输出带来源引用的结论。"
color: cyan
tools: [Read, Bash, WebFetch]
maxTurns: 15
thoughtLevel: low
---
你是 Librarian。**本部署无 WebSearch**(§17 裁决 2):只能 ① WebFetch 抓已知 URL 全文,
② Bash grep/find/rg 做本地取证。重要结果抓全文——snippets lie;
CONTEXT 里没有任何 URL 且本地推不出入口时,明确回报"需要主 agent 提供检索入口"并停止,不得凭记忆编造。
输出每条结论带 [Source N] 引用与访问日期。
```

```markdown
# agents/omz-looker.md
---
name: omz-looker
description: "当需要视觉分析(截图/图表/渲染工件)或 visual-QA 门时委派。多模态检查员:只看图,输出逐图判定;须给全图片路径清单。"
color: yellow
tools: [Read, Bash]
maxTurns: 15
---
你是 Multimodal Looker。**输入契约**:派发方必须给逐图路径清单 + 每图预期;缺预期先回报缺口
(没有判据的 pass 是质量事故)。**工具面纪律**(§17 裁决 3):Read 看图需精确路径,
**Bash 仅用于枚举图片路径**(`ls`/`find -name '*.png'` 一类只读命令),**禁止任何写操作**——
禁 `>`/`>>` 重定向、禁 `mv/rm/cp`、禁任何格式转换或改名。**PDF 须由派发方先转为逐页图片,
你不做格式转换**(Read 对 PDF 的直读能力未验证,不得假设)。
逐图检查:资产正确性(宽高比/裁切/水印/分辨率)、图表与正文一致(数值有无标签单位)、
版面缺陷(文字溢出/空白页/重叠/截断/对比度)。输出每图一行判定(pass/fail:<缺陷+位置>+证据),
末尾给 total/pass/fail 汇总;打不开的图记 `unreadable`,不得记 pass。
```

**A note on reusing the built-in explore**: the engine's built-in Explore (a read-only search agent) *is* OmO's explore role and is not redefined. On the ZCode side, file search inside a subagent is done through Bash grep/find/rg (B20).

## Appendix B: the commands specification

| Command | Parameters | Key points of what it expands to |
|---|---|---|
| `/ulw <goal>` | `$ARGUMENTS` | The full text of the eight-step ultrawork constitution (§6) + **step zero, the session identifier, in front** (a ` ```! ` execution block fetches `OMZ_GOAL_STEM`, §13 B30) + the B21 exception wording + the 10 hard rules + the constitution checklist referencing goal.json |
| `/team <goal>` | `$ARGUMENTS` | Team Mode orchestration instructions (the seven-step protocol of §7.2 + the resume rules of §7.4 + the "files are authoritative" collection-point principle) |
| `/hyperplan` | none | Planning only: omz-planner interviews → omz-critic gap analysis → wait at the approval gate (no execution) |
| `/omz-status` | none | A ```` ```! ```` block runs a node script that renders `.omz/` (waves × tasks × status × elapsed, a 40-line cap, the overflow aggregated) |
| `/omz-doctor` | none | The self-check list: ① spawn-ping each agent (with the probe passphrase; offline it only does static validation, and a real spawn is only possible inside a session — **v1.5 has completed 9/9 in a real session, §10.1 V12**; the receipts contain the subagents' self-reported tool surfaces and self-reported visible skill lists); ② compare the frontmatter model against the registered provider models; ③ check that `.omz/` is in .gitignore; ④ agent file mtime vs the session start time (B19, prompting a restart); ⑤ BOM and path scanning (B4/B3/B26); ⑥ the configuration-tiering report (the precedence of §3.3); ⑦ availability of Node/SQLite/git/codegraph/coordinator/dashboard and the profile degradation report |

Command file frontmatter: `description` (a one-sentence trigger explanation) + a body that *is* the prompt template, with `$ARGUMENTS`/`$1..$N` expansion handled by the engine.

## Appendix C: the skills directory specification

| Skill | Carrier | Core content (matching the §7.5 protocols) |
|---|---|---|
| `ulw-plan` | skills/ulw-plan/SKILL.md | The Prometheus planning protocol: intent routing / the two filters / owner-decisions / the plan artifact syntax (checkboxes + `## Wave <n>`, §17 ruling 5) / the approval gate / dual artifacts (`.omz/drafts/` → `.omz/plans/<slug>.md`) / references/{intent-clear,intent-unclear,full-workflow}.md |
| `ulw-execute` | skills/ulw-execute/SKILL.md | The Atlas execution protocol: the Boulder schema / LIGHT-HEAVY / the 8-element **dispatch proposal** (no spawn, §17 ruling 1) / the 9 adversarial classes / collection points recognizing only results files / the Sisyphus contract JSON / the ledger.jsonl fields / the 10 hard rules |
| `ulw-research` | skills/ulw-research/SKILL.md | The saturation research protocol: the 5 epistemology document templates / the scaling-floor table / the EXPAND tail / the excursion rules / claim gating / the convergence rules / dual-format delivery + the two gates / references/worker-prompt.md; output lands in `.omz/research/<slug>/` |
| `review-work` | skills/review-work/SKILL.md | The 5-lane review protocol: the lane configuration / the Phase 0 context-collection list / worktree discipline / the INCONCLUSIVE rule / the report template / references/{lane-prompts,verdict-schema}.md |

SKILL.md frontmatter: `name` + `description` (the strict activation clauses copied verbatim from OmO's original trigger wording, to prevent false triggering). All four skills are **prompt-protocol text** — no script dependencies (the artifact semantics of scaffold-plan.mjs are implemented by the agent writing from a template, §7.5.1); what is actually on disk additionally includes 11 `references/` documents.

## Appendix D: the M1 installation checklist

1. `.zcode-plugin/plugin.json`: declares `agents`/`commands`/`skills`/`hooks`/`mcpServers`; path variables may only be `${ZCODE_PLUGIN_ROOT}`/`${ZCODE_PROJECT_DIR}` (**`${pluginDir}` is not an engine variable**, §10.3 item 1); the coordinator MCP defaults to `enabled:false`; the keyword hook is off by default through `omz.keyword_hook: false` — **note that the top-level `enabled` in hooks.json is not read**, so switching it off at the engine level requires the element-level `enabled: false` (the three switch layers of §8.2).
2. The 9 agent files land per appendix A (the 10th role reuses the built-in `Explore`); `node tools/validate-frontmatter.mjs` passes (YAML with dash-array support B23, tool-name classification validation B24).
3. **Restart the session** (B19: the agent list is a session-start snapshot).
4. `/omz-doctor` reports no FAIL (including spawn ping 9/9, model validation, gitignore, mtime, BOM/path scanning, configuration tiering, and the profile degradation report). **Note**: run offline, the spawn ping only does static validation, and a real spawn requires being inside a session. **v1.5 has completed the real-session acceptance of this step**: 9/9 all returned `OMZ-PONG` (§10.1 V12); please also check the self-reported tool surfaces and self-reported visible skill lists in the receipts — the former verifies the whitelist (B1) and the engine-injected surface (the third layer of §4), the latter verifies that the four OMZ skills are present (B16).
5. **If the plugin is installed under a path with spaces or non-ASCII characters** (`C:\Program Files\…`, a Chinese directory), first confirm by hand that every CLI entry point produces non-empty output — B22's failure form is **silent no output with exit code 0**, and the doctor itself cannot detect it.
6. The three installed-environment measurements V3/V4/V8′ (§10.2), with the conclusions written back into this document; V10/V11 are scheduled per their own clauses (V8's enum and V9's concurrency load test were closed in the last round of v1.4, and **V12 was closed in v1.5**; all are in §10.1).
7. Smoke test: `/ulw <a small feature spanning 2 files>` (the M1 verification criterion, §9). **The target project must be built in the system temporary directory, not inside the plugin repository** — `/ulw` creates `.omz/` in the working directory, and running it inside the plugin repository would mix runtime state into the plugin package awaiting distribution. The complete reproducible chain (building the target, the four critic blockers, the failing-first criteria, the two reviewer rounds, the seven final-state criteria) is in **§18**.

---

## 15. Impact on the default chat mode, and the isolation strategy

### 15.1 The conclusion

**It does not change ZCode's default chat mode.** After installing OMZ the user can still chat directly, ask questions, read files or do ordinary single-round tasks exactly as before; nothing gets rewritten into `/ulw` or `/team` automatically, and the mere existence of several `agents/*.md` does not force a team to start.

OMZ's default behavior is **core + explicit triggering**:

- The `core` profile is on by default: the definitions of agents, commands and skills can be discovered by ZCode, but `/ulw`, `/team` and `/hyperplan` are activated only when the user types them explicitly.
- `graph`, `orchestration` and `dashboard` are off by default and must be enabled explicitly; they never connect, index, create tasks or open a local port during ordinary chat.
- The M2 `UserPromptSubmit` keyword hook is off by default. Even when enabled it recognizes only unambiguous mode words and dedupes per session; it must not fire falsely on ordinary text containing code variables, quotations, or a discussion of "ulw/team".
- Subagent descriptions do enter ZCode's agent-discovery context, bringing a small fixed token cost (9 of them); but **nothing executes automatically**. The main agent only delegates when a task matches a description and the explicit trigger/orchestration conditions are met.
- A `quick` single-file edit, ordinary Q&A, explaining code, translation and small talk create no team, connect no CodeGraph, and write no `.omz/` state.

### 15.2 The impact matrix

| Scenario | Does OMZ orchestration start? | Does the answering style change? | Extra cost |
|---|---:|---|---:|
| Ordinary chat/Q&A | No | No | The small context token cost of the agent descriptions |
| Ordinary code reading/explanation | No | No | A small context token cost; no subagent starts |
| A single-file quick edit | No (the main agent handles it directly) | No | No subagent cost |
| An explicit `/ulw <goal>` | Yes | Yes, it runs the ultrawork lifecycle | The mode prompt + planning/verification subagents |
| An explicit `/team <goal>` | Yes | Yes, multi-worker scheduling is enabled | Parallel workers + the coordinator (if enabled) |
| `team`/`ulw` appearing in ordinary text | No | No | None when the hook is off; with the hook on, a fixed 126–132ms process overhead per message (the matcher does not filter, §8.2) | 
| Explicitly enabling the graph profile | Only invoked for relevant code tasks | Only code-relationship exploration is enhanced | CodeGraph MCP/index resources |

### 15.3 Isolation guarantees

1. **Trigger isolation**: commands use explicit invocation; the hook is off by default (the real gate is `omz.keyword_hook`, **not the top-level `enabled` of hooks.json** — that one is not read, §8.2); commands and the hook have mutual exclusion and session-level dedupe (B5). **Residual cost**: as long as the hook entry remains in the event table, one node process starts per message even without injection (126–132ms, because `matcher` does not filter on this event); isolating even that requires the element-level `enabled: false`.
2. **Resource isolation**: without `/team` no coordinator team is created; without a need for code relationships CodeGraph is not called; without a dashboard request no BrowserWindow/SSE starts.
3. **State isolation**: ordinary chat writes no `.omz/goal`, `.omz/runtime` or `coordinator.sqlite`; the state directory is created only after the corresponding workflow/profile is activated.
4. **Permission isolation**: ordinary chat continues to use the user's current ZCode permissions; the read-only reviewer's `tools` whitelist does not affect the main agent (that whitelist is itself the three layers "structure + discipline + the engine-injected surface", §4, §17 ruling 3); the coordinator/dashboard cannot widen the main agent's permissions.
5. **Failure isolation**: a connection failure in an optional profile only makes that enhancement unavailable and falls back to core; ordinary chat must not fail because of CodeGraph, SQLite, the dashboard or a hook.
6. **Uninstall isolation**: after deleting/disabling OMZ, ZCode's ordinary chat and the user's existing agents, skills and MCP configuration are unmodified; `.omz/` is the project's own state, and before uninstalling `/omz-doctor` offers to keep or clean it.

### 15.4 Possible negative impacts and their controls

- **A longer context**: the 9 agent descriptions and the OMZ skill metadata add a little fixed context. Control: each description ≤2 sentences with a total of about 400 tokens; the full protocols load only after explicit activation.
- **Mis-delegation**: the main agent may hand an ordinary task to a subagent. Control: descriptions carry strict trigger conditions; spawning is explicitly forbidden for `quick`/ordinary chat; /omz-doctor records abnormal delegations.
- **The user perceives it as slower**: an explicit `/ulw` explores, plans and reviews first, which is the intended behavior; ordinary chat goes through none of those phases.
- **Background resource usage**: SQLite, a sidecar or a port exist only after orchestration/dashboard are enabled; on leaving the workflow, workers, the server and the dashboard are closed and a cleanup receipt is written.
- **A change in output style**: /ulw and /team return status, evidence and phase information; ordinary chat keeps ZCode's original answering style and injects no ULTRAWORK marker.

### 15.5 The default configuration

```jsonc
{
  "omz": {
    "profile": "core",
    "keyword_hook": false,
    "graph": { "enabled": false },
    "orchestration": { "enabled": false },
    "dashboard": { "enabled": false },
    "auto_team": false,
    "auto_ulw": false
  }
}
```

This set is OMZ's product default and can be overridden by the `omz` key of `.zcode/config.json` (shared with the team) or by `.omz/config.json` (machine-private, the highest precedence) — the layering and its side effects are in §3.3 and §17 ruling 12. If the user later switches a profile on, it affects only code tasks for that profile; "OMZ is installed" must not be interpreted as "every chat enters multi-agent mode".

**`keyword_hook: false` is M2's semantic-layer real gate (made explicit in the last round of v1.4, §8.2)**: the top-level `enabled` of `hooks/hooks.json` is not read by the plugin load chain, so switching M2 off relies on this key (the script self-checks and prints a bare `{}`). Note that it only avoids **injection**, not **process startup** — `matcher` plays no part in filtering on `UserPromptSubmit`, so as long as the hook entry is still in the event table, every user message still starts one node process (measured 126–132ms). To save that cost too, add `"enabled": false` at the **element level** of the hooks array (the runtime-layer real gate) or remove the entry outright.

---

## 16. Repository strategy and upstream sync

### 16.1 The conclusion: create a new OMZ repository and sync OmO selectively

**Do not fork the whole `oh-my-openagent` and turn it into a ZCode version, and do not rewrite every capability from scratch either.** A hybrid approach is used:

- **Create an independent OMZ repository**: the actual running code is organized in ZCode's native plugin format; the OpenCode/Codex runtime is not brought into the product mainline.
- **Port OmO's protocols selectively**: the Markdown protocols — ultrawork, ulw-plan, ulw-execute, ulw-research, review-work, DoneClaim/AdversarialVerify, the 9 adversarial classes, the plan checkboxes, EXPAND/claim graph and so on — are referenced from or synced with OmO.
- **Implement the ZCode adapter layer independently**: Agent scheduling, MCP, the SQLite coordinator, and the Windows/Electron dashboard are maintained by us, without directly copying OpenCode's `AgentConfig`, `task(category=...)`, `team_*`, `primary`, Codex `multi_agent_v1` or the tmux runtime.
- **CodeGraph as an independent dependency**: connect the upstream `@colbymchenry/codegraph` MCP directly rather than forking OmO's `@sisyphuslabs/codex-codegraph` bridge.

The reasoning: OmO's host runtime is tightly bound to OpenCode/Codex, so forking the whole repository would import a great deal of incompatible API, create upstream merge conflicts, retain unrunnable features and widen the license boundary; while a complete rewrite would lose already-verified orchestration protocols. The hybrid approach separates "protocol reuse" from "host implementation", so later updates only need to handle the changes that are worth something.

### 16.2 The recommended directory layout

```text
omz/
├── .zcode-plugin/plugin.json
├── agents/                 # 9 ZCode agents/*.md (the 10th role reuses the built-in Explore)
├── commands/               # ulw/team/hyperplan/status/doctor
├── skills/                 # 4 core SKILL.md + 11 references
├── hooks/                  # hooks.json + keyword-detect.mjs (off by default)
├── mcp/
│   └── coordinator/        # OMZ's own SQLite/MCP scheduling layer (13 tools)
├── dashboard/              # the optional Electron/SSE presentation layer (server + main + renderer)
├── adapters/zcode/         # ZCode transport/capability/fallback/path
├── upstream/
│   ├── omo-sources.lock.json
│   └── README.md
├── tools/
│   ├── sync-omo-skills.mjs
│   ├── validate-frontmatter.mjs
│   ├── render-status.mjs
│   ├── doctor.mjs
│   └── lib/is-main.mjs     # the shared CLI entry-point detection (B22)
├── tests/                  # protocol/coordinator/fallback/integration/cli/hooks/path/dashboard/…
├── LICENSE
└── README.md
```

`upstream/` records only the source version, file paths, commit SHAs, licenses and porting status; `adapters/zcode/` isolates host differences; `tools/` and `tests/` are the operations and regression base (v1.5: 102 suites / 573 tests); OMZ's actual running code all lives in its own `agents/`, `commands/`, `skills/`, `hooks/`, `mcp/` and `dashboard/`.

### 16.3 Git branch and sync discipline

Keep the OmO upstream remote, but **never merge an upstream branch straight into the OMZ mainline**:

```bash
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git
git fetch upstream

git diff upstream-sync..upstream/dev -- \
  packages/shared-skills/skills/ulw-plan \
  packages/shared-skills/skills/ulw-execute \
  packages/shared-skills/skills/ulw-research \
  packages/shared-skills/skills/review-work \
  packages/prompts-core/prompts/ultrawork
```

Suggested branches: `main` (runnable OMZ code), `upstream-sync` (OmO snapshots/comparison records), `porting/<date-or-version>` (one round of protocol porting). The sync process:

1. `git fetch upstream`, comparing only the locked protocol paths.
2. Judge whether a change is pure prompt protocol or OpenCode/Codex host API.
3. Pure protocol changes are ported into the corresponding ZCode SKILL/command; host changes are registered as "not applicable" or rewritten into an adapter.
4. Update `upstream/omo-sources.lock.json`, the changelog and the license record.
5. Run the protocol, fallback and Windows/MCP regressions; only merge into the OMZ mainline once they pass.

Executing `git merge upstream/dev` directly is forbidden. An OmO version upgrade never enters production code automatically; it must pass through this filtering path.

### 16.4 The source lock file

```json
{
  "source": "code-yeongyu/oh-my-openagent",
  "branch": "dev",
  "commit": "<a fixed commit SHA>",
  "synced_at": "<ISO-8601>",
  "ported_paths": [
    "packages/shared-skills/skills/ulw-plan/SKILL.md",
    "packages/shared-skills/skills/ulw-execute/SKILL.md",
    "packages/shared-skills/skills/ulw-research/SKILL.md",
    "packages/shared-skills/skills/review-work/SKILL.md"
  ],
  "ignored_paths": [
    "packages/omo-opencode",
    "packages/omo-codex",
    "packages/team-core",
    "packages/tmux-core",
    "packages/model-core"
  ]
}
```

Every sync must preserve the original SHA, so that "the current latest" never substitutes for a reproducible source; third-party licenses and the NOTICE are recorded along with it.

| Conclusion | Source | Grade / how it is used |
|---|---|---|
| ZCode supports stdio/HTTP/SSE MCP; user level `~/.zcode/cli/config.json`, workspace `.zcode/config.json`; connects automatically at session start | [ZCode MCP services documentation](https://zcode.z.ai/cn/docs/mcp-services) | An official public contract |
| Subagents have isolated contexts, run in the foreground or background, return results to the main conversation, and cannot spawn further; the public documentation has no Team/mailbox/resume API | [ZCode subagents documentation](https://zcode.z.ai/cn/docs/subagents) | An official public contract; capabilities not written down are not treated as a stable API |
| Goals: one goal per session, can be paused/resumed/cleared, state persists; idle-time tasks are a global FIFO, persistent, with no automatic retry on failure | [ZCode Goals](https://zcode.z.ai/cn/docs/goal), [idle-time tasks](https://zcode.z.ai/cn/docs/idle-time-tasks) | An official public contract; idle-time tasks are not passed off as a DAG |
| Plugins can declare agents/commands/skills/hooks/mcpServers; channels/lspServers/settings are not executed | [The official ZCode plugin repository](https://github.com/zai-org/zcode-plugins), this machine's document-skills manifest | Official source/a physical sample on this machine |
| `codegraph_explore` upstream, Windows, MIT, MCP, initialization/installation | [The CodeGraph README](https://github.com/colbymchenry/codegraph), [MCP tools](https://github.com/colbymchenry/codegraph/blob/main/src/mcp/tools.ts), [the OmO codegraph bridge](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/codegraph) | Upstream source/README; M1-G must pin the version and run the acceptance |
| vardiya's SQLite WAL/atomic claim/heartbeat/retry/DLQ/priority/delay/cron/Node >=22 | [vardiya](https://github.com/Zulwatha/vardiya) | A candidate upstream; full Windows support and the native ABI still need acceptance, so it is not locked in by default |
| SQLite RETURNING, transactions, WAL and busy_timeout semantics | [RETURNING](https://www.sqlite.org/lang_returning.html), [Transactions](https://www.sqlite.org/lang_transaction.html), [WAL](https://www.sqlite.org/wal.html), [busy_timeout](https://www.sqlite.org/pragma.html#pragma_busy_timeout) | Official database semantics; the coordinator implementation must obey them |
| The Electron main/renderer/preload/utilityProcess boundaries; **a sandboxed preload cannot use ESM import** | [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox) | Official architecture documentation. The second half is the direct basis for withdrawing the preload promise in §13.5 I5 (`sandbox: true` and an `.mjs` preload are mutually exclusive), and the OMZ implementation ends up **containing no preload** |
| One-way SSE event streams and automatic reconnection | [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) | Web platform documentation; commands go through fetch/IPC separately |
| Windows Terminal `wt split-pane` | [Windows Terminal command-line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments) | Official documentation; only a debugging bypass |

**Handling conflicting evidence**: the ZCode hooks web page's description of `async: true` conflicts with the diagnosing-hooks guide shipped on this machine ("async currently has no runtime effect, hooks are inline"). v1.2 adopts the more conservative installed runtime guide: designed for synchronous execution; async-related optimizations are only enabled after the V3 probe passes.

---

## 17. Architectural rulings made during implementation (new in v1.4)

The twelve rulings below are **judgements that had to be made while implementing**: things the design document did not say, said wrongly, or said in contradiction with a known fact (especially V5, "subagents cannot spawn", and the reality of the tool surface). Each gives "the design-era statement → the fact → the ruling → the affected surface". This section is the difference list between v1.3 and the implementation, and any later change to the design must read it first.

### Ruling 1: subagents cannot spawn, so every protocol where "a spawned role dispatches further" is rewritten as "produce a dispatch proposal + hand back to the main agent"

- **The design-era statement**: §7.5.1 said "Prometheus spawns the read-only subagents explore/librarian/metis/momus", and §7.5.2 said "Atlas dispatches the 8 elements".
- **The fact**: V5 confirmed as early as the design era that subagents have no Agent tool (§10.1), but the wording in the porting comparison table was never updated.
- **The implementation consequence**: taken literally, `omz-atlas` is **wholly unexecutable** — it is forbidden to implement by ORCHESTRATOR-NEVER-IMPLEMENTER and cannot delegate for lack of an Agent tool, so **the moment it is spawned it necessarily violates something** (either it oversteps and implements, or it spins idle).
- **The ruling**: rewrite it as "wave state machine + dispatch-proposal generator + reporter" — it manages the ledger, the LIGHT/HEAVY grading, the five gates and the ledger file, and produces directly pasteable 8-element prompts **handed back to the main agent** to spawn. Prometheus's "spawning" likewise becomes handing back to the main agent.
- **The affected surface**: the §4 role table and its notes, §7.5.1, §7.5.2 (including a new precondition paragraph), the omz-atlas skeleton in appendix A, and the body of `agents/omz-atlas.md`.

### Ruling 2: `WebSearch` is unavailable in this deployment

- **The design-era statement**: the §4 role table and appendix A gave omz-librarian `[Read, Bash, WebFetch, WebSearch]`.
- **The fact**: the engine has the name `WebSearch` and classifies it under `isReadOnlyTool` (§10.3 item 5), but the actual tool surface of the current deployment (including the main agent) does not have it, and neither does the measured subagent list.
- **The ruling**: delete `WebSearch`; librarian's retrieval becomes ① WebFetch fetching the full text of known URLs, ② Bash gathering local evidence, and ③ **when there is no entry point, explicitly asking the main agent for one and stopping** (no fabricating from memory).
- **The more general lesson**: **"a tool name exists in the engine" does not equal "it is available in the current deployment"**. This has been promoted to a general rule: it goes into §13 B24, and a verification clause is added in §10.2 (a capability obtained from engine evidence must be re-confirmed as delivered by the deployment).
- **The affected surface**: the §4 role table, appendix A, the note in §13 B20, the new §13 B24, `agents/omz-librarian.md`, and `tools/validate-frontmatter.mjs`.

### Ruling 3: the "structural guarantee" of the read-only roles is limited

- **The design-era statement**: §4 said "this is not a prompt convention but a structural guarantee (the reviewer physically cannot change code)"; §13 B11 said "① the tool whitelist is read-only (structurally preventing a helpful edit)".
- **The fact**: the engine itself classifies `Bash` as `isWriteTool` **and** `isDestructiveTool` (§10.3 item 5). A role with `tools: [Read, Bash]` can write files with `>` redirection, `node -e fs.writeFileSync` or `git checkout`.
- **The ruling**: both sentences are **over-promises** and are replaced by a layered model — **Edit/Write is a structural constraint, and Bash being read-only is a disciplinary constraint**. B11's defences change from "four" to "**three structural + one disciplinary**". Note: before v1.4 `omz-looker`'s `[Read]` was the one completely structurally read-only role, but during implementation it turned out to be unusable because it could not obtain the paths of the images to inspect (Read needs exact paths, and without Bash it cannot enumerate), so `Bash` was added; at that point all 5 quality roles fall under the layered model with no exception. **v1.5's installed-environment measurements add a third layer**: the tool surface = the frontmatter whitelist ∪ **the engine-injected tools** (`RespondToCoordinator` demonstrated, held by all 9 subagents and not bound by the whitelist, §10.3 item 11) — the whitelist is the upper bound on "what can be declared" and not the entirety of the tool surface, and this layer has no control point on the OMZ side. The full statement of the three-layer model is in §4.
- **A path to tightening: there is none (changed to a terminal conclusion in the last round of v1.4)**. v1.4's original text treated `permissionMode` as "the only means of turning Bash into a structural constraint too", which was **an expectation destined to fall through**. The engine enum has been extracted directly (§10.1 V8): `["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`, with the subagent mapping (`Fsi`) `bypassPermissions`/`dontAsk` → yolo, `acceptEdits` → edit, `auto` → auto, `plan` → plan, `default`/unwritten → inherit. **No value in the enum can remove an individual tool** — it tunes "how strict approval actions are", not the tool whitelist; and the closest, `plan`, is a **global mode** (nothing in the whole subsession lands on disk), which can neither switch off Bash alone nor avoid destroying the necessary read-only Bash usages such as looker enumerating paths and librarian gathering local evidence. Therefore: **the layered model (Edit/Write structural + Bash disciplinary + an uncontrollable engine-injected surface) is terminal, not transitional**. Genuinely turning Bash into a structural constraint would require the engine to provide per-tool denial (for instance `permissionDecision: deny` on the PreToolUse side with per-agent matching conditions) — an engine-side feature request outside this project's control. The only thing left pending in V8 is "the permission dialog behavior during parallel spawn" (→ §10.2 V8′, §13 B2), which has nothing to do with read-only-ness.
- **The effect of v1.5's installed-environment measurements on this ruling (the structural layer rises from inference to measurement; the conclusion is unchanged)**: the measured tool surfaces of the five restricted roles **really do lack Edit** and the three full-tool roles **really do have Edit** (§10.1 V12), so "the structural half is real" now has behavior-level evidence; §14 accordingly raises the "read-only structural guarantee" sub-item from 70% to 80%. **But the ruling itself does not change** — Bash is still the disciplinary layer, and the newly discovered engine-injected surface means the assumption "the tool surface is fully controllable" does not hold either.
- **The affected surface**: the §4 design points (expanded to three layers in v1.5), §13 B1 (behavior-level confirmation of the whitelist), §13 B11, the §14 confidence (that sub-item was lowered to 70% in v1.4 and **raised to 80% in v1.5**), the bodies of `agents/omz-reviewer.md` and the other read-only roles (already changed to the honest statement), §10.1 V8 (the enum extracted) and V12 (behavior-level measurement), §10.2 V8′ (only the dialog behavior left), and §10.3 item 11 (the engine-injected surface).

### Ruling 4: the Stop hook is not implemented

- **The design-era statement**: both §13 B17 and the §6 wrap-up said "the Stop hook persists boulder.json / checks the completeness of the constitution checklist".
- **The fact**: `hooks/hooks.json` only registers `UserPromptSubmit`.
- **The ruling**: change it to "**the main agent actively writes `.omz/boulder.json` after each wave collection point**", and mark the Stop hook explicitly as an **unimplemented M4 item**. Known gap: abnormal termination loses whatever progress followed the last collection point and will not automatically block a "complete" conclusion.
- **The affected surface**: the new wrap-up persistence paragraph in §6, §13 B17, the M4 row of §9, and the Boulder row of §7.5.2.

### Ruling 5: the wave syntax is unified as `## Wave <n>`

- **The design-era statement**: the plan artifact syntax table of §7.5.1 specified only the zero-column checkboxes and the `Recommended task executor category:` annotation, and **never fixed the wave delimiter**.
- **The implementation consequence**: both `Wave <n>:` and `## Wave <n>` appeared, and the wave delimiter is, like the checkboxes, **a machine contract between ulw-plan and ulw-execute** (Atlas splits waves by it, `/omz-status` groups by it), so two forms mean a broken contract.
- **The ruling**: unify on `## Wave <n>` (a Markdown level-2 heading). The §7.5.1 syntax table has that row added.
- **The affected surface**: §7.5.1, §3.5 (the note on the plans row), step 5 of §6, `skills/ulw-plan/*`, `agents/omz-atlas.md`, and `tools/render-status.mjs`.

### Ruling 6: the coordinator's task state is 7 states, and §7.3's 4 states are a mirror projection

- **The design-era statement**: the JSON of §7.3 listed only `pending | running | done | failed`.
- **The fact**: scheduling needs `blocked`/`ready` (to distinguish "dependencies not met" from "can be dealt out") and `dead` (the dead-letter), and §13.5 I3 additionally requires `unknown`.
- **The ruling**: **SQLite's 7 states are the source of truth**, and `exportMirror()` projects them to 4 states **while additionally preserving the raw `coordinator_state`**. Without the raw state, the audit mirror loses the distinction between dead-letter (never dealt out again) and unknown (reclaimable and re-dispatchable) — and the operational action for those two is completely different.
- **The affected surface**: the whole of §7.3 rewritten (including the projection comparison table), and the `omz_status`/`omz_export_mirror` rows of §7.2.

### Ruling 7: the mirror's identifier scheme uses numeric task ids

- **The design-era statement**: `depends_on` in §7.3 used task keys (`["T-001"]`).
- **The fact**: the unique constraint is `UNIQUE(graph_id, key)` — a key is unique only within a graph. When the same key is reused across graphs within one team, the mirror chains tasks from different graphs into one dependency chain.
- **The ruling**: `id` (numeric, globally unique) expresses machine relationships, `key` remains the in-graph business identifier, `graph_id` is carried explicitly, `depends_on` is an array of numbers, and `depends_on_keys` is added for humans.
- **The affected surface**: the JSON example of §7.3, and `exportMirror` in `mcp/coordinator/core.mjs`.

### Ruling 8: `attempts` is incremented at claim time

- **The design-era statement**: the claim SQL of §7.2 had `attempts = attempts + 1` but **never defined the counting-point semantics**.
- **The ruling**: the counting point *is* the claim, so **`max_attempts = N` means N executions in total** (not "N retries" = N+1). The two readings differ by one real execution, so it must be written down.
- **The affected surface**: the §7.2 tool table and the SQL comments, and the description of the `attempts` field in §7.3.

### Ruling 9: three new coordinator tools (13 in total)

- **The design-era statement**: the §7.2 tool table had 11.
- **The ruling**: add `omz_reclaim_expired` and `omz_export_mirror` (together with the terminal-state guard/one-time consumption rework they depend on, see I7), for 13 in total.
  - `omz_reclaim_expired` is **required**, not an enhancement: the original §7.2 table had no entry point for lease reclamation, yet both I3 and I4 require "an expired lease may only be re-dispatched" — **with no entry point an expired task is stuck in `running` forever** and the whole DAG deadlocks.
  - `omz_export_mirror` is the landing point for rulings 6/7 (projecting the 7-state source of truth into the 4-state + raw-state mirror).
- **The affected surface**: the §7.2 tool table, §13.5 I3, and `mcp/coordinator/server.mjs`.

### Ruling 10: the §7.2 claim SQL example lacks the `retry_at` filter, and the timestamp must be parameterized and must not be exposed

- **The design-era statement**: the example's `WHERE` had only `status='ready' AND deps_remaining=0`, and `lease_until` used the DB-side `unixepoch()`.
- **The facts and consequences**: ① lacking `(retry_at IS NULL OR retry_at <= :now)` makes failed tasks inside their backoff window be re-dispatched immediately, so **backoff is a dead letter**; ② taking the time on the DB side prevents injecting a fixed clock and conflicts with testability.
- **The ruling**: add the `retry_at` filter + parameterize the timestamp. **And**: `now` **must never appear in the inputSchema of an outward-facing MCP tool** — during implementation this turned out to be an attack surface any worker could exploit: `omz_reclaim_expired({now: <a future timestamp>})` can judge someone else's **unexpired** lease to be expired and steal it, which amounts to handing the scheduler's clock to the caller. Time is taken only by the server process itself, and `now` is only an internal function parameter.
- **The affected surface**: the SQL example of §7.2 and the clauses after it, and §13.5 I3.

### Ruling 11: the `.omz/` runtime directory tree is completed

- **The design-era statement**: §3.5 was missing three paths that are actually used.
- **The ruling**: add `drafts/<slug>.md` (the draft/approval-gate record of ulw-plan's dual artifacts), `research/<slug>/` (ulw-research output) and `ulw-execute/ledger.jsonl` (the execution ledger); and register `config.json` and the hook's `.mode-injected-<sessionId>` marker while we are there.
- **The affected surface**: the §3.5 directory tree.

### Ruling 12: configuration precedence `.omz/config.json` > `.zcode/config.json` > the built-in defaults

- **The design-era statement**: §3.3 only said "the MCP connection configuration goes in the workspace `.zcode/config.json` or the plugin manifest" and **never specified the precedence between the two configs**.
- **The ruling**: `built-in defaults → the omz key of .zcode/config.json → .omz/config.json` (the whole file *is* the omz configuration) override layer by layer, with **the last the highest**.
- **The side effect that must be written down**: `.omz/` is gitignored (§13 B14), so `.omz/config.json` is a **machine-private override**; **if profile switches are to be shared with the team, they must be written in `.zcode/config.json`**. The doctor reports hits/skips layer by layer, avoiding "I changed the config and nothing happened".
- **The affected surface**: the new configuration-precedence paragraph in §3.3, §3.5 (the config.json row), and the notes on the default configuration in §15.5.

---

## 18. The post-installation smoke acceptance chain (new in v1.5, a reproducible record)

This is the acceptance record of **the first time OMZ ran a complete lifecycle in a real environment**. It is written as **a reproducible chain** rather than a narrative: every section gives "what was done / what the criterion was / the measured result", so that later readers can run it again and compare.

**Preconditions**: the plugin is installed into ZCode (`plugins.dirs` points at this directory and `omz@inline` is enabled), and **the session has been restarted** (B19: the agent list is a session-start snapshot, and without a restart all 9 agents come back not found). The three acceptance items run `/omz-doctor`, `/omz-status` and `/ulw` in that order.

**The hygiene precondition (set the rule before touching anything)**: **the smoke test must build its target project in the system temporary directory and must not run inside the plugin repository**. The measured final state confirms: `<plugin repo root>/.omz/` **does not exist**, so the plugin repository has zero pollution. This is not fastidiousness — `/ulw` creates `.omz/` in the **working directory** (goal/plans/evidence/boulder.json), and running it inside the plugin repository would mix runtime state into the plugin package awaiting distribution.

### 18.1 The target project (a reproducible minimal real engineering project)

Do not use hello-world: the review gate and dual evidence need a real failure surface. What was built this time:

- A real **Node ESM** project (`package.json` with `"type": "module"`, `npm test` running `node --test`)
- `src/config.mjs`: `loadConfig` reads environment variables and validates strictly
- `src/server.mjs`: a consumer such as `describeTarget` that **calls `loadConfig` unconditionally** (this detail later became the root of an attribution error)
- One **baseline test** (a green starting point that passes, used later for a reverse-mutation comparison)

**The goal**: add `APP_TIMEOUT_MS` to `loadConfig` (with a default value, type validation, and throwing on an illegal value). This is "a small feature spanning 2 files", exactly matching the M1 verification criterion of §9.

### 18.2 The planning phase: planner → critic → the main agent's ruling → rev2

After `omz-planner` produced a draft it went to `omz-critic`. **critic reported 4 blockers** (all four are of the "copy the plan and it silently falls through" type and are worth recording one by one):

1. **`.omz/evidence/` does not exist, and `tee` does not create parent directories** → the transcript **silently falls through** (the command exits 0, the file is not written, and dual evidence becomes an unsupported claim).
2. **Two tasks in the same wave write the same test file in parallel** → they overwrite each other (the wave partition was not aligned with the file write surface).
3. **F1's `# pass ≥ 6` criterion is not self-consistent with its own task granularity** → the criterion references a number of tests this wave will not produce.
4. **`# fail 0` is TAP-format output, while Node 22 defaults to the spec reporter under a TTY** → **the criterion falls through entirely** (grep finds no such line; it is not "nothing failed" but "that line does not exist at all").

After the main agent ruled on **two of them that were owner-decisions**, it **sent the plan back for re-planning** → **rev2**: waves **5 → 9**, final-verification items **5 → 7**.

**Reproducible takeaways**: any criterion involving test output format must first fix the reporter (`--test-reporter=tap`) or switch to a reporter-independent criterion; anything that writes a file must `mkdir -p` the parent directory first. Those two classes are the most common sources of silent failure in "plan-layer criteria".

### 18.3 The execution phase: two junior rounds, and failing-first really went red

Two rounds of `omz-junior`. **failing-first is not a formality** — real red output was measured:

- **On the config side**: `# fail 4` (including `undefined !== 250` and `Missing expected exception`)
- **On the server side**: `# fail 2` (including `actual: '127.0.0.1:8080'`)

**Criterion design**: first produce the expected number of failures and persist the transcript, then implement to all green. The **specific assertion text** of the red output (not just the fail count) is the core of this step's evidence — with only numbers, any unrelated failure could masquerade as failing-first.

### 18.4 The review gate: reviewer's first round `needs-fix` → re-review `confirmed`

`omz-reviewer` **returned `needs-fix` in the first round**, with three findings:

1. **F7's `sc-map.md` does not exist** (a final-verification item referenced an artifact that was never produced)
2. **The plan record still said `status: draft` and "current position Wave 0"** (the state file did not advance with execution, conflicting with §7.3's "files are authoritative" collection-point principle)
3. **The totality breakage of `describeTarget` had no coverage and no record** (a behavior change with neither a test nor an entry in the record)

After the fixes, the re-review returned **`confirmed`**.

**This round produced three methodology-level findings whose value exceeds that of the feature itself**:

- **The in-memory replay evidence method (cleaner than "change the file and change it back")**: when independently re-checking failing-first, the reviewer took the baseline source with `git show HEAD:src/*.mjs` and **loaded it via a base64 data URL dynamic import**, completing the comparison **with zero changes to the working tree**. Compared with "change the file, run it, then change it back", it produces no intermediate state, does not depend on "remembering to change it back", and does not pollute the criteria with `git status`. **Recommended as a standard technique on the review side.**
- **The reviewer corrected an attribution error by the main agent**: for the totality breakage of `describeTarget`, the main agent attributed it to D1=a (a change in output shape); the reviewer used a **reverse mutation** to prove the root cause was **strict validation in the config layer propagating upwards + `describeTarget` calling `loadConfig` unconditionally** (which was already the case in the baseline) — the method was to run the combination of **the baseline `server.mjs` + the current `config.mjs`**, where S3 **stayed green**, thereby ruling out the output-shape path. This is a positive sample of the value of independent review (the counter-evidence to B11: the review gate really did catch the main agent's error).
- **Catching an evidence defect that is formally indistinguishable from a forged transcript**: one command was written as `{APP_TIMEOUT_MS:''abc''}` (**a doubled single quote**), which raises a `SyntaxError` when copied verbatim, yet the transcript's next line carried **successful output**. That combination is formally identical to forged evidence — the command cannot run yet there is output. **It was empirically confirmed that after fixing the quoting the output is identical verbatim**, i.e. **the content was real and the command string was broken**; per discipline the **whole block was re-run** and a new transcript kept. **The criterion is upgraded**: dual evidence's requirement of "reproducible" includes **the command string itself being executable verbatim**, not just the output looking right.

### 18.5 The final-state criteria (check these seven and the acceptance is reproduced)

| Criterion | Measured result |
|---|---|
| `npm test` | **8/8/0** (8 passed / 8 total / 0 failed) |
| The four SCs (success criteria) | **all done** |
| `.omz/boulder.json` | `status: done` |
| The `.omz/` hygiene scan | **zero BOM, zero backslash paths, zero corrupted JSON** (B4/B3/B26) |
| `git status` | **exactly 4 changes** (matching the plan's write surface, with no unexpected files) |
| `package.json` | **zero diff** (no dependency quietly added and no script changed) |
| Plugin repository pollution | `<plugin repo root>/.omz/` **does not exist** |

### 18.6 What this smoke test confirmed and exposed

- **Confirmed**: the review gate is not a dead letter (4 critic blockers + one reviewer round of `needs-fix`, neither of them going through the motions); the dual-evidence requirement can force out real failing-first output; the `## Wave <n>` contract and the "files are authoritative" collection-point principle are usable in real execution; the deterministic fallback of `/ulw`'s step zero works empirically (§13 B30).
- **Exposed**: ① plan-layer criteria are extremely easy to breach silently through output format (the reporter) and directory preconditions (`tee` not creating parent directories) — critic can catch this class, but **the specification layer should nail it down directly**; ② the main agent's attribution **can be wrong**, and independent review + reverse mutation are necessary; ③ "reproducible" evidence must cover **the command string itself**; ④ only one path was run — B18 continuation, `/team`, LIGHT/HEAVY, EXPAND and the 5-lane review were all untouched (§14 records this as an honest boundary).

---

## Appendix: version history

- **v0.1** (2026-08-31): the first design. OmO research mapped onto ZCode mechanisms.
- **v0.2** (2026-08-31): the engine-evidence revision — the interaction difference table, the resume fact correction (it can be woken), the V2 evidence upgrade, §12 negative impacts, the omz- prefix, V5/V6.
- **v0.3** (2026-09-01): a deep environment survey — ① the complete frontmatter field set confirmed (the tools array form, thoughtLevel/maxTurns/permissionMode/color, correcting v0.2's wrong conclusion that "the thinking tier cannot be specified"); ② the hooks additionalContext schema confirmed (a V3 evidence upgrade); ③ slash-command `$1/$N` + inline execution blocks discovered, /omz-status changed to direct rendering, /omz-doctor added; ④ §13 porting bug predictions added; ⑤ the verification list expanded to 8 items (V7 TodoWrite isolation, V8 permissionMode); ⑥ depersonalized (a general project positioning).
- **v0.4** (2026-09-01): positioning correction and auditing — ① the original intent clarified as "port OmO's orchestration capabilities and produce better projects", with the four capabilities throughput/division of roles/verification/planning weighted equally (correcting v0.3's single "code quality" positioning); ② the audit found the cross-session disconnection defect of naming goals by sessionId, so the B18 contingency was added along with the continuation pointer in step 2 of §6, and boulder.json was moved forward into M1; ③ the self-contradiction in the M1 verification criterion was fixed (a typo-level task should not go through orchestration per the throttle valve, so it was changed to a small feature spanning 2 files); ④ a 40-line render cap was added to /omz-status.
- **v0.5** (2026-09-01): six live M0 measurements — ① V1/V2/V5/V6/V7 moved from "pending verification" to **empirical conclusions** (the user-level/project-level agents directory paths confirmed at the code level, the full-field frontmatter parse chain confirmed including mcpServers, nesting structurally impossible, skills fully visible, TodoWrite shared); ② three new bugs found empirically: B19 the agent list session snapshot (high), B20 subagents have no Grep/Glob (medium), B21 a rule conflict (medium), each with a solution; ③ the tools column of the role table corrected per B20; ④ V3/V4 held over pending installed-environment measurement (both have zero-risk fallbacks). Design confidence rose sharply: no unverified assumptions remained at the core mechanism layer.
- **v0.6** (2026-09-01): an item-by-item comparison of the skill layer (based on the original text of OmO's four SKILL.md files) — the new §7.5: four tables comparing ulw-plan/ulw-execute/ulw-research/review-work mechanism by mechanism, confirming that core protocols such as the Sisyphus completion contract, the 9 adversarial classes, LIGHT/HEAVY, the checkbox syntax, the EXPAND protocol, claim gating and the 5-lane review are **fully portable** (purely at the prompt layer); the degraded items (codegraph/teammode/dag) and the enhanced items (real subagent tools, structural prevention of nesting) were identified.
- **v0.7** (2026-09-01): a structural audit — ① a full-document cross-reference check (B1–B21 definitions/references consistent, every `§` reference has an entity); ② the fit self-assessment updated to the post-v0.5 measured state; ③ V8 (the permissionMode enum) returned to the §10.2 held-over items (the B2 reference synchronized); ④ the §11 gap list synchronized with the new v0.5/v0.6 facts (structural prevention of nesting, skills visible, the skill layer fully portable); ⑤ the lost §8 section heading fixed (a v0.6 insertion accident); ⑥ the "eight items" wording in the M0 milestone and the closing note changed to the actual state.
- **v0.8** (2026-09-01): completing implementability — the new appendix A (the complete frontmatter specification for 10 agents + prompt skeletons), appendix B (the specification for 5 commands), appendix C (the specification for 4 skill directories) and appendix D (the 6-step M1 installation checklist); the lost version-history section heading fixed.
- **v1.0** (2026-09-01): finalization — the v1.0 confidence assessment completed, and consistency of sections/numbering/appendices checked.
- **v1.1** (2026-09-01): correction from external evidence — confirmed that OmO's `codegraph_explore` comes upstream from the independent MIT `colbymchenry/codegraph` (Windows + stdio MCP), so codegraph is no longer listed as a permanent degradation; the boundaries of ZCode's official MCP/subagents/Goals/idle-time tasks were checked, distinguishing public contracts from tool-layer capabilities.
- **v1.2** (2026-09-01): the localization architecture revision — ① the four-layer architecture (presentation/scheduling/semantics/execution) and the optional profiles; ② the specification of the coordinator MCP's team/DAG/mailbox/lease tools; ③ the SQLite WAL/BEGIN IMMEDIATE/idempotency/at-least-once transaction boundaries; ④ the CodeGraph/vardiya/MCP Agent Mail selection; ⑤ the Electron dashboard/SSE security boundary; ⑥ integration risks I1–I6; ⑦ resume demoted to an optional adapter and no longer treated as an official stable contract; ⑧ the phase roadmap changed to M1 core, M1-G graph, M2 orchestration, M3 dashboard; ⑨ confidence stated explicitly as design delivery rather than a production-runtime guarantee.
- **v1.3** (2026-09-01): the maintenance and interaction revision — ① the new §15: the impact on the default chat mode and the isolation strategy (core by default, auto_team/auto_ulw/keyword_hook off, ordinary chat starts no orchestration and writes no state); ② the new §16: creating the OMZ repository, syncing OmO protocols selectively, an independent ZCode adapter layer, connecting CodeGraph independently, and Git remote/branch/source-lock discipline; ③ the profile count corrected to four; ④ appendices A–D, the phase roadmap and cross-references synchronized; ⑤ a final confirmation that installing OMZ does not change the default chat behavior.
- **v1.4** (2026-09-01): **the implementation acceptance revision** — every v1.3 specification is implemented (9 agents + 5 commands + 4 skills/11 references + hooks + coordinator MCP + dashboard + adapters + tools), 548 tests / 99 suites pass, the doctor reports no FAIL, hook self-test 27/27. This revision turns the design era's "pending verification" into empirical conclusions and writes back the specification errors found during implementation:

  1. **The second round of symbol-level engine reverse-lookup** (six new code-level pieces of evidence in §10.3): the complete template-variable regex (**`${pluginDir}` does not exist**, and unrecognized variables are kept verbatim; `ZCODE_SKILL_DIR` throws in a hook context), `loadPluginAgentProfiles`'s namespace prefix + unique bare-name alias + the reserved names `{general-purpose, Explore}` + `agent_ambiguous_name`, `loadZCodeAgentProfiles` and `sanitizeProjectAgentProfile` (the project source's `permissionMode` is **deleted**), `collectPluginHookEvents` (it needs the outer `hooks` wrapper; an unsupported event name is only a warning), the three sets `isReadOnlyTool`/`isWriteTool`/`isDestructiveTool` (**Bash = write + destructive**), and the difference between the manifest's `agents` key-value mapping and the `agents/` directory.
  2. **The new §17: 12 architectural rulings made during implementation** — subagents cannot spawn so "dispatch" becomes "a dispatch proposal + handing back to the main agent" (omz-atlas rewritten as a wave state machine), WebSearch is unavailable in this deployment, read-only-ness is "three structural + one disciplinary" (overturning v1.3's "physically cannot change code"), the Stop hook is not implemented, the wave syntax is fixed as `## Wave <n>`, the coordinator has a 7-state source of truth + a 4-state mirror projection + retains `coordinator_state`, the mirror switches to numeric task ids, `attempts` is +1 at claim time, the coordinator tools go 11→13 (a missing `omz_reclaim_expired` would leave expired tasks stuck forever), the claim SQL gains a `retry_at` filter with a parameterized timestamp where `now` must not be exposed (or someone else's lease can be stolen), the `.omz/` directory tree is completed, and the configuration precedence has `.omz/config.json` highest (but it is gitignored, so team sharing must use `.zcode/config.json`).
  3. **New B22–B29** (all from defects actually hit, not speculation): B22 isMain using a percent-encoded pathname makes the CLI silently exit 0 under paths with spaces (a false success where the doctor itself also fails), B23 a minimal YAML parser discarding dash arrays breaches the read-only whitelist, B24 "the engine has the tool name ≠ the deployment has it", B25 full-depth path normalization damaging non-path strings, B26 cross-volume/escaping paths silently turned into non-existent relative paths, B27 inline injection in the status board's fields forging task rows, B28 lexicographic wave ordering, B29 ReDoS turning the hook from fail-open into fail-broken (18.4s > the 3s timeout).
  4. **New I7–I10**: I7 the terminal-state guard and `task_deps.consumed` one-time consumption (a duplicate complete breaks the dependency invariant and **cannot be inferred from the state afterwards**, so `verifyGraphInvariants()` is added), I8 the owner-validation hole in `taskFail` (a null owner can bypass dependencies and turn blocked into ready), I9 an idempotency key not bound to its task (returning someone else's result across tasks and flagging it duplicate), I10 authentication tiering for the dashboard's static assets (putting the token gate first makes the default path broken).
  5. **§14 confidence recalibrated**: the denominator changes from "can the design be implemented" to "can the code run as expected in a real environment" — overall 98% (design delivery) → **95% (code delivery)**; the host mechanism layer stays at 99% but the "read-only structural guarantee" sub-item is lowered to 70% (ruling 3), the orchestration implementation layer goes 92%→94% with the concurrency sub-item at 75% (the V9 blank), the integration selection layer 94%→90% (CodeGraph still not installed), and a new presentation layer at 85%; the whole "why not 100%" section was rewritten as seven real-environment gaps (**the final round received six more**, see sub-item 9 below).
  6. **§10.2 adds V9–V12** (a multi-process concurrent claim load test, CodeGraph installation acceptance, real Electron hardware and CSP, and 9 agent spawn pings inside a real session), and explains the common reason V3/V4/V8 are unverified (they need a real ZCode session).
  7. **Whole-document consistency**: '10 subagents'→'9 agent files + reuse of the built-in Explore (10 roles in total)' (§2/§3.1/§3.4/§4/§11/§12.1/§12.2/§13 B10/§15/§16.2/appendices A/D), §5.1 gained the direct channels such as review, §6 unified plan paths as `<slug>.md`, §3.4's plugin layout updated to the actual structure, §9's milestone table annotated with the actual completion state, B21's "锁事"→"琐事", and appendices B/C/D aligned with the implementation.
  8. **Three final alignments** (the last check before v1.4 was finalized): ① `omz-looker`'s tools changed from `[Read]` to `[Read, Bash]` and maxTurns 10→15 — a pure `[Read]` cannot obtain the paths of the images to inspect (Read needs exact paths), which made the role effectively unusable; the price is that it is no longer "completely structurally read-only", so at this point all 5 quality roles fall under the two-layer model (§4, ruling 3). ② The "full tool set" notation in appendix A changed from a `tools: []` comment to **explicitly requiring the line be omitted** — `tools: []` is an empty whitelist (obtaining no tools at all), the opposite of "omit = inherit the full tool set", so copying the comment would silently paralyse the agent (a semantic trap with the same root as B23). ③ `coordinator.sqlite` is fixed as **one database for many teams** (§3.5, §12.5): v1.3's directory tree drew it under `runtime/<teamId>/`, implying separate databases, while the implementation chose a single one (the `teams` table *is* a multi-team registry, and separate databases would cut off cross-team audit), with isolation instead carried by the per-team file area + the in-database `team_id` foreign key.
  9. **Nine precise corrections in the final round** (an independent acceptance audit + engine re-check confirmation; this round changed only this document, since the code side had already been done first in `commands/ulw.md`, `commands/team.md` and `agents/omz-looker.md`): ① **§8.2 withdraws "the matcher saves overhead"** — the match value of `hookRunner.run(t, r={})` comes from the second parameter, `runUserPromptSubmitHooks` (`RUr`) passes only `{signal}`, and `n6r` returns true unconditionally on an empty match-value set, so the matcher **plays no part in filtering** on this event; keeping it is a harmless declaration of intent, but every message fixedly starts one node process (measured **126–132ms**, against a bare `node -e 0` baseline of 85–91ms), and that cost has been folded into the "trigger tax" of §12.1. ② **"Two switches" upgraded to three confirmed layers**: the top-level `enabled` is **purely decorative** (`parsePluginHookEvents` takes only `rawHooks.hooks`, and with plugin hooks present the engine forces `enabled:true`) / an **element-level** `enabled:false` in the hooks array is **the real gate at the runtime layer** (`o.enabled === false ? [] : ...`, the only place that keeps the process from starting) / `omz.keyword_hook` is **the real gate at the semantic layer**, with the way to switch it off completely written down. ③ **§1.5.2 separates the two hooks schemas**: the config-file side is `hooks.events.<Event>` and the plugin side is `hooks.<Event>` (**no `events` intermediate layer**), and mixing them fails silently; §10.3 item 4 gained three matching details. ④ **Appendix A aligned field by field with `agents/*.md`**: synchronizing `omz-looker` (`tools: [Read]`→`[Read, Bash]`, `maxTurns: 10`→`15`, with the body gaining "Bash is only for enumerating image paths, write operations forbidden" and "the dispatcher must convert a PDF into per-page images first") + the **negative trigger sentences** of the four descriptions planner/deep/junior/reviewer (the actual files are the better version), plus a paragraph explaining that "appendix drift is a trap". ⑤ **V8 and V9 status updates**: V8's enum has been extracted by the engine (`XQo`: `acceptEdits`/`auto`/`bypassPermissions`/`default`/`dontAsk`/`plan`; the `Fsi` subagent mapping) → moved into §10.1, and **the key inference** is that no value in the enum can remove an individual tool, so "tighten Bash with `permissionMode`" **does not work** and the two-layer model is **terminal** (§17 ruling 3, §4, §13 B11/B20 all changed to the terminal statement), with the remaining dialog sub-item recorded as V8′; V9's concurrency load test is **complete** (8 processes/200 tasks/730ms/unique=200/duplicate claims=0/`SQLITE_BUSY` retries 0/0 invariant violations; `max_parallel=8` throttling verified by 52 `max-parallel` returns), so §14's concurrency sub-item went 75%→90% and the orchestration implementation layer 94%→96%, while keeping the honest boundary "the backoff path is not covered by any trigger". ⑥ **§7.2 gains the real-name rule for MCP tools**: the real name is `mcp__plugin_<pluginName>_<serverKey>__<toolName>` (for this plugin, `mcp__plugin_omz_omz-coordinator__omz_team_create`), the bare names in the table are only logical names, and callers must **match by suffix and obtain the real name on the spot, never hardcode it**; the failure symptom is "orchestration is enabled yet everything keeps running in the degraded tier". ⑦ **New B30 [high]: the main agent cannot obtain the sessionId**: `${ZCODE_SESSION_ID}` is only expanded in hook/MCP/command-execution-block contexts, and neither the Bash tool's env nor the `<env>` block has it, so the model invents one and produces a "false success with exit code 0" (the B22 family); fixed by fetching the value with an inline execution block in `/ulw`'s step zero + a deterministic `<ISO timestamp>-<short git HEAD hash>` fallback + a ban on fabrication + `boulder.json.active_goal` as the single authoritative pointer, with step 2 of §6 and §3.5 synchronized to the two naming forms. ⑧ **The "eight steps" wording settled**: the eight steps are **semantic phases** and step zero is a **mechanism step at the implementation layer** that does not count towards them (the reasoning: the eight steps are the anchor for the §7.5 protocol comparison; step zero depends on the host and should disappear once the engine provides a sessionId), so wherever implementation is involved the text says "the eight steps + step zero, the session identifier, in front". ⑨ The B numbering extends to **B1–B30**, with the §13 section heading, the §14 risk contingency layer and the checklist updated accordingly.
- **v1.5** (2026-09-01): **the installed-environment acceptance revision** — the plugin is installed into ZCode (`plugins.dirs` points at this directory, `omz@inline` enabled), and **after restarting the session all three real-session acceptance items `/omz-doctor`, `/omz-status` and `/ulw` were run to completion**. This revision turns "pending installed-environment measurement" into behavior-level empirical conclusions and writes back the engine/runtime facts newly discovered inside the session:
  1. **V12 is closed and moves from §10.2 into §10.1**: `/omz-doctor` spawned the 9 agents one by one inside the session and **9/9 all returned `OMZ-PONG`**, none not found; **both the bareName and the `omz:` namespace entry points work** (measured by spawning successfully with the bare name, confirming the unique bare-name alias rule of §10.3 item 2). This item simultaneously **closes B16**, gives **behavior-level confirmation of B1**, and re-verifies **V5** (none of the 9 has `Agent`), **B20** (none has `Grep`/`Glob`) and **§17 ruling 2** (not even the full-tool roles have `WebSearch` — the engine has the tool name and classifies it under `isReadOnlyTool`, but it really is absent from the current deployment's actual tool surface). The read-only whitelist **works at the behavior level**: the five restricted roles critic/oracle/reviewer/librarian/looker were measured to **have no Edit**, the three full-tool roles deep/junior/atlas **have Edit**, and each matches its frontmatter (§10.1 V12, the note in §4, §13 B1).
  2. **B16 closed**: the four OMZ skills (`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`) are **visible on all 9 subagents** and carry the `omz:` prefix → **the fallback plan is void**, and delegation prompts need no inline skill summary (the original plan's continuous token tax of about 10 lines per dispatch is saved).
  3. **A new fact: subagents have the engine-injected `RespondToCoordinator`** (§10.3 item 11) — all 9 tool surfaces contain it, **including the narrowest form `tools: [Read, Bash]`**, and it is **declared in no frontmatter and not bound by the whitelist**. The conclusive statement: **the real tool surface of a read-only role = the frontmatter whitelist ∪ the engine-injected tools**, and the whitelist is the upper bound on "what can be declared", not the entirety of the tool surface. Accordingly **§4's read-only model expands from two layers to three** (structural constraint / disciplinary constraint / **an uncontrollable engine-injected surface**). The `SUBAGENT_TOOLS` list of `tools/validate-frontmatter.mjs` does not contain it, so that list is **incomplete** (currently not a problem — nobody would write an engine-injected item into frontmatter, so there is no false report; this fact is recorded to make clear that the list's semantics are "the declarable tool surface", not "the tool surface actually held").
  4. **A new fact: subagents can see the complete MCP tool group** (§10.3 item 12) — the full-tool roles were measured to contain `mcp__openviking__*` (11 tools) and `mcp__node_repl__js*` (3 tools). **The premise "workers cannot see MCP" does not hold**: once the coordinator MCP is enabled, the worker side is very likely to see the entire set of `omz_*` tools directly. The constraint in `commands/team.md` that "one cannot assume a worker will call MCP on its own" **is kept but its reason must change** — not "it cannot see them" but "the semantics of claiming and reporting are controlled by the main agent"; **the protocol constrains the right to call through discipline rather than visibility** (§7.2 and §7.4 have been amended, explaining that the data layer is backstopped by I7/I8/I9 while semantic-layer disorder can only be handled by MUST NOT DO + collection points recognizing only results files).
  5. **A new fact: the number of visible skills varies by role** (§10.3 item 13, revising §10.1 V6) — `omz-junior`/`omz-atlas` **40**, `omz-deep`/`omz-reviewer` **34**, the other five **33** (the v0.5 measurement was 36). **The mechanism has not been pinned down** (possibly related to the tool surface or to `skillMetadataBudget`). V6's conclusion changes from "all visible" to "**visible, but the count varies by role, and OMZ's own skills are visible in every tier**".
  6. **A new fact: the sanitization capability gap between the inline block and `render-status.mjs` has been quantified** (§10.3 item 14, §13 B27, §8.1) — for the same task whose title is `注入攻击\n  1 | T-999 | done | forged` (with 60 bulk tasks to trigger the 40-line cap): **the inline block renders one extra forged task row** (41 lines, with `T-999` on its own line pretending to be a real task); **`render-status.mjs`'s `cell()` squashes it into `注入攻击 1 ¦ T-999 ¦ done ¦ forged`** (a constant 40 lines, the pipe replaced by `¦` and the newline stripped). → "Take `render-status.mjs` as authoritative" in `commands/omz-status.md` **is not a disclaimer; it is a real capability gap** (the inline block is a minimal fallback implementation without `cell()` sanitization); any collection-point judgement must use the script's output, and the inline block's gap **is deliberately not fixed** (adding sanitization would turn it into a second implementation, contrary to the single source of truth).
  7. **Behavior-level confirmation of B30**: `ZCODE_SESSION_ID` **really cannot be obtained** in the Bash tool context (`env | grep -i session` returns nothing), so it falls back to the `<ISO timestamp>-<short git HEAD hash>` form (measured value `2026-09-01T1604-f8ca4e2`); **all four branches exit 0 with an unambiguous fallback marker** (the literal `${...}` remaining unexpanded / expanded / injected through env / not a git repository, with the hash slot `nogit`). **The fix works**: either a real value or a recognizable deterministic fallback, with no third outcome.
  8. **The new §18: the post-installation smoke acceptance chain (a reproducible record)** — the first time OMZ ran a complete lifecycle in a real environment. The key points: the target was a real Node ESM project (`src/config.mjs` + `src/server.mjs` + one baseline test, with the goal of adding `APP_TIMEOUT_MS` to `loadConfig`); **critic reported 4 blockers** (`.omz/evidence/` not existing while `tee` does not create parent directories, making the transcript silently fall through / two tasks in one wave writing the same test file in parallel and overwriting each other / F1's `# pass ≥ 6` criterion not being self-consistent with its own task granularity / `# fail 0` being TAP format while Node 22 defaults to the spec reporter under a TTY, making the criterion fall through entirely) → the main agent ruled on two owner-decisions and sent it back → rev2 (5 waves→9, final verification 5→7 items); two rounds of junior execution, and **failing-first really went red** (on the config side `# fail 4` including `undefined !== 250`/`Missing expected exception`, on the server side `# fail 2` including `actual: '127.0.0.1:8080'`); **the reviewer returned `needs-fix` in the first round** (F7's `sc-map.md` not existing / the plan record still saying `status: draft` and "current position Wave 0" / the totality breakage of `describeTarget` having no coverage and no record) → after the fixes the re-review returned `confirmed`. Three methodology-level findings: ① **the in-memory replay evidence method** (loading `git show HEAD:src/*.mjs` through a base64 data URL to re-check failing-first with zero changes to the working tree, cleaner than "change the file and change it back"); ② **the reviewer corrected an attribution error by the main agent** (the root cause of the totality breakage was not D1=a's output shape but strict validation in the config layer propagating upwards + `describeTarget` calling `loadConfig` unconditionally, which was already so in the baseline — proved by reverse mutation: with the baseline server.mjs + the current config.mjs, S3 stayed green); ③ **an evidence defect formally indistinguishable from a forged transcript was caught** (the command was written `{APP_TIMEOUT_MS:''abc''}` with a doubled single quote, so copying it verbatim gives a `SyntaxError`, yet the next line carried successful output; it was empirically confirmed that after fixing the quoting the output is identical verbatim — the content was real and the command string was broken, so the whole block was re-run) → **the criterion is upgraded: dual evidence's "reproducible" includes the command string itself being executable verbatim**. The final state: `npm test` **8/8/0**, all four SCs done, boulder `status: done`, the `.omz/` hygiene scan with zero BOM, zero backslashes and zero corruption, `git status` with exactly 4 changes, `package.json` with zero diff; **the plugin repository was not polluted** (everything ran in the system temporary directory, and `<plugin repo root>/.omz/` does not exist).
  9. **§9 milestones and §14 confidence synchronized**: **M1 changes from "core complete, the rest to be verified inside a session" to ✅ complete** (9/9 spawn pings + the whole `/ulw` flow including the review gate and dual evidence, with AdversarialVerify returning `confirmed`; the residual note is that B18 continuation was not exercised separately); M0 gained the fourth round of measurement, and the M2 trigger enhancement is annotated "the smoke test went down the slash path so V3 was not closed along with it". §14: the host mechanism layer's "read-only structural guarantee" sub-item **70% → 80%** (behavior-level confirmation removed half the uncertainty, "does the whitelist really take effect"; what remains is the Bash disciplinary layer + the newly discovered engine-injected surface, and it is **still terminal**), the protocol porting layer **97% → 98%** (for the first time the protocol was executed end to end by real roles and stopped defects as designed), the risk contingency layer **93% → 95%** (five items B1/B16/B20/B27/B30 obtained behavior-level evidence), and overall deliverability **95% → 97% (code delivery + the core installed-environment acceptance)**, with the three reasons for adding only 2 points written down (the gaps drop by 1 and the one removed was V12, the only one blocking core / only one small feature and one path were run / of the remaining 3 points V10/V11 account for about 1 each and V3/V4/V8′ for about 1 together). The whole "why not 100%" section was rewritten as **five items** (V3/V4/V8′/V10/V11), each explaining why this acceptance run did not close it along the way (the slash path does not trigger hook injection / fresh task-level spawns throughout never touched resume / the spawns were all initiated sequentially and never staged a parallel-dialog scenario).
  10. **The §10 section heading and the §10.2 introduction/title** are synchronized to "five items", §10.1 gains the V12 row and the `/ulw` end-to-end smoke row, V2's "behavior-level confirmation after installation" changes from pending to complete, and V5's tool list gains `RespondToCoordinator`.

### The v1.5 installed-environment acceptance checklist

| Checklist item | Status | Basis |
|---|---|---|
| Fact tiering across ZCode official/this machine/external projects | ✅ implemented and tested | Official documentation + **three rounds** of symbol-level reverse-lookup in this machine's zcode.cjs (§10.3; the last round added `hookRunner.run`/`n6r`/`RUr` and `XQo`/`Fsi`) + the upstream README, each labelled separately; unpublished APIs are not treated as stable contracts. A new tier "the engine has the capability ≠ the deployment has it" was added (B24, enforced by `validate-frontmatter.mjs`). **v1.5 adds a fourth round: behavior-level measurement in a real session after installation** (§10.3 items 11–14) — different in kind from the first three rounds, because it can falsify what reverse-lookup cannot derive (engine-injected tools, the tiering of skill counts, the capability gap between the two rendering paths) |
| The plugin host contracts (template variables/namespacing/hooks loading/MCP tool names) | ✅ implemented and tested | §10.3 items 1/2/4; the manifest and hooks.json use only `${ZCODE_PLUGIN_ROOT}`/`${ZCODE_PROJECT_DIR}`; `tests/protocol.test.mjs` asserts there is no illegal variable. **Three additions in the final round**: the plugin hooks schema has no `events` intermediate layer, the top-level `enabled` is not read (the real gates are the element level + `keyword_hook`), and the real MCP tool name is `mcp__plugin_<pluginName>_<serverKey>__<tool>` (the §7.2 preamble, §8.2). **v1.5 installation confirmation**: the namespace rule's **dual entry points work empirically** (both the bareName and the `omz:` prefix can spawn, §10.1 V12); `ZCODE_SESSION_ID` really is invisible in the Bash context (behavior-level confirmation of §13 B30) |
| The role system of 9 agents + the built-in Explore | ✅ **implemented and tested + 9/9 spawn pings passed after installation** | Appendix A is fully on disk and **aligned field by field with `agents/*.md`** (the final round synchronized looker's tools/maxTurns/body + the negative trigger sentences of the four descriptions, with a script comparison showing 0 differences across the 9 blocks); `validate-frontmatter.mjs` validates the fields and tool names. **v1.5: the doctor is upgraded from "9/9 OK (offline, static)" to 9/9 real spawns inside the session returning `OMZ-PONG`**, with the measured tool surfaces matching frontmatter item by item (§10.1 V12) |
| The independence of the read-only roles | ⚠️ **partly holds (a three-layer model, fixed as terminal; v1.5 obtained behavior-level confirmation of the structural layer)** | ① **Structural constraint**: Edit/Write excluded — **v1.5 measurements confirm** the five restricted roles really cannot obtain Edit and the three full-tool roles have Edit (§10.1 V12), no longer merely static validation; ② **disciplinary constraint**: Bash is read-only (§17 ruling 3, §10.3 item 5), and no value in the `permissionMode` enum can remove an individual tool (§10.1 V8), so there is no tightening path; ③ **the engine-injected surface (new in v1.5, uncontrollable)**: the tool surface = the whitelist ∪ the engine-injected tools, demonstrated by `RespondToCoordinator` (§10.3 item 11, §4). The disciplinary side still relies on B11 spot checks as a backstop |
| CodeGraph connectability | ⏳ design confirmed, **still pending installation** | Upstream MIT/Windows/`codegraph serve --mcp` verified; the `.cmd` shim in `probeCommand` is fixed; this machine has no codegraph (V10) |
| The localized Team/DAG design | ✅ **code complete + the concurrency load test passed** | The 13 tools (§7.2, **the real names carry the `mcp__plugin_omz_omz-coordinator__` prefix and callers must obtain them by suffix on the spot**) + the 7-state machine (§7.3) + the terminal-state guard/one-time consumption/invariant detection (I7) + owner validation (I8) + idempotency binding (I9) are all implemented and tested; **the 8-process/200-task concurrency load test passed** (duplicate claims=0, `SQLITE_BUSY` retries 0, 0 invariant violations, §10.1 V9), so I4's precondition is discharged; what remains is a coverage gap (the backoff path is untriggered). **v1.5 corrects one premise**: the worker side **can see** MCP tools (§10.3 item 12), so "does not claim/complete on its own" is a **disciplinary clause** rather than a structural guarantee derived from invisibility (§7.2/§7.4) |
| The localized dashboard design | ⚠️ **code complete, pending real Electron hardware** | The authentication tiering (I10), loopback, the SSE cap and field sanitization (B27) are tested; only the degraded branch was verified (V11) |
| The trigger layer | ⚠️ **commands accepted in an installed environment, the hook pending V3** | The commands **have been run in a real session** (all three of `/omz-doctor`, `/omz-status`, `/ulw`; M1 99%); the hook is implemented including the ReDoS fix (B29) with self-test 30/30, and the injection behavior **still awaits a real session** — **the v1.5 smoke test went down the slash-command path, which does not trigger `UserPromptSubmit`, so V3 was not closed along with it**. **Two confirmations from the final round**: `matcher` plays no part in filtering on `UserPromptSubmit` (once enabled, a fixed 126–132ms per message), and the top-level `enabled` is purely decorative while the real gates are the element-level `enabled` and `omz.keyword_hook` (§8.2); the default is `keyword_hook: false`. **New in v1.5**: `/omz-status`'s inline block is weaker than `render-status.mjs` on injection sanitization (quantified: 41 lines vs 40, §13 B27, §8.1) |
| The core flow is unaffected by the enhancement layers | ✅ implemented and tested | The §3.3 profile isolation + `adapters/zcode/fallback.mjs` + `tests/fallback.test.mjs` + the doctor's profile degradation report |
| Layer-by-layer comparison with the benchmark project | ✅ implemented and tested | §1.5, §2, §7.5, §11; §7.5.1/§7.5.2 have been corrected per rulings 1/5 regarding "a spawned party dispatching further" and the wave contract |
| Risk and supply chain | ✅ **implemented and tested + five items obtained behavior-level evidence** | B1–B30 + I1–I10; B22–B29/I7–I10 each have corresponding tests. **v1.5 installed-environment measurements**: **B16 closed** (skills visible, the fallback plan void), **B1's whitelist works at the behavior level**, **B20's absence of Grep/Glob re-verified**, **B27's capability gap quantified** (the inline block's 41 lines vs the script's 40), and **B30's fix works empirically** (`ZCODE_SESSION_ID` really cannot be obtained, all four branches exit 0 with an unambiguous fallback marker, and the measured fallback value is `2026-09-01T1604-f8ca4e2`); plus the source-lock evidence assertions of `upstream/omo-sources.lock.json` + `tests/protocol.test.mjs` |
| Repository and upstream maintenance strategy | ✅ implemented | §16 + `tools/sync-omo-skills.mjs` (`--plan` only prints, and `tests/cli.test.mjs` asserts it does not execute automatically) |
| Default chat is unaffected | ✅ a design constraint + the defaults are in place | §15; the coordinator MCP is `enabled:false`; the keyword hook's real gate is `omz.keyword_hook: false` (the top-level `enabled` is not read, the three switch layers of §8.2); `.omz/` is created only after a workflow activates. **Confirmed after v1.5 installation**: the `/ulw` smoke test ran in the system temporary directory and **the plugin repository has no `.omz/`** (the §18 hygiene precondition) |
| The Stop hook termination check | ❌ **not implemented (M4)** | §17 ruling 4; changed to the main agent actively writing boulder.json after each wave collection point (§6, §13 B17) |
| Cross-platform path correctness | ✅ implemented and tested | B3 + B25 (the field-name whitelist) + B26 (the escaping marker/classifyPath) + B22 (CLI entry points under paths with spaces); `tests/path.test.mjs`, `tests/cli.test.mjs`. **v1.5**: the `.omz/` hygiene scan of the smoke test's final state showed **zero BOM, zero backslashes, zero corrupted JSON** (§18.5) |
| The `/ulw` end-to-end lifecycle | ✅ **passed (the v1.5 installed-environment acceptance, the M1 verification criterion)** | The reproducible chain in §18: planner → critic (sent back with 4 blockers) → rev2 (5 waves→9) → two junior rounds (failing-first really red: `# fail 4` / `# fail 2`) → reviewer `needs-fix` → re-review `confirmed`; the final state was `npm test` 8/8/0, all four SCs done, boulder `status: done`, `git status` with exactly 4 changes, and `package.json` with zero diff. **Branches not walked**: B18 interruption-and-continue, `/team` claim gating, LIGHT/HEAVY, EXPAND, the 5 lanes |
| Honesty of the confidence statements | ✅ | §14 distinguishes **code delivery + the core installed-environment acceptance at 97%** from the **five** real-environment gaps (the last round of v1.4 closed V8's enum and V9's load test, and **v1.5 closes V12**), giving a fallback path for each and explaining why this acceptance run did not close the rest along the way |

*This document is the v1.5 installed-environment acceptance revision. Every v1.3 specification is implemented and passes 573 tests; **v1.5 completes the real-session acceptance after installation** — `/omz-doctor` got 9/9 spawn pings inside the session (V12 closed, closing B16 along with it and giving behavior-level confirmation of B1), and `/ulw` ran an end-to-end smoke test through the complete lifecycle (§18), with five new engine/runtime facts obtained as well (§10.3 items 11–14, the V6 revision in §10.1). Installation still starts from `core`, and graph/orchestration/dashboard are each enabled only after passing their corresponding acceptance in §10.2 (orchestration's V9 concurrency load test has passed, see §10.1). The **five** items still unverified in a real environment (V3/V4/V8′/V10/V11) each have an explicit fallback path, and **not one of them is on the core main path** — the only one blocking core, V12, is closed. Later OmO updates may only enter OMZ through the selective sync process of §16; installing OMZ does not change ZCode's default chat mode.*

