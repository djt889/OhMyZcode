/**
 * adapters/zcode/boulder.mjs
 * Boulder 槽位层（DESIGN B32：多会话同根并发丢数据）。
 *
 * 【为什么不是加锁】
 * 旧实现把 `.omz/boulder.json` 当单值事实源：`active_goal` / `works` / `session_ids` 各一个槽。
 * 两个会话在同一项目根各跑一次 /ulw，第二个会话写 boulder 时会把第一个的指针整体覆盖——
 * goal 文件都还在，但指向它们的指针只剩一个，先写的会话此后读到的是别人的目标。
 * 文件锁解决不了这件事：`writeJsonSafe` 用 tmp + rename，本来就不会写出半截文件；
 * 加锁只是让第二个会话排队，排完照样覆盖。**病根是「单槽位两个主人」，不是写的时机。**
 *
 * 【为什么槽位化不需要锁】
 * 每个会话只写 `.omz/boulder/<stem>.json` 这一个属于自己的文件，从不碰别人的；
 * 发现机制是 readdir 那个目录——**目录本身就是索引**。没有共享可变索引，就没有丢更新。
 * 派生视图 `.omz/boulder.json` 只喂 tools/render-status.mjs 与 dashboard，
 * **永不参与续跑决策**，所以它输给竞态也无害（这是「不需要锁」的另一半理由）。
 *
 * 【B18 的真实要求是「可发现」，不是「单值」】
 * 新会话要能找回未关闭的目标——它需要一个固定的发现入口，不需要那个入口只有一个答案。
 * 有两个未关闭目标时，正确行为是列出来让用户选（resolveContinuation 的 choose 分支），
 * 而不是只保留一个。单值只是「假设同时只有一个会话」时最省事的编码。
 *
 * 纪律：本模块所有 JSON 读写都走 ./path.mjs（唯一入口），路径一律正斜杠相对形态（B3），
 * 落盘 UTF-8 无 BOM + LF（B4）。stem 与 goal 文件同源，由 /ulw 第零步产出（B30）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonSafe, normalizePathFields, toPosixRelative } from './path.mjs';

/** 槽位目录与派生视图的仓库内相对路径（正斜杠形态，可直接写进状态文件） */
export const BOULDER_DIR_REL = '.omz/boulder';
export const BOULDER_VIEW_REL = '.omz/boulder.json';

/** boulder 状态三态（OmO v2 原枚举，不扩不改） */
export const BOULDER_STATUSES = Object.freeze(['active', 'paused', 'done']);

/** 未关闭 = 非 done。paused 也算未关闭（用户暂停了但没放弃）。 */
const isOpen = (slot) => slot?.status !== 'done';

function errText(err) {
  return String(err && err.message ? err.message : err);
}

/**
 * stem 文件名安全化（与 hooks/keyword-detect.mjs 的 safeSessionId、transport 的 safeTeamId
 * **同一字符集**：`[^A-Za-z0-9_-]` 一律替换为 `_`）。
 * 真实 sessionId（`sess_<uuid>`）与回退形态（`<ISO 时间戳>-<git HEAD 短哈希>`）都不含点号，
 * 所以点号不必放行——放行只会产出 `.._.._etc_passwd` 这类含 `..` 的文件名：它虽然不是穿越
 * （分隔符已被吃掉），却和另外两个 safe* 函数不一致，也让「文件名里绝不出现 ..」这条
 * 一眼可查的性质失效。三处保持同一字符集，读者不必逐个确认差异。
 */
export function safeStem(stem) {
  const s = stem === undefined || stem === null ? '' : String(stem).trim();
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 96);
}

/**
 * 第二道防线：断言解析后的目标仍在 <projectRoot>/.omz 之下。
 * 安全化可能被将来的改动放宽（比如有人为了支持带斜杠的 stem 改了正则），
 * 断言是兜底，让越界在写盘前抛错而不是静默把状态写到项目外。
 */
function assertInsideOmz(projectRoot, file) {
  const base = path.resolve(String(projectRoot ?? '.'), '.omz');
  const target = path.resolve(file);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`boulder: 路径越出 .omz/（拒绝读写）：${target} 不在 ${base} 之下`);
  }
  return target;
}

export function boulderDir(projectRoot) {
  return assertInsideOmz(projectRoot, path.join(String(projectRoot ?? '.'), '.omz', 'boulder'));
}

export function slotPath(projectRoot, stem) {
  return assertInsideOmz(projectRoot, path.join(boulderDir(projectRoot), `${safeStem(stem)}.json`));
}

export function viewPath(projectRoot) {
  return assertInsideOmz(projectRoot, path.join(String(projectRoot ?? '.'), '.omz', 'boulder.json'));
}

/**
 * 新建一个 boulder 槽位。
 * OmO v2 原 5 字段（works / active_plan / session_ids / status / worktree_path）字段名一字不改；
 * OMZ 扩展 active_goal / active_team / finished_at（承接 1.7.x）+ stem / updated_at（本轮新增）。
 *
 * `stem` 写进内容而不只靠文件名：槽位要能自证归属，避免有人重命名文件后归属关系失联。
 * `sessionId` 只在拿到**真实值**时进 session_ids——回退命名下保持 `[]`，不塞 'UNAVAILABLE'
 * 之类占位符（B30：占位符本轮自洽、看板照常渲染、doctor 也检不出来，却让下一个会话彻底失准）。
 */
export function createBoulder({ stem, sessionId = null, activeGoal = null, now = Date.now() } = {}) {
  const safe = stem === undefined || stem === null || String(stem).trim() === '' ? '' : safeStem(stem);
  if (!safe) throw new Error('createBoulder: 缺 stem（槽位没有 stem 就无法归属；stem 来自 /ulw 第零步）');
  const real = typeof sessionId === 'string' && sessionId.trim() !== '' && sessionId !== 'UNAVAILABLE' ? sessionId : null;
  return {
    works: [],
    active_plan: null,
    session_ids: real ? [real] : [],
    status: 'active',
    worktree_path: null,
    active_goal: activeGoal ?? `.omz/goal/${safe}.json`,
    active_team: null,
    finished_at: null,
    stem: safe,
    updated_at: new Date(now).toISOString()
  };
}

/** 读单个槽位。缺失/损坏一律不抛，按 reason 区分（doctor 要据此给不同修复指令）。 */
export function readSlot(projectRoot, stem) {
  let file;
  try {
    file = slotPath(projectRoot, stem);
  } catch (err) {
    return { ok: false, slot: null, reason: 'unsafe-path', error: errText(err) };
  }
  const r = readJsonSafe(file);
  if (!r.ok) return { ok: false, slot: null, reason: r.reason, error: r.error };
  const value = r.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, slot: null, reason: 'shape', error: '槽位内容不是对象' };
  }
  // 文件名是权威归属：内容里的 stem 缺失或被改过都以文件名为准，避免重命名后归属失联
  return { ok: true, slot: { ...value, stem: value.stem ?? safeStem(stem) }, reason: null, error: null };
}

/**
 * 写单个槽位，并顺带刷新派生视图（调用方不必记得两步）。
 * 落盘前过 normalizePathFields：active_goal / active_plan / worktree_path 都是路径字段，
 * 归一为相对 projectRoot 的正斜杠形态（B3）；非路径字段（note/last_error 等）不受影响。
 */
export function writeSlot(projectRoot, slot, { now = Date.now(), refreshView = true } = {}) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
    throw new Error('writeSlot: slot 必须是对象');
  }
  const stem = slot.stem === undefined || slot.stem === null || String(slot.stem).trim() === '' ? '' : safeStem(slot.stem);
  if (!stem) throw new Error('writeSlot: slot 缺 stem（不产生无主槽位）');
  const next = normalizePathFields({ ...slot, stem, updated_at: new Date(now).toISOString() }, projectRoot);
  const out = writeJsonSafe(slotPath(projectRoot, stem), next);
  if (refreshView) {
    try {
      writeView(projectRoot, { now });
    } catch {
      /* 派生视图写失败不影响事实源——它只是看板投影 */
    }
  }
  return out;
}

/**
 * 枚举全部槽位。**目录即索引**：没有共享可变索引文件，所以并发写入不会丢条目。
 * 损坏槽位进 corrupt 显式暴露，不无声跳过——否则调用方会以为「只有这些目标」。
 */
export function listSlots(projectRoot) {
  const out = { slots: [], corrupt: [] };
  let dir;
  try {
    dir = boulderDir(projectRoot);
  } catch (err) {
    out.corrupt.push({ file: null, reason: errText(err) });
    return out;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 = 首次运行，不是错误
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    const stem = e.name.slice(0, -'.json'.length);
    const r = readSlot(projectRoot, stem);
    if (r.ok) out.slots.push(r.slot);
    else out.corrupt.push({ file: path.join(dir, e.name), reason: r.reason, error: r.error });
  }
  return out;
}

/** updated_at 倒序（最近活动排最前）；缺 updated_at 的历史槽位排末尾但不丢弃。 */
function byRecency(a, b) {
  const ta = Date.parse(a?.updated_at ?? '');
  const tb = Date.parse(b?.updated_at ?? '');
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  if (va && vb) return tb - ta;
  if (va) return -1;
  if (vb) return 1;
  return String(a?.stem ?? '').localeCompare(String(b?.stem ?? ''));
}

/** 未关闭（status 非 done）的槽位，按最近活动倒序。 */
export function openSlots(projectRoot) {
  const { slots, corrupt } = listSlots(projectRoot);
  return { slots: slots.filter(isOpen).sort(byRecency), corrupt };
}

/**
 * 派生视图：给 tools/render-status.mjs 与 dashboard 读的投影。
 * 保留 render-status 依赖的四个顶层字段（active_goal / active_plan / active_team / status），
 * 所以旧看板零改动即可继续工作；另加 open_stems / open_count 让它能显示「还有几个未关闭」。
 * `source: 'derived'` 是防呆标记：这个文件永不参与续跑决策，谁把它当事实源就是回归。
 */
export function deriveView(projectRoot, { now = Date.now() } = {}) {
  const { slots, corrupt } = openSlots(projectRoot);
  const head = slots[0] ?? null;
  return {
    source: 'derived',
    note: '本文件是 .omz/boulder/ 槽位的派生视图，仅供看板读取；续跑决策一律读槽位目录（B32）',
    active_goal: head?.active_goal ?? null,
    active_plan: head?.active_plan ?? null,
    active_team: head?.active_team ?? null,
    status: head ? head.status : 'none',
    open_stems: slots.map((s) => s.stem),
    open_count: slots.length,
    corrupt_count: corrupt.length,
    derived_at: new Date(now).toISOString()
  };
}

export function writeView(projectRoot, { now = Date.now() } = {}) {
  return writeJsonSafe(viewPath(projectRoot), deriveView(projectRoot, { now }));
}

/** 从旧 boulder.json 的 active_goal 推 stem（`.omz/goal/<stem>.json` → `<stem>`）。 */
function stemFromGoalPath(activeGoal) {
  if (typeof activeGoal !== 'string' || activeGoal.trim() === '') return null;
  const base = path.basename(activeGoal.split('\\').join('/'));
  const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -'.json'.length) : base;
  return stem.trim() === '' ? null : safeStem(stem);
}

/**
 * 一次性迁移：把 1.7.x 的旧单文件 boulder.json 迁成一个槽位。
 *
 * 幂等且可重入：槽位目录已有内容时直接返回 migrated:false，绝不覆盖用户后续更新。
 * 旧文件损坏时**不猜着迁**（reason: 'legacy-unreadable'）——迁移是升级路径上唯一会碰用户
 * 既有数据的动作，宁可让人看到「读不出来」，也不能用猜出来的内容顶上。
 * stem 优先从 active_goal 的文件名推导（与 goal 文件同源）；推不出时用确定的时间戳回退。
 */
export function migrateLegacyView(projectRoot, { now = Date.now() } = {}) {
  const existing = listSlots(projectRoot);
  if (existing.slots.length > 0 || existing.corrupt.length > 0) {
    return { migrated: false, reason: 'slots-present', stem: null };
  }
  const file = viewPath(projectRoot);
  if (!fs.existsSync(file)) return { migrated: false, reason: 'no-legacy', stem: null };

  const r = readJsonSafe(file);
  if (!r.ok) return { migrated: false, reason: 'legacy-unreadable', stem: null, error: r.error };
  const legacy = r.value;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return { migrated: false, reason: 'legacy-unreadable', stem: null, error: '旧 boulder.json 顶层不是对象' };
  }
  // 已经是派生视图（本模块自己写的）——不是待迁移的旧事实源
  if (legacy.source === 'derived') return { migrated: false, reason: 'already-derived', stem: null };

  const iso = new Date(now).toISOString();
  const stem = stemFromGoalPath(legacy.active_goal) ?? safeStem(`${iso.slice(0, 13)}${iso.slice(14, 16)}-migrated`);
  const slot = {
    ...createBoulder({ stem, activeGoal: legacy.active_goal ?? null, now }),
    ...legacy,
    stem,
    updated_at: iso
  };
  // legacy 里可能没有这两个扩展字段，补齐以免下游读到 undefined
  if (slot.active_team === undefined) slot.active_team = null;
  if (slot.finished_at === undefined) slot.finished_at = null;
  if (slot.active_goal === undefined || slot.active_goal === null) slot.active_goal = `.omz/goal/${stem}.json`;

  writeSlot(projectRoot, slot, { now });
  return { migrated: true, reason: null, stem, legacyFile: toPosixRelative(file, projectRoot) };
}

/**
 * 续跑决策（B18 + B32）。三分支：
 *   - fresh：没有未关闭槽位 → 全新开始，不必问用户
 *   - confirm：恰好一个 → 问「续跑还是放弃」（1.7.x 的行为）
 *   - choose：两个及以上 → 列出候选让用户选
 *
 * choose 分支顺带修掉一个单会话下就存在的隐患：旧实现里三天前的陈旧 boulder 也会
 * 静默变成「那个」指针，用户根本不知道自己在续什么。现在候选一律带 stem / active_goal /
 * updated_at / status，足以让人判断。
 */
export function resolveContinuation(projectRoot) {
  const { slots, corrupt } = openSlots(projectRoot);
  const action = slots.length === 0 ? 'fresh' : slots.length === 1 ? 'confirm' : 'choose';
  return { action, slots, corrupt };
}
