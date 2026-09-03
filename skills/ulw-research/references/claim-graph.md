# claim-graph — 断言图谱

## 用途

把调研结论拆成可单独追责的 claim，每条挂上证据与过门状态，杜绝"报告里出现了一句没人能指出来源的话"。不维护它的典型错误：把某个 worker 的推测在综合阶段升格成事实，或同一事实被两波各自表述、互相矛盾却都写进报告。

## 何时更新

**每产生一个 claim 时立即写入**（不攒到波尾）。状态迁移（unverified → gated / refuted）在过门判定或 Phase 3 执行验证完成的那一刻改写。综合阶段只读不写。

## 模板

路径：`.omz/research/<stem>-<slug>/claim-graph.md`

```markdown
# claim-graph — <slug>

## claim 台账

### C-001
- 断言：<一句可判真假的陈述，不含"可能/大概">
- 类型：`code` | `non-code`
- 状态：`unverified` | `gated` | `refuted`
- 回答的意图子问句：I-1（对应 intent-diff.md）
- 证据：
  - [S1] 一手来源：<URL>（访问日期 2026-09-01）｜官方文档/源码/commit
  - [S2] 独立来源域：<URL>（访问日期 ...）
  - [E1] `src/foo/bar.ts:118-134`（读取于 W2）
  - [X1] 执行验证：见 observation-manifest O-014，结论 CONFIRMED
- counter-search：<反证检索的查询原文 + 结果："无反证" 或 反证摘要>
- 过门依据：<命中 §6 的哪一条门槛>
- 依赖 claim：C-000（本 claim 成立以 C-000 成立为前提）
- 冲突 claim：C-009（同一事实的相反表述，未解决前双方均不得 gated）
```

## id 与引用格式规范

- claim id：`C-NNN`，三位零填充，全局单调递增，**不复用、不重编号**；refuted 的 id 保留占位。
- 证据 id：来源 `[S<n>]`、文件 `[E<n>]`、执行验证 `[X<n>]`，编号在单个 claim 内局部递增。
- 文件证据格式固定 `相对路径:起行[-止行]`（正斜杠，相对仓库根，B3）。
- 网络来源格式固定 `<URL>（访问日期 YYYY-MM-DD）`；无访问日期的来源不得计入独立来源域计数。
- 执行验证证据必须指向 `observation-manifest.md` 的观察 id（`O-NNN`），转录留在 manifest，不复制进本文件。
- 报告正文引用形态：`[Source N]` 或 `file:line`（§8），并在附录给出 claim id ↔ Source N 的映射表。

## 判定规则

1. **只有 `gated` 的 claim 能进综合**（SKILL.md §2 硬规则）。`unverified` 只能进附录"未证实线索"，`refuted` 只能进附录"已否证"并保留死因。
2. non-code claim 过门 = 命中 §6 四条门槛之一 **且** counter-search 字段非空且无反证。counter-search 未填 → 状态强制 `unverified`。
3. code claim 过门 = Phase 3 执行验证结论为 `CONFIRMED`。`PARTIAL` 不算 gated——须拆成两个 claim（成立的部分与不成立的部分）后分别定状态。
4. 依赖链传染：依赖的 claim 不是 gated，本 claim 不得 gated（即使自身证据充足）。
5. 冲突未解决即双向阻断：`冲突 claim` 字段非空且未标注解决方式的两条 claim 都不得进综合；解决方式只能是"其一 refuted"或"重述为两个条件不同的 claim"。
6. 收敛前自检：`unverified` 数量 > 0 时，逐条给出"放弃验证"的理由（引用 `verification-economics.md` 的象限判定），无理由不得收敛。
