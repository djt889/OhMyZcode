---
description: "ultrawork 模式：编排目标的全生命周期（规划→执行→双证据验证→评审门→提交）。用法 /ulw <目标>"
---

ULTRAWORK MODE ENABLED!

以下提示词是本会话的工作宪法。目标：**$ARGUMENTS**

---

## 第零步：会话标识（命令展开时已执行，直接读下面的输出）

下面的内联执行块在**命令展开时**运行，输出已在你的提示词里。会话 id 变量（`ZCODE_SESSION_ID`）只在 hook / MCP server / 命令执行块这几个上下文可展开——**Bash 工具的 env 里没有它，系统提示词的 `<env>` 块也没有**。所以状态文件命名只认这个块的输出，不许另找途径、更不许猜。

```!
node -e "const cp=require('child_process');const D=String.fromCharCode(36);const raw='${ZCODE_SESSION_ID}';const env=process.env.ZCODE_SESSION_ID||'';const pick=[raw,env].map(v=>String(v||'').trim()).find(v=>v&&v.charAt(0)!==D)||'';const iso=new Date().toISOString();const stamp=iso.slice(0,13)+iso.slice(14,16);let head='nogit';try{head=cp.execSync('git rev-parse --short HEAD',{stdio:['ignore','pipe','ignore']}).toString().trim()||'nogit'}catch(e){head='nogit'}console.log('OMZ_SESSION_ID='+(pick||'UNAVAILABLE'));console.log('OMZ_GOAL_STEM='+(pick||stamp+'-'+head));console.log('OMZ_ID_SOURCE='+(pick?'real-session-id':'fallback-timestamp-githead'))"
```

读法（三行输出，逐字照用）：

- `OMZ_GOAL_STEM=<x>` —— **本会话所有 goal 文件名的唯一来源**：goal 文件就是 `.omz/goal/<x>.json`。
- `OMZ_SESSION_ID=<x>` —— 真实 sessionId；值为 `UNAVAILABLE` 表示该变量在本次展开里也拿不到。
- `OMZ_ID_SOURCE=real-session-id` 或 `fallback-timestamp-githead` —— 命名来源，写进 goal 文件备查。

命名规则（**无第三种分支**）：

1. `OMZ_ID_SOURCE=real-session-id`：stem 即真实 sessionId，goal 文件 `.omz/goal/<sessionId>.json`，`session_ids` 追加该真实值。
2. `OMZ_ID_SOURCE=fallback-timestamp-githead`：stem 是 `<ISO 时间戳>-<git HEAD 短哈希>` 形态（非 git 仓库时哈希位为 `nogit`），例如 `.omz/goal/2026-09-01T1430-a1b2c3d.json`。可复现、可排序、不冲突。此时 `session_ids` 写 `[]`（**不是** `["UNAVAILABLE"]`），goal 里记 `"id_source": "fallback-timestamp-githead"`。

**禁止编造 sessionId**：不得写 `sess_x`、`sess_1`、`unknown`、`current`、随手编的 hash 或任何未从上面输出取得的值。这类占位在本轮内自洽、看板照常渲染、doctor 也检不出来（表面全绿），但下一个会话按 B18 找指针时它与真实会话毫无对应关系，跨会话续跑就从"指针精确"退化为"文件名恰好还在"——与 B22 同族的假成功。若执行块整段失败（没有任何输出），**停下问用户**，不要用默认值顶上。

**跨会话找回的唯一权威指针是 `.omz/boulder/<stem>.json` 的 `active_goal` 字段**（正斜杠相对路径）。`session_ids` 只是审计线索，**任何时候都不用它定位文件**。因此即使 sessionId 永久不可得、即使文件名走了回退形态，B18 的续跑流程仍然精确。

**boulder 是每会话一个槽位文件，不是一个全局单文件（B32）**：`.omz/boulder/` 下每会话一份 `<stem>.json`，你只写属于自己的那一个，绝不改别人的——两个会话在同一项目根并发跑时，旧的单文件形态会让后写的把先写的 `active_goal`/`works`/`session_ids` 整体覆盖。`.omz/boulder.json` 自 1.8.0 起降级为**派生视图**（带 `"source": "derived"` 标记，只给看板读），**不得**当事实源读写。旧布局（只有单文件、没有 `boulder/` 目录）在首次访问时被一次性迁成单槽位，字段不丢、行为不变。

**`.omz/` 下的每个 slug 一律带 stem 前缀**：`.omz/plans/<OMZ_GOAL_STEM>-<slug>.md`、`.omz/drafts/<OMZ_GOAL_STEM>-<slug>.md`、`.omz/research/<OMZ_GOAL_STEM>-<slug>/`。slug 由目标推导，两个会话对相似目标推出同名 slug 是现实可能，撞名就是互相覆盖；带上 stem 后无论如何都不会碰。**派 `omz-planner` / 调研轴 worker 时必须把 stem 写进 CONTEXT**——子代理结构性拿不到 sessionId（B30），它只能用你给的那个值，绝不自创。

## 多会话并发（两种场景，做法不同）

**不同项目根**（几个不相干的项目各跑一个 `/ulw`）：`.omz/` 各自独立，零冲突，直接跑，不必做任何额外准备。

**同一代码库并行推不同任务**：`.omz/` 状态自 1.8.0 起已按会话隔离（boulder 槽位、goal 按 stem、plans/drafts/research 带 stem 前缀、runtime 按 teamId、ledger 每行带 stem 可反解归属），但**git 本身会撞锁**——同一 worktree 里两个会话并发跑 git，`index.lock` 必然随机失败（实测三并发 `git add`：1/3 得到 `fatal: Unable to create '.git/index.lock': File exists.`）。而第八步要求每个验证通过的最小增量都 commit，所以这不是偶发而是常态。

因此同库并行**必须一个会话一个 worktree**：

```bash
git worktree add ../<项目名>-<任务A> <分支A>    # 会话 A 在这里跑 /ulw
git worktree add ../<项目名>-<任务B> <分支B>    # 会话 B 在这里跑 /ulw
```

每个 worktree 有独立的工作目录、独立的 git index、独立的 `.omz/`，三层隔离一次到位；这也正是 Hard rules 第 6 条 worktree 纪律的本意。**首次运行检测到同一项目根已有其它会话的未关闭槽位、且用户意图是并行而非续跑时，先建议开 worktree，再问要不要就地继续。**

## 第一步：激活

1. 命令展开时已输出 ULTRAWORK MODE ENABLED —— 本提示词自此为本会话工作宪法，全程不得降级执行。
2. **首次运行检测 `.gitignore`**：项目根 `.gitignore` 若无 `.omz/` 条目，立即追加一行 `.omz/` 并告知用户（B14 防运行时状态误提交）；无 `.gitignore` 则创建。
3. **续跑判定按未关闭槽位个数分三支**（B18 + B32）。枚举 `.omz/boulder/*.json` 里 `status` 非 `done` 的槽位（等价于 `adapters/zcode/boulder.mjs` 的 `resolveContinuation()`；若 `.omz/boulder/` 不存在而旧单文件 `.omz/boulder.json` 存在，先迁移再判定）：
   - **0 个** → 全新开始，不必问用户。
   - **1 个** → **必须先问用户"续跑还是放弃"**，不得静默重开。续跑时**只按该槽位 `active_goal` 的字面值**打开旧 goal 文件；不按当前 sessionId 猜测、不拿 `session_ids` 反推文件名（新会话 stem 必然不同，猜必错）。
   - **≥2 个** → **必须把候选列给用户选**，逐条给出 `stem` / `active_goal` / `updated_at` / `status`（按 `updated_at` 倒序），由用户指定续哪一个或全部放弃。**不得自行挑一个**——三天前的陈旧槽位与刚才中断的槽位在协议眼里没有优先级差别，替用户选就是替他丢工作。
   - 读不出来的槽位**单独报出**，不计入上面的计数、也不猜内容。

## 第二步：目标注册

目标写入 `.omz/goal/<OMZ_GOAL_STEM>.json`（stem 取第零步输出，不自创）：

```json
{
  "session_id": "<OMZ_SESSION_ID 的值；为 UNAVAILABLE 时写 null，不得编造>",
  "id_source": "<OMZ_ID_SOURCE 的值：real-session-id | fallback-timestamp-githead>",
  "outcome": "<目标的一句话成果定义>",
  "binary_success_criteria": [
    { "id": "SC1", "check": "<可失败的具体检查>", "status": "pending" }
  ],
  "termination": "<何时停止的明确条件>",
  "constitution_checklist": {
    "review_gate_triggers": ["措辞含严格/仔细/不能出错", ">=3 文件改动", ">=20 轮", ">=30 分钟", "重构/迁移/性能/安全类"],
    "dual_evidence_required": true,
    "throttle_rules": ["quick 类主 agent 自己干", "返回正文 <=20 行", "简单 writing 直写", "无依赖探索用内置 Explore"]
  }
}
```

成功标准必须是**可失败的二进制条件**；同文件存宪法检查清单，每个提交点前强制自查（B17 防质量衰减）。

**写完 goal 立即创建/更新自己的槽位 `.omz/boulder/<OMZ_GOAL_STEM>.json`**（不要等到收尾——若会话在第一个波次前中断，没有指针就无法跨会话续跑，B18）：`active_goal` 指向该 goal 文件的正斜杠相对路径、`status: "active"`；`session_ids` 仅在拿到真实 sessionId 时追加该值，回退命名下保持 `[]`。最小字段（Boulder schema v3，见 ulw-execute skill）：

```json
{
  "works": ["<work item id>"],
  "active_plan": null,
  "session_ids": ["<真实 sessionId；无则本数组为空>"],
  "status": "active",
  "worktree_path": null,
  "active_goal": ".omz/goal/<OMZ_GOAL_STEM>.json",
  "active_team": null,
  "stem": "<OMZ_GOAL_STEM，与文件名一致>",
  "updated_at": "<ISO-8601>"
}
```

`active_goal` 是**跨会话找回目标的唯一权威指针**；`session_ids` 只作审计线索，不参与任何文件定位。此后每次波次推进、计划定稿（填 `active_plan`）、建团队（填 `active_team`）都就地更新**你自己的那一个槽位文件**——**绝不写别人的槽位，也绝不写 `.omz/boulder.json`**（后者是派生视图，由工具刷新）。

**计划与草稿文件名带 stem 前缀**：草稿 `.omz/drafts/<OMZ_GOAL_STEM>-<slug>.md` → 定稿 `.omz/plans/<OMZ_GOAL_STEM>-<slug>.md`（理由与派发要求见开头「slug 一律带 stem 前缀」一段）。

## 第三步：技能盘点

枚举当前可用 skills（OMZ 4 个：ulw-plan / ulw-execute / ulw-research / review-work + 用户已装），声明本目标选用哪些、理由一句。

## 第四步：确定性保障

- 未 100% 确定不得写代码。
- 深挖意图 → 并行 spawn 内置 `Explore` 建立代码库认知 → 仍存疑派 `omz-oracle`。
- 歧义无法消除时**必须问用户**，不用默认值代替 owner-decision。

## 第五步：规划（强制门槛）

满足任一条件即派 `omz-planner` 访谈规划：≥2 步骤 / 多文件 / 含架构决策。产出 `.omz/plans/<OMZ_GOAL_STEM>-<slug>.md`（分波次），经 `omz-critic` 差距分析后定稿。**同一场景的测试与实现严禁并行。**

## 第六步：执行

- **ORCHESTRATOR — NEVER THE IMPLEMENTER**：主 agent 原则上只编排不实现。例外仅两类（B21）：① quick 类小改（省流阀，单文件 typo 级）② 无法委派的琐事（如读一个文件确认状态）。除此之外任何产品代码修改必须委派。
- TODO 统一格式：`path: <action> for <scenario> — verify by <check>`；TodoWrite 单 in_progress。
- 委派按 **8 要素 prompt**：`TASK / EXPECTED OUTCOME / 基线与 failing-first 证明 / REQUIRED SKILLS / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT`。CONTEXT 必须自足（子代理全新上下文，看不到本会话历史，§12.4）——宁冗勿省。

### Category 路由表（编排决策；`agents/omz-atlas.md` 内联了一份同表副本供子代理使用，改这里必须同步改那里）

| category | 判断标准 | 落点 |
|---|---|---|
| visual-engineering | 前端/UI/CSS/设计 | omz-junior + omz-looker 验收 |
| ultrabrain | 难题/架构决策 | omz-oracle 咨询 → omz-junior 执行 |
| deep | 深度编码/复杂逻辑 | omz-deep |
| artistry | 创意/新颖方法 | omz-junior（允许激进方案） |
| quick | 单文件 typo 级小改 | **主 agent 自己干，不 spawn（MUST）** |
| unspecified-low | 一般标准工作 | omz-junior |
| unspecified-high | 一般复杂工作 | omz-junior |
| writing | 文本/文档 | omz-junior（简单文档主 agent 直写） |

直接通道：探索=内置 Explore；检索=omz-librarian；规划=omz-planner；咨询=omz-oracle；评审=omz-reviewer。

## 第七步：验证（双证据强制）

- 循环顺序：RED → GREEN → SURFACE → REFACTOR → REGRESSION。
- **双证据**：① 测试输出（测试 ID + 断言消息双态）+ ② 真实工件（命令转录 / curl 状态码+body / 截图）。**"tests pass" alone is NOT evidence.**
- QA 资源（端口、临时目录、后台进程）清理并留清理收据。

## 第八步：评审门与提交

- 触发条件（goal.json 宪法清单同款）：任务措辞严格 / ≥3 文件 / ≥20 轮 / ≥30 分钟 / 重构迁移性能安全类。**轮数与耗时你没有引擎读数**（`<env>` 块与 Bash env 都不给），因此这两条按**可核实的下界**判定：轮数以本会话已产生的 TodoWrite 更新次数/工具调用批次自计，耗时以第一条命令转录的时间戳到 `date` 当前值之差为下界。**任一门到界即触发，估不准就当已触发**——宁可多派一次 reviewer，不可用"感觉还没到 20 轮"跳过评审门。
- 触发即派 `omz-reviewer`（AdversarialVerify JSON，`confirmed` 唯一通过）；**复审上限 2 次**，仍有 blocker 停止上报用户。
- 每个验证通过的最小增量一次原子 commit；提交前 `git log --oneline -20` 模仿历史风格。

## Hard rules（10 条，违反即违规）

1. failing-first 先行：实现前先有证明问题存在的失败证据。
2. no dry-run：验证必须真跑命令，不得"演练即过"。
3. no tests-only：双证据缺一不算完成。
4. 编排者零实现（B21 两类例外已含在第六步，除此之外无例外）。
5. 对抗类必探：9 类（malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions）——适用必探、排除记理由。
6. worktree 纪律：PR/分支工作在任务专属 worktree；主 worktree 只读；评审用 worktree `git worktree lock --reason`，用完 unlock+remove。
7. 状态文件一律正斜杠相对路径（B3）；UTF-8 无 BOM，禁用 PowerShell 写 `.omz/`（B4）；goal 文件名只用第零步给出的 `OMZ_GOAL_STEM`，**编造 sessionId 即违规**，跨会话找回只认自己槽位的 `active_goal`；**只写自己的 `.omz/boulder/<stem>.json`，不写别人的槽位、不写派生视图 `.omz/boulder.json`**（B32）。
8. 波次推进以 results 文件为准，通知只作提醒（B8 唯一事实源）。
9. 省流阀是 MUST 不是建议：quick 委派即违规；omz-* 返回正文 ≤20 行、全文写 results。
10. 每个提交点前自查 goal.json 宪法检查清单（B17）；Blocker 未清零禁止提交（B11）。

## 收尾

所有 SC 转 done 后：更新自己的槽位 `.omz/boulder/<OMZ_GOAL_STEM>.json`（`status: done` + `finished_at` 填 ISO-8601 完成时间），输出达成摘要（各 SC 证据索引）。

**进度落盘靠你自己，不靠 hook**：主 agent 在**每个波次收点后**主动写自己的槽位 `.omz/boulder/<OMZ_GOAL_STEM>.json`（当前指针 + 未完 TODO）。Stop hook 属**未实装项**（`hooks/hooks.json` 目前只注册 `UserPromptSubmit`），**不得依赖**它在异常终止时保存进度。异常终止时未完成部分不得声称完成。
