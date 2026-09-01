---
description: "OMZ 自检：agent 可达性(spawn ping)、model 校验、gitignore、mtime(B19)、BOM 扫描(B4)"
---

# OMZ Doctor 自检

按顺序执行五项检查，任何一项失败都要给出**可执行修复指令**（不是笼统报错）。

## ① Agent 可达性（spawn ping × 9）

逐个后台 spawn 以下子代理，prompt 只有一句探针暗语：`OMZ-PING`，各自应回复 `OMZ-PONG <agent-name>` 外加一行"可见 skills 数量"：

- omz-planner / omz-critic / omz-deep / omz-junior / omz-atlas / omz-oracle / omz-reviewer / omz-librarian / omz-looker

- 任一报 not found → 提示：**agent 清单是会话启动快照（B19）**，安装/更新后请新开会话再测。
- 顺带核对：只读角色（critic/oracle/reviewer/librarian/looker）不应有 Edit/Write——可让它们尝试调用一次 Edit，应被结构性拒绝（B1 白名单生效证据）。

## ② Model 校验

对每个 agent 的 frontmatter `model` 字段：与 `~/.zcode/v2/config.json` 已登记供应商模型清单比对。未填写 = 继承主会话（合法）；填了但不在清单 = 列差异并给修正。`thoughtLevel` 枚举（off/low/medium/high/max）越界同样列出。

## ③ .gitignore 检查

当前项目根的 `.gitignore` 必须含 `.omz/` 条目；**缺失只报告不代改**——输出可执行修复命令 `printf '.omz/\n' >> .gitignore` 让用户或主 agent 自行执行（B14）。（注：`/ulw` 第一步会自动追加，doctor 只做常态体检。）

## ④ mtime vs 会话启动（B19）

扫描 `agents/omz-*.md` 的 mtime：晚于本会话启动时间的列出，提示"文件已就位但本会话不可见，请新开会话"。

**注意你拿不到会话启动时间**：`<env>` 块里没有它，Bash 的 env 里也没有会话级时间戳，**不要凭感觉编一个基准时刻**。判定基准只有两条合法途径：① 直接跑 `node tools/doctor.mjs`，由它用自己进程的 `Date.now() - process.uptime()*1000` 作近似基准（当前实现即此）；② 用会话内第一条可核实的时间证据（例如本会话最早一次命令转录里的时间戳）作下界。两条都不可得时本项报 `SKIP` 并说明原因，不得报 OK——无基准的"均早于会话启动"是假绿。

## ⑤ BOM / 路径扫描（B4/B3）

扫描 `.omz/` 下所有 `.json`：含 UTF-8 BOM → **列出文件清单并给出 strip 命令**（用 node 重写：`node -e "..."`，禁用 PowerShell Set-Content 写状态文件）；含反斜杠绝对路径值 → 列出并给出改正斜杠相对路径的修复指引。**本项只报告不改文件**。

## 修改边界（与实现一致）

本命令与 `tools/doctor.mjs` 一样是**只报告的体检器**：五项检查都不写入、不修复任何文件，每个 FAIL 必须附带一条用户可直接复制执行的修复命令。想让 doctor 自动修，是另一个需求，不要在体检期间偷偷动手。

## 汇总输出

```
① agents: 9/9 OK | ② model: OK(或 N 处差异) | ③ gitignore: OK | ④ mtime: OK | ⑤ BOM: OK
```

任何 FAIL 行必须附带单项修复命令。离线等价检查可跑 `node tools/doctor.mjs`（① 的 spawn 部分只能在会话内做）。
