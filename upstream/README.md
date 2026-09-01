# upstream/ — OmO 上游来源与同步纪律

## 这个目录是什么

**只记录来源与移植状态，不存放上游代码。**（DESIGN §16.2）

- `omo-sources.lock.json` — 上游仓库、分支、pin 的 commit SHA、同步时间、已移植路径 ↔ OMZ 目标文件映射、忽略路径、许可证记录。
- 本 README — 同步纪律与流程。

OMZ 的实际运行代码全部在 `agents/`、`commands/`、`skills/`、`mcp/`、`dashboard/`、`adapters/zcode/`。上游文本不复制进本仓库，只做协议层面的移植与改写。

## git remote 与分支纪律（§16.3）

```bash
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git
git fetch upstream
```

| 分支 | 用途 |
|---|---|
| `main` | OMZ 可运行代码，唯一发布线 |
| `upstream-sync` | OmO 快照与对比记录（diff 基线） |
| `porting/<date-or-version>` | 一轮协议移植的工作分支，验收后并入 `main` |

**禁止 `git merge upstream/dev`。** OmO 版本升级不会自动进入生产代码，必须走下面的筛选路径。

## 同步流程（5 步）

1. `git fetch upstream`，**只比较** `omo-sources.lock.json` 里锁定的协议路径（用 `node tools/sync-omo-skills.mjs --plan` 生成 diff 命令清单，人工执行）。
2. 判断每处变更是纯 prompt 协议，还是 OpenCode/Codex 宿主 API。
3. 纯协议变更移植到对应 ZCode SKILL/command；宿主变更登记为"不适用"或改写进 `adapters/zcode/`。
4. 更新 `omo-sources.lock.json`（`--pin <SHA>` 回写 commit 与 synced_at）、`CHANGELOG.md` 与许可证记录。
5. 跑协议、fallback、Windows/MCP 回归；通过后才合并进 `main`。

`tools/sync-omo-skills.mjs` **只打印命令、绝不执行 git**——上游同步必须人工过目，这是纪律不是限制。

## 不适用的上游路径（宿主 API）

以下路径永不移植，`ignored_paths` 已登记：

| 上游路径 | 不适用原因 |
|---|---|
| `packages/omo-opencode` | OpenCode 宿主运行时绑定（`AgentConfig`、`task(category=)`、`primary`） |
| `packages/omo-codex` | Codex 宿主绑定（`multi_agent_v1`） |
| `packages/team-core` | ZCode 无公开 Team API；等价语义由 OMZ coordinator MCP（SQLite WAL）本土实现 |
| `packages/tmux-core` | tmux pane 交互不可复制；Windows Terminal 仅调试旁路 |
| `packages/model-core` | 模型路由属宿主能力，ZCode 侧由 agent frontmatter 表达 |

判据：变更触及上述任一路径 → 登记"不适用"，不进 `porting/` 分支。

## 许可证与 NOTICE

**本目录只做取证，不做法律判断。** 下面全是已核实的事实；许可证边界的最终判断归项目所有者，发布前需其确认。

### 上游 OmO：已核实为 SUL-1.0（2026-09-01）

- 上游 `LICENSE.md` 是 **"Sustainable Use License" Version 1.0**（n8n 系的 fair-source 协议）。核验途径：
  GitHub License API（`/repos/code-yeongyu/oh-my-openagent/license`）+ `LICENSE.md` 原文。
- GitHub 元数据把它标为 `license: "Other"` / `spdx_id: "NOASSERTION"`——SUL 不在 SPDX 标准清单里。
  lock 文件按惯例记为 `LicenseRef-SUL-1.0`。**不是 MIT，也不是 GPL 类。**
- 三条关键条款（英文原文片段照抄在 lock 的 `license.omo.key_terms`）：使用/修改仅限
  "your own internal business purposes or for non-commercial or personal use"；分发必须免费且用于非商业目的；
  Notices 要求"anyone who gets a copy of any part of the software from you also gets a copy of these terms"，
  修改版必须带显著的"已修改"声明。
- **逐字重叠度证据**见 lock 的 `license.omo.overlap_analysis`：上游 4 个 `SKILL.md`（116,784 字节、15,824 个
  8-gram）与 OMZ 的 `skills/` + `commands/` + `agents/` 全部 md 比对，**共享 8-gram 仅 9 个，全部来自同一处**
  （`"verdict": "confirmed | false-positive | needs-fix | needs-human-review"` 这行 JSON 枚举）。体积对比同向：
  `review-work/SKILL.md` 3,870 vs 上游 29,316 字节。该对象另记了 `coverage_gap`（`prompts/ultrawork/` 6 个文件与
  `references/` 未比对）——覆盖缺口写在证据里，不装作已全覆盖。
- 本项目对上游做的是**能力对标与协议语义重实现**，不是文本复制。**上游许可证与本仓库 MIT 声明之间的边界属法律
  判断，超出本目录的取证范围。** 本 README 与 lock 都不给"因此可以 MIT"这类结论。

### 其它

- CodeGraph 为 MIT，作为独立 MCP 依赖接入（不 fork）；锁版本时同步记录 NOTICE。
- 每次同步必须在 `omo-sources.lock.json` 的 `license` 段登记上游许可证与 NOTICE 出处；状态回到 `unverified`
  时禁止合并进 `main`，也不得把上游文本原样复制进本仓库。
- `commit` 字段永不写猜测值：未 pin 一律 `null` + `commit_status` 说明。以"当前 latest"代替固定 SHA 会毁掉来源可复现性。
- `ported_paths[].path` 必须 pin 到**文件**而非目录：目录级 pin 无法判断移植了哪个变体。
  `prompts/ultrawork/` 已从目录收紧到 `glm.md`，同目录另 5 个宿主变体在该项 `note` 里登记为未移植。

## 自检

```bash
node tools/sync-omo-skills.mjs --check   # lock 字段 + omz_target 存在性；ERROR 时 exit 1
node tools/sync-omo-skills.mjs --plan    # 打印待人工执行的 git 命令
node tools/sync-omo-skills.mjs --pin <40位 SHA>   # 回写 commit + synced_at
```
