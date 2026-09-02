---
description: "纯规划模式：omz-planner 访谈 → omz-critic 差距分析 → 批准门等待，不执行任何实现"
---

# Hyperplan（纯规划，不执行）

本条命令只走规划，**禁止进入实现阶段**——即使计划获批，也只交付计划工件本身。

流程：

1. 派 `omz-planner`（访谈式规划）。若意图不清，planner 会按两道过滤器提问；它产出 `.omz/drafts/<slug>.md`。
2. 草稿成形后派 `omz-critic` 做差距分析（决策完备性 / 范围完整性 / 依赖矩阵 / 验收可证伪）。blocker/major 清零后生成 `.omz/plans/<slug>.md`。
3. 若用户措辞含"high accuracy / 仔细 / 不能出错"等评审修饰词：加派 `omz-oracle` 第二评审，两份报告都过才算定稿。
4. 批准门：把计划摘要给用户，**等待明确批准**。批准后本命令到此为止——执行请另起 `/ulw` 并引用该计划文件。

省流阀照常生效：如果目标本身就是 quick 类（单文件 typo 级），直接说明"无需规划"，不 spawn 任何子代理。
