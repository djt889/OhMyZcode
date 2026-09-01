-- OMZ coordinator 迁移 003：补建 task_deps 的 complete 热路径索引，并补跑 consumed 回填。
--
-- 为什么必须是独立的新文件：002 首行的 `-- @skip-if-column task_deps.consumed` 是**文件级**守卫。
-- 对"列已存在但 002 未登记"的库（典型来源：有人手工 `ALTER TABLE task_deps ADD COLUMN consumed`），
-- 002 整个文件体被跳过并登记为已应用，于是其中两条**本来幂等、本来必须跑**的语句被连坐跳过：
--   * `CREATE INDEX IF NOT EXISTS idx_task_deps_upstream` 永远不会执行 → taskComplete 的下游递减
--     （`WHERE graph_id = ? AND upstream = ? AND consumed = 0`）退化为全表扫描，写锁被拉长，
--     且不会有任何告警——库自身是自洽的，只是慢。
--   * 历史回填 `UPDATE ... SET consumed = 1 WHERE upstream 已 done` 不会执行 → 已 done 的上游其出边
--     仍是 consumed=0，verifyGraphInvariants 会报 edge-unconsumed-but-upstream-done。
-- 而"已发布的迁移文件永不修改"（001 头部纪律）+ "已登记的迁移不再重放"（db.mjs runMigrations）
-- 意味着改 002 既违纪也无效：对已经把 002 登记为已应用的库，修改后的 002 永远不会再跑。
-- 修复只能落在一个新文件里，这就是本文件存在的唯一理由。
--
-- 本文件刻意**不带任何守卫**：两条语句天然幂等——`CREATE INDEX IF NOT EXISTS` 是 SQLite 原生幂等；
-- UPDATE 是向不变量收敛的赋值（重复执行命中 0 行）。因此它对任意状态的旧库都能安全重放，
-- 不需要执行器特例，也不会再触发同类连坐。

CREATE INDEX IF NOT EXISTS idx_task_deps_upstream ON task_deps(graph_id, upstream, consumed);

-- 与 002 的回填同义：已 done 的上游，其出边视为已消费（当时递减确实发生过的那批边）。
-- 多一个 `consumed = 0` 条件只为把重放的写放大压到 0 行，语义与 002 完全一致。
UPDATE task_deps
   SET consumed = 1
 WHERE consumed = 0
   AND upstream IN (SELECT id FROM tasks WHERE status = 'done');
