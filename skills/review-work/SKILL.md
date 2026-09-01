---
name: review-work
description: "当一批工作完成提交前需要独立综合评审,或 omz-reviewer 单点评审不足以覆盖目标/QA/安全/上下文维度时激活。5-lane 并行评审;全 PASS 才 PASS。"
---

# review-work — 5-lane 并行评审协议

把"这批工作能不能算完成"拆成 5 条独立 lane 并行审。**全 lane PASS 才 PASS**；任一 FAIL 即 FAIL；**INCONCLUSIVE 不算 PASS**。

## Phase 0：上下文收集（发起前必做）

主 agent 一次性收集，放进每个 lane 的 prompt（lane 是叶代理，看不到主会话）：

1. 目标原文 + 二进制成功标准（goal.json）
2. 变更清单：`git diff --stat` + 完整 diff（或 worktree 路径）
3. DoneClaim / 测试输出 / 工件路径
4. 评审范围声明：本次评审覆盖的文件/行为面

## 5-lane 配置（一回合并行 spawn 齐发，**主 agent 派发**）

| lane | 角色 | 职责 |
|---|---|---|
| 1 Goal Verifier | omz-oracle | 目标达成度：对照 goal.json 逐条 SC 裁决 |
| 2 QA Executor | omz-junior（或按 category 路由） | 实测：重跑测试/QA 步骤，输出自己的转录，不信转述 |
| 3 Code Reviewer | omz-reviewer | 代码质量：blocker/major/minor 穷举格式 |
| 4 Security | omz-oracle | 注入/凭证泄漏/权限扩大/危险操作面 |
| 5 Context Miner | omz-junior | git 考古：`log/blame/--grep/reverted commits`，找"这段历史上翻过车"的证据 |

lane 3/4 各自穷举输出"未发现 X 类问题"；lane 1/2/5 输出 PASS | FAIL | INCONCLUSIVE + 证据。

## 裁决规则

- lane 是叶代理、**一 verdict 即终审**（lane 内部不 iteration）。
- lane 沉默/超时 → 重 spawn 一个范围更小的 reviewer 补位 → 仍失败 → **安全关闭**并在报告点名该 lane 未完成。
- 复审 = 全新 spawn，scope 仅限 delta（新改动部分），不复审全盘。

## worktree 纪律

评审尽量在独立 worktree：`git worktree add` → 评审期 `git worktree lock --reason="<评审批次>"` → 结束 `git worktree unlock && git worktree remove`。主 worktree 只读。

## 报告模板（汇总给主 agent）

```
# review-work 报告 <批次 id>
lane1 Goal:    PASS|FAIL|INCONCLUSIVE — 一句话证据
lane2 QA:      PASS|FAIL|INCONCLUSIVE — 一句话证据
lane3 Code:    PASS(blocker=0 major=<n> minor=<n>)|FAIL — 摘要
lane4 Sec:     PASS|FAIL|INCONCLUSIVE — 摘要
lane5 Context: PASS|FAIL|INCONCLUSIVE — 摘要
总裁决: PASS|FAIL
未决项: <INCONCLUSIVE lane 的待办>
```

FAIL 时必须附可执行的修复派单建议（每条映射到 category 路由）。

## references/

两份都是机器契约，不是背景阅读——**不读就派/不读就汇总 = 契约必然漂移**：

- `references/lane-prompts.md` — 5 个 lane 的完整派发 prompt（含通用 MUST NOT DO 条款与全部占位符 `{{BATCH_ID}}` `{{GOAL}}` `{{DIFF}}` `{{DIFF_STAT}}` `{{FILE_CONTENTS}}` `{{DONECLAIM}}` `{{TEST_TRANSCRIPT}}` `{{SCOPE}}` `{{WORKTREE}}`）。**派任何 lane 之前必须先读它**，占位符在 Phase 0 逐个填实；lane 是叶代理，prompt 之外的上下文它一概看不到。
- `references/verdict-schema.md` — 裁决的字段级契约。**汇总裁决前必须按它解析**：单 lane 报告 JSON schema、`exhaustive_check` 维度集合、汇总规则（任一 FAIL 即 FAIL / INCONCLUSIVE 不算 PASS）、**AdversarialVerify JSON**（`verdict` / `evidence` / `repro` / `confidence`，`confirmed` 唯一通过）及其与 lane verdict 的映射、复审上限 2 次与 delta scope 规则。缺字段视为 lane 未完成。

两套枚举**禁止混用字面量**：lane verdict 是 `PASS | FAIL | INCONCLUSIVE`，AdversarialVerify 是 `confirmed | false-positive | needs-fix | needs-human-review`（后者与 `agents/omz-reviewer.md`、`skills/ulw-execute/SKILL.md` 三处逐字一致）。
