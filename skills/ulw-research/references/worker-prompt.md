# worker-prompt — 单轴调查 worker 派发模板

## 用途

调研 worker 是**叶代理**：全新上下文、看不到主会话、工具面无 `Agent`（不能再派人）。它不会自发遵守 SKILL.md 里的 EXPAND / manifest / claim 规则——**这些规则必须逐条写进派发 prompt**，否则回报无法归并（DESIGN B16 风险）。

派发主体 = **主 agent**。一个 worker 一条轴（axis），按 §3 scaling floor 的数量一回合并行齐发。

## 占位符（派发前全部填实，宁冗勿省）

`{{SLUG}}` 调研目录名——**已含 stem 前缀的完整目录名**（形如 `<stem>-<短语>`，如 `sess_c99601d3-vmscan-folio`）；worker 原样使用，不拆解、不重拼、不自创（子代理拿不到 sessionId，B30/B32）｜`{{WAVE}}` 波次号（W1/W2…）｜`{{AXIS_ID}}` 轴 id（如 `W2/axis-3`）｜`{{AXIS}}` 本轴要回答的**单一**问句｜`{{INTENT_IDS}}` 本轴对应的 intent-diff 子问句 id｜`{{SCOPE}}` 范围边界（目录/模块/URL 清单）｜`{{URLS}}` 已知外部链接清单（本部署无搜索引擎，必须由派发者提供）｜`{{KNOWN_FACTS}}` 已确认事实与已有 claim id｜`{{DEAD_ENDS}}` 前几波已证死的方向｜`{{OBS_NEXT_ID}}` 本 worker 起始观察 id（如 `O-021`）｜`{{CLAIM_NEXT_ID}}` 起始 claim id（如 `C-012`）｜`{{AGENT_TYPE}}` omz-librarian | omz-junior | omz-deep | omz-oracle

## 模板（8 要素）

```
TASK: 调研 {{SLUG}} 的单一轴 {{AXIS_ID}}：{{AXIS}}。只查这一轴，不扩散。

EXPECTED OUTCOME: 一份 ≤20 行的回报正文（全文证据写文件），结构固定为四段：
  1) 本轴结论：逐条 claim，格式 `C-NNN [unverified|gated|refuted] <一句可判真假的断言> — 证据 [S1]/[E1]/[X1]`
  2) 观察清单：本轴新增的 O-id 列表（明细已写入 observation-manifest 文件）
  3) 未解决点：本轴没答上的部分 + 缺什么才能答
  4) `## EXPAND` 尾巴（见 MUST DO 第 1 条，缺则回复无效）

BASELINE: 先声明本轴的起点事实——{{KNOWN_FACTS}} 里哪些已成立、{{DEAD_ENDS}} 哪些方向不必重走；对每个待查点说明"现在为什么还不知道"（无起点声明的调查等于重复劳动）。查前先 grep observation-manifest 已有条目防重跑（manifest 判定规则 1）。

REQUIRED SKILLS: 无（本 prompt 自足；不要加载 ulw-research skill 全文，你只需遵守本 prompt）

REQUIRED TOOLS: Read, Bash（`grep -rn` / `rg` / `find` / `git log --oneline` / 最小验证脚本）, WebFetch（仅限 {{URLS}} 内的链接）
  —— 本部署**没有 WebSearch**：不得声称做过关键词搜索；需要新链接时写进 EXPAND 的 LEAD 向主 agent 索取，不得凭记忆编造 URL。

MUST DO:
  1. **回复必须以 `## EXPAND` 收尾**，格式逐字如下，至少各一条（真的没有就写 `- LEAD: 无（理由：…）`）：
     ```
     ## EXPAND
     - LEAD: <值得继续追的线索 + 建议下一步用什么手段/入口>
     - DEAD END: <已证死的方向 + 一句死因（含证据 O-id）>
     ```
  2. **每次观察结束立刻追加一条 observation-manifest 条目**，写入 `.omz/research/{{SLUG}}/observation-manifest.md`（append-only，从 {{OBS_NEXT_ID}} 起递增），字段一个不少：波次/执行者、时间戳、意图、operator（只能取 `Bash grep`|`Explore`|`codegraph_explore`|`WebFetch`|`Read`|`执行验证脚本`）、命令原文（含 cwd，逐字可重放）、网络来源（WebFetch 必填 URL + 访问日期 + 抓取形态）、结果摘要 ≤5 行、原始输出留档路径（超 20 行外置到 `.omz/research/{{SLUG}}/raw/O-NNN.txt`）、产生的 claim、代价（cheap|moderate|expensive）、可重放性（replayable|time-sensitive|one-shot）。
  3. **每个 claim 按 claim-graph 状态枚举标注**，写入 `.omz/research/{{SLUG}}/claim-graph.md`（从 {{CLAIM_NEXT_ID}} 起）：状态只能是 `unverified` | `gated` | `refuted`；证据 id 用 `[S<n>]` 来源 / `[E<n>]` 文件（`相对路径:起行[-止行]`，正斜杠）/ `[X<n>]` 执行验证（必须指向本轴的 O-id）；counter-search 字段必填（查询原文或"无法检索：缺什么入口"）；回答的意图子问句填 {{INTENT_IDS}}。
     - 过门自律：non-code claim 未命中 §6 四门槛之一或 counter-search 空 → 只能 `unverified`，**不得自升 gated**；code claim 必须跑最小脚本实测并标 CONFIRMED/REFUTED/PARTIAL，PARTIAL 不算 gated。
  4. **失败的观察同样记录**（含失败输出与退出码）——它是 DEAD END 的证据来源。
  5. 一手来源优先（官方文档/源码/commit）；每条事实性陈述带 `[S<n>]` 或 `file:line`，禁止无出处的转述。
  6. 发现与 {{KNOWN_FACTS}} 里已有 claim **冲突的证据**：立即在 claim-graph 填"冲突 claim"字段并在回报正文点名，不自行裁决谁对。
  7. 曾出现后来查无的线索（链接 404、文件被删、结果不可复现）写入 `.omz/research/{{SLUG}}/cause-disappearance.md`，不得静默丢失。
  8. 路径一律正斜杠相对路径（B3）、UTF-8 无 BOM（B4）；回报正文 ≤20 行，全文写上述文件。

MUST NOT DO:
  1. **不得再委派**——你的工具面没有 `Agent`。需要另一条轴/第二意见/新链接时写进 `## EXPAND` 的 LEAD，由主 agent 决定，不得自行派发也不得假称派过。
  2. 不得越出 {{SCOPE}}；轴外发现只写进 EXPAND 的 LEAD，不顺手调查（这是 Excursion，归主 agent 判 ENTER/EXIT）。
  3. 不得修改、创建、删除任何**产品代码或仓库文件**；写文件仅限 `.omz/research/{{SLUG}}/` 下的 manifest / claim-graph / cause-disappearance / raw。不得 `git add/commit/checkout/stash/reset`。
  4. 不得把推测、"应该"、"一般来说"写成 claim；无证据的判断只能进 EXPAND 的 LEAD。
  5. 不得省略 `## EXPAND`，不得把它改名或改格式（主 agent 按字面解析）。
  6. 不得事后凭记忆补写命令原文，不得用 `<同上>` / 省略号截断命令。
  7. 不得回显 secret 值（按 key 名引用）；不得把 `.env` 类文件内容写进 manifest。
  8. 不得声明"本轴已饱和/可以收敛"——收敛判定归主 agent（§7）。

CONTEXT:
  调研 slug={{SLUG}}；波次={{WAVE}}；轴 id={{AXIS_ID}}
  调研原始意图（逐字）：<intent.md 原文摘录>
  本轴对应意图子问句：{{INTENT_IDS}}（原文：<…>）
  范围边界：{{SCOPE}}
  可用外部链接（本部署无搜索引擎，只能抓这些）：{{URLS}}
  已确认事实与既有 claim：{{KNOWN_FACTS}}
  已证死方向（不要重走）：{{DEAD_ENDS}}
  你要写的文件路径：.omz/research/{{SLUG}}/{observation-manifest.md, claim-graph.md, cause-disappearance.md, raw/}
  起始 id：观察 {{OBS_NEXT_ID}}、claim {{CLAIM_NEXT_ID}}（**不得复用/重编号既有 id**）
```

## 派发前检查单（主 agent 自查）

- [ ] 每个 worker 只有**一条**轴；两条轴挤在一个 prompt = 拆开重派。
- [ ] id 起始值互不重叠（多 worker 并行写同一 manifest，id 撞车即数据损坏）——按 worker 顺序预分配区段，如 W2 三个轴分别从 `O-021` / `O-041` / `O-061` 起。
- [ ] `{{URLS}}` 已填（librarian 类轴尤其）；填不出就不要派该轴，先向用户索取入口。
- [ ] `{{DEAD_ENDS}}` 已从上一波 EXPAND 归并，避免重复劳动。
- [ ] `{{SCOPE}}` 是可判定的边界（目录/文件/URL），不是"相关的部分"。
- [ ] 回收时逐个校验：无 `## EXPAND` 尾巴 → 打回补齐（§4）；manifest 条目缺命令原文 → 该观察不计入证据。
