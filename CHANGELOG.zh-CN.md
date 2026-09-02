[English](./CHANGELOG.md) | **简体中文**

# OMZ 实现变更日志

**两套版本号**：`package.json` / `.zcode-plugin/plugin.json` 里的版本号追踪**实现**进度；`DESIGN.md` 顶部的 v1.x 是**设计文档**版本。两者的 minor 位对齐到同一份规格——一个是"写下来"，一个是"跑起来"。当前：实现 **1.5.0** ↔ DESIGN **v1.5**。

**跳号是有意的**：0.7.0 / 0.8.0 预留给 `graph` profile（DESIGN §9 M1-G，需外部安装 `@colbymchenry/codegraph` 并在目标项目 `codegraph init`）与真实环境实测回写（§10.2 当前的五项：**V3** hook `additionalContext` 注入行为、**V4** resume 适配器、**V8′** 并行 spawn 的权限弹窗时序、**V10** CodeGraph 装机、**V11** Electron dashboard 真机渲染与 CSP 实际拦截），两类都依赖真机安装环境或真实 ZCode 会话，本轮未交付；1.0.0 未单独发布，orchestration 层落地后直接进入 1.x 线。清单本身随版本收缩：**V8** 的枚举部分与 **V9** 并发压测在 1.4.0 结清（V8 只剩弹窗子项，记为 V8′），**V12** 的 9 个 agent spawn ping 在 1.5.0 装机验收结清（六项 → 五项）。

每个条目记录三件事：**范围**（交付了什么）、**验证**（怎么证明它工作，用可复现的数字）、**已知缺口**（当时还没有的）。数字均取自 2026-09-01 在 Node v22.14.0 / Windows 上的实际运行输出。

---

## 1.5.0 — 装机验收：真实会话跑通 doctor 与 `/ulw` 全生命周期（2026-09-01）

1.4.0 之前的每条结论都建立在"代码 + 测试 + 引擎反查"的推断上，真实环境一次没跑。这一版把 OMZ 装进 ZCode、重启会话、在真实会话里跑完 `/omz-doctor`、`/omz-status` 与一条完整的 `/ulw` 生命周期，并把实测结果回写设计文档。没有新功能——交付物是**证据**，以及被证据结清或推翻的条目。

**范围**

- **V12 结清**：`/omz-doctor` 在真实会话内逐个 spawn 9 个 agent，**9/9 全部返回 `OMZ-PONG`**，无一 not found；裸名（`omz-planner` 等）与 `omz:` 命名空间前缀双入口均可 spawn。这一项是此前六项待实测里**唯一卡住 core 主路径**的，结清后 DESIGN §10.2 由六行减为五行（V12 移入 §10.1 已实测表）。
- **只读白名单取得行为级确证（B1）**：五个受限角色（critic/oracle/reviewer/librarian/looker）的实测工具面**均无 Edit**，三个全工具角色（deep/junior/atlas）**有 Edit**，逐项与 frontmatter 吻合（planner 恰为 `Bash, Read, Write`，librarian 恰为 `Bash, Read, WebFetch`）。此前只有静态校验 + 引擎解析链推断。同时复验：9 个角色**全部无 `Agent`**（V5）、**全部无 `Grep`/`Glob`**（B20）、**连全工具角色都没有 `WebSearch`**（§17 裁决 2）。
- **B16 结清**：OMZ 四个 skill 在子代理侧**全部可见且带 `omz:` 前缀**——委派 prompt 不必内联 skill 摘要，原回退方案作废。
- **四条引擎/运行时新事实**：① 子代理工具面**多出一个 frontmatter 未声明的 `RespondToCoordinator`**（引擎注入，不受白名单约束）——"工具面 = 白名单 ∪ 引擎注入面"，第三层不可控；② **可见 skill 数因角色而异**（junior/atlas **40**、deep/reviewer **34**、其余五个 **33**），分档机制未查清，当前不影响 OMZ 但也不是引擎承诺；③ **worker 侧看得见 MCP 工具组**，调用权只能靠协议纪律约束；④ **B27 的两路渲染净化能力差已量化**：同一个含换行 + 竖线的恶意 title 下，`/omz-status` 内联块渲染出**多一行伪造任务**（**41 行**，`T-999` 独立成行冒充真任务），而 `render-status.mjs` 的 `cell()` 把它压成单元格内一行（**40 行**恒定，竖线换 `¦`）——"以 `render-status.mjs` 为准"是实测的能力差，不是免责声明。
- **`/ulw` 端到端冒烟通过（M1 验证标准）**：在系统临时目录造真实 Node ESM 靶子项目跑完整生命周期——planner 出计划 → **critic 报 4 个 blocker 打回**（`.omz/evidence/` 不存在而 `tee` 不建父目录致转录静默落空／波内两任务并行写同一测试文件互相覆盖／判据与自身任务粒度不自洽／`# fail 0` 判据在 TTY 默认 spec reporter 下整体落空）→ rev2 → **两轮 junior 执行，failing-first 真的红了** → **reviewer 第一轮判 `needs-fix`** → 修完复审判 **`confirmed`**。全程在临时目录，插件仓库零污染。
- **DESIGN.md v1.4 → v1.5**，新增 **§18「装机后冒烟验收链路」**（可复现记录：靶子构造、两轮评审的逐条发现、内存重放取证法、双证据判据升级为"命令串本身逐字可执行"），并把上述结论回写 §8/§9/§10/§13/§14/§17。
- **移除 dashboard preload（发布前收尾）**：删除 `dashboard/preload.mjs`，连同 `main.mjs` 的 `windowOptions()` 里的 `preload` 字段与配套的 `OMZ_DASHBOARD_URL`/`OMZ_DASHBOARD_TOKEN` 环境变量写入。三条理由：① 与 `sandbox: true` **互相排斥**——Electron 官方文档明确 "Sandboxed preload scripts can't use ESM imports"，sandboxed preload 以普通脚本（非 ESM 上下文）加载，而原文件是 `.mjs`；它靠 `typeof require` 守卫躲开抛错，代价是 **sandbox 下 `contextBridge` 是否可达没有任何文档承诺**，"这道防护是否生效"无从验证；② **零引用的死代码**——`renderer/app.js` 与 `index.html` 对 `omzDashboard`/`getBootInfo` 一处都没有引用；③ **删掉不减少保护面**——renderer 的页面与数据全部来自 loopback HTTP 服务（`fetch('/api/*')`），token 走地址栏 query（`urlOf('/')` 拼 `?token=`，页面从 `location.search` 读），主进程手上没有 renderer 拿不到的东西。**因此 §13.5 I5 的安全清单从七道防护改为六道**（1.1.0 那条"preload 最小面"是第七道）：这是**一条无法验证的承诺被撤下**，**不是一道防护失效**——攻击面前后相同，`contextIsolation`/`nodeIntegration:false`/`sandbox`/`webSecurity` 四项 BrowserWindow 硬化全部保留。将来若真需要主进程数据，只能用 `preload.cjs`（sandbox 下按 CJS 加载）并把暴露面重新登记进 I5 清单；理由与落点见 `dashboard/README.md`「为什么 Electron 壳不需要 preload」。
- **`engines.node` 由 `>=22.5.0` 提到 `>=22.13.0`**（源码级取证）：Node 22.5–22.12 的 `node:sqlite` 在 `--experimental-sqlite` flag 之后（未开 flag 即不注册该内置模块），直接 import 抛 `ERR_UNKNOWN_BUILTIN_MODULE`，**coordinator 与 dashboard 启动即崩栈**，用户会得到"只有 core 能用"的半残装机；官方 `doc/api/sqlite.md` 的 history 表写明 "v22.13.0 — SQLite is no longer behind `--experimental-sqlite`"。同步改动：`adapters/zcode/capability.mjs` 的 `MIN_MINOR` 5 → 13、`package.json` 的 `engines.node`、`README.md` 与 `mcp/coordinator/README.md` 的下限说明、`tools/doctor.mjs` 的 `cap:node`/`supply:engines` 文案与修复建议（`fix` 里写明 22.5–22.12 需 flag 的原因）。`tests/capability.test.mjs` 的下限用例改为**从 `package.json` 的 `engines.node` 读取版本号写进用例名与失败消息**（`MIN_MAJOR`/`MIN_MINOR` 是 capability.mjs 的私有常量、未 export，engines 是测试能拿到的唯一权威声明），此后改门槛不会再留下写死旧版本号的文案。**判定逻辑未变**：doctor 与测试都走 `capability.mjs` 的常量，本条只是把文案与常量对齐。
- **本条目发布后追加的三处收尾**（本轮补记，故上方"本版不加测试"已不成立）：
  1. **`checkRequestTarget` 的 absolute-form 白名单补测试 9 例 → 当时总数 557 tests / 101 suites**（本条目最终总数见下方注入预算那条与「验证」块的 572/102）。这道门此前是 I5 清单里**唯一有实现零断言**的一项（全仓搜只命中 `server.mjs` 自身，把函数体改成 `return true` 也不会有任何用例变红）。补的是两级断言：纯函数级 5 例（origin-form 恒放行、absolute-form 命中本机白名单放行、外部 host 与端口不符拒绝、authority-form 与 asterisk-form 拒绝、非 http scheme 一律拒绝）+ 真实 socket 级 4 例（用 `net.connect` 手写请求行，因为 `node:http` 客户端只发 origin-form、构造不出 absolute-form；覆盖外部 host→400、本机 host→200、origin-form→200、ftp scheme→400），并断言 400 发生在读静态文件之前（响应体不含 `app.js` 内容）。
  2. **许可证判据提取为 `tools/lib/license-gate.mjs` 共享函数**。此前 `tools/doctor.mjs` 与 `tools/sync-omo-skills.mjs` 各写一份判据，松紧差两个量级：doctor 看四项（status/spdx/verified_at/verified_via），sync 只要求 `status` 存在且不以 `unverified` 开头——于是 `status: "pending"`/`"TODO"`/甚至 `"x"` 都能从 sync 静默过去，且完全不看 spdx 与取证痕迹。现在两侧共用 `evaluateLicenseEntry()`，**判断同源、严重度按调用方职责分化**（doctor 的 `supply:upstream-license` 是发布门：`ok` 之外三档一律 FAIL；sync 的 `loadLock()` 是同步前提示：`incomplete`/`unverified` 只报 WARN 且退出码仍 0，`missing`（记录整条不存在）保留它原有的 ERROR/exit 1，因为 lock 结构缺失与"核验没做完"不是一回事）。为精确保留这条退出码契约，函数除 `level` 另返回 `statusPresent`。"谁要取证痕迹"的划分也归入判据本身（`PROOF_EXEMPT_KEYS`，方向 fail-closed：默认要 proof，只有显式豁免的 key 免——`codegraph` 是外部 MCP 依赖而非移植来源，其供应链取证由 `supply:codegraph` 与 NOTICE 承担）。**已知边界照旧写明**：四项齐备只证明"有可复核的取证痕迹"，不证明值本身正确，值的正确性只能联网比对上游 LICENSE，而 doctor 与 sync 都是离线检查。
  3. **I5 防护计数口径统一**。`dashboard/server.mjs` 与 `tests/dashboard.test.mjs` 保留按代码结构的**七条**切分（端口与 token 在实现里是两段独立逻辑），并显式注明与 DESIGN §13.5 I5 **六道**切分的差异属"同一组防护的不同切分、不是漂移"，以及原第七道 preload 已随组件删除是"承诺被撤下"而非"防护失效"。
- **文档双语化（本轮）**：`DESIGN.md` 转为英文主文件、新建 `DESIGN.zh-CN.md` 作中文对照（中文正文原样保留，不回译），两版首行加语言切换器、跨文件链接指向对应语言版本。同时修掉三处过期数字：`hooks/README.md` 的 `ulw.md` 字节数复测为 **11175**（剥 frontmatter 后正文 **11018**、`additionalContext` **11105**、JSON 负载 **11372**，旧值 7200/7044/7130/7355 是 `ulw.md` 拆八步加第零步之前的）；`hooks/README.md` 的"注入长度上限"一节不再用现在时描述**已在 v1.4 删除**的顶层 `maxOutputBytes`，并改为准确表述——真实上限来自用户/内部配置、**缺省 32768**，因此 `MAX_CONTEXT_BYTES = 48KB`（49152）在缺省配置下**不是有效防线**（正文落在 32768–49152 之间会通过自检后被引擎**整段静默丢弃**——不是本条目原文所写的"截断成半截 JSON"，取证与修法见下一条），当时不构成实际问题只因 11105 远低于 32768。**本轮已修，故不再是需要标注的残余风险**；`DESIGN.md` 描述当前状态处的 `548 tests / 99 suites` 改为当时的 **557/101**（本轮再改为 **572/102**；**版本历史 v1.4 条目里的 548/99 是当时的真实值，不改**）。
- **hook 注入预算防线错位（真实缺陷，已修）**：旧 `MAX_CONTEXT_BYTES = 48KB`（49152）**高于**引擎缺省 `maxOutputBytes` **32768**，且判定对象是 `additionalContext` **字符串**的字节数，而引擎量的是 **stdout 的完整 JSON 负载**（实测 `ulw.md` 差 267 字节，中文越多差越大）——两重错位。落在 32768–49152 之间的注入体会通过自检后被引擎**静默丢弃**：`OutputCollector.append()` 在 `inlineBytes >= maxInlineBytes` 后丢弃余下 chunk（只置 `truncated` 标记，hook 路径从不读它），随后 `parseHookStdout()` 对半截 JSON 执行 `try{JSON.parse(r)}catch{return}` → `undefined`。没有 kill、没有非零退出码、没有报错，唯一症状是"hook 好像没生效"。**修法**：新增 `ENGINE_DEFAULT_MAX_OUTPUT_BYTES = 32768`（注释附五处引擎取证）；判定改为 `payloadBytes(text) = Buffer.byteLength(JSON.stringify({additionalContext}), 'utf8')`；预算 `MAX_PAYLOAD_BYTES = 24576`（32768 − 8192，即 25% 余量——用户/工作区配置可能把 `maxOutputBytes` 调得更小，hook 进程拿不到那个值）；降级从两级扩为**三级**（`full` → `headings` → `minimal`）并以 `fitToPayload()` 硬裁兜底；头窗大小改用**二分实测负载**求，不用线性回减（转义密集输入下线性回减会一次把头窗砍到 0）。`MAX_CONTEXT_BYTES` 保留但**降级为派生参考量**（`MAX_PAYLOAD_BYTES - 24` = 24552），**不参与任何判定**。**测试**：`tests/hooks.test.mjs` +15 例（68 → **83**，新增 suite「注入负载预算与降级」），self-test +3 例覆盖 full/headings/minimal（27/27 → **30/30**），总数 557/101 → **572/102**。含不变量断言（预算 + 余量 ≤ 引擎缺省；三个 mode 的负载都 < 预算）、三级降级各自的负载上界断言、`ulw.md` 回归哨兵（负载 < 预算且余量 > 1.5x，再膨胀先撞测试而不是撞引擎）、5MB 输入的降级耗时哨兵（< 1500ms）。**变异验证**：预算改回 49152 → 3 条红（含 `预算(49152) + 余量(8192) 必须 <= 引擎缺省(32768)`）；删掉二级降级 → 3 条红（含 `预算 24 下返回的负载 82865（level=headings）越界`）。**顺带修正**：`ulw.md` 剥 frontmatter 后正文是 **11018** 而非 11019（`stripFrontmatter` 剥完分隔符后还有个 `replace(/^\s+/,'')` 吃掉一个前导换行）。


**验证**

`npm test` **572 tests / 102 suites 全绿**（1.4.0 是 548/99，本条目发布后补的 `checkRequestTarget` 用例 +9、本轮注入预算用例 +15）；`node tools/doctor.mjs` **无 FAIL**（唯一 WARN 是本机未装 codegraph，`graph` profile 默认关闭属预期）；`node tools/validate-frontmatter.mjs .` 通过；`node hooks/keyword-detect.mjs --self-test` **30/30**。真实会话侧：`/omz-doctor` 的 9 次 spawn ping 全部返回暗语并带回自报工具面与自报可见 skill 清单；`/ulw` 终态靶子项目 `npm test` **8/8/0**、四条 SC 全 done、boulder `status: done`、`.omz/` 卫生扫描零 BOM 零反斜杠零损坏。

**已知缺口**

剩 **5 项**真实环境验收未做（1.4.0 是六项，减掉的正是 V12）：**V3**（hook `additionalContext` 的实际注入行为——本次两个命令都走斜杠路径，不触发 hook）、**V4**（resume 适配器——冒烟全程任务级新 spawn，未触达 resume 路径）、**V8′**（并行 spawn 的权限弹窗时序——本次 spawn 均为顺序发起，没制造并行场景）、**V10**（CodeGraph 装机）、**V11**（Electron dashboard 真机渲染与 CSP 实际拦截）。五项全在触发增强层、可选适配层或可选 profile，回退形态都已是当前的常态发行配置，**没有一项会让 core 不可用**。另一条诚实边界：core 主路径只跑过**一个小特性、一条路径**——B18 的中断续跑、`/team` 的 claim 过门、LIGHT/HEAVY 分级、EXPAND 尾巴、5-lane 评审这些分支本次都没走到。

---

## 1.4.0 — 设计文档回写与收尾对齐（2026-09-01）

1.3.0 修完了代码，这一版做三件事：把**实现期学到的东西写回设计文档**、清掉规格与实现的残余分歧、以及**用变异测试验证测试本身是否真的会红**。没有新功能。

**范围**

- **DESIGN.md v1.3 → v1.4**（1117 → 1482 行）。新增 §17「实现期架构裁决」12 条，每条按「设计期表述 → 事实 → 裁决 → 影响面」记录；新增 B22–B30 九条 bug 预案（全部来自实际命中的缺陷，不是推演）与 I7–I10 四条集成风险；§10.3 补第二、三轮引擎符号级反查的十条代码级证据；§10.2 待实测项重排（V8 枚举与 V9 并发压测已结清移入 §10.1，剩 V3/V4/V8′/V10/V11/V12 六项）；§9 里程碑表加「v1.4 实际状态」列；§8.2 重写 hook 触发层的事实。
- **反假测试（本轮最有价值的部分）**。独立验收审计做了变异测试——把整仓复制到临时目录、随机破坏被测实现、看对应测试是否变红。结果发现三条**不可失败的测试**：I10 的 dashboard 鉴权分层（把 `/api/snapshot` 加进 `PUBLIC_PATHS`、或把静态壳移回 token 门之后使面板彻底不可用，46/46 全过）、B27 的看板字段注入净化（让 `cell()` 直接返回原值，139 个用例全过）、B28 的波次数值排序（改回字典序无人发现）。修法：`dashboard/server.mjs` 让请求流水线**直接用** `PUBLIC_PATHS.has(pathname)` 判定（消除第二份独立判断，改常量即改行为），测试加同源断言 + token 非空服务上的真实浏览器序列；新建 `tests/render-status.test.mjs` 直测 `cell()` 与 `compareWave()` 并做端到端伪造攻击断言。抽查又发现三条同类假测试（`MAX_SSE_STREAMS`、`parseEventCursor`、流水线的 loopback 门）一并补齐。四次变异逐个复验会红。
- **引擎第三轮反查推翻两个前提**。① `hooks.json` 的 `matcher` 在 `UserPromptSubmit` 上**不参与筛选**：`hookRunner.run(t, r={})` 用第二参数做匹配，而 `runUserPromptSubmitHooks` 只传 `{signal}`，匹配函数在 matchValues 为空时无条件返回 true——所以"不命中连 node 进程都不启（省开销）"是错的，启用 `keyword_hook` 后每条用户消息都付约 126–132ms（裸 `node -e 0` 基线 85–91ms）。② `permissionMode` 枚举已直接取出（`acceptEdits`/`auto`/`bypassPermissions`/`default`/`dontAsk`/`plan`），**没有任何值能移除单个工具**——所以「用 `permissionMode` 把 Bash 收成结构约束」这条收紧路径不可行，双层模型（Edit/Write 结构 + Bash 纪律）是**终态**而非过渡态。
- **新增 B30【高】：主 agent 拿不到 sessionId**。`${ZCODE_SESSION_ID}` 只在 hook / MCP / 命令的 shell 执行块上下文展开，Bash 工具的 env 里没有它，系统提示词 `<env>` 块也只有 cwd/git/platform/shell/osVersion——而协议要求把目标写到 `.omz/goal/<sessionId>.json`。模型会自己编一个，本轮自洽、看板照渲、doctor 检不出，**又一个退出码 0 的假成功**（B22 家族）。修法：`commands/ulw.md` 新增「第零步：会话标识」用内联执行块取真实值（并挡住"引擎未展开时字面量 `${...}` 残留"这一分支），取不到则用 `<ISO 时间戳>-<git HEAD 短哈希>` 确定性回退，**明令禁止编造**，并把 `boulder.json` 的 `active_goal` 钉为跨会话找回的唯一权威指针（`session_ids` 只作审计线索）。
- **MCP 工具真名**。插件 MCP 工具的实际名字是 `mcp__plugin_omz_omz-coordinator__omz_team_create` 形态，而 `commands/team.md` 与 DESIGN §7.2 全用裸名——主 agent 按字面调用会 tool-not-found（有回退，但表现为"orchestration 开了却总在降级档"，极难诊断）。修法：命令新增第零步，要求按后缀匹配自己的工具清单现取真名（不硬编码长名，插件名或 server key 变了也不会错），找不到即判定 profile 未启用并走 core 回退。
- **`hooks.json` 清掉死字段**。顶层 `enabled` 与 `maxOutputBytes` 经取证引擎**从不读取**（`parsePluginHookEvents` 只取 `rawHooks.hooks`，有插件 hook 时引擎强制 `enabled: true`）；真正生效的是 hooks 数组**元素级**的 `enabled`。删掉两个死字段并把取舍写进 `_comment`（已验证引擎忽略未知顶层键）。有意**不写**元素级 `enabled: false`——那会让语义闸 `keyword_hook` 永远不被触及，用户想启用得改插件文件而非项目配置。
- **收尾对齐**：`omz-looker` 的 tools `[Read]` → `[Read, Bash]`、maxTurns 10 → 15（纯 `[Read]` 拿不到待检图片路径，该角色此前实际不可用）；附录 A 的"全工具"写法由 `tools: []  # 全工具` 改为**明确要求省略该行**（`tools: []` 是空白名单，与"省略=继承全工具"语义相反，与 B23 同源）；`coordinator.sqlite` 定为**单库多 team**（v1.3 目录树的分库画法被推翻，隔离改由 per-team 文件区 + 库内 `team_id` 外键承担）；附录 A 九个骨架与 `agents/*.md` 实际文件逐字段对齐（diff 归零）；doctor 汇总行改为 `9/9 静态校验OK（spawn ping 未执行）`（旧措辞会让人误读为 V12 已完成）；三个模块 README 的 `${pluginDir}`、过期字节数、开关表述一并修正。
- **§14 置信度重新标定**：分母从"设计能否实施"换成"代码能否在真实环境按预期跑"，整体 98%（设计交付）→ **95%（代码交付）**。只读子项 70%（裁决 3 的终态结论）、集成选型层 90%（CodeGraph 未装机）、新增展示层 85%；并发子项因 V9 压测通过而上调。

**验证**

`npm test` **548 tests / 99 suites** 全绿（1.3.0 是 515/90，本轮反假测试 +33）；`node tools/doctor.mjs` 无 FAIL（唯一 WARN 是本机未装 codegraph）；`node tools/validate-frontmatter.mjs .` 通过；`node hooks/keyword-detect.mjs --self-test` 27/27。**四次变异验证**：`/api/snapshot` 进 `PUBLIC_PATHS` → 10 条红；静态壳移到 token 门后 → 3 条红（含"面板会无样式无脚本"的明文断言）；`cell()` 返回原值 → 10 条红（含"列数被注入撑开 7 !== 4"）；`compareWave` 改字典序 → 4 条红。**V9 并发压测**（本轮补做）：8 个独立 node 进程抢同一 graph 的 200 个任务 → 730ms 内 200 次 claim、unique=200、**重复 claim 0**、`SQLITE_BUSY` 重试 0 次、`verifyGraphInvariants` 0 violations；`max_parallel=8` 的 40 任务图，超限的 52 次全部返回 `reason:'max-parallel'`。DESIGN.md 交叉引用自查：340 处 `§` 引用去重 41 个全部命中、B1–B30 连续无缺号、I1–I10 连续、V 编号 13 个引用无定义 0。

**已知缺口**

六项真实环境验收仍未做，全部需要真机或真实 ZCode 会话：V3（hook 的 `additionalContext` 注入行为）、V4（resume 适配器）、V8′（并行 spawn 时的权限弹窗行为）、V10（CodeGraph 装机）、V11（Electron dashboard 真机渲染与 CSP 实际拦截）、V12（会话内 9 个 agent 的 spawn ping）。每项都有明确回退路径，没有一项会让 `core` 不可用。另一项已知残余：未启用 `keyword_hook` 时 hook 仍会空跑（约 126–132ms/条消息），彻底消除需在项目/用户配置层禁用插件 hook。

---

## 1.3.0 — 对抗式全量审计与修复；实现对齐 DESIGN v1.3（2026-09-01）

两位独立审计员对全仓库做了对抗式审计——一位查**协议保真度**（agents/commands/skills 的正文是否与 ZCode 的真实工具面自洽、与 OmO 原始协议是否等价），一位查**代码安全与并发**（MCP 服务端、dashboard、hook、adapters）。报告的缺陷已全部修复，并为每一类补了回归测试。本条目按缺陷类型分类，每条都写清"此前的实际后果"，因为多数缺陷的危险性不在于它会报错，而在于它**不会**报错。

### 安全类

- **`now` 参数从 13 个公开 MCP 工具的 `inputSchema` 移除。** 此前调度器时钟对调用方开放，任意 worker 可以 `omz_reclaim_expired({ now: <未来时间> })` 把别人正在跑、lease 未过期的任务判成过期抢走（原 owner 被清空、任务回 `ready` 后被另一 agent 认领），同样能绕过 `retry_at` 退避与 `attempts` 重试预算。现在 MCP 层一律传服务端 `nowSec()`；`now` 只保留在 core 函数签名上作测试注入，且仅当 `OMZ_TEST_TIME=1` 时才接受外部值，每次接受都在 stderr 打一行 WARNING。
- **`teamId` 与 `projectRoot` 的路径穿越。** `adapters/zcode/transport.mjs` 增加 `safeTeamId()`（非 `[A-Za-z0-9_-]` 一律替换为 `_`）与 `assertInsideOmz()` 断言（解析后的目标必须在 `<projectRoot>/.omz` 之下）；`hooks/keyword-detect.mjs` 的 `resolveProjectRoot()` 对非绝对路径一律不采信、退回 `process.cwd()` 并记 stderr。此前 `teamId='../../../evil'` 能把状态文件写到项目外，hook 侧只安全化了 `sessionId` 而漏了 `projectRoot`。
- **hook 的 ReDoS。** Markdown 链接屏蔽原用正则 `/\[[^\]\r\n]*\]\([^)\r\n]*\)/`，在 `[[[[…](](](…` 这类退化输入上灾难性回溯：128KB 输入实测 **18.4 秒**，远超 `hooks.json` 的 `timeoutMs: 3000`——引擎超时会直接杀进程，"任何情况都输出 `{}`"的 fail-open 契约当场变成 fail-broken。改为 `maskMarkdownLinks()` 单向线性扫描后同类输入 **2ms**，最坏 O(n)。另加两道自保：扫描窗口 `MAX_SCAN = 32KB`（头 24KB + 尾 8KB 两段独立屏蔽，避免头窗未闭合的三反引号跨越拼接点）与自我预算 `SCAN_BUDGET_MS = 1500`（超预算立即放弃分析返回 `budget-exceeded`；宁可漏检一次，用户还能显式打 `/ulw`，也不能被杀掉输出零字节）。注入体另有 `MAX_CONTEXT_BYTES = 48KB` 上限，超限降级为"头部原文 + 章节标题清单"，防止 `maxOutputBytes: 65536` 硬截断切出半截 JSON。（*v1.5 修正：引擎取证推翻末句两点——引擎缺省 `maxOutputBytes` 是 **32768** 而非 65536，超限也不是硬截断而是**整段注入被静默丢弃**；因此这道 48KB 上限当时高于引擎真墙、不是有效防线。此处记录的设计意图原样保留，修法见 1.5.0 条目。*）
- **dashboard 鉴权分层。** 静态壳（`/`、`/index.html`、`/app.js`、`/app.css`）免 token，数据端点（`/api/snapshot`、`/api/events`）必须 token。此前静态资源也在 token 门之后，而浏览器只把 `?token=` 带在地址栏那一个请求上——`<link>`/`<script>` 子资源请求不带任何凭据 → 401 → 页面无样式无脚本 → **面板在默认路径下根本不可用**。分层依据是"响应里有没有数据"：静态壳是编译期固定字节，不含任务、路径或 token。免 token 集合导出为 `PUBLIC_PATHS`。
- **`/healthz` 不再泄露绝对路径。** 只回 `{ ok, source }`；`degraded[]` 的 reason 含 coordinator db 绝对路径，已移到需 token 的 `/api/snapshot`。另加 `HEALTHZ_TTL_MS = 1000` 结果缓存，避免免鉴权端点变成全量快照的 CPU 放大器。
- **SSE 连接数上限与共享轮询器。** `MAX_SSE_STREAMS = 8`，超限 `503 + Retry-After: 5`（此前 `streams` 是无界 Set，60 条连接会被全部接受）；所有连接共用**一个** `setInterval`（1500ms）采集并广播同一份快照，CPU 成本与连接数解耦（此前 per-connection 一对定时器各自跑全量采集）。最后一个订阅者断开即停定时器，定时器一律 `unref()`。
- **eventId 局部化。** `Last-Event-ID` / `?since=` 只作**本连接**的计数起点，不再写回服务器全局计数器——此前传 `Number.MAX_SAFE_INTEGER` 会让 `+1` 失去精度，把**所有**客户端的帧 id 钉死在同一个值。入参经 `parseEventCursor()` 校验（非纯数字 / 非安全整数 / `<=0` / `> 2^31-1` 一律忽略并从 0 开始）。
- **`tools/sync-omo-skills.mjs` 的 shell 元字符白名单。** lock 里的 `url`/`branch`/`path`/`omz_target` 会被拼进打印给人复制执行的 git 命令，此前一个恶意 lock 的 url 就能把 `; rm -rf` 送进用户终端。现在这些字段先过字符白名单，违规进 `errors` 并 `exit 1`，绝不进入打印。

### 数据一致性类

DAG 的核心不变量是「下游 ready ⟺ 所有上游 done」。它一旦被破坏，**数据库自身仍然是自洽的**（`deps_remaining=0` 且 `status=ready`），事后无法从状态反推出错——所以必须在写入侧堵死，并另备检测手段。

- **终态守卫 + 依赖边一次性消费（两层防重，缺一不可）。** `taskComplete`/`taskFail` 在 `idemLookup` 之后立刻检查任务状态：已在终态集合（`done`/`failed`/`dead`）→ 直接返回 `duplicate: true`，**不再触碰下游**。这一层拦的是"不带幂等键"或"带一个全新幂等键"的重复调用——幂等表对这两种情况完全无感，此前重复 complete 会二次递减下游 `deps_remaining`。第二层是 `task_deps.consumed`（migration `002-task-deps-consumed.sql` 新增，默认 0）：递减只处理 `consumed = 0` 的边并在同一事务内置 1，即使第一层被绕过（历史脏数据、手工 SQL）下游也不会重复解锁。002 同时回填历史数据（已 `done` 上游的出边置 `consumed = 1`），既有库回填后即刻自洽。
- **`taskFail` 的三道守卫。** ① 终态任务不可 fail（否则已 done 的任务被复活成 `ready`、`result_ref` 被清空、可被重新 claim 再次 complete → 下游二次解锁）；② `owner_agent` 不等于调用方即 `NOT_OWNER`，**包括 `owner_agent` 为 null 的情况**——此前"null 就不校验"等于开了一条任意 agent 对他人任务写 `last_error`、改状态的通道；③ 只有 `running` 的任务可以 fail，`blocked` 任务被 fail 会被改成 `ready`，那是直接绕过依赖的通道。
- **幂等键与 `task_id` 绑定。** 幂等键现在与 `(op, task_id)` 双重绑定；键已用于其他 `op` 或**另一个 task** → `BAD_ARGS`。此前对 `task_id=2` 用 task 1 的键，`idemLookup` 会返回 `{task_id:1, status:'done', unblocked:[2]}` 且标 `duplicate: true`——调用方据此认为 task 2 已完成，拿到的是**另一个任务**的结果。
- **`max_parallel` 实际生效。** 此前只存储与回显，`max_parallel=2` 的 team 能有 5 个并发 `running`。`taskClaim` 现在在**同一 `BEGIN IMMEDIATE` 事务内**统计该 team 的 running 数，达上限返回 `{ task: null, reason: 'max-parallel', running, max_parallel }`。计数必须在写事务内做——"先读计数再开事务"本身就是竞态，N 个并发 claim 会同时读到未达上限；计数范围是整个 team（跨该 team 的所有图），因为并发预算是团队级资源。调用方按 `reason` 分支：无 reason = 暂时无 ready 任务，`max-parallel` = 稍后重试，`team-shutdown` = 停止轮询。
- **新增 `verifyGraphInvariants(db, { graph_id })`** 作为 DAG 不变量检测器（core 的导出函数，不是 MCP 工具，只读、可用于 readonly 句柄，供 doctor / 对账脚本调用）。它拿 `tasks.deps_remaining` 与 `task_deps` 里真实的未完成上游数对账，覆盖 4 类违规：`deps-remaining-mismatch`、`dispatched-with-open-upstream`、`blocked-with-no-open-upstream`、`edge-consumed-but-upstream-not-done` / `edge-unconsumed-but-upstream-done`。
- **`omz_export_mirror` 的标识体系改用数字 task id。** `tasks` 的唯一约束是 `UNIQUE(graph_id, key)`——key 只在**图内**唯一，同一 team 提交两个图复用同名 key 完全合法，此时以 key 为关联键会让镜像串行（第一个图的任务贴上第二个图的 title/depends_on）。镜像行现在给 `id`（数字，全库唯一，关联主键）/ `key`（供人读）/ `graph_id` / `depends_on`（数字 id 数组）/ `depends_on_keys`。这是对 DESIGN §7.3 样例的**刻意偏离**，已在 `mcp/coordinator/README.md` 记录。dashboard 侧 `buildMirrorIndex()` 三档降级：有数字 id 按 id 关联 → 只有字符串 id 且本 team 内 key 无重名按 key 关联 → 存在重名 key 时**只对重名的那些 key** 退化为不关联并写 `degraded[]`。绝不按 key 猜：错误关联比缺字段更有害。
- **`reclaimExpired` 的 `last_seen` 不倒退**：把原 owner `transport_state` 置 `unknown` 时写的是回收发生的时刻，而非已过去的 `lease_until`。

### 可用性类（最隐蔽的一类：全是退出码 0 的假成功）

- **`isMain` 判定改用 `fileURLToPath`。** 此前用 `new URL(import.meta.url).pathname`，它是 percent-encoded：插件目录含空格或非 ASCII（Windows 极常见，`C:\Program Files\`、`C:\Users\张三\`）时与 `process.argv[1]` 永不相等，`isMain` 恒为 false ——hook 输出 0 字节、`doctor`/`status`/`sync`/`validate` 全部**静默 exit 0 什么都不做**。退出码 0 意味着用户和 CI 都看不出坏了。统一抽出 `tools/lib/is-main.mjs` 的 `isMainModule(import.meta.url)`，5 个 CLI 入口（doctor / render-status / validate-frontmatter / sync-omo-skills / keyword-detect）与 `dashboard/server.mjs`、`dashboard/main.mjs` 全部改用。
- **`validate-frontmatter.mjs` 支持 dash 数组。** 此前只认 `tools: [Read, Bash]` 行内数组，合法 YAML 的 `tools:\n  - Read` 被静默解析为 `tools` 缺失（= 全工具）——只读角色的白名单静默失效，而 doctor 报 OK。
- **`KNOWN_TOOLS` 拆为 `SUBAGENT_TOOLS` 与 `ENGINE_ONLY_TOOLS`。** `Agent`/`WebSearch`/`Grep`/`Glob` 在引擎里存在但子代理侧拿不到（DESIGN §10.1 V5、§13 B20 实测），写进 frontmatter 会被静默忽略。现在出现 `ENGINE_ONLY_TOOLS` 成员直接报错并说明原因——静默忽略的能力声明会让"只读角色靠白名单收束"的假设失效。
- **`deepNormalizePaths` 改为字段白名单驱动。** 归一只对 `PATH_FIELD_NAMES` 登记过的字段生效（数组元素继承父键名判定）。此前全量深度遍历会把非路径字符串一并"归一"，例如 `regex \d+` 被破坏成 `regex /d+`。
- **`toPosixRelative` 的越界语义。** 跨卷（`C:` vs `E:`）、设备命名空间、结果以 `..` 开头三种情况不再静默返回相对路径（那是一个在任何机器上都不存在的路径），改为按 `onEscape` 抛错或返回显式标记。
- **`render-status.mjs` 的波次数值排序与 title 清洗。** 波次此前按字典序排成 1→10→2；title 现在剥换行与竖线——此前 title 含换行可以伪造出一整行看起来合法的任务。

### 协议保真度类

- **Atlas 角色重写。** `omz-atlas` 是子代理，**结构性没有 Agent 工具**（DESIGN §10.1 V5 实测），此前正文却要求它"派执行 agent"——一旦被 spawn 必然违规。改为「**波次状态机 + 派单建议生成器 + 汇报器**」：产出可直接粘贴的 8 要素派单建议（TASK / EXPECTED OUTCOME / 基线+failing-first / REQUIRED SKILLS / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT）+ 建议 `subagent_type` + LIGHT/HEAVY 标注，回请主 agent 执行 spawn。同时明确它**收不到后台通知**（通知只到主 agent），收点判据只有 results 文件是否存在且可解析。
- **`ulw-plan` 补齐结构约束说明。** Prometheus 同样不能 spawn，此前三处文件命令它派 Explore/critic。
- **`ulw-execute` 补入 10 条 Hard rules 全文。** 此前只在 `commands/ulw.md` 有一份，子代理拿不到会话历史也拿不到命令展开的内容。两份现在要求逐字一致，文件里留了同步提醒注释。
- **`ulw-research` 补 PDF + DOCX 交付工具链**（chrome headless 打印 + pandoc，含 Windows 上逐条探测 chrome 可执行文件的失败回退，命中路径记进 observation-manifest）。
- **`review-work` 补 `references/` 引用段。** `verdict-schema.md` 里的 AdversarialVerify JSON 契约此前因为 SKILL.md 没有引用它而事实上不可达。
- **只读角色的"结构性保证"表述修正为诚实版。** `tools: [Read, Bash]` 里 Bash 能写文件（重定向、`sed -i`、`node -e`），此前正文宣称"你物理上改不了代码"是错误的自我认知。现在的表述是"工具面拦得住 Edit/Write，拦不住 Bash 写文件，所以这一条靠你自己守"，并逐条列出禁用命令；`omz-reviewer` 的 `git worktree add/lock/unlock/remove` 是唯一显式豁免命令集。
- **工具面纠正。** `omz-librarian` 删除不可用的 `WebSearch`（现为 `[Read, Bash, WebFetch]`，正文明确"你没有搜索引擎工具，无链接时明确回报需要主 agent 提供入口，不许凭记忆编造"）；`omz-looker` 从只有 `Read` 加到 `[Read, Bash]`（此前无法枚举图片路径）。
- **`boulder.json` 指针在目标注册时立即写入**（`commands/ulw.md` 第二步），不再等到收尾。此前若会话在第一个波次前中断，跨会话续跑没有任何指针可查（B18）。
- **`commands/ulw.md` 拆为八步**与 DESIGN §6 对齐（激活 / 目标注册 / 技能盘点 / 确定性保障 / 规划门槛 / 执行 / 双证据验证 / 评审门与提交）。同时加入 Stop hook 的诚实表述：它属**未实装项**（`hooks/hooks.json` 目前只注册 `UserPromptSubmit`），进度落盘靠主 agent 每个波次收点后主动写 `boulder.json`，**不得依赖** hook 在异常终止时保存进度。

**验证**

- `npm test` → **515 用例 / 90 suites 全通过，0 失败**（`node --test tests/`，约 13.6s）。按文件：coordinator 100、path 82、hooks 68、protocol 48、dashboard 46、transport 37、capability 33、server-mcp 31、cli 30、fallback 25、integration 15。（1.4.0 的反假测试补齐后为 548 / 99。）
- `node tools/doctor.mjs` → 无 FAIL；`① agents 9/9 OK | ② model OK | ③ gitignore OK | ④ mtime OK | ⑤ BOM OK`，唯一 WARN 是 codegraph 不可用（`graph` profile 默认关闭，属预期）。
- `node tools/validate-frontmatter.mjs .` → 通过（agents/commands/skills）。
- `node hooks/keyword-detect.mjs --self-test` → **27/27 通过**，含"Markdown 链接退化输入 32K 不超预算（线性扫描）"与"İ 前缀 + `team` 索引对齐"两条针对本轮修复的用例。
- `node tools/sync-omo-skills.mjs --check` → lock 字段完整、5 个 `omz_target` 全部存在；3 条 WARN（commit 未 pin / synced_at 未记录 / OmO 许可证 `unverified`），均为"尚未执行过一次真实同步"的预期状态。
- `tests/protocol.test.mjs` 内含跨文件契约断言：AdversarialVerify 四字段与四枚举在 `omz-reviewer.md` 与 `verdict-schema.md` 逐字一致、复审上限 2 次两处一致、状态枚举三方闭环（coordinator 7 态 + 文件视图 `pending`/`corrupt` = `app.js` 的 `STATES` = `app.css` 的 `.pill[data-state]` 选择器）、`skills/*/references/` 无孤儿文档、`plugin.json` 声明路径全部存在、全仓库无 BOM、全 `.json` 可解析。

**已知缺口**

- DESIGN §10.2 的 **V3 / V4 / V8 三项装机实测未完成**（hook `additionalContext` 实际注入行为、resume 适配器行为、`permissionMode` 枚举与并行 spawn 权限弹窗）。三项各有已写明的回退路径。
- `graph` profile 需外部安装 `@colbymchenry/codegraph` 并在目标项目 `codegraph init`，本仓库不含其索引；doctor 目前只能报"不可用"。
- **Stop hook（DESIGN §9 M4）未实装**，异常终止的宪法清单核对仍靠主 agent 自律。
- `omz-doctor` 的 spawn ping 9/9 必须**在会话内**执行（离线 doctor 只能做文件级核对）；agent 清单是会话启动快照（B19），装完必须重启会话。
- OmO 上游许可证仍为 `unverified`，`commit` 未 pin——按 `upstream/README.md` 的纪律，核验回填前禁止合并进 `main`。
- coordinator 的 SQLite 单写者压力（DESIGN §13.5 I4）只有单元级并发测试，无长时压测样本。

---

## 1.2.0 — 测试套件建立（2026-09-01）

**范围**

- 11 个测试文件（`tests/*.test.mjs`）覆盖 path / fallback / capability / transport / coordinator / server-mcp / dashboard / hooks / protocol / cli / integration，全部用 Node 内置 `node:test`，零测试框架依赖。
- `package.json` 补全 `test` 与 10 个 `test:*` 分文件脚本；`tests/index.js` 作为聚合入口。
- `protocol.test.mjs` 把文档一致性变成断言（agent 数量与命名、只读角色 tools 不含 Edit/Write、全工具角色不声明 tools、maxTurns 必填、frontmatter 无未知字段、8 要素与 10 条 Hard rules 齐全、8 个 category 全在路由表、两路 status 渲染功能等价、状态枚举三方闭环、references 无孤儿、编码卫生、上游 lock 取证）。
- `cli.test.mjs` 针对每个 CLI 入口断言 `isMainModule` 在含空格/非 ASCII 路径下仍成立——这条测试是 1.3.0 那个"静默 exit 0"缺陷的守门人。

**验证**：`node --test tests/` 与 `npm test` 等价可用；建立时 354 用例全绿（1.3.0 的审计补齐推到 515，1.4.0 的反假测试补齐推到 548）。

**已知缺口**：无端到端装机测试（需真实 ZCode 会话）；覆盖率未统计。

---

## 1.1.0 — dashboard：loopback HTTP/SSE 只读展示层（2026-09-01）

**范围**

- `dashboard/server.mjs`（793 行）纯 HTTP + SSE 服务，零第三方依赖；`dashboard/main.mjs` Electron 壳（缺 Electron 自动降级为纯 HTTP）；`dashboard/preload.mjs` 只经 `contextBridge` 暴露 `getBootInfo()`（**1.5.0 已删除该文件，见该条目「移除 dashboard preload」**）。
- `dashboard/renderer/` 三件套（`index.html` / `app.js` / `app.css`）：零内联脚本样式；服务端字符串只经 `textContent`/`createTextNode`，渲染前剥 ANSI 与控制字符，超 2000 字符截断标注。
- 数据源双轨：优先只读打开 coordinator SQLite 走 `core.status()` → `source: 'coordinator'`；db 缺失/损坏/查询失败则回退 `tools/render-status.mjs` 的 `.omz/` 文件视图 → `source: 'files'`，原因写 `degraded[]`，**绝不 500**。
- 只读契约：所有端点都是 GET，其它方法一律 405；没有任何写入/提交/重试/命令执行端点——dashboard 不能扩大主 agent 权限（DESIGN §15.3-4）。
- 安全模型七道防护（对应 §13.5 I5）：只绑 loopback（来源判定在 token 校验**之前**，非 loopback 直接 403 + `socket.destroy()`）、随机端口（`port = 0`）、每次启动随机 token（`randomBytes(24)` + `timingSafeEqual`）、CORS 白名单（无 `Origin` 放行，其它 403；请求行的 absolute-form host 也校验）、SSE 只发 `snapshot`/`heartbeat` 结构化事件、CSP 禁 inline script、preload 最小面（**最后一道随 preload 删除于 1.5.0 撤下，I5 现为六道，见该条目**）。
- `transport_state`（agents 表）与 `coordinator_state`（tasks.status）永远分两列，不互推不合并（I3）；文件视图无传输维度时 `transport_state` 恒为 `null`。

**验证**：URL（含 token）只打到 stderr，stdout 保持干净；SIGINT 优雅关闭。`node dashboard/server.mjs --project <dir> --port 0` 可独立启动。

**已知缺口**：当时静态资源也在 token 门之后（浏览器子资源不带 token → 面板默认不可用）、`/healthz` 回 `degraded[]` 含绝对路径、SSE 无连接上限且 per-connection 各跑一份全量采集、eventId 写回全局计数器——四项在 1.3.0 修复。

---

## 0.9.0 — mcp/coordinator：SQLite 支撑的 DAG 调度 sidecar（2026-09-01）

**范围**

- `mcp/coordinator/server.mjs`（stdio JSON-RPC）+ `core.mjs`（968 行纯逻辑）+ `db.mjs`（迁移执行器与连接管理）+ `schema.sql` + `migrations/001-init.sql`。零第三方依赖，只用 Node 内置 `node:sqlite`（因此 `engines.node >= 22.5.0`；启动会打 ExperimentalWarning，正常）（**1.5.0 已提到 `>=22.13.0`——22.5–22.12 上该模块在 `--experimental-sqlite` flag 之后，见该条目**）。
- **13 个 MCP 工具**：`omz_team_create` / `omz_dag_submit` / `omz_task_claim` / `omz_task_heartbeat` / `omz_task_complete` / `omz_task_fail` / `omz_mail_send` / `omz_mail_receive` / `omz_mail_ack` / `omz_status` / `omz_team_shutdown` / `omz_reclaim_expired` / `omz_export_mirror`。
- 事务边界纪律（DESIGN §7.2 / §13.5 I4）：claim 用 `BEGIN IMMEDIATE` + 单条 `UPDATE ... RETURNING`（`RETURNING` 不是锁，缺 IMMEDIATE 两个 writer 会读到同一 ready 行）；**外部 agent 执行期间绝不持有写事务**，claim 返回即 COMMIT；`core.mjs` 只 import `node:crypto` 与 `./db.mjs`，无 fs/spawn/网络，因此 `SQLITE_BUSY` 时整个事务含回调可安全重放。
- `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON` + 有界指数退避（基数 25ms、最多 5 次、带 jitter），超限抛 `BUSY_TIMEOUT`；时间戳统一 unix 秒整数，与 `unixepoch()` 同刻度。
- at-least-once 语义 + 幂等键（`complete`/`fail` 必带，`send` 用 `dedupe_key`，`ack` 天然按 message 幂等），重复调用返回首次结果并标 `duplicate: true`。
- 环与未知 key 在写库前拒绝；mailbox 的 `seq` 在事务内 `MAX+1` 无空洞；`status()`/`exportMirror()` 的 `counts` 字段集合恒定 7 态（含 `unknown`）不随库中实际状态漂移。
- 迁移纪律：`migrations/*.sql` 按文件名字典序重放，已发布文件**永不修改**，结构变更只追加；因 SQLite 的 `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，执行器支持文件首部指令 `-- @skip-if-column <table>.<column>`。
- `.zcode-plugin/plugin.json` 加回 `mcpServers.omz-coordinator`（`enabled: false`，`${ZCODE_PLUGIN_ROOT}` 变量，`OMZ_COORDINATOR_DB` 指向 `${ZCODE_PROJECT_DIR}/.omz/runtime/coordinator.sqlite`）——路径此时才真实存在。

**验证**：手工 smoke（`initialize` / `tools/list` / `omz_team_create` 三行喂 stdin）stdout 三行合法 JSON，`tools/list` 返回 13 个工具；stdout 只有 JSON-RPC，日志全走 stderr；工具级失败返回 `isError: true` 的 tool result 而非 JSON-RPC error，未知方法 `-32601`，解析失败 `-32700`。

**已知缺口**：当时 `now` 在 13 个工具的 inputSchema 里对外开放、`max_parallel` 只存不用、幂等键未与 task 绑定、`taskFail` 在 `owner_agent` 为 null 时不校验身份、无终态守卫与边的一次性消费、无 `verifyGraphInvariants`、`exportMirror` 按 key 关联——全部在 1.3.0 修复（`consumed` 列由 `migrations/002-task-deps-consumed.sql` 引入）。

---

## 0.6.0 — 上游来源锁定与选择性同步纪律（2026-09-01）

**范围**

- `upstream/omo-sources.lock.json`：上游仓库/分支/pin 的 commit SHA/同步时间/已移植路径 ↔ OMZ 目标文件映射/`ignored_paths`/许可证记录。**只记录来源与移植状态，不存放上游代码**（DESIGN §16.2）。
- `tools/sync-omo-skills.mjs`：`--check`（lock 字段完整性 + `omz_target` 存在性，ERROR 时 exit 1）/ `--plan`（打印待人工执行的 git 命令清单）/ `--pin <40 位小写 hex SHA>`（回写 `commit` + `synced_at`，输出无 BOM、LF 结尾）。**只打印命令、绝不执行 git**——上游同步必须人工过目。
- `upstream/README.md` 记录分支纪律（`main` / `upstream-sync` / `porting/<date>`，**禁止 `git merge upstream/dev`**）、5 步同步流程、5 条永不移植的宿主 API 路径（`omo-opencode` / `omo-codex` / `team-core` / `tmux-core` / `model-core`）及其判据、许可证与 NOTICE 要求。
- `commit` 字段永不写猜测值：未 pin 一律 `null` + `commit_status` 说明——以"当前 latest"代替固定 SHA 会毁掉来源可复现性。

**验证**：`node tools/sync-omo-skills.mjs --check` → lock 字段完整、5 个 `omz_target` 全部存在。

**已知缺口**：OmO 许可证 `unverified`（未 clone、未读到 LICENSE）、`commit`/`synced_at` 均为 `null`；按纪律核验回填前禁止合并进 `main`。当时 lock 字段未过 shell 元字符白名单（1.3.0 修复）。

---

## 0.5.0 — skills references 补全（2026-09-01）

**范围**

- `skills/ulw-research/references/` 5 个认识论文档：`claim-graph.md`（claim 图与过门）、`intent-diff.md`（意图差分）、`observation-manifest.md`（观测清单）、`verification-economics.md`（验证经济学）、`cause-disappearance.md`（原因消失判据），外加 `worker-prompt.md` 作为强制派发模板。
- `skills/review-work/references/` 2 个契约文档：`lane-prompts.md`（5 个 lane 的完整派发 prompt，含通用 MUST NOT DO 与全部占位符 `{{BATCH_ID}}` `{{GOAL}}` `{{DIFF}}` `{{DIFF_STAT}}` `{{FILE_CONTENTS}}` `{{DONECLAIM}}` `{{TEST_TRANSCRIPT}}` `{{SCOPE}}` `{{WORKTREE}}`）、`verdict-schema.md`（单 lane 报告 JSON schema、`exhaustive_check` 维度集合、汇总规则、AdversarialVerify JSON 的四字段四枚举、复审上限 2 次与 delta scope）。
- `skills/ulw-plan/references/` 3 个流程文档：`intent-clear.md` / `intent-unclear.md` / `full-workflow.md`。
- 每个 references 文档都必须被对应 SKILL.md 显式引用——lane 是叶代理，prompt 之外的上下文它一概看不到，未被引用的契约等于不存在。

**验证**：`protocol.test.mjs` 断言 SKILL.md 声明的 references 全部真实存在且非空，且 references 目录下无未被引用的孤儿文档（双向检查）。

**已知缺口**：`review-work/SKILL.md` 当时尚无 `## references/` 引用段，`verdict-schema.md` 的 AdversarialVerify 契约事实上不可达（1.3.0 修复）。

---

## 0.4.0 — hooks M2 关键词检测（2026-09-01）

**范围**

- `hooks/keyword-detect.mjs`（581 行）：`UserPromptSubmit` 时扫描 `ulw`/`ultrawork`/`team`/`hyperplan`（大小写不敏感），命中则把 `commands/<mode>.md` 正文（已剥 frontmatter）经 `additionalContext` 注入本轮上下文——等价于用户手打斜杠命令（DESIGN §8.2，复刻 OmO 的 IntentGate）。
- `hooks/hooks.json`：`enabled: false`、`timeoutMs: 3000`、`maxOutputBytes: 65536`、matcher 大小写变体正则；`.zcode-plugin/plugin.json` 加回 `hooks: "hooks/hooks.json"`（路径此时才真实存在）。（*v1.5 修正：引擎缺省 `maxOutputBytes` 实为 **32768**，且这两个顶层字段因引擎从不读取已在 v1.4 删除，见 1.5.0 条目。*）
- **默认双开关关闭**：`hooks.json` 的 `enabled`（运行层，ZCode 客户端管，一开就是全局）+ 项目 `.zcode/config.json` 的 `omz.keyword_hook`（语义层，按项目粒度）。两道是有意为之——`keyword_hook` 才是真正可靠的那道闸（zcode-guide 指出任何插件贡献 hook 都会自动启用 hook runner，且插件 `hooks.json` 顶层 `enabled` 是否被读取未经证实），`enabled` 视为声明性意图。脚本在语义层关闭时立即返回空对象，不读命令文件、不写任何状态。
- 三道双重注入防护（B5 + §15.1 误触发红线）：prompt trim 后以 `/` 开头一律不注入；会话级去重标记（`<项目根>/.omz/.mode-injected-<sessionId>`，sessionId 已文件名安全化）；关键词落在行内反引号、三反引号块、引号字符串、Markdown 链接或含 `/`/`.` 的路径 token 内均不命中，且匹配要求两侧不是 ASCII 字母/数字/下划线/连字符（`teamwork`、`myteam`、`multiulw` 不命中）。
- fail-open 契约：脚本任何异常都输出 `{}` 且退出码 0，不阻断主流程（B15）。失败回退纯 slash command（§10.2 的 V3 回退方案就是"永久 M1"）。
- `--self-test` 自检模式。

**验证**：`node hooks/keyword-detect.mjs --self-test` 全绿（当前 27/27）。

**已知缺口**：V3 装机实测未做（`session_id`/`cwd` 的真实字段名尚未在本机 guide 中列明，脚本已容忍 `sessionId`/`userPrompt` 等别名）。当时 Markdown 链接屏蔽正则存在灾难性回溯（128KB → 18.4s，必被 3s 超时杀掉）、`projectRoot` 未净化、`isMain` 用 percent-encoded pathname、无注入长度上限——全部在 1.3.0 修复。

---

## 0.3.0 — tools/doctor.mjs 离线自检（2026-09-01）

**范围**

- `tools/doctor.mjs`（590 行）七类检查：清单完整性（`plugin.json` 声明路径是否存在）、frontmatter 校验（复用 `validate-frontmatter.mjs`）、agent 数量与 model 核对、`.gitignore` 含 `.omz/`（B14，**只报告不代改**，输出可执行修复命令）、mtime vs 会话启动（B19）、JSON/BOM 编码卫生（B4）、能力探测（Node 版本 / `node:sqlite` / git / codegraph / coordinator / dashboard / profile 降级报告）。
- `--supply-chain` 子模式做依赖取证。
- 结论行给单行汇总 `① agents | ② model | ③ gitignore | ④ mtime | ⑤ BOM`，并对每个 WARN/FAIL 给出可执行修复指令（不是笼统报错）。
- `package.json` 加回 `doctor` / `doctor:supply-chain` 脚本（`tools/doctor.mjs` 此时才存在）。

**验证**：`node tools/doctor.mjs` 在本仓库输出"结论：无 FAIL"，唯一 WARN 是 codegraph 不可用（`graph` profile 默认关闭，预期）。

**已知缺口**：spawn ping 9/9 只能在会话内做（`/omz-doctor` 命令版负责），离线版只做文件级核对；当时 `validate-frontmatter.mjs` 不认 dash 数组，导致只读角色白名单失效时 doctor 仍报 OK（1.3.0 修复）。

---

## 0.2.0 — adapters/zcode 宿主适配层（2026-09-01）

**范围**

- `path.mjs`（305 行，B3/B4 路径与编码卫生）：`stripBom` / `readJsonSafe` / `writeJsonSafe`（无 BOM、LF）、`isWindowsAbsolutePath` / `hasBackslashPath` / `isEscapingPath`、`toPosixRelative`、`classifyPath`、`normalizePathValue` / `normalizePathFields` / `deepNormalizePaths`（`PATH_FIELD_NAMES` 白名单驱动）、`scanJsonHygiene`。
- `capability.mjs`（256 行，能力探测）：`probeNode` / `probeSqlite` / `probeCommand` / `probeGit` / `probeCodegraph` / `probeCoordinator` / `probeDashboard` / `probeAll`。Windows 上按 `PATHEXT` 逐后缀查找可执行文件。
- `fallback.mjs`（146 行，profile 解析与降级链）：`loadConfig`（`.zcode/config.json` → `.omz/config.json` 分层）、`resolveProfiles`（能力探测结果对照声明的 profile）、`fallbackFor`、`formatDegradeReport`。四条降级链对应 DESIGN §3.3：`graph` → Explore + Bash grep/rg、`orchestration` → core 波次并行 + `.omz/runtime/` 文件状态、`dashboard` → ZCode GUI 任务面板 + `/omz-status`、M2 hook → slash commands。
- `transport.mjs`（199 行，worker 状态机与 resume 适配器）：`createRegistry` / `bindAgent` / `markResumeWait` / `markReturned` / `checkTimeouts` / `rebuildPromptContext` / `saveRegistry` / `loadRegistry`。resume 不可用时按 DESIGN §7.4 走"任务级新 spawn + 上下文重建"，不依赖 ZCode 未公开的稳定 resume API（V4 回退）。
- `index.mjs` 作为统一出口。

**验证**：各模块纯函数，无 fs/网络副作用（除显式的 `saveRegistry`/`loadRegistry`/`scanJsonHygiene`）；`doctor` 与 `dashboard` 均复用同一套 probe 与 fallback 逻辑，不存在第二份判定。

**已知缺口**：当时 `deepNormalizePaths` 全量深度遍历（会把 `regex \d+` 破坏成 `regex /d+`）、`toPosixRelative` 跨卷/越界静默返回相对路径、`transport` 侧 `teamId` 无安全化与 `.omz` 边界断言——全部在 1.3.0 修复。

---

## 0.1.0 — core profile 骨架（2026-09-01）

**范围**

- `agents/` 9 个子代理定义（omz-planner / critic / deep / junior / atlas / oracle / reviewer / librarian / looker），内置 `Explore` 复用不重复定义（DESIGN 附录 A）。
- `commands/` 5 个斜杠命令（ulw / team / hyperplan / omz-status / omz-doctor，DESIGN 附录 B）。
- `skills/` 4 个核心协议（ulw-plan / ulw-execute / ulw-research / review-work，DESIGN 附录 C），description 均写严格触发语义（普通问答不得激活）。
- `tools/validate-frontmatter.mjs`（B1/B10 防线）、`tools/render-status.mjs`（`/omz-status` 执行体，40 行上限 + BOM 容错）。

**清单收敛（本版的关键决定）**

- `.zcode-plugin/plugin.json` 曾声明 `hooks: "hooks/hooks.json"` 与 `mcpServers.omz-coordinator → mcp/coordinator/server.mjs`，但两个路径均不存在——清单指向空文件会让 ZCode 插件加载报错或静默失败。0.1.0 收敛为仅声明已落地的 `agents`/`commands`/`skills`；hooks 在 0.4.0 加回，coordinator 在 0.9.0 加回。
- `package.json` 曾声明 5 个 `test:*` 脚本与 `doctor` 脚本，指向不存在的 `tests/` 与 `tools/doctor.mjs`。0.1.0 收敛为 `validate` + `status`，随对应里程碑逐步加回。

**验证**：`npm run validate` 通过（9 agents + 5 commands + 4 skills 全部 frontmatter 合规）；`node tools/render-status.mjs` 在空 `.omz/` 下输出"无状态"提示而非报错。

**已知缺口**：无 adapters / hooks / coordinator / dashboard / tests / upstream 锁定；doctor 只有会话内命令版本，无离线可执行体；Atlas 正文当时仍假设自己能 spawn（1.3.0 重写）。


