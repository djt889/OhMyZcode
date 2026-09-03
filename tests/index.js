/**
 * tests/index.js —— 目录入口聚合器。
 *
 * 为什么需要它：Node 22 起 `node --test <arg>` 的位置参数是 **glob 模式**（不是目录路径），
 * `tests/` 只 glob 到目录本身，运行器随后按模块解析它 → MODULE_NOT_FOUND。
 * 本文件是 `tests/` 的 CommonJS 目录入口（index.js），使 `node --test tests/`（以及
 * package.json 的 `npm test`）能把整套用例作为一个测试文件加载执行。
 *
 * 命名刻意不带 `.test.mjs`：它不匹配 `node --test` 的默认模式，也不匹配
 * `tests/*.test.mjs`，因此以下三种调用都不会重复执行同一批用例：
 *   node --test                      （默认模式逐个文件、进程隔离）
 *   node --test "tests/*.test.mjs"   （显式 glob、进程隔离）
 *   node --test tests/               （本文件聚合、单进程）
 *
 * 新增测试文件时必须在此登记，否则 `npm test` 会漏跑。
 */
import './path.test.mjs';
import './fallback.test.mjs';
import './capability.test.mjs';
import './boulder.test.mjs';
import './transport.test.mjs';
import './coordinator.test.mjs';
import './server-mcp.test.mjs';
import './dashboard.test.mjs';
import './hooks.test.mjs';
import './protocol.test.mjs';
import './render-status.test.mjs';
import './cli.test.mjs';
import './integration.test.mjs';
