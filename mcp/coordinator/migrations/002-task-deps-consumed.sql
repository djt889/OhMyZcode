-- @skip-if-column task_deps.consumed
-- OMZ coordinator 迁移 002：task_deps 增加 consumed 列（依赖边的一次性消费标记）。
--
-- 为什么需要这一列：taskComplete 递减下游 deps_remaining 时，仅靠"任务是否终态"这一层守卫
-- 不足以杜绝重复递减（历史脏数据、手工 SQL、守卫被绕过都会导致下游在上游未全部完成时提前 ready，
-- 而且损坏后数据库自身是自洽的：deps_remaining=0 且 status=ready，事后无法从状态反推）。
-- 把"这条边是否已被兑付"落到边自身，递减就变成幂等的一次性消费。
--
-- 可重放性：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，无法在纯 SQL 里自守卫。
-- 因此本文件首行使用 db.mjs 支持的 `-- @skip-if-column <table>.<column>` 指令：
-- 该列已存在时整个文件被跳过（但仍登记为已应用），从而对任意状态的旧库都能安全重放。
--
-- 历史数据回填：已 done 的上游，其出边视为已消费——这是当时递减确实发生过的那批边。
-- 未 done 的上游其出边保持 consumed=0。这样回填后 verifyGraphInvariants 对既有库即刻自洽。

ALTER TABLE task_deps ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0;

UPDATE task_deps
   SET consumed = 1
 WHERE upstream IN (SELECT id FROM tasks WHERE status = 'done');

CREATE INDEX IF NOT EXISTS idx_task_deps_upstream ON task_deps(graph_id, upstream, consumed);
