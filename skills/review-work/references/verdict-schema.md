# verdict-schema — 评审裁决机器契约

lane 报告与汇总裁决的字段级契约。字段名一字不改——主 agent 按此解析，缺字段视为 lane 未完成。

## 1. 单 lane 报告 JSON schema

```json
{
  "batch_id": "<评审批次 id>",
  "lane": "goal | qa | code | security | context",
  "verdict": "PASS | FAIL | INCONCLUSIVE",
  "findings": [
    {
      "level": "blocker | major | minor",
      "file": "src/foo/bar.ts",
      "line": 118,
      "issue": "<问题描述>",
      "fix": "<修复建议>"
    }
  ],
  "evidence": ["file:line", "命令原文 + 退出码 + 关键输出行", "commit SHA"],
  "exhaustive_check": {
    "正确性": "未发现",
    "安全": "<发现：见 findings[0]>",
    "并发": "未发现",
    "资源清理": "未发现",
    "边界条件": "未发现",
    "与声明目标一致性": "未发现"
  },
  "out_of_scope": ["<范围外发现，不影响本 lane verdict>"],
  "inconclusive_reason": "<verdict 为 INCONCLUSIVE 时必填：缺什么证据/什么条件不可建立>"
}
```

约束：

- `findings` 为空数组时，`exhaustive_check` 每个维度必须显式为 `"未发现"`；缺维度 = 报告不完整，按 lane 沉默处理。
- `exhaustive_check` 维度集合：lane 3 用上表六维度；lane 4 用 `注入 / 凭证泄漏 / 权限扩大 / 危险操作面`；lane 1/2/5 可省略该字段，但 `evidence` 不得为空。
- `verdict: "PASS"` 且存在 `level: "blocker"` 的 finding = 非法报告，主 agent 直接判该 lane FAIL。
- `line` 未知时填 `0`，不得省略字段。

## 2. 汇总裁决规则

- 5 lane 全 `PASS` → 总裁决 `PASS`。
- 任一 lane `FAIL` → 总裁决 `FAIL`（不因其它 lane 全过而抵消）。
- **`INCONCLUSIVE` 不算 PASS**：存在 INCONCLUSIVE 且无 FAIL → 总裁决非 PASS，进入"未决项"，必须在报告列出该 lane 的待办。
- lane 沉默/超时 → 重 spawn 一个**范围更小**的 reviewer 补位（缩小 scope，不缩小标准）→ 仍失败 → **安全关闭**，并在报告中点名该 lane 未完成，总裁决不得为 PASS。
- 汇总输出用 SKILL.md 的报告模板（`lane1..lane5` + `总裁决` + `未决项`）；`FAIL` 时每条修复建议映射到一个 category 路由。

## 3. AdversarialVerify JSON（对 DoneClaim 逐条裁决）

字段与 `agents/omz-reviewer.md` 完全一致：

```json
{
  "verdict": "confirmed | false-positive | needs-fix | needs-human-review",
  "evidence": ["file:line 或命令转录"],
  "repro": "复现步骤（needs-fix 时必填）",
  "confidence": "high | medium | low"
}
```

- **`confirmed` 是唯一通过裁决。** `needs-fix` 必附最小复现；`false-positive` 必须说明为何 DoneClaim 成立；证据不足以裁决时给 `needs-human-review`，不得猜。
- 与 lane verdict 的映射（不是同一枚举，禁止混用字面量）：`confirmed` → 该条 DoneClaim 不阻塞；`false-positive` → 不阻塞但需记录；`needs-fix` → lane `FAIL`；`needs-human-review` → lane `INCONCLUSIVE` 且 `inconclusive_reason` 填缺失证据。

## 4. 复审规则

- **上限 2 次**。第 2 次复审后仍有 blocker → 停止，上报主 agent 交人介入，不得第 3 次。
- 复审 scope **仅限 delta**（上一轮 FAIL 之后的新改动），不复审全盘；delta 用 `git diff <上轮评审 SHA>..HEAD` 界定并写入 `{{SCOPE}}`。
- 复审是**全新 spawn**：新 lane 实例、全新 CONTEXT（含上轮 findings 原文），不复用上一轮会话，也不在 lane 内部 iteration。
- 复审只判 delta 是否修好了指定 findings 与是否引入新问题；上一轮的 PASS lane 不自动继承——delta 触及其覆盖面时该 lane 必须重跑。
