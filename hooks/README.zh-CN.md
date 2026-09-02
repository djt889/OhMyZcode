[English](./README.md) | **简体中文**

# OMZ M2 触发层：UserPromptSubmit 关键词 hook

`keyword-detect.mjs` 在用户提交 prompt 时扫描模式词（`ulw`/`ultrawork`/`team`/`hyperplan`，大小写不敏感），
命中则把 `commands/<mode>.md` 正文（已剥 frontmatter）经 `additionalContext` 注入本轮上下文——等价于手打
`/ulw`、`/team`、`/hyperplan`。设计与证据链见 `DESIGN.md` §8.2。

**默认关闭**（§15.5）：安装 OMZ 不得改变普通聊天行为；关键词注入属「有感知」行为，必须显式开启。

## 三个开关层次（哪个是真闸）

| 层次 | 位置 | 引擎是否读取 | 作用 |
|---|---|---|---|
| 顶层 `enabled` | `hooks/hooks.json` 根对象 | **不读**，纯装饰 | 只是声明性意图，改它不改变任何运行行为 |
| 元素级 `enabled` | `hooks.UserPromptSubmit[].hooks[].enabled` | **读**（`=== false` 即丢弃该条） | **运行层唯一真开关** |
| `omz.keyword_hook` | 项目 `.zcode/config.json` 的 `omz` 段 / `.omz/config.json` | 脚本自己读 | 语义层真闸：非 `true` 即返回 `{}`，不读命令文件、不写状态 |

引擎侧已确证：插件 hook 解析只取 `rawHooks.hooks`，**通篇不碰顶层 `enabled`**；且只要有插件贡献 hook，引擎
就**强制**把 hook runner 置为 `enabled: true`。因此：

- **启用**：项目 `.zcode/config.json` 写 `{ "omz": { "keyword_hook": true } }`（或 `.omz/config.json` 的
  `{ "keyword_hook": true }`），重启会话。**不需要动 `hooks.json`**。
- **运行层彻底关掉**：在 hooks 数组**元素**里加 `"enabled": false`，或删掉 `hooks/hooks.json`。只把顶层
  `enabled` 置回 `false` 不起作用。注意「从 `.zcode-plugin/plugin.json` 移除 `hooks` 声明」**不是**关闭手段：
  1.7.0 起清单本来就不声明 hooks——引擎会自动发现 `<root>/hooks/hooks.json` 这个确切路径
  （`listPluginHookSources`），同一 realpath 再声明一遍只会得到一条 `Duplicate plugin hooks file ignored`
  warning，而自动发现那条照样运行。

## 启用后的固定成本：每条消息一次 node 进程

引擎调用 UserPromptSubmit hook runner 时**不传 matchValue/matchValues**，而匹配函数在 matchValues 为空时
**无条件返回 true**。即 `hooks.json` 里那条大小写展开的 matcher 在本事件上**根本不参与筛选**——只要 hook
注册着，**每条**用户消息都会启动一次 node 进程。

本机实测（Windows / Node 22，5 次采样）：整条 hook **126–132ms**，裸 `node -e 0` 基线 85–91ms。命中与否、
`keyword_hook` 开没开都一样——`disabled` 短路省的是文件读取，省不掉进程创建。所以启用 `keyword_hook` 的
真实代价是**每条消息 +约 120ms 与一次进程创建**。

matcher 保留无害（对工具事件、`SessionStart` 仍有效，且是自文档化的意图声明），但**不要再宣称它省开销**：
§8.2 原文「不命中连 node 进程都不启」在 `UserPromptSubmit` 上不成立。

## 双重注入防护（§13 B5）

- prompt trim 后以 `/` 开头一律不注入（命令系统已展开过协议）。
- 会话级去重标记：同会话同模式只注入一次。
- §15.1 误触发红线：关键词落在行内反引号、三反引号块、引号字符串、Markdown 链接或含 `/`、`.` 的路径 token
  内均不命中；两侧还必须不是 ASCII 字母/数字/下划线/连字符（`teamwork`、`myteam`、`multiulw` 不命中）。

## 3 秒超时预算与三道自保

`timeoutMs: 3000` 是**引擎杀进程**：超时即零输出被终止，「任何情况都输出 `{}`」的 fail-open 契约立刻变成
fail-broken。故脚本自扛：

- **Markdown 链接屏蔽走线性扫描**。原正则在 `[[[[…](](](…` 上灾难性回溯（128KB 实测 18.4 秒），必被杀；
  现由 `maskMarkdownLinks()` 单向扫描，最坏 O(n)。
- **`MAX_SCAN = 32KB`**（头 24KB + 尾 8KB 两段独立分析）。实测最坏 32KB→8ms、256KB→177ms、1MB→2672ms，
  32KB 对 3 秒留约 350 倍余量。两段独立屏蔽，避免头窗未闭合的三反引号跨越拼接点吃掉尾窗。
- **`SCAN_BUDGET_MS = 1500`**：超预算即返回 `{ mode: null, reason: 'budget-exceeded' }`。宁可漏检（用户可显式
  打 `/ulw`），不能被杀掉。

## 注入长度上限

**引擎真墙：缺省 `maxOutputBytes = 32768`，超限的后果是整段注入被静默丢弃。**

取证（反查本机 `E:/APP/Zcode/resources/glm/zcode.cjs`，五处同值 32768）：

| 取证点 | 片段 |
|---|---|
| 运行时缺省配置 | `hooks:{enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}` |
| 另一处同值兜底 | `jdi={enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}` |
| 归并缺省常量 | `AEo=32768`（`L2e()` 在没有任何 scope 指定时取它） |
| 插件 hook 并入运行时配置 | `maxOutputBytes:e?.maxOutputBytes??32768` |
| 工作区 hook 的 runtimeRoot | `maxOutputBytes:Q.hooks?.maxOutputBytes??32768` |

**不是 65536**——那个数来自 `hooks.json` 顶层那个引擎从不读取的死字段（v1.4 已删）。**也不是「截断」**：

- 插件 / 工作区 hook 走 executionPort，`outputLimit:{maxBufferBytes:i.maxOutputBytes,maxInlineBytes:i.maxOutputBytes,persistOutput:"none"}`；
  `OutputCollector.append()` 在 `inlineBytes >= maxInlineBytes` 后**丢弃余下 chunk**（只置 `truncated` 标记，
  而 hook 路径从不读这个标记），随后 `parseHookStdout()` 对半截 JSON 执行 `try{JSON.parse(r)}catch{return}`
  —— **静默返回 undefined，整段注入被无声丢掉，一条错误都不产生**。
- 另一形态 `runGitCommand()` 是**直接杀进程**：`Buffer.byteLength(i,'utf8')>r.maxOutputBytes&&(o.kill(),l({exitCode:-1,stdout:i}))`。
  它服务 `resolveWorkspaceGitBranch`（自带 512 字节缺省），不在 hook 执行链上，但说明引擎对超限的通用态度是**杀/丢，不是安全截断**。

两条路径都是 fail-broken：注入体必须**在写 stdout 之前**就落进预算。

**我们的预算：`MAX_PAYLOAD_BYTES = 24576`（24KB）= 32768 − `PAYLOAD_SAFETY_MARGIN_BYTES` 8192。**
余量不是装饰：`maxOutputBytes` 可被用户配置（`~/.zcode/cli/config.json` 的 `hooks.maxOutputBytes`）或工作区配置**调得更小**，
而 hook 进程**拿不到那个值**（引擎不通过 stdin/env 下发），只能按缺省值保守估。8KB = 缺省值的 25%，能吸收「用户收紧到 24–32KB」这类常见配置。

**判定对象是 stdout 的完整 JSON 负载，不是 `additionalContext` 字符串。** 引擎量的就是 stdout 累计字节数，
也即 `JSON.stringify({additionalContext})`。实测差值：`additionalContext` 11105 字节 → JSON 负载 11372（+267，其中信封固定 24 字节，
其余是 `\n` 等转义）。中文越多、引号/反斜杠/控制字符越多，差得越大——只按字符串判定必然错。
唯一权威闸门是 `payloadBytes(text) <= MAX_PAYLOAD_BYTES`，`buildAdditionalContextDetailed` 的**每条返回路径**都在返回前实测过。

`MAX_CONTEXT_BYTES` 保留但改语义：现在是 `MAX_PAYLOAD_BYTES − 24`（信封开销）= **24552**，字符串侧的**软**上限，
**不参与任何判定**——降级逻辑一律直接实测 JSON 负载。保留它只有两个作用：既有导出面（读者与文档引用的那个「注入上限」符号）
不断裂，以及给一个「字符串大概能写多长」的量级参考。**派生而非手写**是因为 JSON 转义（单个 `"`、`\`、控制字符最多 1→6 字节）
让字符串长度与负载没有固定关系，任何手写的字符串上限都可能像旧的 48KB 那样悄悄错位到引擎真墙之上（49152 > 引擎 32768）；
派生之后它恒 `< MAX_PAYLOAD_BYTES < ENGINE_DEFAULT_MAX_OUTPUT_BYTES`，这条不变量由测试钉死。

**两级降级（都以负载预算为准，头窗大小靠二分实测求出，而非按字符串长度估）**：

| 级别 | 触发条件 | 内容 |
|---|---|---|
| `full` | 全文负载 ≤ 预算 | 来源注释行 + 命令体全文 |
| `headings` | 全文超预算，但「头部 + 章节清单 + 提示」放得下 | 头部原文（二分求最大可放字节）+ 全部 Markdown 章节标题清单 + 显式跑 `/<mode>` 的提示 |
| `minimal` | 连章节清单都撑爆预算（例如几千个 `## ` 标题行） | 头部原文 + 一行「内容过长，请显式执行 `/<mode>`」 |

`minimal` 末尾还有一层 `fitToPayload()` 二分硬裁兜底，因此**不存在「降级了但仍超限」的返回路径**——
`tests/hooks.test.mjs` 用 24/32/64/128/512/2048/8192/24576 八档病态预算全程扫描断言了这一点。
降级时 stderr 记一行：原始正文字节数、原始 JSON 负载、预算、降到哪一级、降级后负载、引擎缺省值。stdout 始终是严格 schema 的合法 JSON。

**当前实测（本轮实跑 `buildAdditionalContextDetailed`，非照抄旧值）**：

| 文件 | 文件字节 | 剥 frontmatter 后正文 | `additionalContext` | **JSON 负载** | 级别 | 对预算余量 | 对引擎缺省余量 |
|---|---|---|---|---|---|---|---|
| `ulw.md` | 11175 | 11018 | 11105 | **11372** | `full` | **2.16x** | 2.88x |
| `team.md` | 4442 | 4315 | 4405 | **4475** | `full` | 5.49x | 7.32x |
| `hyperplan.md` | 1067 | 934 | 1039 | **1083** | `full` | 22.69x | 30.26x |

`ulw.md` 是最紧的一个：1.3.0/1.4.0 拆八步、加第零步后从 7200 长到 11175（+55%），2.16x 的余量会被继续吃掉。
因此 `tests/hooks.test.mjs` 里有一条回归哨兵断言其负载 < 预算**且余量 > 1.5x**——`ulw.md` 再膨胀会先撞这条测试，而不是撞引擎。
（正文 11018 而非旧文记的 11019：`stripFrontmatter` 在剥分隔符后还会 `replace(/^\s+/,'')` 吃掉一个前导换行。）


## 路径与变量名纪律

- marker 路径：`projectRoot` 经 `resolveProjectRoot()` 净化（**非绝对路径不采信**，退回 `process.cwd()`），
  再由 `assertInsideOmz()` 断言目标必须在 `<projectRoot>/.omz` 之下——与 `adapters/zcode/transport.mjs` 同一
  纪律。此前只有 `sessionId` 侧做了安全化，`projectRoot='../../../evil'` 能把 marker 写到项目外。
- 模板变量统一 `${ZCODE_PLUGIN_ROOT}`（与 `plugin.json` 一致）；**`ZCODE_SKILL_DIR`/`CLAUDE_SKILL_DIR` 在
  hook 上下文会抛错**，禁用。脚本侧同时读 `ZCODE_PLUGIN_ROOT` 与 `CLAUDE_PLUGIN_ROOT`（前者优先）。
- 入口判定用 `tools/lib/is-main.mjs` 的 `isMainModule()`（内部 `fileURLToPath`）。用 `new URL(url).pathname`
  会因 percent-encoding 在 `C:\Program Files\`、`C:\Users\张三\` 下恒为 false，hook 静默输出 0 字节且退出码 0。

## 会话级标记与装机实测

标记位于 `<项目根>/.omz/.mode-injected-<sessionId>`（sessionId 已做文件名安全化，`.omz/` 已 gitignore）。
清理 `rm -f .omz/.mode-injected-*` 后同会话可再注入。

1. `node hooks/keyword-detect.mjs --self-test` → 30/30 通过，退出码 0（其中三例覆盖注入负载预算：真实 `ulw.md` 保持
   `full`、超预算命令文件降为 `headings`、几千个标题行降为 `minimal`，每例都断言降级后 JSON 负载仍在预算内）。
2. `echo '{"prompt":"ulw test","session_id":"sess_x","cwd":"<项目绝对路径>"}' | node hooks/keyword-detect.mjs`
   —— 未开 `keyword_hook` 时 stdout 恰好 `{}`（stderr 一行 `disabled`）；开了则是
   `{"additionalContext":"<!-- OMZ keyword hook: ... -->\n\n..."}`。两种情况退出码都是 0。
3. 开 `keyword_hook` 重启，新会话说不带斜杠的 `ulw 修一个小 bug`。判据：回答出现 ultrawork 阶段用语（目标
   注册、双证据、评审门）且 marker 文件出现；同会话再说一次时不新增模式。
4. 在 ZCode 日志中核对该 hook 的执行记录（触发/耗时/结果），区分超时与失败。

**回退 M1**：`keyword_hook` 置 `false`（要连进程开销一起省，就在 hooks 元素里 `enabled: false`）。触发层退回
纯 slash command，功能不受影响（§10.2 的 V3 回退即「永久 M1」）。脚本任何异常都输出 `{}` 且退出码 0（§13 B15）。
