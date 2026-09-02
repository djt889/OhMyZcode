**English** | [简体中文](./CHANGELOG.zh-CN.md)

# OMZ implementation changelog

**Two version numbers**: the version in `package.json` / `.zcode-plugin/plugin.json` tracks **implementation**
progress; the v1.x at the top of `DESIGN.md` is the **design document** version. The minor digits of the two are
aligned to the same spec — one is "written down", the other is "running". Currently: implementation **1.7.0** ↔
DESIGN **v1.5** (1.6.0, 1.6.1 and 1.7.0 are documentation, packaging and defect-fix releases; none changes the design
spec).

**Skipped numbers are intentional**: 0.7.0 / 0.8.0 are reserved for the `graph` profile (DESIGN §9 M1-G, which
requires installing `@colbymchenry/codegraph` externally and running `codegraph init` in the target project) and for
writing back measurements from a real environment (the five current items of §10.2: **V3** the actual injection
behavior of the hook's `additionalContext`, **V4** the resume adapter, **V8′** the timing of the permission prompt on
parallel spawns, **V10** CodeGraph installation, **V11** real-machine rendering of the Electron dashboard and actual
CSP blocking). Both kinds depend on a real installed environment or a real ZCode session and were not delivered this
round; 1.0.0 was never released on its own — once the orchestration layer landed, it went straight into the 1.x line.
The list itself shrinks as versions go by: the enumeration part of **V8** and the **V9** concurrency stress test were
settled in 1.4.0 (V8 has only the prompt sub-item left, recorded as V8′), and the 9 agent spawn pings of **V12** were
settled by the 1.5.0 installed-environment acceptance (six items → five).

Every entry records three things: **Scope** (what was delivered), **Verification** (how it was proven to work, with
reproducible numbers), and **Known gaps** (what was still missing at the time). All numbers are taken from actual run
output on Node v22.14.0 / Windows on 2026-09-01.

---

## 1.7.0 — Installable from its own marketplace, with a diagnostic-free install (2026-09-02)

**Scope**

- **A self-hosted marketplace index, `.claude-plugin/marketplace.json`.** ZCode discovers that exact path
  (`.claude-plugin/marketplace.json` → `marketplace.json`, engine constant `JRo`), so `/plugin marketplace add
  djt889/OhMyZcode` followed by `/plugin install omz@omz-marketplace` runs through **the same
  `installMarketplacePlugin` code path the official marketplace uses** — including update, enable and disable. The
  official `zcode-plugins-official` marketplace is not an option here: its source is Z.ai's CDN and every entry has
  `source: "filesystem"` pointing at directories shipped inside the client, so it has no submission path.
  The entry uses `source: "github"` rather than `"git"`: `resolveRepositoryPluginSource` tries the GitHub tarball API
  first (`requireSingleRoot` + `stripRoot`, **no local `git` needed**) and falls back to `git clone` only on
  401/403/404 or a submodule/LFS repository. `ref` is pinned to the `v<version>` tag, so an install gets the released
  tree rather than whatever `main` currently is. `sha` is deliberately absent and that is not an oversight: this index
  lives in the same repository as the payload it pins, so writing its own commit sha would be self-referential and
  unknowable before the commit exists — the engine's pin is `sha ?? ref`, and the tag already fills that role.
- **A diagnostic-free install, verified by running the engine rather than by reading it.** `zcode plugins list
  --verbose` used to print two warnings for `omz`; it now prints none. Both had the same shape — the manifest
  declaring something the engine already handles:
  1. `"agents": "agents"` → `plugin_unsupported_component: Plugin component is diagnostic-only in this ZCode
     runtime: agents`. The engine's `ZMo()` warns for every key in `["agents","channels","lspServers",
     "outputStyles","settings"]`. Subagents were never loaded from that declaration: `loadPluginAgentProfiles` scans
     `<root>/agents/*.md` directly. Removing the key changes nothing about the 9 subagents and removes the warning.
  2. `"hooks": "hooks/hooks.json"` → `plugin_hook_invalid: Duplicate plugin hooks file ignored`.
     `listPluginHookSources` **auto-discovers exactly that path first**, then reads the manifest key; identical
     realpaths make the second one a discarded duplicate. The auto-discovered entry was always the live one.
  Both removals are now asserted by tests, so they cannot creep back in.
- **Marketplace listing metadata.** `displayName`, `displayName_i18n`, `description_i18n`, `category`, `tags`,
  `homepage`, `author.url`, `examplePrompts` and `examplePrompts_i18n` — the fields the engine's `Cee()` actually
  reads into a plugin card. The listing states up front that OMZ registers one `UserPromptSubmit` hook whose
  injection is gated off by default, because a user reading only the card should not be surprised by a hook.
- **Five commands now declare `name` explicitly.** The engine's `readMarkdownFrontmatter` reads only `name` and
  `description`, falling back to the filename when `name` is absent. Declaring it decouples the command name from the
  filename, so renaming a file cannot silently change what users type.
- **`ulw-execute`'s skill description: 204 → 103 characters**, keeping the strict activation clause. Skill
  descriptions sit in the discovery context permanently; this one was carrying the `/ulw` step number and the Atlas
  session mention, neither of which affects whether the skill should activate.

**Verification**

`npm test` **577 tests / 102 suites, 0 failures** (573 before: four new cross-file contract assertions).
**Mutation-tested, because four green assertions prove nothing on their own** — seven mutations, each reverted
immediately, each turning the suite red exactly once: re-adding `agents` to the manifest; re-adding the `hooks`
declaration; a marketplace entry version that disagrees with `plugin.json`; `source: "git"` instead of `"github"`;
`ref: "main"` instead of the tag; deleting a command's `name`; a command `name` that disagrees with its filename.
Baseline and post-restore both `fail=0`.

Engine-level verification, run against this exact tree: `zcode plugins list --verbose` reports **no warning and no
error** for `omz` while still reporting `skills: 4, commands: 1, hooks: 1, mcp: plugin:omz:omz-coordinator`;
`zcode commands list` still lists all 5 commands; `zcode skills list` still lists all 4 skills under both the
namespaced and the bare alias. So removing the two manifest keys cost no capability. `node tools/doctor.mjs`
reports no FAIL, `node tools/validate-frontmatter.mjs .` passes, `hook:self-test` 30/30.

**Known gaps**

- The `claude-plugins-official` marketplace (286 entries, `git-subdir` sources, accepts PRs) ships an automated
  security review in `.github/policy/`. OMZ **would fail it as it stands**: the policy sets
  `has_broad_scope_hooks=true` for any `UserPromptSubmit` hook without a *project-relevance* gate, and `passes=false`
  follows from that alone. OMZ's matcher is a keyword gate, not a project gate — and on `UserPromptSubmit` the engine
  does not filter on matcher at all, so the process starts on every message. Everything else in that policy is
  already clean: no network call anywhere in the hook, no telemetry, no credential access, no downloaded software,
  and a description that discloses the hook. Submitting there would mean shipping the hook as a separate plugin.
- The upstream Sustainable Use License 1.0 versus this repository's MIT boundary is still a legal judgement for the
  project owner; `upstream/omo-sources.lock.json` records evidence only.
- The five items of §10.2 that need a real environment (V3/V4/V8′/V10/V11) are untouched by this round.

---

## 1.6.1 — A verified four-layer architecture diagram in the README (2026-09-02)

**Scope**

- **A four-layer architecture diagram, one per language, embedded in the top-level READMEs.** Both are generated from a
  typed [archify](https://github.com/tt-a1i/archify) specification under `docs/`, and each ships as four files: the
  specification (the only hand-edited one), a self-contained interactive HTML viewer, and light/dark PNG captures of the
  diagram surface for GitHub to render inline. The READMEs use `<picture>` with `prefers-color-scheme`, so a reader on
  GitHub's dark theme gets the dark capture.
  The two languages are **two separate specifications with identical topology**, not one file with translated strings:
  node sizes and the viewBox are tuned per language because CJK glyphs are twice as wide in the renderer's measurement
  model, and the viewer's own UI language follows `meta.locale`. Seven components carry `sources` references that point
  at real files in this repository (the coordinator's MCP entry point and schema, the dashboard's GET-only surface,
  `probeCodegraph`, the review-gate agent, the eight-step lifecycle command, the status renderer); `deliver` verifies
  those paths against the repository at the recorded revision rather than trusting the specification.
- **What the diagram is drawn to say.** The topology is DESIGN §3.1 plus §3.3 in one frame: the execution layer is the
  only one always present (`core`), and the other three sit behind their own default-off switch with their own fallback.
  Four guided views walk the default `core` path, DAG scheduling, semantic retrieval, and the three fallback chains.
- **`docs/README.md` + `docs/README.zh-CN.md`** record how to regenerate the artifacts, why the HTML is the real
  artifact and the PNGs are only what GitHub can inline, and the verification state of exactly the committed bytes.

**Verification**

For both languages, at the revision recorded in each specification's `meta.repository`: `validate` and `deliver` report
**9/9 artifact checks** under the `showcase` profile with **0 errors and 0 warnings**, and repository evidence
**verified** against 7 source references. `visual-check` reports **`status: pass`** — no vertical or horizontal overflow
at 1440×900, 1600×1000, 1920×1080 or 2048×1320, with the smallest projected node text at **7.6 px** (English) and
**7.8 px** (Chinese) at the tightest viewport, against a 6 px floor. The rendered light and dark captures were reviewed
by inspection. Unchanged this round and re-run: `npm test` **573 tests / 102 suites, 0 failures**;
`node tools/doctor.mjs` **no FAIL**; `node tools/validate-frontmatter.mjs .` passes.

**Known gaps**

- A `showcase` pass is a mechanical claim about **composition and containment** — no edge crosses an unrelated node, no
  label is masked, nothing overflows a desktop viewport. It says nothing about whether the facts drawn are correct;
  those remain the responsibility of DESIGN §3.1 and §3.3.
- The PNGs are captures, so they do not track the specification automatically. Editing a specification without
  re-running `deliver` and re-capturing leaves the README showing the previous diagram, and nothing in the test suite
  catches that. The regeneration commands are in `docs/README.md`.
- The five items of §10.2 that need a real environment (V3/V4/V8′/V10/V11) are untouched by this round.

---

## 1.6.0 — Bilingual documentation; fixed the hook injection budget misalignment (2026-09-02)

**Scope**

- **Bilingual documentation.** `README.md`, `CHANGELOG.md`, `DESIGN.md` and the four module READMEs
  (`mcp/coordinator/`, `dashboard/`, `hooks/`, `upstream/`) become English primary files — that is what GitHub shows
  by default and the repository topics are English too — each with a matching `*.zh-CN.md` Chinese counterpart. The
  Chinese bodies are the original text carried over **verbatim, not back-translated**: a round trip through two
  languages loses precisely the load-bearing distinctions this project depends on ("the code path is confirmed" vs
  "behavior has been measured" vs "pending empirical verification"). Both versions carry a language switcher on line 1
  and cross-file links point at the matching language. `NOTICE` is bilingual **inside one file** — splitting a legal
  notice across two files invites version drift.
  Terminology is constrained by an 8-category do-not-translate list (role names, commands, skill names, tool and
  frontmatter fields, MCP tool names, paths, engine symbols, template variables, and the `B<n>`/`I<n>`/`V<n>`/`§`
  numbering) plus 60 fixed translations. Cross-reference parity was checked programmatically: 469 `§` references
  (44 distinct), `B1`–`B30`, `I1`–`I10`, `V1`–`V12` — identical counts in both versions, zero dangling.
- **Fixed a real defect: the hook injection budget was aimed at the wrong wall.** The old
  `MAX_CONTEXT_BYTES = 48 * 1024` (49152) sat **above** the engine's default `maxOutputBytes` of **32768** (five places
  of evidence in the engine source), and it measured the byte length of the `additionalContext` **string** while the
  engine measures the **complete JSON payload on stdout** (measured difference: 267 bytes, and the gap widens the more
  CJK text there is). Two misalignments stacked.
  The consequence for an injection body landing between 32768 and 49152 is worse than a truncated JSON:
  `OutputCollector.append()` drops the remaining chunks once `inlineBytes >= maxInlineBytes` (setting only a
  `truncated` flag that the hook path never reads), and `parseHookStdout()` then runs `try{JSON.parse(r)}catch{return}`
  on the half message, returning `undefined`. **The whole injection disappears silently** — no kill, no non-zero exit
  code, no error, only "the hook doesn't seem to have fired". The `o.kill()` path noted earlier belongs to
  `runGitCommand()`, not to the hook execution chain; hooks go through the executionPort's `outputLimit`.
- **The fix.** Added `ENGINE_DEFAULT_MAX_OUTPUT_BYTES = 32768` with the engine evidence in a comment; moved the
  decision onto `payloadBytes(text) = Buffer.byteLength(JSON.stringify({ additionalContext }), 'utf8')`; set the budget
  to `MAX_PAYLOAD_BYTES = 24576` (32768 − 8192, a 25% margin, because user or workspace configuration can set
  `maxOutputBytes` **lower** and we cannot read that value); extended the degradation from two levels to three
  (`full` → `headings` → `minimal`) with a `fitToPayload()` hard-trim backstop so **no path can end in "degraded but
  still over the limit"**; and the head-window size is found by **binary search over measured payload** rather than
  linear back-off, because under escape-dense input linear back-off cuts the window to zero in one step and throws away
  space that would have fit. `MAX_CONTEXT_BYTES` is kept as a derived reference value (`MAX_PAYLOAD_BYTES - 24`) that
  **no longer participates in any decision** — under JSON escaping one character can expand to 6 bytes, so any
  string-side threshold can drift out of alignment again.

**Four loose ends closed**

- `tests/cli.test.mjs`: the comment claiming "the upstream license is unverified in the current repository state" was
  stale. The license is verified; the only source of `exit 1` from `doctor --supply-chain` is `supply:codegraph` on a
  machine without codegraph. The comment now states the four environment-independent invariants those cases actually
  assert, so installing codegraph will not turn them red.
- `checkRequestTarget()` had an implementation and **zero assertions** — the only such item on the I5 list (a
  whole-repo search hit `server.mjs` alone; changing the body to `return true` turned nothing red). Added 9 cases on
  two levels: 5 pure-function cases, plus 4 real-socket cases using `net.connect` to hand-write the request line,
  because the `node:http` client only ever emits origin-form and cannot construct absolute-form at all.
- The upstream-license criterion is now a shared function, `tools/lib/license-gate.mjs`. Previously `doctor.mjs`
  required four fields while `sync-omo-skills.mjs` only required a non-empty `status` not starting with `unverified` —
  `status: "pending"` passed silently there. **The judgement is now shared; the severity stays differentiated by the
  caller's role**: `doctor --supply-chain` is a release gate and reports FAIL, `sync --check` is a pre-sync notice and
  reports WARN. The known limit is documented in the module header: writing `spdx: "MIT-typo"` with the other three
  fields filled in still evaluates to `ok`, because four fields present only proves there is a re-checkable evidence
  trail, not that the value itself is right.
- I5 protection counting: the code side keeps its own seven-way split (port and token are two independent pieces of
  logic in `server.mjs`) but now states explicitly where it differs from DESIGN's six-way split, and that the original
  seventh — preload — was withdrawn along with the component.

**Verification**

`npm test` **572 tests / 102 suites, 0 failures** (557/101 before this round: `checkRequestTarget` +9,
injection-budget +15 in a new "injection payload budget and degradation" suite);
`node hooks/keyword-detect.mjs --self-test` **30/30** (+3 covering `full` / `headings` / `minimal`);
`node tools/doctor.mjs` **no FAIL**; `node tools/validate-frontmatter.mjs .` passes.

New assertions pin the invariants rather than the current numbers: budget + margin ≤ engine default; the payload of all
three modes is under budget; each degradation level has its own payload upper bound; a `ulw.md` regression sentinel
(payload under budget **with more than 1.5x headroom**, so further growth hits the test before it hits the engine); and
a wall-clock sentinel for degradation on 5MB input (< 1500ms — the binary search costs one `JSON.stringify` of the
prefix per step, and being killed on timeout produces zero output, which is worse than a failed degradation).

Two mutation checks confirm the new tests have teeth: setting the budget back to 49152 turns **3 red** (including
`budget(49152) + margin(8192) must be <= engine default(32768)`); removing the second degradation level turns **3 red**
(including `payload 82865 returned under budget 24 (level=headings) is out of bounds`).

Measured `ulw.md` figures for this round: file 11175 bytes, body after stripping frontmatter **11018**
(`stripFrontmatter` also eats one leading newline, so the 11019 recorded earlier was off by one),
`additionalContext` 11105, **JSON payload 11372** — 2.16x headroom against the 24576 budget, 2.88x against the engine
default.

**Known gaps**

Unchanged from 1.5.0: five items pending verification in a real environment (V3 / V4 / V8′ / V10 / V11), each with a
fallback path and none of them on the `core` path. One item is left in place deliberately: when `keyword_hook` is off
the hook still starts a node process per message (about 126–132ms) — eliminating that requires disabling the plugin
hook at the project or user configuration layer, not editing the plugin's own `hooks.json`.

---

## 1.5.0 — Installed-environment acceptance: doctor and the full `/ulw` lifecycle run through in a real session (2026-09-01)

Every conclusion before 1.4.0 rested on inference from "code + tests + engine reverse-lookup"; the real environment
had never been run even once. This version installed OMZ into ZCode, restarted the session, ran `/omz-doctor`,
`/omz-status` and one complete `/ulw` lifecycle through inside a real session, and wrote the measured results back
into the design document. There are no new features — the deliverable is **evidence**, plus the items that the
evidence settled or refuted.

**Scope**

- **V12 settled**: inside a real session `/omz-doctor` spawned the 9 agents one by one, and **all 9/9 returned
  `OMZ-PONG`**, not one of them not found; both entries work for spawning — the bare name (`omz-planner` etc.) and
  the `omz:` namespace prefix. Of the six previously pending empirical items this was **the only one blocking the
  core main path**; once settled, DESIGN §10.2 shrank from six lines to five (V12 moved into the §10.1 table of
  measured items).
- **The read-only whitelist gained behavior-level confirmation (B1)**: the measured tool surfaces of the five
  restricted roles (critic/oracle/reviewer/librarian/looker) **all lack Edit**, the three full-tool roles
  (deep/junior/atlas) **have Edit**, and each matches the frontmatter item by item (planner is exactly
  `Bash, Read, Write`, librarian exactly `Bash, Read, WebFetch`). Previously there was only static validation plus
  inference from the engine's parsing chain. Re-verified at the same time: all 9 roles **have no `Agent`** (V5),
  **none has `Grep`/`Glob`** (B20), and **not even the full-tool roles have `WebSearch`** (§17 ruling 2).
- **B16 settled**: all four OMZ skills are **visible on the subagent side and carry the `omz:` prefix** — a
  delegation prompt does not need to inline skill summaries, and the original fallback plan is void.
- **Four new engine/runtime facts**: ① the subagent tool surface **has one extra `RespondToCoordinator` that the
  frontmatter never declared** (injected by the engine, not subject to the whitelist) — "the tool surface = the
  whitelist ∪ the engine's injected surface", and the third layer is beyond our control; ② **the number of visible
  skills varies by role** (junior/atlas **40**, deep/reviewer **34**, the other five **33**); the tiering mechanism
  has not been pinned down, it currently does not affect OMZ, but it is not an engine promise either; ③ **the worker
  side can see the MCP tool group**, and the right to call it can only be constrained by protocol discipline; ④ **the
  sanitization capability gap between B27's two rendering paths has been quantified**: given the same malicious title
  containing a newline plus a vertical bar, the inline block of `/omz-status` renders **one extra line of forged
  task** (**41 lines**, with `T-999` on its own line impersonating a real task), whereas `cell()` in
  `render-status.mjs` flattens it into one line inside a cell (a constant **40 lines**, with the vertical bar replaced
  by `¦`) — "`render-status.mjs` is authoritative" is a measured capability gap, not a disclaimer.
- **The `/ulw` end-to-end smoke test passed (the M1 verification criterion)**: a real Node ESM target project was
  built in the system temp directory and the full lifecycle was run — planner produced a plan → **critic reported 4
  blockers and sent it back** (`.omz/evidence/` did not exist and `tee` does not create parent directories, so the
  transcript silently went nowhere / two tasks in the same wave wrote the same test file in parallel and overwrote
  each other / the criteria were not self-consistent with the granularity of its own tasks / the `# fail 0` criterion
  falls through entirely under the default spec reporter on a TTY) → rev2 → **two rounds of junior execution, and
  failing-first really did go red** → **reviewer returned `needs-fix` in the first round** → after the fixes, the
  re-review returned **`confirmed`**. All of it in a temp directory, with zero pollution of the plugin repository.
- **DESIGN.md v1.4 → v1.5**, adding **§18 "The post-installation smoke acceptance chain"** (a reproducible record:
  building the target, the item-by-item findings of the two review rounds, the memory-replay evidence method, and the
  upgrade of the dual-evidence criterion to "the command string itself is executable verbatim"), and writing the
  conclusions above back into §8/§9/§10/§13/§14/§17.
- **Removed the dashboard preload (pre-release wrap-up)**: deleted `dashboard/preload.mjs`, along with the `preload`
  field in `windowOptions()` in `main.mjs` and the accompanying writes of the `OMZ_DASHBOARD_URL`/`OMZ_DASHBOARD_TOKEN`
  environment variables. Three reasons: ① it is **mutually exclusive** with `sandbox: true` — Electron's official
  documentation states explicitly that "Sandboxed preload scripts can't use ESM imports", a sandboxed preload is
  loaded as an ordinary script (a non-ESM context), and the original file was `.mjs`; it dodged the throw with a
  `typeof require` guard, at the cost that **there is no documented promise whatsoever about whether `contextBridge`
  is reachable under sandbox**, so "whether this protection is in effect" cannot be verified; ② it is **dead code with
  zero references** — neither `renderer/app.js` nor `index.html` references `omzDashboard`/`getBootInfo` even once;
  ③ **deleting it does not reduce the protected surface** — the renderer's page and data all come from the loopback
  HTTP service (`fetch('/api/*')`), the token travels in the address-bar query (`urlOf('/')` appends `?token=` and the
  page reads it from `location.search`), and the main process holds nothing the renderer cannot get. **The I5 security
  list in §13.5 therefore goes from seven protections to six** (the "minimal preload surface" from 1.1.0 was the
  seventh): this is **an unverifiable promise being withdrawn**, **not a protection failing** — the attack surface is
  the same before and after, and all four BrowserWindow hardening items,
  `contextIsolation`/`nodeIntegration:false`/`sandbox`/`webSecurity`, are retained. If data from the main process is
  ever genuinely needed in the future, the only way is `preload.cjs` (loaded as CJS under sandbox) with its exposed
  surface re-registered on the I5 list; for the reasoning and where it lands see "Why the Electron shell does not need
  a preload" in `dashboard/README.md`.
- **`engines.node` raised from `>=22.5.0` to `>=22.13.0`** (source-level evidence): on Node 22.5–22.12 `node:sqlite`
  sits behind the `--experimental-sqlite` flag (without the flag that builtin module is not registered), so importing
  it directly throws `ERR_UNKNOWN_BUILTIN_MODULE` and **the coordinator and the dashboard crash on startup**, leaving
  the user with a half-crippled installation where "only core works"; the history table in the official
  `doc/api/sqlite.md` states "v22.13.0 — SQLite is no longer behind `--experimental-sqlite`". Accompanying changes:
  `MIN_MINOR` in `adapters/zcode/capability.mjs` 5 → 13, `engines.node` in `package.json`, the lower-bound wording in
  `README.md` and `mcp/coordinator/README.md`, and the `cap:node`/`supply:engines` wording and fix suggestions in
  `tools/doctor.mjs` (the `fix` spells out why 22.5–22.12 need the flag). The lower-bound test case in
  `tests/capability.test.mjs` was changed to **read the version from `engines.node` in `package.json` and put it into
  the case name and the failure message** (`MIN_MAJOR`/`MIN_MINOR` are private constants of capability.mjs and are not
  exported; engines is the only authoritative declaration a test can reach), so changing the threshold from now on
  will no longer leave hard-coded old version numbers in the wording. **The decision logic is unchanged**: both doctor
  and the tests go through the constants in `capability.mjs`; this entry only aligns the wording with the constants.
- **Three wrap-up items added after this entry was released** (recorded in this round, so "this version adds no tests"
  above no longer holds):
  1. **9 tests added for the absolute-form whitelist of `checkRequestTarget` → 557 tests / 101 suites at that point**
     (this entry's final total is the 572/102 of the injection-budget item below and of the "Verification" block).
     That gate was
     previously **the only item on the I5 list with an implementation and zero assertions** (searching the whole
     repository hit only `server.mjs` itself, and replacing the function body with `return true` would not have turned a
     single case red). What was added is assertions at two levels: 5 pure-function cases (origin-form always allowed,
     absolute-form matching the local whitelist allowed, an external host and a mismatched port refused, authority-form
     and asterisk-form refused, every non-http scheme refused) + 4 real-socket cases (writing the request line by hand
     with `net.connect`, because the `node:http` client only sends origin-form and cannot construct an absolute-form;
     covering external host→400, local host→200, origin-form→200, ftp scheme→400), asserting also that the 400 happens
     before any static file is read (the response body contains none of `app.js`).
  2. **The license criterion extracted into the shared function `tools/lib/license-gate.mjs`**. Previously
     `tools/doctor.mjs` and `tools/sync-omo-skills.mjs` each wrote their own criterion, two orders of magnitude apart in
     strictness: doctor looked at four things (status/spdx/verified_at/verified_via) while sync only required `status` to
     exist and not begin with `unverified` — so `status: "pending"`/`"TODO"`/even `"x"` passed sync silently, and spdx and
     the evidence trail were not examined at all. Both sides now share `evaluateLicenseEntry()`, so **the judgement is
     from one source while the severity differentiates by the caller's responsibility** (doctor's
     `supply:upstream-license` is a release gate: everything other than `ok` is a FAIL; sync's `loadLock()` is a
     pre-sync notice: `incomplete`/`unverified` are only WARN with exit code still 0, and `missing` — the record absent
     entirely — keeps its original ERROR/exit 1, because a missing lock structure is not the same thing as "the
     verification is unfinished"). To preserve that exit-code contract precisely, the function returns `statusPresent`
     alongside `level`. The split of "who needs an evidence trail" also belongs to the criterion itself
     (`PROOF_EXEMPT_KEYS`, fail-closed: proof is required by default and only an explicitly exempted key is excused —
     `codegraph` is an external MCP dependency rather than a porting source, and its supply-chain evidence is carried by
     `supply:codegraph` and the NOTICE). **The known boundary is stated as before**: all four items present only proves
     "there is a re-checkable evidence trail", not that the values themselves are correct; correctness of the values can
     only be judged by comparing against the upstream LICENSE online, and both doctor and sync are offline checks.
  3. **The I5 guard count is unified**. `dashboard/server.mjs` and `tests/dashboard.test.mjs` keep the **seven**-way
     split that follows the code structure (the port and the token are two independent pieces of logic in the
     implementation), and explicitly note that the difference from DESIGN §13.5 I5's **six**-way split is "different
     partitions of the same set of guards, not drift", and that the original seventh guard, preload, disappearing with
     its component is "a promise being withdrawn" rather than "a guard failing".
- **Documentation bilingualization (this round)**: `DESIGN.md` becomes the English primary file and the new
  `DESIGN.zh-CN.md` is the Chinese counterpart (the Chinese body is preserved verbatim, not back-translated); both
  versions carry a language switcher on the first line, and cross-file links point at the matching language version.
  Three stale numbers were fixed at the same time: the `ulw.md` byte counts in `hooks/README.md` were re-measured as
  **11175** (**11018** for the body after stripping the frontmatter, `additionalContext` **11105**, the JSON payload
  **11372**; the old values 7200/7044/7130/7355 predate `ulw.md` being split into eight steps with step zero added);
  the "injection length cap" section of `hooks/README.md` no longer describes in the present tense a top-level
  `maxOutputBytes` that **was deleted in v1.4**, and now states accurately that the real cap comes from the
  user/internal configuration with a **default of 32768**, so that `MAX_CONTEXT_BYTES = 48KB` (49152) **was not an
  effective line of defence under the default configuration** (a body between 32768 and 49152 passes our own check and
  is then **discarded in its entirety by the engine, silently** — not "truncated into half a JSON document" as this
  entry originally said; the forensics and the fix are in the item below), harmless at that moment only because 11105
  is far below 32768. **This round fixes it, so it is no longer a residual risk to label**; and
  `548 tests / 99 suites` was changed to the then-current **557/101** everywhere it describes the current state in
  `DESIGN.md` (this round takes those places to **572/102**; **the 548/99 in the v1.4 version-history entry was the
  true value at the time and is left alone**).
- **The hook injection budget was guarding the wrong wall (a real defect, fixed)**. The old `MAX_CONTEXT_BYTES = 48KB`
  (49152) sat **above** the engine's default `maxOutputBytes` of **32768**, and what it measured was the byte length of
  the `additionalContext` **string** while the engine measures **the complete JSON payload on stdout** (measured gap:
  267 bytes for `ulw.md`, and the more Chinese text the larger the gap) — the line of defence was misplaced twice over.
  An injected body landing between 32768 and 49152 passed our own check and was then **discarded silently by the
  engine**: `OutputCollector.append()` drops the remaining chunks once `inlineBytes >= maxInlineBytes` (it only sets a
  `truncated` flag that the hook path never reads), and `parseHookStdout()` then runs `try{JSON.parse(r)}catch{return}`
  on half a JSON document → `undefined`. No kill, no non-zero exit code, no error at all; the only symptom is "the hook
  seems to have had no effect". **The fix**: a new `ENGINE_DEFAULT_MAX_OUTPUT_BYTES = 32768` (five identical engine
  defaults, cited in the comment); the decision now runs on `payloadBytes(text) =
  Buffer.byteLength(JSON.stringify({additionalContext}), 'utf8')`; the budget is `MAX_PAYLOAD_BYTES = 24576`
  (32768 − 8192, a 25% margin, because a user or workspace config may lower `maxOutputBytes` and the hook process
  cannot read that value); degradation goes from two levels to **three** (`full` → `headings` → `minimal`) with
  `fitToPayload()` as a hard-trim backstop; and the head-window size comes from a **binary search on the measured
  payload** rather than a linear back-off (which cuts the head window to 0 in one step on escape-dense input).
  `MAX_CONTEXT_BYTES` is kept but **demoted to a derived reference value** (`MAX_PAYLOAD_BYTES - 24` = 24552) that
  **takes part in no decision**. **Tests**: `tests/hooks.test.mjs` +15 cases (68 → **83**, the new suite
  「注入负载预算与降级」), the self-test +3 cases covering full/headings/minimal (27/27 → **30/30**), for a total of
  557/101 → **572/102**. They include the invariants (budget + margin ≤ the engine default; the payload of all three
  modes < the budget), a payload upper-bound assertion for each of the three degradation levels, a `ulw.md` regression
  sentinel (payload < budget with more than 1.5x headroom, so further growth hits the test before it hits the engine),
  and a degradation-latency sentinel on 5MB input (< 1500ms). **Mutation verification**: putting the budget back to
  49152 turns 3 cases red (including `预算(49152) + 余量(8192) 必须 <= 引擎缺省(32768)`); deleting the second
  degradation level turns 3 cases red (including `预算 24 下返回的负载 82865（level=headings）越界`). **Fixed in
  passing**: the `ulw.md` body after stripping the frontmatter is **11018**, not 11019 (`stripFrontmatter` runs one more
  `replace(/^\s+/,'')` after removing the delimiter, which eats one leading newline).

**Verification**

`npm test` **572 tests / 102 suites all green** (1.4.0 was 548/99; the `checkRequestTarget` cases added after this
entry was released are +9, and the injection-budget cases of this round are +15); `node tools/doctor.mjs` **no FAIL**
(the only WARN is that codegraph is not installed on
this machine, and the `graph` profile being off by default is expected); `node tools/validate-frontmatter.mjs .`
passes; `node hooks/keyword-detect.mjs --self-test` **30/30**. On the real session side: all 9 spawn pings of
`/omz-doctor` returned the passphrase and brought back their self-reported tool surface and self-reported list of
visible skills; for `/ulw`, the target project in its final state had `npm test` **8/8/0**, all four SCs done, boulder
`status: done`, and the `.omz/` hygiene scan showed zero BOM, zero backslashes, zero corruption.

**Known gaps**

**5 items** of real-environment acceptance remain undone (1.4.0 had six; the one subtracted is exactly V12): **V3**
(the actual injection behavior of the hook's `additionalContext` — both commands this time went through the slash
path, which does not trigger the hook), **V4** (the resume adapter — the whole smoke run used task-level fresh spawns
and never reached the resume path), **V8′** (the timing of the permission prompt on parallel spawns — all spawns this
time were initiated sequentially, so no parallel scenario was created), **V10** (CodeGraph installation), **V11**
(real-machine rendering of the Electron dashboard and actual CSP blocking). All five are in the trigger enhancement
layer, the optional adapter layer or an optional profile, their fallback forms are already the normal shipping
configuration, and **not one of them can make core unusable**. Another honest boundary: the core main path has only
been run on **one small feature, one path** — the branches of B18's interrupt-and-resume, `/team`'s claim gate,
LIGHT/HEAVY tiering, the EXPAND tail, and the 5-lane review were none of them reached this time.

---

## 1.4.0 — Writing back the design document and wrap-up alignment (2026-09-01)

1.3.0 finished fixing the code; this version does three things: **write what was learned during implementation back
into the design document**, clear the residual divergences between spec and implementation, and **use mutation testing
to verify whether the tests themselves actually go red**. No new features.

**Scope**

- **DESIGN.md v1.3 → v1.4** (1117 → 1482 lines). Added §17 "Architectural rulings made during implementation" with 12
  items, each recorded as "the design-time statement → the fact → the ruling → the affected surface"; added nine bug
  contingency items B22–B30 (all from defects actually hit, not speculation) and four integration risks I7–I10; §10.3
  gained ten code-level pieces of evidence from the second and third rounds of engine symbol-level reverse-lookup;
  §10.2's pending empirical items were reordered (the V8 enumeration and the V9 concurrency stress test were settled
  and moved into §10.1, leaving the six items V3/V4/V8′/V10/V11/V12); the milestone table in §9 gained a "v1.4 actual
  status" column; §8.2 rewrote the facts about the hook trigger layer.
- **Anti-fake-testing (the most valuable part of this round).** An independent acceptance audit did mutation testing —
  copy the whole repository into a temp directory, randomly break the implementation under test, and see whether the
  corresponding test goes red. It found three **tests that cannot fail**: I10's dashboard authentication tiering
  (adding `/api/snapshot` to `PUBLIC_PATHS`, or moving the static shell back behind the token gate so the panel is
  completely unusable, still gave 46/46 pass), B27's sanitization of injected board fields (making `cell()` return the
  raw value, all 139 cases passed), and B28's numeric wave ordering (switching back to lexicographic order went
  unnoticed by anyone). The fixes: `dashboard/server.mjs` now has the request pipeline **use**
  `PUBLIC_PATHS.has(pathname)` for the decision (eliminating the second independent judgment, so changing the constant
  changes the behavior), and the tests gained a same-source assertion plus a real browser sequence against a service
  with a non-empty token; a new `tests/render-status.test.mjs` tests `cell()` and `compareWave()` directly and asserts
  an end-to-end forgery attack. Spot checks turned up three more fake tests of the same kind (`MAX_SSE_STREAMS`,
  `parseEventCursor`, and the pipeline's loopback gate), all filled in as well. Each of the four mutations was
  re-verified to go red.
- **The third round of engine reverse-lookup refuted two premises.** ① The `matcher` in `hooks.json` **takes no part in
  filtering** on `UserPromptSubmit`: `hookRunner.run(t, r={})` uses the second parameter for matching, while
  `runUserPromptSubmitHooks` passes only `{signal}`, and the match function returns true unconditionally when
  matchValues is empty — so "a miss does not even start a node process (saving overhead)" is wrong, and once
  `keyword_hook` is enabled every user message costs roughly 126–132ms (against a bare `node -e 0` baseline of
  85–91ms). ② The `permissionMode` enum has now been extracted directly (`acceptEdits`/`auto`/`bypassPermissions`/
  `default`/`dontAsk`/`plan`), and **no value can remove an individual tool** — so the tightening route "use
  `permissionMode` to turn Bash into a structural constraint" is not viable, and the two-layer model (Edit/Write
  structural + Bash disciplinary) is the **final state**, not a transitional one.
- **New B30 [High]: the main agent cannot obtain the sessionId.** `${ZCODE_SESSION_ID}` is expanded only in the shell
  execution block context of hooks / MCP / commands; it is not in the env of the Bash tool, and the `<env>` block of
  the system prompt only has cwd/git/platform/shell/osVersion — while the protocol requires writing the goal to
  `.omz/goal/<sessionId>.json`. The model will make one up, this round stays self-consistent, the board renders as
  usual, doctor cannot detect it: **another false success with exit code 0** (the B22 family). The fix:
  `commands/ulw.md` gained a "Step zero: session identifier" that takes the real value via an inline execution block
  (and blocks the branch where "the literal `${...}` remains because the engine did not expand it"), and if it cannot
  be obtained, falls back deterministically to `<ISO timestamp>-<short git HEAD hash>`, with **fabrication expressly
  forbidden**; and `active_goal` in `boulder.json` is pinned as the only authoritative pointer for finding the goal
  again across sessions (`session_ids` serves only as an audit clue).
- **The real names of the MCP tools.** The actual name of a plugin MCP tool has the form
  `mcp__plugin_omz_omz-coordinator__omz_team_create`, whereas `commands/team.md` and DESIGN §7.2 use bare names
  throughout — a main agent calling them literally gets tool-not-found (there is a fallback, but it manifests as
  "orchestration is on yet it is always in the degraded tier", which is extremely hard to diagnose). The fix: the
  command gained a step zero requiring the caller to match by suffix against its own tool list and take the real name
  on the spot (no hard-coded long names, so it will not break if the plugin name or the server key changes), and if
  nothing is found, to conclude the profile is not enabled and go to the core fallback.
- **Dead fields cleared out of `hooks.json`.** Evidence shows the engine **never reads** the top-level `enabled` and
  `maxOutputBytes` (`parsePluginHookEvents` takes only `rawHooks.hooks`, and when there are plugin hooks the engine
  forces `enabled: true`); what actually takes effect is the **element-level** `enabled` inside the hooks array. The
  two dead fields were deleted and the trade-off written into `_comment` (verified that the engine ignores unknown
  top-level keys). We deliberately **do not** write an element-level `enabled: false` — that would mean the semantic
  gate `keyword_hook` is never even reached, and a user wanting to enable it would have to edit the plugin file rather
  than the project config.
- **Wrap-up alignment**: `omz-looker`'s tools `[Read]` → `[Read, Bash]` and maxTurns 10 → 15 (with a pure `[Read]` it
  cannot obtain the paths of the images to inspect, so that role was in fact unusable before); the "full tools"
  notation in appendix A changed from `tools: []  # 全工具` to **an explicit requirement to omit that line**
  (`tools: []` is an empty whitelist, the opposite of "omit = inherit all tools", same root cause as B23);
  `coordinator.sqlite` is settled as **one database for many teams** (the split-database drawing in the v1.3 directory
  tree was overturned, and isolation is instead carried by the per-team file area plus the `team_id` foreign key inside
  the database); the nine skeletons in appendix A were aligned field by field with the actual `agents/*.md` files (diff
  reduced to zero); doctor's summary line changed to `9/9 静态校验OK（spawn ping 未执行）` (the old wording could be
  misread as V12 being complete); and the `${pluginDir}`, stale byte counts and switch descriptions in the three module
  READMEs were corrected along with it.
- **§14 confidence recalibrated**: the denominator changed from "can the design be implemented" to "can the code run
  as expected in a real environment", overall 98% (design delivery) → **95% (code delivery)**. The read-only sub-item
  is 70% (the final conclusion of ruling 3), the integration/selection layer 90% (CodeGraph not installed), and the new
  presentation layer 85%; the concurrency sub-item was raised because the V9 stress test passed.

**Verification**

`npm test` **548 tests / 99 suites** all green (1.3.0 was 515/90; this round's anti-fake-testing added 33);
`node tools/doctor.mjs` no FAIL (the only WARN is that codegraph is not installed on this machine);
`node tools/validate-frontmatter.mjs .` passes; `node hooks/keyword-detect.mjs --self-test` 27/27. **Four mutation
verifications**: `/api/snapshot` into `PUBLIC_PATHS` → 10 red; the static shell moved behind the token gate → 3 red
(including an explicit assertion that "the panel would have no styles and no scripts"); `cell()` returning the raw
value → 10 red (including "the column count is blown open by injection, 7 !== 4"); `compareWave` switched to
lexicographic order → 4 red. **The V9 concurrency stress test** (done this round): 8 independent node processes
competing for the 200 tasks of the same graph → 200 claims within 730ms, unique=200, **0 duplicate claims**, 0
`SQLITE_BUSY` retries, `verifyGraphInvariants` 0 violations; on a 40-task graph with `max_parallel=8`, all 52
over-limit attempts returned `reason:'max-parallel'`. Self-check of DESIGN.md cross-references: of the 340 `§`
references, all 41 distinct ones resolve; B1–B30 are contiguous with no missing numbers; I1–I10 are contiguous; and of
the 13 V-number references, 0 lack a definition.

**Known gaps**

Six items of real-environment acceptance are still undone, all requiring a real machine or a real ZCode session: V3
(the hook's `additionalContext` injection behavior), V4 (the resume adapter), V8′ (the permission-prompt behavior on
parallel spawns), V10 (CodeGraph installation), V11 (real-machine rendering of the Electron dashboard and actual CSP
blocking), V12 (the spawn ping of the 9 agents inside a session). Each has a documented fallback path, and not one of
them can make `core` unusable. One more known residue: when `keyword_hook` is not enabled the hook still runs empty
(about 126–132ms per message), and eliminating that entirely requires disabling the plugin hook at the project/user
config layer.

---

## 1.3.0 — Adversarial full audit and fixes; the implementation aligned to DESIGN v1.3 (2026-09-01)

Two independent auditors ran an adversarial audit over the whole repository — one checking **protocol fidelity** (are
the bodies of agents/commands/skills self-consistent with ZCode's real tool surface, and equivalent to the original
OmO protocol), the other checking **code security and concurrency** (the MCP server, dashboard, hook, adapters). Every
defect reported has been fixed, and a regression test was added for each category. This entry is organized by defect
type, and each item spells out "the actual consequence beforehand", because the danger of most of these defects is not
that they raise an error but that they **do not**.

### Security

- **`now` removed from the `inputSchema` of the 13 public MCP tools.** Previously the scheduler's clock was open to
  callers: any worker could call `omz_reclaim_expired({ now: <a future time> })` to have someone else's running task,
  whose lease had not expired, judged expired and stolen (the original owner was cleared, the task went back to `ready`
  and was then claimed by another agent); the same trick could bypass the `retry_at` backoff and the `attempts` retry
  budget. The MCP layer now always passes the server's `nowSec()`; `now` is retained only on the core function
  signatures as a test injection, is accepted from outside only when `OMZ_TEST_TIME=1`, and every acceptance prints one
  WARNING line to stderr.
- **Path traversal via `teamId` and `projectRoot`.** `adapters/zcode/transport.mjs` gained `safeTeamId()` (anything not
  `[A-Za-z0-9_-]` is always replaced with `_`) and the `assertInsideOmz()` assertion (the resolved target must be under
  `<projectRoot>/.omz`); `resolveProjectRoot()` in `hooks/keyword-detect.mjs` never trusts a non-absolute path, falls
  back to `process.cwd()` and records it on stderr. Previously `teamId='../../../evil'` could write the state file
  outside the project, and on the hook side only `sessionId` was sanitized while `projectRoot` was missed.
- **ReDoS in the hook.** Markdown link masking originally used the regex `/\[[^\]\r\n]*\]\([^)\r\n]*\)/`, which
  catastrophically backtracks on degenerate input like `[[[[…](](](…`: a 128KB input measured at **18.4 seconds**, far
  beyond the `timeoutMs: 3000` in `hooks.json` — an engine timeout kills the process outright, and the fail-open
  contract "output `{}` under all circumstances" becomes fail-broken on the spot. Changed to a one-way linear scan in
  `maskMarkdownLinks()`, after which the same input measured **2ms**, worst case O(n). Two more self-protections were
  added: the scan window `MAX_SCAN = 32KB` (the leading 24KB + the trailing 8KB masked as two independent segments, so
  that an unclosed triple backtick in the head window cannot straddle the splice point) and the self-imposed budget
  `SCAN_BUDGET_MS = 1500` (over budget it abandons the analysis immediately and returns `budget-exceeded`; better to
  miss one detection, since the user can still type `/ulw` explicitly, than to be killed and output zero bytes). The
  injected body additionally has a `MAX_CONTEXT_BYTES = 48KB` cap; over the limit it degrades to "the leading original
  text + a list of section headings", preventing the `maxOutputBytes: 65536` hard truncation from cutting out half a
  JSON document. (*v1.5 correction: engine forensics overturned two points in that last sentence — the engine's default
  `maxOutputBytes` is **32768**, not 65536, and going over it is not a hard truncation but **the entire injection being
  discarded silently**; so this 48KB cap sat above the engine's real wall and was not an effective line of defence. The
  design intent recorded here is unchanged; the fix is in the 1.5.0 entry.*)
- **Dashboard authentication tiering.** The static shell (`/`, `/index.html`, `/app.js`, `/app.css`) needs no token;
  the data endpoints (`/api/snapshot`, `/api/events`) must have a token. Previously the static resources were behind
  the token gate too, while the browser carries `?token=` only on that one address-bar request — the `<link>`/`<script>`
  subresource requests carry no credentials at all → 401 → the page has no styles and no scripts → **the panel is
  simply unusable on the default path**. The basis for the tiering is "whether the response contains data": the static
  shell is bytes fixed at compile time and contains no tasks, paths or token. The token-free set is exported as
  `PUBLIC_PATHS`.
- **`/healthz` no longer leaks absolute paths.** It returns only `{ ok, source }`; the reason strings in `degraded[]`
  contain the absolute path of the coordinator db and have been moved to the token-required `/api/snapshot`. A
  `HEALTHZ_TTL_MS = 1000` result cache was also added so that an unauthenticated endpoint does not become a CPU
  amplifier for the full snapshot.
- **An SSE connection cap and a shared poller.** `MAX_SSE_STREAMS = 8`, over the limit `503 + Retry-After: 5`
  (previously `streams` was an unbounded Set and 60 connections would all be accepted); all connections share **one**
  `setInterval` (1500ms) that collects and broadcasts the same snapshot, decoupling CPU cost from the connection count
  (previously each connection ran its own pair of timers doing a full collection). The timer stops as soon as the last
  subscriber disconnects, and timers are always `unref()`ed.
- **eventId localized.** `Last-Event-ID` / `?since=` serve only as the counting start point **for this connection** and
  are no longer written back to the server's global counter — previously passing `Number.MAX_SAFE_INTEGER` would make
  `+1` lose precision and pin **all** clients' frame ids to the same value. The input is validated by
  `parseEventCursor()` (not purely numeric / not a safe integer / `<=0` / `> 2^31-1` are all ignored and it starts from
  0).
- **A shell-metacharacter whitelist in `tools/sync-omo-skills.mjs`.** The `url`/`branch`/`path`/`omz_target` in the
  lock get concatenated into git commands that are printed for a human to copy and run, and previously the url alone in
  a malicious lock could deliver `; rm -rf` into the user's terminal. These fields now go through a character whitelist
  first; violations go into `errors` and `exit 1`, and never reach the printout.

### Data consistency

The core invariant of the DAG is "downstream ready ⟺ all upstreams done". Once it is broken, **the database itself is
still self-consistent** (`deps_remaining=0` and `status=ready`) and the error cannot be inferred from the state after
the fact — so it must be sealed off on the write side, with a separate means of detection kept in reserve.

- **The terminal-state guard + one-time consumption of dependency edges (two layers of duplicate protection, neither
  dispensable).** `taskComplete`/`taskFail` check the task's status immediately after `idemLookup`: already in the
  terminal set (`done`/`failed`/`dead`) → return `duplicate: true` straight away and **do not touch downstream at
  all**. This layer catches repeated calls that carry "no idempotency key" or "a brand-new idempotency key" — the
  idempotency table is entirely blind to both, and previously a repeated complete would decrement the downstream
  `deps_remaining` a second time. The second layer is `task_deps.consumed` (added by migration
  `002-task-deps-consumed.sql`, defaulting to 0): the decrement only processes edges with `consumed = 0` and sets it to
  1 within the same transaction, so even if the first layer is bypassed (historical dirty data, manual SQL) downstream
  is not unblocked twice. 002 also backfills historical data (out-edges of already-`done` upstreams are set to
  `consumed = 1`), so an existing database is immediately self-consistent after the backfill.
- **Three guards on `taskFail`.** ① A terminal task cannot be failed (otherwise an already-done task is revived to
  `ready`, its `result_ref` is cleared, and it can be claimed again and completed again → downstream is unblocked a
  second time); ② an `owner_agent` different from the caller is `NOT_OWNER`, **including the case where `owner_agent`
  is null** — previously "null means no check" amounted to an open channel for any agent to write `last_error` on and
  change the status of someone else's task; ③ only a `running` task may be failed, since failing a `blocked` task would
  change it to `ready`, which is a channel that bypasses dependencies outright.
- **The idempotency key bound to `task_id`.** The idempotency key is now doubly bound to `(op, task_id)`; a key already
  used for another `op` or **another task** → `BAD_ARGS`. Previously, using task 1's key for `task_id=2` made
  `idemLookup` return `{task_id:1, status:'done', unblocked:[2]}` marked `duplicate: true` — on which basis the caller
  believed task 2 was complete, while what it got was **another task's** result.
- **`max_parallel` actually takes effect.** Previously it was only stored and echoed back, and a team with
  `max_parallel=2` could have 5 concurrent `running` tasks. `taskClaim` now counts that team's running tasks **inside
  the same `BEGIN IMMEDIATE` transaction** and, at the limit, returns
  `{ task: null, reason: 'max-parallel', running, max_parallel }`. The counting must be done inside the write
  transaction — "read the count first, then open the transaction" is itself a race, and N concurrent claims would all
  read a below-limit count; the counting scope is the whole team (across all of that team's graphs), because the
  concurrency budget is a team-level resource. Callers branch on `reason`: no reason = no ready task for the moment,
  `max-parallel` = retry later, `team-shutdown` = stop polling.
- **Added `verifyGraphInvariants(db, { graph_id })`** as a DAG invariant detector (an exported function of core, not an
  MCP tool; read-only, usable on a readonly handle, to be called by doctor / reconciliation scripts). It reconciles
  `tasks.deps_remaining` against the real number of unfinished upstreams in `task_deps`, covering 4 classes of
  violation: `deps-remaining-mismatch`, `dispatched-with-open-upstream`, `blocked-with-no-open-upstream`, and
  `edge-consumed-but-upstream-not-done` / `edge-unconsumed-but-upstream-done`.
- **`omz_export_mirror` switched its identifier system to numeric task ids.** The unique constraint on `tasks` is
  `UNIQUE(graph_id, key)` — a key is unique only **within a graph**, and it is entirely legal for one team to submit
  two graphs that reuse the same key, in which case using the key as the join key makes the mirror cross-wire (the
  tasks of the first graph get the title/depends_on of the second). Mirror rows now carry `id` (numeric, unique across
  the whole database, the join primary key) / `key` (for humans) / `graph_id` / `depends_on` (an array of numeric ids) /
  `depends_on_keys`. This is a **deliberate deviation** from the DESIGN §7.3 sample and is recorded in
  `mcp/coordinator/README.md`. On the dashboard side `buildMirrorIndex()` degrades in three tiers: numeric ids present
  → join by id → only string ids and no duplicate keys within this team → join by key → when duplicate keys exist,
  **only for those duplicated keys** degrade to no join and write `degraded[]`. Never guess by key: a wrong join is
  more harmful than a missing field.
- **`reclaimExpired`'s `last_seen` does not go backwards**: when it sets the original owner's `transport_state` to
  `unknown` it writes the moment the reclaim happened, not the already-past `lease_until`.

### Usability (the most insidious class: all of them false successes with exit code 0)

- **`isMain` detection switched to `fileURLToPath`.** It previously used `new URL(import.meta.url).pathname`, which is
  percent-encoded: when the plugin directory contains spaces or non-ASCII characters (extremely common on Windows:
  `C:\Program Files\`, `C:\Users\张三\`) it is never equal to `process.argv[1]`, so `isMain` is permanently false — the
  hook outputs 0 bytes, and `doctor`/`status`/`sync`/`validate` all **silently exit 0 doing nothing**. Exit code 0
  means neither the user nor CI can tell anything is broken. `isMainModule(import.meta.url)` was factored out into
  `tools/lib/is-main.mjs`, and the 5 CLI entry points (doctor / render-status / validate-frontmatter /
  sync-omo-skills / keyword-detect) plus `dashboard/server.mjs` and `dashboard/main.mjs` all switched to it.
- **`validate-frontmatter.mjs` supports dash arrays.** It previously recognized only the inline array
  `tools: [Read, Bash]`, and the perfectly legal YAML `tools:\n  - Read` was silently parsed as `tools` being absent
  (= all tools) — the read-only roles' whitelist silently stopped working while doctor reported OK.
- **`KNOWN_TOOLS` split into `SUBAGENT_TOOLS` and `ENGINE_ONLY_TOOLS`.** `Agent`/`WebSearch`/`Grep`/`Glob` exist in the
  engine but are unavailable on the subagent side (measured in DESIGN §10.1 V5, §13 B20), and writing them into
  frontmatter gets them silently ignored. Now the appearance of a member of `ENGINE_ONLY_TOOLS` raises an error
  explaining why — a silently ignored capability declaration would invalidate the assumption that "read-only roles are
  constrained by the whitelist".
- **`deepNormalizePaths` became field-whitelist driven.** Normalization now applies only to fields registered in
  `PATH_FIELD_NAMES` (array elements inherit the decision from their parent key). Previously the full deep traversal
  would "normalize" non-path strings as well, for instance corrupting `regex \d+` into `regex /d+`.
- **The out-of-bounds semantics of `toPosixRelative`.** In the three cases of crossing volumes (`C:` vs `E:`), the
  device namespace, and a result starting with `..`, it no longer silently returns a relative path (which is a path
  that does not exist on any machine); it now throws according to `onEscape` or returns an explicit marker.
- **Numeric wave ordering and title cleaning in `render-status.mjs`.** Waves were previously sorted lexicographically
  into 1→10→2; titles now have newlines and vertical bars stripped — previously a title containing a newline could
  forge an entire line that looked like a legitimate task.

### Protocol fidelity

- **The Atlas role rewritten.** `omz-atlas` is a subagent and **structurally has no Agent tool** (measured in DESIGN
  §10.1 V5), yet its body previously required it to "dispatch execution agents" — once spawned it was bound to violate
  that. It was changed into a **wave state machine + dispatch-proposal generator + reporter**: it produces a directly
  pasteable 8-element dispatch proposal (TASK / EXPECTED OUTCOME / baseline + failing-first / REQUIRED SKILLS /
  REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT) + a suggested `subagent_type` + a LIGHT/HEAVY annotation, and asks
  the main agent to perform the spawn. It is also made explicit that it **receives no background notifications**
  (notifications go only to the main agent), so its collection-point criterion is solely whether the results file
  exists and is parseable.
- **`ulw-plan` had its structural-constraint explanation filled in.** Prometheus likewise cannot spawn, and three
  places in the file previously ordered it to dispatch Explore/critic.
- **`ulw-execute` had the full text of the 10 Hard rules added.** Previously there was only one copy, in
  `commands/ulw.md`, which a subagent cannot reach — it gets neither the session history nor the expanded content of
  the command. The two copies are now required to be identical word for word, with a sync reminder comment left in the
  file.
- **`ulw-research` had the PDF + DOCX delivery toolchain added** (headless chrome printing + pandoc, including a
  fallback that probes chrome executables one by one on Windows, with the path that hits recorded into the
  observation-manifest).
- **`review-work` had a `references/` citation section added.** The AdversarialVerify JSON contract in
  `verdict-schema.md` was previously unreachable in practice because SKILL.md did not reference it.
- **The read-only roles' "structural guarantee" wording corrected to an honest version.** Bash inside
  `tools: [Read, Bash]` can write files (redirection, `sed -i`, `node -e`), so the body's earlier claim "you physically
  cannot change the code" was an incorrect self-assessment. The wording now is "the tool surface stops Edit/Write, it
  does not stop Bash from writing files, so this one is on you to uphold", with the forbidden commands listed one by
  one; `omz-reviewer`'s `git worktree add/lock/unlock/remove` is the only explicitly exempted command set.
- **Tool-surface corrections.** `omz-librarian` had the unavailable `WebSearch` removed (now `[Read, Bash, WebFetch]`,
  with the body stating explicitly "you have no search-engine tool; when there is no link, report clearly that the main
  agent must provide an entry point, and never fabricate from memory"); `omz-looker` went from having only `Read` to
  `[Read, Bash]` (previously it could not enumerate image paths).
- **The `boulder.json` pointer is written the moment the goal is registered** (step two of `commands/ulw.md`), no
  longer waiting until the wrap-up. Previously, if the session was interrupted before the first wave, cross-session
  resumption had no pointer to consult at all (B18).
- **`commands/ulw.md` split into eight steps** aligned with DESIGN §6 (activation / goal registration / skill inventory
  / determinism assurance / the planning threshold / execution / dual-evidence verification / the review gate and
  commit). An honest statement about the Stop hook was added at the same time: it is an **unimplemented item**
  (`hooks/hooks.json` currently registers only `UserPromptSubmit`), progress is persisted by the main agent actively
  writing `boulder.json` after each wave's collection point, and one **must not rely on** the hook to save progress on
  abnormal termination.

**Verification**

- `npm test` → **515 tests / 90 suites all passing, 0 failures** (`node --test tests/`, about 13.6s). By file:
  coordinator 100, path 82, hooks 68, protocol 48, dashboard 46, transport 37, capability 33, server-mcp 31, cli 30,
  fallback 25, integration 15. (After 1.4.0's anti-fake-testing was filled in, it became 548 / 99.)
- `node tools/doctor.mjs` → no FAIL; `① agents 9/9 OK | ② model OK | ③ gitignore OK | ④ mtime OK | ⑤ BOM OK`, the only
  WARN being that codegraph is unavailable (the `graph` profile is off by default, as expected).
- `node tools/validate-frontmatter.mjs .` → passes (agents/commands/skills).
- `node hooks/keyword-detect.mjs --self-test` → **27/27 passing**, including two cases aimed at this round's fixes:
  "degenerate Markdown link input, 32K, stays within budget (linear scan)" and "the `İ` prefix + `team` index
  alignment".
- `node tools/sync-omo-skills.mjs --check` → the lock fields are complete and all 5 `omz_target`s exist; 3 WARNs
  (commit not pinned / synced_at not recorded / the OmO license `unverified`), all of them the expected state of "a
  real sync has not been performed yet".
- `tests/protocol.test.mjs` contains cross-file contract assertions: the four AdversarialVerify fields and four enums
  are identical word for word in `omz-reviewer.md` and `verdict-schema.md`, the re-review cap of 2 matches in both
  places, the state enums close the loop three ways (the coordinator's 7 states + the file view's `pending`/`corrupt` =
  the `STATES` in `app.js` = the `.pill[data-state]` selectors in `app.css`), `skills/*/references/` has no orphan
  documents, every path declared in `plugin.json` exists, the whole repository is free of BOMs, and every `.json` file
  is parseable.

**Known gaps**

- **The three installed-environment measurements V3 / V4 / V8 of DESIGN §10.2 are not done** (the actual injection
  behavior of the hook's `additionalContext`, the behavior of the resume adapter, the `permissionMode` enum and the
  permission prompt on parallel spawns). Each of the three has a documented fallback path.
- The `graph` profile requires installing `@colbymchenry/codegraph` externally and running `codegraph init` in the
  target project; this repository contains no index for it, and doctor can currently only report "unavailable".
- **The Stop hook (DESIGN §9 M4) is not implemented**, so the constitutional checklist on abnormal termination still
  relies on the main agent's self-discipline.
- The 9/9 spawn ping of `omz-doctor` must be run **inside a session** (the offline doctor can only do file-level
  checks); the agent list is a session-startup snapshot (B19), so the session must be restarted after installation.
- The OmO upstream license is still `unverified` and `commit` is not pinned — under the discipline in
  `upstream/README.md`, merging into `main` is forbidden until verification is backfilled.
- The single-writer pressure on the coordinator's SQLite (DESIGN §13.5 I4) has only unit-level concurrency tests; there
  is no long-duration stress sample.

---

## 1.2.0 — The test suite established (2026-09-01)

**Scope**

- 11 test files (`tests/*.test.mjs`) covering path / fallback / capability / transport / coordinator / server-mcp /
  dashboard / hooks / protocol / cli / integration, all using the built-in `node:test`, with zero test-framework
  dependencies.
- `package.json` completed with `test` plus 10 per-file `test:*` scripts; `tests/index.js` as the aggregate entry
  point.
- `protocol.test.mjs` turns documentation consistency into assertions (the agent count and naming, read-only roles'
  tools containing no Edit/Write, full-tool roles not declaring tools, maxTurns being mandatory, frontmatter having no
  unknown fields, the 8 elements and the 10 Hard rules all present, all 8 categories being in the routing table, the
  functional equivalence of the two status rendering paths, the state enums closing the loop three ways, references
  having no orphans, encoding hygiene, and upstream lock evidence).
- `cli.test.mjs` asserts for each CLI entry point that `isMainModule` still holds under paths containing spaces or
  non-ASCII characters — this test is the gatekeeper for the "silently exit 0" defect of 1.3.0.

**Verification**: `node --test tests/` and `npm test` are equivalent and usable; 354 tests all green when it was
established (1.3.0's audit fixes pushed it to 515, and 1.4.0's anti-fake-testing pushed it to 548).

**Known gaps**: no end-to-end installed-environment test (that needs a real ZCode session); coverage not measured.

---

## 1.1.0 — dashboard: the loopback HTTP/SSE read-only presentation layer (2026-09-01)

**Scope**

- `dashboard/server.mjs` (793 lines), a pure HTTP + SSE service with zero third-party dependencies;
  `dashboard/main.mjs`, the Electron shell (automatically degrading to pure HTTP when Electron is absent);
  `dashboard/preload.mjs`, exposing only `getBootInfo()` through `contextBridge` (**this file was deleted in 1.5.0, see
  "Removed the dashboard preload" in that entry**).
- The `dashboard/renderer/` trio (`index.html` / `app.js` / `app.css`): zero inline scripts or styles; server strings
  go only through `textContent`/`createTextNode`, with ANSI and control characters stripped before rendering, and
  truncation past 2000 characters marked.
- A dual-track data source: it first opens the coordinator SQLite read-only and goes through `core.status()` →
  `source: 'coordinator'`; if the db is missing/corrupt/the query fails, it falls back to the `.omz/` file view of
  `tools/render-status.mjs` → `source: 'files'`, with the reason written to `degraded[]`, and **never a 500**.
- The read-only contract: all endpoints are GET, any other method is always 405; there is no write/submit/retry/
  command-execution endpoint at all — the dashboard cannot enlarge the main agent's privileges (DESIGN §15.3-4).
- Seven security protections (corresponding to §13.5 I5): binding to loopback only (the origin is judged **before**
  token validation, and a non-loopback request gets a straight 403 + `socket.destroy()`), a random port (`port = 0`), a
  random token at every startup (`randomBytes(24)` + `timingSafeEqual`), a CORS whitelist (no `Origin` is let through,
  anything else is 403; the absolute-form host in the request line is validated too), SSE emitting only the structured
  `snapshot`/`heartbeat` events, CSP forbidding inline script, and a minimal preload surface (**the last one was
  withdrawn in 1.5.0 along with the deletion of preload; I5 is now six, see that entry**).
- `transport_state` (the agents table) and `coordinator_state` (tasks.status) are always two separate columns, never
  inferred from each other or merged (I3); when the file view has no transport dimension, `transport_state` is always
  `null`.

**Verification**: the URL (including the token) is printed only to stderr, and stdout stays clean; SIGINT shuts down
gracefully. `node dashboard/server.mjs --project <dir> --port 0` can be started standalone.

**Known gaps**: at the time the static resources were behind the token gate too (browser subresources carry no token →
the panel is unusable by default), `/healthz` returned a `degraded[]` containing absolute paths, SSE had no connection
cap and each connection ran its own full collection, and eventId was written back to the global counter — all four
fixed in 1.3.0.

---

## 0.9.0 — mcp/coordinator: the SQLite-backed DAG scheduling sidecar (2026-09-01)

**Scope**

- `mcp/coordinator/server.mjs` (stdio JSON-RPC) + `core.mjs` (968 lines of pure logic) + `db.mjs` (the migration runner
  and connection management) + `schema.sql` + `migrations/001-init.sql`. Zero third-party dependencies, using only the
  built-in `node:sqlite` (hence `engines.node >= 22.5.0`; startup prints an ExperimentalWarning, which is normal)
  (**raised to `>=22.13.0` in 1.5.0 — on 22.5–22.12 that module sits behind the `--experimental-sqlite` flag, see that
  entry**).
- **13 MCP tools**: `omz_team_create` / `omz_dag_submit` / `omz_task_claim` / `omz_task_heartbeat` /
  `omz_task_complete` / `omz_task_fail` / `omz_mail_send` / `omz_mail_receive` / `omz_mail_ack` / `omz_status` /
  `omz_team_shutdown` / `omz_reclaim_expired` / `omz_export_mirror`.
- Transaction-boundary discipline (DESIGN §7.2 / §13.5 I4): claim uses `BEGIN IMMEDIATE` + a single
  `UPDATE ... RETURNING` (`RETURNING` is not a lock; without IMMEDIATE two writers would read the same ready row);
  **a write transaction is never held while an external agent is executing**, and claim COMMITs as soon as it returns;
  `core.mjs` imports only `node:crypto` and `./db.mjs`, with no fs/spawn/network, so on `SQLITE_BUSY` the whole
  transaction including its callback can safely be replayed.
- `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON` + bounded exponential backoff (base 25ms, at most 5
  attempts, with jitter), throwing `BUSY_TIMEOUT` past the limit; timestamps are uniformly integer unix seconds, on the
  same scale as `unixepoch()`.
- at-least-once semantics + idempotency keys (mandatory for `complete`/`fail`, `send` uses `dedupe_key`, and `ack` is
  naturally idempotent per message); a repeated call returns the first result marked `duplicate: true`.
- Cycles and unknown keys are rejected before anything is written to the database; the mailbox's `seq` is `MAX+1`
  within the transaction, with no holes; the `counts` field set of `status()`/`exportMirror()` is a constant 7 states
  (including `unknown`) and does not drift with the states actually present in the database.
- Migration discipline: `migrations/*.sql` are replayed in lexicographic order by filename, published files are
  **never modified**, and structural changes are append-only; because SQLite's `ALTER TABLE ADD COLUMN` has no
  `IF NOT EXISTS`, the runner supports the file-leading directive `-- @skip-if-column <table>.<column>`.
- `.zcode-plugin/plugin.json` got `mcpServers.omz-coordinator` back (`enabled: false`, the `${ZCODE_PLUGIN_ROOT}`
  variable, with `OMZ_COORDINATOR_DB` pointing at `${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite`) — the path
  only genuinely exists as of now.

**Verification**: a manual smoke test (feeding three lines, `initialize` / `tools/list` / `omz_team_create`, into
stdin) produced three lines of valid JSON on stdout, with `tools/list` returning 13 tools; stdout carries only
JSON-RPC and all logging goes to stderr; a tool-level failure returns a tool result with `isError: true` rather than a
JSON-RPC error, an unknown method `-32601`, and a parse failure `-32700`.

**Known gaps**: at the time `now` was exposed in the inputSchema of the 13 tools, `max_parallel` was stored but unused,
the idempotency key was not bound to a task, `taskFail` did not verify identity when `owner_agent` was null, there was
no terminal-state guard and no one-time consumption of edges, there was no `verifyGraphInvariants`, and `exportMirror`
joined by key — all fixed in 1.3.0 (the `consumed` column was introduced by
`migrations/002-task-deps-consumed.sql`).

---

## 0.6.0 — Upstream source pinning and selective-sync discipline (2026-09-01)

**Scope**

- `upstream/omo-sources.lock.json`: the upstream repository/branch/pinned commit SHA/sync time/the mapping of ported
  paths ↔ OMZ target files/`ignored_paths`/the license record. **It records only provenance and porting status; it does
  not store upstream code** (DESIGN §16.2).
- `tools/sync-omo-skills.mjs`: `--check` (lock field completeness + the existence of `omz_target`, exit 1 on ERROR) /
  `--plan` (prints the list of git commands to be executed by hand) / `--pin <40-digit lowercase hex SHA>` (writes back
  `commit` + `synced_at`, output free of BOM and LF-terminated). **It only prints commands and never executes git** —
  upstream sync must be reviewed by a human.
- `upstream/README.md` records the branch discipline (`main` / `upstream-sync` / `porting/<date>`,
  **`git merge upstream/dev` is forbidden**), the 5-step sync procedure, the 5 host-API paths that are never ported
  (`omo-opencode` / `omo-codex` / `team-core` / `tmux-core` / `model-core`) and the criteria for them, and the license
  and NOTICE requirements.
- The `commit` field never carries a guessed value: when not pinned it is always `null` + a `commit_status`
  explanation — substituting "current latest" for a fixed SHA would destroy the reproducibility of provenance.

**Verification**: `node tools/sync-omo-skills.mjs --check` → the lock fields are complete and all 5 `omz_target`s
exist.

**Known gaps**: the OmO license is `unverified` (not cloned, the LICENSE not read) and `commit`/`synced_at` are both
`null`; under the discipline, merging into `main` is forbidden until verification is backfilled. At the time the lock
fields did not go through a shell-metacharacter whitelist (fixed in 1.3.0).

---

## 0.5.0 — skills references completed (2026-09-01)

**Scope**

- 5 epistemology documents in `skills/ulw-research/references/`: `claim-graph.md` (the claim graph and its gate),
  `intent-diff.md` (intent differencing), `observation-manifest.md` (the observation manifest),
  `verification-economics.md` (the economics of verification), `cause-disappearance.md` (the cause-disappearance
  criterion), plus `worker-prompt.md` as the mandatory dispatch template.
- 2 contract documents in `skills/review-work/references/`: `lane-prompts.md` (the complete dispatch prompts for the 5
  lanes, including the common MUST NOT DO and all the placeholders `{{BATCH_ID}}` `{{GOAL}}` `{{DIFF}}`
  `{{DIFF_STAT}}` `{{FILE_CONTENTS}}` `{{DONECLAIM}}` `{{TEST_TRANSCRIPT}}` `{{SCOPE}}` `{{WORKTREE}}`) and
  `verdict-schema.md` (the JSON schema of a single lane's report, the `exhaustive_check` dimension set, the aggregation
  rules, the four fields and four enums of the AdversarialVerify JSON, the re-review cap of 2 and the delta scope).
- 3 process documents in `skills/ulw-plan/references/`: `intent-clear.md` / `intent-unclear.md` / `full-workflow.md`.
- Every references document must be explicitly referenced by the corresponding SKILL.md — a lane is a leaf agent and
  sees no context beyond its prompt, so an unreferenced contract amounts to one that does not exist.

**Verification**: `protocol.test.mjs` asserts that all references declared by SKILL.md genuinely exist and are
non-empty, and that there are no orphan documents under the references directory that nothing references (a
bidirectional check).

**Known gaps**: `review-work/SKILL.md` had no `## references/` citation section at the time, so the AdversarialVerify
contract in `verdict-schema.md` was in fact unreachable (fixed in 1.3.0).

---

## 0.4.0 — hooks M2 keyword detection (2026-09-01)

**Scope**

- `hooks/keyword-detect.mjs` (581 lines): on `UserPromptSubmit` it scans for `ulw`/`ultrawork`/`team`/`hyperplan`
  (case-insensitive), and on a hit injects the body of `commands/<mode>.md` (frontmatter already stripped) into the
  current turn's context through `additionalContext` — equivalent to the user typing the slash command (DESIGN §8.2,
  reproducing OmO's IntentGate).
- `hooks/hooks.json`: `enabled: false`, `timeoutMs: 3000`, `maxOutputBytes: 65536`, and a matcher regex covering the
  case variants; `.zcode-plugin/plugin.json` got `hooks: "hooks/hooks.json"` back (the path only genuinely exists as of
  now). (*v1.5 correction: the engine's default `maxOutputBytes` is in fact **32768**, and both top-level fields were
  deleted in v1.4 because the engine never reads them — see the 1.5.0 entry.*)
- **Both switches are off by default**: `enabled` in `hooks.json` (the runtime layer, managed by the ZCode client;
  turning it on is global) + `omz.keyword_hook` in the project's `.zcode/config.json` (the semantic layer, at project
  granularity). The two are deliberate — `keyword_hook` is the one that is genuinely reliable (zcode-guide points out
  that any hook contributed by a plugin automatically enables the hook runner, and whether a plugin `hooks.json`'s
  top-level `enabled` is read at all is unproven), and `enabled` is treated as declarative intent. When the semantic
  layer is off, the script returns an empty object immediately, reading no command file and writing no state.
- Three guards against double injection (B5 + the §15.1 false-trigger red line): a prompt that starts with `/` after
  trimming is never injected into; a session-level dedupe marker (`<project root>/.omz/.mode-injected-<sessionId>`,
  with the sessionId already made filename-safe); and a keyword falling inside inline backticks, a triple-backtick
  block, a quoted string, a Markdown link, or a path token containing `/` or `.` does not match, while a match also
  requires that neither side is an ASCII letter, digit, underscore or hyphen (`teamwork`, `myteam`, `multiulw` do not
  match).
- The fail-open contract: any exception in the script still outputs `{}` with exit code 0 and does not block the main
  flow (B15). On failure it falls back to plain slash commands (the V3 fallback plan in §10.2 is exactly "permanent
  M1").
- A `--self-test` self-check mode.

**Verification**: `node hooks/keyword-detect.mjs --self-test` all green (currently 27/27).

**Known gaps**: the V3 installed-environment measurement is not done (the real field names of `session_id`/`cwd` are
not yet listed in the guide on this machine; the script already tolerates aliases such as `sessionId`/`userPrompt`). At
the time the Markdown link masking regex had catastrophic backtracking (128KB → 18.4s, certain to be killed by the 3s
timeout), `projectRoot` was not sanitized, `isMain` used the percent-encoded pathname, and there was no injection
length cap — all fixed in 1.3.0.

---

## 0.3.0 — tools/doctor.mjs offline self-check (2026-09-01)

**Scope**

- `tools/doctor.mjs` (590 lines) with seven classes of check: manifest completeness (do the paths declared in
  `plugin.json` exist), frontmatter validation (reusing `validate-frontmatter.mjs`), the agent count and model
  reconciliation, `.gitignore` containing `.omz/` (B14, **report only, never edit on the user's behalf**, printing an
  executable fix command), mtime vs session start (B19), JSON/BOM encoding hygiene (B4), and capability probing (Node
  version / `node:sqlite` / git / codegraph / coordinator / dashboard / the profile degradation report).
- A `--supply-chain` sub-mode does dependency evidence gathering.
- The conclusion line gives a one-line summary `① agents | ② model | ③ gitignore | ④ mtime | ⑤ BOM`, and gives an
  executable fix instruction for every WARN/FAIL (not a vague error).
- `package.json` got the `doctor` / `doctor:supply-chain` scripts back (`tools/doctor.mjs` only exists as of now).

**Verification**: `node tools/doctor.mjs` outputs "结论：无 FAIL" on this repository, the only WARN being that
codegraph is unavailable (the `graph` profile is off by default, as expected).

**Known gaps**: the 9/9 spawn ping can only be done inside a session (the `/omz-doctor` command version is responsible
for that), and the offline version does file-level checks only; at the time `validate-frontmatter.mjs` did not
recognize dash arrays, so doctor still reported OK when a read-only role's whitelist had stopped working (fixed in
1.3.0).

---

## 0.2.0 — adapters/zcode, the host adaptation layer (2026-09-01)

**Scope**

- `path.mjs` (305 lines, B3/B4 path and encoding hygiene): `stripBom` / `readJsonSafe` / `writeJsonSafe` (no BOM, LF),
  `isWindowsAbsolutePath` / `hasBackslashPath` / `isEscapingPath`, `toPosixRelative`, `classifyPath`,
  `normalizePathValue` / `normalizePathFields` / `deepNormalizePaths` (driven by the `PATH_FIELD_NAMES` whitelist),
  `scanJsonHygiene`.
- `capability.mjs` (256 lines, capability probing): `probeNode` / `probeSqlite` / `probeCommand` / `probeGit` /
  `probeCodegraph` / `probeCoordinator` / `probeDashboard` / `probeAll`. On Windows it looks for the executable by
  trying each suffix in `PATHEXT`.
- `fallback.mjs` (146 lines, profile resolution and the degradation chain): `loadConfig` (the `.zcode/config.json` →
  `.omz/config.json` layering), `resolveProfiles` (checking the capability probe results against the declared
  profiles), `fallbackFor`, `formatDegradeReport`. The four degradation chains correspond to DESIGN §3.3: `graph` →
  Explore + Bash grep/rg, `orchestration` → core wave parallelism + `.omz/runtime/` file state, `dashboard` → the ZCode
  GUI task panel + `/omz-status`, and the M2 hook → slash commands.
- `transport.mjs` (199 lines, the worker state machine and the resume adapter): `createRegistry` / `bindAgent` /
  `markResumeWait` / `markReturned` / `checkTimeouts` / `rebuildPromptContext` / `saveRegistry` / `loadRegistry`. When
  resume is unavailable it follows DESIGN §7.4 with "a task-level fresh spawn + context reconstruction", not depending
  on any undisclosed stable resume API of ZCode (the V4 fallback).
- `index.mjs` as the unified exit point.

**Verification**: each module is pure functions with no fs/network side effects (except the explicit `saveRegistry`/
`loadRegistry`/`scanJsonHygiene`); `doctor` and `dashboard` both reuse the same probe and fallback logic, so there is no
second copy of the decision.

**Known gaps**: at the time `deepNormalizePaths` did a full deep traversal (corrupting `regex \d+` into `regex /d+`),
`toPosixRelative` silently returned a relative path when crossing volumes or going out of bounds, and the `transport`
side had no `teamId` sanitization and no `.omz` boundary assertion — all fixed in 1.3.0.

---

## 0.1.0 — The core profile skeleton (2026-09-01)

**Scope**

- `agents/`, 9 subagent definitions (omz-planner / critic / deep / junior / atlas / oracle / reviewer / librarian /
  looker), reusing the built-in `Explore` rather than defining it again (DESIGN appendix A).
- `commands/`, 5 slash commands (ulw / team / hyperplan / omz-status / omz-doctor, DESIGN appendix B).
- `skills/`, 4 core protocols (ulw-plan / ulw-execute / ulw-research / review-work, DESIGN appendix C), each with a
  description spelling out strict trigger semantics (ordinary Q&A must not activate them).
- `tools/validate-frontmatter.mjs` (the B1/B10 line of defense), `tools/render-status.mjs` (the executable body of
  `/omz-status`, with a 40-line cap and BOM tolerance).

**Manifest convergence (this version's key decision)**

- `.zcode-plugin/plugin.json` once declared `hooks: "hooks/hooks.json"` and
  `mcpServers.omz-coordinator → mcp/coordinator/server.mjs`, but neither path existed — a manifest pointing at empty
  files makes ZCode's plugin loading raise an error or fail silently. 0.1.0 converged to declaring only what had landed:
  `agents`/`commands`/`skills`; hooks came back in 0.4.0 and the coordinator in 0.9.0.
- `package.json` once declared 5 `test:*` scripts and a `doctor` script pointing at a non-existent `tests/` and
  `tools/doctor.mjs`. 0.1.0 converged to `validate` + `status`, with the rest added back milestone by milestone.

**Verification**: `npm run validate` passes (9 agents + 5 commands + 4 skills, all frontmatter compliant);
`node tools/render-status.mjs` prints a "no state" notice rather than an error under an empty `.omz/`.

**Known gaps**: no adapters / hooks / coordinator / dashboard / tests / upstream pinning; doctor existed only as the
in-session command version, with no offline executable; and Atlas's body still assumed at the time that it could spawn
(rewritten in 1.3.0).

