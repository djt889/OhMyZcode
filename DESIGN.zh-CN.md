[English](./DESIGN.md) | **简体中文**

# OMZ (Oh My ZCode) 设计文档

- **版本**：**v1.5（装机验收修订版）** — 插件已装进 ZCode（`plugins.dirs` 指向本目录、`omz@inline` 启用），重启会话后跑完 `/omz-doctor`、`/omz-status`、`/ulw` 三项验收，本版回写真实会话内的实测证据
- **状态**：v1.3 的全部规格已实现（9 个 agent 文件 + 5 commands + 4 skills + hooks + coordinator MCP + dashboard + adapters + tools），578 个测试通过、`/omz-doctor` 无 FAIL、hook self-test 30/30。**v1.5 完成装机后的真实会话验收**：`/omz-doctor` 在会话内逐个 spawn 9 个 agent，**9/9 返回 `OMZ-PONG`**（V12 结清）、只读白名单取得行为级确证、OMZ 四个 skill 在子代理侧可见（**B16 结清**），另得五条引擎/运行时新事实（§10.3 第 11–14 条、§10.1 V6 修订）；`/ulw` 端到端冒烟跑完一个完整生命周期（两轮评审门、双证据、终验 `confirmed`，可复现链路见 §18）。剩余未在真实环境验证项从六项减为**五项**（V3/V4/V8′/V10/V11，§10.2）。
- **日期**：2026-09-01
- **对标项目**：[oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent)（68.5k★，OpenCode/Codex CLI 宿主）
- **目标宿主**：ZCode Desktop 3.10.2+（glm 引擎 `zcode.cjs`）
- **项目性质**：对 OmO 编排能力的完整移植——能力对标，不是代码搬运。
- **为什么做**：让 ZCode 上的项目做得更好。并行吞吐（更快）、角色专业分工（更深）、独立评审与双证据（更可靠）、访谈式规划（更准）四类能力共同服务这个目的，彼此并重，没有谁只是手段。
- **一句话定位**：按 ZCode 的交互模型重新实现 OmO 的编排语义。

---

## 1. 设计原则

1. **为更好的项目服务**：每个设计决策问一句"这让项目产出更好吗"。并行吞吐、角色分工、独立评审与双证据、访谈式规划四者并重；只有既不提速也不提质的机制才降级（花哨可视化最末）。
2. **只用已验证的 ZCode 机制**：子代理 `agents/*.md`、插件五扩展点、内置 Agent 工具（并行 spawn、后台、resume）、TodoWrite、文件系统共享状态。标注「引擎已证实」的项有 zcode.cjs 符号级证据或官方插件实例；「待实测」项列入 §10。
3. **文件即协议**：OmO Ultimate 的 agent 是 TS 模块，ZCode 无对应插件 API；ZCode 子代理有全工具（含文件读写），因此跨 agent 共享状态一律走项目内 `.omz/` 目录的约定文件格式。
4. **主 agent 就是 Sisyphus**：主会话天然常驻，ultrawork 模式提示词（注入主 agent）承担编排角色，不单独定义"主编排 agent"。
5. **贴合 ZCode 而非模仿 OpenCode**：凡 OmO 机制依赖 OpenCode 特有能力（primary 模式、常驻成员、task 的 category 参数），一律改写为 ZCode 等价形态，宁可降级也不造假（差异全表见 §1.5，差距清单见 §11）。
6. **成本意识**：多 agent 编排是 token 放大器（§12.1），设计上处处设省流阀——description 预算、quick 类不 spawn、结果文件化而非全文回传。

## 1.5 ZCode vs OpenCode 环境与交互差异（设计依据）

取证来源：`zcode.cjs` 符号级反查（2026-08-31/09-01）、官方插件 document-skills 实体样本、官方 PLUGIN_DEVELOPMENT.md。

### 1.5.1 运行环境差异

| 维度 | OpenCode（OmO 宿主） | ZCode（本项目宿主） | 对 OMZ 的影响 |
|---|---|---|---|
| 操作系统 | Linux/macOS 为主，tmux 常驻 | Windows（Git Bash 为默认 shell；PowerShell 脚本有 UTF-8 BOM 坑；无 tmux） | hook/状态脚本全部 node 实现避开 shell 差异；展示层采用 Electron dashboard + GUI 任务面板 + `/omz-status`（§3.1、§3.3） |
| 宿主形态 | TUI 终端 + tmux pane 分屏 | Electron GUI，任务面板原生展示后台子代理，Settings → Subagents 图形化管理 agent | 可视化走"GUI 任务面板 + /omz-status 文本看板"双轨 |
| 引擎 | 独立 opencode 进程，配置 `~/.config/opencode/` | glm 引擎（`<ZCode 安装目录>/resources/glm/zcode.cjs`），多引擎管理器之一；模型供应商配 `~/.zcode/v2/config.json` | OMZ 不碰引擎配置；模型分档引用用户已登记的供应商模型（§5.3） |

### 1.5.2 交互模型差异

| 维度 | OpenCode（OmO 宿主） | ZCode（本项目宿主） | 对 OMZ 设计的影响 |
|---|---|---|---|
| **agent 定义** | TS 模块 + 插件 API：`AgentConfig` 含 `mode`/`teammate`/`category`/`prompt_append`/`fallback_models` 等丰富字段 | markdown `agents/*.md`，frontmatter 实测支持字段（judge.md 样本 + 引擎解析链）：`name` / `description` / `tools`（**YAML 数组**，如 `[Read, Bash]`）/ `model` / `thoughtLevel` / `permissionMode` / `maxTurns` / `memory` / `color` / `mcpServers`。加载来源三处：`loadZCodeAgentProfiles` 读 `<storageRoot>/agents`（source=user）与 `<workingDirectory>/.zcode/agents`（source=project），`loadPluginAgentProfiles` 读 `<pluginRoot>/agents/<name>.md`（source=plugin）。**project 来源的 `permissionMode` 被 `sanitizeProjectAgentProfile` 直接删除**（不是"改写/特殊处理"——字段被剥离，agent 回落会话默认权限面） | 字段比预想丰富：maxTurns 做失控护栏、thoughtLevel 做思考分档、permissionMode 控权限面（但项目级 agent 用不上，OMZ 以插件形态分发不受影响）；无 per-agent 运行时覆盖配置 |
| **主会话角色切换** | `AgentMode: "primary"`——用户可直接选某 agent 当主角色（省一层编排与转述） | **无 primary 概念**：主会话固定，子代理只能被 spawn | 深度执行必经主 agent 转述（CONTEXT 冗余协议，§12.4） |
| **委派工具** | `task` 工具：`category` + `subagent_type` 双参数、`load_skills` 显式注入、`task_id` 续接 | `Agent` 工具：仅 `subagent_type` + `prompt` + `description` + `run_in_background` | category 收敛为 /ulw 提示词里的映射表（§5）；skills 靠子代理自动发现（引擎证实子代理上下文含 `skills` + `skillMetadataBudget`） |
| **子代理生命周期** | Team Mode 成员进程级常驻，轮询 mailbox、主动认领、成员间互发消息 | 公开文档确认任务级独立上下文、前后台结果回主对话、禁止子代理再派生；本次工具层可见 SendMessage/agent id，但官方文档未承诺稳定 resume token、取消、进度或 P2P API | 以任务级 worker 为基线；resume 仅作为适配器可选增强，不能作为跨重启保证（§7.4、§13.5 I3） |
| **模型路由** | category→模型+回退链硬编码 | frontmatter `model`（引擎有 `SubagentModelRef` 完整解析链 + Inherited 继承工厂）；**frontmatter `thoughtLevel` 可按 agent 指定思考档**（引擎证实解析）；无回退链 | 单模型直连+失败重派；思考分档靠 frontmatter 而非 spawn 参数（§5.3） |
| **模式触发** | keyword-detector hook（IntentGate） | slash commands 原生（`$ARGUMENTS` + `$1/$N` 位置参数 + `` !`cmd` `` 内联执行块 + ` ```! ` 多行执行块，引擎证实）；UserPromptSubmit hook 的 `additionalContext` 注入在引擎 hook schema 中**已证实存在**（待实测行为） | M1 斜杠命令保底；M2 关键词 hook 证据升级（§8.2）；/omz-status 可用内联执行块直接渲染状态 |
| **hooks** | 54+ lifecycle hooks | 7 事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）；**两种来源的 schema 形状不同，不可混写**（v1.4 末轮修正）：**① 配置文件 hook**（`~/.zcode/cli/config.json` 的 `hooks` 键）用 `hooks.events.<Event>` 组织，另有 `enabled`/`timeoutMs`/`maxOutputBytes` 等运行参数；**② 插件 hook**（`<pluginRoot>/hooks/hooks.json`）用外层 `hooks` 包裹（引擎读 `rawHooks.hooks`），**直接以事件名为键，没有 `events` 中间层**——给插件 hooks.json 写 `events` 会静默不生效（§10.3 第 4 条）。PreToolUse 可返回 `permissionDecision`/`updatedInput`，多事件可返回 `additionalContext` | 事件数量减少，但核心注入/拦截语义保留；插件形态的 OMZ 只用 ② 的形状（§8.2 三层开关说明哪些字段真被读取）；async 按同步语义处理，异常终止兜底靠 Stop hook（M4） |

**本土化结论（v1.1）**：原文将 codegraph、teammode、dag、tmux 一并称为“降级”不准确。四项应按四层拆开：

1. **语义层：codegraph 可直接接入**。OmO 使用的 `codegraph_explore` 实际来自独立开源项目 [`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)，不是 OmO 私有工具；上游 MIT、Windows x64/arm64、提供 `codegraph serve --mcp` stdio MCP，默认暴露 `codegraph_explore(query, maxFiles?, projectPath?)`。ZCode 官方支持 stdio MCP，并在会话启动时自动连接，因此这是配置/安装项，不是能力降级。OmO 的 `@sisyphuslabs/codex-codegraph` 只做进程解析、provision 和 JSON-RPC bridge；不应直接移植其 Codex hook，ZCode 直接接上游更干净。
2. **调度层：teammode 可本土重构**。ZCode 官方公开文档确认子代理独立上下文、前后台运行、完成结果自动回主对话、禁止子代理再派生；未公开稳定的 Team API、agent ID、resume token、mailbox 或 agent-to-agent 通信。因此 OMZ 以 ZCode Agent 作为短命 worker transport，以自有 coordinator MCP 管理 agent registry/mailbox/lease/heartbeat/resume_ref。调度语义可补齐，原生常驻内存和直接 P2P 不承诺等价。
3. **依赖层：DAG 可本土实现**。不要把 ZCode 的“闲时任务”当 DAG：官方闲时任务是持久 FIFO 队列，失败不自动重试，也没有插件可用的认领/依赖 API。OMZ coordinator 用 SQLite WAL + `tasks`/`task_deps` 表实现 DAG；claim 必须 `BEGIN IMMEDIATE` + 单事务 `UPDATE ... RETURNING`，外部 agent 工作期间不持有写事务；SQLite 仍是 single-writer，设置 `busy_timeout`，使用 at-least-once + 幂等 key。可选复用 MIT `vardiya`（Node >=22、SQLite WAL、atomic claim、heartbeat/stalled recovery、retry/backoff/DLQ、priority/delay/cron；Windows 有 benchmark 但完整兼容仍需验收），或自建更小的 coordinator MCP。
4. **展示层：tmux 可本土替代**。Windows Terminal `wt split-pane` 仅做外部调试旁路；ConPTY 自建终端 host 成本过高。推荐 Electron `BrowserWindow` + 独立 `utilityProcess`/stdio MCP sidecar + localhost HTTP/SSE dashboard：展示 agents、DAG、mailbox、日志和事件序号；SSE 只传事件，命令走 fetch/IPC，使用 loopback、随机端口、token、CORS 白名单。ZCode GUI 任务面板仍是默认入口。原生 tmux pane 的交互式终端不等价，但状态与审计可更适合 ZCode。**v1.5 实现修正**：v1.1–v1.2 这里原本还推荐 `preload/contextBridge`，实现最终**不用 preload**——renderer 的页面与数据全部来自 loopback HTTP 服务，token 走地址栏 query，主进程没有它拿不到的东西；且 `sandbox: true` 与 ESM preload 互斥（理由与取证见 §13.5 I5）。

**最终分级**：

| 能力 | 结论 | ZCode 本土实现 | 与 OmO 的差异 |
|---|---|---|---|
| `codegraph_explore` | **直接接入** | 上游 CodeGraph stdio MCP | 无 OmO 专属 bridge；工具返回文本 ToolResult，不是强类型 JSON |
| Team Mode 语义 | **可补齐** | coordinator MCP + ZCode Agent worker + SQLite mailbox/lease | 无官方常驻 Team API；无保证的 agent-to-agent 直连 |
| DAG 调度 | **可补齐** | coordinator MCP + SQLite WAL + 原子 claim/deps/重试 | 需自带调度状态；不依赖 ZCode 闲时任务 FIFO |
| tmux 展示 | **可替代** | Electron dashboard + SSE + GUI 任务面板 | 无原生 pane；Windows Terminal 只作旁路 |



---

## 2. 能力映射总表（OmO → OMZ）

| # | OmO 机制 | ZCode 等价实现 | 可行性 |
|---|---|---|---|
| 1 | 11 个 Discipline Agents | 9 个 `agents/*.md` + 复用内置 `Explore`（共 10 个角色）+ 主 agent 扮演 Sisyphus | ✅ 原生 |
| 2 | IntentGate 关键词检测 | M1：slash commands；M2：UserPromptSubmit hook 注入（schema 已证实，行为待实测；含去重与斜杠命令排除） | ✅ M1 原生，M2 待实测 |
| 3 | `task(category=...)` 8 类路由 + 回退链 | category → subagent_type 映射表（/ulw 提示词）；模型+思考档靠 frontmatter `model`/`thoughtLevel` | ⚠️ 路由可行；无回退链 |
| 4 | ultrawork 生命周期 8 步 | /ulw 命令系统提示词 + `.omz/goal/` + `.omz/plans/` | ✅ 提示词层全量可移植 |
| 5 | Team Mode（lead+8 成员、mailbox、tmux） | **本土重构**：ZCode background Agent 作 worker transport + OMZ coordinator MCP（SQLite registry/mailbox/lease）+ resume 元数据 + /omz-status；不依赖未公开的官方 team API | ⚠️ 语义可补齐；原生常驻/直接 P2P 不等价 |
| 6 | 12 个 team_* 工具 | coordinator MCP 暴露 13 个 `omz_*` 工具（§7.2：team_create/dag_submit/task_claim/heartbeat/complete/fail、mail_send/receive/ack、status、team_shutdown、reclaim_expired、export_mirror；**真名带 `mcp__plugin_omz_omz-coordinator__` 前缀，裸名不可直接调用**）；主 agent 通过 MCP 调用，worker 只处理任务 | ✅ 调度语义可补齐；底层 worker 启动仍由主 agent Agent 工具完成 |
| 7 | 17 个 skills | 移植核心 4 个：ulw-plan、ulw-execute、ulw-research、review-work | ✅ SKILL.md 同构 |
| 8 | boulder.json 会话续接 | `.omz/boulder.json`（**`active_goal` 是唯一权威指针**，§13 B30）+ 主 agent 每波次收点后主动写（Stop hook 未实装，§17 裁决 4）；持久任务状态由 coordinator SQLite 保存，Boulder 只存当前 work 指针 | ✅ 状态可持久；跨重启自动 resume 依赖 ZCode 未公开 API，需人工/主 agent 重启 worker |
| 9 | tmux 可视化 | **本土重构**：独立 localhost dashboard（Electron BrowserWindow/utilityProcess + HTTP/SSE；**实现不用 preload**，renderer 只经 loopback HTTP 取数据，§13.5 I5）；ZCode GUI 任务面板作默认入口，Windows Terminal `wt split-pane` 仅调试旁路 | ⚠️ 状态可等价；原生 pane 交互不等价 |
| 10 | 54+ hooks | 保留 ZCode 七事件；不依赖 OmO 的 hook 数量。`UserPromptSubmit`/`PreToolUse` 的 context/decision 能力可用，但 async 行为按同步处理，等运行时探针后再启用 | ⚠️ 事件数量减少；核心注入/拦截语义可保留 |
| 11 | 5 个内置 MCP | CodeGraph 与 coordinator 作为 OMZ 可选 MCP；其余按需安装，不把外部依赖强塞进核心 | ✅ 可插拔 |

---

## 3. 总体架构

### 3.1 四层架构（本土化实现）

```
┌──────────────────────────────────────────────────────────┐
│ 展示层：ZCode GUI 任务面板 + 可选 Electron dashboard/SSE    │
│ agents / DAG / mailbox / events / audit                   │
├──────────────────────────────────────────────────────────┤
│ 调度层：OMZ coordinator MCP（stdio，ZCode plugin-host）      │
│ registry / task DAG / lease / heartbeat / mailbox / retry  │
├──────────────────────────────────────────────────────────┤
│ 语义层：CodeGraph MCP（上游 @colbymchenry/codegraph）       │
│ codegraph_explore：调用链 / 影响范围 / 相关源码             │
├──────────────────────────────────────────────────────────┤
│ 执行层：ZCode Agent（短命 worker）+ 9 个 OMZ agents/*.md    │
│ + 内置 Explore（共 10 角色）；主 agent 扮演 Sisyphus         │
│ ZCode 原生负责 spawn/结果回传                                │
└──────────────────────────────────────────────────────────┘
```

**核心边界**：调度层不伪装成 ZCode 官方 Team API。ZCode Agent 负责实际启动 worker，coordinator MCP 只负责可持久化的身份、任务、依赖、租约、消息与审计；两者通过 `agent_ref`/`task_id` 关联。任一增强层不可用时，主 agent 的普通单轮委派仍可工作（feature flag + M1 fallback）。

### 3.2 组件与数据流

1. 主 agent 读取 `/ulw` 或 `/team` 协议，决定是否需要 CodeGraph、DAG 和 Team 语义。
2. 若需要代码关系，调用 `codegraph_explore`；没有索引时先返回初始化指导，不静默用不完整结果作为事实。
3. 创建团队/图后，主 agent 调用 coordinator MCP `omz_team_create`/`omz_dag_submit`；coordinator 生成稳定 `team_id`/`graph_id`/`task_id`，但不直接启动 ZCode agent。
4. 主 agent 按 ready 任务调用 ZCode Agent，记录返回的 `agent_ref`；worker 只处理绑定任务并提交 `complete`/`fail` 结果。
5. coordinator 原子更新依赖和 lease，立即释放新 ready 任务；lease 过期由 `omz_reclaim_expired` 回收重派（§7.2）；主 agent 收到后台通知后读取状态，不以通知本身作为完成证据。
6. dashboard 只读 coordinator 的状态 API；展示失效不阻断调度。

### 3.3 可选能力 profile 与依赖隔离

OMZ 不把所有增强能力绑死在一个启动路径上，而是提供四个 profile：

| Profile | 默认 | 依赖 | 失败时 |
|---|---|---|---|
| `core` | ✅ | ZCode 原生 agents/commands/skills + 主 agent 编排 | 不受外部服务影响 |
| `graph` | 可选 | 上游 `@colbymchenry/codegraph`（MIT，Windows x64/arm64，Node 自带运行时）+ `.codegraph/` 项目索引 | 回退 Explore + Bash grep/rg；不得把不完整索引当事实 |
| `orchestration` | 可选 | OMZ coordinator stdio MCP + SQLite WAL（自建或评估后接入 `vardiya`） | 回退 ZCode 原生后台 spawn + 波次并行；不影响 core |
| `dashboard` | 可选 | Electron BrowserWindow/utilityProcess + loopback HTTP/SSE | 回退 ZCode GUI 任务面板 + `/omz-status` |

启用规则：`core` 必须先成立；`graph` 与 `orchestration` 可独立、并行启用；`dashboard` 在 coordinator 状态接口稳定后再启用，但不依赖 CodeGraph。每层必须能单独关闭。CodeGraph 与 coordinator 的 MCP 连接配置放在 workspace `.zcode/config.json` 或插件 manifest 的 `mcpServers`，不修改 ZCode 核心、不覆盖用户已有 MCP。

**配置优先级（v1.4 实现裁决，§17 裁决 12）**：profile 开关按 `内置默认值 → .zcode/config.json 的 omz 键 → .omz/config.json（整个文件即 omz 配置）` 逐层覆盖，**后者优先级最高**。副作用必须知道：`.omz/` 被 gitignore（§13 B14），因此 `.omz/config.json` 是**本机私有覆盖**；想让 profile 开关随仓库共享给团队，必须写在 `.zcode/config.json`。doctor 输出会逐层报告命中/跳过情况，避免"改了配置没生效"。

**CodeGraph 事实边界**：OmO 的 `codegraph_explore` 默认只有一个 MCP 工具，参数是 `query`（必填）、`maxFiles`（可选，默认 12）、`projectPath`（可选）；返回标准 MCP text content，可带 `isError`，不是稳定的强类型 JSON。隐藏的 `search/callers/callees/impact/node/files/status` 工具需显式启用。OMZ 第一版只依赖 `codegraph_explore`，以文本为主并要求 agent 标注来源文件/行号；不要依赖未启用的隐藏工具或自行假设返回 JSON schema。

---

### 3.4 插件包布局

以标准 ZCode 插件分发。基础插件可以只启用 agents/commands/skills；CodeGraph 与 coordinator 作为**可选 MCP profile**，根据 feature flag 连接，避免外部依赖阻断核心流程。ZCode 官方插件实体样本（document-skills）确认 `.zcode-plugin/plugin.json` 可声明 `skills` 和 `mcpServers`；本地 stdio server 由 ZCode plugin-host 启动（`ELECTRON_RUN_AS_NODE=1`）。以下是 **v1.4 实际落盘结构**：

```
├── .zcode-plugin/plugin.json      # manifest：commands/skills/mcpServers（agents 与 hooks 由引擎自动发现）
├── .claude-plugin/marketplace.json # 自建插件市场索引（§3.4）
├── package.json                   # 元数据（对齐官方插件惯例）
├── agents/                        # 9 个子代理（§4；第 10 个角色复用内置 Explore）
│   ├── omz-planner.md             # Prometheus
│   ├── omz-critic.md              # Metis
│   ├── omz-deep.md                # Hephaestus
│   ├── omz-junior.md              # Sisyphus-Junior
│   ├── omz-atlas.md               # Atlas（波次状态机 + 派单建议生成器，§17 裁决 1）
│   ├── omz-oracle.md              # Oracle
│   ├── omz-reviewer.md            # Momus
│   ├── omz-librarian.md           # Librarian
│   └── omz-looker.md              # Multimodal Looker
├── commands/                      # 模式触发层（§8）
│   ├── ulw.md                     # /ulw = ultrawork 模式提示词（$ARGUMENTS 接目标）
│   ├── team.md                    # /team = Team Mode 编排指令
│   ├── hyperplan.md               # /hyperplan = 纯规划模式
│   ├── omz-status.md              # /omz-status = 状态看板（```! 内联执行块渲染 .omz/）
│   └── omz-doctor.md              # /omz-doctor = 自检（§13 B10/B12/B14：agent 可达性 + model 校验 + gitignore 检查）
├── skills/
│   ├── ulw-plan/SKILL.md          # 访谈式规划流程（+ references/ 三篇）
│   ├── ulw-execute/SKILL.md       # 计划执行协议
│   ├── ulw-research/SKILL.md      # 并行调研协议（+ references/ 六篇）
│   └── review-work/SKILL.md       # 双证据验收协议（+ references/ 两篇）
├── hooks/
│   ├── hooks.json                 # M2：UserPromptSubmit 关键词检测（真闸是 omz.keyword_hook，§8.2）
│   └── keyword-detect.mjs         # node 实现，--self-test 30 例
├── mcp/
│   └── coordinator/               # 已实现：stdio MCP，SQLite registry/mailbox/DAG/lease
│       ├── server.mjs             # 13 个工具（§7.2）
│       ├── core.mjs               # 事务与不变量（含 verifyGraphInvariants）
│       ├── db.mjs
│       ├── schema.sql
│       └── migrations/
├── dashboard/                     # 已实现：Electron/localhost SSE 展示层
│   ├── main.mjs                   # Electron 宿主（无 electron 时降级）；无 preload、无 IPC 通道（§13.5 I5）
│   ├── server.mjs                 # loopback HTTP/SSE + token 门（§13.5 I10 分层）
│   └── renderer/
├── adapters/zcode/                # 宿主差异隔离：transport/capability/fallback/path
├── tools/                         # 运维脚本
│   ├── doctor.mjs                 # /omz-doctor 后端
│   ├── render-status.mjs          # /omz-status 渲染（波次数值排序 B28、行内注入防护 B27）
│   ├── validate-frontmatter.mjs   # YAML/工具名校验（B23/B24）
│   ├── sync-omo-skills.mjs        # §16.3 上游选择性同步
│   └── lib/is-main.mjs            # CLI 入口判定（B22 共享实现）
├── tests/                         # 102 suites / 578 tests
└── upstream/                      # omo-sources.lock.json + 移植记录（§16.4）
```

**模板变量纪律（引擎证实，§10.3）**：manifest 与 hooks.json 里的路径只能用引擎展开的变量。OMZ 统一使用 `${ZCODE_PLUGIN_ROOT}` 与 `${ZCODE_PROJECT_DIR}`；`${pluginDir}` **不是引擎变量**（v1.3 及更早文本误用过，实现已改正），写了会被原样保留导致路径必然失效。hooks 上下文禁用 `ZCODE_SKILL_DIR`/`CLAUDE_SKILL_DIR`（引擎直接抛错）。

命名规则：subagent_type 一律 `omz-` 前缀。引擎的 `loadPluginAgentProfiles` **强制给插件 agent 加命名空间前缀** `<pluginName>:<bareName>`（如 `omz:omz-planner`），并在该 bareName 全局唯一且不撞保留名（`general-purpose`/`Explore`）时**额外注册裸名别名**；bareName 冲突或撞保留名会产生 `agent_ambiguous_name` 诊断而丢别名。因此 OMZ 的 9 个 agent 当前既可用 `omz:omz-planner` 也可用裸名 `omz-planner`——`omz-` 前缀策略被引擎行为证实是对的：它保证裸名唯一，`planner`/`oracle` 这类通用名一旦被别的插件占用就会丢别名（详见 §10.3）。

### 3.5 运行时状态目录（项目内）

```
.omz/
├── config.json                    # 可选：本机私有 profile 覆盖（优先级最高，§3.3；被 gitignore）
├── goal/<stem>.json               # ultrawork 目标（outcome + 二进制成功标准 + 终止条件 + 宪法检查清单）
│                                  # stem 两种形态（§13 B30）：① 真实 sessionId；② 拿不到时回退
│                                  # `<ISO 时间戳>-<git HEAD 短哈希>`（非 git 仓库哈希位 `nogit`）
│                                  # 定位一律走 boulder.json 的 active_goal 指针，不靠文件名推断
├── drafts/<slug>.md               # ulw-plan 的草稿/批准门记录（§7.5.1 双工件语义）
├── plans/<slug>.md                # planner 产出的分波次计划（波次分隔符 `## Wave <n>`，§7.5.1）
├── research/<slug>/               # ulw-research 产物（intent.md + report.md/html/pdf/docx）
├── ulw-execute/ledger.jsonl       # 执行编排的逐事件 append 账本（§7.5.2）
├── runtime/
│   ├── coordinator.sqlite         # orchestration profile 的持久状态库（**单库多 team**，v1.4 修订见下）
│   └── <teamId>/                  # Team Mode 的 per-team 文件区（§7.3）
│       ├── state.json             # core profile 的轻量状态镜像/恢复索引（含 agent_ref↔task_id 映射）
│       ├── tasks/<taskId>.json    # 无 coordinator 时的回退任务文件
│       ├── inboxes/<member>/<uuid>.json
│       └── results/<taskId>.json  # 成员完成汇报
├── .mode-injected-<sessionId>     # M2 hook 的会话级去重 marker（§8.2）
└── boulder.json                   # 会话续接状态（主 agent 每波次收点后主动写，§17 裁决 4）
```

**v1.4 修订：coordinator 是单库多 team，不是一 team 一库。** v1.3 把 `coordinator.sqlite` 画在 `runtime/<teamId>/` 下，暗示按 team 分库；实现选择单库——`teams` 表 + `omz_status(team_id)` 本身就是多 team 注册表，`omz_team_create` 由服务端生成 `team_id`，分库反而让"同时只允许一个活跃团队"（§12.5）之外的跨 team 审计查询无法进行。`.zcode-plugin/plugin.json` 的 `OMZ_COORDINATOR_DB` 因此指向 `${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite`。若确需隔离（如压测），挂载方可用 `--db` / `OMZ_COORDINATOR_DB` 指向任意路径，server 不假设库的位置。§12.5 的"runtime 按 teamId 隔离"论证因此改为依赖 **per-team 文件区 + 库内 `team_id` 外键**，而非分库。

coordinator 启用时，SQLite 是任务/依赖/租约/mailbox 的唯一事实源，JSON 目录只作可读镜像与审计导出；coordinator 不可用时才启用文件回退，禁止两套状态同时写入造成分叉。计划文件名一律用 `<slug>.md`（v1.4 统一：v1.3 的 §6 写 `<id>.md`、本节写 `<planId>.md`，实现是 `<slug>.md`）。

---

## 4. 角色系统（9 个 agent 文件 + 复用内置 Explore，共 10 个角色）

frontmatter 实测可用字段全集（judge.md 样本 + 引擎解析链证实）：`name` / `description` / `tools`（YAML 数组）/ `model` / `thoughtLevel` / `permissionMode` / `maxTurns` / `memory` / `color` / `mcpServers`。

| subagent_type | 对应 OmO | 职责 | tools | maxTurns | thoughtLevel | color |
|---|---|---|---|---|---|---|
| `omz-reviewer` | Momus | 评审门：对完成的工作挑刺，blocker/major/minor 分级 + 行号引用；复审上限 2 次 | `[Read, Bash]`（无 Edit/Write=结构约束，v1.5 已行为级确证；Bash 只读是纪律约束，见下文） | 中 | high | red |
| `omz-oracle` | Oracle | 架构咨询与疑难调试：只分析给方案，不动代码 | `[Read, Bash]` 同上三层模型 | 中 | max | purple |
| `omz-critic` | Metis | 计划定稿前差距分析：遗漏场景、隐含假设、依赖风险 | `[Read, Bash]` 同上三层模型 | 低 | high | orange |
| `omz-planner` | Prometheus | 访谈式战略规划：先提问澄清，产出分波次计划写入 `.omz/plans/` | `[Read, Bash, Write]` | 中 | high | blue |
| `omz-deep` | Hephaestus | 深度自主编码：给目标不给步骤，端到端实现；开工先做代码库探索（经 Bash grep/find；子代理不能 spawn） | 全工具 | **高但有限**（失控护栏） | high | green |
| `omz-junior` | Sisyphus-Junior | 聚焦单任务执行器；叶子执行者（工具面无 Agent，结构上不可能委派） | 全工具 | 中 | medium | green |
| `omz-atlas` | Atlas | /ulw-execute 执行会话：**波次状态机 + 派单建议生成器 + 汇报器**（不 spawn 不实现，§17 裁决 1） | 全工具 | 中高 | high | green |
| `omz-librarian` | Librarian | 文档与代码检索：抓已知 URL 全文 + 本地取证，带来源引用（**无 WebSearch**，§17 裁决 2） | `[Read, Bash, WebFetch]` | 低 | low | cyan |
| `omz-looker` | Multimodal Looker | 多模态分析：截图/PDF 页图/图表，服务 visual-qa；Bash 仅用于枚举图片路径（不做格式转换） | `[Read, Bash]` | 低（15） | — | yellow |
| `Explore`（复用内置） | Explore | 快速扫库；内置角色不重复定义（只读工具集天然无 Agent 工具，实测结构上不可能嵌套） | 引擎内置 | — | — | — |

注（v0.5 实测修订）：子代理工具清单**无 Grep/Glob 独立工具**（B20），文件搜索经 Bash 的 grep/find/rg；故只读角色 tools 均含 Bash 而非 Grep/Glob。子代理**无 Agent 工具**（V5 实测），嵌套委派在工具层结构性不可能——"禁止再委派"从提示词纪律升级为结构保证。

注（v1.4 实现修订）：① `omz-atlas` 的语义从"派发者"改为"派单建议生成器"——它自己是被 spawn 的一方，既不能 spawn 又被禁止实现，旧语义使该角色整体不可执行（§17 裁决 1）；② `omz-librarian` 删除 `WebSearch`——引擎有该工具名且归入 `isReadOnlyTool`，但**当前部署的实际工具面里没有它**（§17 裁决 2、§13 B24）；③ `omz-looker` 补 `Bash` 并把 maxTurns 提到 15——它原本只有 `Read`，而 Read 需要精确路径，无 Bash 则无法枚举待检图片，实际不可用；代价是它不再是"完全结构性只读"，正文明令 Bash 仅限 `ls`/`find` 枚举。

注（v1.5 装机实测确证）：本表的 tools 列已在**真实会话内逐个 spawn 核对**（V12，§10.1）——五个受限角色（critic/oracle/reviewer/librarian/looker）的实测工具面**均无 Edit**，三个全工具角色（deep/junior/atlas）**有 Edit**，逐项与 frontmatter 声明吻合；9 个角色**全部无 `Agent`**（V5 行为级复验）、**全部无 `Grep`/`Glob`**（B20 复验）、**连全工具角色都没有 `WebSearch`**（§17 裁决 2 的行为级确证）。同时发现工具面**多出一个 frontmatter 未声明的 `RespondToCoordinator`**——引擎注入，不受白名单约束（下文第三层、§10.3 第 11 条）。

设计要点：

- **质量角色的只读性是三层的，不是单一"结构性保证"**（v1.4 按 §17 裁决 3 拆出前两层；v1.5 装机实测补第三层）：
  - **结构约束（硬）**：`tools` 白名单排除 `Edit`/`Write`/`ApplyPatch`，引擎层面拿不到这些工具，reviewer 无法用编辑工具改代码。**v1.5 已取得行为级确证**：五个受限角色的实测工具面确实无 Edit（此前只有静态校验 + 引擎解析链推断，§10.1 V12）。
  - **纪律约束（软）**：`Bash` 在引擎里被归为 `isWriteTool` **且** `isDestructiveTool`（§10.3 第 5 条），`>` 重定向、`node -e fs.writeFileSync`、`git checkout` 都能改文件。因此"reviewer 物理上改不了代码"是**错的**；准确说法是"reviewer 没有编辑工具，且提示词明令禁止用 Bash 写入"。**全部 5 个质量角色（critic/oracle/reviewer/librarian/looker）都持有 Bash，因此都受这一层约束——v1.4 前 `omz-looker` 曾是唯一纯 `[Read]` 角色，但那让它拿不到图片路径而不可用（本节 v1.4 修订注③）。**
  - **引擎注入面（不可控，v1.5 装机实测新增）**：**只读角色的真实工具面 = frontmatter 白名单 ∪ 引擎注入工具**。9 个子代理的实测工具面**全部含 `RespondToCoordinator`**，包括 `tools: [Read, Bash]` 这种最窄形态——该工具**不在任何 frontmatter 里声明，也不受白名单约束**（§10.3 第 11 条）。含义：白名单是"我们能声明什么"的上界，**不是工具面的全集**；任何"这个角色只有 N 个工具"的推断都必须留出引擎注入的余量。当前 `RespondToCoordinator` 只做回话、不写文件，不削弱只读性；但**引擎将来注入什么由引擎决定，这一层没有 OMZ 侧的控制点**，只能靠装机后复测工具面来发现（doctor 的 spawn ping 已具备这个能力）。
  - **收紧路径：没有（v1.4 末轮定为终态）**。`permissionMode` 的枚举已由引擎反查取出（§10.1 V8），**其中没有任何值能移除单个工具**——最接近的 `plan` 是全局模式而非工具白名单，用它会连带废掉 looker 枚举图片路径、librarian 本地取证这些必需的只读 Bash 用法。所以三层模型（Edit/Write 结构 + Bash 纪律 + 引擎注入面不可控）**是终态而非过渡态**，agent 正文必须写明这一约束的性质（已实施），不要再期待某个 frontmatter 字段把它补成结构保证（§17 裁决 3）。
- **maxTurns 全员设置**：引擎证实 per-agent 可配，这是比提示词纪律硬得多的失控护栏（§13 B6）。
- **thoughtLevel 分档**：librarian 用 low（快检索）、oracle 用 max（深度推理）、junior 用 medium——思考档在 frontmatter 指定（引擎证实），不需要 spawn 参数。
- **description 预算纪律**：9 条 description 常驻主会话系统提示词（固定 token 税）。每条 ≤2 句、第一句必须是触发条件（"当…时委派此代理"），总量控制在 ~400 token。judge.md 证明引擎不限制 description 长度，但成本与误派风险由自己控制；角色细节全放正文（仅被 spawn 时加载）。
- **委派协议**（写进 /ulw 提示词，源自 OmO task 7 要素）：`TASK / EXPECTED OUTCOME / REQUIRED SKILLS / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT`。CONTEXT 必须自足（子代理全新上下文，看不到主会话历史，§12.4）。

---

## 5. Category 路由系统

### 5.1 八类 category（判断标准照搬 OmO）

| category | 判断标准 | OMZ 落点 |
|---|---|---|
| `visual-engineering` | 前端、UI、CSS、设计 | `omz-junior` + omz-looker 验收 |
| `ultrabrain` | 难题、架构决策 | 先 `omz-oracle` 咨询再 `omz-junior` 执行 |
| `deep` | 深度编码、复杂逻辑 | `omz-deep` |
| `artistry` | 创意、新颖方法 | `omz-junior`（提示词允许激进方案） |
| `quick` | 单文件、typo 级小改 | **主 agent 自己干，不 spawn**（省流阀） |
| `unspecified-low` | 一般标准工作 | `omz-junior` |
| `unspecified-high` | 一般复杂工作 | `omz-junior` |
| `writing` | 文本、文档 | `omz-junior`（简单文档主 agent 直接写） |

直接指定通道：探索走内置 `Explore`，检索走 `omz-librarian`，规划走 `omz-planner`，咨询走 `omz-oracle`，**评审走 `omz-reviewer`**，视觉检查走 `omz-looker`，按计划逐波驱动走 `omz-atlas`（v1.4 补齐：实现的通道是本表的超集，v1.3 规格漏列）。

### 5.2 路由表落点

映射表写进 /ulw 命令提示词（编排层决策），不写死在任何 agent 里——调整路由只改一个文件。

### 5.3 模型与思考档（v0.3 修正）

v0.2 曾断言"思考等级不能按 spawn 指定"——spawn 参数确实没有，但引擎证实 **frontmatter `thoughtLevel` 可按 agent 指定**，故修正：

- **模型**：frontmatter `model` 写供应商模型 ID（引擎有 SubagentModelRef 完整解析链 + Inherited 继承工厂，高置信，V2 实测收尾）。未写则继承主会话模型。
- **思考档**：frontmatter `thoughtLevel` per-agent 指定（off/low/medium/high/max，供应商须支持）。
- **回退链**：ZCode 无此机制，放弃——单模型直连，失败由主 agent 换 subagent_type 重派。
- **保守档（v1，V2 失败时）**：全部继承主会话模型，category 只决定路由角色；思考档差异同样失效，省流阀照常生效。

---

## 6. ultrawork 生命周期（/ulw）

/ulw 命令正文即移植后的 ultrawork 系统提示词（OmO `prompts/ultrawork/default.md` 的 ZCode 改写版）。八步全保留，其中 6/7/8 步是质量协议核心：

**关于"八步"与实现里的"第零步"（v1.4 末轮明确）**：`commands/ulw.md` 现在多了一个**第零步：会话标识**（B30 的修复），第一到第八步编号不变。**本文档全文继续用"八步"指称生命周期**——八步是**语义阶段**（激活→注册→盘点→确定性→规划→执行→验证→评审提交），第零步是**实现层的机制步骤**（在命令展开时用内联执行块取一个引擎变量，产出后续步骤要用的文件名 stem），它既不是一个工作阶段，也不产生任何交付物，因此不进阶段计数。选这个表述而不是改成"九步"，理由是：① 八步来自 OmO 的 ultrawork 协议，是 §7.5 逐条对比的锚点，改数字会让协议移植对照表与 skills 里的表述全部失配；② 第零步的存在性依赖宿主（若将来引擎在 `<env>` 里给出 sessionId，它就该消失），把宿主适配细节混进语义阶段编号会让协议随宿主漂移。凡涉及实现细节处（附录 B、`commands/ulw.md`）明确写"八步 + 第零步会话标识前置"。

1. **激活**：输出 ULTRAWORK MODE ENABLED，加载本提示词为工作宪法。（`commands/ulw.md` 里这句不加反引号：`!` 紧贴收尾反引号会命中引擎的行内 shell 展开正则，§13 B31。）
2. **目标注册**：目标写入 `.omz/goal/<stem>.json`——outcome-first、**可失败的二进制成功标准**、明确终止条件。**stem 的来源只有一处**（v1.4 末轮修正，§13 B30）：`/ulw` 的**第零步：会话标识**用 ` ```! ` 内联执行块输出的 `OMZ_GOAL_STEM`。两种命名形态——① 拿到真实 sessionId 时 stem 即 sessionId（`.omz/goal/<sessionId>.json`）；② 拿不到时用 **`<ISO 时间戳>-<git HEAD 短哈希>`** 确定性回退（非 git 仓库哈希位写 `nogit`）。**主 agent 拿不到 sessionId 是既定事实**——`${ZCODE_SESSION_ID}` 只在 hook/MCP/命令执行块上下文展开，Bash 工具 env 与系统提示词 `<env>` 块都没有它，所以**严禁编造**（`sess_x`/时间戳/`unknown` 之类在本轮自洽、看板照渲、doctor 检不出，是退出码 0 的假成功，B30）；执行块整段失败时停下问用户。goal 同文件存"宪法检查清单"（评审门触发条件、双证据要求、省流阀规则），每个提交点前 lead 自查（§13 B17 防质量衰减）。写完 goal **立即**创建/更新 `.omz/boulder.json`：**`active_goal`（正斜杠相对路径）是跨会话找回目标的唯一权威指针**，`session_ids` 只作审计线索、**任何时候都不参与文件定位**。续跑时只按 `active_goal` 打开旧 goal 文件，不按当前 sessionId 猜、不拿 `session_ids` 反推文件名——新会话 stem 必然不同，猜必错（§13 B18/B30）。
3. **技能盘点**：枚举可用 skills（OMZ 4 个 + 用户已装），声明选用与理由。
4. **确定性保障**：未 100% 确定不得写代码。深挖意图 → 并行 spawn 内置 `Explore` → 仍存疑咨询 `omz-oracle`；歧义无法消除必须问用户。
5. **规划**：满足任一条件（≥2 步骤 / 多文件 / 含架构决策）强制派 `omz-planner` 访谈规划，产出 `.omz/plans/<slug>.md`（波次以 `## Wave <n>` 标题划分，§7.5.1）；经 `omz-critic` 差距分析后定稿。**同一场景的测试与实现严禁并行。**
6. **执行**：主 agent 只编排不亲自实现（琐事除外）。TODO 统一格式 `path: <action> for <scenario> — verify by <check>`，TodoWrite 单 in_progress；委派按 7 要素；omz-junior 是叶子执行者（工具面结构上无法再委派）。
7. **验证**：强制 RED→GREEN→SURFACE→REFACTOR→REGRESSION；**双证据验收**——① 测试输出（测试 ID + 断言消息双态）+ ② 真实工件（命令转录 / curl 状态码+body / 截图）。明文写入："tests pass" alone is NOT evidence。QA 资源（端口、临时目录、后台进程）清理并留凭证。
8. **评审门与提交**：触发条件（任务措辞严格 / ≥3 文件 / ≥20 轮 / ≥30 分钟 / 重构迁移性能安全类）满足时派 `omz-reviewer`，**最多复审 2 次**，仍有 blocker 停止上报用户；每个验证通过的最小增量一次原子 commit（提交前 `git log --oneline -20` 模仿历史风格）。

**收尾落盘（v1.4 修正，§17 裁决 4）**：`.omz/boulder.json` 由**主 agent 在每个波次收点后主动写**——Stop hook **未实装**（hooks.json 只注册 `UserPromptSubmit`），"异常终止时由 Stop hook 落盘"属 M4 未实装项。因此当前的续接保障来自主动落盘的频率，而非终止钩子；异常终止（进程被杀、会话崩溃）会丢失最后一个收点之后的进展，这是已知缺口（§13 B17）。

---

## 7. Team Mode（/team）

### 7.1 与 OmO 的机制差异（更新为本土 coordinator 方案）

| OmO | OMZ 本土实现 |
|---|---|
| 成员常驻、轮询 mailbox | ZCode Agent 短命 worker；coordinator 持久化 `agent_registry`、`resume_ref` 和 lease；能 resume 则复用，不能则用原 results 重建 |
| 成员主动认领任务 | coordinator MCP `omz_task_claim` 原子认领；主 agent 负责把 ready 任务绑定给 ZCode Agent，不能假定 worker 会自主调用 MCP |
| 成员间 P2P 通信 | coordinator MCP `send/receive/ack` 提供语义等价 mailbox；**不是** ZCode 原生 agent-to-agent 通道 |
| mailbox 文件投递（3s 轮询） | SQLite mailbox + MCP 拉取；无 coordinator 时回退 JSON inbox，通知只作提醒 |
| tmux pane 可视化 | /omz-status + 可选 Electron dashboard/SSE + GUI 任务面板 |

**边界**：coordinator 能让身份、任务、消息和审计跨进程持久化，但不能让已退出的 ZCode agent 内存和原生上下文永久驻留；不能承诺 ZCode 官方 API 未公开的自动唤醒或跨重启 resume。

### 7.2 coordinator MCP 与 DAG 协议（新增）

coordinator 是 OMZ 自己的 stdio MCP sidecar，由 ZCode plugin-host 启动；它不是 ZCode 官方 Team API。工具集合共 **13 个**（v1.3 规格列 11 个，实现追加 2 个，§17 裁决 9）：

**下表的工具名是逻辑名（裸名），不是可直接调用的真名（v1.4 末轮修正）。** 引擎给插件 MCP server 命名为 `plugin:<pluginName>:<serverKey>`，暴露给模型的工具名是 `mcp__plugin_<pluginName>_<serverKey>__<toolName>`。本插件 `pluginName=omz`、`serverKey=omz-coordinator`（`.zcode-plugin/plugin.json`），所以 `omz_team_create` 的真名是 **`mcp__plugin_omz_omz-coordinator__omz_team_create`**。

- **表里保留裸名只为可读**（13 行长名字会把表挤爆，且与 §7.3/§13.5 的交叉引用都用裸名）。
- **调用方（主 agent）必须按后缀匹配自己的工具清单现取真名**（形如"以 `__omz_task_claim` 结尾的那一个"），**不要硬编码长名**——插件名或 serverKey 一变，硬编码就又错了。
- **按字面裸名调用会 tool-not-found**。这个失效模式很难诊断：`/team` 有 core 波次并行回退，所以表现不是报错，而是"orchestration 明明开了却总在降级档跑"。找不到工具时的正确反应是判定 profile 未启用/MCP 未连接（`mcpServers.omz-coordinator.enabled` 默认 `false`），直接走回退并**明确告知用户处于降级档及原因**，而不是试探性猜名字。
- `commands/team.md` 已按此写法实现（裸名书写 + 后缀匹配取真名 + 找不到即降级并告知）。
- **worker 侧看得见 MCP 工具，这是既定事实（v1.5 装机实测）**：全工具子代理的实测工具面含完整的 `mcp__openviking__*`（11 个）与 `mcp__node_repl__js*`（3 个）（§10.3 第 12 条）。因此**不要再用"worker 看不见 MCP"当理由**——coordinator MCP 一旦启用，worker 侧很可能直接看得见 `mcp__plugin_omz_omz-coordinator__*` 全套工具，其中包括 `omz_task_claim`/`omz_task_complete` 这类**会改调度状态**的工具。
  - **`commands/team.md` 第 4 步"不能假定 worker 会自主调 MCP"这条约束仍然成立且必须保留**，但其**理由要换**：不是"它看不见"，而是"**认领/汇报的语义由主 agent 把控**"。协议靠**纪律**而非可见性来约束调用权（§7.4 同款表述）。
  - **为什么这个区别重要**：靠"看不见"支撑的约束是**假的结构保证**——它会在某次引擎变更或 profile 组合下无声失效，而基于纪律的约束至少在提示词里是显式的、可审计的。这与 §4 只读性模型的三层结论同源：**可见性不是权限**。
  - **残余风险与兜底**：worker 若越权直接 claim/complete，coordinator 侧仍有 owner 校验（§13.5 I8）、终态守卫与一次性消费（I7）、幂等键与 task 绑定（I9）拦住数据层破坏；但**语义层的乱序**（未经主 agent 收点就自行标 done）这三道拦不住，只能靠 8 要素 prompt 的 MUST NOT DO 明令 + 收点只认 results 文件（§7.3）来防。

| 工具（逻辑名） | 输入 | 原子保证 / 输出 |
|---|---|---|
| `omz_team_create` | `name`, `max_parallel`, `metadata` | 生成稳定 `team_id`、建图与审计事件 |
| `omz_dag_submit` | `team_id`, `tasks[]`, `deps[]` | 事务写入任务和依赖，返回 `graph_id` |
| `omz_task_claim` | `graph_id`, `agent_ref`, `lease_seconds` | `BEGIN IMMEDIATE` + 单事务 claim，返回一个 ready task 或空；**claim 时 `attempts += 1`** |
| `omz_task_heartbeat` | `task_id`, `agent_ref`, `extend_seconds` | 仅 owner 可延长 lease |
| `omz_task_complete` | `task_id`, `agent_ref`, `result_ref`, `idempotency_key` | 校验 owner + **终态守卫**，完成任务，**一次性**递减下游 `deps_remaining`（§13.5 I7） |
| `omz_task_fail` | `task_id`, `agent_ref`, `error`, `retry_at` | 校验 owner（与 complete 对齐，§13.5 I8）；只允许作用于 `running`；按重试预算重新 ready 或进入 dead-letter |
| `omz_mail_send` | `to_agent`, `from_agent`, `task_id`, `payload`, `dedupe_key` | `dedupe_key` 唯一，at-least-once 投递 |
| `omz_mail_receive` | `agent_ref`, `limit` | 按 seq 拉取未 ack 消息 |
| `omz_mail_ack` | `message_id`, `agent_ref` | 幂等确认 |
| `omz_status` | `team_id` | 返回 agents/tasks/mailbox/events 汇总（7 态计数 + transport/coordinator 双维度） |
| `omz_team_shutdown` | `team_id`, `force` | 标记终态，拒绝新 claim |
| **`omz_reclaim_expired`** | `graph_id`（可选）, `limit` | **v1.4 新增**：回收 lease 过期任务（超预算进 dead-letter，否则回 ready），并把原 owner 的 `transport_state` 置 `unknown`。§7.2 原表没有 lease 回收入口，但 I3/I4 都要求"lease 过期只允许重派"——**没有入口时过期任务永久卡在 running**，DAG 直接死锁 |
| **`omz_export_mirror`** | `team_id` | **v1.4 新增**：把 SQLite 事实源投影为 §7.3 的 JSON 镜像（4 态 + 原始 `coordinator_state`），供审计与 `/omz-status` 读取 |

**SQLite 必须遵守的事务边界**（v1.4 修正了 v1.3 范例的两个缺陷）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;
UPDATE tasks
SET status = 'running', owner_agent = :agent,
    lease_until = :now + :lease_seconds,     -- 参数化时间戳，不用 DB 侧 unixepoch()
    attempts = attempts + 1,                 -- 计数点在 claim（见下）
    updated_at = :now
WHERE id = (
  SELECT id FROM tasks
  WHERE graph_id = :graph
    AND status = 'ready'
    AND deps_remaining = 0
    AND (retry_at IS NULL OR retry_at <= :now)   -- 必须过滤 backoff 中的任务
  ORDER BY priority DESC, id
  LIMIT 1
)
RETURNING id, payload, lease_until, attempts;
COMMIT;
```

- **`retry_at` 过滤不可省**（§17 裁决 10）：v1.3 范例缺这一条，照抄会让处于退避窗口内的失败任务被立刻重发，backoff 形同虚设。
- **时间戳一律参数化**：v1.3 用 DB 侧 `unixepoch()`，与可测试性冲突（无法注入固定时钟做确定性断言）。实现改为调用方传 `now`。
- **`now` 绝不出现在对外 MCP 工具的 inputSchema**：实现期发现这是一个可被任意 worker 利用的攻击面——`omz_reclaim_expired({now: 未来时间戳})` 能把**别人未过期的 lease** 判为过期并抢走，等于把调度器的时钟交给调用方。规则：时间只由 server 进程自己取，`now` 仅作内部函数参数（§13.5 I3 同步此条）。
- **`attempts` 的计数点是 claim**（§17 裁决 9/8）：`max_attempts = N` 表示**总共执行 N 次**（不是"重试 N 次"=N+1 次）。v1.3 未定义计数点，两种读法差一次执行。

`RETURNING` 本身不是锁；`BEGIN IMMEDIATE` 才取得写事务。worker 执行外部工作时**不得持有 SQLite 写事务**；完成时另开短事务。WAL 仍是 single-writer，遇 `SQLITE_BUSY` 按有限退避重试。所有 `complete/fail/send/ack` 使用幂等键，语义是 at-least-once，不承诺 exactly-once；幂等键**必须与 task 绑定**校验（§13.5 I9）。

**推荐选型**：

- **CodeGraph**：优先直接接入 `@colbymchenry/codegraph`（MIT，Windows x64/arm64，Node 自带运行时，`codegraph init` 建 `.codegraph/`，`codegraph serve --mcp` 提供 `codegraph_explore`）。来源：[上游 README](https://github.com/colbymchenry/codegraph)、[MCP tools](https://github.com/colbymchenry/codegraph/blob/main/src/mcp/tools.ts)、[OmO bridge](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/codegraph)。
- **任务队列**：优先评估 `vardiya`（MIT、Node >=22、SQLite WAL、atomic claim、heartbeat/stalled recovery、retry/backoff/DLQ、priority/delay/cron；Windows 有 benchmark，完整支持仍须 M1 验收）。若其 API/依赖过重，使用自建 coordinator；不默认采用 LGPL 的 sidequest 或 GPL 的 Dagu。
- **Mailbox 参考**：`MCP Agent Mail`（开源，Git archive + SQLite FTS5 + registration/send/fetch/ack/reservation）可借鉴协议与审计模型；Windows/许可证在当前证据中未完全核验，暂不作为默认依赖。



### 7.3 状态文件格式（core profile 回退格式 / coordinator 镜像格式）

**双层状态模型（v1.4 明确，§17 裁决 6）**：coordinator 的 `tasks.status` 是 **7 态事实源**——`blocked | ready | running | done | failed | dead | unknown`。调度必须有 `blocked/ready`（区分"依赖未齐"与"可发牌"）与 `dead`（dead-letter），§13.5 I3 又要求 `unknown`（lease 过期后传输层不可判定）。v1.3 §7.3 只列的 4 态（`pending|running|done|failed`）不是事实源，而是**镜像投影**：

| coordinator 事实态（7） | 镜像投影态（4） | 说明 |
|---|---|---|
| `blocked` / `ready` | `pending` | 都还没开工，人读时不必区分 |
| `running` | `running` | — |
| `done` | `done` | — |
| `failed` / `dead` / `unknown` | `failed` | 三者对人都是"没成"，但**必须靠 `coordinator_state` 区分** |

投影**必须同时保留原始态**：`exportMirror()` 每条任务除 `status`（4 态）外另写 `coordinator_state`（7 态原始值）。否则审计镜像会丢掉 dead-letter（重试预算已耗尽，不会再发牌）与 unknown（可回收重派）的区别——两者的运维动作完全不同。同理，`transport_state`（agents 表，ZCode agent 是否还活着）与 `coordinator_state` 是两个独立维度，禁止互推（§13.5 I3）。

**标识体系用数字 task id（v1.4 修正，§17 裁决 7）**：v1.3 范例的 `depends_on` 用 task key，但唯一约束是 `UNIQUE(graph_id, key)`——**同一 team 跨图复用同名 key 会让镜像把不同图的任务串成一条链**。实现改为以 `id`（数字，全局唯一）表达关系，`key` 保留作图内业务标识，`depends_on_keys` 仅供人读：

```jsonc
{
  "id": 42,                              // 数字主键，镜像内的唯一标识
  "key": "T-003",                        // 图内业务 key（UNIQUE(graph_id, key)）
  "graph_id": 7,
  "team_id": 3,
  "wave": 2,
  "title": "……",                         // 落表前剥 \r\n\t、替换 |、截断（§13 B27）
  "status": "pending | running | done | failed",   // 4 态投影
  "coordinator_state": "blocked | ready | running | done | failed | dead | unknown",
  "subagent_type": "omz-junior",
  "attempts": 1,                          // claim 时 +1；max_attempts=N 即总共执行 N 次
  "prompt": { "task": "...", "expected_outcome": "...", "must_do": [], "must_not_do": [], "context": "..." },
  "depends_on": [40, 41],                 // 数字 id 数组（机器用）
  "depends_on_keys": ["T-001", "T-002"],  // 对应 key（人读用）
  "result_file": "runtime/<teamId>/results/42.json"   // 正斜杠相对路径（B3/B25/B26）
}
```

无 coordinator 时，`.omz/runtime/<teamId>/tasks/<taskId>.json` 用同一 schema 的子集（无 `graph_id`/`coordinator_state`，`status` 直接是 4 态）；启用 coordinator 后 SQLite 是唯一事实源，JSON 仅由 `omz_export_mirror` 生成，禁止手工改写。

### 7.4 resume 适配器（可选增强，非官方稳定契约）

本次 ZCode 工具层可见 `agent_id` 和 `SendMessage` 续用入口，实际会话中已观察到后台 agent 完成通知；但 ZCode 官方公开子代理文档没有承诺 resume token、跨重启恢复、取消、进度或 agent-to-agent API。因此：

- **基线**：任务级 worker；每个任务 spawn → 执行 → 返回 → coordinator `complete/fail`，不依赖 resume。
- **可选路径**：同一运行期内若 SendMessage 对该 `agent_id` 可用，则追加澄清或复用上下文；所有 resume 关联都写入 `resume_ref`，失败即以 results 重建新 worker。
- **禁止承诺**：不把 resume 描述为常驻内存、跨重启自动恢复或 exactly-once；新会话恢复依靠 coordinator 状态 + 新 spawn。
- **边界**：resume 失败（会话已回收等）回退重新 spawn，把原 results 文件内容并入新 prompt 的 CONTEXT（§13 B9）；等待中的 resume 必须登记 TodoWrite。
- **可见性不等于调用权（v1.5 装机实测后明确）**：worker 侧**看得见 MCP 工具**（实测：全工具角色见完整 `mcp__openviking__*` 11 个 + `mcp__node_repl__js*` 3 个，§10.3 第 12 条），子代理还持有引擎注入的 `RespondToCoordinator`（§10.3 第 11 条）。因此 coordinator 协议里"worker 不自主 claim/complete、状态由主 agent 收点"这类条款**不能靠"它看不见工具"来兜**——它看得见。这些条款是**纪律条款**，必须在 8 要素 prompt 的 MUST NOT DO 里逐条写明，并靠 coordinator 侧的 owner 校验（§13.5 I8）/终态守卫（I7）/幂等绑定（I9）做数据层兜底。**V4 未验证不改变这一点**：无论 resume 可用与否，调用权的边界都由协议纪律定义。
- 工程化行为（通知时序、可否多次 resume、会话关闭后的有效期）待装机实测（V4，§10.2；v1.5 冒烟全程走任务级新 spawn，未触达 resume 路径）。

---

## 7.5 Skill 层对比：OmO 原始协议 → OMZ 移植

以下基于 OmO `packages/shared-skills/skills/` 四个 SKILL.md **原文**（2026-09-01 抓取，dev 分支）逐项对比。这四个 skill 是 OmO 编排能力的实际载体——比 agent 角色定义更核心。

### 7.5.1 ulw-plan（Prometheus 规划顾问）→ OMZ ulw-plan skill

| OmO 原始机制 | OMZ 移植 | 状态 |
|---|---|---|
| 触发严格性：仅用户显式说 ulw-plan / 要工作计划才激活；"裸 ulw 运行不是请求"；metis/momus 评审锁在"用户请求 + 写好的计划文件"双条件 | 照搬触发语义写进 SKILL.md description（防误触发）；评审锁条件写入 omz-critic/reviewer 的 description | ✅ 可直接移植 |
| 模式粘性：会话里 "do X"/"fix X" 都按"plan X" 处理；"delegated implementation is still implementation" | 同样写入 skill 正文 | ✅ |
| 意图路由 CLEAR/UNCLEAR + `review_required` 标记 + 评审修饰词门触发（"high accuracy" 等 → 强制双重评审） | 全部保留；双评审映射为 omz-reviewer + omz-oracle 两个 spawn | ✅ |
| 草稿/计划双工件：`.omo/drafts/<slug>.md`（恢复点）→ 批准后 `.omo/plans/<slug>.md`；scaffold-plan.mjs 脚本产出 | **简化**：单一 `.omz/plans/<slug>.md` + `.omz/drafts/<slug>.md`（保留双工件语义，draft 兼作批准门记录）；脚本改为命令模板（ZCode 无 skill 附带脚手架脚本的先例，由 agent 按模板手写文件——行为等价，少一个依赖） | ⚠️ 简化 |
| 计划工件语法：零列 checkbox `- [ ] N. <title>` / 终验行 `- [ ] F<n>. <title>` / 嵌套 `Recommended task executor category:` 注解 | **原样移植**（这是 ulw-plan↔ulw-execute 之间的机器契约，一字不改）；注解值映射到 §5.1 category 表 | ✅ |
| 波次分隔符 | **`## Wave <n>`（Markdown 二级标题，v1.4 补充规定）**——v1.3 只规定了 checkbox 与 category 注解，没定波次分隔符，实现期因此出现 `Wave <n>:` 与 `## Wave <n>` 两种写法。它和 checkbox 一样是 ulw-plan ↔ ulw-execute 的机器契约（Atlas 按此切波、`/omz-status` 按此归组），必须唯一 | ✅ v1.4 定契约 |
| 派生只读子代理 explore/librarian/metis/momus + "TASK/DELIVERABLE/SCOPE/VERIFY" 四要素 | 映射为内置 Explore / omz-librarian / omz-critic / omz-reviewer；四要素并入 7 要素协议。**Prometheus 自身是被 spawn 的一方，不能 spawn**（V5）——它的"派生"实为**产出派单建议 + 回请主 agent**，由 skill 正文与 agent 正文明确（§17 裁决 1） | ✅ 语义等价（改写为回请主 agent） |
| 两道过滤器（已收集证据能答→探索；意图+可辩护默认值能答→采纳不问）+ owner-decision 强制问 | 照搬 | ✅ |
| OmO 的 codegraph_explore 优先 | ZCode 可直接接入上游 `@colbymchenry/codegraph` 的 stdio MCP；未启用 graph profile 时才回退内置 Explore + Bash grep/rg | ✅ graph profile；core profile 有明确回退 |

### 7.5.2 ulw-execute（计划执行编排器）→ OMZ ulw-execute skill + /ulw

**前置约束（v1.4，§17 裁决 1）**：本表所有"派发/派生"字样在 OMZ 里都必须读成"**产出派单建议 + 回请主 agent**"。`omz-atlas` 是被 spawn 的子代理，工具面无 Agent（V5），它既被禁止亲自实现又无法委派——按 v1.3 的字面语义，该角色**一旦被 spawn 必然违规**（要么违反 ORCHESTRATOR-NEVER-IMPLEMENTER，要么什么都做不了）。实现已把它重写为「波次状态机 + 派单建议生成器 + 汇报器」：它管账本、分级、五 gate、ledger，产出可直接粘贴的 8 要素 prompt 交还主 agent，由主 agent 执行 spawn 与收通知。只有**主 agent 自己**跑 ulw-execute 协议时，"派发"才是字面意义的 spawn。

| OmO 原始机制 | OMZ 移植 | 状态 |
|---|---|---|
| "ORCHESTRATOR — NEVER THE IMPLEMENTER"：根代理零实现、零产品文件编辑、零亲自 QA | 照搬进 /ulw 宪法（与 B21 的例外措辞合并） | ✅ |
| Boulder 状态 schema v2（works/active_plan/session_ids/status/worktree_path） | **原样采用**（`.omz/boulder.json`，字段名不变）+ OMZ 扩展 `active_goal`/`active_team`/`finished_at`。**落盘时机改为主 agent 每波次收点后主动写**——Stop hook 未实装（§17 裁决 4）。**`active_goal` 是跨会话找回目标的唯一权威指针；`session_ids` 只作审计线索且可能为空数组**——主 agent 与子代理都拿不到真实 sessionId（§13 B30） | ✅ 字段等价；落盘机制降级；指针语义强化 |
| git worktree 纪律（PR/分支工作必须在任务专属 worktree；主 worktree 只读） | 照搬（Windows Git Bash 完全支持 git worktree）；`git worktree lock --reason` 评审锁同款 | ✅ |
| LIGHT/HEAVY 分级（默认 LIGHT；六类事实触发 HEAVY；绝不降级） | 照搬 | ✅ |
| 派发 8 要素（目标+范围/基线表征测试+failing-first/约束/验证命令/Manual-QA 通道/对抗类/工件路径+清理收据/工具预期） | 并入 7 要素协议扩为 8 要素（增加"基线与 failing-first 证明"要素）。**Atlas 只生成这 8 要素文本，不执行派发**（见本节前置约束） | ✅ 合并；派发主体改为主 agent |
| 9 个 ultraqa 对抗类（malformed input / prompt injection / cancel-resume / stale state / dirty worktree / hung commands / flaky tests / misleading success output / repeated interruptions） | **全量移植**（触发映射表照抄；"适用必探、排除记理由"规则照搬） | ✅ |
| **Sisyphus 完成契约**：DoneClaim（task/changed_files/tests/manual_qa/cleanup/risks）→ 独立 AdversarialVerify（confirmed/false-positive/needs-fix/needs-human-review + evidence + repro + confidence）；confirmed 唯一通过；失败回弹重派 | **全量移植**——这是 OmO 质量协议的核。verifier 独立性在 OMZ 天然满足（omz-reviewer 与执行者是不同 spawn 实例）；JSON schema 原样保留进 review-work skill | ✅ |
| watcher 挂状态不挂时钟、绝不 poll/sleep、watcher 触发+已验证证据=勾选 | 适配：ZCode 后台通知机制（已实证）+ results 文件双确认 = watcher 等价物；"通知+文件双确认才勾选"合并 B8 的唯一事实源原则。**注意 Atlas 收不到后台通知**（通知只到主 agent），它的收点判据只有 results 文件 | ✅ 语义等价；Atlas 侧单据 |
| 计划 checkbox 翻转 + ledger.jsonl 逐事件 append | 照搬（`.omz/ulw-execute/ledger.jsonl` 字段全保留，路径已登记进 §3.5） | ✅ |
| 10 条 Hard rules（failing-first 先行 / no dry-run / no tests-only / 编排者零实现 / 对抗类必探 / worktree 纪律 / session id 前缀 / no stale-memory） | 全量照搬进 /ulw 宪法检查清单 | ✅ |
| 委派路由器 8 category + Codex tier 映射 | category 表已在 §5.1；tier 映射替换为 OMZ subagent_type | ✅ |
| mass-ulw / dag 原生工具 | ZCode 没有 OmO 同名工具，但 coordinator MCP 的 `omz_dag_submit` + SQLite `task_deps` 提供本土 DAG；未启用 orchestration profile 时才回退波次依赖串行 | ✅ 本土实现；原生工具名不同 |
| No-plan bootstrap（无可选计划时把用户话当批准，反向调 ulw-plan） | 照搬 | ✅ |

### 7.5.3 ulw-research（最大饱和度调研）→ OMZ ulw-research skill

| OmO 原始机制 | OMZ 移植 | 状态 |
|---|---|---|
| 激活门槛（仅显式 research 请求）+ 覆盖 exploration-bounding 默认值 | 照搬 description 触发语义 | ✅ |
| 5 个认识论文档（intent-diff / claim-graph / observation-manifest / verification-economics / cause-disappearance） | **全量移植**（文档模板进 skill references/；"综合只可引用过了门的 verified-claims"规则照搬） | ✅ |
| Scaling floor 下限表（单主题代码库 3 explore 起 / 完整尽调 15 worker） | 照搬表格；但 ZCode 并行 spawn 无 team roster 概念——按表数量直接并行 spawn 后台代理（V4 通知机制已实证支持） | ✅ 适配 |
| EXPAND 尾巴协议（每 worker 回复必带 `## EXPAND` LEAD/DEAD END；缺尾巴=回复不完整） | 照搬（这是免费的递归扩展机制，纯提示词层，无宿主依赖） | ✅ |
| Excursion 有界绕道（四触发 ENTER / 四 EXIT / 深度 3 升格） | 照搬 | ✅ |
| 收敛规则（多面查询 ≥2 扩展波；零未查 lead / 连续 3 波无新 lead / 5 波上限问用户） | 照搬 | ✅ |
| Phase 3 执行代码验证争议 claim（最小脚本 + 全输出 + CONFIRMED/REFUTED/PARTIAL） | 照搬（子代理有 Bash，可执行） | ✅ |
| 非代码 claim 过门（≥2 独立源域 / ≥2 独立观察组收敛 / counter-search / 一手来源 / 时间证据） | 照搬 | ✅ |
| teammode 满员/一成员一 axis/分层混编 | 无 ZCode 官方 team runtime，但 coordinator MCP 提供 team/registry/mailbox/lease；按 ZCode 短命 Agent 逐 axis 启动，按 scaling floor 足量并行；不能承诺常驻内存或 worker 自主认领 | ⚠️ 调度语义本土补齐；官方 Team API 不等价 |
| PDF+DOCX 双出 + chrome headless 打印 + pandoc | 照搬工具链（Windows 下 chrome/pandoc 均可用；具体依赖在 M1 装机时验证） | ✅ |
| visual-QA 恒跑 + proofread 门（writing worker 专职校对） | 照搬；visual-QA 由 omz-looker 承担，proofread 走 writing 类委派 | ✅ |

### 7.5.4 review-work（5 代理并行评审）→ OMZ review-work skill

| OmO 原始机制 | OMZ 移植 | 状态 |
|---|---|---|
| 5 lane 结构：Goal Verifier(oracle) / QA Executor(unspecified-high) / Code Reviewer(oracle) / Security(oracle) / Context Miner(unspecified-high)；全 PASS 才 PASS | **全量移植**：lane1/3/4 → omz-oracle ×2 + omz-reviewer；lane2/5 → omz-junior ×2（或按 category 路由）。5 个并行 spawn 一回合齐发（V4 后台机制已实证） | ✅ |
| "Oracle 不能读文件——一切进 prompt"（DIFF+FILE_CONTENTS 全文直接给） | 适配：OMZ 的 omz-oracle **有 Read/Bash**（V2 实测），可自读——但保留"关键上下文进 prompt"以稳为主（oracle 的 Read 用于深挖，prompt 用于必读材料） | ✅ 增强 |
| Context Miner 恒搜 git history（log/blame/--grep/reverted commits） | 照搬（Bash git 可用） | ✅ |
| lane 是叶代理、一 verdict 即终、复审=全新 spawn 且 scope 限 delta | 照搬（与 V5 结构性防嵌套天然一致） | ✅ |
| INCONCLUSIVE 不算 PASS；lane 沉默→重 spawn 更小 reviewer→仍失败→安全关闭并点名 | 照搬（适配：ZCode 后台代理有 TaskOutput/TaskStop 管理原语） | ✅ |
| 评审 worktree 纪律（add → lock --reason → 用完 unlock+remove） | 照搬 | ✅ |

### 7.5.5 对比总结

**可直接接入**：`codegraph_explore`（上游 MIT CodeGraph MCP）。
**可本土重构为等价语义**：Team Mode 的任务/身份/邮箱/租约/心跳/DAG/重试（OMZ coordinator MCP + SQLite WAL），Electron dashboard 的状态与审计展示。
**仍存在交互差异**：ZCode 官方没有公开 Team API、agent ID/resume token 或 agent-to-agent 原生通信；coordinator 只能持久化这些元数据，不能让已退出的 ZCode agent 内存永久驻留。tmux 的原生 pane 交互不能完全复制，Windows Terminal 仅调试旁路。
**核心回退**：任何可选 profile 关闭或故障，回退 ZCode 原生 Agent + `/ulw` + 波次并行；不把外部依赖变成主流程单点故障。

结论：skill 层是整个移植中**保真度最高**的部分——OmO 四个 skill 本身就是写给 LLM 的编排协议（而非调用宿主 API 的代码），宿主差异主要被 §1.5 已识别的交互模型差异吸收。

---

## 8. 触发机制

### 8.1 M1：slash commands（零风险，立即可用）

- `/ulw <目标>` → ultrawork 模式提示词（`$ARGUMENTS` 接目标）
- `/team <目标>` → Team Mode 编排指令
- `/hyperplan` → 只走规划（omz-planner + omz-critic），不执行
- `/omz-status` → 状态看板：用 ```` ```! ```` 多行执行块（引擎证实支持）跑 node 脚本读 `.omz/` 渲染波次 × 任务 × 状态表格——命令展开时即执行，不依赖主 agent 读文件；渲染上限 40 行（超出聚合为计数摘要），防内联执行块输出膨胀上下文。**注入净化上内联块弱于 `tools/render-status.mjs`（v1.5 实测的能力差，非免责声明）**：同一个含换行 + 竖线的恶意 title 下，内联块**多渲染出一行伪造任务**（41 行，`T-999` 独立成行），而 `render-status.mjs` 的 `cell()` 把它压成单元格内一行（40 行恒定，竖线换成 `¦`）。因此**涉及收点判断必须以 `render-status.mjs` 的输出为准**，内联块只作快速一瞥；内联块保持兜底最小实现不加净化（理由与实测数据见 §13 B27）
- `/omz-doctor` → 自检：逐个 spawn 每个 agent 做 ping、校验 frontmatter model 与已登记供应商模型一致、检查 `.omz/` 是否在 .gitignore。**v1.5 装机实测：会话内 9/9 spawn ping 全部返回暗语**（V12 结清，§10.1）；spawn 回执同时带回子代理的**自报工具面与自报可见 skill 清单**，这两项是 B1 白名单行为级验证、B16 skill 可见性、以及 §4 第三层"引擎注入面"变化的常规探测手段

### 8.2 M2：UserPromptSubmit hook 关键词检测（复刻 IntentGate）

引擎 hook schema 已证实 UserPromptSubmit 可返回 `additionalContext`（注入能力存在，行为待实测 V3）。方案：node 单文件脚本扫描 prompt 关键词 `ulw`/`ultrawork`/`team`/`hyperplan`，命中则注入对应模式提示词。

- **`matcher` 在 `UserPromptSubmit` 上不参与筛选（v1.4 末轮引擎反查确证，**推翻本条 v1.4 原文的"省开销"说法**）**：引擎 `hookRunner.run(t, r = {})` 的匹配判定是 `n6r(r, c.matcher)`——**匹配值取自第二个参数（options），不是事件负载**；而 `runUserPromptSubmitHooks`（引擎符号 `RUr`）调用时只传 `{ signal }` 作为 options，**不传 `matchValue`/`matchValues`**。`n6r(e, t)` 的实现为 `if (!t) return true; let r = [...e.matchValues ?? [], ...e.matchValue ? [e.matchValue] : []]; return r.length === 0 ? true : [...new Set(r)].some(n => r6r(n, t))`——matcher 存在但匹配值为空时命中 `r.length === 0` 分支，**无条件返回 true**。故 `[Uu][Ll][Ww]|[Uu][Ll][Tt][Rr][Aa]|[Tt][Ee][Aa][Mm]|[Hh][Yy][Pp][Ee][Rr]` 这条大小写展开正则在本事件上**一次都不会拦掉任何 prompt**。保留它是**无害的意图声明**（同一 schema 用于工具类事件时 matcher 对工具名确实生效，且引擎 matcher 区分大小写，§1.5.2，字符类展开写法本身没错），但**不得再宣称它省开销**——匹配根本没发生。
- **启用后的固定成本（实测）**：没有粗筛意味着 `keyword_hook` 一旦启用，**每条用户消息都会启动一次 node 进程**，与关键词是否命中无关。实测 hook 进程约 **126–132ms**（同机裸 `node -e 0` 基线 85–91ms，即脚本自身约 40ms，其余是 Node 启动税）。这是启用 M2 的固定入场费；默认不启用 `keyword_hook` 因此不只是"注入行为未验证"的保守，也是一条成本决策。真正的判定全在脚本内（精判）。
- **独立词边界与代码上下文排除**：关键词必须是独立词（两侧不是 ASCII 字母/数字/下划线/连字符——`\b` 对中文不可靠），且落在行内反引号、三反引号块、引号字符串、含 `/` 或 `.` 的路径 token **之外**。多模式同时命中时优先级 `hyperplan > team > ulw`（更具体者优先）。
- **大小写归一的索引陷阱（v1.4 实测）**：必须**先 `toLowerCase()` 再做屏蔽**（单一字符串）。曾用"原串屏蔽 + 各自 toLowerCase 后比索引"的写法，而 `toLowerCase` 可改变字符串长度（如 `İ` → 2 字符），一旦屏蔽区之前出现此类字符，索引即错位，真实意图被静默吞掉。
- **扫描预算（v1.4 新增，B29）**：屏蔽分析的输入窗口 `MAX_SCAN = 32KB`（头 24KB + 尾 8KB 两段独立分析，避免头窗未闭合的三反引号跨越拼接点吞掉尾窗），自我时间预算 `SCAN_BUDGET_MS = 1500`（对齐 `timeoutMs: 3000` 的一半）；超预算返回不注入 + `reason: 'budget-exceeded'`。宁可漏检一次（用户仍可显式打 `/ulw`），也不能被引擎超时杀掉而输出零字节。
- **注入体预算（v1.5 按引擎取证重写）**：判定对象是 **stdout 的完整 JSON 负载**——`payloadBytes(text) = Buffer.byteLength(JSON.stringify({additionalContext}), 'utf8')`，不是 `additionalContext` 字符串。引擎缺省 `maxOutputBytes` 是 **32768**（本机 `zcode.cjs` 五处同值；旧文里的 65536 来自 `hooks.json` 顶层那个引擎从不读取的死字段，v1.4 已删），故自我预算取 `MAX_PAYLOAD_BYTES = 24576`（32768 − 8192，即 25% 余量——用户或工作区配置可能把 `maxOutputBytes` 调得更小，而 hook 进程拿不到那个值）。**超限不是截断，而是整段注入静默消失**：`OutputCollector.append()` 在 `inlineBytes >= maxInlineBytes` 后丢弃余下 chunk（只置 `truncated` 标记，hook 路径从不读它），随后 `parseHookStdout()` 对半截 JSON 执行 `try{JSON.parse(r)}catch{return}` → `undefined`，没有 kill、没有非零退出码、没有报错，唯一症状是"hook 好像没生效"。因此降级为**三级**：`full` → `headings`（头部 + 全部章节标题清单 + 提示）→ `minimal`（头部 + 一行"请显式执行 `/<mode>`"），末尾还有 `fitToPayload()` 硬裁兜底，保证不存在"降级了但仍超限"的返回路径；头窗大小用**二分实测负载**求（转义密集输入下线性回减会一次把头窗砍到 0）。`MAX_CONTEXT_BYTES` 仅保留为**派生参考量**（`MAX_PAYLOAD_BYTES - 24` = 24552），**不参与任何判定**。实测：`ulw.md` 的 JSON 负载 **11372** 字节，对预算余量 2.16x（对引擎缺省 2.88x）；`tests/hooks.test.mjs` 同时钉住不变量（预算 + 余量 ≤ 引擎缺省）与这条余量的回归哨兵。
- **去重**：会话级标记 `.omz/.mode-injected-<sessionId>`，同会话同模式只注入一次；`sessionId` 与 `projectRoot` 都要做路径安全化（B22 同源的穿越面）。
- **斜杠命令排除**：输入以 `/` 开头时不注入（命令已展开，防双重注入，§13 B5）。
- **Windows 实现**：hook 用 `type: "process"` + `args[]`（**不经 shell**，从根上消除 B15 的路径空格与 shell 解析差异；这比 v1.3 方案的"命令串加引号"更强）；解释器写 `node`，脚本路径用 `${ZCODE_PLUGIN_ROOT}`。
- **输出 schema 严格**：引擎对 hook stdout 做严格校验，**多一个键就整体丢弃并记为 failed**。因此不注入时输出纯 `{}`，注入时只带 `additionalContext` 单键；`mode`/`reason` 等诊断信息一律走 stderr。
- **三层开关，只有后两层是真闸（v1.4 末轮确证，取代原"两道开关"的存疑表述）**：
  1. **`hooks.json` 顶层 `enabled: false` —— 纯装饰**。`parsePluginHookEvents` 只读 `rawHooks.hooks`，**通篇不碰顶层 `enabled`**；而且只要存在任何插件 hook，引擎就**强制**把 hook runner 置为 `enabled: true`。所以这个字段既不被插件加载链读取，也不会让引擎少注册一条 hook——它只是给人看的意图声明（保留无害，但别指望它关掉什么）。
  2. **hooks 数组**元素级**的 `enabled: false` —— 运行层真闸**。单个 hook 对象里的这个字段**是被读取的**（加载链里 `o.enabled === false ? [] : ...`，直接把该 hook 从贡献列表里剔除）。这是唯一能在**引擎层**让 node 进程根本不被启动的位置，也因此是唯一能省掉上一条那 126–132ms 固定成本的开关。
  3. **`omz.keyword_hook !== true` —— 语义层真闸**。脚本自己读配置（§15.5 默认值），不启用时输出纯 `{}` 立即退出。进程仍然会起（成本已付），但不注入任何东西。
  **想彻底关掉**：把 `hooks/hooks.json` 里 `UserPromptSubmit[0].hooks[0]` 的对象加上 `"enabled": false`（进程都不起），或直接删除该 hook 条目；只把顶层 `enabled` 留成 `false` **不等于关掉**——它当前的实际效果仅是"配置里写着我们不想开"。默认发行态同时满足 2、3 两层中的第 3 层（`keyword_hook: false`），成本层若也要省则再补第 2 层。
- **降级**：V3 实测失败则永久 M1。

---

## 9. 分阶段实施计划

**状态列为 v1.5 实际完成情况**（v1.3 全部规格已实现并通过 578 个测试；**v1.5 补装机后真实会话验收**）。

| 里程碑 | 内容 | 验证标准 | v1.5 实际状态 |
|---|---|---|---|
| **M0 验证**（半天） | §10 验证清单（8 项已实测 + V9/V12 已结清，V3/V4/V8′ 待真实会话） | 每项结论写入本文档 | ✅ **完成**（8 项实测 + 三轮引擎反查 + **v1.5 第四轮装机后行为级实测**，§10.3）；V3/V4/V8′ 仍待真实会话（本次验收路径与其无交集，§10.2） |
| **M1 核心闭环** | 9 agents + 内置 Explore + /ulw + /hyperplan + /omz-status + /omz-doctor + .omz/ + boulder.json 跨会话指针 | `/ulw 一个跨 2 文件的小特性` 全流程跑通（含评审门与双证据；quick 类按省流阀不 spawn，属自查项）；omz-doctor 全绿；中断后新会话可续跑（B18） | ✅ **完成（v1.5 装机验收）**：① `/omz-doctor` 在真实会话内 **9/9 spawn ping 返回暗语**（V12 结清，连带结清 B16、给出 B1 行为级确证，§10.1）；② **冒烟 `/ulw` 全流程已跑通**——两轮评审门（critic 4 blocker 打回 + reviewer `needs-fix` → 复审 `confirmed`）、双证据、AdversarialVerify 判 `confirmed`，终态 8/8/0 测试全绿（可复现链路见 §18）。剩余项：B18 的"中断后新会话续跑"未在本次冒烟中单独演练（冒烟一气跑完，未制造中断），第零步的确定性回退与 `active_goal` 指针已实测有效（§13 B30） |
| **M1-G graph profile** | 安装锁定版本 CodeGraph；每个目标项目 `codegraph init`；ZCode workspace stdio MCP 自动连接 | `codegraph_explore` 返回正确项目/HEAD 相关源码；索引陈旧时 doctor 报警并回退 | ⏳ **待装机**：本机无 codegraph（doctor 报 WARN）；`probeCommand` 的 `.cmd` shim 问题已修；V10 待验 |
| **M2 orchestration** | coordinator MCP + SQLite WAL + DAG/mailbox/lease/heartbeat/retry；3 个无依赖任务并行 | 压测无重复 claim；断 worker 可 reclaim；状态与 DoneClaim 对账；coordinator 故障回 core | ✅ **代码完成 + 并发压测已过**：13 工具、7 态机、终态守卫/一次性消费/不变量检测均已实现并测试；**8 进程抢 200 任务重复 claim=0、`SQLITE_BUSY` 重试 0、不变量 0 violations**（§10.1 V9、I4 条款已履行）。剩余：`SQLITE_BUSY` 退避路径在该负载下未被触发（覆盖面缺口，非正确性缺口）；**v1.5 新增注意**：worker 侧看得见 MCP 工具（§10.3 第 12 条），调用权靠纪律约束（§7.2/§7.4） |
| **M2 触发增强** | 关键词 hook（V3 通过则启用） | 免斜杠说 "ulw ..." 触发；hook 失败仍可用 slash command | ⚠️ **代码完成，待 V3**：hook 已实现（含 B29 修复）、self-test 30/30；默认 `keyword_hook: false`（语义层真闸，§8.2 三层开关），注入行为待真实会话验证；启用后每条消息固定付 126–132ms（matcher 不筛，§8.2）。**v1.5 冒烟走的是斜杠命令路径，未触发 hook，故 V3 未随之结清** |
| **M3 dashboard** | Electron dashboard/SSE + GUI 任务面板；展示 agents/DAG/mailbox/audit | loopback 之外拒绝；XSS/ANSI/超长 payload 安全；dashboard 关闭不影响调度 | ⚠️ **代码完成，待 Electron 真机**：server 侧鉴权分层（I10）、连接上限、字段净化（B27）已测；本机无 electron，只验证了降级分支（V11） |
| **M4 打磨** | Stop hook 终止核对（宪法清单完成度）、review-work skill、模型分档接入 | 异常终止时未达标工作不产生"完成"结论 | ❌ **Stop hook 未实装**（§17 裁决 4）；review-work skill ✅ 已落盘；模型分档接入待用户按自己已登记的模型填 frontmatter `model` |

## 10. 验证清单（M0：8 项已实测 + V9/V12 + `/ulw` 端到端冒烟已结清，V3/V4 + V8′/V10/V11 待实测）

v0.5 起本表为**实测结果表**。2026-09-01 于 ZCode 3.10.2 实机完成六项活体验证（方法：用户级探针 agent `omz-probe` + 嵌套 spawn 实验 + 引擎 `zcode.cjs` 反查）。v1.4 补充实现期的第二轮符号级反查结论（§10.3）与四项新的待实测项（V9–V12）；v1.4 末轮新增第三轮反查（§10.3 第 7–10 条），并把 V8 的枚举部分与 V9 的并发压测移入已实测。**v1.5 装机后在真实 ZCode 会话内完成三项验收**（`/omz-doctor`、`/omz-status`、`/ulw`）：**V12 结清并移入 §10.1**（连带结清 B16、给出 B1 的行为级确证、复验 V5/B20/§17 裁决 2），`/ulw` 端到端冒烟作为 M1 验证标准跑通（链路见 §18），另得**五条新事实**（§10.3 第 11–14 条 + §10.1 V6 修订）。§10.2 现只剩**五项**真正需要真实会话/真机/装机的项。

### 10.1 已实测结论

| # | 验证项 | 结论 | 实测证据 |
|---|---|---|---|
| V1 | 用户级/项目级 agents 目录发现 | ✅ **代码路径已证实**：agent `.md` 从两个文件系统来源加载（`loadZCodeAgentProfiles`）——`storageRoot/agents`（storage.dir 默认 `~/.zcode`，即 **`~/.zcode/agents/*.md`**）与 `<工作区>/.zcode/agents/*.md`（source=project），外加插件 `agents/`（source=plugin，由 `loadPluginAgentProfiles` 单独加载） | 引擎代码：`[{path:join(storageRoot,"agents"),source:"user"},{path:join(workingDirectory,".zcode","agents"),source:"project"}]`。**边界发现**：本会话 spawn `omz-probe` 报 not found（可用列表 = general-purpose/Explore/judge，与文件创建前一致）——**agent 清单是会话启动时快照，运行中新增文件当前会话不可见**（详见 §13 B19）。文件本身合法（嵌套子代理核查 frontmatter/格式无误），新会话应可发现 |
| V2 | frontmatter 字段生效性 | ✅ **解析链已证实**（代码级）：解析 `name`（必填）/`description`（必填，缺失报 `agent_missing_frontmatter`/`agent_invalid_*` 诊断码）/`tools`/`model`/`thoughtLevel`/`permissionMode`/`maxTurns`/`memory`（枚举 user/project/local）/`color`/**`mcpServers`**（agent 级 MCP 白名单，新发现）。tools 数组形式（judge.md 实证）。**project 来源的 `permissionMode` 被 `sanitizeProjectAgentProfile` 直接剥离**（v1.4 精确化：v1.2 写的"特殊处理/强制覆盖"不准确——字段被删除，不是被改写；对以插件形态分发的 OMZ 无影响）。继承工厂存在（未写 model 继承主会话）。**v1.5 补行为级确证**：`tools` 白名单在真实会话内逐 agent 生效（V12），不再只是解析链推断 | 引擎 `loadZCodeAgentProfiles` / `loadPluginAgentProfiles` / `sanitizeProjectAgentProfile` 三函数 + judge.md 样本。**装机后的行为级确认已完成**（§10.1 V12：9 个 agent 的实测工具面逐项与 frontmatter 吻合） |
| V5 | 子代理嵌套 | ✅ **结构性阻断，已证实**：子代理会话**不暴露 Agent 工具**（实测工具清单：AskUserQuestion/Bash/Edit/Read/Skill/TaskOutput/TaskStop/TodoRead/TodoWrite/WebFetch/Write/ReadSessionContext + RespondToCoordinator + MCP 组，无 Agent 工具）。嵌套 spawn 在工具层直接不可能——OmO 的 depth 上限问题在 ZCode 上**不存在**（防无限委派循环是结构保证，非提示词纪律） | 2026-09-01 嵌套实验：子代理报告"无 Agent 工具，spawn 无法发起"。这同时把 v0.2 的 V5 假设（靠提示词防循环）推翻为**无需防护**。**v1.5 装机复验**：9 个 OMZ agent 在真实会话内逐个 spawn，**无一持有 `Agent` 工具**（含三个全工具角色），结构性阻断在 OMZ 自有角色上同样成立（§10.1 V12） |
| V6 | 子代理 skills 可见性 | ✅ **可见，但数量因角色而异（v1.5 装机实测修订 v0.5 的"全量可见"）**：v0.5 实测为"完整技能列表 36 个"；v1.5 会话内逐个 spawn 得到**三档**——`omz-junior`/`omz-atlas` 见 **40 个**，`omz-deep`/`omz-reviewer` 见 **34 个**，其余五个（planner/critic/oracle/librarian/looker）见 **33 个**。**分档机制未查清**（可能与工具面或 `skillMetadataBudget` 相关，不影响结论）。**对 OMZ 无影响**：四个自有 skill（`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`）在**各档下均可见**且带 `omz:` 命名空间前缀（已逐个确认）→ B16 结清 | v0.5 嵌套实验（36 个）+ **v1.5 `/omz-doctor` 会话内 9 次 spawn 的自报清单（33/34/40 三档）**。结论表述从"全量可见"改为"可见但数量因角色而异，OMZ 自有 skill 在各档均可见"；委派 prompt **不需要**内联 skill 摘要（B16 的回退方案作废） |
| V7 | TodoWrite 会话隔离 | ✅ **共享实现已证实**：子代理有 TodoWrite 工具（实测工具清单包含），引擎 `subagentNames` schema 将子代理任务纳入投影。**协议层规定成员进度只写 results 文件、TodoWrite 仅各自内部使用**（B7 原方案），设计天然免疫 | 工具清单实证 + 引擎 schema。精确的跨会话可见性边界（子代理 todo 是否投影到主 agent 视图）不影响设计——协议不依赖它 |
| V8 | frontmatter `permissionMode` **枚举值** | ✅ **枚举已直接取出（v1.4 末轮引擎反查）**：`["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]`（引擎符号 `XQo`）；子代理映射（`Fsi`）：`bypassPermissions`/`dontAsk` → yolo、`acceptEdits` → edit、`auto` → auto、`plan` → plan、`default`/未写 → **继承会话**。**不再需要装机**。**关键推论**：枚举里**没有任何值能移除单个工具**——最接近的 `plan` 是全局模式而非工具白名单，因此"用 `permissionMode` 把只读角色的 Bash 收成结构约束"这条路**走不通**（§17 裁决 3 已据此改为终态表述）。剩余待实测的只有并行 spawn 时的弹窗行为（→ §10.2 V8′、§13 B2） | 引擎 `zcode.cjs` 符号 `XQo`（枚举）与 `Fsi`（子代理权限映射）。project 来源该字段被 `sanitizeProjectAgentProfile` 删除（V2），插件形态不受影响 |
| V9 | 多进程并发 claim 压测 | ✅ **已完成（v1.4 末轮本机实测）**：**8 个独立 node 进程**抢同一 graph 的 **200 个任务** → **730ms** 内完成 200 次 claim，**unique = 200、重复 claim = 0**，**`SQLITE_BUSY` 重试 0 次**，`verifyGraphInvariants` 返回 `ok=true / 0 violations / checked=200`。另跑 `max_parallel=8` 的 40 任务图：单进程拿到 8 个后其余 **52 次全部返回 `reason:'max-parallel'`**，限流生效。`busy_timeout=5000` + `BEGIN IMMEDIATE` 在该负载下**未进退避路径** | 本机压测工件。**诚实边界**：`SQLITE_BUSY` 退避代码路径本身**仍未被触发覆盖**——不是缺陷，是该负载（短事务 + 单机 8 进程）下根本没触发；更高竞争度或慢盘环境下的退避行为仍属推断。I4 的"8 并行前先压测"条款至此**已履行** |
| V12 | 真实 ZCode 会话内的 9 个 agent spawn ping | ✅ **已完成（v1.5 装机后真实会话实测）**：`/omz-doctor` 在会话内逐个 spawn 9 个 agent，**9/9 全部返回 `OMZ-PONG`**，无一 not found。① **双入口均生效**：bareName 与 `omz:` 命名空间前缀都可 spawn（实测用**裸名** `omz-planner` 等成功，证实 §10.3 第 2 条的"唯一裸名别名"规则）；② **只读白名单行为级生效**（B1 的确证，此前只有静态校验）：critic/oracle/reviewer/librarian/looker 五个受限角色的实测工具面**均无 Edit**，deep/junior/atlas 三个全工具角色**有 Edit**，逐项与 frontmatter 吻合——`omz-planner` → `Bash, Read, Write`；`omz-critic`/`omz-oracle`/`omz-reviewer`/`omz-looker` → `Bash, Read`；`omz-librarian` → `Bash, Read, WebFetch`；`omz-deep`/`omz-junior`/`omz-atlas` → 全工具（含 Edit/Write/Skill/TodoWrite/TaskOutput/TaskStop/AskUserQuestion/ReadSessionContext/WebFetch + MCP 组）；③ **9 个全部无 `Agent`**（V5 行为级复验）、**全部无 `Grep`/`Glob`**（B20 复验）、**连全工具角色都没有 `WebSearch`**（§17 裁决 2 的行为级确证：引擎有该工具名且归入 `isReadOnlyTool`，但当前部署的实际工具面里确实没有它）；④ **OMZ 四个 skill 在子代理侧全部可见**且带 `omz:` 前缀 → **B16 结清**（委派 prompt 不需内联 skill 摘要）；⑤ **新事实**：9 个工具面**全部多出 `RespondToCoordinator`**（frontmatter 未声明、不受白名单约束，§10.3 第 11 条、§4 第三层） | 装机后重启会话（B19）→ `/omz-doctor` ① 项的 9 次 spawn 回执（每次含暗语 + 自报工具面 + 自报可见 skill 清单）。**这一项同时结清 V12 本身、B16、B1 的行为级验证，并复验 V5/B20/裁决 2** |
| — | 后台 agent 完成通知（V4 前置） | ✅ **已证实**：后台子代理完成后 `<task-notification>` 异步送达主 agent，含完整 result 摘要与 usage（本节证据即由后台 Explore 代理的完成通知产出） | 2026-09-01 两次后台代理实测（调研代理 + 嵌套实验代理均在主会话收到完成通知） |
| — | `/ulw` 端到端生命周期（M1 冒烟标准） | ✅ **已跑通（v1.5 装机后真实会话）**：一个真实 Node ESM 项目上跑完 planner → critic（4 blocker 打回）→ rev2 → 两轮 junior 执行（failing-first 真的红）→ reviewer（第一轮 `needs-fix`）→ 修完复审 `confirmed`；终态 `npm test` 8/8/0、四条 SC 全 done、boulder `status: done`、`.omz/` 卫生扫描零缺陷 | 完整可复现链路见 **§18**（含 critic/reviewer 的具体发现、内存重放取证法、证据缺陷判据）。**插件仓库未被污染**：全程在系统临时目录，`<插件仓库根>/.omz/` 不存在 |

### 10.2 保留待实测（2 项设计期遗留 + 2 项待真机/装机 + 1 项部分完成，共五项）

设计期两项（V3/V4）**仍未实测**，原因一致：两者都必须在**真实 ZCode 会话内**执行——hook 注入行为要看引擎把 `additionalContext` 送进哪层上下文、resume 要有活的 `agent_id`，离线环境（node 直跑脚本 + 单元测试）无法替代。**v1.4 末轮变化**：V8 的枚举值已由引擎反查直接取出（只剩弹窗行为待验），V9 的并发压测**已在本机完成**（下移至 §10.1）。**v1.5 装机变化**：**V12 已在真实会话内结清**（9/9 spawn ping 全部返回暗语，下移至 §10.1），因此本表从六行减为**五行**；V3/V4 未随之结清——`/omz-doctor` 与 `/ulw` 都走斜杠命令路径（不触发 hook 注入），冒烟全程用任务级新 spawn（不触发 resume），两项与本次验收的执行路径**没有交集**。

| # | 验证项 | 现有证据 | 验证方法 | 失败回退 |
|---|---|---|---|---|
| V3 | UserPromptSubmit hook `additionalContext` 实际注入行为 | 引擎 hook schema 已证实字段存在；OMZ hook 已实现且 `--self-test` 30/30 通过（输入解析/关键词判定/去重 marker/预算控制全绿），但**注入是否被主 agent 真正看见未验证** | 真实会话内开启 hook（注意：顶层 `enabled` 不被读取，真闸是元素级 `enabled` 与 `omz.keyword_hook`，§8.2），说裸 `ulw ...` 观察是否进入 ultrawork | 永久 M1 斜杠命令（slash commands 零风险已实证）；不启用 `keyword_hook` 即此回退的常态形态 |
| V4 | resume 适配器行为（同一运行期续用、通知时序、上下文保留、会话关闭边界） | 工具层可见 `agent_id`/`SendMessage`；官方公开文档未承诺稳定 resume API | 真实会话内 spawn→完成→SendMessage→追加任务；再关闭/重开会话测试边界 | 任务级新 spawn + coordinator 状态恢复，不依赖 resume（当前实现即基线形态） |
| V8′ | **仅剩：并行 spawn 时的权限弹窗行为**（枚举值已知，见 §10.1 V8） | 枚举与子代理映射已由引擎符号反查直接取出（`XQo`/`Fsi`，§10.1）；**弹窗时序/是否阻塞其他 spawn 未验** | 真实会话内定义不同 `permissionMode` 的 agent 并行 spawn，观察弹窗是否串行阻塞 | 用户把会话权限模式调宽后再用 /team（§13 B2 兜底）。**注意**：这一项**不再承载"收紧只读角色 Bash"的期待**——枚举里没有任何值能移除单个工具（§17 裁决 3） |
| V10 | CodeGraph 装机后 `codegraph_explore` 真实返回与索引新鲜度判定 | 上游 README/MCP tools 源码交叉核验；本机**无 codegraph 可执行文件**（doctor 报 WARN）。`probeCommand` 的 Windows `.cmd` shim 查找问题已修（按 PATHEXT 逐后缀查找） | 安装锁定版本 → `codegraph init` → 查询后改文件不重建索引，确认 doctor 能报 stale；重建后返回含新内容（§13.5 I1） | graph profile 保持关闭，回退 Explore + Bash grep/rg |
| V11 | Electron dashboard 真机渲染与 CSP 实际拦截效果 | 本机无 electron，**只验证了降级分支**（`dashboard/main.mjs` 在 electron 缺失时退回纯 HTTP server；server 侧的 token 门/loopback 绑定/静态壳分层已有测试） | 安装 electron 后开窗，注入 `<script>`/ANSI/超长 payload，确认 CSP 拦截、无执行、无布局崩溃（§13.5 I5） | dashboard profile 保持关闭，回退 ZCode GUI 任务面板 + `/omz-status` |

### 10.3 引擎取证补遗

**第一轮（v0.5/v1.2 时期）**：

- **storage.dir 默认值 = `~/.zcode`**（`join(homedir,".zcode")`），可被 `~/.zcode/cli/config.json` 的 `storage.dir` 与环境变量覆盖——用户级 agent 目录就是 `~/.zcode/agents/`（修正 v0.2 "运行痕迹目录"的误认：`~/.zcode/cli/agents/sess_*/` 是子代理运行时输出，定义文件在 `~/.zcode/agents/`）。
- **agent frontmatter 支持 `mcpServers`**（agent 级 MCP 白名单）——OMZ 可为 looker 配独立视觉模型 MCP，能力超原设计假设。
- **slash command 展开链**：`expandCustomCommandPrompt` 处理 `$ARGUMENTS`/`$1..$N`/`` `!cmd` ``/` ```! ` 执行块。
- **子代理工具清单**（实测）：无 Agent 工具（防嵌套）、无 Glob/Grep 独立工具（文件搜索经 Bash）、有 Skill/TodoWrite/TaskOutput/TaskStop、MCP 工具组可用（**v1.5 装机复验：全工具角色见完整 `mcp__openviking__*` 11 个 + `mcp__node_repl__js*` 3 个**，见下第 12 条）、**另有引擎注入的 `RespondToCoordinator`**（不受白名单约束，v1.5 新增，见下第 11 条）。
- **Agent 工具的 subagent_type 清单是会话级快照**（B19，详见 §13）。

**第二轮（v1.4 实现期符号级反查，代码级证据，比设计期的推断更硬）**：

1. **插件模板变量全集已确证**。引擎的展开正则精确为：

   ```
   ${(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)}
   ```

   插件 MCP 额外支持 `${user_config.KEY}`。**`${pluginDir}` 不在其中**——未识别的变量被**原样保留**（不报错、不置空），路径必然失效且难排查；v1.3 及更早文本在 §3.4 附近用过 `${pluginDir}`，属规格错误，实现统一改为 `${ZCODE_PLUGIN_ROOT}`。`ZCODE_SKILL_DIR`/`CLAUDE_SKILL_DIR` 在 hook 上下文会**抛错**（引擎明确 throw `Hook variable requires a skill context`），只能在 skill 上下文用。
2. **插件 agent 加载链已确证**（`loadPluginAgentProfiles`）：从 `<pluginRoot>/agents/<name>.md` 读取，解析后**强制加命名空间前缀** `<pluginName>:<bareName>`；若该 bareName 在所有插件里唯一且不与保留名冲突，**额外注册一个裸名别名**。保留名集合 = `new Set(["general-purpose","Explore"])`。bareName 冲突或撞保留名产生 `agent_ambiguous_name` 诊断（丢别名，命名空间名仍可用）。→ 对 OMZ：`omz-planner` 既可 `omz:omz-planner` 也可裸名调用；`omz-` 前缀策略被证实是对的（§3.4 命名规则）。
3. **用户级/项目级 agent 加载链**（`loadZCodeAgentProfiles`）确认设计期结论，精确形式见 §10.1 V1；`sanitizeProjectAgentProfile` 对 project 来源**删除 `permissionMode` 字段**（§10.1 V2、§1.5.2 已按此表述修正）。
4. **插件 hooks 加载链**（`collectPluginHookEvents`）：`<pluginRoot>/hooks/hooks.json` 需要外层 `hooks` 包裹（引擎读 `rawHooks.hooks`）；manifest 的 `hooks` 字段可以是路径字符串、路径数组或内联对象；不支持的事件名只产生 `plugin_hook_unsupported_event` **warning**，不是致命错误（因此拼错事件名会静默不生效——doctor 应对照支持事件表自查）。**v1.4 末轮追加三条（§8.2 已据此重写）**：
   - **插件 hook 与配置文件 hook 的 schema 形状不同**：配置文件侧是 `hooks.events.<Event>`，插件侧是 `hooks.<Event>`（**无 `events` 中间层**）。给插件 hooks.json 写 `events` 键 → 事件表为空 → 静默无 hook。
   - **顶层 `enabled` 不被读取**：`parsePluginHookEvents` 只取 `rawHooks.hooks`，通篇不碰顶层 `enabled`；且只要有任何插件 hook 存在，引擎就**强制**把 hook runner 置 `enabled: true`。真正被读取的是 hooks 数组**元素级**的 `enabled`（`o.enabled === false ? [] : ...`，该 hook 被整条剔除）。
   - **`matcher` 对 `UserPromptSubmit` 无效**：`hookRunner.run(t, r = {})` 用 `n6r(r, c.matcher)` 判定，匹配值来自第二参数 options；`runUserPromptSubmitHooks`（`RUr`）只传 `{ signal }`。`n6r` 在匹配值集合为空时**无条件返回 true**（`r.length === 0 ? true : ...`）。故该事件上 matcher 不筛任何东西，"不命中不启进程"是错的（§8.2 给出实测固定成本）。
5. **工具分类的引擎定义**：
   - `isReadOnlyTool` = `new Set(["Read","Glob","Grep","WebSearch","WebFetch","TodoRead","TodoWrite","AskUserQuestion","Agent","Task","Skill"])`
   - `isWriteTool` = `["Write","Edit","ApplyPatch","Bash"]`
   - `isDestructiveTool` = `["Bash"]`

   → **引擎自己把 Bash 归为 write + destructive**。这是对 v1.3 §4「只读角色工具白名单是结构性保证」的直接反驳：`tools: [Read, Bash]` 的角色**能写文件**（`>` 重定向、`node -e fs.writeFileSync`、`git checkout`）。已按 §17 裁决 3 改为分层表述（Edit/Write 结构约束 + Bash 只读纪律约束；v1.5 装机实测再补第三层"引擎注入面"，见下第 11 条与 §4）。
6. **插件 manifest 的 `agents` 字段与 `agents/` 目录不是一回事**：本机 `diagnosing-plugins` guide 说 `agents` 是 "recorded but not executed"，容易被读成"插件 agent 不生效"。准确关系是——manifest 里 `agents` 的**键值映射形式（内联声明）不执行**，但 `agents/` **目录会被 `loadPluginAgentProfiles` 扫描并注册**。OMZ 用的是目录形式（manifest 写 `"agents": "agents"` 指向目录），成立。记录此差异以免后人误删目录或误判功能失效。

**第三轮（v1.4 末轮复核，两条推翻既有表述、两条给出新事实）**：

7. **`permissionMode` 枚举与子代理映射已直接取出**：枚举（引擎符号 `XQo`）= `["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`；子代理权限映射（`Fsi`）：`bypassPermissions`/`dontAsk` → yolo、`acceptEdits` → edit、`auto` → auto、`plan` → plan、`default` 或未写 → **继承会话**。→ **V8 的枚举部分不再需要装机**（§10.1 V8）。**关键推论**：枚举调的是"批准动作的宽严"，**没有任何值能移除单个工具**，所以它**不能**用来把只读角色的 Bash 收成结构约束（§17 裁决 3 已改为终态表述）；用于**放宽**（缓解 B2 的弹窗阻塞）则可行。
8. **`matcher` 的匹配值来源与 `UserPromptSubmit` 的实际行为**：`hookRunner.run(t, r = {})` 用 `n6r(r, c.matcher)` 判定，匹配值取自**第二个参数（options）**；`runUserPromptSubmitHooks`（`RUr`）只传 `{ signal }`，不传 `matchValue`/`matchValues`；`n6r(e, t)` = `if (!t) return true; let r = [...e.matchValues ?? [], ...e.matchValue ? [e.matchValue] : []]; return r.length === 0 ? true : [...new Set(r)].some(n => r6r(n, t))`——空集合**无条件返回 true**。→ matcher 在该事件上**不参与筛选**，v1.4 §8.2 的"不命中连 node 进程都不启（省开销）"是**错的**，已撤回并补上实测固定成本（126–132ms/条消息）。
9. **主 agent 的上下文里没有 sessionId**：`${ZCODE_SESSION_ID}` 属第 1 条那张模板变量表，只在 **hook / MCP server / 命令的 shell 执行块**上下文展开；**Bash 工具的 env 里没有它**，系统提示词 `<env>` 块也只有 cwd/git/platform/shell/osVersion。→ 任何要求主 agent"按 sessionId 命名文件"的规格都会被模型用编造值满足（§13 B30 的假成功机理）；`/ulw` 改用 ` ```! ` 执行块取值 + 确定性回退。
10. **插件 MCP 的命名规则**：引擎给插件 MCP server 命名 `plugin:<pluginName>:<serverKey>`，工具暴露名为 `mcp__plugin_<pluginName>_<serverKey>__<toolName>`。→ OMZ 的 `omz_team_create` 真名是 `mcp__plugin_omz_omz-coordinator__omz_team_create`；文档表格里的裸名是逻辑名，调用方必须按后缀匹配自己的工具清单现取真名（§7.2 前言）。

**第四轮（v1.5 装机后真实会话实测，四条**行为级**新事实——来源是 `/omz-doctor` 的 9 次 spawn 回执与 `/omz-status` 的对照实验，不是引擎反查）**：

11. **子代理有 `RespondToCoordinator`，且它不受 frontmatter `tools` 白名单约束**。9 个子代理的实测工具面**全部含 `RespondToCoordinator`**——包括 `tools: [Read, Bash]` 这种最窄形态（`omz-critic`/`omz-oracle`/`omz-reviewer`/`omz-looker`）。该工具**没有在任何 agent 的 frontmatter 里声明**，是**引擎注入**的。
    - **结论性表述**：**只读角色的真实工具面 = frontmatter 白名单 ∪ 引擎注入工具**。白名单是"我们能声明什么"的上界，**不是工具面的全集**；后者由引擎决定，OMZ 侧没有控制点。这对 §4 的只读性模型是一个补充维度（**第三层：引擎注入面**），已写进 §4。
    - **对 `tools/validate-frontmatter.mjs` 的影响**：`SUBAGENT_TOOLS` 清单里**没有 `RespondToCoordinator`**，属**清单不完整**。**当前不构成问题**——它是引擎注入的，没人会在 frontmatter 里声明它，因此校验器不会因缺项而误报（只有真去写它才会落到 `unknown` 分支）。记录此事实的意义在于：清单的语义是"可声明的工具面"，不是"子代理实际持有的工具面"，两者不可混用；将来若要用该清单做"工具面全集"推断，必须先补齐引擎注入项。
    - **旁证**：`ENGINE_ONLY_TOOLS.SendMessage` 的说明里早已写着"子代理回话走 RespondToCoordinator/最终输出"，说明工具存在这件事此前就知道，只是**没登记进 `SUBAGENT_TOOLS`、也没写进本设计文档的工具面清单**。
12. **子代理能看到 MCP 工具组（完整、不是子集）**。全工具角色（`omz-deep`/`omz-junior`/`omz-atlas`）的实测工具面含完整的 `mcp__openviking__*`（**11 个**）与 `mcp__node_repl__js*`（**3 个**）。
    - **推翻的前提**：`commands/team.md` 第 4 步那句约束的**理由**里写了"子代理未必在工具面里看得到它"——**"worker 看不见 MCP"这个前提不成立**。如果 coordinator MCP 启用，worker 侧**很可能直接看得见** `mcp__plugin_omz_omz-coordinator__*` 全套工具。
    - **约束本身仍应保留**（§7.2/§7.4 已据此补写）：能看见 ≠ 该自己调。认领/汇报的语义由主 agent 把控——**协议靠纪律而非可见性来约束调用权**。这是一次"理由错了但结论对"的修正：不改行为，改的是为什么。
13. **子代理可见的 skill 数量因角色而异**（修订 v0.5 的"全量可见 36 个"）：`omz-junior`/`omz-atlas` **40 个**、`omz-deep`/`omz-reviewer` **34 个**、其余五个 **33 个**。分档机制**未查清**（可能与工具面或 `skillMetadataBudget` 相关）。**不影响 OMZ**：四个自有 skill 在各档下均可见且带 `omz:` 前缀（逐个确认）→ §10.1 V6 结论已改写、B16 结清。
14. **内联执行块与 `tools/render-status.mjs` 在注入净化上有可观测的能力差**（B27 的行为级数据）：同一个恶意 title 下，内联块**渲染出多一行伪造任务**，`render-status.mjs` 的 `cell()` 把它压成单元格内的一行。→ `commands/omz-status.md` 里"以 `render-status.mjs` 为准"**不是免责声明，是真实的能力差**（内联块是兜底最小实现，不含 `cell()` 净化）。实测数据与结论见 §13 B27、§8.1 `/omz-status` 条目。

## 11. 与 OmO 的差距与本土化补齐边界

**不应再称为“只能降级”**：`codegraph_explore` 可直接接入上游 CodeGraph MCP；Team/DAG/dashboard 的语义可通过 OMZ coordinator 与 Electron 组件补齐（§3.4、§7.2）。

| 能力 | 当前本土状态 | 仍有的真实差异 |
|---|---|---|
| codegraph | graph profile 直接接入 MIT `@colbymchenry/codegraph`；core profile 回退 Explore+Bash | 上游返回文本 ToolResult；索引新鲜度需自行校验；不复制 OmO Codex bridge |
| Team Mode | coordinator MCP + ZCode Agent worker + SQLite registry/mailbox/lease/heartbeat | 无官方 Team API；worker 非常驻内存；不能保证原生 P2P 或自动跨重启 resume |
| DAG | coordinator SQLite `task_deps` + atomic claim + lease/retry；无 coordinator 时波次回退 | 工具名不同；单机 SQLite single-writer；不使用 ZCode 闲时任务 FIFO 冒充 DAG |
| tmux | Electron dashboard/SSE + ZCode GUI 任务面板；Windows Terminal 调试旁路 | 无原生 tmux pane 的交互式终端；dashboard 是独立可选组件 |
| 模型回退链 | frontmatter `model`/`thoughtLevel` + doctor 校验；失败时重派 | ZCode 无 OmO 同等自动 fallback chain |
| primary 主会话角色 | 主 agent 固定，角色经 Agent 工具派生 | 无 OpenCode primary 模式 |
| hooks | 保留 ZCode 七事件；按同步语义实现 | 事件数量少；网页 async 说明与本机 guide 冲突，未验证前不依赖 async |
| Dynamic Agent | 固定 9 个 agent 文件 + 内置 Explore（10 角色）+ category 路由 | 无 OmO 动态 prompt builder |

**保留的 OmO 核心协议**：ultrawork 全生命周期、category 路由、访谈式规划、评审门、双证据、DoneClaim/AdversarialVerify、9 个对抗类、LIGHT/HEAVY、checkbox/EXPAND/claim 过门、5-lane review、Boulder 与 worktree 纪律。

**ZCode 侧增强**：子代理有真实 Read/Bash；嵌套委派工具层结构性阻断；skills 全量可见（V5/V6 实测）；CodeGraph、coordinator、dashboard 均可按 profile 独立启停，不污染 core。

## 12. 负面影响与成本模型

多 agent 编排是 token 放大器，也是失控面放大器。装 OMZ 前应通读：

### 12.1 Token 成本倍增
- **固定税**：9 条 description 常驻系统提示词（§4 预算纪律 ~400 token；第 10 个角色是内置 Explore，不额外计税）。
- **放大税**：每个子代理全新上下文（系统提示词 + 7 要素 prompt + 自读文件），N 个并行成员 ≈ N 倍上下文构建；主 agent 还要消化返回摘要。
- **模式税**：/ulw 提示词本体很长（八步生命周期全量注入）。
- **触发税（v1.4 末轮实测补充）**：启用 M2 关键词 hook 后，**每条用户消息**都会启动一次 node 进程（约 **126–132ms**，裸 `node -e 0` 基线 85–91ms）——`matcher` 在 `UserPromptSubmit` 上不参与筛选，所以这笔延迟与关键词是否命中无关（§8.2）。它是挂钟延迟而非 token，但同属"装了就一直在付"的固定成本，默认不启用 `keyword_hook` 的理由之一。
- **省流阀（内置）**：① quick 类主 agent 自己干；② 返回正文 ≤20 行摘要，全文写 results；③ 简单 writing 主 agent 直写；④ 无依赖探索用最轻的内置 Explore。

### 12.2 上下文膨胀与污染
后台 agent 完成通知异步插入，多成员并行时交错——TodoWrite 登记"等待中"；M2 hook 去重（§8.2）；10 个角色的选择空间变大导致弱模型过度委派——省流阀写成 MUST 规则。

### 12.3 resume 与通知时序
resume 成员后台跑、通知异步回，与波次同步收点存在竞争。规则：**波次推进以 results 文件为准，不以通知为准**；等待中的 resume 登记 TodoWrite；超时（10 分钟）主动查状态文件。

### 12.4 无 primary 模式的转述损耗
深度执行必经主 agent 转述——转述不全则子代理瞎干（最常见质量事故）。缓解：CONTEXT 强制含"关键文件路径清单 + 已确认事实 + 相关历史决策"，宁冗勿省；omz-deep 首步复核转述，发现缺口立即回报而非猜测。

### 12.5 状态文件竞态
一文件一写者纪律（§3.3）。残余风险：lead 自身并发（同时两个 /team）——`.omz/runtime/<teamId>/` 的 per-team 文件区隔离 + coordinator 库内 `team_id` 外键隔离（**不是分库**，§3.5 v1.4 修订）+ /team 提示词规定同时只允许一个活跃团队。

### 12.6 深度执行的失控面
omz-deep 全工具 + 后台 + 长时自主。护栏（v0.3 强化）：① frontmatter `maxTurns` 硬上限（结构性，非提示词约定）；② `max_wall_clock_minutes` 预算（默认 120）；③ MUST NOT DO 强制写禁区（如"不得删 .omz 外任何文件"）；④ Stop hook（M4）异常终止落盘 boulder.json 供人工接管；⑤ 高危操作（删除性命令、外部发布类）由主 agent 亲自执行。

### 12.7 环境与兼容性
Windows 无 tmux 原生 pane，但展示层有 dashboard/GUI fallback；hook 全 node 实现；`.omz/` 必须进 .gitignore（/omz-doctor 自动检查并提示追加）；状态文件路径统一正斜杠相对路径（§13 B3）；CodeGraph/coordinator/dashboard 只在对应 profile 启用，不影响 core；与现有插件共存（document-skills 的 judge 审渲染工件，omz-reviewer 审代码变更，职责不相交；omz- 前缀防撞名）。

---

## 13. 移植 bug 预案与实测缺陷（B1–B31）

按严重度与发现时间排序。每条：**现象 → 根因 → 解决方案 → 验证/兜底**。B1–B18 是设计期写好的预案（M0/M1 实施时逐条对照，命中即按预案处理）；B19–B21 是 v0.5 实测/审计发现；**B22–B30 是 v1.4 实现与审计期实际命中的缺陷**（不是推演，每条都有对应测试或已实施的修复）。

### B1【高】tools 字段格式写错导致 agent 加载失败或白名单不生效
- **现象**：omz-reviewer 仍然能改代码（白名单失效），或整个 agents 目录加载失败。
- **根因**：引擎消息 schema 里 tools 是 `record<string,boolean>`，但 **agent 文件的 frontmatter 是 YAML 数组**（`tools: [Read, Bash]`，judge.md 实证）。两种写法极易混淆。
- **解决**：严格照 judge.md 样本写数组；omz-doctor 自检环节加"spawn 后实际调用被禁工具应被拒"的断言。
- **验证**：✅ **行为级确证已完成（v1.5 装机实测）**——此前只有 `validate-frontmatter.mjs` 的静态校验（YAML 数组解析 + 工具名分类）。真实会话内逐个 spawn 9 个 agent，实测工具面与 frontmatter 声明**逐项吻合**：五个受限角色（critic/oracle/reviewer/librarian/looker）**均无 Edit**，三个全工具角色（deep/junior/atlas）**有 Edit**，planner 恰为 `Bash, Read, Write`，librarian 恰为 `Bash, Read, WebFetch`（§10.1 V12）。白名单确实生效，不是"写了但引擎没读"。**边界**：白名单只约束"能声明什么"，工具面还含引擎注入项（`RespondToCoordinator`，§10.3 第 11 条、§4 第三层），且 Bash 仍是纪律层（§17 裁决 3）。

### B2【高】并行 spawn 权限弹窗阻塞编排
- **现象**：/team 并行 4 成员，第一个 Bash 调用就挂起等 GUI 确认，后续成员排队，波次推进卡死。
- **根因**：ZCode 工具跑在权限模式下，子代理的工具调用可能继承确认流；Windows GUI 弹窗是模态的。
- **解决**：① 只读角色 tools 白名单天然避开高风险工具（Bash 仍可能弹）；② frontmatter `permissionMode` 按 agent 放宽——枚举已知（§10.1 V8）：`acceptEdits`/`auto`/`bypassPermissions`/`dontAsk`/`plan`/`default`，子代理映射 `bypassPermissions`|`dontAsk` → yolo、`acceptEdits` → edit、`auto` → auto、`default`/未写 → 继承会话；**放宽这条路可用（这是"放宽"方向）**，待验的只有并行弹窗时序（§10.2 V8′）；③ 文档明示：跑 /team 前把会话权限模式调到适当宽松档；④ MUST DO 里规定成员优先用 Read 与 Bash 只读命令等免确认路径。
- **兜底**：V8′ 实测显示弹窗仍串行阻塞，则 Team Mode 降级为"并行度 2 + 顺序确认可接受"。

### B3【高】Windows 路径分隔符撕裂
- **现象**：成员写 results 里的路径 `E:\AI\project\src\main.rs`，lead 或下一波成员在 Git Bash 里读出后拼接命令，反斜杠被当转义符，文件操作全部失败。
- **根因**：ZCode 在 Windows 上运行，工具链横跨 win32 原生（反斜杠）与 Git Bash（正斜杠）两个世界。
- **解决**：协议规定状态文件里**一律存正斜杠相对路径**（相对项目根）；/ulw 与 /team 提示词明文写入此规则；omz-doctor 扫描 .omz/ 内 JSON 发现反斜杠绝对路径即报警。
- **验证**：M1 全流程跑通即覆盖。

### B4【高】状态文件 JSON 编码损坏（BOM/CRLF）
- **现象**：成员 A 写的 results，成员 B 读出来 JSON.parse 报错，波次推进中断。
- **根因**：Windows 下 PowerShell `Set-Content` 默认写 UTF-8 BOM；某些工具写 CRLF；JSON 解析器遇 BOM 直接失败。
- **解决**：协议规定 `.omz/` 下文件一律用 Write 工具或 node（`fs.writeFileSync` 默认无 BOM）写，**禁用 PowerShell 写状态文件**；hook 脚本 node 实现同理；读侧容错（strip BOM 再 parse）写进 /omz-status 的渲染脚本。
- **验证**：M1 覆盖；omz-doctor 加 BOM 扫描。

### B5【中】/ulw 命令与 M2 hook 双重注入
- **现象**：用户输入 `/ulw 修复登录 bug`，命令展开注入一遍 ultrawork 提示词，hook 又检测到 "ulw" 关键词再注入一遍——上下文重复污染，token 浪费且可能自相矛盾。
- **根因**：两个触发层（命令展开与 hook 检测）独立工作，无互斥。
- **解决**：hook 脚本第一条规则——输入以 `/` 开头直接返回不注入（命令系统已处理）；会话级标记做第二道防线（§8.2 去重）。
- **验证**：M2 上线时专项测试 `/ulw`、裸 `ulw`、含 "ultrawork" 单词的正常句子三种输入。

### B6【中】omz-deep 失控烧 token（长循环/反复重试）
- **现象**：后台 omz-deep 跑 40 分钟不返回，transcript 显示在同一错误上循环重试。
- **根因**：全工具 + 自主 + 无硬性轮次上限时，模型可能陷入修复循环。
- **解决**：① frontmatter `maxTurns` 硬上限（引擎证实，结构性护栏）；② wall-clock 预算 120 分钟；③ 提示词规定"同一错误连续 3 次修复失败必须停下来汇报，不得继续"；④ 主 agent 对后台任务使用通知为主、TaskOutput 仅在中途决策确实依赖时单次查看（不做无界轮询）。
- **验证**：M1/M2 Team 与 coordinator 压测专项。

### B7【中】TodoWrite 会话隔离假设错误
- **现象**：若子代理的 TodoWrite 与主 agent 共享同一列表，并行成员互相覆盖 todo，编排状态错乱；若独立（预期），则成员的进度对 lead 不可见，lead 只能靠 results 文件。
- **根因**："current session" 语义未实测，两种行为对设计的影响完全相反。
- **解决**：V7 实测先定方向。无论结果如何，协议统一规定：**成员进度只写 results 文件，TodoWrite 仅供各自会话内部使用**——设计不依赖任何一种 TodoWrite 语义，天然免疫此 bug。
- **验证**：M0-V7。

### B8【中】通知时序与波次推进竞争（收点漂移）
- **现象**：wave-1 的成员 A 还在跑（通知延迟未到），lead 以为收齐了已进 wave-2，A 的结果后来才插入，最终汇总缺 A 或状态错乱。
- **根因**：后台完成通知是异步事件，与 lead 的同步推进逻辑之间存在竞争。
- **解决**：**唯一事实源原则**——波次推进条件是"本波全部 tasks/*.json 的 status 为终态且 results 文件存在"，通知只作提醒不作依据；lead 在推进前 ls 检查 results 目录做最终确认。
- **验证**：M3 主验证项。

### B9【中】resume 适配器不可用或会话已回收
- **现象**：SendMessage 到已完成 agent，静默无响应或报错，lead 一直等。
- **根因**：ZCode 官方公开文档没有 agent ID、resume token、取消/进度 API；工具层存在的 `agent_id`/`SendMessage` 不能当作跨版本稳定契约。
- **解决**：resume 带 10 分钟超时；超时即回退重新 spawn，把原 results 文件内容并入新 prompt 的 CONTEXT（信息不丢）；state.json 记录 agent_id↔task_id 映射便于重建。
- **验证**：M1 装机 V4：同一运行期续用、超时回退、新会话边界三组测试。

### B10【中】单个 agent 文件 YAML 错误拖垮全插件
- **现象**：一个 omz-*.md 的 frontmatter 有未转义冒号/引号，装完插件后 9 个 agent 全部消失。
- **根因**：引擎对 agents 目录的加载容错粒度未知（单文件跳过 or 整目录失败）。
- **解决**：发布流程加 YAML lint（CI 脚本）；omz-doctor 装后自检逐个 agent spawn ping；description 含冒号时整体加引号（judge.md 样本即如此）。
- **验证**：M1 的 omz-doctor。

### B11【中】评审门形同虚设
- **现象**：omz-reviewer 与执行者同模型同源，评审报告全是"总体良好，建议小改"——流程走了，代码质量没提升。
- **根因**：评审者与执行者无结构性差异；提示词倾向性（reviewer prompt 写得温和）会放大从众。
- **解决**（v1.4 修正防线性质）：① **工具白名单**——排除 Edit/Write 是**结构约束**（评审者拿不到编辑工具）；但 Bash 在引擎里是 write+destructive（§10.3 第 5 条），"不用 Bash 写文件"只能是**纪律约束**，写进 reviewer 正文（§17 裁决 3）；② reviewer 提示词强制否定性输出格式：每条发现必须含 `[级别] 文件:行号 问题描述 修复建议`，且**必须显式回答"我没发现 X 类问题"逐类排查**——空报告必须是穷举后的结论而非敷衍；③ 复审上限 2 次（防评审者与执行者互相拉扯死循环）；④ blocker 未清零禁止进入提交步（写进 /ulw 宪法检查清单）。
- **防线强度（诚实表述）**：四道防线里 ②③④ 是结构/流程约束，① 是"半道"——**三道结构 + 一道纪律**。**这是终态**：`permissionMode` 的枚举里没有任何值能移除单个工具（§10.1 V8、§17 裁决 3），所以不存在"等某项实测通过后把 ① 补成结构约束"的路径，纪律约束必须靠下面的抽查兜底长期维持。
- **验证**：M1 起每次评审门抽样人工复核 reviewer 输出质量；若持续空报告，升级 prompt（加"必须至少给出 3 个疑点或明确声明穷举"）。**另加**：抽查 reviewer 的 Bash 调用是否只含读命令（纪律约束需要抽查兜底，结构约束不需要）。

### B12【中】frontmatter model 指向未登记模型
- **现象**：spawn omz-oracle 立即失败，或静默回退到主会话模型（分档失效而不报错）。
- **根因**：frontmatter model 写了 `~/.zcode/v2/config.json` 未登记的模型 ID（拼错、供应商改名、用户换 key）。
- **解决**：omz-doctor 校验全部 agent 的 model 字段与已登记供应商模型清单一致，不一致列差异；模型配置变更后建议重跑 doctor。
- **验证**：M1 的 omz-doctor。

### B13【低】quick 类任务被过度委派
- **现象**：主 agent 把 typo 修复也 spawn omz-junior，token 翻倍无质量收益。
- **根因**：委派选择空间大，弱模型倾向"有角色就用"；省流阀被当成建议忽略。
- **解决**：/ulw 提示词把省流阀写成 MUST 规则（"quick 类任务直接自己修，委派即违规"）；description 写反向触发条件（"仅用于…，单文件小改勿派"）。
- **验证**：M1 观察委派日志。

### B14【低】.omz/ 误提交进 git
- **现象**：goal/plans/runtime 等阶段性产物混进提交，污染仓库历史。
- **根因**：目录在项目根下但无人记得加 .gitignore。
- **解决**：/ulw 首次运行检测 .gitignore，无 `.omz/` 条目则自动追加并告知；omz-doctor 常态检查。
- **验证**：M1。

### B15【低】hook 脚本 Windows 执行失败
- **现象**：hooks.json 配了 bash 脚本，Windows 下找不到解释器或路径含空格解析失败，M2 静默不工作。
- **根因**：Windows 无执行位概念，shell 解析差异。
- **解决**：hook command 统一 `node "<绝对路径>/hook.js"`（ZCode 自带 node）；路径含空格全部引号；hook 失败不阻断主流程（引擎 hook 有 timeoutMs 与容错）。
- **验证**：M0-V3。

### B16【低】子代理看不到 OMZ skills — **✅ 已结清（v1.5 装机实测）**
- **现象**：REQUIRED SKILLS 点名的 skill 成员侧不可见，成员重新摸索流程。
- **根因**：skillMetadataBudget 有限或插件 skills 不下发给子代理（v0.5 的 V6 只实测了"当前会话可见 36 个 skills"，OMZ 自有 4 个当时尚未装机）。
- **实测结论（结清依据）**：`/omz-doctor` 在真实会话内逐个 spawn 9 个 agent，**四个 OMZ skill（`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`）在全部 9 个子代理侧均可见**，且带 `omz:` 命名空间前缀（与 §10.3 第 2 条的插件命名空间规则一致）。**可见 skill 总数因角色而异**（junior/atlas 40、deep/reviewer 34、其余五个 33，§10.3 第 13 条），但**OMZ 自有 4 个在各档下都在**——分档没有把它们挤出去。
- **裁决**：**回退方案作废**——委派 prompt **不需要**内联 skill 摘要（原方案约 10 行/次，9 个角色摊下来是持续的 token 税，现在这笔成本省掉了）。REQUIRED SKILLS 字段可以直接点名 skill，成员侧能自行加载。
- **残余注意**：分档机制未查清（§10.3 第 13 条），所以"skill 一定可见"是**当前部署的实测结论而非引擎承诺**。若将来用户级 skill 大幅膨胀（本次实测基数已是 33–40），存在被预算挤出的理论可能——`/omz-doctor` 的 spawn ping 已把"子代理自报可见 skill 清单"纳入回执，是这条风险的常规探测手段。
- **验证**：✅ 已完成——`/omz-doctor` ① 项的 9 次 spawn 回执（每次含自报可见 skill 清单，逐个确认四个 OMZ skill 在列，§10.1 V12）。

### B17【低】长会话编排层质量衰减
- **现象**：/ulw 会话跑 2 小时后，主 agent 上下文膨胀，开始跳过评审门、忘记双证据要求、直接提交。
- **根因**：模式提示词在会话早期注入，随着上下文增长其约束力被稀释。
- **解决**：goal.json 存"宪法检查清单"（评审门条件/双证据要求/省流阀），**每个提交点前 lead 强制自查一遍**；**每个波次收点后主 agent 主动把进展写入 `.omz/boulder.json`**（§17 裁决 4）。
- **v1.4 缺口**：Stop hook **未实装**（hooks.json 只注册 `UserPromptSubmit`），"终止时核对清单完成度、把缺口写入 boulder.json 阻断'完成'结论"属 **M4 未实装项**。因此异常终止（进程被杀/会话崩溃）会丢失最后一个收点之后的进展，也不会自动阻断"完成"结论——当前只能靠主动落盘频率兜。
- **验证**：M4（Stop hook 实装后）。在此之前靠 §6 收尾条款的主动落盘 + 人工核对。

### B18【中】会话 ID 变化导致目标与团队状态失联
- **现象**：/ulw 跑到一半中断，用户开新会话说"继续"——新会话的 stem 与旧 `goal/<stem>.json` 不同名（B30 的两种命名形态都会变），主 agent 找不到旧目标于是重新注册，已完成波次全部重跑。
- **根因**：goal 按会话维度命名天然碎片化；跨会话指针 boulder.json 若建设滞后则存在真空。**v1.4 末轮补充**：碎片化比设计期以为的更严重——主 agent 连真实 sessionId 都拿不到（B30），命名要么是真 sessionId、要么是时间戳回退，两种形态在新会话里都会变。
- **解决**：① boulder.json 的 **`active_goal` 是唯一权威指针**（活跃目标的 goal 文件正斜杠相对路径、活跃 teamId、未完 TODO），每次波次推进后由 lead 更新；**读它的字面值去开文件，禁止按当前会话反推文件名、禁止拿 `session_ids` 反推**（B30）；② 新会话 /ulw 检测到未关闭旧目标（无 done 标记）时必须先问用户"续跑还是放弃"，不得静默重开；③ 已终态团队归档（runtime 保留副本），防止误续。
- **验证**：M1 中断续跑测试。因为定位只走 `active_goal`，**即使 sessionId 永久不可得，续跑仍然精确**。

### B19【高】agent 清单是会话启动快照（v0.5 实测发现）
- **现象**：用户把 omz-planner.md 放进 `~/.zcode/agents/`，当前已开启的会话说"用 planner"——报 not found；用户以为插件坏了。
- **根因**：实测证实 Agent 工具的 subagent_type 可用清单在**会话启动时快照**，运行中新增的 agent 文件对当前会话不可见。
- **解决**：① 安装/更新 OMZ 后必须**重启会话（或新开会话）**才生效——写进 README 安装步骤与 /omz-doctor 的检查项（检测到 agent 文件 mtime 晚于会话启动时间时提示重启）；② 项目级 agent（`.zcode/agents/`）随仓库走，克隆即得，不依赖用户操作；③ 失败信息可执行化：omz-doctor 报"文件已就位但本会话不可见，请新开会话"而非笼统 not found。
- **验证**：M1 装机后新会话 spawn omz-probe 应返回 PROBE-OK。

### B20【中】子代理无独立 Grep/Glob 工具（v0.5 实测发现）
- **现象**：按 v0.3 角色表给 omz-librarian 配 `tools: [Read, Grep, Glob, WebFetch, WebSearch]`——spawn 后 Grep/Glob 调用失败（工具不存在），检索代理瘫痪。
- **根因**：实测子代理工具清单**没有 Grep/Glob**（主会话的文件搜索走专用工具，子代理侧文件搜索只能经 Bash 的 grep/find）。
- **解决**：所有只读角色的 tools 数组改为 `[Read, Bash, ...]` 形态（Bash 承担 grep/find/rg），文档角色表已同步修正；Bash 的**批准面**可在 permissionMode 层放宽（枚举已知，§10.1 V8），但**不能靠它移除 Bash**（枚举里没有 per-tool 拒绝值，§17 裁决 3）。附注：主 agent 委派 prompt 的 REQUIRED TOOLS 要素相应用 Bash 语法描述搜索命令。**v1.4 追加**：`WebSearch` 也一并删除（本部署无此工具，§13 B24），librarian 的最终 tools 是 `[Read, Bash, WebFetch]`。
- **验证**：✅ **已复验（v1.5 装机实测）**——9 个 agent 在真实会话内逐个 spawn，**全部无 `Grep`、无 `Glob`**（含三个全工具角色），检索确实只能走 Bash + Read（§10.1 V12）。`omz-librarian` 的实测工具面恰为 `Bash, Read, WebFetch`（无 `WebSearch`，§17 裁决 2 同步取得行为级确证）。

### B21【中】quick 省流阀与"编排者不实现"的角色冲突（v0.5 审计发现）
- **现象**：/ulw 宪法说"主 agent 只编排不亲自实现"，省流阀又说"quick 类主 agent 自己干"——弱模型读到的两条规则冲突，行为随机摇摆。
- **根因**：两条规则的边界没有写清楚："不实现"的例外清单没包含省流阀。
- **解决**：/ulw 提示词的措辞统一为——"主 agent 原则上只编排；例外仅两类：① quick 类小改（省流阀）② 无法委派的琐事（如读一个文件确认状态）。除例外外任何产品代码修改必须委派。"两条规则合并成一条带例外的规则，消除歧义。
- **验证**：M1 观察 /ulw 日志中委派决策。

### B22【高】isMain 判定用 percent-encoded pathname 导致 CLI 静默失效（v1.4 实现期发现）
- **现象**：插件目录含空格或非 ASCII 字符（Windows 极常见：`C:\Program Files\…`、中文用户名、`E:\AI\我的项目\…`）时，**所有 node CLI 入口静默 exit 0 什么都不做**——doctor 不输出结论、render-status 渲染空白、keyword hook 输出 0 字节（fail-open 契约破产：hook 本该"要么注入要么明确不注入"，结果是"什么都没说"）。最恶劣的一点是**全部是退出码 0 的假成功**，调用方无法察觉；`/omz-doctor` 自己也检不出来——它本身就是失效的那个。
- **根因**：`new URL(import.meta.url).pathname` 返回 **percent-encoded** 路径（空格→`%20`、中文→`%E4%B8%AD`），而 `process.argv[1]` 是解码后的原始路径。用 `pathname === argv[1]` 判 "是否作为主模块运行" 在含空格/非 ASCII 路径下**必然不等**，于是模块被当作"被 import"，主逻辑整块跳过。ASCII 无空格路径下恰好相等，因此在干净目录里测不出来。
- **解决**：统一用 `fileURLToPath(import.meta.url)`（负责解码）与 `path.resolve(process.argv[1])` 比对；抽成 `tools/lib/is-main.mjs` 供所有 CLI 入口共享，禁止各文件自行手写判定。
- **验证**：把整个插件子树复制到含空格的临时目录（如 `.../omz cli test/`）跑全部 CLI 入口，断言每个都有非空输出——已固化进 `tests/cli.test.mjs`。**兜底**：hook 侧另加"无论如何都要写一行 JSON"的最终兜底，把 fail-open 从"依赖判定正确"变为"无条件成立"。

### B23【高】最小 YAML 解析器静默丢弃 dash 数组，击穿只读白名单（v1.4 实现期发现）
- **现象**：frontmatter 写成合法的 YAML block 序列：

  ```yaml
  tools:
    - Read
    - Bash
  ```

  自建解析器把 `tools` 解析为**缺失**（值是空字符串），而"缺失 tools"的引擎语义是**全工具**——只读角色的白名单静默失效，reviewer 拿到 Edit/Write，而 `/omz-doctor` 与 `validate-frontmatter` 全报 OK（它们看到的就是"没写 tools"，合法）。
- **根因**：为避免引入 YAML 依赖，自建了最小解析器，只支持行内数组 `[a, b]`；dash 数组的后续行被当作"下一个键"处理而无法匹配，值被丢弃。**静默丢弃比解析报错危险得多**：报错会挡住加载，丢弃会让安全约束消失且一切显示正常。
- **解决**：① 解析器支持 dash 数组（含缩进与注释）；② 加**显式防线**——原文中该键下方存在 dash 序列但解析结果不是数组时，直接报错而不是接受空值（宁可拒绝加载也不放过白名单失效）。
- **验证**：`tests/protocol.test.mjs` 对两种数组写法做等价断言 + 临时 fixture 覆盖"dash 数组被解析成非数组必须报错"的反向用例。

### B24【中】"引擎有工具名"≠"当前部署可用"（v1.4 实现期发现）
- **现象**：按 §10.3 的 `isReadOnlyTool` 集合给 omz-librarian 配了 `WebSearch`（引擎确实有这个名字），但当前部署（含主 agent）的实际工具面里**没有它**，子代理实测清单也没有。结果是 frontmatter 声明了一个永远拿不到的工具，agent 正文按"我能搜索"写，实际检索能力为零，且校验器全绿。
- **根因**：把"引擎源码里出现的工具名"当成"运行时可用工具"。两者是不同的集合：引擎代码要兼容多种宿主与版本，实际下发的工具面由部署决定。这是 B20（无 Grep/Glob）的同类错误，但设计期只把 B20 当个例修掉，没有升格为一般规则。
- **解决**：`tools/validate-frontmatter.mjs` 把工具名分为两类——`SUBAGENT_TOOLS`（本部署逐项确认过的子代理工具面 + `mcp__*` 前缀）与 `ENGINE_ONLY_TOOLS`（`Agent`/`WebSearch`/`Grep`/`Glob`，各带原因说明）；frontmatter 里出现 `ENGINE_ONLY_TOOLS` 成员**直接报错**（不是警告），未知名称同样报错。
- **验证**：`tests/protocol.test.mjs` 断言 9 个 agent 的 tools 与 `SUBAGENT_TOOLS` 的包含关系；对每个 `ENGINE_ONLY_TOOLS` 成员各有一条"必须报错"的用例。**制度化**：§10.2 起验证清单新增一条通用条款——凡引擎取证得到的工具/字段能力，必须再做一次"当前部署是否真的下发"的确认，才能写进 frontmatter。

### B25【中】路径归一化的全量深度遍历会破坏非路径字符串（v1.4 实现期发现）
- **现象**：状态文件里 `"error": "regex \\d+ and \\w+ failed"` 被写成 `regex /d+ and /w+`；result 摘要、错误消息、正则字面量、Windows 注册表键、转义序列全部被污染——而且污染发生在**审计与排障最依赖的字段**上（错误消息），使排障信息本身失真。
- **根因**：B3 的"状态文件里一律存正斜杠相对路径"被实现为"对整个 JSON 树递归把 `\` 替换成 `/`"。规则本身对，实施范围错：并非所有字符串都是路径。
- **解决**：改为**字段名白名单驱动**——只有登记在 `PATH_FIELD_NAMES` 里的字段（`result_file`/`plan_path`/`worktree_path`/… ）才归一，数组元素继承父键名的判定，任意深度均适用；未登记字段逐字节保留。新增存路径的字段必须同时登记（代码注释里写明这条纪律，否则 B3 复发）。
- **验证**：`tests/path.test.mjs` 的反向用例——含反斜杠但非路径的字符串（正则、错误消息、转义序列）必须**逐字节原样**；正向用例覆盖嵌套对象/数组里的白名单字段。

### B26【中】跨卷/越界路径被静默改成不存在的相对路径（v1.4 实现期发现）
- **现象**：项目根在 `E:` 而路径是 `C:\Windows\System32\x.txt` 时，归一化产出形如 `../../../Windows/System32/x.txt` 的串——它在**任何机器上都不指向原文件**，还看起来像个正常相对路径，后续读取失败或读到错误文件。
- **根因**：`path.relative` 对跨卷（Windows 无公共根）或结果越出项目根的情况仍会返回一串 `../`，调用方若不检查就当成有效相对路径存下去。
- **解决**：`toPosixRelative(target, root, { onEscape })` 三种策略：`marker`（默认，保留可被 `isEscapingPath()` 判定出来的绝对形态，让 doctor 能报警"状态文件引用了项目外路径"）、`return`（原样返回相对串，仅供内部分类使用）、`throw`（调用方要求严格）。另提供 `classifyPath()` 让调用方**显式**处理 `inside / escaping / cross-volume / plain-text` 四类，而不是靠猜。
- **验证**：`tests/path.test.mjs` 覆盖跨卷、越界、UNC 与纯文本四类输入；doctor 的 B3/B4 扫描项对 marker 形态报警。

### B27【中】状态看板的字段未做行内注入防护（v1.4 审计期发现）
- **现象**：任务 title 里含换行或 `|` 时，`/omz-status` 的 Markdown 表格被撑破——一个恶意/意外的 title（如 `修复 A | done | 2 | 伪造任务`）可以**伪造出整行任务**。危害不止于显示：`/omz-status` 是 B8 声明的"唯一事实源"的投影，投影能被伪造等于事实源被污染，人按看板做的收点判断就是错的。
- **根因**：渲染层直接把任意 agent 写入的文本插进表格单元格，未考虑分隔符与换行是表格语法的一部分（这是 §13.5 I5 renderer 注入问题的**文本版**，设计期只防了 HTML）。
- **解决**：所有落表字段统一走净化——剥 `\r\n\t`（替换为空格）、把 `|` 替换掉、按列宽截断并加省略标记；数值列强制类型转换。渲染上限 40 行的聚合逻辑保持不变（v0.4）。
- **验证**：`tests/*`（render-status 用例）注入含换行、`|`、超长与 ANSI 序列的 title，断言输出行数与列数恒定。
- **实测数据（v1.5 装机后真实会话，两条渲染路径对照）**：造一个 title 为 `注入攻击\n  1 | T-999 | done | forged` 的任务，配合 60 个批量任务触发 40 行上限，同一份 `.omz/` 分别用两条路径渲染：
  - **`/omz-status` 的内联块**：渲染出**多一行伪造任务**——输出 **41 行**，`T-999` **独立成行冒充真任务**（换行被当作表格换行、竖线被当作列分隔符，攻击完全生效）。
  - **`tools/render-status.mjs`**：`cell()` 把它压成单元格内的一行 `注入攻击 1 ¦ T-999 ¦ done ¦ forged`——输出 **40 行**（恒定），竖线被替换为 `¦`、换行被剥离，行数与列数不变。
- **结论（这条实测改变了一句话的性质）**：`commands/omz-status.md` 里"以 `render-status.mjs` 为准"那句**不是免责声明，是真实的能力差**——**内联块是兜底最小实现，不含 `cell()` 净化**。两者的差距可被精确度量：一次注入 = 一行伪造任务。因此 ① 涉及收点判断时必须用 `render-status.mjs` 的输出，内联块只作快速一瞥；② §8.1 的 `/omz-status` 条目已标注此差异；③ 内联块的这个缺口**当前不修**（它的价值就是"零依赖能跑"，加净化逻辑会把它变成第二份实现，与"唯一事实源"的初衷相悖），改为在文档与命令正文里显式标注能力边界。

### B28【中】波次字典序排序（v1.4 实现期发现）
- **现象**：`/omz-status` 与 Atlas 的波次账本里 wave 顺序显示为 `1 → 10 → 2 → 3`，看板上"当前波次"完全错乱；一旦计划超过 9 个波次就必然发生。
- **根因**：wave 值来自 Markdown 标题解析，是字符串；排序用了默认的字典序比较。
- **解决**：`compareWave(a, b)` 数值优先——两侧都能转成有限数时按数值比，否则退回字符串比较（容忍 `1a`/`final` 这类非数值波次名），排序键再叠加任务 id 保证稳定。
- **验证**：render-status 用例断言 `['10','2','1']` 排序为 `1,2,10`；混合数值/非数值输入不抛错。

### B29【高】ReDoS 使 hook 从 fail-open 变 fail-broken（v1.4 实现期发现）
- **现象**：keyword hook 对 128KB 的退化 Markdown 输入耗时 **18.4 秒**，超过 hooks.json 的 `timeoutMs: 3000` 被引擎杀掉，**无任何输出**。这不是"注入失败"而是"契约破产"：hook 的设计承诺是 fail-open（要么注入、要么明确不注入），被杀掉等于既没注入也没说明，且用户侧只感到卡顿。攻击/触发成本极低——一段自动生成的文档粘进 prompt 就够。
- **根因**：识别 Markdown 链接的正则含嵌套量词，在大量方括号/圆括号的退化输入上灾难性回溯（指数级）。
- **解决**：① 把该正则改为**线性单向扫描**（手写状态机逐字符走，不回溯）；② 降低扫描窗口（只扫 prompt 前若干 KB，关键词命中不需要全文）；③ 加**自我时间预算**——超预算立即返回"不注入"的合法 JSON 而不是继续算到被杀（把最坏情况从 fail-broken 拉回 fail-open）。
- **验证**：`tests/hooks.test.mjs` 对退化输入断言**挂钟上界**（远小于 3s timeout）；`--self-test` 内含 32K 退化 Markdown 用例（30 例之一）。

### B30【高】主 agent 拿不到 sessionId，模型会编一个（v1.4 末轮审计发现）
- **现象**：§6 第 2 步要求把目标写到 `.omz/goal/<sessionId>.json`，但主 agent **没有任何途径读到真实 sessionId**——`${ZCODE_SESSION_ID}` 只在 **hook / MCP server / 命令的 shell 执行块**这几个上下文被引擎展开（§10.3 第 1 条的模板变量表），**Bash 工具的 env 里没有它**，系统提示词的 `<env>` 块也只有 cwd/git/platform/shell/osVersion。于是模型按提示词字面要求"用 sessionId 命名"，就地**编一个**：`sess_x`、`sess_1`、时间戳、`unknown`、`current` 之类。
- **为什么危险**：本轮完全自洽——文件写成了、看板照渲（render-status 只按目录扫文件）、doctor 也检不出（它校验 frontmatter/model/BOM/路径，不校验 goal 文件名与会话的对应关系）。**表面全绿的假成功，与 B22 同族**（退出码 0 的静默失效）。代价在下一个会话显现：按 B18 的续跑流程去找旧目标时，编出来的名字与真实会话毫无对应关系，"指针精确"退化为"文件名恰好还在"。
- **根因**：规格把"命名用 sessionId"当成主 agent 能满足的约束，而该变量的可见范围是引擎侧的上下文分层决定的，规格从未核对过这一层。
- **解决**（已在 `commands/ulw.md` 实施）：① 新增**第零步：会话标识**——用 ` ```! ` 内联执行块（命令展开时执行，属于变量可展开的上下文）取真实值，输出 `OMZ_SESSION_ID` / `OMZ_GOAL_STEM` / `OMZ_ID_SOURCE` 三行；② 同时防"引擎未展开时字面量 `${...}` 残留"这一分支（脚本检查首字符是否为 `$`，是则视为未展开并落回退）；③ 取不到则用 **`<ISO 时间戳>-<git HEAD 短哈希>`** 确定性回退（非 git 仓库哈希位写 `nogit`），可复现、可排序、不冲突；④ **明令禁止编造 sessionId**，并规定执行块整段失败时**停下问用户**而不是用默认值顶上；⑤ 把 `.omz/boulder.json` 的 `active_goal` 钉为跨会话找回的**唯一权威指针**，`session_ids` 降级为纯审计线索、**任何时候都不参与文件定位**。
- **验证/兜底**：第零步的三行输出即自证据（`OMZ_ID_SOURCE` 写进 goal 文件备查，事后能区分"真 sessionId"与"回退命名"）；因为定位只走 `active_goal` 指针，**即使 sessionId 永久不可得、即使文件名走回退形态，B18 的续跑流程仍然精确**。doctor 侧的残余缺口：它无法判断某个 goal 文件名是真 sessionId 还是编造值（这正是本条要靠提示词纪律 + 确定性回退堵住的原因）。
- **行为级确证（v1.5 装机后真实会话实测，B30 的修复有效）**：
  - **`ZCODE_SESSION_ID` 在 Bash 工具上下文确实拿不到**——`env | grep -i session` **无结果**。这把 §10.3 第 9 条的引擎反查结论从"代码路径推断"升级为"实测确认"，也就是说 B30 描述的失效条件在真实环境里**必然成立**（不是理论风险）。
  - **回退路径实测生效**：第零步落到 `<ISO 时间戳>-<git HEAD 短哈希>` 形态，实测值 **`2026-09-01T1604-f8ca4e2`**，`OMZ_ID_SOURCE` 如实标为回退。
  - **四种分支全部 exit 0 且回退标记明确**：① 变量未展开（字面量 `${...}` 残留，脚本按首字符 `$` 判定并落回退）；② 已展开（拿到真值）；③ 经 env 注入（外部提供该变量）；④ 非 git 仓库（哈希位写 `nogit`）。四条路径都不抛错、都不静默用默认值顶上——这正是本条修复要达到的性质：**要么有真值、要么有可辨识的确定性回退，没有第三种结局**。
  - **残余缺口不变**：doctor 仍无法区分"真 sessionId"与"编造值"（只能看 `OMZ_ID_SOURCE` 这条自证据），定位仍只走 `active_goal`。

### B31【高】命令文件正文意外命中引擎的行内 shell 展开语法（2026-09-03 `/ulw` 发不出去时发现）

- **症状**：真实会话里输入 `/ulw` 发送失败。引擎日志写着
  `Custom command /ulw shell expansion failed. Command: <一段中文正文> Exit: 1`。
  复现三次（2026-09-02T16:00、17:46、2026-09-03T01:19），即用户的每一次尝试。
- **根因**：引擎的行内展开正则是 `/!`([^`]*)`/gu`——`!` 后跟一对反引号包裹的内容。`commands/ulw.md` 第一步原文写成
  `` `ULTRAWORK MODE ENABLED!` ``，那个 `!` **在反引号里面、紧贴收尾反引号**。于是 `!` 与**下一对**反引号（在两段之后）
  配成一组，引擎把一段中文正文当 shell 命令丢给了 `cmd.exe`。它退出 1，`NPi()` 抛错，整条命令展开失败——消息根本到不了模型。
- **测试为什么没抓住**：577 条用例里没有任何一条用引擎自己的展开正则看过命令正文。所有关于命令的断言都是 frontmatter、
  章节结构或跨文件一致性。这个缺陷自 v1.5.0 起就在树里。
- **冒烟为什么没抓住**：§18 的链路是在 **CLI/插件发现**那个面上跑 `/ulw`，那个面只加载与列出命令；展开只发生在
  **会话发送**面，而那个面从未真正发过一次。
- **修法**：去掉 `commands/ulw.md` 里那句横幅的反引号（句意不变），并补一条静态断言：用两条引擎正则扫每个
  `commands/*.md`——`/!`([^`]*)`/gu`（行内）与 `/```!s*?
?([sS]*?)```/gu`（围栏）——行内命中即判红，
  同时放行那两个有意的围栏块。双向变异验证：把语法写回去变红，合法围栏块保持绿。
- **可推广的教训**：命令文件不是文档，它是**展开器的输入**。任何紧贴反引号的 `!`、任何 ````!``` 围栏都是可执行语法。
  按散文去审它找不出这类缺陷，只有拿引擎自己的正则跑一遍才行。

## 13.5 可选 profile 集成风险（I1–I10）

I1–I6 只在启用 `graph`/`orchestration`/`dashboard` profile 时出现；`core` profile 不依赖它们。每条都要求先 feature flag、再健康检查、最后才让 /team 使用，避免可选增强反向降低基础可靠性。**I7–I10 是 v1.4 实现与审计期在 coordinator/dashboard 代码里实际命中的缺陷**，性质与 I1–I6 不同：它们不是"外部依赖不可靠"，而是"自有实现的正确性漏洞"，且其中三条（I7/I8/I9）**破坏后数据库自身仍自洽**，必须靠专门的检测器或校验才能发现。

### I1【高】CodeGraph 索引陈旧或项目根选错
- **现象**：`codegraph_explore` 返回旧源码、错误 worktree 或最近 `.codegraph/` 索引；主 agent 以此做架构判断，修改了错误位置。
- **根因**：工具通过 `projectPath` 选择最近索引；索引不会自动等价于当前 Git working tree，且 MCP 返回 text ToolResult，不是带版本强约束的 JSON。
- **解决**：每次 graph 查询前检查 Git HEAD、working-tree dirty 状态和 `.codegraph/` 更新时间；结果必须记录 `projectPath`、HEAD、索引时间；检测不一致时先 `codegraph init` 或回退 Explore，并把结果标 `stale/unverified`，不得作为高风险决策唯一证据。
- **验证**：修改文件后不重建索引查询一次，确认 doctor 能报警；重建后查询结果含新内容。

### I2【高】MCP 外部依赖启动失败阻塞主流程
- **现象**：ZCode 会话启动等待 `codegraph`/coordinator，命令找不到、Node/native addon 加载失败或 stdio 协议损坏，导致 /ulw 无法继续。
- **根因**：ZCode workspace MCP 会话启动自动连接；`vardiya` 依赖 Node >=22 与 `better-sqlite3` native 模块，Windows 安装/ABI 不匹配时容易失败。
- **解决**：profile 启用前 `/omz-doctor` 做版本、可执行文件、stdio 握手和超时检查；MCP 连接失败只关闭该 profile 并返回可读诊断，绝不阻断 core；coordinator 自建协议优先使用 ZCode plugin-host 已验证的 Node 进程形态，依赖 pin 版本与 lockfile。
- **验证**：人为移走可执行文件/改坏端口，确认 /ulw 回退成功且诊断明确。

### I3【高】coordinator 与 ZCode worker 状态分叉
- **现象**：SQLite 显示 `running`，但 ZCode agent 已完成/被取消/从未启动；或 worker 已执行两次，coordinator 只记一次。
- **根因**：官方公开文档没有 agent ID、resume token、取消/进度 API；`agent_ref` 只能是 OMZ 自己保存的关联元数据，无法证明底层执行实例的真实状态。
- **解决**：任务采用 at-least-once；每个任务必须有幂等 key、heartbeat/lease、`unknown` 状态；完成必须同时满足 worker 返回 DoneClaim + coordinator `complete` 成功 + 独立 verifier 证据；lease 过期只允许重派，不宣称 exactly-once；dashboard 把 `transport_state` 与 `coordinator_state` 分开显示。
- **v1.4 补充（§17 裁决 9/10）**：① "lease 过期只允许重派"需要一个**入口**才能成立——`omz_reclaim_expired` 是这个入口，缺它则过期任务永久卡在 `running`；② 回收/claim 的时间基准**只能由 server 自己取**，`now` 绝不进对外 MCP 工具的 inputSchema，否则任意 worker 可用未来时间戳把别人未过期的 lease 判为过期并抢走（把调度器时钟交给调用方）。
- **验证**：在 worker 返回前终止/断网，确认任务进入 `unknown/reclaimable` 而非静默 done；另断言 `omz_reclaim_expired` 的 inputSchema 不含时间参数。

### I4【中】SQLite 单写者导致高并发争用
- **现象**：4~8 个成员同时 claim/heartbeat/complete，出现 `SQLITE_BUSY`、延迟尖峰或错误重复认领。
- **根因**：WAL 改善读写并发但仍是 single-writer；`RETURNING` 不是锁；事务过长会阻塞其他 writer。
- **解决**：claim 使用 `BEGIN IMMEDIATE` + 短 `UPDATE ... RETURNING`；外部 agent 工作绝不持有写事务；`busy_timeout` + 有界指数退避；所有状态写入幂等；在 8 并行之前先跑压力测试，超过阈值自动降并发。
- **验证**：N=1/2/4/8 worker claim 压测，统计重复 claim=0、busy 重试次数和 P95 延迟；保留结果工件。**v1.4 末轮：本条已履行**（§10.1 V9）——8 进程抢同一 graph 的 200 任务，730ms 内 200 次 claim、unique=200、重复 claim=0、`SQLITE_BUSY` 重试 0、`verifyGraphInvariants` 0 violations；`max_parallel=8` 的 40 任务图另有 52 次 `reason:'max-parallel'` 证明限流生效。因此"8 并行之前先压测"这一前置条件**已满足**，可按设定并行度启用。**保留的诚实边界**：`busy_timeout=5000` + `BEGIN IMMEDIATE` 在该负载下未进退避路径，所以"超阈值自动降并发"的触发逻辑本身仍未被真实 `SQLITE_BUSY` 检验过。

### I5【中】dashboard 本地端口暴露或 renderer 注入
- **现象**：局域网可访问任务面板、SSE 泄露 prompt/路径；状态字段被任务内容注入 HTML 执行脚本。
- **根因**：localhost 服务绑定地址/CORS/鉴权配置错误；renderer 把不可信 agent 文本当 HTML 插入。
- **解决（六道防护）**：① 只绑定 loopback；② 随机端口 + 每次启动随机 token；③ CORS 白名单；④ SSE 只发结构化事件；⑤ renderer 默认 `textContent`，CSP 禁 inline script；⑥ dashboard 只读，不提供任意命令执行入口。六道全部落在 loopback HTTP 服务这一侧，与是否装 Electron 无关（`dashboard/server.mjs` 文件头与 `tests/dashboard.test.mjs` 把②拆成"随机端口"与"随机 token"两条、逐条给出代码落点与断言，故那两处的清单计作七条——同一组防护的不同切分，两处都**不含 preload**）。
- **原七道里的 preload 那一道（"preload 只暴露最小 contextBridge API"，CHANGELOG 1.1.0 清单里列在末位，故也称第七道）已撤下，不再适用**：`dashboard/preload.mjs` 连同 `windowOptions()` 里的 `preload` 字段一起删除，因此这道防护**没有可保护的对象**。三条理由：① **无法验证**——Electron 官方文档明确 "Sandboxed preload scripts can't use ESM imports"，`sandbox: true` 下 preload 以普通脚本加载，`contextBridge` 在该组合下是否可达没有任何文档承诺，"防护是否生效"根本无从断言；② **零引用的死代码**——`renderer/app.js` 与 `index.html` 对 `omzDashboard`/`getBootInfo` **一处都没有引用**；③ **删除不减少任何保护面**——renderer 仍只经 loopback HTTP 取数据（`fetch('/api/*')`），token 走地址栏 query（`urlOf('/')` 拼 `?token=`，页面从 `location.search` 读），主进程手上没有 renderer 拿不到的东西；没有 preload 就没有 contextBridge 面，也没有可被误用的 IPC 入口。**措辞界定**：这是**一条承诺被撤下**（一个无法验证的承诺不该挂在安全清单上充数），**不是一道防护失效**——攻击面在删除前后相同，`contextIsolation`/`nodeIntegration:false`/`sandbox`/`webSecurity` 四项 BrowserWindow 硬化全部保留。将来若真需要主进程数据，只能用 `preload.cjs`（sandbox 下按 CJS 加载）并把暴露面重新登记进本清单（理由与落点见 `dashboard/README.md`「为什么 Electron 壳不需要 preload」）。
- **验证**：从非 loopback 地址请求应拒绝；注入 `<script>`/ANSI/超长 payload，确认页面无执行、无布局崩溃。①—⑥ 全部在 `tests/dashboard.test.mjs` 有实测覆盖且不依赖 Electron（CSP 的**实际拦截效果**仍待真机，§10.2 V11）；"无 preload/无 IPC 通道"是**结构性事实**（`windowOptions()` 的返回值里没有 `preload` 键），靠代码本身而非运行时断言保证。

### I6【中】第三方许可证/供应链漂移
- **现象**：升级 CodeGraph/vardiya 后许可证、Node ABI 或行为变化，发布物与文档不一致。
- **根因**：CodeGraph 上游与 OmO wrapper 许可证边界不同；版本 latest 漂移；native 依赖未锁定。
- **解决**：锁定 CodeGraph 版本与 SHA/semver；保留 LICENSE/NOTICE；CI 生成依赖清单和 SBOM；升级必须重跑 graph/MCP/Windows 验收；不把 PolyForm Noncommercial 的 GitNexus 作为默认商业依赖。
- **验证**：`/omz-doctor --supply-chain` 输出版本、许可证和 hash，缺失即 fail。

### I7【高】coordinator 的终态守卫与一次性消费（v1.4 实现期发现）
- **现象**：同一个 `task_complete` 被调用两次（**at-least-once 语义下这是正常行为**，不是异常）——第二次会**再次**递减所有下游任务的 `deps_remaining`。有 3 个上游的任务在两次重复 complete 后 `deps_remaining` 提前归零，状态被置 `ready` 并被 claim，于是**下游在上游还没做完时就开工了**，"下游 ready ⟺ 所有上游 done"不变量破裂。
- **根因**：完成动作被写成"无条件递减下游计数"，既不检查本任务是否已是终态，也不记录某条依赖边是否已被消费过。
- **最恶劣的性质**：破坏之后**数据库自身是自洽的**——`deps_remaining=0` 且 `status=ready`，任何单点查询都看不出异常，`status()` 输出也完全正常。**事后无法从状态推断出错**，只能靠 events 审计链人工对账，而人通常根本不会去对账。
- **解决**：三层——① **终态守卫**：`complete/fail` 先检查当前状态，已是终态（`done`/`failed`/`dead`）则直接返回幂等结果，不执行任何副作用；② **`task_deps.consumed` 一次性消费**（migration `002-task-deps-consumed.sql`）：递减只对未消费的边生效，消费与递减在同一事务内，重复调用天然无效；③ **`verifyGraphInvariants()` 检测器**：独立重算每个任务的未完成上游数，与 `deps_remaining` 比对，并断言"`deps_remaining>0` 的任务不得是 ready/running"、"=0 的不得是 blocked"——把"无法从状态推断"变成"可以被主动检出"。
- **验证**：`tests/coordinator.test.mjs` 对每个任务重复 complete/fail 各两次，断言下游计数不变、不变量检测器返回空；另有构造性用例（直接改库造出不一致）确认检测器能抓到。

### I8【高】`taskFail` 的 owner 校验空洞（v1.4 审计期发现）
- **现象**：`owner_agent` 为 `null` 时（任务尚未被 claim，或刚被 reclaim）`taskFail` **不做任何身份校验**——任何 agent 都能对他人/未分配的任务上报失败。更糟的是它还能作用于 `blocked` 任务：把一个"依赖未齐"的任务改成 `ready`，**绕过整个依赖图**直接让它可被 claim。
- **根因**：owner 校验写成"若 `owner_agent` 非空则必须匹配"，把 null 当成"无主=谁都可以"；同时没有限制 fail 的合法前置状态。
- **解决**：① 与 `complete` 对齐——owner 不匹配（含 null 情形）一律返回 `NOT_OWNER`；② `fail` **只允许作用于 `running`**（其他状态返回错误而非默默改状态）；③ 未 claim 的任务要退出流程只能走 `team_shutdown` 或过期回收路径，不能靠 fail。
- **验证**：`tests/coordinator.test.mjs` 覆盖"未 claim 任务 fail → NOT_OWNER"、"他人 owner → NOT_OWNER"、"blocked 任务 fail → 拒绝且状态不变"。

### I9【中】幂等键未与 task 绑定（v1.4 实现期发现）
- **现象**：worker A 用 `idempotency_key="k1"` 完成了 task 10；worker B 拿同一个 `k1` 提交 task 20，**返回的是 task 10 的结果**并标 `duplicate: true`。调用方看到 duplicate 会认为"本任务已完成过"，于是 task 20 被当成已完成——实际上它一次都没执行。
- **根因**：幂等键做成了全局（或 team 级）唯一，命中即返回历史结果，未校验这条历史记录属于哪个 task。key 由 worker 生成，撞名不需要恶意（时间戳+短随机就够撞）。
- **解决**：命中幂等记录时**必须校验 `task_id` 一致**：一致才返回缓存结果（真幂等），不一致返回明确错误（key 冲突），绝不跨 task 复用。
- **验证**：`tests/coordinator.test.mjs` 用同一 key 对两个不同 task 提交，断言第二次报冲突错误而不是返回第一次的结果。

### I10【中】dashboard 静态资源鉴权分层（v1.4 实现期发现）
- **现象**：浏览器打开 dashboard 拿到 HTML 后，页面对 `app.js`/`app.css` 的子资源请求**不带 token**（浏览器不会自动加自定义头/查询参数）→ 401 → 页面白屏。由于 token 默认自动生成并要求，**默认路径就是坏的**：用户第一次打开就用不了，只能靠手工拼 URL。
- **根因**：把 token 门加在了所有路由之前。鉴权粒度与"浏览器如何加载子资源"的现实不匹配——真正需要保护的是数据，不是空壳。
- **解决**：**分层**——静态壳（`index.html`/`app.js`/`app.css`，**不含任何数据**）放在 token 门**之前**；所有 `/api/*` 与 SSE 放在门**之后**，页面用 JS 显式带 token 请求数据。附带三项加固：① `/healthz` 最小化（只回存活与版本，**不泄露绝对路径**，避免通过健康检查探测目录结构）；② SSE 连接数上限 + **共享轮询器**（多客户端共用一个数据源轮询，防连接放大成 N 倍 DB 读）；③ eventId 局部化（每连接自增，不暴露全局事件序号，避免泄露活动量）。
- **验证**：`tests/dashboard.test.mjs` 断言无 token 时静态壳 200、`/api/*` 401；超出连接上限时被拒；`/healthz` 响应体不含路径分隔符。仍待真机验证 CSP 实际拦截效果（§10.2 V11）。

---



## 14. 置信度评估（v1.5 装机验收修订）

按"能否照本文档直接实施并达到预期"逐层自评。评级依据是证据类型，不是主观感受。**v1.4 的关键变化**：coordinator/dashboard/hooks/tools 已实现且有测试（578 个测试、102 suites），所以"设计→代码"这一段的风险大幅下降；但**运行时验收的缺口换了位置**——从"没写代码"变成"没在真实环境跑过"（真实 ZCode 会话、多进程并发、CodeGraph 装机、Electron 真机）。**v1.5 的关键变化**：**"真实 ZCode 会话"这一格已经跑过了**——插件装进 ZCode、重启会话、`/omz-doctor` 9/9 spawn ping、`/ulw` 端到端冒烟跑完一个完整生命周期（§18）。这是第一次有**行为级证据**而非"代码 + 测试 + 引擎反查"的三重推断，所以本轮的上调不是乐观，而是证据类型升级；同时也第一次暴露了只有真实会话才看得见的事实（引擎注入工具、skill 数分档、内联块与脚本的净化能力差）。

| 层次 | 内容 | 置信度 | 证据类型 |
|---|---|---|---|
| **宿主机制层** | agents 三来源路径与命名空间规则、frontmatter 十字段解析、模板变量全集、插件 hooks 加载链、子代理工具面、嵌套阻断、skills 可见性、后台通知 | **99%**（维持）<br>其中"只读角色的结构性保证"子项 **↑ 80%**（原 70%；行为级确证后上调，但仍是终态、不再有更高上调路径） | 引擎 `zcode.cjs` **三轮**符号级取证（v1.4 新增模板变量正则、`loadPluginAgentProfiles` 命名空间与保留名、`sanitizeProjectAgentProfile`、`collectPluginHookEvents`、`isReadOnlyTool/isWriteTool/isDestructiveTool`；末轮新增 `hookRunner.run`/`n6r`/`RUr` 的 matcher 判定链与 `XQo`/`Fsi` 的 permissionMode 枚举与映射）+ 官方插件实体样本 + 8 项活体实测 + **v1.5 第四轮装机后行为级实测**（§10.3 第 11–14 条、§10.1 V12）。**子项上调理由**：v1.4 的 70% 里含两部分不确定——(a) Bash 是纪律层（真实缺陷，不可消除）、(b) "白名单是否真的生效"本身只有静态校验与解析链推断。**v1.5 消除了 (b)**：9 个 agent 在真实会话内逐个 spawn，五个受限角色实测**确实拿不到 Edit**、三个全工具角色**确实有 Edit**，逐项与 frontmatter 吻合。剩下的 20% 就是 (a) 加上 v1.5 新发现的第三层——**工具面 = 白名单 ∪ 引擎注入面**（`RespondToCoordinator` 实证，§10.3 第 11 条），后者不可控。**仍是终态**：`permissionMode` 枚举里没有任何值能移除单个工具（§10.1 V8、§17 裁决 3） |
| **协议移植层** | ultrawork 八步、Sisyphus 完成契约、9 对抗类、LIGHT/HEAVY、checkbox + `## Wave <n>` 契约、EXPAND、claim 过门、5-lane 评审 | **98%**（微升） | OmO 四个 SKILL.md 原文逐条对比（§7.5）+ 已落盘的 4 个 SKILL.md 与 11 篇 references。v1.4 微降原因（协议移植表两处语义错误，§17 裁决 1/5）已修正并由 `tests/protocol.test.mjs` 的跨文件契约断言兜住。**v1.5 微升理由**：协议第一次**被真实角色端到端执行**并且**按设计意图拦住了缺陷**——critic 报 4 个 blocker 打回计划、reviewer 判 `needs-fix` 并在复审判 `confirmed`、双证据要求逼出了 failing-first 的真实红色输出（§18）。评审门不是形同虚设（B11 的正向证据）。**不给更高分的原因**：只跑了一个小特性、一条路径；LIGHT/HEAVY 分级、EXPAND、5-lane 评审、`/team` 的 claim 过门这些分支本次都没走到 |
| **编排实现层** | core 波次并行、文件状态总线、category 路由、省流阀、coordinator DAG/mailbox/lease/终态守卫/不变量检测 | **96%**（上调）<br>并发子项 **↑ 90%** | coordinator **已实现**（13 工具、7 态机、`task_deps.consumed` 一次性消费、`verifyGraphInvariants`）并有 `tests/coordinator.test.mjs` 覆盖原子性、幂等、owner 校验、不变量。**v1.4 末轮补上并发压测（§10.1 V9）**：8 进程抢 200 任务 730ms 完成、unique=200、重复 claim=0、`SQLITE_BUSY` 重试 0、不变量 0 violations；`max_parallel=8` 限流经 52 次 `reason:'max-parallel'` 验证。**剩余缺口只是覆盖面而非正确性**：`SQLITE_BUSY` 退避代码路径在该负载下未被触发，慢盘/更高竞争度下的行为仍属推断 |
| **集成选型层** | CodeGraph stdio MCP、plugin-host 启动、MCP 配置路径 | **90%**（下调） | 上游 README/源码交叉核验仍成立，`probeCommand` 的 Windows `.cmd` shim 查找问题已修（按 PATHEXT 逐后缀）。**下调原因**：CodeGraph **仍未装机**（本机无可执行文件，doctor 报 WARN），v1.2 的 94% 里含"很快就能装"的乐观成分，而这一轮并没有装上——`codegraph_explore` 的真实返回形态与索引新鲜度判定（I1）一次都没跑过（§10.2 V10） |
| **触发层** | slash commands（M1）/ 关键词 hook（M2） | M1 **99%** / M2 **85%**（不变） | commands 展开链代码级证实。hook **已实现**（含 B29 的线性扫描与时间预算）且 `--self-test` 30/30、`tests/hooks.test.mjs` 全绿，但这些只证明**脚本本身正确**；`additionalContext` 是否被主 agent 真正看见**仍待装机实测（V3 未变）**，因此不上调。**v1.4 末轮新增两条确证（不改分数，改的是理解）**：① matcher 在 `UserPromptSubmit` 上不参与筛选（`RUr` 不传匹配值，`n6r` 空集合直接 true），启用后每条消息固定付 126–132ms node 启动税；② 顶层 `enabled` 不被插件加载链读取，真闸是元素级 `enabled` 与 `omz.keyword_hook`（§8.2）。默认不启用 `keyword_hook`，回退即常态 |
| **展示层** | Electron dashboard/SSE、token 分层、注入防护 | **85%**（新列） | server 侧已实现并测试（静态壳/API 分层 I10、loopback 绑定、SSE 连接上限、`/healthz` 最小化、字段净化 B27）。**只验证了无 electron 的降级分支**；真机渲染与 CSP 实际拦截效果未验（§10.2 V11） |
| **风险预案层** | B1–B30 + I1–I10 | **95%**（上调） | v1.4 新增的 B22–B30、I7–I10 **全部来自实际实现/审计中命中的缺陷**（不是推演），每条都有对应测试或验证手段；设计期的 B1–B21、I1–I6 中仍有部分未被真实故障样本检验（尤其依赖 profile 装机的 I1/I2/I5/I6）。**v1.5 上调理由**：四条预案在真实环境里取得行为级证据——**B16 结清**（skill 可见，回退方案作废）、**B1 白名单实测生效**、**B20 无 Grep/Glob 复验**、**B30 的修复实测有效**（`ZCODE_SESSION_ID` 确实拿不到、四种分支全部 exit 0 且回退标记明确）、**B27 量化出内联块与脚本的能力差**（41 行 vs 40 行）。**不给更高分**：B2/B5/B8/B9/B17/B18/B19 与依赖 profile 的 I1/I2/I5/I6 仍未被真实故障样本检验 |
| **实现验收** | v1.3 全部规格是否已落地 + 装机后是否按预期运行 | **已完成**：578 tests / 102 suites 全通过、`/omz-doctor` 无 FAIL（1 项 WARN=codegraph 未装）、hook self-test 30/30、9 个 agent frontmatter 校验通过；**v1.5 追加装机验收**：会话内 9/9 spawn ping、`/ulw` 端到端冒烟跑完整生命周期（§18）、`.omz/` 卫生扫描零缺陷、插件仓库未被污染 | v1.4 离线产物 + **v1.5 真实会话产物**（行为级） |
| **整体可交付性** | core 可独立使用，graph/orchestration/dashboard 可选启用并可回退 | **97%（代码交付 + core 装机验收）** | 从 v1.4 的 95% 上调 2 点。**分母未变**（仍是"这套代码能不能在真实环境里按预期跑"），变的是**证据类型**：v1.4 的 95% 建立在"代码 + 测试 + 引擎反查"的三重推断上，真实环境一次没跑；v1.5 的 core 主路径（doctor + ulw 全生命周期）**已在装机后的真实会话里跑通并接受了两轮独立评审**。**为什么只加 2 点而不是更多**：① 缺口数从六项减为五项，减掉的那一项（V12）恰是**唯一卡住 core 的**——剩下五项全在可选层或触发增强层，回退路径都已是常态形态；② 但只跑了**一个小特性、一条路径**，B18 续跑、`/team`、LIGHT/HEAVY、EXPAND 等分支未走到；③ 剩余的 3 点里，V10/V11 各占约 1 点（装机/真机未验）、V3/V4/V8′ 合占约 1 点。**这仍不是生产运行保证** |

**为什么不是 100%（v1.5 装机验收：缺口从六项收到五项，且剩下的都不在 core 主路径上）**

v1.3 的缺口是"东西还没写"；v1.4 的缺口是"写完了，但有几件事只能在真实环境里才能证实"；**v1.5 已经把真实环境跑了一遍**——装机、重启会话、`/omz-doctor` 9/9 spawn ping、`/ulw` 端到端冒烟（§18）。v1.4 末轮结清了 V8 枚举与 V9 压测，**v1.5 结清 V12**（连带结清 B16、给出 B1 的行为级确证），于是剩下**五项**（与 §10.2 的五行一一对应）：

1. **V3 — hook 注入行为**：脚本正确 ≠ 注入生效。`additionalContext` 是否进主 agent 上下文，必须在真实会话里说一句裸 `ulw ...` 才知道。**v1.5 没有顺带结清它**——本次验收全程走斜杠命令（`/omz-doctor`、`/omz-status`、`/ulw`），斜杠路径不触发 `UserPromptSubmit` 注入，两者执行路径无交集。回退：不启用 `keyword_hook`，永久 M1 斜杠命令。**附带的新事实**：matcher 在该事件上不筛任何东西，启用后每条消息固定付 126–132ms 的 node 启动税（§8.2），这是成本而非风险。
2. **V4 — resume 适配器**：需要活的 `agent_id` 与 `SendMessage`。**v1.5 冒烟全程用任务级新 spawn**（两轮 junior、两轮 reviewer 都是新 spawn），未触达 resume 路径。回退即当前基线（任务级新 spawn + coordinator 状态恢复），不依赖 resume。**v1.5 相关新事实**：worker 侧看得见 MCP 工具与引擎注入的 `RespondToCoordinator`（§10.3 第 11/12 条），所以调用权的边界靠纪律而非可见性（§7.4）——这一点与 resume 是否可用无关。
3. **V8′ — 并行 spawn 的权限弹窗行为**：枚举本身已知（§10.1 V8），**这一项不再承载"收紧只读角色 Bash"的期待**——枚举里没有任何值能移除单个工具，分层模型是终态（§17 裁决 3）。剩下要看的只有弹窗是否串行阻塞其他 spawn（B2 兜底：用户先调宽会话权限模式）。**v1.5 未覆盖**：doctor 的 9 次 spawn ping 与冒烟的角色委派都是**顺序**发起，没有制造"不同 `permissionMode` 的 agent 同时 spawn"的场景。
4. **V10 — CodeGraph 装机**：本机无 codegraph，`codegraph_explore` 的真实返回与索引新鲜度判定（I1）一次都没跑过。回退：graph profile 关闭，Explore + Bash grep/rg。
5. **V11 — Electron dashboard 真机**：只验证了降级分支；CSP 实际拦截效果未验。回退：dashboard 关闭，GUI 任务面板 + `/omz-status`。

（V8 的枚举部分与 V9 压测在 v1.4 末轮结清、**V12 与 `/ulw` 端到端冒烟在 v1.5 结清**，均见 §10.1。）五项都有明确回退路径，且**没有一项会让 core 不可用**——更进一步：**减掉的 V12 恰是六项里唯一卡住 core 主路径的**，剩下五项全在触发增强层（V3）、可选适配层（V4/V8′）或可选 profile（V10/V11），回退形态都已是当前的常态发行配置。**97% 是代码交付 + core 装机验收的置信度，不是生产运行保证**；生产运行的门槛是上面各项的验收条款（§10.2）。**新增的诚实边界**：core 主路径只跑过**一个小特性、一条路径**——B18 的中断续跑、`/team` 的 claim 过门、LIGHT/HEAVY 分级、EXPAND 尾巴、5-lane 评审这些分支本次都没走到；`/omz-status` 的内联块在注入面上弱于 `render-status.mjs`（已量化，§13 B27）；子代理可见 skill 数因角色而异且**机制未查清**（§10.3 第 13 条），当前不影响 OMZ 但也不是引擎承诺。

**实施前提醒**：① B19（agent 清单是会话启动快照）仍是最容易让人误判"插件坏了"的坑，装完必须重启会话（附录 D 第 3 步）——**v1.5 装机验收正是先重启会话才拿到 9/9 spawn ping**；② B22（含空格路径导致 CLI 静默 exit 0）是最危险的一类缺陷——**假成功且 doctor 自身也失效**，安装到 `C:\Program Files\…` 或中文路径下时若发现"命令毫无输出"，先怀疑它；③ **跑 `/ulw` 冒烟必须换到系统临时目录**，不要在插件仓库里跑（`.omz/` 会落在工作目录，污染待分发的插件包，§18 卫生前提）；④ 涉及收点判断时看 `render-status.mjs` 的输出，不要只看 `/omz-status` 内联块——两者在注入净化上有实测的能力差（§13 B27）。

---

## 附录 A：agent frontmatter 完整规格

以下 9 个定义是实施时的直接源文件规范（第 10 个角色复用引擎内置 `Explore`，不落文件）。格式对齐引擎实测字段（§10.1 V2）；description 按预算纪律（首句=触发条件，≤2 句）；正文系统提示词此处给骨架（实施时按 §7.5 协议扩写）。v1.4 已按 §17 裁决 1/2/3 更新 atlas、librarian 与只读角色的表述。

**v1.4 末轮：本附录已与 `agents/*.md` 实际文件逐字段对齐。** 附录自称"直接源文件规范"，一旦与落盘文件漂移，照抄的人就会把已修掉的缺陷重新造回来（本轮命中的正是 `omz-looker`：附录仍写 `tools: [Read]` / `maxTurns: 10`，而实际文件早已是 `[Read, Bash]` / `15`，§17 裁决 3、§4 注③、版本历史 v1.4 第 8 条都记了这次修改）。本轮同步的差异：① looker 的 `tools`/`maxTurns`/正文工具面纪律；② planner/deep/junior/reviewer 四条 description ——实际文件补了**负向触发句**（"单步骤单文件任务勿派"/"范围清晰的标准任务勿派,用 junior"/"单文件 typo 级小改勿派"/"门未触发勿派"），这是更好的版本（负向条款直接压制误派，成本仅几个 token），故以实际文件为准回写附录。

```markdown
# agents/omz-planner.md
---
name: omz-planner
description: "当任务满足规划门槛(≥2 步骤/多文件/含架构决策)或用户要求工作计划/访谈时委派。访谈式规划顾问:产出分波次计划,自己绝不实现;单步骤单文件任务勿派。"
color: blue
tools: [Read, Bash, Write]
maxTurns: 30
thoughtLevel: high
---
你是 Prometheus(OMZ 版),规划顾问。移植自 OmO ulw-plan 协议(§7.5.1):
[意图路由 CLEAR/UNCLEAR → 两道过滤器 → owner-decision 必问 → 计划工件语法(零列 checkbox
-N./终验 F<n>./嵌套 category 注解) → 批准门等待 → 绝不执行]
```

```markdown
# agents/omz-critic.md
---
name: omz-critic
description: "当一份计划草稿成形、尚未批准执行时委派。计划差距分析师:找遗漏场景/隐含假设/依赖风险,只评审不修改。"
color: orange
tools: [Read, Bash]
maxTurns: 15
thoughtLevel: high
---
你是 Metis。逐节审查计划:决策完备性(执行者零判断点)、范围完整性、依赖矩阵一致性、
验收标准可证伪性。输出分级清单(blocker/major/minor+行号)。
```

```markdown
# agents/omz-deep.md
---
name: omz-deep
description: "当任务属于 deep 类(棘手调试/研究密集/微妙跨模块)且需要端到端自主实现时委派。给目标不给步骤的深度自主编码者;范围清晰的标准任务勿派,用 junior。"
color: green
# 全工具 = 完全不写 tools 这一行。切勿写成 `tools: []`——空数组是"空白名单"（拿不到任何工具），
# 与"省略字段=继承全工具"语义相反。B23 的教训正是解析器对 tools 的语义差异极敏感。
maxTurns: 80
thoughtLevel: high
---
你是 Hephaestus。收到的是目标而非配方:
[开工先做代码库探索(经 Bash grep/rg;你不能 spawn Explore) → failing-first 证明 → 实现 →
基线表征测试 → 自测双证据 → DoneClaim JSON 返回]
同一错误连续 3 次修复失败必须停下回报(B6)。未经派发单授权不得删除任何文件。
```

```markdown
# agents/omz-junior.md
---
name: omz-junior
description: "当任务可独立完成、范围清晰、属单 lane 执行类(标准特性/文档/UI 组件等)时委派。聚焦单任务执行器,禁止再委派;单文件 typo 级小改勿派,主 agent 自己干。"
color: green
# 全工具 = 省略 tools 行（不要写 `tools: []`，见 omz-deep 的说明）
maxTurns: 40
thoughtLevel: medium
---
你是 Sisyphus-Junior。铁律:你是叶子执行者——你的工具清单没有 Agent 工具,
结构上不可能委派,也不要求。收到 8 要素 prompt:按约束实现,返回 DoneClaim。
```

```markdown
# agents/omz-atlas.md
---
name: omz-atlas
description: "当需要按已批准计划逐波驱动执行(/ulw-execute 场景)时委派。波次状态机与派单建议生成器,沟通型汇报;自己不 spawn 不实现。"
color: green
maxTurns: 60
thoughtLevel: high
---
你是 Atlas,ulw-execute 的**波次状态机 + 派单建议生成器 + 汇报器**(§7.5.2、§17 裁决 1):
[计划选择(按 `## Wave <n>` 切波) → Boulder 更新 → 逐 checkbox LIGHT/HEAVY 分级 →
**产出 8 要素派单建议(不 spawn,交还主 agent)** → 收点判定(只认 results 文件;你收不到后台通知) →
五 gate 验证 → ledger append → checkbox 翻转]
ORCHESTRATOR-NEVER-IMPLEMENTER 铁律 + 10 条 Hard rules 全文照搬。
遇到需要实现的活:既不自己写也不 spawn,一律写成派单建议回请主 agent。
```

```markdown
# agents/omz-oracle.md
---
name: omz-oracle
description: "当遇到架构决策/疑难调试/需要第二意见的技术判断时委派。资深架构顾问:只分析给方案,不动任何代码。"
color: purple
tools: [Read, Bash]
maxTurns: 20
thoughtLevel: max
---
你是 Oracle。咨询模式:读代码(Bash grep/rg + Read)、给判断、给方案、给权衡,
输出固定格式(结论先行/论据带 file:line/反方视角)。绝不修改文件。
```

```markdown
# agents/omz-reviewer.md
---
name: omz-reviewer
description: "当评审门触发(措辞严格/≥3 文件/≥20 轮/≥30 分钟/重构迁移性能安全)或需 AdversarialVerify 裁决 DoneClaim 时委派。独立只读对抗评审,分级 blocker/major/minor;门未触发勿派。"
color: red
tools: [Read, Bash]
maxTurns: 25
thoughtLevel: high
---
你是 Momus,对抗性评审者。每条发现必须含 [级别] 文件:行号 问题 修复建议;
必须显式回答"未发现 X 类问题"(穷举式排查,空报告是结论不是敷衍);
confirmed 是唯一通过裁决(§7.5.2 Sisyphus 完成契约)。复审上限 2 次。
**只读性是分层的**(§17 裁决 3、§4 三层模型):你没有 Edit/Write(结构约束,v1.5 已实测确证),但 Bash 能写文件——
禁止用 `>` 重定向、`node -e fs.*`、`git checkout/apply` 等任何方式改动仓库(纪律约束)。
发现问题只报不改。
```

```markdown
# agents/omz-librarian.md
---
name: omz-librarian
description: "当需要查外部文档/API 用法/版本兼容/第三方库资料时委派。检索员:按 URL 抓全文,输出带来源引用的结论。"
color: cyan
tools: [Read, Bash, WebFetch]
maxTurns: 15
thoughtLevel: low
---
你是 Librarian。**本部署无 WebSearch**(§17 裁决 2):只能 ① WebFetch 抓已知 URL 全文,
② Bash grep/find/rg 做本地取证。重要结果抓全文——snippets lie;
CONTEXT 里没有任何 URL 且本地推不出入口时,明确回报"需要主 agent 提供检索入口"并停止,不得凭记忆编造。
输出每条结论带 [Source N] 引用与访问日期。
```

```markdown
# agents/omz-looker.md
---
name: omz-looker
description: "当需要视觉分析(截图/图表/渲染工件)或 visual-QA 门时委派。多模态检查员:只看图,输出逐图判定;须给全图片路径清单。"
color: yellow
tools: [Read, Bash]
maxTurns: 15
---
你是 Multimodal Looker。**输入契约**:派发方必须给逐图路径清单 + 每图预期;缺预期先回报缺口
(没有判据的 pass 是质量事故)。**工具面纪律**(§17 裁决 3):Read 看图需精确路径,
**Bash 仅用于枚举图片路径**(`ls`/`find -name '*.png'` 一类只读命令),**禁止任何写操作**——
禁 `>`/`>>` 重定向、禁 `mv/rm/cp`、禁任何格式转换或改名。**PDF 须由派发方先转为逐页图片,
你不做格式转换**(Read 对 PDF 的直读能力未验证,不得假设)。
逐图检查:资产正确性(宽高比/裁切/水印/分辨率)、图表与正文一致(数值有无标签单位)、
版面缺陷(文字溢出/空白页/重叠/截断/对比度)。输出每图一行判定(pass/fail:<缺陷+位置>+证据),
末尾给 total/pass/fail 汇总;打不开的图记 `unreadable`,不得记 pass。
```

**内置 explore 复用说明**：引擎内置 Explore（只读搜索代理）即 OmO 的 explore 角色，不重复定义。ZCode 侧文件搜索在子代理中经 Bash grep/find/rg 完成（B20）。

## 附录 B：commands 规格

| 命令 | 参数 | 展开内容要点 |
|---|---|---|
| `/ulw <目标>` | `$ARGUMENTS` | ultrawork 八步宪法全文（§6）+ **第零步会话标识前置**（` ```! ` 执行块取 `OMZ_GOAL_STEM`，§13 B30）+ B21 例外措辞 + Hard rules 10 条 + 宪法检查清单引用 goal.json |
| `/team <目标>` | `$ARGUMENTS` | Team Mode 编排指令（§7.2 七步协议 + §7.4 resume 规则 + "以文件为准"收点原则） |
| `/hyperplan` | 无 | 只走规划：omz-planner 访谈 → omz-critic 差距分析 → 批准门等待（不执行） |
| `/omz-status` | 无 | ```` ```! ```` 块跑 node 脚本渲染 `.omz/`（波次×任务×状态×耗时，40 行上限，聚合超出部分） |
| `/omz-doctor` | 无 | 自检清单：① 逐 agent spawn ping（含探针暗语；离线只做静态校验，会话内才能真 spawn——**v1.5 已在真实会话完成 9/9，§10.1 V12**；回执含子代理自报工具面与自报可见 skill 清单）；② frontmatter model 与已登记供应商模型比对；③ `.omz/` 在 .gitignore 检查；④ agent 文件 mtime vs 会话启动时间（B19 提示重启）；⑤ BOM 与路径扫描（B4/B3/B26）；⑥ 配置分层报告（§3.3 优先级）；⑦ Node/SQLite/git/codegraph/coordinator/dashboard 可用性与 profile 降级报告 |

命令文件 frontmatter：`description`（一句触发说明）+ 正文即提示词模板，`$ARGUMENTS`/`$1..$N` 展开由引擎处理。

## 附录 C：skills 目录规格

| Skill | 载体 | 核心内容（对应 §7.5 协议） |
|---|---|---|
| `ulw-plan` | skills/ulw-plan/SKILL.md | Prometheus 规划协议：意图路由/两道过滤器/owner-decision/计划工件语法（checkbox + `## Wave <n>`，§17 裁决 5）/批准门/双工件（`.omz/drafts/` → `.omz/plans/<slug>.md`）/references/{intent-clear,intent-unclear,full-workflow}.md |
| `ulw-execute` | skills/ulw-execute/SKILL.md | Atlas 执行协议：Boulder schema/LIGHT-HEAVY/8 要素**派单建议**（不 spawn，§17 裁决 1）/9 对抗类/收点只认 results 文件/Sisyphus 契约 JSON/ledger.jsonl 字段/10 Hard rules |
| `ulw-research` | skills/ulw-research/SKILL.md | 饱和调研协议：5 认识论文档模板/scaling floor 表/EXPAND 尾巴/excursion 规则/claim 过门/收敛规则/交付双出+双 gate/references/worker-prompt.md；产物落 `.omz/research/<slug>/` |
| `review-work` | skills/review-work/SKILL.md | 5-lane 评审协议：lane 配置/Phase 0 上下文收集清单/worktree 纪律/INCONCLUSIVE 规则/报告模板/references/{lane-prompts,verdict-schema}.md |

SKILL.md frontmatter：`name` + `description`（触发语义照搬 OmO 原文措辞的严格激活条款，防误触发）。四个 skill 均为**提示词协议文本**——无脚本依赖（scaffold-plan.mjs 的工件语义由 agent 按模板手写实现，§7.5.1）；实际落盘另含 11 篇 `references/`。

## 附录 D：M1 装机检查单

1. `.zcode-plugin/plugin.json`：声明 `commands`/`skills`/`mcpServers`——**不声明** `agents`（该键在本运行时是诊断-only，子代理由引擎扫 `agents/*.md` 加载）也**不声明** `hooks`（引擎自动发现 `hooks/hooks.json`，再声明一遍会得到重复文件 warning）；路径变量只能用 `${ZCODE_PLUGIN_ROOT}`/`${ZCODE_PROJECT_DIR}`（**`${pluginDir}` 不是引擎变量**，§10.3 第 1 条）；coordinator MCP 默认 `enabled:false`；关键词 hook 默认经 `omz.keyword_hook: false` 关闭——**注意 hooks.json 顶层 `enabled` 不被读取**，要在引擎层彻底关掉须用元素级 `enabled: false`（§8.2 三层开关）。
2. 9 个 agent 文件按附录 A 落盘（第 10 个角色复用内置 `Explore`）；`node tools/validate-frontmatter.mjs` 通过（YAML 含 dash 数组支持 B23、工具名分类校验 B24）。
3. **重启会话**（B19：agent 清单会话启动快照）。
4. `/omz-doctor` 无 FAIL（含 spawn ping 9/9、model 校验、gitignore、mtime、BOM/路径扫描、配置分层、profile 降级报告）。**注意**：离线跑时 spawn ping 只做静态校验，真 spawn 需会话内。**v1.5 已完成这一步的真实会话验收**：9/9 全部返回 `OMZ-PONG`（§10.1 V12）；回执里的自报工具面与自报可见 skill 清单请一并核对——前者验白名单（B1）与引擎注入面（§4 第三层），后者验四个 OMZ skill 是否在列（B16）。
5. **若插件装在含空格或非 ASCII 的路径下**（`C:\Program Files\…`、中文目录），先手工确认每个 CLI 入口都有非空输出——B22 的失效形态是**退出码 0 的静默无输出**，doctor 自己也检不出来。
6. V3/V4/V8′ 三项装机实测（§10.2），结论回写本文档；V10/V11 按各自条款排期（V8 枚举与 V9 并发压测在 v1.4 末轮结清、**V12 在 v1.5 结清**，均见 §10.1）。
7. 冒烟：`/ulw 一个跨 2 文件的小特性`（M1 验证标准，§9）。**必须在系统临时目录里造靶子项目，不要在插件仓库里跑**——`/ulw` 会在工作目录创建 `.omz/`，在插件仓库跑会把运行时状态混进待分发的插件包。可复现的完整链路（靶子构造、四个 critic blocker、failing-first 判据、reviewer 两轮、七项终态判据）见 **§18**。

---

## 15. 默认聊天模式影响与隔离策略

### 15.1 结论

**不会改变 ZCode 的默认聊天模式。**安装 OMZ 后，用户仍可以像以前一样直接聊天、问问题、读文件或做普通单轮任务；不会自动被改写成 `/ulw`、`/team`，也不会因为存在多个 `agents/*.md` 就强制启动团队。

OMZ 的默认行为是 **core + 显式触发**：

- `core` profile 默认启用：agents、commands、skills 的定义可被 ZCode 发现，但 `/ulw`、`/team`、`/hyperplan` 只有用户明确输入时才激活。
- `graph`、`orchestration`、`dashboard` 默认关闭，必须显式启用；它们不会在普通聊天中自动连接、索引、创建任务或启动本地端口。
- M2 `UserPromptSubmit` 关键词 hook 默认关闭。即使启用，也只识别明确的模式词并做会话级去重；普通文本中出现代码变量、引用或讨论“ulw/team”的场景不得误触发。
- 子代理 description 会进入 ZCode 的 agent 发现上下文，带来少量固定 token 成本（9 条）；但**不会自动执行**。主 agent 只有在任务符合 description 且满足显式触发/编排条件时才委派。
- `quick` 单文件小改、普通问答、解释代码、翻译和闲聊不创建 team、不连接 CodeGraph、不写 `.omz/` 状态。

### 15.2 影响矩阵

| 场景 | 是否启动 OMZ 编排 | 是否改变回答方式 | 额外成本 |
|---|---:|---|---:|
| 普通聊天/问答 | 否 | 否 | agent description 的小额上下文 token |
| 普通代码阅读/解释 | 否 | 否 | 小额上下文 token；不启动子代理 |
| 单文件 quick 修改 | 否（主 agent 直接处理） | 否 | 无子代理成本 |
| 明确 `/ulw <目标>` | 是 | 是，执行 ultrawork 生命周期 | 模式提示词 + 规划/验证子代理 |
| 明确 `/team <目标>` | 是 | 是，启用多 worker 调度 | 并行 worker + coordinator（若开启） |
| 普通文本中出现 `team`/`ulw` | 否 | 否 | hook 关闭时无；hook 启用时每条消息固定 126–132ms 进程开销（matcher 不筛，§8.2） | 
| 显式启用 graph profile | 仅相关代码任务调用 | 仅代码关系探索增强 | CodeGraph MCP/索引资源 |

### 15.3 隔离保证

1. **触发隔离**：commands 采用显式命令；hook 默认关闭（真闸是 `omz.keyword_hook`，**不是 hooks.json 顶层 `enabled`**——后者不被读取，§8.2）；命令与 hook 有互斥和会话级去重（B5）。**残余成本**：hook 条目留在事件表里时，即便不注入也会每条消息起一次 node 进程（126–132ms，因为 `matcher` 在该事件上不筛），要连这个也隔离须用元素级 `enabled: false`。
2. **资源隔离**：没有 `/team` 就不创建 coordinator team；没有代码关系需求就不调用 CodeGraph；没有 dashboard 请求就不启动 BrowserWindow/SSE。
3. **状态隔离**：普通聊天不写 `.omz/goal`、`.omz/runtime`、`coordinator.sqlite`；状态目录只在对应 workflow/profile 激活后创建。
4. **权限隔离**：普通聊天继续使用用户当前 ZCode 权限；只读 reviewer 的 `tools` 白名单不影响主 agent（该白名单本身是"结构 + 纪律 + 引擎注入面"三层，§4、§17 裁决 3）；coordinator/dashboard 不能扩大主 agent 权限。
5. **故障隔离**：可选 profile 的连接失败只导致该增强不可用，并回退到 core；普通聊天不应因 CodeGraph、SQLite、dashboard 或 hook 故障失败。
6. **卸载隔离**：删除/停用 OMZ 后，ZCode 普通聊天、用户原有 agents、skills、MCP 配置不被修改；`.omz/` 是项目自有状态，卸载前由 `/omz-doctor` 提示保留或清理。

### 15.4 可能的负面影响与控制

- **上下文变长**：9 条 agent description 和 OMZ skill 元数据增加少量固定上下文。控制：description 每条 ≤2 句、总量约 400 token；完整协议只在明确激活后加载。
- **误委派**：主 agent 可能把普通任务交给子代理。控制：description 写严格触发条件；`quick`/普通聊天明确禁止 spawn；/omz-doctor 记录异常委派。
- **用户感知变慢**：显式 `/ulw` 会先探索、规划和评审，这是预期行为；普通聊天不经过这些阶段。
- **后台资源占用**：只有启用 orchestration/dashboard 后才有 SQLite、sidecar 或端口；退出 workflow 时关闭 worker、server 和 dashboard，并写清理收据。
- **输出风格变化**：/ulw 与 /team 会返回状态、证据和阶段信息；普通聊天保持 ZCode 原有回答风格，不注入 ULTRAWORK 标记。

### 15.5 默认配置

```jsonc
{
  "omz": {
    "profile": "core",
    "keyword_hook": false,
    "graph": { "enabled": false },
    "orchestration": { "enabled": false },
    "dashboard": { "enabled": false },
    "auto_team": false,
    "auto_ulw": false
  }
}
```

这组配置是 OMZ 的产品默认值，可被 `.zcode/config.json` 的 `omz` 键（团队共享）或 `.omz/config.json`（本机私有，优先级最高）覆盖——层级与副作用见 §3.3 与 §17 裁决 12。后续若用户主动打开某个 profile，只影响该 profile 的代码任务；不应把“已安装 OMZ”解释为“所有聊天进入多 agent 模式”。

**`keyword_hook: false` 是 M2 的语义层真闸（v1.4 末轮明确，§8.2）**：`hooks/hooks.json` 的顶层 `enabled` 不被插件加载链读取，所以关掉 M2 靠的是这个键（脚本自检后输出纯 `{}`）。注意它只免除**注入**，不免除**进程启动**——`matcher` 在 `UserPromptSubmit` 上不参与筛选，hook 条目只要还在事件表里，每条用户消息就仍会起一次 node 进程（实测 126–132ms）。若要连这笔开销也省掉，须在 hooks 数组的**元素级**加 `"enabled": false`（运行层真闸）或直接移除该条目。

---

## 16. 仓库策略与上游同步

### 16.1 结论：新建 OMZ 仓库，选择性同步 OmO

**不要把整个 `oh-my-openagent` fork 后直接改成 ZCode 版，也不要把全部能力从零重写。**采用混合方案：

- **新建独立 OMZ 仓库**：实际运行代码按 ZCode 原生插件格式组织；不把 OpenCode/Codex runtime 带入产品主线。
- **选择性移植 OmO 协议**：ultrawork、ulw-plan、ulw-execute、ulw-research、review-work、DoneClaim/AdversarialVerify、9 个对抗类、计划 checkbox、EXPAND/claim graph 等 Markdown 协议从 OmO 参考或同步。
- **ZCode 适配层独立实现**：Agent 调度、MCP、SQLite coordinator、Windows/Electron dashboard 自己维护，不直接复制 OpenCode 的 `AgentConfig`、`task(category=...)`、`team_*`、`primary`、Codex `multi_agent_v1` 或 tmux runtime。
- **CodeGraph 独立依赖**：直接接上游 `@colbymchenry/codegraph` MCP，不 fork OmO 的 `@sisyphuslabs/codex-codegraph` bridge。

原因：OmO 的宿主运行时强绑定 OpenCode/Codex；整仓 fork 会引入大量不兼容 API、造成上游合并冲突、保留不可运行功能并增加许可证边界；完全从零又会丢失已验证的编排协议。混合方案把“协议复用”和“宿主实现”分离，后续更新只需处理有价值的变更。

### 16.2 推荐目录

```text
omz/
├── .zcode-plugin/plugin.json
├── agents/                 # 9 个 ZCode agents/*.md（第 10 个角色复用内置 Explore）
├── commands/               # ulw/team/hyperplan/status/doctor
├── skills/                 # 4 个核心 SKILL.md + 11 篇 references
├── hooks/                  # hooks.json + keyword-detect.mjs（默认关闭）
├── mcp/
│   └── coordinator/        # OMZ 自有 SQLite/MCP 调度层（13 工具）
├── dashboard/              # 可选 Electron/SSE 展示层（server + main + renderer）
├── adapters/zcode/         # ZCode transport/capability/fallback/path
├── upstream/
│   ├── omo-sources.lock.json
│   └── README.md
├── tools/
│   ├── sync-omo-skills.mjs
│   ├── validate-frontmatter.mjs
│   ├── render-status.mjs
│   ├── doctor.mjs
│   └── lib/is-main.mjs     # CLI 入口判定共享实现（B22）
├── tests/                  # protocol/coordinator/fallback/integration/cli/hooks/path/dashboard/…
├── LICENSE
└── README.md
```

`upstream/` 只记录来源版本、文件路径、commit SHA、许可证和移植状态；`adapters/zcode/` 隔离宿主差异；`tools/` 与 `tests/` 是运维与回归基座（v1.5：102 suites / 578 tests）；OMZ 实际运行代码全部位于自己的 `agents/`、`commands/`、`skills/`、`hooks/`、`mcp/` 与 `dashboard/`。

### 16.3 Git 分支与同步纪律

保留 OmO 上游 remote，但**不把上游分支直接 merge 到 OMZ 主线**：

```bash
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git
git fetch upstream

git diff upstream-sync..upstream/dev -- \
  packages/shared-skills/skills/ulw-plan \
  packages/shared-skills/skills/ulw-execute \
  packages/shared-skills/skills/ulw-research \
  packages/shared-skills/skills/review-work \
  packages/prompts-core/prompts/ultrawork
```

建议分支：`main`（OMZ 可运行代码）、`upstream-sync`（OmO 快照/对比记录）、`porting/<date-or-version>`（一轮协议移植）。同步流程：

1. `git fetch upstream`，只比较锁定的协议路径。
2. 判断变更是纯 prompt 协议还是 OpenCode/Codex 宿主 API。
3. 纯协议变更移植到对应 ZCode SKILL/command；宿主变更登记为“不适用”或改写到 adapter。
4. 更新 `upstream/omo-sources.lock.json`、变更日志和许可证记录。
5. 跑协议、fallback、Windows/MCP 回归；通过后才合并 OMZ 主线。

禁止直接执行 `git merge upstream/dev`。OmO 版本升级不会自动进入生产代码，必须通过这条筛选路径。

### 16.4 来源锁定文件

```json
{
  "source": "code-yeongyu/oh-my-openagent",
  "branch": "dev",
  "commit": "<固定 commit SHA>",
  "synced_at": "<ISO-8601>",
  "ported_paths": [
    "packages/shared-skills/skills/ulw-plan/SKILL.md",
    "packages/shared-skills/skills/ulw-execute/SKILL.md",
    "packages/shared-skills/skills/ulw-research/SKILL.md",
    "packages/shared-skills/skills/review-work/SKILL.md"
  ],
  "ignored_paths": [
    "packages/omo-opencode",
    "packages/omo-codex",
    "packages/team-core",
    "packages/tmux-core",
    "packages/model-core"
  ]
}
```

每次同步必须保留原始 SHA，避免以“当前 latest”代替可复现来源；第三方许可证和 NOTICE 一起记录。

| 结论 | 来源 | 等级 / 使用方式 |
|---|---|---|
| ZCode 支持 stdio/HTTP/SSE MCP；用户级 `~/.zcode/cli/config.json`、工作区 `.zcode/config.json`；会话启动自动连接 | [ZCode MCP 服务文档](https://zcode.z.ai/cn/docs/mcp-services) | 官方公开契约 |
| 子代理独立上下文、前后台运行、结果回主对话、不能再派生；公开文档无 Team/mailbox/resume API | [ZCode 子智能体文档](https://zcode.z.ai/cn/docs/subagents) | 官方公开契约；未写明的能力不当稳定 API |
| Goals 每会话一个目标、可 pause/resume/clear、状态持久；闲时任务是全局 FIFO、持久、失败不自动重试 | [ZCode Goals](https://zcode.z.ai/cn/docs/goal)、[闲时任务](https://zcode.z.ai/cn/docs/idle-time-tasks) | 官方公开契约；不将闲时任务冒充 DAG |
| 插件可声明 agents/commands/skills/hooks/mcpServers；channels/lspServers/settings 不执行 | [ZCode 官方插件仓库](https://github.com/zai-org/zcode-plugins)、本机 document-skills manifest | 官方源码/本机实体样本 |
| `codegraph_explore` 上游、Windows、MIT、MCP、初始化/安装 | [CodeGraph README](https://github.com/colbymchenry/codegraph)、[MCP tools](https://github.com/colbymchenry/codegraph/blob/main/src/mcp/tools.ts)、[OmO codegraph bridge](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/codegraph) | 上游源码/README；M1-G 必须锁版本并运行验收 |
| vardiya 的 SQLite WAL/atomic claim/heartbeat/retry/DLQ/priority/delay/cron/Node >=22 | [vardiya](https://github.com/Zulwatha/vardiya) | 候选上游；Windows 完整支持和 native ABI 仍需验收，不默认锁死 |
| SQLite RETURNING、事务、WAL、busy_timeout 语义 | [RETURNING](https://www.sqlite.org/lang_returning.html)、[Transactions](https://www.sqlite.org/lang_transaction.html)、[WAL](https://www.sqlite.org/wal.html)、[busy_timeout](https://www.sqlite.org/pragma.html#pragma_busy_timeout) | 官方数据库语义；coordinator 实现必须遵守 |
| Electron main/renderer/preload/utilityProcess 边界；**sandboxed preload 不能用 ESM import** | [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox) | 官方架构文档。后半条是 §13.5 I5 撤下 preload 那道承诺的直接依据（`sandbox: true` 与 `.mjs` preload 互斥），OMZ 实现最终**不含 preload** |
| SSE 单向事件流与自动重连 | [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) | Web 平台文档；命令另走 fetch/IPC |
| Windows Terminal `wt split-pane` | [Windows Terminal 命令行参数](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments) | 官方文档；只作调试旁路 |

**证据冲突处理**：ZCode hooks 网页对 `async: true` 的描述与本机随附 diagnosing-hooks guide（“async 当前无 runtime effect、hooks inline”）冲突。v1.2 采用更保守的已安装 runtime guide：按同步执行设计；V3 探针通过后再启用 async 相关优化。

---

## 17. 实现期架构裁决（v1.4 新增）

以下十二条是**实现时必须做出的判断**：设计文档没写、写错、或写了但与已知事实（尤其 V5"子代理不能 spawn"与工具面现实）矛盾。每条给"设计期表述 → 事实 → 裁决 → 影响面"。这一节是 v1.3 与实现之间的差异清单，后续修改设计必须先读它。

### 裁决 1：子代理不能 spawn，凡"被 spawn 的角色再派发"的协议一律改写为"产出派单建议 + 回请主 agent"

- **设计期表述**：§7.5.1 写 "Prometheus 派生只读子代理 explore/librarian/metis/momus"，§7.5.2 写 "Atlas 派发 8 要素"。
- **事实**：V5 早在设计期就确认子代理无 Agent 工具（§10.1），但协议移植表的表述没跟着改。
- **实现后果**：`omz-atlas` 按字面语义**整体不可执行**——它被 ORCHESTRATOR-NEVER-IMPLEMENTER 禁止实现，又没有 Agent 工具无法委派，**一旦被 spawn 必然违规**（要么越界实现，要么空转）。
- **裁决**：重写为「波次状态机 + 派单建议生成器 + 汇报器」——管账本、LIGHT/HEAVY 分级、五 gate、ledger，产出可直接粘贴的 8 要素 prompt **交还主 agent** 执行 spawn。Prometheus 的"派生"同样改为回请主 agent。
- **影响面**：§4 角色表与注、§7.5.1、§7.5.2（含新增前置约束段）、附录 A 的 omz-atlas 骨架、`agents/omz-atlas.md` 正文。

### 裁决 2：`WebSearch` 在本部署不可用

- **设计期表述**：§4 角色表与附录 A 给 omz-librarian 配 `[Read, Bash, WebFetch, WebSearch]`。
- **事实**：引擎有 `WebSearch` 这个名字且归入 `isReadOnlyTool`（§10.3 第 5 条），但当前部署（含主 agent）的实际工具面里没有它，子代理实测清单也没有。
- **裁决**：删除 `WebSearch`，librarian 的检索改为 ① WebFetch 抓已知 URL 全文 ② Bash 本地取证 ③ **无入口时明确向主 agent 索取检索入口并停止**（不得凭记忆编造）。
- **更一般的教训**：**"引擎里有工具名"不等于"当前部署可用"**。这条已升格为通用规则：进 §13 B24，并在 §10.2 加验证条款（引擎取证得到的能力必须再确认部署是否下发）。
- **影响面**：§4 角色表、附录 A、§13 B20 附注、新增 §13 B24、`agents/omz-librarian.md`、`tools/validate-frontmatter.mjs`。

### 裁决 3：只读角色的"结构性保证"是有限的

- **设计期表述**：§4 写"这不是提示词约定而是结构性保证（reviewer 物理上改不了代码）"；§13 B11 写"① 工具白名单只读（结构上防顺手帮改）"。
- **事实**：引擎自己把 `Bash` 归为 `isWriteTool` **且** `isDestructiveTool`（§10.3 第 5 条）。`tools: [Read, Bash]` 的角色能用 `>` 重定向、`node -e fs.writeFileSync`、`git checkout` 写文件。
- **裁决**：两句话都是**过度承诺**，改为分层模型——**Edit/Write 是结构约束，Bash 只读是纪律约束**。B11 的防线从"四道"改为"**三道结构 + 一道纪律**"。注意：v1.4 前 `omz-looker` 的 `[Read]` 曾是唯一完全结构性只读的角色，但实现期发现它因此拿不到待检图片的路径而不可用（Read 需精确路径、无 Bash 无法枚举），已补 `Bash`；至此 5 个质量角色全部落入分层模型，没有例外。**v1.5 装机实测追加第三层**：工具面 = frontmatter 白名单 ∪ **引擎注入工具**（`RespondToCoordinator` 实证，9 个子代理全部持有且不受白名单约束，§10.3 第 11 条）——白名单是"能声明什么"的上界而非工具面全集，这一层没有 OMZ 侧控制点。三层模型的完整表述见 §4。
- **收紧路径：没有（v1.4 末轮改为终态结论）**。v1.4 原文把 `permissionMode` 当作"唯一能把 Bash 也变成结构约束的手段"，这是**会落空的期待**。引擎枚举已直接取出（§10.1 V8）：`["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`，子代理映射（`Fsi`）为 `bypassPermissions`/`dontAsk` → yolo、`acceptEdits` → edit、`auto` → auto、`plan` → plan、`default`/未写 → 继承。**枚举里没有任何值能移除单个工具**——它调的是"批准动作的宽严"，不是工具白名单；最接近的 `plan` 也是**全局模式**（整个子会话不落盘），既不能只关 Bash，也会连带废掉 looker 枚举路径、librarian 本地取证这些必需的只读 Bash 用法。因此：**分层模型（Edit/Write 结构 + Bash 纪律 + 引擎注入面不可控）是终态，不是过渡态**。真要把 Bash 变成结构约束，只有等引擎提供 per-tool 拒绝能力（如 PreToolUse 侧的 `permissionDecision: deny` 配上按 agent 分流的匹配条件）——那是引擎侧特性请求，不在本项目可控范围。V8 剩余的待实测项只有"并行 spawn 时的权限弹窗行为"（→ §10.2 V8′、§13 B2），与只读性无关。
- **v1.5 装机实测对本裁决的影响（结构层从推断升为实测，结论不变）**：五个受限角色的实测工具面**确实无 Edit**、三个全工具角色**确实有 Edit**（§10.1 V12），所以"结构约束这一半是真的"已有行为级证据；§14 据此把"只读结构性保证"子项从 70% 上调到 80%。**但裁决本身不变**——Bash 仍是纪律层，且新发现的引擎注入面让"工具面完全可控"这个假设也不成立。
- **影响面**：§4 设计要点（v1.5 扩为三层）、§13 B1（白名单行为级确证）、§13 B11、§14 置信度（该子项 v1.4 下调至 70%，**v1.5 上调至 80%**）、`agents/omz-reviewer.md` 等只读角色正文（已改为诚实表述）、§10.1 V8（枚举已取出）与 V12（行为级实测）、§10.2 V8′（只剩弹窗行为）、§10.3 第 11 条（引擎注入面）。

### 裁决 4：Stop hook 未实装

- **设计期表述**：§13 B17 与 §6 收尾都写"Stop hook 落盘 boulder.json / 核对宪法清单完成度"。
- **事实**：`hooks/hooks.json` 只注册 `UserPromptSubmit`。
- **裁决**：改为「**主 agent 每波次收点后主动写 `.omz/boulder.json`**」，并明确标注 Stop hook 属 **M4 未实装项**。已知缺口：异常终止会丢失最后一个收点之后的进展，也不会自动阻断"完成"结论。
- **影响面**：§6 新增收尾落盘段、§13 B17、§9 M4 行、§7.5.2 Boulder 行。

### 裁决 5：波次语法统一为 `## Wave <n>`

- **设计期表述**：§7.5.1 的计划工件语法表只规定了零列 checkbox 与 `Recommended task executor category:` 注解，**没定波次分隔符**。
- **实现后果**：出现了 `Wave <n>:` 与 `## Wave <n>` 两种写法，而波次分隔符和 checkbox 一样是 **ulw-plan ↔ ulw-execute 的机器契约**（Atlas 按此切波、`/omz-status` 按此归组），两种写法等于契约破裂。
- **裁决**：统一为 `## Wave <n>`（Markdown 二级标题）。§7.5.1 语法表已补该行。
- **影响面**：§7.5.1、§3.5（plans 行注）、§6 第 5 步、`skills/ulw-plan/*`、`agents/omz-atlas.md`、`tools/render-status.mjs`。

### 裁决 6：coordinator 的任务状态是 7 态，§7.3 的 4 态是镜像投影

- **设计期表述**：§7.3 的 JSON 只列 `pending | running | done | failed`。
- **事实**：调度必须有 `blocked`/`ready`（区分依赖未齐与可发牌）与 `dead`（dead-letter），§13.5 I3 又要求 `unknown`。
- **裁决**：**SQLite 的 7 态是事实源**，`exportMirror()` 投影为 4 态**并额外保留 `coordinator_state` 原始态**。不保留原始态的话，审计镜像会丢失 dead-letter（不会再发牌）与 unknown（可回收重派）的区分——两者运维动作完全不同。
- **影响面**：§7.3 全节重写（含投影对照表）、§7.2 `omz_status`/`omz_export_mirror` 行。

### 裁决 7：镜像标识体系用数字 task id

- **设计期表述**：§7.3 的 `depends_on` 用 task key（`["T-001"]`）。
- **事实**：唯一约束是 `UNIQUE(graph_id, key)`——key 只在图内唯一。同一 team 跨图复用同名 key 时，镜像会把不同图的任务串成一条依赖链。
- **裁决**：`id`（数字，全局唯一）表达机器关系，`key` 保留作图内业务标识，`graph_id` 显式带上，`depends_on` 是数字数组，另加 `depends_on_keys` 供人读。
- **影响面**：§7.3 JSON 范例、`mcp/coordinator/core.mjs` 的 `exportMirror`。

### 裁决 8：`attempts` 在 claim 时 +1

- **设计期表述**：§7.2 的 claim SQL 里有 `attempts = attempts + 1`，但**没定义计数点语义**。
- **裁决**：计数点就是 claim，因此 **`max_attempts = N` 表示总共执行 N 次**（不是"重试 N 次"=N+1 次）。两种读法差一次真实执行，必须写明。
- **影响面**：§7.2 工具表与 SQL 注释、§7.3 的 `attempts` 字段说明。

### 裁决 9：新增 3 个 coordinator 工具（合计 13）

- **设计期表述**：§7.2 工具表 11 个。
- **裁决**：追加 `omz_reclaim_expired` 与 `omz_export_mirror`（连同它们所依赖的终态守卫/一次性消费改造，见 I7），合计 13 个。
  - `omz_reclaim_expired` 是**必需**而非增强：§7.2 原表没有 lease 回收入口，但 I3/I4 都要求"lease 过期只允许重派"——**没有入口时过期任务永久卡在 `running`**，整个 DAG 死锁。
  - `omz_export_mirror` 是裁决 6/7 的落地入口（把 7 态事实源投影为 4 态 + 原始态镜像）。
- **影响面**：§7.2 工具表、§13.5 I3、`mcp/coordinator/server.mjs`。

### 裁决 10：§7.2 的 claim SQL 范例缺 `retry_at` 过滤，且时间戳必须参数化且不可外露

- **设计期表述**：范例的 `WHERE` 只有 `status='ready' AND deps_remaining=0`，`lease_until` 用 DB 侧 `unixepoch()`。
- **事实与后果**：① 缺 `(retry_at IS NULL OR retry_at <= :now)` 会让处于退避窗口的失败任务被立刻重发，**backoff 形同虚设**；② DB 侧取时间无法注入固定时钟，与可测试性冲突。
- **裁决**：补 `retry_at` 过滤 + 时间戳参数化。**并且**：`now` **绝不能出现在对外 MCP 工具的 inputSchema**——实现期发现这是一个可被任意 worker 利用的攻击面：`omz_reclaim_expired({now: 未来时间戳})` 能把别人**未过期**的 lease 判为过期并抢走，等于把调度器的时钟交给调用方。时间只由 server 进程自己取，`now` 仅作内部函数参数。
- **影响面**：§7.2 SQL 范例与其后的条款、§13.5 I3。

### 裁决 11：`.omz/` 运行时目录树补全

- **设计期表述**：§3.5 缺三个实际使用的路径。
- **裁决**：补 `drafts/<slug>.md`（ulw-plan 双工件的草稿/批准门记录）、`research/<slug>/`（ulw-research 产物）、`ulw-execute/ledger.jsonl`（执行账本）；顺带登记 `config.json` 与 hook 的 `.mode-injected-<sessionId>` marker。
- **影响面**：§3.5 目录树。

### 裁决 12：配置优先级 `.omz/config.json` > `.zcode/config.json` > 内置默认

- **设计期表述**：§3.3 只说"MCP 连接配置放在 workspace `.zcode/config.json` 或插件 manifest"，**没规定两个 config 的优先级**。
- **裁决**：`内置默认 → .zcode/config.json 的 omz 键 → .omz/config.json`（整文件即 omz 配置）逐层覆盖，**后者最高**。
- **必须写明的副作用**：`.omz/` 被 gitignore（§13 B14），所以 `.omz/config.json` 是**本机私有覆盖**；**profile 开关若想团队共享，必须写在 `.zcode/config.json`**。doctor 逐层报告命中/跳过，避免"改了配置没生效"。
- **影响面**：§3.3 新增配置优先级段、§3.5（config.json 行）、§15.5 默认配置说明。

---

## 18. 装机后冒烟验收链路（v1.5 新增，可复现记录）

这是 OMZ **第一次在真实环境跑完整生命周期**的验收记录。写法是**可复现的链路**而非叙事：每一节给"做了什么 / 判据是什么 / 实测结果"，让后人能照着再跑一遍并对比。

**前置条件**：插件已装进 ZCode（`plugins.dirs` 指向本目录、`omz@inline` 已启用）、**已重启会话**（B19：agent 清单是会话启动快照，不重启则 9 个 agent 全部 not found）。三项验收依次跑 `/omz-doctor`、`/omz-status`、`/ulw`。

**卫生前提（先立规矩再动手）**：**冒烟必须在系统临时目录里造靶子项目，不能在插件仓库里跑**。实测终态确认：`<插件仓库根>/.omz/` **不存在**，插件仓库零污染。这一条不是洁癖——`/ulw` 会在**工作目录**创建 `.omz/`（goal/plans/evidence/boulder.json），在插件仓库里跑会把运行时状态混进待分发的插件包。

### 18.1 靶子项目（可复现的最小真实工程）

不要用 hello-world：评审门和双证据需要真实的失败面。本次构造：

- 真实 **Node ESM** 项目（`package.json` 带 `"type": "module"`、`npm test` 走 `node --test`）
- `src/config.mjs`：`loadConfig` 读环境变量并做严格校验
- `src/server.mjs`：`describeTarget` 之类的消费方，**无条件调用 `loadConfig`**（这个细节后面成了归因错误的根源）
- 一条**基线测试**（跑通的绿色起点，用于事后做反向变异对照）

**目标**：给 `loadConfig` 加 `APP_TIMEOUT_MS`（含默认值、类型校验、非法值抛错）。这是一个"跨 2 文件的小特性"，正好对齐 §9 M1 的验证标准。

### 18.2 规划阶段：planner → critic → 主 agent 裁决 → rev2

`omz-planner` 产出 draft 后交 `omz-critic`。**critic 报 4 个 blocker**（这四条都是"计划照抄就会静默落空"的类型，值得逐条留档）：

1. **`.omz/evidence/` 目录不存在，而 `tee` 不建父目录** → 转录**静默落空**（命令 exit 0、文件没写成，双证据变成空口无凭）。
2. **波内两个任务并行写同一个测试文件** → 互相覆盖（波次划分与文件写入面没对齐）。
3. **F1 的 `# pass ≥ 6` 判据与自身任务粒度不自洽** → 判据引用了本波不会产生的测试数量。
4. **`# fail 0` 是 TAP 格式的输出，而 Node 22 在 TTY 下默认 spec reporter** → **判据整体落空**（grep 不到那行字，不是"没失败"而是"根本没这行"）。

主 agent 就其中**两个 owner-decision** 做裁决后**打回重规划** → **rev2**：波次 **5 → 9**、终验条目 **5 → 7 条**。

**可复现要点**：判据里凡涉及测试输出格式的，必须先固定 reporter（`--test-reporter=tap`）或改用与 reporter 无关的判据；凡涉及写文件的，必须先 `mkdir -p` 父目录。这两类是"计划层判据"最常见的静默失效源。

### 18.3 执行阶段：两轮 junior，failing-first 真的红了

两轮 `omz-junior` 执行。**failing-first 不是形式**——实测拿到真实的红色输出：

- **config 侧**：`# fail 4`（含 `undefined !== 250`、`Missing expected exception`）
- **server 侧**：`# fail 2`（含 `actual: '127.0.0.1:8080'`）

**判据设计**：先跑出预期数量的 fail 并把转录落盘，再实现到全绿。红色输出的**具体断言文本**（不只是 fail 数）是这一步的证据核心——只有数字的话，任何一次无关失败都能冒充 failing-first。

### 18.4 评审门：reviewer 第一轮 `needs-fix` → 复审 `confirmed`

`omz-reviewer` **第一轮判 `needs-fix`**，三条：

1. **F7 的 `sc-map.md` 不存在**（终验条目引用了一个没产出的工件）
2. **计划记录仍写 `status: draft` 与"当前位置 Wave 0"**（状态文件没随执行推进，与 §7.3"以文件为准"的收点原则冲突）
3. **`describeTarget` 的 totality 破坏无覆盖无记录**（行为变化没有测试也没写进记录）

修完复审判 **`confirmed`**。

**这一轮产出了三条方法论级的发现，价值高于本次特性本身**：

- **内存重放取证法（比"改文件再改回"更干净）**：reviewer 独立复核 failing-first 时，用 `git show HEAD:src/*.mjs` 取出基线源码，**经 base64 data URL 动态 import 加载**，**工作树零改动**完成对照。相比"改文件跑一遍再改回来"，它不产生中间态、不依赖"记得改回去"、也不会被 `git status` 污染判据。**推荐写进评审侧的标准手法**。
- **reviewer 纠正了主 agent 的一个归因错误**：`describeTarget` 的 totality 破坏，主 agent 归因为 D1=a（输出形状变化）；reviewer 用**反向变异**证明根因是**config 层严格校验向上传导 + `describeTarget` 无条件调用 `loadConfig`**（基线就已如此）——方法是拿**基线 `server.mjs` + 当前 `config.mjs`** 组合跑，S3 **仍绿**，从而排除输出形状这一路。这是独立评审的正向价值样本（B11 的反面证据：评审门确实抓到了主 agent 的错）。
- **抓到一条"形式上与伪造转录不可区分"的证据缺陷**：一条命令写成 `{APP_TIMEOUT_MS:''abc''}`（**双写单引号**），逐字复制会 `SyntaxError`，但转录里下一行配了**成功输出**。这个组合在形式上等同于伪造证据——命令跑不通却有输出。**实测确认修正引号后输出逐字一致**，即**内容真、命令串坏**；按纪律**整块重跑**留新转录。**判据升级**：双证据的"可复现"要求含**命令串本身逐字可执行**，不只是输出看起来对。

### 18.5 终态判据（照这七项核对即可复现验收）

| 判据 | 实测结果 |
|---|---|
| `npm test` | **8/8/0**（8 通过 / 8 总数 / 0 失败） |
| 四条 SC（success criteria） | **全 done** |
| `.omz/boulder.json` | `status: done` |
| `.omz/` 卫生扫描 | **零 BOM、零反斜杠路径、零损坏 JSON**（B4/B3/B26） |
| `git status` | **恰 4 条改动**（与计划的写入面一致，无意外文件） |
| `package.json` | **零 diff**（没有偷偷加依赖或改脚本） |
| 插件仓库污染 | `<插件仓库根>/.omz/` **不存在** |

### 18.6 这次冒烟证实与暴露了什么

- **证实**：评审门不是形同虚设（critic 4 blocker + reviewer 一轮 `needs-fix`，都不是走过场）；双证据要求能逼出真实的 failing-first 输出；`## Wave <n>` 契约与"以文件为准"的收点原则在真实执行里可用；`/ulw` 第零步的确定性回退实测有效（§13 B30）。
- **暴露**：① 计划层判据极易被输出格式（reporter）与目录前提（`tee` 不建父目录）静默击穿——这类缺陷 critic 抓得到，但**规格层应当直接写死**；② 主 agent 的归因**会错**，独立评审 + 反向变异是必要的；③ 证据的"可复现"必须覆盖**命令串本身**；④ 只跑了一条路径——B18 续跑、`/team`、LIGHT/HEAVY、EXPAND、5-lane 均未走到（§14 已记为诚实边界）。

---

## 附：版本历史

- **v0.1**（2026-08-31）：初版设计。OmO 调研映射 ZCode 机制。
- **v0.2**（2026-08-31）：引擎取证修订——交互差异表、resume 事实修正（可唤醒）、V2 证据升级、§12 负面影响、omz- 前缀、V5/V6。
- **v0.3**（2026-09-01）：环境深查——① frontmatter 完整字段集证实（tools 数组形式、thoughtLevel/maxTurns/permissionMode/color，修正 v0.2"思考档不能指定"的错误结论）；② hooks additionalContext schema 证实（V3 证据升级）；③ slash command `$1/$N` + 内联执行块发现，/omz-status 改直渲染、新增 /omz-doctor；④ 新增 §13 移植 bug 预测；⑤ 验证清单扩至 8 项（V7 TodoWrite 隔离、V8 permissionMode）；⑥ 去个人化（通用项目定位）。
- **v0.4**（2026-09-01）：定位修正与审计——① 初衷澄清为"移植 OmO 编排能力、做出更好的项目"，吞吐/分工/验证/规划四能力并重（修正 v0.3 单一"代码质量"定位）；② 审计发现 goal 按 sessionId 命名的跨会话失联缺陷，新增 B18 预案 + §6 第 2 步的续接指针，boulder.json 提前至 M1；③ M1 验证标准自相矛盾修复（typo 级任务按省流阀不应走编排，改为跨 2 文件小特性）；④ /omz-status 加 40 行渲染上限。
- **v0.5**（2026-09-01）：M0 六项活体实测——① V1/V2/V5/V6/V7 从"待验证"变为**实测结论**（用户级/项目级 agents 目录路径代码级证实、frontmatter 全字段解析链证实含 mcpServers、嵌套结构性不可能、skills 全量可见、TodoWrite 共享）；② 实测发现三个新 bug：B19 agent 清单会话快照（高）、B20 子代理无 Grep/Glob（中）、B21 规则冲突（中），各配解决方案；③ 角色表 tools 列按 B20 修正；④ V3/V4 保留待装机实测（均有零风险回退）。设计置信度大幅提升：核心机制层无剩余未验证假设。
- **v0.6**（2026-09-01）：skill 层逐项对比（基于 OmO 四个 SKILL.md 原文抓取）——新增 §7.5：ulw-plan/ulw-execute/ulw-research/review-work 四表逐机制对比，确认 Sisyphus 完成契约、9 对抗类、LIGHT/HEAVY、checkbox 语法、EXPAND 协议、claim 过门、5-lane 评审等核心协议**全量可移植**（纯提示词层）；识别降级项（codegraph/teammode/dag）与增强项（子代理真实工具、结构防嵌套）。
- **v0.7**（2026-09-01）：结构审计——① 全文交叉引用核查（B1–B21 定义/引用一致、§ 引用均有实体）；② 贴合度自评更新至 v0.5 实测后状态；③ V8（permissionMode 枚举）回归 §10.2 保留项（B2 引用同步）；④ §11 差距清单同步 v0.5/v0.6 新事实（结构防嵌套、skills 可见、skill 层全量可移植）；⑤ 修复 §8 章头丢失（v0.6 插入事故）；⑥ M0 里程碑与尾注的"八项"表述改为实际状态。
- **v0.8**（2026-09-01）：可实现性补全——新增附录 A（10 个 agent frontmatter 完整规格+prompt 骨架）、附录 B（5 个 commands 规格）、附录 C（4 个 skills 目录规格）、附录 D（M1 装机检查单 6 步）；修复版本历史章节头丢失。
- **v1.0**（2026-09-01）：定稿——完成 v1.0 置信度评估、章节/编号/附录一致性核对。
- **v1.1**（2026-09-01）：外部证据纠偏——确认 OmO `codegraph_explore` 上游为独立 MIT `colbymchenry/codegraph`（Windows + stdio MCP），不再把 codegraph 列为永久降级；核查 ZCode 官方 MCP/子代理/Goals/闲时任务边界，区分公开契约与工具层能力。
- **v1.2**（2026-09-01）：本土化架构修订——① 四层架构（展示/调度/语义/执行）与可选 profile；② coordinator MCP 的 team/DAG/mailbox/lease 工具规格；③ SQLite WAL/BEGIN IMMEDIATE/幂等/at-least-once 事务边界；④ CodeGraph/vardiya/MCP Agent Mail 选型；⑤ Electron dashboard/SSE 安全边界；⑥ I1–I6 集成风险；⑦ resume 降为可选适配器，不再当官方稳定契约；⑧ 阶段路线改为 M1 core、M1-G graph、M2 orchestration、M3 dashboard；⑨ 置信度明确为设计交付而非生产运行保证。
- **v1.3**（2026-09-01）：维护与交互修订——① 新增 §15：默认聊天模式影响与隔离策略（core 默认、auto_team/auto_ulw/keyword_hook 关闭，普通聊天不启动编排、不写状态）；② 新增 §16：新建 OMZ 仓库、选择性同步 OmO 协议、ZCode 适配层独立、CodeGraph 独立接入、Git remote/分支/来源锁定纪律；③ profile 数量修正为四个；④ 附录 A–D、阶段路线和交叉引用同步；⑤ 终审确认安装 OMZ 不改变默认聊天行为。
- **v1.4**（2026-09-01）：**实现验收修订**——v1.3 全部规格已实现（9 agents + 5 commands + 4 skills/11 references + hooks + coordinator MCP + dashboard + adapters + tools），548 tests / 99 suites 通过、doctor 无 FAIL、hook self-test 27/27。本版把设计期的"待验证"改为实测结论，并回写实现期发现的规格错误：
  1. **引擎第二轮符号级反查**（§10.3 新增六条代码级证据）：模板变量全集正则（**`${pluginDir}` 不存在**，未识别变量原样保留；`ZCODE_SKILL_DIR` 在 hook 上下文抛错）、`loadPluginAgentProfiles` 的命名空间前缀 + 唯一裸名别名 + 保留名 `{general-purpose, Explore}` + `agent_ambiguous_name`、`loadZCodeAgentProfiles` 与 `sanitizeProjectAgentProfile`（project 来源的 `permissionMode` 被**删除**）、`collectPluginHookEvents`（需外层 `hooks` 包裹；不支持事件名只 warning）、`isReadOnlyTool`/`isWriteTool`/`isDestructiveTool` 三集合（**Bash = write + destructive**）、manifest `agents` 键值映射 vs `agents/` 目录的区别。
  2. **新增 §17：实现期架构裁决 12 条**——子代理不能 spawn 故"派发"改"派单建议 + 回请主 agent"（omz-atlas 重写为波次状态机）、WebSearch 本部署不可用、只读性是"三道结构 + 一道纪律"（推翻 v1.3 的"物理上改不了代码"）、Stop hook 未实装、波次语法定为 `## Wave <n>`、coordinator 7 态事实源 + 4 态镜像投影 + 保留 `coordinator_state`、镜像改用数字 task id、`attempts` 在 claim 时 +1、coordinator 工具 11→13（`omz_reclaim_expired` 缺失会导致过期任务永久卡死）、claim SQL 补 `retry_at` 过滤 + 时间戳参数化且 `now` 不得外露（否则可抢他人 lease）、`.omz/` 目录树补全、配置优先级 `.omz/config.json` 最高（但被 gitignore，团队共享须写 `.zcode/config.json`）。
  3. **新增 B22–B29**（全部来自实际命中的缺陷，非推演）：B22 isMain 用 percent-encoded pathname 致含空格路径下 CLI 静默 exit 0（假成功且 doctor 自身失效）、B23 最小 YAML 解析器丢弃 dash 数组击穿只读白名单、B24"引擎有工具名 ≠ 部署可用"、B25 路径归一化全量深度遍历破坏非路径字符串、B26 跨卷/越界路径被静默改成不存在的相对路径、B27 状态看板字段行内注入可伪造任务行、B28 波次字典序排序、B29 ReDoS 使 hook 从 fail-open 变 fail-broken（18.4s > 3s timeout）。
  4. **新增 I7–I10**：I7 终态守卫与 `task_deps.consumed` 一次性消费（重复 complete 破坏依赖不变量且**事后无法从状态推断**，配 `verifyGraphInvariants()`）、I8 `taskFail` 的 owner 校验空洞（null owner 可绕过依赖把 blocked 改 ready）、I9 幂等键未与 task 绑定（跨 task 返回他人结果并标 duplicate）、I10 dashboard 静态资源鉴权分层（token 门前置导致默认路径就是坏的）。
  5. **§14 置信度重新标定**：分母从"设计能否实施"换为"代码能否在真实环境按预期跑"——整体 98%（设计交付）→ **95%（代码交付）**；宿主机制层维持 99% 但"只读结构性保证"子项下调至 70%（裁决 3）、编排实现层 92%→94% 但并发子项 75%（V9 空白）、集成选型层 94%→90%（CodeGraph 仍未装机）、新增展示层 85%；"为什么不是 100%"整段重写为七项真实环境缺口（**末轮又收到六项**，见下第 9 子项）。
  6. **§10.2 新增 V9–V12**（多进程并发 claim 压测、CodeGraph 装机验收、Electron 真机与 CSP、真实会话内 9 agent spawn ping），并说明 V3/V4/V8 未实测的共同原因（须真实 ZCode 会话）。
  7. **全文一致性**：'10 个子代理'→'9 个 agent 文件 + 复用内置 Explore（共 10 个角色）'（§2/§3.1/§3.4/§4/§11/§12.1/§12.2/§13 B10/§15/§16.2/附录 A/D）、§5.1 补评审等直接指定通道、§6 计划路径统一 `<slug>.md`、§3.4 插件布局更新为实际结构、§9 里程碑标注实际完成状态、B21"锁事"→"琐事"、附录 B/C/D 与实现对齐。
  8. **收尾三处对齐**（v1.4 定稿前最后一轮核对）：① `omz-looker` 的 tools 由 `[Read]` 改为 `[Read, Bash]`、maxTurns 10→15——纯 `[Read]` 拿不到待检图片路径（Read 需精确路径），该角色实际不可用；代价是它不再"完全结构性只读"，5 个质量角色至此全部落入双层模型（§4、裁决 3）。② 附录 A 的"全工具"写法由 `tools: []` 注释改为**明确要求省略该行**——`tools: []` 是空白名单（拿不到任何工具），与"省略=继承全工具"语义相反，照注释抄会静默瘫痪 agent（与 B23 同源的语义陷阱）。③ `coordinator.sqlite` 定为**单库多 team**（§3.5、§12.5）：v1.3 的目录树把它画在 `runtime/<teamId>/` 下暗示分库，实现选择单库（`teams` 表本身是多 team 注册表，分库会切断跨 team 审计），隔离改由 per-team 文件区 + 库内 `team_id` 外键承担。
  9. **末轮精准修正九条**（独立验收审计 + 引擎复核确证；本轮只改本文档，代码侧已由 `commands/ulw.md`、`commands/team.md`、`agents/omz-looker.md` 先行实施）：① **§8.2 撤回"matcher 省开销"**——`hookRunner.run(t, r={})` 的匹配值取自第二参数，`runUserPromptSubmitHooks`（`RUr`）只传 `{signal}`，`n6r` 在匹配值空集合时无条件返回 true，故 matcher 在该事件上**不参与筛选**；保留它是无害的意图声明，但每条消息固定启一次 node 进程（实测 **126–132ms**，裸 `node -e 0` 基线 85–91ms），该成本已同步进 §12.1「触发税」。② **"两道开关"升级为三层确证**：顶层 `enabled` **纯装饰**（`parsePluginHookEvents` 只取 `rawHooks.hooks`，且有插件 hook 时引擎强制置 `enabled:true`）／hooks 数组**元素级** `enabled:false` 是**运行层真闸**（`o.enabled === false ? [] : ...`，唯一能让进程不启动的位置）／`omz.keyword_hook` 是**语义层真闸**，并写明彻底关掉的做法。③ **§1.5.2 拆开两种 hooks schema**：配置文件侧 `hooks.events.<Event>`，插件侧 `hooks.<Event>`（**无 `events` 中间层**），混写会静默失效；§10.3 第 4 条同步补三条细则。④ **附录 A 与 `agents/*.md` 逐字段对齐**：同步 `omz-looker`（`tools: [Read]`→`[Read, Bash]`、`maxTurns: 10`→`15`，正文补"Bash 仅用于枚举图片路径、禁止写操作"与"PDF 须派发方先转逐页图片"）+ planner/deep/junior/reviewer 四条 description 的**负向触发句**（实际文件是更好的版本），并加一段说明"附录漂移即陷阱"。⑤ **V8 与 V9 状态更新**：V8 枚举已由引擎取出（`XQo`：`acceptEdits`/`auto`/`bypassPermissions`/`default`/`dontAsk`/`plan`；`Fsi` 子代理映射）→ 移入 §10.1，**关键推论**是枚举里没有任何值能移除单个工具，故"用 `permissionMode` 收紧 Bash"**走不通**，双层模型是**终态**（§17 裁决 3、§4、§13 B11/B20 同步改为终态表述），剩余弹窗子项记为 V8′；V9 并发压测**已完成**（8 进程/200 任务/730ms/unique=200/重复 claim=0/`SQLITE_BUSY` 重试 0/不变量 0 violations；`max_parallel=8` 经 52 次 `max-parallel` 验证限流），§14 并发子项 75%→90%、编排实现层 94%→96%，并保留"退避路径未被触发覆盖"的诚实边界。⑥ **§7.2 补 MCP 工具真名规则**：真名为 `mcp__plugin_<pluginName>_<serverKey>__<toolName>`（本插件即 `mcp__plugin_omz_omz-coordinator__omz_team_create`），表里裸名只是逻辑名，调用方须**按后缀匹配现取真名、不得硬编码**；失效表现是"orchestration 开了却总在降级档"。⑦ **新增 B30【高】主 agent 拿不到 sessionId**：`${ZCODE_SESSION_ID}` 只在 hook/MCP/命令执行块上下文展开，Bash 工具 env 与 `<env>` 块都没有，模型会自行编造并形成"退出码 0 的假成功"（B22 家族）；修复为 `/ulw` 第零步内联执行块取值 + `<ISO 时间戳>-<git HEAD 短哈希>` 确定性回退 + 禁止编造 + `boulder.json.active_goal` 为唯一权威指针，§6 第 2 步与 §3.5 已同步两种命名形态。⑧ **"八步"表述定调**：八步是**语义阶段**，第零步是**实现层机制步骤**，不进阶段计数（理由：八步是 §7.5 协议对比锚点；第零步依赖宿主，将来引擎给出 sessionId 它就该消失），涉及实现处写"八步 + 第零步会话标识前置"。⑨ B 编号扩至 **B1–B30**，§13 章头、§14 风险预案层、核对表相应更新。
- **v1.5**（2026-09-01）：**装机验收修订**——插件已装进 ZCode（`plugins.dirs` 指向本目录、`omz@inline` 启用），**重启会话后跑完 `/omz-doctor`、`/omz-status`、`/ulw` 三项真实会话验收**。本版把"待装机实测"改为行为级实测结论，并回写会话内新发现的引擎/运行时事实：
  1. **V12 结清并从 §10.2 移入 §10.1**：`/omz-doctor` 在会话内逐个 spawn 9 个 agent，**9/9 全部返回 `OMZ-PONG`**，无一 not found；**bareName 与 `omz:` 命名空间双入口均生效**（实测用裸名 spawn 成功，证实 §10.3 第 2 条的唯一裸名别名规则）。这一项同时**结清 B16**、给出 **B1 的行为级确证**，并复验 **V5**（9 个全部无 `Agent`）、**B20**（全部无 `Grep`/`Glob`）、**§17 裁决 2**（连全工具角色都没有 `WebSearch`——引擎有该工具名且归入 `isReadOnlyTool`，但当前部署的实际工具面里确实没有它）。只读白名单**行为级生效**：critic/oracle/reviewer/librarian/looker 五个受限角色实测**均无 Edit**，deep/junior/atlas 三个全工具角色**有 Edit**，逐项与 frontmatter 吻合（§10.1 V12、§4 注、§13 B1）。
  2. **B16 结清**：四个 OMZ skill（`ulw-plan`/`ulw-execute`/`ulw-research`/`review-work`）在**全部 9 个子代理侧均可见**且带 `omz:` 前缀 → **回退方案作废**，委派 prompt 不需内联 skill 摘要（原方案约 10 行/次的持续 token 税省掉）。
  3. **新事实：子代理有引擎注入的 `RespondToCoordinator`**（§10.3 第 11 条）——9 个工具面全部含它，**包括 `tools: [Read, Bash]` 这种最窄形态**，且它**不在任何 frontmatter 里声明、不受白名单约束**。结论性表述：**只读角色的真实工具面 = frontmatter 白名单 ∪ 引擎注入工具**，白名单是"能声明什么"的上界而非工具面全集。据此 **§4 的只读性模型从双层扩为三层**（结构约束 / 纪律约束 / **引擎注入面不可控**）。`tools/validate-frontmatter.mjs` 的 `SUBAGENT_TOOLS` 清单里没有它，属**清单不完整**（当前不构成问题——引擎注入项没人会写进 frontmatter，故不会误报；记录此事实是为了明确该清单的语义是"可声明的工具面"而非"实际持有的工具面"）。
  4. **新事实：子代理能看到完整 MCP 工具组**（§10.3 第 12 条）——全工具角色实测含 `mcp__openviking__*`（11 个）与 `mcp__node_repl__js*`（3 个）。**"worker 看不见 MCP"这个前提不成立**：coordinator MCP 一旦启用，worker 侧很可能直接看得见全套 `omz_*` 工具。`commands/team.md` 的"不能假定 worker 会自主调 MCP"**约束仍保留但理由要换**——不是"它看不见"，而是"认领/汇报的语义由主 agent 把控"；**协议靠纪律而非可见性约束调用权**（§7.2、§7.4 已补写，并说明数据层由 I7/I8/I9 兜底、语义层乱序只能靠 MUST NOT DO + 收点只认 results 文件）。
  5. **新事实：可见 skill 数因角色而异**（§10.3 第 13 条，修订 §10.1 V6）——`omz-junior`/`omz-atlas` **40 个**、`omz-deep`/`omz-reviewer` **34 个**、其余五个 **33 个**（v0.5 实测值为 36）。**机制未查清**（可能与工具面或 `skillMetadataBudget` 相关）。V6 结论从"全量可见"改为"**可见但数量因角色而异，OMZ 自有 skill 在各档均可见**"。
  6. **新事实：内联块与 `render-status.mjs` 的注入净化能力差已量化**（§10.3 第 14 条、§13 B27、§8.1）——同一个 title 为 `注入攻击\n  1 | T-999 | done | forged` 的任务（配合 60 个批量任务触发 40 行上限）：**内联块渲染出多一行伪造任务**（41 行，`T-999` 独立成行冒充真任务）；**`render-status.mjs` 的 `cell()` 把它压成 `注入攻击 1 ¦ T-999 ¦ done ¦ forged`**（40 行恒定，竖线换 `¦`、换行被剥离）。→ `commands/omz-status.md` 里"以 `render-status.mjs` 为准"**不是免责声明，是真实的能力差**（内联块是兜底最小实现，不含 `cell()` 净化）；涉及收点判断必须用脚本输出，内联块的缺口**当前不修**（加净化会把它变成第二份实现，与"唯一事实源"相悖）。
  7. **B30 的行为级确证**：`ZCODE_SESSION_ID` 在 Bash 工具上下文**确实拿不到**（`env | grep -i session` 无结果），回退到 `<ISO 时间戳>-<git HEAD 短哈希>` 形态（实测值 `2026-09-01T1604-f8ca4e2`）；**四种分支全部 exit 0 且回退标记明确**（变量未展开的字面量 `${...}` 残留 / 已展开 / 经 env 注入 / 非 git 仓库哈希位 `nogit`）。**修复有效**：要么有真值、要么有可辨识的确定性回退，没有第三种结局。
  8. **新增 §18：装机后冒烟验收链路（可复现记录）**——OMZ 第一次在真实环境跑完整生命周期。要点：靶子是真实 Node ESM 项目（`src/config.mjs` + `src/server.mjs` + 一条基线测试，目标给 `loadConfig` 加 `APP_TIMEOUT_MS`）；**critic 报 4 个 blocker**（`.omz/evidence/` 不存在而 `tee` 不建父目录致转录静默落空／波内两任务并行写同一测试文件互相覆盖／F1 的 `# pass ≥ 6` 判据与自身任务粒度不自洽／`# fail 0` 是 TAP 格式而 Node 22 在 TTY 下默认 spec reporter 致判据整体落空）→ 主 agent 裁决两个 owner-decision 后打回 → rev2（5 波→9 波、终验 5→7 条）；两轮 junior 执行，**failing-first 真的红了**（config 侧 `# fail 4` 含 `undefined !== 250`/`Missing expected exception`，server 侧 `# fail 2` 含 `actual: '127.0.0.1:8080'`）；**reviewer 第一轮判 `needs-fix`**（F7 的 `sc-map.md` 不存在／计划记录仍写 `status: draft` 与"当前位置 Wave 0"／`describeTarget` 的 totality 破坏无覆盖无记录）→ 修完复审判 `confirmed`。三条方法论级发现：① **内存重放取证法**（`git show HEAD:src/*.mjs` 经 base64 data URL 加载，工作树零改动复核 failing-first，比"改文件再改回"更干净）；② **reviewer 纠正了主 agent 的归因错误**（totality 破坏的根因不是 D1=a 输出形状，而是 config 层严格校验向上传导 + `describeTarget` 无条件调用 `loadConfig`，基线即如此——用反向变异证明：基线 server.mjs + 当前 config.mjs 下 S3 仍绿）；③ **抓到一条形式上与伪造转录不可区分的证据缺陷**（命令写成 `{APP_TIMEOUT_MS:''abc''}` 双写单引号，逐字复制会 `SyntaxError`，但下一行配了成功输出；实测确认修正引号后输出逐字一致——内容真、命令串坏，已整块重跑）→ **判据升级：双证据的"可复现"含命令串本身逐字可执行**。终态：`npm test` **8/8/0**、四条 SC 全 done、boulder `status: done`、`.omz/` 卫生扫描零 BOM 零反斜杠零损坏、`git status` 恰 4 条改动、`package.json` 零 diff；**插件仓库未被污染**（全程在系统临时目录，`<插件仓库根>/.omz/` 不存在）。
  9. **§9 里程碑与 §14 置信度同步**：**M1 由"core 完成、剩余会话内验证"改为 ✅ 完成**（9/9 spawn ping + `/ulw` 全流程含评审门与双证据、AdversarialVerify 判 `confirmed`；残余记明 B18 续跑未单独演练）；M0 补第四轮实测、M2 触发增强注明"冒烟走斜杠路径故 V3 未随之结清"。§14：宿主机制层"只读结构性保证"子项 **70% → 80%**（行为级确证消除了"白名单是否真生效"这一半不确定，剩下的是 Bash 纪律层 + 新发现的引擎注入面，**仍是终态**）、协议移植层 **97% → 98%**（协议第一次被真实角色端到端执行且按设计意图拦住缺陷）、风险预案层 **93% → 95%**（B1/B16/B20/B27/B30 五条取得行为级证据）、整体可交付性 **95% → 97%（代码交付 + core 装机验收）**，并写明只加 2 点的三条理由（缺口减 1 且减掉的是唯一卡 core 的 V12／只跑了一个小特性一条路径／剩余 3 点里 V10/V11 各约 1 点、V3/V4/V8′ 合约 1 点）。"为什么不是 100%"整段重写为**五项**（V3/V4/V8′/V10/V11），并逐项说明本次验收为何没顺带结清（斜杠路径不触发 hook 注入／全程任务级新 spawn 未触达 resume／spawn 均为顺序发起未制造并行弹窗场景）。
  10. **§10 章头与 §10.2 引言/标题**同步为"五项"，§10.1 新增 V12 行与 `/ulw` 端到端冒烟行，V2 的"装机后行为级确认"从待办改为已完成，V5 工具清单补 `RespondToCoordinator`。

### v1.5 装机验收核对

| 核对项 | 状态 | 依据 |
|---|---|---|
| ZCode 官方/本机/外部项目事实分层 | ✅ 已实现并测试 | 官方文档 + 本机 zcode.cjs **三轮**符号级反查（§10.3；末轮新增 `hookRunner.run`/`n6r`/`RUr` 与 `XQo`/`Fsi`）+ 上游 README 分别标注；未公开 API 不当稳定契约。新增"引擎有能力 ≠ 部署可用"分层（B24，`validate-frontmatter.mjs` 强制）。**v1.5 补第四轮：装机后真实会话的行为级实测**（§10.3 第 11–14 条）——与前三轮的性质不同，它能证伪反查推不出的东西（引擎注入工具、skill 数分档、两条渲染路径的能力差） |
| 插件宿主契约（模板变量/命名空间/hooks 加载/MCP 工具名） | ✅ 已实现并测试 | §10.3 第 1/2/4 条；manifest 与 hooks.json 只用 `${ZCODE_PLUGIN_ROOT}`/`${ZCODE_PROJECT_DIR}`；`tests/protocol.test.mjs` 断言无非法变量。**末轮补三条**：插件 hooks schema 无 `events` 中间层、顶层 `enabled` 不被读取（真闸是元素级 + `keyword_hook`）、MCP 工具真名为 `mcp__plugin_<pluginName>_<serverKey>__<tool>`（§7.2 前言、§8.2）。**v1.5 装机确证**：命名空间规则的**双入口实测生效**（bareName 与 `omz:` 前缀都能 spawn，§10.1 V12）；`ZCODE_SESSION_ID` 在 Bash 上下文确实不可见（§13 B30 行为级确证） |
| 9 个 agent + 内置 Explore 角色体系 | ✅ **已实现并测试 + 装机后 9/9 spawn ping 通过** | 附录 A 全部落盘并**与 `agents/*.md` 逐字段对齐**（末轮同步 looker 的 tools/maxTurns/正文 + 四条 description 的负向触发句，脚本比对 9 块 0 差异）；`validate-frontmatter.mjs` 校验字段与工具名。**v1.5：doctor 从"9/9 OK（离线静态）"升级为会话内 9/9 真 spawn 返回 `OMZ-PONG`**，且实测工具面逐项与 frontmatter 吻合（§10.1 V12） |
| 只读角色的独立性 | ⚠️ **部分成立（三层模型，已定为终态；v1.5 结构层取得行为级确证）** | ① **结构约束**：Edit/Write 排除——**v1.5 实测确证**五个受限角色确实拿不到 Edit、三个全工具角色有 Edit（§10.1 V12），不再只是静态校验；② **纪律约束**：Bash 只读（§17 裁决 3、§10.3 第 5 条），`permissionMode` 枚举里没有任何值能移除单个工具（§10.1 V8），无收紧路径；③ **引擎注入面（v1.5 新增，不可控）**：工具面 = 白名单 ∪ 引擎注入工具，`RespondToCoordinator` 实证（§10.3 第 11 条、§4）。纪律侧仍靠 B11 抽查兜底 |
| CodeGraph 可接入性 | ⏳ 设计确认，**仍待装机** | 上游 MIT/Windows/`codegraph serve --mcp` 已核验；`probeCommand` 的 `.cmd` shim 已修；本机无 codegraph（V10） |
| Team/DAG 本土化方案 | ✅ **代码完成 + 并发压测已过** | 13 工具（§7.2，**真名带 `mcp__plugin_omz_omz-coordinator__` 前缀，调用方须按后缀现取**）+ 7 态机（§7.3）+ 终态守卫/一次性消费/不变量检测（I7）+ owner 校验（I8）+ 幂等绑定（I9）均已实现并测试；**8 进程/200 任务并发压测通过**（重复 claim=0、`SQLITE_BUSY` 重试 0、不变量 0 violations，§10.1 V9），I4 前置条款已履行；残余为覆盖面缺口（退避路径未被触发）。**v1.5 修正一条前提**：worker 侧**看得见** MCP 工具（§10.3 第 12 条），"不自主 claim/complete"是**纪律条款**而非"看不见"带来的结构保证（§7.2/§7.4） |
| dashboard 本土化方案 | ⚠️ **代码完成，待 Electron 真机** | 鉴权分层（I10）、loopback、SSE 上限、字段净化（B27）已测；只验证降级分支（V11） |
| 触发层 | ⚠️ **commands 已装机验收，hook 待 V3** | commands **已在真实会话跑通**（`/omz-doctor`、`/omz-status`、`/ulw` 三项，M1 99%）；hook 已实现含 ReDoS 修复（B29）、self-test 30/30，注入行为**仍待真实会话**——**v1.5 冒烟走的是斜杠命令路径，不触发 `UserPromptSubmit`，故 V3 未随之结清**。**末轮两条确证**：`matcher` 在 `UserPromptSubmit` 上不参与筛选（启用后每条消息固定 126–132ms），顶层 `enabled` 纯装饰、真闸是元素级 `enabled` 与 `omz.keyword_hook`（§8.2）；默认 `keyword_hook: false`。**v1.5 新增**：`/omz-status` 的内联块在注入净化上弱于 `render-status.mjs`（已量化：41 行 vs 40 行，§13 B27、§8.1） |
| 核心流程不受增强层影响 | ✅ 已实现并测试 | §3.3 profile 隔离 + `adapters/zcode/fallback.mjs` + `tests/fallback.test.mjs` + doctor 的 profile 降级报告 |
| 对标项目逐层对比 | ✅ 已实现并测试 | §1.5、§2、§7.5、§11；§7.5.1/§7.5.2 已按裁决 1/5 修正"被 spawn 者再派发"与波次契约 |
| 风险与供应链 | ✅ **已实现并测试 + 五条取得行为级证据** | B1–B30 + I1–I10；B22–B29/I7–I10 各有对应测试。**v1.5 装机实测**：**B16 结清**（skill 可见，回退方案作废）、**B1 白名单行为级生效**、**B20 无 Grep/Glob 复验**、**B27 能力差量化**（内联块 41 行 vs 脚本 40 行）、**B30 修复实测有效**（`ZCODE_SESSION_ID` 确实拿不到，四种分支全部 exit 0 且回退标记明确，实测回退值 `2026-09-01T1604-f8ca4e2`）；`upstream/omo-sources.lock.json` + `tests/protocol.test.mjs` 的锁定取证断言 |
| 仓库与上游维护策略 | ✅ 已实现 | §16 + `tools/sync-omo-skills.mjs`（`--plan` 只打印，`tests/cli.test.mjs` 断言不自动执行） |
| 默认聊天不受影响 | ✅ 设计约束 + 默认值已落地 | §15；coordinator MCP `enabled:false`；关键词 hook 的真闸是 `omz.keyword_hook: false`（顶层 `enabled` 不被读取，§8.2 三层开关）；`.omz/` 只在 workflow 激活后创建。**v1.5 装机后确认**：`/ulw` 冒烟在系统临时目录进行，**插件仓库 `.omz/` 不存在**（§18 卫生前提） |
| Stop hook 终止核对 | ❌ **未实装（M4）** | §17 裁决 4；改为主 agent 每波次收点后主动写 boulder.json（§6、§13 B17） |
| 跨平台路径正确性 | ✅ 已实现并测试 | B3 + B25（字段名白名单）+ B26（越界 marker/classifyPath）+ B22（含空格路径 CLI 入口）；`tests/path.test.mjs`、`tests/cli.test.mjs`。**v1.5**：冒烟终态的 `.omz/` 卫生扫描**零 BOM、零反斜杠、零损坏 JSON**（§18.5） |
| `/ulw` 端到端生命周期 | ✅ **已跑通（v1.5 装机验收，M1 验证标准）** | §18 可复现链路：planner → critic（4 blocker 打回）→ rev2（5 波→9 波）→ 两轮 junior（failing-first 真红：`# fail 4` / `# fail 2`）→ reviewer `needs-fix` → 复审 `confirmed`；终态 `npm test` 8/8/0、四条 SC 全 done、boulder `status: done`、`git status` 恰 4 条改动、`package.json` 零 diff。**未走到的分支**：B18 中断续跑、`/team` claim 过门、LIGHT/HEAVY、EXPAND、5-lane |
| 置信度表述诚实 | ✅ | §14 区分**代码交付 + core 装机验收 97%** 与**五项**真实环境缺口（v1.4 末轮结清 V8 枚举与 V9 压测，**v1.5 结清 V12**），逐项给回退路径并说明本次验收为何没顺带结清剩余项 |

*本文档为 v1.5 装机验收修订版。v1.3 的规格已全部实现并通过 578 个测试；**v1.5 完成装机后的真实会话验收**——`/omz-doctor` 会话内 9/9 spawn ping（V12 结清，连带结清 B16、给出 B1 行为级确证）、`/ulw` 端到端冒烟跑完整生命周期（§18），另得五条引擎/运行时新事实（§10.3 第 11–14 条、§10.1 V6 修订）。安装仍从 `core` 开始，graph/orchestration/dashboard 分别通过 §10.2 的对应验收后再启用（orchestration 的 V9 并发压测已过，见 §10.1）。仍未在真实环境验证的**五项**（V3/V4/V8′/V10/V11）各有明确回退路径，且**没有一项在 core 主路径上**——唯一卡 core 的 V12 已结清。OmO 后续更新只能经 §16 的选择性同步流程进入 OMZ；安装 OMZ 不改变 ZCode 默认聊天模式。*
