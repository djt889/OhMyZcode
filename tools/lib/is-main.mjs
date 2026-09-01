/**
 * tools/lib/is-main.mjs
 * 「本模块是否被当作入口脚本直接执行」的唯一判定实现。
 *
 * 为什么要有这个文件：早期各处自己写
 *   path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
 * URL.pathname 是 **percent-encoded** 的——插件目录一旦含空格或非 ASCII
 * （Windows 极常见：`C:\Program Files\…`、`C:\Users\张三\…`），`%20` / `%E5%BC%A0`
 * 与 process.argv[1] 的真实路径永不相等，isMain 恒为 false。后果是 CLI 静默 exit 0
 * 什么都不做、hook 输出 0 字节（违反 fail-open 契约），而且退出码为 0，人和 CI 都看不出坏了。
 * 正确做法只有 fileURLToPath()：它负责解码并处理 Windows 盘符。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** file:// URL → 本地绝对路径（percent-decode + Windows 盘符处理） */
export function modulePath(importMetaUrl) {
  return fileURLToPath(importMetaUrl);
}

/** 该模块所在目录的本地绝对路径 */
export function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * 传入调用方的 import.meta.url，返回该模块是否为进程入口。
 * 被 import 时返回 false；`node path/to/mod.mjs` 直接跑时返回 true。
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  let self;
  try {
    self = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
  return path.resolve(process.argv[1]) === path.resolve(self);
}
