/**
 * adapters/zcode/fallback.mjs
 * profile 解析与降级链（DESIGN §3.3 四 profile 表 + §15.5 默认配置）。
 * core 恒成立；graph/orchestration/dashboard 任一探测失败只关闭该 profile 并给出可读回退，绝不阻断 core（I2）。
 */
import path from 'node:path';
import { readJsonSafe } from './path.mjs';

/** 严格对齐 DESIGN §15.5 的产品默认值——「已安装 OMZ」不等于「所有聊天进入多 agent 模式」 */
export const DEFAULT_CONFIG = {
  profile: 'core',
  keyword_hook: false,
  graph: { enabled: false },
  orchestration: { enabled: false },
  dashboard: { enabled: false },
  auto_team: false,
  auto_ulw: false
};

const FALLBACKS = {
  core: '不受外部服务影响',
  graph: 'Explore + Bash grep/rg',
  orchestration: 'ZCode 原生后台 spawn + 波次并行（.omz/runtime 文件状态）',
  dashboard: 'ZCode GUI 任务面板 + /omz-status'
};

export function fallbackFor(profile) {
  return FALLBACKS[profile] ?? '无既定回退';
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function loadConfig(projectRoot) {
  const sources = [];
  let config = DEFAULT_CONFIG;

  // 顺序即优先级：后读的覆盖先读的；任一文件缺失/损坏都退回上一层
  const layers = [
    { file: path.join(projectRoot, '.zcode', 'config.json'), pick: (v) => (isPlainObject(v) ? v.omz : undefined) },
    { file: path.join(projectRoot, '.omz', 'config.json'), pick: (v) => v }
  ];

  for (const layer of layers) {
    const r = readJsonSafe(layer.file);
    if (!r.ok) {
      sources.push({ file: layer.file, ok: false, error: `${r.reason}: ${r.error}` });
      continue;
    }
    const patch = layer.pick(r.value);
    if (!isPlainObject(patch)) {
      sources.push({ file: layer.file, ok: true, error: '未含可用的 omz 配置段（已忽略）' });
      continue;
    }
    config = deepMerge(config, patch);
    sources.push({ file: layer.file, ok: true, error: null });
  }

  return { config, sources };
}

function wanted(config, key) {
  const section = config?.[key];
  return isPlainObject(section) ? section.enabled === true : section === true;
}

/**
 * 从 cap 对象里安全取出「可用」与「原因」。
 * caps 可能是 undefined / null / 缺字段 / 字段本身是异常对象（probeAll 里某个 probe 抛过）——
 * §15.3 故障隔离底线：任何形态都不得抛，core 必须永远 true。
 */
function capState(cap, label) {
  if (cap === undefined || cap === null) return { ok: false, reason: `${label} 能力探测不可用（未提供探测结果）` };
  if (typeof cap !== 'object' || Array.isArray(cap)) {
    return { ok: cap === true, reason: cap === true ? null : `${label} 能力探测结果格式异常（${typeof cap}）` };
  }
  if (cap instanceof Error) return { ok: false, reason: `${label} 能力探测异常：${cap.message}` };
  const errors = Array.isArray(cap.errors) ? cap.errors.filter((e) => typeof e === 'string' && e) : [];
  const reasonParts = [];
  if (typeof cap.error === 'string' && cap.error) reasonParts.push(cap.error);
  else if (errors.length) reasonParts.push(errors.join('；'));
  // 三态 stale：'unknown' 表示无法判定索引新鲜度，按不可信处理（I1）
  if (cap.stale === 'unknown') reasonParts.push('无法判定索引新鲜度（stale=unknown），按不可信处理');
  const trustworthy = cap.available === true && cap.stale !== 'unknown';
  if (!trustworthy && !reasonParts.length) reasonParts.push(`${label} 能力探测不可用`);
  return { ok: trustworthy, reason: trustworthy ? null : reasonParts.join('；') };
}

export function resolveProfiles(config, caps = {}) {
  const active = { core: true, graph: false, orchestration: false, dashboard: false };
  const degraded = [];
  const safeCaps = caps && typeof caps === 'object' && !Array.isArray(caps) ? caps : {};

  const rules = [
    { profile: 'graph', cap: safeCaps.codegraph, label: 'codegraph' },
    { profile: 'orchestration', cap: safeCaps.coordinator, label: 'coordinator' },
    { profile: 'dashboard', cap: safeCaps.dashboard, label: 'dashboard' }
  ];

  for (const { profile, cap, label } of rules) {
    let state;
    try {
      if (!wanted(config, profile)) continue; // 未启用不算降级
      state = capState(cap, label);
    } catch (err) {
      // 连判定本身都出错也只关掉该 profile，绝不影响 core（I2）
      degraded.push({
        profile,
        reason: `${label} 能力判定异常：${String(err && err.message ? err.message : err)}`,
        fallback: fallbackFor(profile)
      });
      continue;
    }
    if (state.ok) {
      active[profile] = true;
      continue;
    }
    degraded.push({ profile, reason: state.reason, fallback: fallbackFor(profile) });
  }

  return { active, degraded };
}

export function formatDegradeReport(resolved) {
  const active = Object.entries(resolved?.active ?? { core: true })
    .filter(([, on]) => on)
    .map(([k]) => k);
  // 无降级：默认（仅 core）返回规范串；有额外 profile 生效时一并列出，避免报告失真
  if (!resolved?.degraded?.length) return `profiles: ${active.join(', ') || 'core'}（无降级）`;
  const lines = [`profiles active: ${active.join(', ')}`, `降级 ${resolved.degraded.length} 项：`];
  for (const d of resolved.degraded) {
    lines.push(`  - ${d.profile}: ${d.reason}`);
    lines.push(`    回退 → ${d.fallback}`);
  }
  return lines.join('\n');
}
