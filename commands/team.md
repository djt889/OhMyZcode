---
description: "Team Mode：多 worker 并行编排（coordinator MCP 或 core 文件回退）。用法 /team <目标>"
---

# Team Mode 编排指令

目标：**$ARGUMENTS**

同时只允许一个活跃团队（§12.5）。全程遵守"以文件为准"收点原则（B8）：波次推进以状态文件/results 文件为准，后台通知只作提醒。

## 第零步：确认 coordinator 工具真名（首次调用前必做）

coordinator 的 `omz_*` 是**插件 MCP 工具**，不是内置工具。引擎给插件 MCP server 的命名是 `plugin:<pluginName>:<serverKey>`，暴露给模型的工具名带 `mcp__plugin_omz_omz-coordinator__` 前缀（本插件 `pluginName=omz`、`serverKey=omz-coordinator`，见 `.zcode-plugin/plugin.json`）。**下文一律用裸名书写以便阅读，实际调用必须用带前缀的真名**——按字面裸名调用会直接 tool-not-found。

因此在第 2 步之前先做一次可见性确认：

1. 在你自己的工具清单里按**后缀匹配** `omz_team_create` 找到真名（形如 `mcp__plugin_<插件名>_<服务key>__omz_team_create`）。**不要硬编码**那串长名字——插件名或服务 key 变了就又错了；每轮从清单里现取。
2. 找到 → 记下前缀，本轮所有 `omz_*` 调用都拼这个前缀（`<前缀>omz_dag_submit`、`<前缀>omz_task_complete`…）。
3. 找不到 → 说明 orchestration profile 未启用或 MCP server 未连接（`plugin.json` 的 `mcpServers.omz-coordinator.enabled` 默认 `false`）。**不要试探性调用、不要猜名字**：直接走下面「故障回退」的 core 波次并行，并明确告知用户当前处于降级档及原因。

## 七步协议（§3.2 数据流）

1. **读协议**：确认本团队任务是否需要 CodeGraph（graph profile）、DAG 与 mailbox（orchestration profile）。
2. **建团队**：
   - orchestration 启用：调 coordinator MCP `omz_team_create(name, max_parallel, metadata)`（真实名带 `mcp__plugin_omz_omz-coordinator__` 前缀），拿稳定 `team_id`。
   - core 回退：在 `.omz/runtime/<teamId>/` 建 `state.json` 与 `tasks/` 目录（格式见 DESIGN §7.3）。
3. **提交 DAG**：coordinator 用 `omz_dag_submit(team_id, tasks[], deps[])`（真实名带 `mcp__plugin_omz_omz-coordinator__` 前缀）拿 `graph_id`；core 回退按波次把任务 JSON 写入 `tasks/`。
4. **绑定 worker**：对每个 ready 任务，用 Agent 工具 spawn（后台）omz-* 执行者，prompt 按 8 要素；把返回的 `agent_ref` 记入 state.json（`agent_ref ↔ task_id` 映射）。**不能假定 worker 会自主调 MCP**——认领/汇报的语义由你把控；`omz_task_claim` 同样是带前缀的插件 MCP 工具，子代理未必在工具面里看得到它。
5. **收点**：worker 完成 = 后台通知到达 **且** results 文件存在可解析（双确认）。coordinator 侧再调 `omz_task_complete(task_id, agent_ref, result_ref, idempotency_key)`（同前缀规则）；依赖原子递减，新 ready 任务立即绑定新 worker。
6. **状态面板**：随时 `/omz-status` 查看波次×任务×状态；coordinator 侧 `omz_status(team_id)`（同前缀规则）拿 agents/tasks/mailbox/events 汇总。
7. **收尾**：全部终态后 `omz_team_shutdown(team_id)`（同前缀规则）或把 `state.json` 标记 done；清理后台资源并写清理收据。

## resume 适配器（可选，非官方稳定契约，§7.4）

- 基线：任务级 worker（spawn→执行→返回→complete），不依赖 resume。
- 同一运行期内 SendMessage 可用时可追加澄清；所有 resume 关联写入 `resume_ref`。
- resume 超时 10 分钟无响应 → 回退重新 spawn，把原 results 内容并入新 prompt 的 CONTEXT（B9）；等待中的 resume 登记 TodoWrite。
- 禁止承诺常驻内存、跨重启自动恢复、exactly-once。

## 故障回退

coordinator 连接失败/查询报错 → 立即回退 core 波次并行（功能不中断，只是调度语义降级为文件状态）。**工具名按后缀匹配也找不到（tool-not-found 或清单里没有）视同连接失败**，走同一条回退路径——不得反复重试裸名。CodeGraph 不可用 → 回退内置 Explore + Bash grep/rg。两类回退都要求显式告知用户当前处于降级档，并说明具体原因（未启用 / 未连接 / 工具不可见），避免用户看到"orchestration 开了却总在降级档"却无从诊断。
