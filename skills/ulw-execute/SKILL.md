---
name: ulw-execute
description: "仅当存在已定稿的 .omz/plans/<slug>.md 且用户/主 agent 要求按计划逐波执行时激活;或用户/主 agent 要求按计划执行但计划不存在(走 No-plan bootstrap 反向调 ulw-plan 补计划)。用于 Atlas 执行会话与 /ulw 执行步骤(当前 commands/ulw.md 第六步)的执行编排;不得空中执行,普通问答与单文件 quick 小改不得激活。"
---

# ulw-execute — 计划执行编排协议

**ORCHESTRATOR — NEVER THE IMPLEMENTER**：执行会话零实现、零产品文件编辑、零亲自 QA。

> 例外仅两类（B21）：① quick 类小改（省流阀，单文件 typo 级）② 无法委派的琐事（如读一个文件确认状态）。除此之外任何产品代码修改必须委派。

## 结构约束（谁能派谁）

- **并行 spawn 只有主 agent 能做**。本协议里所有"派发 / 并行派 N 个 worker / 派 reviewer"的执行主体一律是**主 agent（Atlas 执行会话本身）**。
- **你若是被委派的子代理**（工具面无 `Agent`）：不得再委派——只执行分给你的单个任务，把需要别人做的部分写成明确请求回报主 agent，由主 agent 代派。
- 判断方法：检查自己的工具面有无 `Agent`。没有 = 你是叶节点，本节的派发条款对你只读不执行。

## Boulder schema（v2，OmO 原 5 字段名不变）

`.omz/boulder.json`：

```json
{
  "works": ["<work item id>"],
  "active_plan": ".omz/plans/<slug>.md",
  "session_ids": ["<真实 sessionId；拿不到真实值时本数组为空 []，不塞占位符>"],
  "status": "active | paused | done",
  "worktree_path": "<相对路径或 null>",
  "active_goal": ".omz/goal/<stem>.json（stem 两种形态：真实 sessionId，或回退的 <ISO 时间戳>-<git HEAD 短哈希>，非 git 仓库哈希位为 nogit，如 .omz/goal/2026-09-01T1503-nogit.json）",
  "active_team": "<teamId 或 null>",
  "finished_at": "<ISO-8601 字符串；未完成时 null>"
}
```

- OmO v2 原 schema 的 5 个字段（`works` / `active_plan` / `session_ids` / `status` / `worktree_path`）**字段名一字不改**。
- `active_goal` / `active_team` / `finished_at` 是 **OMZ 扩展字段**：`active_goal` 解 B18 的 goal 指针问题，`active_team` 接 coordinator，`finished_at` 承载 `/ulw` 收尾要求的"完成时间"（`status: done` 时必填 ISO-8601，其余状态为 `null`）。
- **`active_goal` 是跨会话找回目标的唯一权威指针**：一律读它的**字面值**去开 goal 文件。文件名可能是真实 sessionId，也可能是 `<ISO 时间戳>-<git HEAD 短哈希>` 回退形态（命名规则见 `commands/ulw.md` 第零步）——**禁止按当前 sessionId 反推文件名**，也禁止拿 `session_ids` 反推（新会话 stem 必然不同，猜必错）。goal 文件里的 `id_source` 字段（`real-session-id` | `fallback-timestamp-githead`）只作命名来源备查，不参与定位。
- **`session_ids` 只是审计线索**，**不参与任何文件定位**；它**可能是空数组 `[]`**（回退命名下就该保持 `[]`，不写 `UNAVAILABLE` 之类占位符），空数组不代表状态异常。
- **子代理（含 Atlas 执行会话）结构性拿不到 sessionId**：会话 id 变量只在 hook / MCP server / 命令执行块上下文展开，Bash 工具的 env 与系统提示词 `<env>` 块里都没有它。因此子代理对 `session_ids` **只读不写**（既不追加也不改动），`active_goal` 一律沿用文件里已有的路径；需要新建 goal 指针时把它**写成派单建议交回主 agent**。**禁止编造 sessionId**（`sess_x`、`unknown`、`current`、时间戳硬编、自编 hash 都不行）——这类占位本轮自洽、看板照常渲染、doctor 也检不出来，却让下一个会话彻底失准，是 B22 同族的假成功。
- 每个波次推进后更新；新会话从 boulder 的 `active_goal` 恢复指针，不按当前 sessionId 猜 goal 文件（B18）。


## LIGHT / HEAVY 分级

默认 **LIGHT**。以下六类事实任一出现即升 **HEAVY**，**绝不反向降级**：

1. 触及历史遗留/无人敢动的代码
2. 跨模块或跨仓库
3. 安全 / 数据迁移 / 性能关键路径
4. 对抗类有命中（见下）
5. 评审门触发词出现（严格/仔细/不能出错）
6. 同一任务此前失败过 ≥1 次

LIGHT：单执行者 + 完成后抽检。HEAVY：执行者 + 独立 omz-reviewer 门（AdversarialVerify）——**reviewer 由主 agent 派发**，与执行者是不同 spawn 实例。

## 派发 8 要素（子代理 prompt 契约）

派发主体 = **主 agent**。CONTEXT 必须自足（子代理全新上下文，看不到本会话历史）——宁冗勿省。`MUST DO` / `MUST NOT DO` 的条目是**固定基线**，每次派发逐条填实，不得整段省略成 `[...]`（密度参照 `review-work/references/lane-prompts.md`）。占位符：`{{TASK_ID}}` `{{PLAN_PATH}}` `{{WAVE}}` `{{FILES}}` `{{BASELINE_CMD}}`。

```
TASK: <一句话任务>（来自 {{PLAN_PATH}} 的 {{WAVE}} 第 N 行，taskId={{TASK_ID}}）
EXPECTED OUTCOME: <完成态的可观察描述> + 返回 DoneClaim JSON（见本 skill Sisyphus 契约）
BASELINE: 基线表征测试现状 + failing-first 证明——先跑 {{BASELINE_CMD}} 留下"问题存在"的失败转录；无法建立基线时明说原因，不得跳过。
REQUIRED SKILLS: <点名 skill；无则写"无"，不留空>
REQUIRED TOOLS: <Bash 级命令清单，逐条给出实际命令形态>
MUST DO:
  1. 双证据：① 测试输出（测试 ID + 断言消息，双态：改前失败/改后通过）② 真实工件（命令转录 / curl 状态码+body / 文件产物路径 / 截图）。
  2. Manual-QA 通道：<无法自动化的部分逐步写清人工步骤（起什么服务、点哪里、看到什么算过）+ 你实际执行的证据；完全无 manual 面时写 "manual_qa: 不适用 — <理由>"，不得留空字符串>。
  3. 对抗类覆盖表：9 类逐项标注「探（证据）」或「排除（理由）」，一类不漏——
     malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions
  4. 清理收据：端口、临时目录、后台进程逐项列出并实际清理，写进 DoneClaim 的 `cleanup.receipt`（含验证命令原文，如 `ss -ltnp | grep 3000` 无输出）。
  5. 工件路径与结果落盘：全文写 `.omz/runtime/<team>/results/{{TASK_ID}}.json`，路径一律**正斜杠相对路径**（B3）、UTF-8 无 BOM（B4）；返回正文 ≤20 行。
  6. 命令转录要求：每条命令逐字留档（含 cwd + 退出码 + 关键输出行），禁止 `<同上>`、省略号截断、事后凭记忆补写。
  7. 只改 <明确的文件/目录白名单>；越界的必要改动先停下回报，不自行扩范围。
MUST NOT DO:
  1. 不得再委派——你的工具面没有 `Agent`；需要别人做的部分写成请求回报主 agent。
  2. 不得删除或重写授权白名单之外的文件；不得 `git reset --hard` / `git clean -f` / force push / 改 git config。
  3. 不得以 "tests pass" 单独作为证据（双证据缺一不算完成）；不得把"实现了功能"当作"验收通过"。
  4. 不得写 BOM 或反斜杠路径进 `.omz/`；不得用 PowerShell 写 `.omz/`（B4）。
  5. 不得 dry-run 冒充验证——验证必须真跑命令。
  6. 不得跳过任一对抗类而不给排除理由；不得只跑 happy path。
  7. 不得在返回或日志里回显 secret 值（按 key 名引用）。
CONTEXT: <自足：{{PLAN_PATH}} 相关段落原文 + {{FILES}} 关键文件路径与内容摘录 + 已确认事实 + 历史决策 + 上游任务的 results 路径>
```

## Sisyphus 完成契约（JSON schema 原样保留）

执行者返回 **DoneClaim**：

```json
{
  "task": "...",
  "changed_files": ["相对路径，正斜杠"],
  "tests": [{ "id": "...", "pass_command": "...", "assertion": "...", "evidence": "..." }],
  "manual_qa": { "steps": "...", "evidence": "..." },
  "cleanup": { "ports": [], "tmp": [], "processes": [], "receipt": "..." },
  "risks": ["..."]
}
```

独立 verifier（omz-reviewer，由主 agent 派发）对 DoneClaim 裁决 **AdversarialVerify**（字段与枚举与 `agents/omz-reviewer.md`、`skills/review-work/references/verdict-schema.md` 逐字一致）：

```json
{
  "verdict": "confirmed | false-positive | needs-fix | needs-human-review",
  "evidence": ["file:line 或命令转录"],
  "repro": "复现步骤（needs-fix 时必填）",
  "confidence": "high | medium | low"
}
```

**confirmed 是唯一通过裁决**；needs-fix 原路打回重派；复审上限 2 次。

## watcher 双确认 + 波次推进

- watcher 挂状态不挂时钟：**绝不 poll/sleep 空转**。
- 勾选 checkbox 需要双确认：后台完成通知到达 **且** `.omz/runtime/<team>/results/<taskId>.json` 存在且可解析。
- 波次推进唯一事实源 = results 文件（B8）；推进前 `ls` results 目录最终核对。

## 9 个对抗类（适用必探、排除记理由）

malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions

## ledger.jsonl

`.omz/ulw-execute/ledger.jsonl`，每事件一行：

```json
{ "ts": "ISO-8601", "event": "claim|gate|complete|fail|review|commit", "task": "T-003", "detail": {} }
```

## No-plan bootstrap

无可选计划时（`.omz/plans/` 下没有对应 slug，或 boulder 的 `active_plan` 指向不存在的文件）：把用户原话当已批准意图，**反向先走 ulw-plan 产计划**（由主 agent 派 omz-planner），再回本协议执行。**不得空中执行**——没有计划文件就没有波次、没有 checkbox、没有唯一事实源。

## Hard rules（10 条，违反即违规）

<!-- 本清单须与 commands/ulw.md 的 Hard rules 保持同步（逐字一致）；改一处必须同步改另一处。 -->

1. failing-first 先行：实现前先有证明问题存在的失败证据。
2. no dry-run：验证必须真跑命令，不得"演练即过"。
3. no tests-only：双证据缺一不算完成。
4. 编排者零实现（B21 两类例外已含在第六步，除此之外无例外）。
5. 对抗类必探：9 类（malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions）——适用必探、排除记理由。
6. worktree 纪律：PR/分支工作在任务专属 worktree；主 worktree 只读；评审用 worktree `git worktree lock --reason`，用完 unlock+remove。
7. 状态文件一律正斜杠相对路径（B3）；UTF-8 无 BOM，禁用 PowerShell 写 `.omz/`（B4）。
8. 波次推进以 results 文件为准，通知只作提醒（B8 唯一事实源）。
9. 省流阀是 MUST 不是建议：quick 委派即违规；omz-* 返回正文 ≤20 行、全文写 results。
10. 每个提交点前自查 goal.json 宪法检查清单（B17）；Blocker 未清零禁止提交（B11）。

## worktree 纪律

PR/分支工作在任务专属 worktree 进行；主 worktree 只读；评审 worktree `git worktree lock --reason`，用完 `git worktree unlock` + `git worktree remove`。
