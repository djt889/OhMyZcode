/**
 * adapters/zcode/capability.mjs
 * 运行时能力探测（DESIGN §13.5 I2：MCP 外部依赖启动失败不得阻塞主流程）。
 * 铁律：本模块所有导出**自身永不抛**——探测失败一律降级为 { available: false, error }，
 * 由调用方（fallback.resolveProfiles / doctor）决定关闭哪个 profile。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const MIN_MAJOR = 22;
// 22.13.0 是 `node:sqlite` **默认可用**的第一个版本：22.5–22.12 上该模块在
// `--experimental-sqlite` flag 之后（引擎 pre_execution 里未开 flag 即不注册内置模块），
// 直接 import 会抛 ERR_UNKNOWN_BUILTIN_MODULE，coordinator 与 dashboard 启动即崩栈退出。
// 官方 doc/api/sqlite.md 的 history 表："v22.13.0 — SQLite is no longer behind
// `--experimental-sqlite`"。故门槛写 13 而不是 5，宁可在探测层判不满足，也不要让用户装了
// 22.5 之后只有 core 能用、orchestration/dashboard 崩在启动阶段。
const MIN_MINOR = 13;

function errText(err) {
  return String(err && err.message ? err.message : err);
}

export function probeNode() {
  const version = process.versions.node;
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
  return { version, major, minor, ok };
}

export async function probeSqlite() {
  try {
    await import('node:sqlite');
    return { available: true, error: null };
  } catch (err) {
    return { available: false, error: errText(err) };
  }
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows 上要尝试的名字列表。
 * 【关键】不含「裸名」候选：Windows 的 CreateProcess 只能执行 PATHEXT 里登记的后缀，
 * npm 系分发在 PATH 里同时放了无后缀的 shell 脚本（`npm`，给 Git Bash 用）和 `npm.cmd`。
 * 若把裸名当候选，existsSync('.../npm') 会命中那个 shell 脚本，spawnSync 再报 ENOENT ——
 * 这正是「npm 明明装了却永远探测不到」的根因。所以无后缀命令一律只按 PATHEXT 拼后缀。
 */
function windowsCandidates(cmd) {
  if (/\.[A-Za-z0-9]+$/.test(cmd)) return [cmd]; // 已带后缀，按原名执行
  const pathext = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD');
  return pathext
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => cmd + e.toLowerCase());
}

/** .cmd/.bat 需要 cmd.exe 解释；.exe/.com 直接 spawn */
function needsCmdExe(name) {
  return /\.(cmd|bat)$/i.test(name);
}

/**
 * 在 PATH 里按 PATHEXT 逐个后缀找出真实存在的可执行文件名（每个目录内按后缀优先级，贴合
 * Windows 自身的查找顺序）。
 * 不靠解析 stderr 判断「命令不存在」—— cmd.exe 的「不是内部或外部命令」在中文 Windows 上是
 * GBK 输出，用 encoding:'utf8' 读会变乱码，文本匹配不可靠；文件系统探测是确定性的。
 * 返回**基名**（如 codegraph.cmd）而非全路径：交给 cmd.exe 走 PATH 解析，避免全路径含空格时
 * cmd.exe /c 的引号剥离规则带来歧义（`C:\Program Files\` 极常见）。
 */
function resolveOnWindowsPath(cmd) {
  const candidates = windowsCandidates(cmd);
  if (cmd.includes('/') || cmd.includes('\\')) {
    for (const cand of candidates) if (fs.existsSync(cand)) return cand;
    return null;
  }
  const dirs = String(process.env.PATH || process.env.Path || '')
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const cand of candidates) {
      try {
        if (fs.existsSync(path.join(dir, cand))) return cand;
      } catch {
        /* 单个 PATH 条目不可访问不影响其余 */
      }
    }
  }
  return null;
}

function runOnce(name, args, opts) {
  // 【安全】.cmd/.bat 用 spawnSync 直接执行会被 Node 的安全策略拒绝（EINVAL），必须经 cmd.exe /c。
  // 关键点：命令名与每个 arg 都作为**独立数组元素**传给 cmd.exe，shell 仍为 false ——
  // Node 不会把 args 拼成一条命令行交给 shell 解析，因此用户输入不参与 shell 语法解析，
  // 与 shell:true 有本质区别（后者会让 & | > 等元字符生效，即 B15 同源的注入面）。
  if (IS_WINDOWS && needsCmdExe(name)) {
    return spawnSync('cmd.exe', ['/c', name, ...args], opts);
  }
  return spawnSync(name, args, opts);
}

export function probeCommand(cmd, args = ['--version'], { timeoutMs = 5000, cwd } = {}) {
  // shell:false 避免 Windows 下命令注入与引号解析差异（B15 同源问题）——任何情况都不放开
  const opts = { encoding: 'utf8', timeout: timeoutMs, shell: false, cwd, windowsHide: true };
  const name = IS_WINDOWS ? resolveOnWindowsPath(String(cmd)) : String(cmd);
  if (!name) {
    return { available: false, version: null, resolvedCommand: null, error: `PATH 中未找到可执行文件 ${cmd}（已按 PATHEXT 逐后缀查找）` };
  }
  let r;
  try {
    r = runOnce(name, args, opts);
  } catch (err) {
    return { available: false, version: null, resolvedCommand: name, error: errText(err) };
  }
  if (r.error) return { available: false, version: null, resolvedCommand: name, error: errText(r.error) };
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `exit ${r.status}`;
    return { available: false, version: null, resolvedCommand: name, error: detail };
  }
  const version = (r.stdout || '').trim().split(/\r?\n/)[0].trim() || null;
  return { available: true, version, resolvedCommand: name, error: null };
}

export function probeGit(cwd) {
  const base = probeCommand('git', ['--version'], { cwd });
  if (!base.available) {
    return { available: false, version: null, head: null, dirty: false, resolvedCommand: base.resolvedCommand ?? null, error: base.error };
  }
  const head = probeCommand('git', ['rev-parse', 'HEAD'], { cwd });
  const status = probeCommand('git', ['status', '--porcelain'], { cwd });
  return {
    available: true,
    version: base.version,
    resolvedCommand: base.resolvedCommand ?? 'git',
    head: head.available ? head.version : null, // 非 git 仓库/空仓库 => null，但 git 本身可用
    dirty: status.available ? Boolean(status.version) : false,
    error: null
  };
}

/**
 * stale 是三态：true / false / 'unknown'。
 * git 不可用时无法核对 HEAD/提交时间（DESIGN I1 要求核对），此时必须是 'unknown' 而不是 false ——
 * false 会让一个可能极旧的索引被当成新鲜索引使用，正是 I1 描述的事故。
 * error 保留字符串（兼容旧调用方），errors 数组累积**全部**原因，避免二进制原因盖掉索引目录原因。
 *
 * 第二参 `commandName` 只为测试注入。本机装了 codegraph 之后，"二进制不可用 + 索引目录缺失"
 * 这个双原因场景在真实 PATH 上再也构造不出来，而它恰是「原因累积不互相覆盖」的回归靶子。
 * 生产调用一律省略该参数。
 */
export function probeCodegraph(cwd, commandName = 'codegraph') {
  const out = {
    available: false,
    binary: null,
    resolvedCommand: null,
    indexDir: null,
    indexedAt: null,
    stale: false,
    error: null,
    errors: []
  };
  const pushErr = (msg) => {
    out.errors.push(msg);
    out.error = out.errors.join('；');
  };

  const bin = probeCommand(commandName, ['--version'], { cwd });
  out.binary = bin.available ? bin.version : null;
  out.resolvedCommand = bin.resolvedCommand ?? null;
  if (!bin.available) pushErr(`codegraph 可执行文件不可用：${bin.error}`);

  const indexDir = path.join(String(cwd ?? '.'), '.codegraph');
  let indexMtime = null;
  try {
    const st = fs.statSync(indexDir);
    if (st.isDirectory()) {
      out.indexDir = indexDir;
      indexMtime = st.mtime;
      out.indexedAt = st.mtime.toISOString();
    } else {
      pushErr('.codegraph 存在但不是目录');
    }
  } catch {
    pushErr('未找到 .codegraph 索引目录');
  }

  // I1 简化判据：索引 mtime 早于最后一次提交时间即视为陈旧；判不出时标 'unknown'
  if (indexMtime) {
    const lastCommit = probeCommand('git', ['log', '-1', '--format=%cI'], { cwd });
    const t = lastCommit.available && lastCommit.version ? Date.parse(lastCommit.version) : NaN;
    if (Number.isFinite(t)) {
      out.stale = indexMtime.getTime() < t;
    } else {
      out.stale = 'unknown';
      pushErr(`无法判定索引新鲜度（git 不可用或无提交记录）：${lastCommit.error ?? '无 HEAD 提交'}`);
    }
  }

  out.available = Boolean(bin.available && out.indexDir) && out.stale === false;
  if (out.stale === true) pushErr('索引早于最后一次提交，需 codegraph init 重建（I1）');
  return out;
}

export async function probeCoordinator(pluginRoot) {
  const serverPath = path.join(pluginRoot, 'mcp', 'coordinator', 'server.mjs');
  if (!fs.existsSync(serverPath)) {
    return { available: false, serverPath, error: 'mcp/coordinator/server.mjs 不存在' };
  }
  const sqlite = await probeSqlite();
  if (!sqlite.available) {
    return { available: false, serverPath, error: `node:sqlite 不可用：${sqlite.error}` };
  }
  return { available: true, serverPath, error: null };
}

export function probeDashboard(pluginRoot) {
  const serverPath = path.join(pluginRoot, 'dashboard', 'server.mjs');
  let electron = false;
  try {
    createRequire(import.meta.url).resolve('electron');
    electron = true;
  } catch {
    electron = false; // GUI 模式不可用，但 loopback HTTP 模式仍可跑，故不计入 error
  }
  if (!fs.existsSync(serverPath)) {
    return { available: false, serverPath, electron, error: 'dashboard/server.mjs 不存在' };
  }
  return { available: true, serverPath, electron, error: null };
}

/** 单个 probe 抛异常不得让整个 probeAll reject（I2 故障隔离） */
function safeProbe(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return { ...fallback, error: `${label} 探测异常：${errText(err)}` };
  }
}

export async function probeAll({ pluginRoot, cwd } = {}) {
  const root = pluginRoot ?? process.cwd();
  const work = cwd ?? root;
  const [sqlite, coordinator] = await Promise.all([
    probeSqlite().catch((err) => ({ available: false, error: errText(err) })),
    probeCoordinator(root).catch((err) => ({ available: false, serverPath: null, error: errText(err) }))
  ]);
  return {
    node: safeProbe('node', () => probeNode(), { version: process.versions.node, major: 0, minor: 0, ok: false }),
    sqlite,
    git: safeProbe('git', () => probeGit(work), { available: false, version: null, head: null, dirty: false }),
    codegraph: safeProbe('codegraph', () => probeCodegraph(work), {
      available: false,
      binary: null,
      indexDir: null,
      indexedAt: null,
      stale: 'unknown',
      errors: []
    }),
    coordinator,
    dashboard: safeProbe('dashboard', () => probeDashboard(root), { available: false, serverPath: null, electron: false })
  };
}
