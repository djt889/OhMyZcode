#!/usr/bin/env node
/**
 * tools/doctor.mjs
 * /omz-doctor 的离线可执行部分（commands/omz-doctor.md 的 ① spawn ping 只能在会话内做，本文件不实现）。
 * 覆盖：清单完整性 / frontmatter / model 登记核对 / .gitignore(B14) / mtime vs 会话启动(B19)
 *      / .omz JSON 卫生(B3+B4) / 能力探测与 profile 降级(I1/I2)，--supply-chain 追加供应链取证(I6)。
 * 每个 FAIL 必须附可执行修复指令——笼统报错在本项目视为缺陷。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateAll, parseFrontmatter } from './validate-frontmatter.mjs';
import { scanJsonHygiene, readJsonSafe, toPosixRelative } from '../adapters/zcode/path.mjs';
import { probeAll } from '../adapters/zcode/capability.mjs';
import { loadConfig, resolveProfiles, formatDegradeReport } from '../adapters/zcode/fallback.mjs';
import { isMainModule, moduleDir } from './lib/is-main.mjs';
import { evaluateLicenseEntry, licenseReasonText, VERIFY_COMMAND } from './lib/license-gate.mjs';

const PLUGIN_ROOT = path.resolve(moduleDir(import.meta.url), '..');
const EXPECTED_AGENTS = 9; // commands/omz-doctor.md 承诺的 spawn ping 数量

/**
 * 引擎证实的插件模板变量全集（zcode.cjs 的展开正则，2026-09-01 反查）。
 * 不在此集合内的 `${X}` 不会被展开，会原样留在命令行里——因此必须当作错误报出。
 * ZCODE_SKILL_DIR/CLAUDE_SKILL_DIR 在 hook 上下文会抛错，此处只用于路径存在性判断。
 */
const SUPPORTED_TEMPLATE_VARS = new Set([
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_SESSION_ID',
  'CLAUDE_SKILL_DIR',
  'ZCODE_PLUGIN_DATA',
  'ZCODE_PLUGIN_ROOT',
  'ZCODE_PROJECT_DIR',
  'ZCODE_SESSION_ID',
  'ZCODE_SKILL_DIR'
]);

export function unsupportedTemplateVars(value) {
  const found = new Set();
  for (const m of String(value).matchAll(/\$\{([A-Za-z0-9_.]+)\}/g)) {
    const name = m[1];
    if (name.startsWith('user_config.')) continue; // 引擎为插件 MCP 展开 user_config.*
    if (!SUPPORTED_TEMPLATE_VARS.has(name)) found.add(`\${${name}}`);
  }
  return [...found];
}

/** 只展开能在离线校验期确定的变量（插件根）；项目目录等运行期变量保留原样 */
function expandTemplateVars(value, pluginRoot) {
  return String(value)
    .replace(/\$\{ZCODE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

function check(id, label, status, detail, fix = null) {
  return { id, label, status, detail, fix };
}

/** 逐文件容错时统一的错误文本（不吞错误信息，但也不让单文件拖垮整体） */
function errText(err) {
  return String(err && err.message ? err.message : err);
}

/** ① 清单完整性：plugin.json 声明的每个路径必须真实存在（本项目踩过的坑） */
function checkManifest(pluginRoot) {
  const out = [];
  const manifestFile = path.join(pluginRoot, '.zcode-plugin', 'plugin.json');
  const r = readJsonSafe(manifestFile);
  if (!r.ok) {
    return [
      check(
        'manifest',
        '清单完整性',
        'FAIL',
        `无法读取 .zcode-plugin/plugin.json（${r.reason}: ${r.error}）`,
        '修复：创建/修正 .zcode-plugin/plugin.json（UTF-8 无 BOM 的合法 JSON）'
      )
    ];
  }
  const m = r.value ?? {};
  const missing = [];
  const declared = [];

  for (const key of ['agents', 'commands', 'skills', 'hooks']) {
    const v = m[key];
    if (typeof v !== 'string' || !v) continue;
    const abs = path.resolve(pluginRoot, v);
    declared.push(`${key}=${v}`);
    if (!fs.existsSync(abs)) missing.push({ key, value: v, abs, optional: false });
  }

  /**
   * mcpServers 的每个条目：args + cwd + env 的每个值都要送检。
   * 只查 args 是不够的——plugin.json 的 cwd 与 env.OMZ_COORDINATOR_DB 都用了 ${ZCODE_PROJECT_DIR}，
   * 变量名写错时引擎原样保留，服务器会在一个字面量为 '${ZCODE_PROJECT_DIRR}' 的目录里启动。
   */
  for (const [name, srv] of Object.entries(m.mcpServers ?? {})) {
    const candidates = [];
    for (const arg of srv?.args ?? []) candidates.push({ where: 'args', value: arg });
    if (srv?.cwd !== undefined) candidates.push({ where: 'cwd', value: srv.cwd, skipExists: true });
    for (const [ek, ev] of Object.entries(srv?.env ?? {})) {
      candidates.push({ where: `env.${ek}`, value: ev, skipExists: true });
    }

    for (const cand of candidates) {
      const { where, value } = cand;
      if (typeof value !== 'string') continue;
      const bad = unsupportedTemplateVars(value);
      if (bad.length) {
        out.push(
          check(
            `manifest:mcpServers.${name}.${where}:vars`,
            '清单模板变量',
            'FAIL',
            `mcpServers.${name} 的 ${where} 使用了引擎不识别的模板变量：${bad.join(', ')}（未识别变量原样保留，路径必然失效）`,
            `修复：改用引擎证实的变量之一：${[...SUPPORTED_TEMPLATE_VARS].join(' / ')}`
          )
        );
      }
      const raw = expandTemplateVars(value, pluginRoot);
      if (!/[\\/]/.test(raw)) continue; // 非路径参数（如 --flag / 纯标量 env）跳过
      if (/\$\{/.test(raw)) continue; // 仍含未解析变量（如 ZCODE_PROJECT_DIR）——运行期才定，跳过存在性检查
      const abs = path.resolve(pluginRoot, raw);
      declared.push(`mcpServers.${name}.${where}=${value}`);
      // cwd/env 指向的路径可能是运行期才创建的（如 .omz/runtime/*.sqlite）——不做存在性硬校验
      if (!cand.skipExists && !fs.existsSync(abs)) {
        missing.push({ key: `mcpServers.${name}.${where}`, value, abs, optional: srv?.enabled === false });
      }
    }
  }

  const hard = missing.filter((x) => !x.optional);
  const soft = missing.filter((x) => x.optional);
  if (hard.length) {
    out.push(
      check(
        'manifest',
        '清单完整性',
        'FAIL',
        `plugin.json 声明了 ${declared.length} 个路径，其中 ${hard.length} 个不存在：` +
          hard.map((x) => `${x.key} → ${x.value}`).join('；'),
        '修复：' +
          hard
            .map((x) => `创建 ${toPosixRelative(x.abs, pluginRoot)}，或从 plugin.json 删除 ${x.key} 声明`)
            .join('；')
      )
    );
  } else {
    out.push(check('manifest', '清单完整性', 'OK', `plugin.json 声明的 ${declared.length} 个路径全部存在`));
  }
  for (const x of soft) {
    out.push(
      check(
        `manifest:${x.key}`,
        '清单完整性(可选项)',
        'WARN',
        `${x.key} → ${x.value} 不存在，但该条目 enabled:false（profile 未启用，不阻断 core）`,
        `修复（仅当要启用该 profile）：实现 ${toPosixRelative(x.abs, pluginRoot)} 后把 enabled 改为 true`
      )
    );
  }
  return out;
}

/** ② frontmatter：复用 validate-frontmatter.mjs，不重复实现 */
function checkFrontmatter(pluginRoot) {
  let errors;
  try {
    errors = validateAll(pluginRoot);
  } catch (err) {
    return check(
      'frontmatter',
      'frontmatter 校验',
      'FAIL',
      `校验器执行失败：${err && err.message ? err.message : err}`,
      '修复：确认 agents/ commands/ skills/ 三个目录存在后重跑 node tools/validate-frontmatter.mjs'
    );
  }
  if (errors.length) {
    return check(
      'frontmatter',
      'frontmatter 校验',
      'FAIL',
      `${errors.length} 处问题：` + errors.join('；'),
      '修复：按上列逐条改正后重跑 node tools/validate-frontmatter.mjs'
    );
  }
  return check('frontmatter', 'frontmatter 校验', 'OK', 'agents/commands/skills frontmatter 全部合规');
}

/** agents 计数（① 的离线等价：spawn ping 无法离线做，退化为文件存在 + frontmatter 可解析） */
function checkAgents(pluginRoot) {
  const dir = path.join(pluginRoot, 'agents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^omz-.*\.md$/.test(n));
  } catch {
    return {
      result: check(
        'agents',
        'agents 清单',
        'FAIL',
        'agents/ 目录不存在或不可读',
        '修复：创建 agents/ 目录并放入 omz-*.md 子代理定义'
      ),
      total: 0,
      passed: 0,
      models: []
    };
  }
  const models = [];
  let passed = 0;
  const bad = [];
  const unreadable = [];
  for (const f of files) {
    const full = path.join(dir, f);
    // 逐文件容错：Windows 下文件被独占锁定（编辑器/杀软/同步盘）时 readFileSync 会抛，
    // 整个 doctor 因此崩掉就等于「体检仪自己坏了还不报」——单文件失败只记该文件。
    let fm = null;
    try {
      fm = parseFrontmatter(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      unreadable.push(`${f}(${err && err.code ? err.code : errText(err)})`);
      continue;
    }
    if (fm && fm.name && fm.description) passed += 1;
    else bad.push(f);
    if (fm?.model) models.push({ file: f, model: String(fm.model) });
  }
  const broken = [...bad, ...unreadable];
  const status = broken.length ? 'FAIL' : files.length === EXPECTED_AGENTS ? 'OK' : 'WARN';
  const detail =
    `${passed}/${files.length} 个 omz-*.md frontmatter 可用` +
    (files.length === EXPECTED_AGENTS ? '' : `（omz-doctor.md 承诺 ${EXPECTED_AGENTS} 个）`) +
    (bad.length ? `；异常：${bad.join(', ')}` : '') +
    (unreadable.length ? `；不可读：${unreadable.join(', ')}` : '');
  const fix = broken.length
    ? `修复：检查 ${broken.join(', ')} 的 frontmatter（name/description 必填）；不可读文件请关闭占用该文件的程序后重跑`
    : files.length === EXPECTED_AGENTS
      ? null
      : `修复：让 agents/omz-*.md 数量与 commands/omz-doctor.md 的 ping 清单一致（当前 ${files.length}，期望 ${EXPECTED_AGENTS}）`;
  return { result: check('agents', 'agents 清单', status, detail, fix), total: files.length, passed, models };
}

/** 宽松递归收集：ZCode config 结构未公开，把所有可能是模型 ID 的字符串都收进集合 */
function collectModelIds(node, acc, keyHint = '') {
  if (typeof node === 'string') {
    if (/^(model|modelId|id|name)$/.test(keyHint) || keyHint === '[]') acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectModelIds(v, acc, typeof v === 'string' ? '[]' : keyHint);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectModelIds(v, acc, k);
  }
  return acc;
}

/** ③ model 校验：agent 未写 model = 继承主会话 = 合法；配置文件缺失 = SKIP 不算 FAIL */
function checkModels(agentModels) {
  const cfgFile = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
  if (!fs.existsSync(cfgFile)) {
    return check(
      'model',
      'model 登记核对',
      'SKIP',
      `未找到 ${toPosixRelative(cfgFile, os.homedir())}（未登记供应商模型清单，跳过比对）`,
      null
    );
  }
  const r = readJsonSafe(cfgFile);
  if (!r.ok) {
    return check(
      'model',
      'model 登记核对',
      'SKIP',
      `~/.zcode/v2/config.json 不可解析（${r.reason}: ${r.error}），跳过比对`,
      '修复（可选）：修正该文件为 UTF-8 无 BOM 的合法 JSON 后重跑'
    );
  }
  const known = collectModelIds(r.value, new Set());
  if (!agentModels.length) {
    return check('model', 'model 登记核对', 'OK', `所有 agent 未写 model（继承主会话，合法）；已登记候选 ${known.size} 项`);
  }
  const unknown = agentModels.filter((m) => !known.has(m.model));
  if (unknown.length) {
    return check(
      'model',
      'model 登记核对',
      'FAIL',
      `${unknown.length} 处 model 不在已登记清单：` + unknown.map((m) => `${m.file}→${m.model}`).join('；'),
      '修复：改为已登记模型 ID，或删掉该 frontmatter 的 model 行以继承主会话模型'
    );
  }
  return check('model', 'model 登记核对', 'OK', `${agentModels.length} 处 model 均在已登记清单（共 ${known.size} 项候选）`);
}

/** ④ .gitignore 含 .omz/（B14） */
function checkGitignore(projectRoot) {
  const file = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(file)) {
    return check(
      'gitignore',
      '.gitignore 检查',
      'FAIL',
      '项目根缺少 .gitignore，.omz/ 运行时状态可能被误提交（B14）',
      '修复：printf ".omz/\\n" >> .gitignore'
    );
  }
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim());
  } catch (err) {
    return check(
      'gitignore',
      '.gitignore 检查',
      'WARN',
      `.gitignore 存在但不可读（${err && err.code ? err.code : errText(err)}）——无法确认 .omz/ 是否被忽略`,
      '修复：关闭占用 .gitignore 的程序后重跑；并手工确认其中有一行 .omz/'
    );
  }
  const hit = lines.some((l) => l === '.omz/' || l === '.omz' || l === '/.omz/' || l === '/.omz');
  if (!hit) {
    return check(
      'gitignore',
      '.gitignore 检查',
      'FAIL',
      '.gitignore 未忽略 .omz/（B14：运行时状态会被误提交）',
      '修复：在 .gitignore 追加一行 .omz/'
    );
  }
  return check('gitignore', '.gitignore 检查', 'OK', '.gitignore 已忽略 .omz/');
}

/** ⑤ mtime vs 本会话启动时间（B19：agent 清单是会话启动快照） */
function checkMtime(pluginRoot) {
  const sessionStart = Date.now() - process.uptime() * 1000;
  const dir = path.join(pluginRoot, 'agents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^omz-.*\.md$/.test(n));
  } catch {
    return check('mtime', 'mtime vs 会话启动(B19)', 'SKIP', 'agents/ 不可读，跳过');
  }
  const newer = [];
  const unreadable = [];
  for (const f of files) {
    // 逐文件容错：statSync 也会因独占锁定/权限抛（Windows 常见），不能让它掀翻整个 doctor
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > sessionStart) newer.push({ file: f, mtime: st.mtime.toISOString() });
    } catch (err) {
      unreadable.push(`${f}(${err && err.code ? err.code : errText(err)})`);
    }
  }
  if (newer.length || unreadable.length) {
    return check(
      'mtime',
      'mtime vs 会话启动(B19)',
      'WARN',
      [
        newer.length
          ? `${newer.length} 个 agent 文件晚于本进程启动（${new Date(sessionStart).toISOString()}）：` +
            newer.map((n) => `${n.file}@${n.mtime}`).join('；') +
            '——文件已就位但本会话不可见'
          : null,
        unreadable.length ? `${unreadable.length} 个文件 stat 失败（跳过该文件，不影响其余检查）：${unreadable.join(', ')}` : null
      ]
        .filter(Boolean)
        .join('；'),
      newer.length ? '修复：新开一个 ZCode 会话，agent 清单才会重新快照' : '修复：关闭占用这些文件的程序（编辑器/同步盘/杀软）后重跑'
    );
  }
  return check('mtime', 'mtime vs 会话启动(B19)', 'OK', `${files.length} 个 agent 文件均早于本会话启动`);
}

/** ⑥ .omz/ JSON 卫生：BOM(B4) + 反斜杠路径(B3) */
function checkHygiene(projectRoot) {
  const omzDir = path.join(projectRoot, '.omz');
  const scan = scanJsonHygiene(omzDir);
  const problems = scan.bom.length + scan.backslash.length + scan.corrupt.length;
  if (scan.scanned === 0) {
    return { result: check('hygiene', 'BOM/路径扫描(B3/B4)', 'OK', '.omz/ 下无 JSON 可扫（尚未产生运行时状态）'), scan };
  }
  if (!problems) {
    return { result: check('hygiene', 'BOM/路径扫描(B3/B4)', 'OK', `扫描 ${scan.scanned} 个 JSON，无 BOM/反斜杠/损坏`), scan };
  }
  const detail = [
    `扫描 ${scan.scanned} 个 JSON`,
    scan.bom.length ? `BOM ${scan.bom.length} 个：${scan.bom.map((f) => toPosixRelative(f, projectRoot)).join(', ')}` : null,
    scan.backslash.length
      ? `反斜杠路径 ${scan.backslash.length} 处：` +
        scan.backslash.map((b) => `${toPosixRelative(b.file, projectRoot)}#${b.keyPath}=${b.value}`).join(', ')
      : null,
    scan.corrupt.length
      ? `损坏 ${scan.corrupt.length} 个：${scan.corrupt.map((c) => `${toPosixRelative(c.file, projectRoot)}(${c.error})`).join(', ')}`
      : null
  ]
    .filter(Boolean)
    .join('；');
  const fixes = [];
  if (scan.bom.length) fixes.push('用 node 重写这些文件（fs.writeFileSync 默认无 BOM），禁用 PowerShell Set-Content 写状态文件');
  if (scan.backslash.length) fixes.push('把上列值改为相对项目根的正斜杠路径，或调用 adapters/zcode/path.mjs 的 deepNormalizePaths 后重写');
  if (scan.corrupt.length) fixes.push('删除或重建损坏文件（.omz/ 是可重建的运行时状态）');
  return { result: check('hygiene', 'BOM/路径扫描(B3/B4)', 'FAIL', detail, '修复：' + fixes.join('；')), scan };
}

/** ⑦ 能力探测 + profile 降级（I1/I2）：探测不可用只降级，不 FAIL——core 必须能独立跑 */
function checkCapabilities(caps, resolved) {
  const out = [];
  out.push(
    caps.node.ok
      ? check('cap:node', 'Node 版本', 'OK', `v${caps.node.version}（>=22.13）`)
      : check(
          'cap:node',
          'Node 版本',
          'FAIL',
          `v${caps.node.version} 低于 22.13，node:sqlite 等内置能力不可用`,
          '修复：升级到 Node >= 22.13.0（package.json engines 已声明）。' +
            '门槛不是保守取整：22.5–22.12 上 node:sqlite 在 --experimental-sqlite flag 之后，' +
            '直接 import 会 ERR_UNKNOWN_BUILTIN_MODULE 崩栈，orchestration（coordinator）与 dashboard 启动即挂'
        )
  );
  out.push(
    caps.sqlite.available
      ? check('cap:sqlite', 'node:sqlite', 'OK', '内置 SQLite 可用')
      : check('cap:sqlite', 'node:sqlite', 'WARN', `不可用：${caps.sqlite.error}（orchestration profile 无法启用）`, '修复（仅当要启用 orchestration）：升级 Node 或改用外部 SQLite 实现')
  );
  out.push(
    caps.git.available
      ? check('cap:git', 'git', 'OK', `${caps.git.version}；HEAD=${caps.git.head ?? '(非 git 仓库)'}${caps.git.dirty ? '；working tree dirty' : ''}`)
      : check('cap:git', 'git', 'WARN', `不可用：${caps.git.error}（graph 索引新鲜度无法核验，I1）`, '修复（可选）：安装 git 并确保在 PATH 中')
  );
  out.push(
    caps.codegraph.available
      ? check('cap:codegraph', 'codegraph 索引', 'OK', `${caps.codegraph.binary}；索引 ${caps.codegraph.indexedAt}`)
      : check('cap:codegraph', 'codegraph 索引', 'WARN', caps.codegraph.error ?? 'graph profile 依赖不满足', '修复（仅当要启用 graph）：安装 @colbymchenry/codegraph 并在项目根跑 codegraph init')
  );
  out.push(
    caps.coordinator.available
      ? check('cap:coordinator', 'coordinator MCP', 'OK', caps.coordinator.serverPath)
      : check('cap:coordinator', 'coordinator MCP', 'WARN', caps.coordinator.error, '修复（仅当要启用 orchestration）：实现 mcp/coordinator/server.mjs 并把 plugin.json 的 enabled 改为 true')
  );
  out.push(
    caps.dashboard.available
      ? check('cap:dashboard', 'dashboard', 'OK', `${caps.dashboard.serverPath}；electron=${caps.dashboard.electron}`)
      : check('cap:dashboard', 'dashboard', 'WARN', `${caps.dashboard.error}；electron=${caps.dashboard.electron}`, '修复（仅当要启用 dashboard）：实现 dashboard/server.mjs（loopback 绑定 + 随机 token，I5）')
  );
  out.push(check('profiles', 'profile 降级报告', 'OK', formatDegradeReport(resolved)));
  return out;
}

/** --supply-chain：I6 供应链取证，缺失即该项 FAIL */
function checkSupplyChain(pluginRoot, caps) {
  const out = [];
  const lockFile = path.join(pluginRoot, 'upstream', 'omo-sources.lock.json');
  const lock = readJsonSafe(lockFile);
  if (!lock.ok) {
    out.push(
      check(
        'supply:lock',
        '上游来源锁定',
        'FAIL',
        `缺少或不可读 upstream/omo-sources.lock.json（${lock.reason}）——无法复现移植来源（DESIGN §16.4）`,
        '修复：创建 upstream/omo-sources.lock.json，至少含 source/branch/commit/synced_at/ported_paths 字段'
      )
    );
  } else {
    const v = lock.value ?? {};
    const required = ['source', 'commit', 'synced_at'];
    const absent = required.filter((k) => !(k in v));
    // commit/synced_at 显式为 null 且带 <key>_status 说明 = 诚实的未 pin 状态（与 sync 工具约定一致）→ WARN 不 FAIL
    const unpinned = required.filter((k) => k in v && !v[k] && typeof v[`${k}_status`] === 'string');
    const empty = required.filter((k) => k in v && !v[k] && !unpinned.includes(k));
    if (absent.length || empty.length) {
      const bad = [...absent, ...empty];
      out.push(check('supply:lock', '上游来源锁定', 'FAIL', `lock 文件缺字段或为空：${bad.join(', ')}`, `修复：在 upstream/omo-sources.lock.json 补齐 ${bad.join('、')}`));
    } else if (unpinned.length) {
      out.push(
        check(
          'supply:lock',
          '上游来源锁定',
          'WARN',
          `source=${v.source}；${unpinned.map((k) => `${k}=null（${v[`${k}_status`]}）`).join('；')}`,
          '修复（发布前必做）：执行首次 upstream 同步并回写真实 commit SHA 与 synced_at（DESIGN §16.4：禁止用 latest 代替可复现来源）'
        )
      );
    } else {
      out.push(check('supply:lock', '上游来源锁定', 'OK', `source=${v.source} commit=${v.commit} synced_at=${v.synced_at}`));
    }
    /**
     * 上游许可证取证。判据实现**同源**：与 tools/sync-omo-skills.mjs 的 loadLock() 共用
     * tools/lib/license-gate.mjs 的 evaluateLicenseEntry()——同一个函数、同一组四项判据
     * （① status 以 verified 开头且不含 unverified；② spdx 非空；③④ verified_at + verified_via 存在）。
     * 此前两侧各写一份，松紧差两个量级（那侧只要求 status 存在且不以 unverified 开头，
     * 于是 status:"pending"/"TODO"/"x" 都静默通过，且完全不看 spdx/verified_at/verified_via）。
     *
     * **严重度分化是有意的，不要抹平**：本项是发布门 → ok 之外的三档（incomplete/unverified/missing）
     * 一律 FAIL；那侧是同步前提示 → incomplete/unverified 只报 WARN 且退出码仍 0，
     * missing 走它原有的 ERROR/exit 1（lock 结构缺失属结构性错误）。
     *
     * 只判 license.omo（本项标签就是"上游许可证"）；codegraph 的许可证记录由 lock 的
     * license.codegraph 与 supply:codegraph 承担——它只有 spdx+status、无 verified_at/verified_via
     * （按共享判据是 incomplete），不在本项判据内。
     * **判据的已知边界**（别把它当强于实际）：四项齐备只证明"有人留下了可复核的取证痕迹"，
     * 不证明 spdx 的值本身正确——把 spdx 写成错的协议名同时补齐 status/verified_at/verified_via
     * 仍会转 OK。要判值的正确性只能联网比对上游 LICENSE，而 doctor 是离线检查（见文件头与
     * license-gate.mjs 的「已知边界」）。
     */
    const lic = evaluateLicenseEntry(v.license?.omo, { key: 'omo' });
    const licFix =
      '修复：核验上游许可证并回填 upstream/omo-sources.lock.json 的 license.omo——' +
      VERIFY_COMMAND +
      '（GitHub 对非标准协议只给 Other/NOASSERTION，仍需读仓库 LICENSE.md 原文确认协议名与关键条款）；' +
      `需回填的字段：${lic.missingFields.length ? lic.missingFields.join('、') : 'spdx、status="verified"、verified_at、verified_via'}` +
      '（status 须为 "verified…"、verified_at=<ISO 日期>、verified_via=<取证途径>）。' +
      '本项与 node tools/sync-omo-skills.mjs --check 共用同一判据（tools/lib/license-gate.mjs），但严重度更高：' +
      '那侧对同一状态只报 WARN 且退出码仍 0，本项判 FAIL——发布门在这里。';
    out.push(
      lic.level === 'ok'
        ? check('supply:upstream-license', '上游许可证', 'OK', licenseReasonText(lic))
        : check(
            'supply:upstream-license',
            '上游许可证',
            'FAIL',
            `${licenseReasonText(lic)}（判据档位=${lic.level}）——I6 要求许可证边界必须留档`,
            licFix
          )
    );
  }

  const pkg = readJsonSafe(path.join(pluginRoot, 'package.json'));
  const engines = pkg.ok ? pkg.value?.engines : null;
  out.push(
    engines && engines.node
      ? check('supply:engines', 'engines 声明', 'OK', `node ${engines.node}`)
      : check(
          'supply:engines',
          'engines 声明',
          'FAIL',
          'package.json 缺 engines.node——ABI/版本漂移无约束',
          '修复：在 package.json 加 "engines": { "node": ">=22.13.0" }' +
            '（22.5–22.12 的 node:sqlite 需 --experimental-sqlite，缺 flag 时 coordinator 与 dashboard 会崩在启动阶段）'
        )
  );

  const licenseFile = path.join(pluginRoot, 'LICENSE');
  if (!fs.existsSync(licenseFile)) {
    out.push(check('supply:license', 'LICENSE', 'FAIL', '缺少 LICENSE 文件（I6：许可证边界必须留档）', '修复：添加 LICENSE（本项目 package.json 声明 MIT）'));
  } else {
    let first = '';
    try {
      first = fs.readFileSync(licenseFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim()) ?? '';
    } catch (err) {
      out.push(check('supply:license', 'LICENSE', 'WARN', `LICENSE 存在但不可读（${err && err.code ? err.code : errText(err)}）`, '修复：关闭占用该文件的程序后重跑'));
      first = null;
    }
    if (first !== null) out.push(check('supply:license', 'LICENSE', 'OK', first.trim()));
  }

  out.push(
    caps.codegraph.binary
      ? check('supply:codegraph', '外部依赖 codegraph 版本', 'OK', caps.codegraph.binary)
      : check('supply:codegraph', '外部依赖 codegraph 版本', 'FAIL', '无法取得 codegraph 版本（未安装或不在 PATH）——供应链取证不完整', '修复：安装并锁定 @colbymchenry/codegraph 版本，或在 lock 文件中显式标注该依赖未使用')
  );
  return out;
}

export async function runDoctor({ projectRoot, supplyChain = false } = {}) {
  const root = path.resolve(projectRoot ?? PLUGIN_ROOT);
  const checks = [];

  checks.push(...checkManifest(PLUGIN_ROOT));
  const agents = checkAgents(PLUGIN_ROOT);
  checks.push(agents.result);
  checks.push(checkFrontmatter(PLUGIN_ROOT));
  checks.push(checkModels(agents.models));
  checks.push(checkGitignore(root));
  checks.push(checkMtime(PLUGIN_ROOT));
  const hygiene = checkHygiene(root);
  checks.push(hygiene.result);

  const caps = await probeAll({ pluginRoot: PLUGIN_ROOT, cwd: root });
  const { config, sources } = loadConfig(root);
  const resolved = resolveProfiles(config, caps);
  checks.push(
    check(
      'config',
      '配置加载',
      'OK',
      `profile=${config.profile} keyword_hook=${config.keyword_hook}；层：` +
        sources.map((s) => `${toPosixRelative(s.file, root)}(${s.ok ? 'ok' : 'skip'})`).join(' → ')
    )
  );
  checks.push(...checkCapabilities(caps, resolved));
  if (supplyChain) checks.push(...checkSupplyChain(PLUGIN_ROOT, caps));

  const status = (id) => checks.find((c) => c.id === id)?.status ?? 'SKIP';
  const modelCheck = checks.find((c) => c.id === 'model');
  const summaryLine = [
    // 措辞刻意区分"静态校验"与"spawn ping"：真 spawn 只能在会话内做（§10.2 V12），
    // 写成 "9/9 OK" 会让人以为 V12 已完成。
    `① agents: ${agents.passed}/${agents.total || EXPECTED_AGENTS} 静态校验${agents.result.status}（spawn ping 未执行，需会话内 /omz-doctor）`,
    `② model: ${modelCheck?.status === 'OK' ? 'OK' : modelCheck?.status === 'SKIP' ? 'SKIP(未登记清单)' : 'FAIL'}`,
    `③ gitignore: ${status('gitignore')}`,
    `④ mtime: ${status('mtime')}`,
    `⑤ BOM: ${status('hygiene')}`
  ].join(' | ');

  return { ok: !checks.some((c) => c.status === 'FAIL'), checks, summaryLine, caps, resolved, config };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const supplyChain = args.includes('--supply-chain');
  const asJson = args.includes('--json');
  const positional = args.find((a) => !a.startsWith('--'));
  const report = await runDoctor({ projectRoot: positional ?? PLUGIN_ROOT, supplyChain });

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ ok: report.ok, summaryLine: report.summaryLine, checks: report.checks, resolved: report.resolved }, null, 2) + '\n'
    );
  } else {
    const icon = { OK: '[OK]  ', FAIL: '[FAIL]', WARN: '[WARN]', SKIP: '[SKIP]' };
    process.stdout.write(`OMZ doctor（离线检查）projectRoot=${path.resolve(positional ?? PLUGIN_ROOT)}\n\n`);
    for (const c of report.checks) {
      process.stdout.write(`${icon[c.status]} ${c.label}: ${c.detail}\n`);
      if (c.status !== 'OK' && c.fix) process.stdout.write(`        ${c.fix}\n`);
    }
    process.stdout.write(`\n${report.summaryLine}\n`);
    process.stdout.write(report.ok ? '结论：无 FAIL\n' : '结论：存在 FAIL，按上列修复指令处理\n');
  }
  if (!report.ok) process.exit(1);
}
