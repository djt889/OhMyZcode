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
- **运行层彻底关掉**：在 hooks 数组**元素**里加 `"enabled": false`，或从 `.zcode-plugin/plugin.json` 移除
  `hooks` 声明。只把顶层 `enabled` 置回 `false` 不起作用。

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

`maxOutputBytes: 65536` 是引擎侧硬截断，注入体是 `commands/<mode>.md` 全文。实测（`wc -c commands/*.md`）
当前最大的 `ulw.md` **7200 字节**（剥 frontmatter 后正文 7044；实际 `additionalContext` 7130，整个 JSON 负载
7355），离 64KB 尚远。但文档一旦超 64KB，输出会被切成半截 JSON → fail-broken。故 `buildAdditionalContext`
自设 `MAX_CONTEXT_BYTES = 48KB`：超限降级为「头部原文 + 章节标题清单 + 提示显式执行 `/<mode>`」，stderr 记
一行，stdout 仍是合法 JSON。48KB 给 JSON 转义与 banner 留了余量。

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

1. `node hooks/keyword-detect.mjs --self-test` → 27/27 通过，退出码 0。
2. `echo '{"prompt":"ulw test","session_id":"sess_x","cwd":"<项目绝对路径>"}' | node hooks/keyword-detect.mjs`
   —— 未开 `keyword_hook` 时 stdout 恰好 `{}`（stderr 一行 `disabled`）；开了则是
   `{"additionalContext":"<!-- OMZ keyword hook: ... -->\n\n..."}`。两种情况退出码都是 0。
3. 开 `keyword_hook` 重启，新会话说不带斜杠的 `ulw 修一个小 bug`。判据：回答出现 ultrawork 阶段用语（目标
   注册、双证据、评审门）且 marker 文件出现；同会话再说一次时不新增模式。
4. 在 ZCode 日志中核对该 hook 的执行记录（触发/耗时/结果），区分超时与失败。

**回退 M1**：`keyword_hook` 置 `false`（要连进程开销一起省，就在 hooks 元素里 `enabled: false`）。触发层退回
纯 slash command，功能不受影响（§10.2 的 V3 回退即「永久 M1」）。脚本任何异常都输出 `{}` 且退出码 0（§13 B15）。
