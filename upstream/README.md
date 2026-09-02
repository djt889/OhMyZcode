**English** | [简体中文](./README.zh-CN.md)

# upstream/ — OmO upstream provenance and sync discipline

## What this directory is

**It records only provenance and porting status; it does not store upstream code.** (DESIGN §16.2)

- `omo-sources.lock.json` — the upstream repository, branch, pinned commit SHA, sync time, the mapping from ported
  paths ↔ OMZ target files, ignored paths, and the license record.
- This README — the sync discipline and procedure.

All of OMZ's actual running code lives in `agents/`, `commands/`, `skills/`, `mcp/`, `dashboard/`,
`adapters/zcode/`. Upstream text is not copied into this repository; only protocol-level porting and rewriting is
done.

## git remote and branch discipline (§16.3)

```bash
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git
git fetch upstream
```

| Branch | Purpose |
|---|---|
| `main` | OMZ runnable code, the only release line |
| `upstream-sync` | OmO snapshots and comparison records (the diff baseline) |
| `porting/<date-or-version>` | The working branch for one round of protocol porting; merged into `main` after acceptance |

**`git merge upstream/dev` is forbidden.** An OmO version bump never enters production code automatically; it must
go through the filtering path below.

## The sync procedure (5 steps)

1. `git fetch upstream`, and **compare only** the protocol paths locked in `omo-sources.lock.json` (use
   `node tools/sync-omo-skills.mjs --plan` to generate the list of diff commands, executed by hand).
2. Decide for each change whether it is pure prompt protocol or an OpenCode/Codex host API.
3. Port pure protocol changes to the corresponding ZCode SKILL/command; register host changes as "not applicable"
   or rewrite them into `adapters/zcode/`.
4. Update `omo-sources.lock.json` (`--pin <SHA>` writes back commit and synced_at), `CHANGELOG.md`, and the license
   record.
5. Run the protocol, fallback and Windows/MCP regressions; only merge into `main` after they pass.

`tools/sync-omo-skills.mjs` **only prints commands and never executes git** — upstream sync must be reviewed by a
human; this is discipline, not a limitation.

## Upstream paths that are not applicable (host APIs)

The following paths are never ported; they are already registered in `ignored_paths`:

| Upstream path | Reason it is not applicable |
|---|---|
| `packages/omo-opencode` | OpenCode host runtime bindings (`AgentConfig`, `task(category=)`, `primary`) |
| `packages/omo-codex` | Codex host binding (`multi_agent_v1`) |
| `packages/team-core` | ZCode has no public Team API; the equivalent semantics are implemented natively by the OMZ coordinator MCP (SQLite WAL) |
| `packages/tmux-core` | tmux pane interaction cannot be reproduced; Windows Terminal is only a debugging side path |
| `packages/model-core` | Model routing is a host capability; on the ZCode side it is expressed by agent frontmatter |

Criterion: a change that touches any of the paths above → register it as "not applicable" and keep it out of the
`porting/` branch.

## License and NOTICE

**This directory only gathers evidence; it does not make legal judgments.** Everything below is verified fact; the
final judgment on the license boundary belongs to the project owner, and their confirmation is required before
release.

### Upstream OmO: verified as SUL-1.0 (2026-09-01)

- The upstream `LICENSE.md` is the **"Sustainable Use License" Version 1.0** (the fair-source license of the n8n
  family). Verification route: the GitHub License API
  (`/repos/code-yeongyu/oh-my-openagent/license`) + the original text of `LICENSE.md`.
- GitHub metadata marks it as `license: "Other"` / `spdx_id: "NOASSERTION"` — SUL is not on the SPDX standard list.
  The lock file records it as `LicenseRef-SUL-1.0` by convention. **It is not MIT, nor of the GPL family.**
- Three key clauses (the English original fragments are copied verbatim into `license.omo.key_terms` in the lock):
  use/modification is limited to "your own internal business purposes or for non-commercial or personal use";
  distribution must be free of charge and for a non-commercial purpose; the Notices clause requires that "anyone who
  gets a copy of any part of the software from you also gets a copy of these terms", and a modified version must
  carry a prominent notice that it has been modified.
- **The verbatim-overlap evidence** is in `license.omo.overlap_analysis` in the lock: the 4 upstream `SKILL.md`
  files (116,784 bytes, 15,824 8-grams) were compared against all the md files in OMZ's `skills/` + `commands/` +
  `agents/`, and **only 9 8-grams are shared, all of them from the same place** (the JSON enum line
  `"verdict": "confirmed | false-positive | needs-fix | needs-human-review"`). The size comparison points the same
  way: `review-work/SKILL.md` is 3,870 bytes vs 29,316 upstream. That object also records a `coverage_gap` (the 6
  files under `prompts/ultrawork/` and `references/` were not compared) — the coverage gap is written into the
  evidence rather than pretending full coverage.
- What this project does with respect to upstream is **capability benchmarking and a re-implementation of protocol
  semantics**, not text copying. **The boundary between the upstream license and this repository's MIT declaration
  is a legal judgment and lies outside the evidence-gathering scope of this directory.** Neither this README nor the
  lock draws any conclusion of the form "therefore MIT is fine".

### Others

- CodeGraph is MIT and is wired in as an independent MCP dependency (not forked); record the NOTICE at the same time
  the version is pinned.
- Every sync must register the upstream license and the provenance of the NOTICE in the `license` section of
  `omo-sources.lock.json`; while the status is back to `unverified`, merging into `main` is forbidden, and upstream
  text must not be copied verbatim into this repository either.
- The `commit` field must never carry a guessed value: when it is not pinned it is always `null` plus a
  `commit_status` explanation. Substituting "current latest" for a fixed SHA would destroy the reproducibility of
  provenance.
- `ported_paths[].path` must be pinned to a **file**, not a directory: a directory-level pin makes it impossible to
  tell which variant was ported. `prompts/ultrawork/` has already been narrowed from the directory to `glm.md`, and
  the other 5 host variants in the same directory are registered as not ported in that entry's `note`.

## Self-check

```bash
node tools/sync-omo-skills.mjs --check   # lock fields + existence of omz_target; exit 1 on ERROR
node tools/sync-omo-skills.mjs --plan    # print the git commands to be executed by hand
node tools/sync-omo-skills.mjs --pin <40-digit SHA>   # write back commit + synced_at
```
