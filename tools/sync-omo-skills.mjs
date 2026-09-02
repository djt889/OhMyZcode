#!/usr/bin/env node
/**
 * tools/sync-omo-skills.mjs
 * OmO 上游同步助手（零依赖、不联网、不执行 git）。
 * 纪律来源 DESIGN §16.3/§16.4：上游变更必须人工过目——本工具只校验 lock、
 * 校验 omz_target 存在性、打印待执行 git 命令清单；绝不自动跑 git，也不 merge。
 *
 * 【为什么 lock 字段必须走字符白名单】
 * planSync 把 lock 的 url/branch/ported_paths[].path 直接拼进 git 命令字符串**打印给人复制执行**。
 * 工具自己不执行 git 是对的，但被复制到终端的那一行是要执行的：
 *   url: "https://evil.com/r.git; rm -rf /tmp/pwned #"  →  git remote add upstream <整行>
 * 于是 lock 文件（可能来自上游 PR / 他人提交）就成了任意命令执行的载体。
 * 因此 url/branch/path/omz_target 一律先过字符白名单，违规进 errors 并 exit 1，绝不进入打印。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonSafe } from '../adapters/zcode/path.mjs';
import { isMainModule, moduleDir } from './lib/is-main.mjs';
import { evaluateLicenseEntry, licenseReasonText } from './lib/license-gate.mjs';

const LOCK_REL = 'upstream/omo-sources.lock.json';
const SHA_RE = /^[0-9a-f]{40}$/;

/** 仓库 URL：只允许 https:// 与 git@ 两种形态，且字符集里没有任何 shell 元字符 */
const URL_HTTPS_RE = /^https:\/\/[A-Za-z0-9._~-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
const URL_SSH_RE = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/;
/** git 分支名：不含 shell 元字符，也不含 git 自身拒绝的形态 */
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
/** 仓库内相对路径：正斜杠、无元字符、无 .. 段、非绝对 */
const REL_PATH_RE = /^[A-Za-z0-9._/-]+$/;

export function isSafeRepoUrl(value) {
  return typeof value === 'string' && (URL_HTTPS_RE.test(value) || URL_SSH_RE.test(value));
}

export function isSafeBranch(value) {
  return typeof value === 'string' && value !== '' && BRANCH_RE.test(value) && !value.includes('..') && !value.startsWith('-');
}

/** 相对路径安全性：字符集 + 拒绝 `..` 段 + 拒绝绝对路径（含盘符与 UNC） */
export function isSafeRelPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (!REL_PATH_RE.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

/** 读并校验 lock：返回 { ok, lock, errors, warnings } —— errors 非空即 exit 1 的依据 */
export function loadLock(root) {
  const file = path.join(root, LOCK_REL);
  const errors = [];
  const warnings = [];
  const r = readJsonSafe(file);
  if (!r.ok) {
    const msg =
      r.reason === 'missing'
        ? `${LOCK_REL}: 文件不存在`
        : `${LOCK_REL}: 读取/解析失败（${r.reason}）— ${r.error}`;
    return { ok: false, lock: null, errors: [msg], warnings };
  }
  const lock = r.value;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return { ok: false, lock: null, errors: [`${LOCK_REL}: 顶层必须是对象`], warnings };
  }

  for (const k of ['source', 'url', 'branch', 'ported_paths', 'ignored_paths', 'license']) {
    if (lock[k] === undefined) errors.push(`${LOCK_REL}: 缺必填字段 '${k}'`);
  }
  if (!('commit' in lock)) errors.push(`${LOCK_REL}: 缺必填字段 'commit'（未 pin 请显式写 null）`);
  if (!('synced_at' in lock)) errors.push(`${LOCK_REL}: 缺必填字段 'synced_at'（未同步请显式写 null）`);

  // 这两个字段会被拼进打印给人复制执行的 git 命令行——字符白名单是硬门槛
  if (lock.url !== undefined && !isSafeRepoUrl(lock.url)) {
    errors.push(
      `${LOCK_REL}: url 形态不安全（只允许 https://host[:port]/path 或 git@host:path，字符集 A-Za-z0-9._~/-）：'${String(lock.url).slice(0, 120)}'` +
        '——该值会被拼进打印给人复制执行的 git 命令'
    );
  }
  if (lock.branch !== undefined && !isSafeBranch(lock.branch)) {
    errors.push(`${LOCK_REL}: branch 只允许 [A-Za-z0-9._/-]、不得含 '..' 或以 '-' 开头：'${String(lock.branch).slice(0, 120)}'`);
  }

  if (lock.commit === null) {
    if (!lock.commit_status) errors.push(`${LOCK_REL}: commit 为 null 时必须有 'commit_status' 说明`);
    warnings.push(`commit 未 pin（null）：无可复现来源基线。先 \`git fetch upstream\`，再 \`node tools/sync-omo-skills.mjs --pin <40位 SHA>\` 回写。`);
  } else if (typeof lock.commit !== 'string' || !SHA_RE.test(lock.commit)) {
    errors.push(`${LOCK_REL}: commit 必须是 40 位小写 hex SHA 或 null（当前 '${String(lock.commit).slice(0, 120)}'）`);
  }
  if (lock.synced_at === null) warnings.push('synced_at 未记录（null）：尚未执行过一次完整同步。');

  if (!Array.isArray(lock.ported_paths) || lock.ported_paths.length === 0) {
    errors.push(`${LOCK_REL}: ported_paths 必须是非空数组`);
  } else {
    lock.ported_paths.forEach((p, i) => {
      const tag = `ported_paths[${i}]`;
      if (typeof p !== 'object' || p === null) return errors.push(`${tag}: 必须是对象`);
      if (!p.path) errors.push(`${tag}: 缺 'path'（上游路径）`);
      else if (!isSafeRelPath(p.path)) {
        errors.push(`${tag}: path 只允许 [A-Za-z0-9._/-] 的仓库内相对路径（拒 '..' 段与绝对路径）：'${String(p.path).slice(0, 120)}'——该值会被拼进打印的 git diff 命令`);
      }
      if (!p.omz_target) errors.push(`${tag}: 缺 'omz_target'（本仓库对应文件）`);
      else if (p.omz_target.includes('\\')) errors.push(`${tag}: omz_target 必须用正斜杠（B3）`);
      else if (!isSafeRelPath(p.omz_target)) {
        errors.push(`${tag}: omz_target 必须是项目内相对路径（拒 '..' 段、绝对路径与元字符）：'${String(p.omz_target).slice(0, 120)}'`);
      }
      if (!['ported', 'adapted', 'pending'].includes(p.port_status)) {
        errors.push(`${tag}: port_status 非法值 '${p.port_status}'（ported/adapted/pending）`);
      }
    });
  }
  if (!Array.isArray(lock.ignored_paths)) errors.push(`${LOCK_REL}: ignored_paths 必须是数组`);
  else {
    lock.ignored_paths.forEach((p, i) => {
      if (!isSafeRelPath(p)) errors.push(`ignored_paths[${i}]: 只允许 [A-Za-z0-9._/-] 的相对路径（该值会被打印进注释行）：'${String(p).slice(0, 120)}'`);
    });
  }

  /**
   * 许可证判据：与 tools/doctor.mjs 的 supply:upstream-license **共用**
   * tools/lib/license-gate.mjs 的 evaluateLicenseEntry()（同一函数、同一组判据）。
   * 此前这里只要求 `status` 字段存在且不以 `unverified` 开头——比 doctor 松两个量级：
   * status:"pending"/"TODO"/"x" 都静默通过，且完全不看 spdx/verified_at/verified_via。
   * 本工具比 doctor 多判一条：doctor 的 supply:upstream-license 只看 license.omo，
   * 这里对 license 下每个已登记条目都判（omo + codegraph）。
   *
   * **严重度是本工具自己的职责，与 doctor 有意不同**（不要抹平）：
   *   · missing（整条 license.<key> 记录不存在）或 status 字段缺失 → ERROR/exit 1：
   *     保持本工具**原有的退出码契约**（原实现对 `!lic[key].status` 就是 push 到 errors）。
   *     字段缺失是 lock 结构问题，与"核验没做完"不是一回事；靠共享判据返回的 statusPresent 区分，
   *     不能因为收紧判据就把它降成 WARN——那是用重构掩盖行为变更。
   *   · 其余 unverified（status 存在但写着 pending/unverified/…）与 incomplete → WARN（退出码仍 0）：
   *     本工具是同步前的提示，不是发布门；同一状态在 doctor --supply-chain 里是 FAIL（仅 omo 会让它变红）。
   */
  const lic = lock.license;
  if (lic && typeof lic === 'object') {
    for (const key of ['omo', 'codegraph']) {
      const r = evaluateLicenseEntry(lic[key], { key });
      if (r.level === 'missing') {
        errors.push(`${LOCK_REL}: license 缺 '${key}' 记录`);
        continue;
      }
      if (!r.statusPresent) {
        errors.push(`${LOCK_REL}: license.${key} 缺 'status'`);
        continue;
      }
      if (r.level === 'ok') continue;
      const tail = r.level === 'unverified' ? '（未核验前禁止合并进 main）' : `（需回填：${r.missingFields.join('、')}）`;
      // doctor 的 supply:upstream-license 只判 license.omo；codegraph 的供应链取证由 supply:codegraph
      // 与 NOTICE 承担，别把它说成会让 doctor 变红。
      const cross =
        key === 'omo'
          ? '——doctor --supply-chain 对此判 FAIL（本工具只提示，退出码仍 0）'
          : '——doctor 的 supply:upstream-license 只判 license.omo，本条只在这里提示（退出码仍 0）';
      warnings.push(`${licenseReasonText(r)}${tail}${cross}`);
    }
  } else if (lic !== undefined) {
    errors.push(`${LOCK_REL}: license 必须是对象`);
  }

  return { ok: errors.length === 0, lock, errors, warnings };
}

/**
 * 生成待人工执行的 git 命令清单（只返回字符串，不执行）。
 * 二次防线：即便调用方跳过了 loadLock 的校验，这里对每个要拼进命令行的值再判一次；
 * 不安全的值不进命令行，只留一行显式说明——打印出来被人复制执行的东西必须是干净的。
 */
export function planSync(lock, { remoteExists = false } = {}) {
  const cmds = [];
  const rawBranch = lock.branch ?? 'dev';
  const branchOk = isSafeBranch(rawBranch);
  const branch = branchOk ? rawBranch : '<branch 不安全，已拒绝>';
  if (!branchOk) cmds.push(`# 拒绝：lock.branch 含非法字符，已从命令中剔除（只允许 [A-Za-z0-9._/-]）`);
  if (!remoteExists) {
    if (isSafeRepoUrl(lock.url)) cmds.push(`git remote add upstream ${lock.url}`);
    else cmds.push('# 拒绝：lock.url 形态不安全，未生成 git remote add 命令（只允许 https:// 或 git@ 形态）');
  }
  cmds.push('git fetch upstream');
  if (!lock.commit) {
    cmds.push(`# commit 未 pin —— 先取当前上游 SHA 并回写 lock，再做 diff：`);
    cmds.push(`git log -1 --format=%H upstream/${branch}`);
    cmds.push(`node tools/sync-omo-skills.mjs --pin <上一条输出的 SHA>`);
  }
  for (const p of lock.ported_paths ?? []) {
    const base = lock.commit ?? '<pin 后的 SHA>';
    if (!isSafeRelPath(p?.path)) {
      cmds.push(`# 拒绝：ported_paths 的 path 不安全，未生成 diff 命令（${JSON.stringify(String(p?.path ?? '').slice(0, 60))}）`);
      continue;
    }
    cmds.push(`git diff ${base}..upstream/${branch} -- ${p.path}`);
  }
  const ignored = (lock.ignored_paths ?? []).filter((p) => isSafeRelPath(p));
  cmds.push(`# 忽略路径（宿主 API，不适用，不移植）：${ignored.join(' ')}`);
  cmds.push('# 禁止 git merge upstream/dev（DESIGN §16.3）——逐路径判定后手工移植。');
  return cmds;
}

/** 校验每个 omz_target 在本仓库真实存在，返回缺失清单（不安全路径不做 join，直接记为问题） */
export function checkTargets(root, lock) {
  const missing = [];
  for (const p of lock.ported_paths ?? []) {
    if (!p?.omz_target) continue;
    if (!isSafeRelPath(p.omz_target)) {
      missing.push(`${p.omz_target}（路径不安全，未做存在性判断）`);
      continue;
    }
    const abs = path.join(root, ...p.omz_target.split('/'));
    if (!fs.existsSync(abs)) missing.push(p.omz_target);
  }
  return missing;
}

/** 回写 lock（走 writeJsonSafe：tmp + rename 原子写、UTF-8 无 BOM、LF、结尾换行） */
export function updateLock(root, { commit, synced_at, notes } = {}) {
  const file = path.join(root, LOCK_REL);
  const r = readJsonSafe(file);
  if (!r.ok) throw new Error(`updateLock: 无法读取 ${LOCK_REL}（${r.reason}）— ${r.error}`);
  const lock = r.value;
  if (commit !== undefined) {
    if (commit !== null && !SHA_RE.test(String(commit))) throw new Error(`commit 必须是 40 位小写 hex SHA：'${commit}'`);
    lock.commit = commit;
    lock.commit_status = commit
      ? `pinned — 由 tools/sync-omo-skills.mjs --pin 写入`
      : 'unpinned — 首次 sync 时由 tools/sync-omo-skills.mjs 写入实际 SHA';
  }
  if (synced_at !== undefined) {
    lock.synced_at = synced_at;
    lock.synced_at_status = synced_at ? 'synced' : 'never — 尚未执行过 git fetch upstream';
  }
  if (notes) lock.notes = [...(lock.notes ?? []), notes];
  writeJsonSafe(file, lock);
  return lock;
}

function runCli(root, argv) {
  const wantCheck = argv.includes('--check');
  const wantPlan = argv.includes('--plan');
  const pinIdx = argv.indexOf('--pin');
  const doAll = !wantCheck && !wantPlan && pinIdx === -1;

  if (pinIdx !== -1) {
    const sha = argv[pinIdx + 1];
    if (!sha || !SHA_RE.test(sha)) {
      console.error(`--pin 需要 40 位小写 hex SHA（收到 '${sha ?? ''}'）`);
      return 1;
    }
    updateLock(root, { commit: sha, synced_at: new Date().toISOString(), notes: `pin ${sha}` });
    console.log(`已回写 ${LOCK_REL}: commit=${sha}`);
    return 0;
  }

  const { ok, lock, errors, warnings } = loadLock(root);
  let exit = 0;

  if (wantCheck || doAll) {
    console.log('== check ==');
    for (const w of warnings) console.log(`  WARN  ${w}`);
    for (const e of errors) console.error(`  ERROR ${e}`);
    if (!ok) return 1;
    const missing = checkTargets(root, lock);
    for (const m of missing) console.error(`  ERROR omz_target 不存在：${m}`);
    if (missing.length) exit = 1;
    else console.log(`  OK    lock 字段完整；${lock.ported_paths.length} 个 omz_target 全部存在`);
  }

  if ((wantPlan || doAll) && lock) {
    console.log('== plan（只打印，不执行；上游同步必须人工过目，DESIGN §16.3）==');
    for (const c of planSync(lock)) console.log(`  ${c}`);
  }
  return exit;
}

if (isMainModule(import.meta.url)) {
  const here = moduleDir(import.meta.url);
  const root = fs.existsSync(path.join(process.cwd(), LOCK_REL)) ? process.cwd() : path.resolve(here, '..');
  process.exit(runCli(root, process.argv.slice(2)));
}
