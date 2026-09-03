# full-workflow — 从意图到批准门的完整示例

## 场景

用户："给我们的 CLI 加一个 `--watch` 模式，文件变了自动重跑上一条命令。"

## 1. 意图路由

- 目标可推？否——"上一条命令"指什么（shell 历史？上次执行的构建脚本？），UNCLEAR。
- 约束可推？部分——需确认是否守护常驻、失败行为。
- 验收可推？部分——可写终验但依赖前两项。

## 2. 探索先行（自己取证）

用 `Bash` + `Read` 自己查：`grep -rn "commander\|yargs\|process.argv" src/` 找 CLI 入口解析处、`grep -rn "spawn\|execa" src/` 找命令执行管线、`Read package.json` 看是否已有 watch 依赖（chokidar / fs.watch 封装）。产出证据清单 file:line。

你没有 Agent 工具，**派不了 Explore 并行扫库**。若单轴 grep 覆盖不够（例如需要同时扫 3 个包的入口约定），把缺口写进草稿：

```markdown
## 待主 agent 代派
- REQUEST-1｜类型：Explore 广度扫描
  - 要回答的问题：monorepo 三个包各自的 CLI 入口与命令执行管线在哪
  - 建议范围/入口：packages/*/src/cli*、packages/*/bin
  - 拿到结果后计划会怎么变：Wave 1 的任务 2（watcher 接入点）才能确定落点文件
```

## 3. 两道过滤器

- Q"'上一条命令'指什么"：证据答不了 → 无行业默认 → **必问**（且接近 owner-decision：影响 UX 定义）。
- Q"是否引入 chokidar"：有默认（已有依赖里有则复用；无则评估引入，属新增依赖 → owner-decision，问）。

## 4. 草稿 → 评审 → 定稿

- 草稿 `.omz/drafts/<stem>-add-watch-mode.md`（`<stem>` 取派发 CONTEXT 给的值，如 `sess_c99601d3`）：登记已确认决策、已采纳默认值、"待主 agent 代派"段。
- 草稿写好后**交还主 agent**，请求它派 omz-critic 做差距分析（你不能自己派）。
- critic 差距分析（由主 agent 派发，结论回传给你）：发现"未覆盖终端 resize / 长任务中断"两条 major → 你把它们补进 Wave 2。
- 用户批准 → 写 `.omz/plans/<stem>-add-watch-mode.md`（stem 与草稿一致）。

## 5. 计划节选（机器契约示例）

```markdown
## Wave 1
- [ ] 1. 命令历史缓冲模块（环形 50 条）
  Recommended task executor category: unspecified-low
- [ ] 2. fs watcher 接入（复用现有依赖）
  Recommended task executor category: deep

## Wave 2
- [ ] 3. 中断/resize 行为
  Recommended task executor category: deep

## Final verification
- [ ] F1. `printf x > f` 触发自动重跑的集成测试通过（测试 ID: watch.integration）
- [ ] F2. Ctrl-C 后 watcher 进程完全退出（`ps` 无残留，留清理收据）
```

## 6. 批准门

呈现计划摘要 → 等批准 → 本 skill 终止（执行归 /ulw）。
