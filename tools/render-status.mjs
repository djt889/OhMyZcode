#!/usr/bin/env node
/**
 * OMZ 状态看板渲染器（/omz-status 的执行体）。
 * 读 <cwd>/.omz/，渲染 波次 × 任务 × 状态 表，硬上限 40 行（超出聚合为计数摘要）。
 *
 * 纪律：
 * - JSON 读取一律走 adapters/zcode/path.mjs 的 readJsonSafe（唯一读写入口），并按 reason 分流：
 *   missing（文件不存在/竞态删除）不等于 corrupt（内容坏），两者混为 [corrupt] 会误导排查。
 * - 落表字段全部经 cell() 剥换行/制表符：本面板是 DESIGN B8「唯一事实源」的投影，
 *   任务 title 里带 `\n 1 | T-999 | done | forged` 就能凭空伪造一整行任务。
 * - 波次排序必须按数值：字典序会排出 1 → 10 → 2，把波次面板的语义搞反。
 */
import path from 'node:path';
import { readJsonSafe } from '../adapters/zcode/path.mjs';
import { isMainModule } from './lib/is-main.mjs';
import fs from 'node:fs';

const MAX_LINES = 40;
/** 单元格最大宽度（超出截断），与表格可读性折中 */
const CELL_MAX = 34;

/**
 * 落表前净化。表格是「一行一记录、`|` 分列」的结构：
 * - 换行/制表/回车 → 一行任务的 title 里写 `\n  1 | T-999 | done | forged` 就能凭空多出一行任务；
 * - `|` → 即便不换行，title 里的竖线也会把一列劈成多列，让下游按列解析时错位。
 * 两者都压成安全字符。
 */
export function cell(value, max = CELL_MAX) {
  const s = value === undefined || value === null ? '' : String(value);
  const flat = s
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .split('|')
    .join('\u00a6') // 竖线换成 broken bar：保留可读性，但不再是列分隔符
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** wave 排序键：数字优先且按数值比较；非数字退化为字符串比较并排在数字之后 */
export function compareWave(a, b) {
  const na = typeof a === 'number' ? a : /^\s*-?\d+(\.\d+)?\s*$/.test(String(a)) ? Number(a) : null;
  const nb = typeof b === 'number' ? b : /^\s*-?\d+(\.\d+)?\s*$/.test(String(b)) ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1; // 数字波次优先于 '?' 等非数字
  if (nb !== null) return 1;
  return String(a).localeCompare(String(b));
}

export function collectStatus(omzRoot) {
  const lines = [];
  /** 返回 { value } / { missing:true } / { corrupt:reason }——调用方必须区分缺失与损坏 */
  const readJson = (p) => {
    const r = readJsonSafe(p);
    if (r.ok) return { value: r.value };
    if (r.reason === 'missing') return { missing: true };
    return { corrupt: r.reason, error: r.error };
  };
  const listDir = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  // boulder：跨会话活跃指针
  const boulder = readJson(path.join(omzRoot, 'boulder.json'));
  if (boulder.value) {
    const b = boulder.value;
    lines.push(
      `[boulder] active_goal=${cell(b.active_goal ?? '-')} active_plan=${cell(b.active_plan ?? '-')} team=${cell(b.active_team ?? '-')} status=${cell(b.status ?? '-')}`
    );
  } else if (boulder.corrupt) {
    lines.push(`[boulder] boulder.json [corrupt] (${boulder.corrupt})`);
  }

  // goals
  const goalDir = path.join(omzRoot, 'goal');
  for (const e of listDir(goalDir)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const r = readJson(path.join(goalDir, e.name));
    if (r.missing) continue; // 列目录与读文件之间被删（竞态）——不是损坏，不渲染
    if (r.corrupt) {
      lines.push(`[goal] ${cell(e.name)} [corrupt] (${r.corrupt})`);
      continue;
    }
    const g = r.value ?? {};
    const sc = Array.isArray(g.binary_success_criteria) ? g.binary_success_criteria : [];
    const done = sc.filter((s) => s?.status === 'done').length;
    lines.push(`[goal] ${cell(e.name)} outcome=${cell(g.outcome ?? '', 60)} SC ${done}/${sc.length}`);
  }

  // runtime teams
  const runtimeDir = path.join(omzRoot, 'runtime');
  for (const team of listDir(runtimeDir)) {
    if (!team.isDirectory()) continue;
    const teamDir = path.join(runtimeDir, team.name);
    lines.push(`[team] ${cell(team.name)}`);
    const tasksDir = path.join(teamDir, 'tasks');
    let rows = [];
    for (const t of listDir(tasksDir)) {
      if (!t.isFile() || !t.name.endsWith('.json')) continue;
      const r = readJson(path.join(tasksDir, t.name));
      if (r.missing) continue;
      if (r.corrupt) {
        rows.push({ id: cell(t.name), wave: '?', status: 'corrupt', title: `[corrupt] (${r.corrupt})` });
        continue;
      }
      const task = r.value ?? {};
      rows.push({
        // 显示优先用 key（`A`/`T-3` 这类人可读的任务键）；coordinator 镜像的 `id` 现在是自增数字，
        // 直接显示数字会让波次面板变成 `1 | 1 | …`，看板作为「唯一事实源投影」就失去了指认能力。
        id: cell(task.key ?? task.id ?? t.name, 20),
        wave: typeof task.wave === 'number' ? task.wave : cell(task.wave ?? '?', 8),
        status: cell(task.status ?? '?', 16),
        title: cell(task.title ?? '')
      });
    }
    rows.sort((a, b) => compareWave(a.wave, b.wave) || String(a.id).localeCompare(String(b.id)));
    const header = '  wave | task | status | title';
    rows = [header, ...rows.map((r) => `  ${r.wave} | ${r.id} | ${r.status} | ${r.title}`)];
    lines.push(...rows);
  }

  // plans
  const plansDir = path.join(omzRoot, 'plans');
  for (const e of listDir(plansDir)) {
    if (e.isFile() && e.name.endsWith('.md')) lines.push(`[plan] ${cell(e.name)}`);
  }

  if (lines.length === 0) lines.push('(omz: 无状态——.omz/ 为空或不存在)');
  return lines;
}

export function render(omzRoot, maxLines = MAX_LINES) {
  const lines = collectStatus(omzRoot);
  if (lines.length <= maxLines) return lines.join('\n');
  const head = lines.slice(0, maxLines - 1);
  const overflow = lines.length - (maxLines - 1);
  return [...head, `…(聚合省略 ${overflow} 行;总量 ${lines.length})`].join('\n');
}

if (isMainModule(import.meta.url)) {
  const omzRoot = path.resolve(process.cwd(), '.omz');
  process.stdout.write(render(omzRoot) + '\n');
}
