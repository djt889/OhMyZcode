/**
 * adapters/zcode/path.mjs
 * Windows/Git Bash 路径与 JSON 编码卫生层（DESIGN B3 路径分隔符撕裂 / B4 BOM-CRLF 损坏）。
 * 协议纪律：.omz/ 下的状态文件一律「UTF-8 无 BOM + LF + 正斜杠相对路径」，
 * 本模块是唯一被允许直接读写这些 JSON 的入口，其它模块不得自己 JSON.parse/writeFileSync。
 *
 * 【设计取舍 1 · 路径归一必须字段白名单驱动，禁止全量深度遍历】
 * 早期实现对整个 registry 递归跑 normalizePathValue，会把非路径字符串一并改坏：
 *   'regex \d+ and \w+'   → 'regex /d+ and /w+'     （正则被破坏）
 *   'text with \n escape' → 'text with /n escape'   （转义序列被破坏）
 * 而 transport.saveRegistry 落盘前对**整个** registry 调用它，于是 result 摘要、错误消息、
 * prompt 原文都可能被污染——状态文件是跨会话唯一事实源，污染后无法复原。
 * 因此归一只对 PATH_FIELD_NAMES 里登记过的字段生效，数组元素继承父键名的判定。
 * ⚠️ 新增任何存路径的字段时，必须同时登记进 PATH_FIELD_NAMES，否则该字段不会被归一（B3 复发）。
 * 白名单键的值若是**对象**，其内层键各自重新判定（不继承），只有数组继承父键。
 *
 * 判定条件只有一个：**当前键名在白名单里**，与它嵌套多深、父键叫什么全无关系。
 * 即 `agents.<agent_ref>.result_ref`（transport registry 的形态）会被命中，尽管 `agents`
 * 与 `<agent_ref>` 都不在白名单——因为 walk 对每个对象键都重算 set.has(k)，从不把父键的
 * 判定结果传下去。反过来，`agents.<agent_ref>.note` 永远不会被动到。
 * 别把这里改成「父键命中则整棵子树归一」：那会让 note/msg/error 这类同层兄弟字段一起被改坏。
 *
 * 【设计取舍 2 · 越界路径宁可原样保留，也不写一个假的相对路径】
 * toPosixRelative 对跨卷（C: vs E:）与越界（结果以 .. 开头）不再静默返回相对路径：
 * 默认 onEscape:'marker' 返回可被 isEscapingPath() 判定出来的形式，normalizePathValue 在越界时
 * 原样保留输入，让 /omz-doctor 能报警——而不是把一个看起来合法、实际指向别处的相对路径写进状态文件。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 反斜杠路径片段：`src\main.rs`、`E:\a\b`、`..\x` 等；单独的 JSON 转义残留不在此列 */
const BACKSLASH_SEGMENT = /(?:^|[^\\])\\(?![\\/])[^\\/\s"']/;
/** Win32 设备/长路径命名空间：`\\?\C:\x`、`\\.\pipe\x`（也匹配已被改坏的 `//?/C:/x`） */
const DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;
/** UNC：`\\server\share`（必须在 DEVICE_PREFIX 之后判定，否则 `\\.\` 会被误判成 UNC） */
const UNC_PREFIX = /^\\\\[^\\/?*:|"<>]+[\\/]/;
/** 盘符绝对路径：`E:\x`、`E:/x` */
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;

/** 默认路径字段白名单（供 doctor/测试引用；新增路径字段必须登记到这里） */
export const PATH_FIELD_NAMES = Object.freeze([
  'result_ref',
  'result_file',
  'changed_files',
  'worktree_path',
  'path',
  'file',
  'files',
  'plan',
  'active_plan',
  'goal_file',
  'artifact',
  'artifacts',
  'cwd',
  'root',
  'dir'
]);

const PATH_FIELD_SET = new Set(PATH_FIELD_NAMES);

/** 目录扫描护栏默认值：极深目录树与超大 .omz/ 都不得让 doctor 崩掉或跑飞 */
export const JSON_SCAN_DEFAULTS = Object.freeze({ maxDepth: 32, maxFiles: 5000 });

function errText(err) {
  return String(err && err.message ? err.message : err);
}

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
export function readJsonSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'missing' : 'io';
    return { ok: false, error: errText(err), reason };
  }
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  try {
    return { ok: true, value: JSON.parse(stripBom(raw)) };
  } catch (err) {
    // 已 stripBom 仍失败 => 内容本身坏；区分两者便于 doctor 给不同修复指令
    return { ok: false, error: errText(err), reason: hadBom ? 'bom-parse' : 'parse' };
  }
}

export function writeJsonSafe(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(value, null, 2).replace(/\r\n/g, '\n') + '\n';
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8' });
    fs.renameSync(tmp, file); // 同目录 rename 才有原子语义
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
  return { ok: true, file };
}

export function isWindowsAbsolutePath(value) {
  if (typeof value !== 'string') return false;
  // 设备/长路径命名空间（\\?\C:\x、\\.\pipe\x）也是绝对路径，漏判会被当相对路径降级成 //?/C:/x
  return DRIVE_ABS.test(value) || DEVICE_PREFIX.test(value) || UNC_PREFIX.test(value);
}

export function hasBackslashPath(value) {
  if (typeof value !== 'string') return false;
  if (isWindowsAbsolutePath(value)) return value.includes('\\');
  return BACKSLASH_SEGMENT.test(value);
}

function toPosix(value) {
  return value.split('\\').join('/');
}

/** 取盘符（大写）用于跨卷判定；无盘符（UNC/设备/posix）返回 null */
function volumeOf(value) {
  const m = /^([A-Za-z]):/.exec(toPosix(String(value ?? '')).replace(DEVICE_PREFIX, ''));
  return m ? m[1].toUpperCase() : null;
}

/** 越界标记：以 ../ 开头的相对路径，或仍为绝对形态的 posix 串（跨卷/UNC/设备） */
export function isEscapingPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  // 先统一分隔符再判定：`..\x` 与 `../x` 是同一件事，只因分隔符不同就漏判会让 Windows 形态的
  // 越界路径被当成安全相对路径写进状态文件（normalizePathValue 的兜底判据就是本函数）。
  const p = toPosix(value);
  if (p === '..' || p.startsWith('../')) return true;
  return DRIVE_ABS.test(p) || /^\/{2}/.test(p) || DEVICE_PREFIX.test(p);
}

/**
 * 归一为相对 root 的正斜杠路径。
 * onEscape 控制「跨卷 / 结果越出 root」时的行为：
 *  - 'marker'（默认）：返回原样 posix 绝对路径，可由 isEscapingPath() 判定 —— 宁可留下能被 doctor
 *    报警的绝对路径，也不返回一个看起来合法、实际指向别处的相对路径
 *  - 'return'：返回相对路径（旧行为，含 ../ 前缀）
 *  - 'throw'：抛错，交由调用方处理
 */
export function toPosixRelative(target, root, { onEscape = 'marker' } = {}) {
  if (typeof target !== 'string' || target === '') return target;
  const abs = isWindowsAbsolutePath(target) || path.isAbsolute(target) || path.posix.isAbsolute(target);
  if (!abs) return toPosix(target).split(path.sep).join('/');

  const nativeTarget = target.split('/').join(path.sep);
  const crossVolume = Boolean(volumeOf(target) && volumeOf(root) && volumeOf(target) !== volumeOf(root));
  const device = DEVICE_PREFIX.test(target);
  const rel = toPosix(path.relative(root, nativeTarget));
  const escaping = crossVolume || device || rel === '..' || rel.startsWith('../') || DRIVE_ABS.test(rel) || rel.startsWith('//');

  if (!escaping) return rel;
  if (onEscape === 'return') return rel;
  if (onEscape === 'throw') {
    throw new Error(`toPosixRelative: 路径越出 root（${crossVolume ? '跨卷' : device ? '设备命名空间' : '越界'}）：${target} vs ${root}`);
  }
  return toPosix(target); // marker：保留绝对形态，isEscapingPath() 可判定
}

/**
 * classifyPath：让调用方显式处理各类路径，而不是靠猜。
 * kind: 'posix-relative' | 'windows-absolute' | 'unc' | 'device' | 'escaping' | 'cross-volume' | 'plain-text'
 * 注意：`src\main.rs` 与 `regex \d+` 在字符串层面同构，无法完全区分——这里的启发式是「含空白字符
 * 且非绝对路径 => plain-text」。真正可靠的判定靠调用点的字段名（见 PATH_FIELD_NAMES）。
 */
export function classifyPath(value, root) {
  if (typeof value !== 'string' || value === '') return { kind: 'plain-text', normalized: value };
  if (DEVICE_PREFIX.test(value)) return { kind: 'device', normalized: toPosix(value) };
  if (UNC_PREFIX.test(value) || /^\/{2}[^/?.]/.test(value)) return { kind: 'unc', normalized: toPosix(value) };
  if (DRIVE_ABS.test(value)) {
    if (volumeOf(value) && volumeOf(root) && volumeOf(value) !== volumeOf(root)) {
      return { kind: 'cross-volume', normalized: toPosix(value) };
    }
    const rel = toPosixRelative(value, root, { onEscape: 'return' });
    return isEscapingPath(rel)
      ? { kind: 'escaping', normalized: toPosix(value) }
      : { kind: 'windows-absolute', normalized: rel };
  }
  if (value === '..' || value.startsWith('../') || value.startsWith('..\\')) {
    return { kind: 'escaping', normalized: toPosix(value) };
  }
  if (path.posix.isAbsolute(value)) return { kind: 'escaping', normalized: value };
  if (/\s/.test(value)) return { kind: 'plain-text', normalized: value }; // 正则/散文/错误消息
  if (hasBackslashPath(value)) return { kind: 'posix-relative', normalized: toPosix(value) };
  if (value.includes('/')) return { kind: 'posix-relative', normalized: value };
  return { kind: 'plain-text', normalized: value };
}

export function normalizePathValue(value, root) {
  if (typeof value !== 'string' || value === '') return value;
  if (!isWindowsAbsolutePath(value) && !hasBackslashPath(value)) return value;
  const out = toPosixRelative(value.split('\\').join(path.sep), root);
  // 越界（跨卷/逃出 root/设备命名空间）时保留原值：假相对路径比可报警的绝对路径更危险
  return isEscapingPath(out) ? value : out;
}

/**
 * 只对 fields 里登记的字段做路径归一；数组元素继承父键名的判定。
 * 见文件头「设计取舍 1」：不能全量遍历，否则正则/转义序列/错误消息会被改坏。
 */
export function normalizePathFields(obj, root, { fields = PATH_FIELD_NAMES } = {}) {
  const set = fields instanceof Set ? fields : new Set(fields);
  const walk = (node, inherited) => {
    if (typeof node === 'string') return inherited ? normalizePathValue(node, root) : node;
    if (Array.isArray(node)) return node.map((v) => walk(v, inherited));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, set.has(k));
      return out;
    }
    return node;
  };
  return walk(obj, false);
}

/** 保留签名以兼容调用方；语义已改为白名单驱动（非全量深度遍历） */
export function deepNormalizePaths(obj, root) {
  return normalizePathFields(obj, root);
}

/**
 * 收集 .json 文件；带深度与数量上限，并把不可读目录显式记入 skipped（不再无声跳过——
 * 否则 doctor 会报「无 BOM/损坏」而实际上根本没扫到）。
 */
function walkJsonFiles(dir, { maxDepth, maxFiles }) {
  const acc = { files: [], skipped: [], truncated: false, truncateReasons: [] };
  const visit = (cur, depth) => {
    if (depth > maxDepth) {
      acc.truncated = true;
      acc.truncateReasons.push(`目录深度超过上限 ${maxDepth}：${cur}`);
      acc.skipped.push({ dir: cur, reason: `depth>${maxDepth}` });
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      acc.skipped.push({ dir: cur, reason: errText(err) });
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
        if (acc.files.length >= maxFiles) {
          acc.truncated = true;
          if (!acc.truncateReasons.some((r) => r.startsWith('文件数'))) acc.truncateReasons.push(`文件数超过上限 ${maxFiles}`);
          continue;
        }
        acc.files.push(full);
      }
    }
  };
  visit(dir, 0);
  return acc;
}

function collectBackslash(node, keyPath, file, out) {
  if (typeof node === 'string') {
    if (hasBackslashPath(node)) out.push({ file, keyPath, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectBackslash(v, keyPath ? `${keyPath}.${i}` : String(i), file, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectBackslash(v, keyPath ? `${keyPath}.${k}` : k, file, out);
  }
}

export function scanJsonHygiene(dir, { maxDepth = JSON_SCAN_DEFAULTS.maxDepth, maxFiles = JSON_SCAN_DEFAULTS.maxFiles } = {}) {
  const result = { scanned: 0, bom: [], backslash: [], corrupt: [], skipped: [], truncated: false, truncateReasons: [] };
  if (!dir || !fs.existsSync(dir)) return result;
  const walked = walkJsonFiles(dir, { maxDepth, maxFiles });
  result.skipped = walked.skipped;
  result.truncated = walked.truncated;
  result.truncateReasons = walked.truncateReasons;
  for (const file of walked.files) {
    result.scanned += 1;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      result.corrupt.push({ file, error: errText(err) });
      continue;
    }
    if (raw.charCodeAt(0) === 0xfeff) result.bom.push(file);
    let value;
    try {
      value = JSON.parse(stripBom(raw));
    } catch (err) {
      result.corrupt.push({ file, error: errText(err) });
      continue;
    }
    collectBackslash(value, '', file, result.backslash);
  }
  return result;
}
