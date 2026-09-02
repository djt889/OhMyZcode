**English** | [简体中文](./README.zh-CN.md)

# OMZ M2 trigger layer: the UserPromptSubmit keyword hook

`keyword-detect.mjs` scans the prompt when the user submits it for the mode keywords (`ulw`/`ultrawork`/`team`/
`hyperplan`, case-insensitive). On a hit it injects the body of `commands/<mode>.md` (frontmatter already stripped)
into the current turn's context through `additionalContext` — equivalent to typing `/ulw`, `/team` or `/hyperplan`
by hand. Design and evidence chain: `DESIGN.md` §8.2.

**Off by default** (§15.5): installing OMZ must not change ordinary chat behavior; keyword injection is a
"perceptible" behavior and must be enabled explicitly.

## The three switch layers (which one is the real gate)

| Layer | Location | Read by the engine? | Effect |
|---|---|---|---|
| Top-level `enabled` | root object of `hooks/hooks.json` | **not read**, purely decorative | Declarative intent only; changing it changes no runtime behavior |
| Element-level `enabled` | `hooks.UserPromptSubmit[].hooks[].enabled` | **read** (`=== false` discards that entry) | **The only real switch at the runtime layer** |
| `omz.keyword_hook` | the `omz` section of the project's `.zcode/config.json` / `.omz/config.json` | read by the script itself | The real gate at the semantic layer: anything other than `true` returns `{}`, reads no command file and writes no state |

Confirmed on the engine side: plugin hook parsing takes only `rawHooks.hooks` and **never touches the top-level
`enabled` anywhere**; and as soon as any plugin contributes a hook, the engine **forces** the hook runner to
`enabled: true`. Therefore:

- **To enable**: write `{ "omz": { "keyword_hook": true } }` in the project's `.zcode/config.json` (or
  `{ "keyword_hook": true }` in `.omz/config.json`), then restart the session. **You do not need to touch
  `hooks.json`.**
- **To shut it off completely at the runtime layer**: add `"enabled": false` to the **element** inside the hooks
  array, or remove the `hooks` declaration from `.zcode-plugin/plugin.json`. Setting the top-level `enabled` back
  to `false` has no effect.

## The fixed cost once enabled: one node process per message

When the engine calls the UserPromptSubmit hook runner it **passes no matchValue/matchValues**, and the match
function **returns true unconditionally** when matchValues is empty. That is, the case-expanded matcher in
`hooks.json` **plays no part in filtering at all** on this event — as long as the hook is registered, **every**
user message starts one node process.

Measured on this machine (Windows / Node 22, 5 samples): the whole hook takes **126–132ms**, against a bare
`node -e 0` baseline of 85–91ms. It is the same whether or not there is a hit and whether or not `keyword_hook`
is on — the `disabled` short circuit saves the file reads, not the process creation. So the real cost of enabling
`keyword_hook` is **about +120ms and one process creation per message**.

Keeping the matcher is harmless (it still works for tool events and `SessionStart`, and it is a self-documenting
declaration of intent), but **do not claim it saves overhead any more**: the original wording in §8.2, "a miss
does not even start a node process", does not hold on `UserPromptSubmit`.

## Double-injection guards (§13 B5)

- A prompt that starts with `/` after trimming is never injected into (the command system has already expanded
  the protocol).
- Session-level dedupe marker: the same mode is injected only once per session.
- The §15.1 false-trigger red line: a keyword that falls inside inline backticks, a triple-backtick block, a quoted
  string, a Markdown link, or a path token containing `/` or `.` does not match; and neither side may be an ASCII
  letter, digit, underscore or hyphen (`teamwork`, `myteam`, `multiulw` do not match).

## The 3-second timeout budget and three self-protections

`timeoutMs: 3000` means **the engine kills the process**: on timeout it is terminated with zero output, and the
fail-open contract "output `{}` under all circumstances" instantly becomes fail-broken. So the script carries the
load itself:

- **Markdown link masking uses a linear scan.** The original regex catastrophically backtracked on
  `[[[[…](](](…` (128KB measured at 18.4 seconds), and would certainly be killed; it is now a one-way scan in
  `maskMarkdownLinks()`, worst case O(n).
- **`MAX_SCAN = 32KB`** (the leading 24KB + the trailing 8KB, analyzed as two independent segments). Measured
  worst cases: 32KB→8ms, 256KB→177ms, 1MB→2672ms; 32KB leaves roughly a 350x margin against 3 seconds. The two
  segments are masked independently so that an unclosed triple backtick in the head window cannot straddle the
  splice point and swallow the tail window.
- **`SCAN_BUDGET_MS = 1500`**: over budget it returns `{ mode: null, reason: 'budget-exceeded' }` immediately.
  Better to miss a detection (the user can type `/ulw` explicitly) than to be killed.

## The injection length cap

**The engine's real wall: the default `maxOutputBytes` is 32768, and going over it makes the whole injection
disappear silently.**

Evidence (obtained by reading this machine's `E:/APP/Zcode/resources/glm/zcode.cjs`; five sites, all 32768):

| Evidence site | Snippet |
|---|---|
| Default runtime configuration | `hooks:{enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}` |
| Another fallback with the same value | `jdi={enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}` |
| The merge default constant | `AEo=32768` (taken by `L2e()` when no scope specifies one) |
| Plugin hooks merged into the runtime config | `maxOutputBytes:e?.maxOutputBytes??32768` |
| The runtimeRoot of workspace hooks | `maxOutputBytes:Q.hooks?.maxOutputBytes??32768` |

**It is not 65536** — that number came from the dead top-level field in `hooks.json` that the engine never reads
(deleted in v1.4). **And it is not "truncation" either**:

- Plugin / workspace hooks go through the executionPort with
  `outputLimit:{maxBufferBytes:i.maxOutputBytes,maxInlineBytes:i.maxOutputBytes,persistOutput:"none"}`;
  once `inlineBytes >= maxInlineBytes`, `OutputCollector.append()` **discards the remaining chunks** (it only sets a
  `truncated` flag, which the hook path never reads), and `parseHookStdout()` then runs
  `try{JSON.parse(r)}catch{return}` on half a JSON document — **it silently returns undefined and the entire
  injection is dropped without a single error being raised**.
- The other shape, `runGitCommand()`, **kills the process outright**:
  `Buffer.byteLength(i,'utf8')>r.maxOutputBytes&&(o.kill(),l({exitCode:-1,stdout:i}))`. It serves
  `resolveWorkspaceGitBranch` (with its own 512-byte default) and is not on the hook execution path, but it shows the
  engine's general attitude toward exceeding `maxOutputBytes` is **kill/drop, not safe truncation**.

Both paths are fail-broken, so the injected body must land inside the budget **before** it is written to stdout.

**Our budget: `MAX_PAYLOAD_BYTES = 24576` (24KB) = 32768 − `PAYLOAD_SAFETY_MARGIN_BYTES` 8192.**
The margin is not decoration: `maxOutputBytes` can be **lowered** by the user configuration
(`hooks.maxOutputBytes` in `~/.zcode/cli/config.json`) or by a workspace configuration, and the hook process
**cannot obtain that value** (the engine passes it through neither stdin nor env), so it can only be conservative
about the default. 8KB is 25% of the default, which absorbs common tightenings such as "the user lowered it to
24–32KB".

**What is judged is the complete JSON payload on stdout, not the `additionalContext` string.** What the engine
measures is the accumulated stdout byte count, i.e. `JSON.stringify({additionalContext})`. Measured difference:
`additionalContext` 11105 bytes → JSON payload 11372 (+267, of which 24 bytes are the fixed envelope and the rest is
escaping such as `\n`). The more Chinese text, quotes, backslashes and control characters, the larger the gap — so
judging by the string alone is necessarily wrong. The single authoritative gate is
`payloadBytes(text) <= MAX_PAYLOAD_BYTES`, and **every** return path of `buildAdditionalContextDetailed` measures it
before returning.

`MAX_CONTEXT_BYTES` is kept but re-defined: it is now `MAX_PAYLOAD_BYTES − 24` (the envelope overhead) = **24552**,
a **soft** cap on the string side that **takes part in no decision** — the degradation logic always measures the JSON
payload directly. It is kept for two reasons only: the existing export surface (the "injection cap" symbol readers and
docs refer to) does not break, and it gives a rough sense of how long the string may be. It is **derived rather than
hand-written** because JSON escaping (a single `"`, `\` or control character expands 1→6 bytes) means string length has
no fixed relation to payload size, so any hand-written string cap can silently drift above the engine's real wall the
way the old 48KB did (49152 > the engine's 32768). Being derived, it is always
`< MAX_PAYLOAD_BYTES < ENGINE_DEFAULT_MAX_OUTPUT_BYTES`, and that invariant is pinned by a test.

**Two degradation levels (both governed by the payload budget; the head window size is found by binary search on
measured payloads, not estimated from string lengths)**:

| Level | Trigger | Content |
|---|---|---|
| `full` | The whole-text payload is ≤ the budget | The source-comment line + the full command body |
| `headings` | The whole text is over budget, but "head + heading list + notice" fits | The leading original text (the largest byte count that fits, by binary search) + the list of all Markdown section headings + a notice to run `/<mode>` explicitly |
| `minimal` | Even the heading list blows the budget (e.g. several thousand `## ` lines) | The leading original text + one line: "the content is too long, run `/<mode>` explicitly" |

`minimal` additionally ends with a `fitToPayload()` binary-search hard trim, so **there is no return path that has
"degraded but is still over the limit"** — `tests/hooks.test.mjs` asserts this by sweeping eight pathological budgets
(24/32/64/128/512/2048/8192/24576). On degradation one line goes to stderr: the original body byte count, the original
JSON payload, the budget, which level it dropped to, the post-degradation payload, and the engine default. stdout
always stays valid JSON under the strict schema.

**Currently measured (this round actually ran `buildAdditionalContextDetailed`; not copied from older figures)**:

| File | File bytes | Body after stripping frontmatter | `additionalContext` | **JSON payload** | Level | Margin vs budget | Margin vs engine default |
|---|---|---|---|---|---|---|---|
| `ulw.md` | 11175 | 11018 | 11105 | **11372** | `full` | **2.16x** | 2.88x |
| `team.md` | 4442 | 4315 | 4405 | **4475** | `full` | 5.49x | 7.32x |
| `hyperplan.md` | 1067 | 934 | 1039 | **1083** | `full` | 22.69x | 30.26x |

`ulw.md` is the tightest one: it grew from 7200 to 11175 (+55%) when it was split into eight steps and gained step
zero in 1.3.0/1.4.0, and that 2.16x margin will keep being eaten. So `tests/hooks.test.mjs` carries a regression
sentinel asserting its payload is below the budget **and that the margin stays above 1.5x** — further growth of
`ulw.md` hits that test first, not the engine.
(The body is 11018 rather than the 11019 this document used to record: after stripping the delimiters,
`stripFrontmatter` also applies `replace(/^\s+/,'')`, which eats one leading newline.)


## Path and variable-name discipline

- Marker path: `projectRoot` is sanitized by `resolveProjectRoot()` (**a non-absolute path is never trusted**, it
  falls back to `process.cwd()`), then `assertInsideOmz()` asserts the target must be under `<projectRoot>/.omz` —
  the same discipline as in `adapters/zcode/transport.mjs`. Previously only the `sessionId` side was sanitized, and
  `projectRoot='../../../evil'` could write the marker outside the project.
- Template variables are uniformly `${ZCODE_PLUGIN_ROOT}` (consistent with `plugin.json`); **`ZCODE_SKILL_DIR`/
  `CLAUDE_SKILL_DIR` throw in a hook context** and are forbidden. The script reads both `ZCODE_PLUGIN_ROOT` and
  `CLAUDE_PLUGIN_ROOT` (the former takes precedence).
- Entry-point detection uses `isMainModule()` from `tools/lib/is-main.mjs` (internally `fileURLToPath`). Using
  `new URL(url).pathname` is always false under `C:\Program Files\` or `C:\Users\张三\` because of
  percent-encoding, and the hook then silently outputs 0 bytes with exit code 0.

## The session-level marker and installed-environment acceptance

The marker lives at `<project root>/.omz/.mode-injected-<sessionId>` (the sessionId is already made
filename-safe; `.omz/` is already gitignored). After `rm -f .omz/.mode-injected-*` the same session can be
injected into again.

1. `node hooks/keyword-detect.mjs --self-test` → 30/30 pass, exit code 0 (three of them cover the payload budget:
   real `ulw.md` stays at `full`, an oversized command file degrades to `headings`, and thousands of headings degrade
   to `minimal` — each asserting the JSON payload is still inside the budget).
2. `echo '{"prompt":"ulw test","session_id":"sess_x","cwd":"<absolute path of the project>"}' | node hooks/keyword-detect.mjs`
   — with `keyword_hook` off, stdout is exactly `{}` (with one `disabled` line on stderr); with it on, the output is
   `{"additionalContext":"<!-- OMZ keyword hook: ... -->\n\n..."}`. In both cases the exit code is 0.
3. Turn `keyword_hook` on, restart, and in a new session say `ulw 修一个小 bug` without a slash. Criteria: the reply
   contains ultrawork phase vocabulary (goal registration, dual evidence, review gate) and the marker file appears;
   saying it again in the same session adds no new mode.
4. Check the hook's execution record (trigger / duration / result) in the ZCode logs, distinguishing a timeout from
   a failure.

**Fall back to M1**: set `keyword_hook` to `false` (to also save the process overhead, put `enabled: false` in the
hooks element). The trigger layer falls back to pure slash commands with no loss of function (the V3 fallback in
§10.2 is exactly "permanent M1"). Any exception in the script still outputs `{}` with exit code 0 (§13 B15).
