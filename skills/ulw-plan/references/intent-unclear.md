# intent-unclear — UNCLEAR 访谈问题清单模板

适用：目标/约束/验收任一不可推。

## 访谈前

先探索，**自己动手**：`Bash` 的 `grep -rn` / `rg` / `find` / `git log` + `Read` 取证；graph profile 启用且 `codegraph_explore` 可用时优先。你没有 Agent 工具，**不能派 Explore/librarian**——广度扫描或外部检索的缺口写成 REQUEST-n 进草稿"待主 agent 代派"段（见 SKILL.md 结构约束），并注明哪些问题在拿到结果前无法定稿。**带着证据提问**。

## 提问清单模板

按此顺序组织问题；每一问先过两道过滤器，都过不了才出现在清单里：

```markdown
## 待确认（<n> 问）

### Q1（owner-decision｜证据不足 二选一标注）
- 问：<问题本身>
- 背景证据：<file:line / 搜索结果，证明为什么需要问>
- 候选答案：<A/B/C + 各自代价>（owner-decision 不提供默认推荐，其余给推荐）
- 影响：<答 A 则计划的分支 1；答 B 则分支 2>
```

## 规则

- **owner-decision**（删旧功能 / 改对外 API / 引入付费依赖 / 技术栈选型方向）必问且不给默认推荐。
- 一次访谈 ≤5 问；超出说明计划范围失控，先砍范围。
- 需要第二意见或广度证据才能收敛的问题，不要写成"问用户"——写成 REQUEST-n 交主 agent 代派 Explore/librarian/critic。
- 用户答完即更新草稿 `.omz/drafts/<slug>.md`，把答案落进"已确认决策"段，再交还主 agent 走评审门。
