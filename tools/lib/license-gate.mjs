/**
 * tools/lib/license-gate.mjs
 * upstream/omo-sources.lock.json 里 license.<key> 条目的**唯一判据实现**。
 *
 * 【判断同源、严重度按调用方职责分化】
 * 这个文件只回答一个问题：这条许可证记录的取证完整度处于哪一档（ok / incomplete / unverified /
 * missing）。它**不决定**该档位是 FAIL 还是 WARN——那是调用方的职责，两侧有意不同，不要抹平：
 *   · tools/doctor.mjs 的 supply:upstream-license 是**发布门**：ok → OK，其余三档一律 FAIL。
 *   · tools/sync-omo-skills.mjs 的 loadLock() 是**同步前提示**：ok → 静默，incomplete/unverified
 *     → WARN（退出码仍 0，不阻断同步流程），missing（整条记录不存在）→ 保持它原有的
 *     ERROR/exit 1 语义（lock 结构缺失是结构性错误，与"核验没做完"不是一回事）。
 * 之前两侧各写一份判据，松紧差了两个量级：doctor 看四项，sync 只看 `status` 存在且不以
 * `unverified` 开头——于是 status: "pending" / "TODO" / 甚至 "x" 都能从 sync 静默过去，
 * 且完全不看 spdx/verified_at/verified_via。现在判断收敛到这里，两侧共用同一个函数。
 *
 * 【四项判据】
 *   ① status 以 verified 开头且不含 unverified —— 核验维度本身（spdx 非空 ≠ 已核验）
 *   ② spdx 非空 —— 协议名
 *   ③ verified_at、④ verified_via —— 可复核的取证痕迹：谁在何时用什么核的
 * 只有 ①②③④ 齐备才是 ok。只有 spdx 没有 ③④，等于一条无法复核的断言。
 *
 * 【为什么除了 level 还要给 statusPresent】
 * "status 字段整个不存在" 与 "status 写着 pending/unverified" 在**判据**上同档（都是 unverified：
 * 都没核验），但在 sync-omo-skills 的**退出码契约**上不同档：它原先对缺 status 是
 * ERROR/exit 1（`else if (!lic[key].status) errors.push(…缺 'status')`），只对
 * /^unverified/ 才 WARN。字段缺失是 lock **结构**问题，与"核验没做完"不是一回事。
 * 若只给 level，sync 侧就得靠 reasons 字符串猜，或者把缺 status 降级成 WARN——那是在收紧判据的同时
 * 悄悄放松退出码，属于用重构掩盖行为变更。所以这里额外返回 statusPresent，让 sync 能精确保留原契约。
 *
 * 【已知边界 —— 别把它当强于实际】
 * 四项齐备只证明"有人留下了可复核的取证痕迹"，**不证明值本身正确**：把 spdx 写成
 * "MIT-typo-写错的协议名"、同时补齐 status/verified_at/verified_via 三项，本函数仍返回 ok，
 * doctor 仍报 OK。要判**值**的正确性只能联网比对上游 LICENSE 原文，而 doctor 与
 * sync-omo-skills 都是**离线**检查（零依赖、不联网、不执行 git），做不到也不应偷偷去做。
 * 因此本判据的真实语义是"取证痕迹完整性"，不是"许可证结论正确性"；后者归项目所有者，
 * 核实途径见 VERIFY_COMMAND。
 *
 * 【字段形态差异（实测 lock 现状）与 proof 档的适用范围】
 * license.omo 有全部四项；license.codegraph 只有 spdx + status（status 是
 * "verified — 上游 README 声明 MIT（…）"，无 verified_at/verified_via）。这不是漏填，是**两类条目**：
 *   · **移植来源**（omo）：我们从它搬了协议语义，I6 要求许可证边界必须有可复核的取证痕迹
 *     → 四项全要（③④ 是硬要求）。
 *   · **外部依赖**（codegraph）：作为独立 MCP 接入、不 fork、无移植文本，其供应链取证由
 *     doctor 的 supply:codegraph（版本可得性）与 NOTICE 承担 → 只要 ①② （status + spdx）。
 * 这个「谁要 proof」的划分是**判据的一部分，两侧共用**（不是严重度，不归调用方），因此声明在本文件：
 * 见 PROOF_EXEMPT_KEYS。方向是 fail-closed：**默认要 proof**，只有显式列进豁免集的 key 才免；
 * 将来新增任何移植来源条目，不动这里就自动落进严格档。豁免只减 ③④ 两项，①② 对所有条目一视同仁
 * （所以 codegraph 的 status 被改成 "pending" 仍会被判 unverified——旧 sync 判据对此静默通过）。
 */

/** 核实上游许可证的命令（doctor/sync 的 fix 文案共用，避免两处漂移）。 */
export const VERIFY_COMMAND = 'curl -s https://api.github.com/repos/code-yeongyu/oh-my-openagent/license';

/** 四项判据里"取证痕迹"那两项的字段名。 */
export const PROOF_FIELDS = ['verified_at', 'verified_via'];

/**
 * 免 ③④ 取证痕迹的条目 key（**只减 proof 两项，不减 status/spdx**）。
 * codegraph 是外部 MCP 依赖而非移植来源：不 fork、不搬文本，许可证结论来自上游 README 的 MIT 声明，
 * 供应链取证由 supply:codegraph 与 NOTICE 承担。往这个集合里加 key 等于宣布"该条目不是移植来源"，
 * 是需要理由的动作——别为了消 WARN 往里加。
 */
export const PROOF_EXEMPT_KEYS = new Set(['codegraph']);

/** 该 key 是否必须带 verified_at/verified_via。未知 key 默认**要**（fail-closed）。 */
export function requiresProof(key) {
  return !PROOF_EXEMPT_KEYS.has(key);
}

/** 取字符串字段并 trim；非字符串按空串处理（null/undefined/数字都算缺）。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 判定一条 license.<key> 记录的取证完整度。**只做判断，不定严重度。**
 *
 * @param {unknown} entry lock.license[key]，可为 undefined/null（视为 missing）
 * @param {{ key?: string }} [opts] key 决定是否要求 ③④ 取证痕迹（见 PROOF_EXEMPT_KEYS），也进 reasons 文案
 * @returns {{ level: 'ok'|'incomplete'|'unverified'|'missing', reasons: string[], missingFields: string[],
 *            status: string, spdx: string, proofRequired: boolean, statusPresent: boolean }}
 *   level          四档；语义见文件头
 *   reasons        人可读的判定理由（每条可直接进 doctor 的 detail / sync 的 WARN 文案）
 *   missingFields  需回填的字段名清单（供 fix 文案列出）
 *   status/spdx    已 trim 的取值，便于调用方回显（缺失为空串）
 *   proofRequired  该 key 是否被要求带 verified_at/verified_via
 *   statusPresent  status 字段本身是否存在且非空——sync 侧靠它区分"结构缺字段"（ERROR/exit 1）
 *                  与"核验没做完"（WARN），见文件头
 */
export function evaluateLicenseEntry(entry, { key = 'omo' } = {}) {
  const label = `license.${key}`;
  const proofRequired = requiresProof(key);
  if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      level: 'missing',
      reasons: [`${label} 记录不存在（或不是对象）——许可证边界无留档（I6）`],
      missingFields: ['spdx', 'status', ...(proofRequired ? PROOF_FIELDS : [])],
      status: '',
      spdx: '',
      proofRequired,
      statusPresent: false
    };
  }

  const status = str(entry.status);
  const spdx = str(entry.spdx);
  const statusPresent = status !== '';
  // ③④ 只对非豁免 key 计入（豁免见 PROOF_EXEMPT_KEYS：外部依赖不是移植来源）
  const missingProof = proofRequired ? PROOF_FIELDS.filter((f) => str(entry[f]) === '') : [];

  // ① status 是核验维度：缺失、含 unverified、或不以 verified 开头（pending / TODO / x 都在此列）
  if (!statusPresent || /unverified/i.test(status) || !/^verified/i.test(status)) {
    const missingFields = [];
    if (!statusPresent || !/^verified/i.test(status)) missingFields.push('status');
    if (spdx === '') missingFields.push('spdx');
    missingFields.push(...missingProof);
    return {
      level: 'unverified',
      reasons: [
        `${label} 未核验（status=${status || '无记录'}${spdx ? `，但已填 spdx=${spdx}` : ''}）` +
          '——spdx 非空不等于已核验，status 才是核验维度'
      ],
      missingFields,
      status,
      spdx,
      proofRequired,
      statusPresent
    };
  }

  // ②③④ status 已标已核验，检查取证是否完整
  const reasons = [];
  const missingFields = [];
  if (spdx === '') {
    reasons.push(`${label}.spdx 为空——status=${status} 已标已核验但协议名缺失，取证不完整`);
    missingFields.push('spdx');
  }
  if (missingProof.length) {
    reasons.push(
      `${label} 缺可追溯凭据：${missingProof.join('、')}` +
        '——只有 spdx 没有取证痕迹时无法复核（谁在何时用什么核的），视为手填'
    );
    missingFields.push(...missingProof);
  }
  if (missingFields.length) {
    return { level: 'incomplete', reasons, missingFields, status, spdx, proofRequired, statusPresent };
  }

  const proofText = proofRequired
    ? `（verified_at=${str(entry.verified_at)}；verified_via=${str(entry.verified_via)}）`
    : '（外部依赖，免 verified_at/verified_via）';
  return {
    level: 'ok',
    reasons: [`${label} spdx=${spdx} status=${status}${proofText}`],
    missingFields: [],
    status,
    spdx,
    proofRequired,
    statusPresent
  };
}

/** reasons 拼成单行文案（两侧输出都是单行，避免各自写一遍 join）。 */
export function licenseReasonText(result) {
  return result.reasons.join('；');
}
