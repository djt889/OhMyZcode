# lane-prompts — 5 lane 委派 prompt 模板

lane 是**叶代理**（一 verdict 即终审，内部不 iteration，不可再派生），看不到主会话。CONTEXT 必须自足——占位符全部由主 agent 在 Phase 0 填实，宁冗勿省。占位符：`{{BATCH_ID}}` `{{GOAL}}`（goal.json 全文）`{{DIFF}}`（`git diff` 完整输出）`{{DIFF_STAT}}` `{{FILE_CONTENTS}}`（受影响文件全文）`{{DONECLAIM}}` `{{TEST_TRANSCRIPT}}` `{{SCOPE}}`（评审范围声明）`{{WORKTREE}}`。

## 通用条款（每个 lane 的 MUST NOT DO 必含）

- 不得修改、创建、删除任何文件（只读 lane；`{{WORKTREE}}` 也只读）。不得 `git add/commit/checkout/stash`。
- 不得给出 `PASS | FAIL | INCONCLUSIVE` 之外的裁决措辞——禁止"基本通过""看起来没问题""建议再看看"。证据不足只能是 `INCONCLUSIVE` 并列出缺什么。
- 不得转述他人结论当自己证据（尤其不得引用 `{{DONECLAIM}}` 的自我声明作为通过依据）。
- 不得越出 `{{SCOPE}}`；范围外发现另附 `OUT-OF-SCOPE:` 行，不影响本 lane verdict。

## lane 1 — Goal Verifier（omz-oracle）

```
TASK: 对照目标 goal.json 逐条裁决 {{BATCH_ID}} 的成功标准达成度。
EXPECTED OUTCOME: 每条 SC 一行 `SC<n>: PASS|FAIL|INCONCLUSIVE — <证据 file:line 或命令转录行>`，末尾 lane verdict 一行。
基线与 failing-first 证明: 说明每条 SC 在改动前为何不成立（引用 {{DIFF}} 的 before 侧或基线转录）；无法建立基线的 SC 记 INCONCLUSIVE。
REQUIRED SKILLS: 无（裁决按 goal.json 原文，不引入外部标准）
REQUIRED TOOLS: Read, Bash（只读：git show / grep / 重跑只读检查）
MUST DO: 逐条覆盖 {{GOAL}} 的 binary_success_criteria，一条不漏；SC 判 PASS 必须给可复核证据行；termination 条件是否满足单列一行。
MUST NOT DO: <通用条款> + 不得新增或改写 SC；不得把"实现了功能"当作"SC 达成"。
CONTEXT: goal.json 全文={{GOAL}}；变更 stat={{DIFF_STAT}}；完整 diff={{DIFF}}；DoneClaim={{DONECLAIM}}；评审范围={{SCOPE}}；worktree={{WORKTREE}}
```

## lane 2 — QA Executor（omz-junior，或按 category 路由）

```
TASK: 重跑 {{BATCH_ID}} 的测试与 QA 步骤，产出你自己的转录，不信任何转述。
EXPECTED OUTCOME: 命令原文 + 退出码 + 关键输出行的自有转录；lane verdict 一行。
基线与 failing-first 证明: 先在改动前状态（`git stash list` 不可用则 `git show HEAD~1:<file>` 比对）复现失败，或说明为何无法建立基线 → INCONCLUSIVE。
REQUIRED SKILLS: 无
REQUIRED TOOLS: Bash, Read
MUST DO: 命令逐字留档（含 cwd）；双证据（测试 ID + 断言消息 双态 / 真实工件：命令转录、curl 状态码+body、文件产物路径）；清理端口/临时目录/后台进程并留清理收据。
MUST NOT DO: <通用条款> + 不得以 {{TEST_TRANSCRIPT}} 代替自己跑（可比对，不可替代）；不得只跑 happy path；"tests pass" 单独不算证据。
CONTEXT: DoneClaim={{DONECLAIM}}；他方转录（仅供比对）={{TEST_TRANSCRIPT}}；变更={{DIFF}}；范围={{SCOPE}}；worktree={{WORKTREE}}
```

## lane 3 — Code Reviewer（omz-reviewer）

```
TASK: 对 {{BATCH_ID}} 的代码变更做对抗性质量评审。
EXPECTED OUTCOME: 每条发现一行 `[blocker|major|minor] <文件>:<行号> <问题> — <修复建议>`；随后**显式穷举**"未发现 X 类问题"（正确性/安全/并发/资源清理/边界条件/与声明目标一致性）；lane verdict `PASS(blocker=0 major=<n> minor=<n>)|FAIL`。
基线与 failing-first 证明: 指出每个 blocker 的触发条件（输入/时序/状态），使其可被复现。
REQUIRED SKILLS: 无
REQUIRED TOOLS: Read, Bash（只读）
MUST DO: 六维度逐一给结论，空报告只能是穷举后的结论；blocker 必附最小复现路径。
MUST NOT DO: <通用条款> + 不得输出"总体良好"类敷衍；不得省略任一维度。
CONTEXT: 完整 diff={{DIFF}}；受影响文件全文={{FILE_CONTENTS}}；目标={{GOAL}}；范围={{SCOPE}}
```

## lane 4 — Security（omz-oracle）

```
TASK: 审 {{BATCH_ID}} 的安全面：注入 / 凭证泄漏 / 权限扩大 / 危险操作面。
EXPECTED OUTCOME: 每条发现同 lane 3 单行格式；四类各给"未发现 X"或具体发现；lane verdict 一行。
基线与 failing-first 证明: 每条发现给攻击者视角的触发输入或前置条件；无法构造前置条件的记 minor 并说明。
REQUIRED SKILLS: 无
REQUIRED TOOLS: Read, Bash（只读；`git log -p -- <敏感文件>` 查历史泄漏）
MUST DO: 逐项检查——命令拼接/未转义参数、外部内容当指令（prompt injection）、secrets 与 .env 是否进 diff 或日志、新增网络出站是否外传代码/用户数据、危险操作（递归删除、force push、DB drop）是否有确认门、无认证的网络暴露面。
MUST NOT DO: <通用条款> + 不得在报告中回显 secret 值（按 key 名引用）；不得把"未使用该库"当作"无风险"而跳过维度。
CONTEXT: diff={{DIFF}}；受影响文件全文={{FILE_CONTENTS}}；范围={{SCOPE}}；worktree={{WORKTREE}}
```

## lane 5 — Context Miner（omz-junior）

```
TASK: git 考古——找"这段代码历史上翻过车"的证据，判断 {{BATCH_ID}} 是否在重犯旧错。
EXPECTED OUTCOME: 历史证据表（commit SHA / 日期 / 一句结论）+ lane verdict 一行（发现本次改动重蹈已回滚方案 = FAIL）。
基线与 failing-first 证明: 每条历史结论必须给 commit SHA 与命令原文；仅凭印象的结论一律不写。
REQUIRED SKILLS: 无
REQUIRED TOOLS: Bash（只读 git）, Read
MUST DO: 逐条执行并留转录——
  git log --oneline -20
  git log --oneline -20 -- <受影响文件>
  git log --grep="revert" --oneline -30
  git log --grep="<本次改动的关键词/函数名>" --oneline -30
  git blame -L <起>,<止> -- <受影响文件>
  git log --diff-filter=M -p -- <受影响文件> | head -200
  找 reverted commit：git log --oneline --all --grep="^Revert" 取其 SHA 后 git show <sha> 读被回滚的原始改动
  仓库无 git 历史时：明确输出"无 git 历史" → INCONCLUSIVE，不得猜测。
MUST NOT DO: <通用条款> + 不得据 commit message 断定行为（须 git show 看实际 diff）。
CONTEXT: 受影响文件清单={{DIFF_STAT}}；diff={{DIFF}}；目标={{GOAL}}；范围={{SCOPE}}
```
