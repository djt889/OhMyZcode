---
name: ulw-research
description: "仅当用户显式要求调研/尽调/research,或主 agent 委派饱和调研时激活。普通问答与普通查文档(Librarian 单次可查清的)不得激活本协议。"
---

# ulw-research — 最大饱和度调研协议

目标：对一个主题做到**饱和**——直到新一波调查不再产生新线索才收敛。

## 0. 执行主体与工具面（先读这一节）

- **本协议的并行派发只能由主 agent 执行。**§3 scaling floor 的"并行 N 个 worker"、§8 的 visual-QA / proofread 委派，主体一律是主 agent。
- **你若是被委派的子代理**（工具面无 `Agent`，例如被派去查某一轴的 omz-librarian / omz-junior）：**只执行分给你的单轴调查**，按 §4 以 `## EXPAND` 收尾回报，观察写 observation-manifest 格式、claim 按 claim-graph 的状态枚举标注。需要再开新轴时写进 `LEAD`，由主 agent 决定是否派人，**你不自行派发**。
- 判断方法：检查自己的工具面有无 `Agent`。没有 = 叶节点。

## 0.1 检索纪律（本部署的实际工具面）

**本部署没有 `WebSearch`**（主 agent 也没有）。因此：

- 外部证据靠 **`WebFetch` 抓已知 URL**（官方文档、仓库页、release note、issue 链接）+ **`Bash` 本地取证**（`grep -rn` / `rg` / `git log` / `find` / 跑最小验证脚本）+ `Read`。
- **不要写"用搜索引擎 operator 轮换检索"的计划**，也不要假称做过关键词搜索——本部署做不到，那样的转述是伪证。
- 缺搜索入口时的正确动作：**向主 agent / 用户索取链接**（"请给 X 的官方文档 URL / 仓库地址 / 讨论帖链接"），并在 `intent-diff.md` 把该子问句标 `blocked: 需外部检索入口`。连续 3 波因此无新 lead 时按 §7 升格，不算收敛。
- `observation-manifest.md` 的 `operator` 字段只允许填本部署真实存在的取证手段：`Bash grep` | `Explore` | `codegraph_explore`（graph profile）| `WebFetch` | `Read` | `执行验证脚本`。

## 1. 激活与范围界定

- 覆盖 exploration-bounding 默认值：单主题代码库至少 3 路探索起步（见 scaling floor）。
- 先写 `.omz/research/<slug>/intent.md`：调研问题、受众、交付格式（报告/决策备忘录/代码证据包）、截止约束。

## 2. 5 个认识论文档（references/ 模板，调研全程维护）

| 文档 | 内容 |
|---|---|
| `intent-diff.md` | 用户原始意图 vs 实际调研覆盖面的差集；每波后更新 |
| `claim-graph.md` | 断言图谱：claim → 证据（来源/文件:行/实验）→ 状态（unverified / gated / refuted）|
| `observation-manifest.md` | 原始观察流水：谁在哪看到什么，带时间戳 |
| `verification-economics.md` | 验证经济学：每个 claim 的核实成本/收益，决定是否过门 |
| `cause-disappearance.md` | "消失的证据"记录：曾经出现后来查无的线索，防止静默丢失 |

**综合只可引用过了门的 verified-claims**——claim-graph 里状态不是 gated 的断言不得进入最终报告正文（可进附录"未证实线索"）。

## 3. Scaling floor（并行下限，**主 agent 派发**）

| 场景 | 并行 worker 下限 |
|---|---|
| 单主题代码库 | 3 explore |
| 多模块特性 | 5 |
| 外部技术尽调 | 4 librarian + 2 explore |
| 完整尽调 | 15 worker 混合编队 |

按 ZCode 短命 Agent 逐轴并行 spawn，不搞常驻编队（DESIGN §7.5.3）。每个 worker 一条轴、一份 `references/worker-prompt.md` 填实后的派发 prompt；**外部技术尽调轴在本部署无搜索引擎**（§0.1），librarian 轴必须带着具体 URL 清单派出，否则该轴退化为无效。

## 4. EXPAND 尾巴协议（强制）

每个 worker 的回复**必须**以 `## EXPAND` 收尾，列出：

```
## EXPAND
- LEAD: <值得继续追的线索>（可多条）
- DEAD END: <已证死的方向 + 一句死因>
```

缺 EXPAND 尾巴 = 回复不完整，打回补齐。这是递归扩展引擎。

**这条要求必须写进派发 prompt**——worker 在全新上下文里看不到本文件，不会自发加尾巴。派发一律用 `references/worker-prompt.md` 模板（其 MUST DO 已强制 EXPAND 收尾）。

## 5. Excursion 有界绕道

- **ENTER**（任一触发）：发现主线索的未预期分支 / 与现有 claim 冲突的证据 / 高信息量意外 / 用户新约束。
- **EXIT**（任一触发）：绕道产出了可归入主线的结论 / 深度达 3 层 / 预算超限 / 证死。
- 深度 3 层触发**升格**：向主 agent 汇报并请求是否继续。

## 6. claim 过门（gated 的门槛）

非代码 claim 至少满足其一 + counter-search 无反证：

- ≥2 个独立来源域
- ≥2 组独立观察收敛
- 一手来源（官方文档/源码/commit）
- 带时间的证据链

counter-search 在本部署的实做（无搜索引擎，§0.1）：抓该来源的**反面位置**——官方文档的 changelog / known issues / deprecation 段、仓库的 `issues?q=` 与 `CHANGELOG.md`、`git log --grep` 找相反改动。查询原文（URL 或命令）逐字记进 `claim-graph.md` 的 counter-search 字段；确实无法构造反证检索时字段填"无法检索：<缺什么入口>"，该 claim **不得 gated**。

代码 claim：**Phase 3 执行验证**——最小脚本实测，全输出留档，结论标 CONFIRMED / REFUTED / PARTIAL。

## 7. 收敛规则

满足任一即收敛：零未查 lead / 连续 3 波无新 lead / 达 5 波上限（问用户是否继续）。多面查询 ≥2 个扩展波后才允许收敛。

## 8. 交付双出 + 双 gate

- **双出**：主报告 + 证据附件（observation-manifest 全文 + `raw/` 目录）。
- **双 gate**：visual-QA 由 omz-looker 逐图判定（报告含图表时恒跑）；proofread 由 writing 类委派专职校对（错别字/引用断裂/格式一致性）。两者均**由主 agent 派发**。
- 报告每条事实性陈述带 [Source N] 或 file:line。

## 9. 格式产出（PDF + DOCX 工具链）

交付格式固定三层：**Markdown 是唯一事实源，PDF 与 DOCX 由它生成**。

### 9.1 Markdown（必产）

`.omz/research/<slug>/report.md`——先写完并自查（每条事实带 [Source N] / file:line，只引用 gated claim）再谈转换。

### 9.2 PDF（chrome headless 打印）

先 md → html，再打印：

```bash
pandoc .omz/research/<slug>/report.md -s --metadata title="<报告标题>" -o .omz/research/<slug>/report.html
"$CHROME" --headless --disable-gpu --print-to-pdf=".omz/research/<slug>/report.pdf" ".omz/research/<slug>/report.html"
```

Windows 上探测 chrome 可执行文件（逐条试，第一个存在的即用；把命中的路径记进 observation-manifest）：

```bash
ls "/c/Program Files/Google/Chrome/Application/chrome.exe"
ls "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
ls "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
ls "/c/Program Files/Microsoft/Edge/Application/msedge.exe"   # 同 Chromium 内核，--print-to-pdf 等价可用
where chrome; where msedge                                    # PATH 兜底
```

注意：`--print-to-pdf` 的路径参数在 Git Bash 下建议用**正斜杠相对路径**（B3）；`--headless` 需要 `--disable-gpu` 才在部分 Windows 环境稳定退出。

### 9.3 DOCX（pandoc）

```bash
pandoc .omz/research/<slug>/report.md -o .omz/research/<slug>/report.docx
pandoc --version    # 先确认可用；不可用直接进 9.4 回退
```

### 9.4 失败回退（**不得静默降级**）

任一环节不可用时：**交付 Markdown**，并在交付说明里显式写清三件事——

1. 缺哪个工具（`pandoc` 未安装 / 未探测到 Chromium 内核浏览器 / 转换命令非零退出）；
2. 失败命令原文 + 退出码 + 错误输出关键行；
3. 安装方式：`winget install --id JohnMacFarlane.Pandoc`（或 `choco install pandoc`，或 pandoc releases 页手动安装）；浏览器缺失则装 Chrome/Edge 后重跑 9.2。

**禁止**：只交 Markdown 却宣称"已按双格式交付"，或把转换失败写成"格式不重要故省略"。降级必须是被告知的降级。

### 9.5 命令转录进双证据

9.2 / 9.3 的每条命令（含 chrome 路径探测的命中结果、退出码、产物 `ls -l` 尺寸）**逐字转录进 `observation-manifest.md`**，与产物路径一起构成交付的第二重证据；只说"已生成 PDF"不算证据。

## references/

调研全程维护的 5 个认识论文档模板 + 1 个派发模板：

- `references/intent-diff.md` — 意图差集台账（每波后更新）
- `references/claim-graph.md` — 断言图谱与过门状态枚举
- `references/observation-manifest.md` — 观察流水与重放契约
- `references/verification-economics.md` — 验证成本/收益象限
- `references/cause-disappearance.md` — 消失证据登记
- `references/worker-prompt.md` — **单轴调查 worker 的 8 要素派发模板；主 agent 派任何调查轴之前必读并填实**（它承载 EXPAND 尾巴、observation-manifest 格式、claim 状态枚举三项强制要求）
