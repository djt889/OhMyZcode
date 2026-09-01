#!/usr/bin/env node
/**
 * tools/validate-frontmatter.mjs
 * 校验 OMZ 插件清单：agents/commands/skills 的 frontmatter 合规性（B1/B10 防线）。
 * 零依赖——自带最小 YAML frontmatter 子集解析器（覆盖本仓库用到的字段形态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, moduleDir } from './lib/is-main.mjs';

const KNOWN_AGENT_FIELDS = new Set(['name', 'description', 'tools', 'model', 'thoughtLevel', 'permissionMode', 'maxTurns', 'memory', 'color', 'mcpServers']);
const THOUGHT_LEVELS = new Set(['off', 'low', 'medium', 'high', 'max']);

/**
 * 工具白名单分两级——「引擎里有这个名字」不等于「子代理拿得到」。
 *
 * SUBAGENT_TOOLS：子代理实测可用（本部署 2026-09-01 逐项确认过的工具面）+ `mcp__*` 前缀。
 * ENGINE_ONLY_TOOLS：引擎里存在该工具名，但子代理拿不到：
 *   - Agent：对子代理结构性不存在（防嵌套委派）。写进 frontmatter 等于声明一个会被静默忽略的能力。
 *   - WebSearch：本部署不可用（主 agent 与子代理的实测工具面里都没有）。
 *   - Grep/Glob：本部署不在子代理工具面内（检索走 Bash + Read）。
 * 出现 ENGINE_ONLY_TOOLS 成员必须报错：静默忽略的能力声明会让「只读角色靠白名单收束」的
 * 结构性保证（B1/B11）变成一句空话——人以为声明了，实际引擎没给。
 */
export const SUBAGENT_TOOLS = Object.freeze([
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Read',
  'ReadSessionContext',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'TodoRead',
  'TodoWrite',
  'WebFetch',
  'Write'
]);

export const ENGINE_ONLY_TOOLS = Object.freeze({
  Agent: '子代理不可用：Agent 对子代理结构性不存在（防嵌套委派），声明后会被静默忽略',
  WebSearch: '本部署不可用：主 agent 与子代理的实测工具面里均无 WebSearch（联网检索请用 WebFetch）',
  Grep: '子代理工具面无 Grep（用 Bash 的 grep/rg 或 Read 替代）',
  Glob: '子代理工具面无 Glob（用 Bash 的 ls/find 替代）',
  SendMessage: '本部署子代理不可用：无 SendMessage（子代理回话走 RespondToCoordinator/最终输出）',
  CronCreate: '本部署子代理不可用：定时任务工具不在子代理工具面内',
  CronList: '本部署子代理不可用：定时任务工具不在子代理工具面内',
  CronUpdate: '本部署子代理不可用：定时任务工具不在子代理工具面内',
  CronDelete: '本部署子代理不可用：定时任务工具不在子代理工具面内'
});

const SUBAGENT_TOOL_SET = new Set(SUBAGENT_TOOLS);

/** 供 doctor / 测试引用：某工具名的判定结果 */
export function classifyToolName(name) {
  const t = String(name);
  if (t.startsWith('mcp__')) return { kind: 'mcp' };
  if (SUBAGENT_TOOL_SET.has(t)) return { kind: 'ok' };
  if (t in ENGINE_ONLY_TOOLS) return { kind: 'engine-only', reason: ENGINE_ONLY_TOOLS[t] };
  return { kind: 'unknown' };
}

/**
 * 最小 YAML frontmatter 子集解析：标量 / 行内数组 [a, b] / dash 多行数组 / 嵌套对象(一层缩进)。
 *
 * dash 数组必须支持：`tools:` 后接缩进 `- Read` 是完全合法的 YAML，早期实现把它解析成
 * 「tools 缺失」→ 校验通过 → 而 tools 缺失的语义是「继承全部工具」。只读角色用这种写法时
 * 白名单静默失效、doctor 还报 OK，B1/B11 的结构性只读保证直接被击穿。
 */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const out = {};
  let lastKey = null;
  let listKey = null; // 正在累积 dash 数组的键
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    // dash 数组项：缩进 + `- value`（必须在 kv 判定之前，`- a: b` 不属本仓库形态）
    const dash = rawLine.match(/^\s+-\s+(.*)$/);
    if (dash && listKey) {
      const item = dash[1].trim().replace(/^["']|["']$/g, '');
      if (!Array.isArray(out[listKey])) out[listKey] = [];
      if (item !== '') out[listKey].push(item);
      continue;
    }

    const kv = rawLine.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      const [, key, rawVal] = kv;
      const val = rawVal.trim();
      lastKey = key;
      listKey = null;
      if (val.startsWith('[')) {
        const inner = val.replace(/^\[/, '').replace(/\]\s*$/, '');
        out[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
      } else if (val === '' || val === '{}' || val === '[]') {
        if (val === '{}') out[key] = {};
        else if (val === '[]') out[key] = [];
        else {
          out[key] = undefined; // 可能后续有缩进项（对象或 dash 数组）
          listKey = key;
        }
      } else if (/^\d+$/.test(val)) {
        out[key] = Number(val);
      } else {
        out[key] = val.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      }
      continue;
    }
    const sub = rawLine.match(/^\s+(\w[\w-]*)\s*:\s*(.*)$/);
    if (sub && lastKey) {
      listKey = null;
      if (typeof out[lastKey] !== 'object' || out[lastKey] === null || Array.isArray(out[lastKey])) out[lastKey] = {};
      const subVal = sub[2].trim();
      out[lastKey][sub[1]] = /^".*"$/.test(subVal) || /^'.*'$/.test(subVal) ? subVal.slice(1, -1) : subVal;
    }
  }
  return out;
}

/**
 * 第二道防线：即便解析器又退化，只要原文里 `<key>:` 后紧跟缩进 dash 行，就必须解析出数组。
 * 解析结果为 undefined 时报明确错误而不是放过——「静默丢弃 tools 白名单」是本项目最贵的坑。
 */
export function detectDroppedDashArrays(text, fm) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const dropped = [];
  for (let i = 0; i < lines.length; i += 1) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*$/);
    if (!kv) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j += 1;
    if (j >= lines.length || !/^\s+-\s+\S/.test(lines[j])) continue;
    const key = kv[1];
    if (!Array.isArray(fm?.[key])) dropped.push(key);
  }
  return dropped;
}

function checkAgentFile(file, errors) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const fm = parseFrontmatter(text);
  const base = path.basename(file);
  if (!fm) return errors.push(`${base}: 缺少 frontmatter`);
  for (const key of detectDroppedDashArrays(text, fm)) {
    errors.push(`${base}: '${key}:' 后是 YAML dash 数组但解析结果不是数组——解析器丢弃了该字段（若为 tools，语义会退化成「继承全部工具」，B1 白名单静默失效）`);
  }
  if (!fm.name) errors.push(`${base}: 缺 name`);
  if (fm.name && fm.name !== base.replace(/\.md$/, '')) errors.push(`${base}: name(${fm.name}) 与文件名不一致`);
  if (!fm.description) errors.push(`${base}: 缺 description`);
  if (fm.description) {
    if (!/^当.+时委派/.test(fm.description)) errors.push(`${base}: description 首句必须是触发条件(当…时委派)`);
    const sentences = fm.description.split(/(?<=[。！？!?])/).filter((s) => s.trim());
    if (sentences.length > 2) errors.push(`${base}: description 超过 2 句(${sentences.length})——违反预算纪律`);
    if ([...fm.description].length > 120) errors.push(`${base}: description 过长(${[...fm.description].length} 字符)`);
  }
  for (const k of Object.keys(fm)) {
    if (!KNOWN_AGENT_FIELDS.has(k)) errors.push(`${base}: 未知 frontmatter 字段 '${k}'`);
  }
  if (fm.tools !== undefined) {
    if (Array.isArray(fm.tools)) {
      for (const t of fm.tools) {
        const c = classifyToolName(t);
        if (c.kind === 'engine-only') errors.push(`${base}: tools 含子代理拿不到的工具 '${t}'——${c.reason}`);
        else if (c.kind === 'unknown') errors.push(`${base}: tools 含未知名称 '${t}'（可用：${SUBAGENT_TOOLS.join('/')} 或 mcp__* 前缀）`);
      }
    } else {
      errors.push(`${base}: tools 必须是 YAML 数组（B1）`);
    }
  }
  if (fm.thoughtLevel !== undefined && !THOUGHT_LEVELS.has(String(fm.thoughtLevel))) {
    errors.push(`${base}: thoughtLevel 非法值 '${fm.thoughtLevel}'（off/low/medium/high/max）`);
  }
  // mcpservers/mcpServers 大小写
  if (fm.mcpservers !== undefined) errors.push(`${base}: 字段名应为 mcpServers`);
  if (fm.maxTurns !== undefined && (typeof fm.maxTurns !== 'number' || fm.maxTurns < 1)) {
    errors.push(`${base}: maxTurns 必须是正整数`);
  }
}

function checkSkill(dir, errors) {
  const f = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(f)) return errors.push(`${path.basename(dir)}: 缺 SKILL.md`);
  const fm = parseFrontmatter(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  if (!fm) return errors.push(`${path.basename(dir)}: SKILL.md 缺 frontmatter`);
  if (!fm.name) errors.push(`${path.basename(dir)}: SKILL.md frontmatter 缺 name`);
  if (!fm.description) errors.push(`${path.basename(dir)}: SKILL.md frontmatter 缺 description`);
  if (fm.description && !/仅当|当.+激活|不得激活/.test(fm.description)) {
    errors.push(`${path.basename(dir)}: skill description 应含严格触发语义(防误触发)`);
  }
}

function checkCommand(file, errors) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const fm = parseFrontmatter(text);
  const base = path.basename(file);
  if (!fm) return errors.push(`${base}: 缺 frontmatter`);
  if (!fm.description) errors.push(`${base}: 缺 description`);
  if (/`{3}!\r?\n/.test(text) === false && base === 'omz-status.md') {
    errors.push(base + ': 应包含 ```! 内联执行块');
  }
}

export function validateAll(root) {
  const errors = [];
  const agentsDir = path.join(root, 'agents');
  for (const f of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
    checkAgentFile(path.join(agentsDir, f), errors);
  }
  const skillsDir = path.join(root, 'skills');
  for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (d.isDirectory()) checkSkill(path.join(skillsDir, d.name), errors);
  }
  const cmdsDir = path.join(root, 'commands');
  for (const f of fs.readdirSync(cmdsDir).filter((n) => n.endsWith('.md'))) {
    checkCommand(path.join(cmdsDir, f), errors);
  }
  return errors;
}

if (isMainModule(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.resolve(moduleDir(import.meta.url), '..'));
  const errors = validateAll(root);
  if (errors.length) {
    console.error('frontmatter 校验失败：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('frontmatter 校验通过（agents/commands/skills）');
}
