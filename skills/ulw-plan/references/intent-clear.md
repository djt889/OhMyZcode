# intent-clear — CLEAR 路由最小起草模板

适用：目标、约束、验收三者可从请求+上下文推出，无需访谈。

## 必填段

```markdown
# Plan: <一句话标题>
<!-- review_required: false（用户有评审修饰词时改 true） -->

## 目标与边界
- 做什么：<一句>
- 不做什么：<排除项，防范围爬行>

## 已采纳默认值
- <默认决策 1>（依据：证据/行业惯例）
- 无 owner-decision 遗留（如有遗留 → 本计划不得定稿）

## Wave 1
- [ ] 1. <title>
  Recommended task executor category: <category>

## Final verification
- [ ] F1. <可执行、可判失败的终验>
```

## 检查单（起草后自查）

- [ ] 每个任务行的 category 取自 §5.1 八类枚举
- [ ] 测试与实现不在同一波次并行
- [ ] 终验可执行（有具体命令/检查），非"应该没问题"
- [ ] 草稿落盘 `.omz/drafts/<slug>.md`，批准后复制为 `.omz/plans/<slug>.md`
