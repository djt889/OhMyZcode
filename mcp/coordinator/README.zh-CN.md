[English](./README.md) | **简体中文**

# OMZ coordinator（stdio MCP sidecar）

SQLite 支撑的 team registry / DAG 调度 / lease / heartbeat / mailbox / 重试。零第三方依赖，只用内置
`node:sqlite`（**Node >= 22.13**——22.5–22.12 上该模块在 `--experimental-sqlite` flag 之后，直接 import 会
`ERR_UNKNOWN_BUILTIN_MODULE` 崩栈退出；22.13.0 起默认可用，启动打 ExperimentalWarning 属正常）。
**完整设计、逐工具入参与全部不变量见 `DESIGN.md` §7**；本文只写运维者需要当场知道的部分。

## 数据库位置

优先级：`--db <path>` > env `OMZ_COORDINATOR_DB` > `<cwd>/.omz/runtime/coordinator.sqlite`。**单库多 team，不是
一 team 一库**（§3.5 v1.4 修订：`teams` 表本身就是多 team 注册表，分库会切断跨 team 审计查询）；隔离由 per-team
文件区 + 库内 `team_id` 外键承担。需要物理隔离（如压测）时挂载方用 `--db`/env 指向任意路径，server 不假设库位置。
SQLite 是任务/依赖/租约/mailbox 的**唯一事实源**；`omz_export_mirror` 的 JSON 只是镜像与审计导出，不可回写。

> **不带 `--db` 就在 cwd 建库**：在仓库根跑 `npm run coordinator` 会生成 `./.omz/runtime/coordinator.sqlite`。
> `.omz/` 已 gitignore，但仍是意外产物。手工试跑请显式给 `--db`。

## 工具（13 个）与工具名

`omz_team_create` / `omz_dag_submit` / `omz_task_claim` / `omz_task_heartbeat` / `omz_task_complete` /
`omz_task_fail` / `omz_mail_send` / `omz_mail_receive` / `omz_mail_ack` / `omz_status` / `omz_team_shutdown` /
`omz_reclaim_expired` / `omz_export_mirror`。`tools/list` 是唯一权威清单。

上列是 core 侧**裸名**。作为插件挂载时引擎会加命名空间前缀，主 agent 侧实际名形如
`mcp__plugin_omz_omz-coordinator__omz_team_create`——调用方应先列工具再按后缀匹配，不要硬编码裸名。

`verifyGraphInvariants(db, { graph_id })` 是 core 的导出函数（**不是 MCP 工具**），只读、可用 readonly 句柄，供
doctor / 对账脚本调用，返回 `{ ok, violations, checked }`，覆盖 4 类违规（deps 计数不符、上游未 done 却已派发、
该 ready 却卡死、边 consumed 与上游状态不一致）。

## 三条容易被改坏的纪律

1. **`now` 不对外**。它只是 core 签名上的测试注入参数，**不在任何工具的 `inputSchema` 里**，MCP 层一律传服务端
   `nowSec()`。对外即完整攻击面：`omz_reclaim_expired({ now: <未来> })` 能抢走 lease 未过期的任务，也能绕过
   `retry_at` 退避与 `attempts` 预算。只有 `OMZ_TEST_TIME=1` 才接受注入，且每次 stderr 打 WARNING。
2. **下游解锁双层防重**（不变量：下游 ready ⟺ 所有上游 done）。重复递减 `deps_remaining` 破坏它之后**数据库
   自身仍自洽**，事后无法反推，只能写入侧堵死：① 终态守卫——`taskComplete`/`taskFail` 在 `idemLookup` 后即查
   状态，已在终态即返回 `duplicate: true` 且不触碰下游（拦「无幂等键」与「带全新幂等键」的重复调用，幂等表
   对这两种无感）；② `task_deps.consumed`（migration 002）——递减只处理 `consumed = 0` 并同事务置 1。
   `taskFail` 另有三道守卫：终态不可 fail、owner 不匹配即 `NOT_OWNER`（**含 owner 为 null**）、只有 `running`
   可 fail（fail 一个 `blocked` 会把它改成 `ready`，绕过依赖）。
3. **claim 必须 `BEGIN IMMEDIATE`**。`RETURNING` 不是锁，缺了它两个 writer 会读到同一 ready 行。max_parallel 的
   running 计数也必须在这个写事务内做——「先读计数再开事务」本身就是竞态；计数范围是**整个 team**（跨图）。

## 调用方约定

- `taskClaim` 返回 `task: null` 时按 `reason` 分支：无 `reason` = 暂无 ready；`max-parallel` = 名额满、稍后重试；
  `team-shutdown` = 不再发牌，停止轮询。
- **幂等键**与 `(op, task_id)` 双重绑定：键用于其他 `op` 或另一个 task 均 `BAD_ARGS`。否则 `idemLookup` 会把 A 的
  首次结果当作 B 的结果返回。at-least-once 语义见 §13.5 I3。
- **镜像关联键是数字 `id`，不是 key**：唯一约束是 `UNIQUE(graph_id, key)`，key 只在图内唯一，同 team 两图复用
  同名 key 合法。`depends_on` 是数字 id 数组，`key`/`depends_on_keys` 只供人读（对 §7.3 样例的刻意偏离）。
- `transport_state`（agents）与 `coordinator_state`（tasks.status）是独立维度，不得互推或合并显示。
  `status()`/`exportMirror()` 的 `counts` 恒定 7 态（含 `unknown`），不随库中实际状态漂移，可依赖它做 diff。
- 迁移：`migrations/*.sql` 字典序重放，已发布文件**永不修改**，变更只追加且必须能对任意旧库安全重放。
  `ADD COLUMN` 无 `IF NOT EXISTS`，故支持首部 `-- @skip-if-column <table>.<column>`（跳过文件体但仍登记为已
  应用，否则每次 `openDb` 都重试并抛 `MIGRATION_FAILED`）。002 用的就是它。
  **该守卫的粒度是文件级**：命中时整个文件体都不执行，包括其中本来幂等、本来必须跑的语句。因此纪律是
  **带守卫的文件里只放那条 `ADD COLUMN` 与它的直接回填**，索引等天然幂等的语句放进不带守卫的独立文件。
  002 违反了这条（它内含 `CREATE INDEX idx_task_deps_upstream`）：对"列已存在但 002 未登记"的库
  （被人手工 `ALTER TABLE task_deps ADD COLUMN consumed` 过），索引被连坐跳过、且不留任何告警，
  `taskComplete` 的下游递减热路径退化为全表扫描。修复是新增 **003-task-deps-index.sql**（无守卫、两条语句
  天然幂等），不是改 002——已登记的迁移不再重放，改 002 既违纪也无效。

## 在 ZCode 中挂载

```json
{
  "mcpServers": {
    "omz-coordinator": {
      "type": "stdio",
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/mcp/coordinator/server.mjs"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": { "OMZ_COORDINATOR_DB": "${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite" }
    }
  }
}
```

与 `.zcode-plugin/plugin.json` 的实际写法一致。**引擎只展开这十一个变量**：`CLAUDE_CODE_SESSION_ID`、
`CLAUDE_PLUGIN_DATA`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PROJECT_DIR`、`CLAUDE_SESSION_ID`、`CLAUDE_SKILL_DIR`、
`ZCODE_PLUGIN_DATA`、`ZCODE_PLUGIN_ROOT`、`ZCODE_PROJECT_DIR`、`ZCODE_SESSION_ID`、`ZCODE_SKILL_DIR`（插件 MCP
另支持 `${user_config.KEY}`）。写错的变量名**不报错、不置空，只静默留下字面量**，路径必然失效——
`${pluginDir}`/`${workspaceFolder}` 都不是引擎变量（§10.3 第 1 条）。

stdout 只允许 JSON-RPC，日志全走 stderr。工具级失败返回 `isError: true` 的 tool result（不是 JSON-RPC error）；
未知方法 `-32601`，解析失败 `-32700`。

## 手工 smoke

```bash
# 显式给 db 路径，避免在仓库里留库。Git Bash 下别写 /tmp：会被 MSYS 转换成 <当前盘>:\tmp\...
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"omz_team_create","arguments":{"name":"smoke"}}}' \
  | node mcp/coordinator/server.mjs --db "$TEMP/omz-smoke.sqlite"   # cmd 用 %TEMP%\omz-smoke.sqlite
```

预期 stdout 三行合法 JSON，`tools/list` 含 13 个工具。跑完删掉 `omz-smoke.sqlite*`（含 `-wal`/`-shm`）。
