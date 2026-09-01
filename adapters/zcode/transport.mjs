/**
 * adapters/zcode/transport.mjs
 * worker transport 状态机（DESIGN §7.4 resume 适配器 / B9 resume 不可用回退 / §12.3 通知时序）。
 *
 * 【核心语义 · DESIGN §13.5 I3】transport_state 与 coordinator 的任务 state 是两个独立维度，
 * 不得互相推断：transport_state 只描述「OMZ 与某个 ZCode agent 实例的关联还成不成立」，
 * 它既不能证明任务已完成，也不能证明任务未执行；任务完成只能由
 * worker DoneClaim + coordinator complete + 独立 verifier 三方共同判定。
 *
 * 本模块是纯状态机，不 spawn 任何进程、不发 SendMessage，所有更新都是不可变返回新对象。
 */
import path from 'node:path';
import { readJsonSafe, writeJsonSafe, deepNormalizePaths } from './path.mjs';

/** B9：resume 等待 10 分钟上限，超时即回退重新 spawn */
export const RESUME_TIMEOUT_MS = 600000;

export const TRANSPORT_STATES = ['pending', 'running', 'resume-wait', 'returned', 'unknown'];

export function createRegistry({ teamId }) {
  return { team_id: teamId, agents: {}, bindings: {}, updated_at: new Date(0).toISOString() };
}

function cloneRegistry(reg, now) {
  return {
    ...reg,
    agents: { ...(reg?.agents ?? {}) },
    bindings: { ...(reg?.bindings ?? {}) },
    updated_at: new Date(now).toISOString()
  };
}

export function bindAgent(reg, { agent_ref, task_id, role, resume_ref = null, now = Date.now() }) {
  const next = cloneRegistry(reg, now);
  next.agents[agent_ref] = {
    agent_ref,
    task_id,
    role: role ?? null,
    resume_ref,
    transport_state: 'running',
    bound_at: new Date(now).toISOString(),
    resume_wait_since: null,
    returned_at: null,
    result_ref: null
  };
  next.bindings[task_id] = agent_ref; // 反向映射：task_id → agent_ref
  return next;
}

function patchAgent(reg, agent_ref, now, patch) {
  const next = cloneRegistry(reg, now);
  const prev = next.agents[agent_ref];
  if (!prev) {
    // 未登记的 agent_ref 只能落到 unknown，不臆测它在跑（I3）
    next.agents[agent_ref] = {
      agent_ref,
      task_id: null,
      role: null,
      resume_ref: null,
      transport_state: 'unknown',
      bound_at: null,
      resume_wait_since: null,
      returned_at: null,
      result_ref: null,
      ...patch
    };
    return next;
  }
  next.agents[agent_ref] = { ...prev, ...patch };
  return next;
}

export function markResumeWait(reg, { agent_ref, now = Date.now() }) {
  return patchAgent(reg, agent_ref, now, {
    transport_state: 'resume-wait',
    resume_wait_since: new Date(now).toISOString()
  });
}

export function markReturned(reg, { agent_ref, result_ref, now = Date.now() }) {
  return patchAgent(reg, agent_ref, now, {
    transport_state: 'returned',
    result_ref: result_ref ?? null,
    resume_wait_since: null,
    returned_at: new Date(now).toISOString()
  });
}

export function checkTimeouts(reg, { now = Date.now(), timeoutMs = RESUME_TIMEOUT_MS } = {}) {
  const expired = [];
  for (const a of Object.values(reg?.agents ?? {})) {
    if (a.transport_state !== 'resume-wait') continue;
    const since = Date.parse(a.resume_wait_since ?? '');
    if (!Number.isFinite(since)) continue;
    const waited_ms = now - since;
    if (waited_ms >= timeoutMs) expired.push({ agent_ref: a.agent_ref, task_id: a.task_id ?? null, waited_ms });
  }
  return { expired };
}

function summarizeResult(r, i) {
  if (typeof r === 'string') return `${i + 1}. ${r}`;
  const id = r?.task_id ?? r?.task ?? r?.id ?? `result-${i + 1}`;
  const parts = [];
  if (r?.status) parts.push(`status=${r.status}`);
  if (Array.isArray(r?.changed_files) && r.changed_files.length) parts.push(`changed_files=${r.changed_files.join(', ')}`);
  if (r?.result_file) parts.push(`result_file=${r.result_file}`);
  if (r?.summary) parts.push(String(r.summary));
  if (Array.isArray(r?.risks) && r.risks.length) parts.push(`risks=${r.risks.join('; ')}`);
  if (!parts.length) parts.push(JSON.stringify(r));
  return `${i + 1}. ${id} — ${parts.join(' | ')}`;
}

/**
 * B9：resume 失败后重建新 worker 的 prompt CONTEXT 段。
 * 原 results 内容必须并入，信息不丢；宁冗勿省（§12.4 转述损耗）。
 */
export function rebuildPromptContext({ task, priorResults = [], reason }) {
  const id = task?.id ?? '(未知任务 id)';
  const title = task?.title ?? '(无标题)';
  const lines = [];
  lines.push(`## CONTEXT（重建：${reason ?? '未说明原因'}）`);
  lines.push('');
  lines.push(`- 任务 id: ${id}`);
  lines.push(`- 任务 title: ${title}`);
  if (task?.wave !== undefined && task?.wave !== null) lines.push(`- 波次: ${task.wave}`);
  if (task?.subagent_type) lines.push(`- 角色: ${task.subagent_type}`);
  if (task?.result_file) lines.push(`- 结果文件（正斜杠相对路径）: ${task.result_file}`);
  lines.push('');
  lines.push('### 前次执行产出');
  if (!priorResults.length) {
    lines.push('（无——前次执行未留下任何 results，按全新任务处理）');
  } else {
    priorResults.forEach((r, i) => lines.push(summarizeResult(r, i)));
  }
  lines.push('');
  lines.push('### 关键约束');
  lines.push('- 这是 resume 失败后的重建执行：不要重复已完成且已验证的改动，先复核上列产出的真实状态。');
  lines.push('- 状态文件与汇报里的路径一律用相对项目根的正斜杠路径（B3）。');
  lines.push('- 写 .omz/ 下 JSON 必须 UTF-8 无 BOM、LF 结尾；禁用 PowerShell 写状态文件（B4）。');
  const mustNot = Array.isArray(task?.prompt?.must_not_do) ? task.prompt.must_not_do : task?.must_not_do;
  if (Array.isArray(mustNot)) for (const m of mustNot) lines.push(`- MUST NOT: ${m}`);
  if (task?.prompt?.context) {
    lines.push('');
    lines.push('### 原始 CONTEXT（原样保留）');
    lines.push(String(task.prompt.context));
  }
  return lines.join('\n');
}

/**
 * teamId 白名单安全化：非 [A-Za-z0-9_-] 一律替换为 _（对齐 hooks/keyword-detect.mjs 的 safeSessionId）。
 * 这是第一道防线——`../../../evil` 会变成 `_________evil`，无法穿越目录。
 */
export function safeTeamId(teamId) {
  const s = teamId === undefined || teamId === null ? '' : String(teamId);
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 96);
}

/**
 * 第二道防线：断言解析后的目标仍在 <projectRoot>/.omz 之下。
 * 安全化可能被将来的改动绕过（比如有人为了支持带斜杠的 team 名放宽了正则），断言是兜底，
 * 让越界在写盘前就抛错而不是静默把状态文件写到项目外。
 */
function assertInsideOmz(projectRoot, file) {
  const base = path.resolve(String(projectRoot ?? '.'), '.omz');
  const target = path.resolve(file);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`transport: 状态文件路径越出 .omz/（拒绝写入）：${target} 不在 ${base} 之下`);
  }
  return target;
}

function registryFile(projectRoot, teamId) {
  const file = path.join(String(projectRoot ?? '.'), '.omz', 'runtime', safeTeamId(teamId), 'state.json');
  return assertInsideOmz(projectRoot, file);
}

export function saveRegistry(projectRoot, reg) {
  const teamId = reg?.team_id;
  if (!teamId) throw new Error('saveRegistry: registry 缺 team_id');
  // 落盘前统一路径值（B3），避免 Windows 绝对路径污染跨会话状态
  const clean = deepNormalizePaths(reg, projectRoot);
  return writeJsonSafe(registryFile(projectRoot, teamId), clean);
}

export function loadRegistry(projectRoot, teamId) {
  const r = readJsonSafe(registryFile(projectRoot, teamId));
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason, registry: createRegistry({ teamId }) };
  const reg = r.value ?? {};
  return {
    ok: true,
    error: null,
    reason: null,
    registry: { ...createRegistry({ teamId }), ...reg, agents: reg.agents ?? {}, bindings: reg.bindings ?? {} }
  };
}
