#!/usr/bin/env node
/**
 * hooks/keyword-detect.mjs
 * M2 触发层：UserPromptSubmit 关键词检测（复刻 OmO 的 IntentGate，DESIGN §8.2）。
 *
 * 硬约束（按本机 zcode-guide/diagnosing-hooks 与 DESIGN 双向对齐）：
 * - 默认关闭：config.keyword_hook !== true 直接不注入（§15.5 产品默认值，普通聊天零侵入）。
 * - B5 互斥：prompt 以 `/` 开头一律不注入（命令系统已展开），会话级标记做第二道防线。
 * - §15.1 误触发红线：关键词出现在反引号/代码块/引号/路径-链接 token 内不得命中。
 * - B15 失败不阻断：CLI 任何异常都输出 `{}` 且 exit 0；诊断只写 stderr。
 * - 输出 schema 严格（guide §2「any extra key fails validation」）：只发 additionalContext，
 *   不注入时输出空对象 `{}`（guide 明示 empty output is fine）。
 * - Windows：node 实现（不用 PowerShell，B4 BOM 坑）；JSON 读写一律走 adapters/zcode/path.mjs。
 * - 3s 超时预算是硬约束：hooks.json 的 timeoutMs=3000 会直接杀进程，被杀就是「无输出」，
 *   fail-open 契约瞬间变成 fail-broken。因此屏蔽分析全程线性扫描 + 自我预算保护（见 SCAN_BUDGET_MS）。
 * - maxOutputBytes 同理是硬约束：引擎量的是 **stdout 的完整 JSON 负载**、缺省仅 32768，超限即整段注入
 *   被静默丢弃（见 ENGINE_DEFAULT_MAX_OUTPUT_BYTES 的取证）。注入体一律按 MAX_PAYLOAD_BYTES 自我裁剪。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonSafe, stripBom } from '../adapters/zcode/path.mjs';
import { loadConfig } from '../adapters/zcode/fallback.mjs';
import { isMainModule, moduleDir } from '../tools/lib/is-main.mjs';

const HERE = moduleDir(import.meta.url);
/** 插件根 = hooks/ 的上一级；ZCode 传 ${ZCODE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT} 时以环境变量为准 */
const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(HERE, '..');

/** 关键词 → 模式。大小写不敏感；匹配必须是独立词（见 WORD_EDGE） */
export const MODE_KEYWORDS = Object.freeze({
  ulw: 'ulw',
  ultrawork: 'ulw',
  'ultra-work': 'ulw',
  team: 'team',
  hyperplan: 'hyperplan',
  'hyper-plan': 'hyperplan'
});

/** 更具体的模式优先（多命中时取序号大者），DESIGN §8.2 */
const MODE_PRIORITY = { ulw: 1, team: 2, hyperplan: 3 };

/** 中文语境下 `\b` 不可靠：只把 ASCII 字母/数字/下划线/连字符视为词内字符 */
const WORD_CHAR = /[A-Za-z0-9_-]/;

function isWordChar(ch) {
  return typeof ch === 'string' && ch.length === 1 && WORD_CHAR.test(ch);
}

/** 用等长空白替换区间，保持 index 对齐，便于「命中点是否落在代码上下文」判定 */
function blank(len) {
  return ' '.repeat(len);
}

/**
 * 需要屏蔽的代码/引用区域：三反引号块（含未闭合）、~~~ 块、行内反引号、各类引号串。
 *
 * ⚠️ Markdown 链接 `[text](url)` **不在这里**：正则形态 /\[[^\]\r\n]*\]\([^)\r\n]*\)/ 呈灾难性回溯
 * （`'['.repeat(n) + ']('.repeat(n)`：n=32000 实测 18.4s，远超 hooks.json 的 timeoutMs=3000），
 * 被引擎杀掉即无输出 → fail-open 变 fail-broken。改由 maskMarkdownLinks() 单向线性扫描实现。
 * 新增任何屏蔽形态前，必须先用退化输入实测其回溯代价。
 */
const MASK_PATTERNS = [
  /```[\s\S]*?```/g,
  /```[\s\S]*$/g,
  /~~~[\s\S]*?~~~/g,
  /`[^`\r\n]*`/g,
  /"[^"\r\n]*"/g,
  /'[^'\r\n]*'/g,
  /[\u201c][^\u201d\r\n]*[\u201d]/g,
  /[\u2018][^\u2019\r\n]*[\u2019]/g
];

/** 行尾（不含换行符本身）位置；用于失败时整行跳过，保证扫描严格线性 */
function lineEnd(text, from) {
  const nl = text.indexOf('\n', from);
  const cr = text.indexOf('\r', from);
  if (nl === -1 && cr === -1) return text.length;
  if (nl === -1) return cr;
  if (cr === -1) return nl;
  return Math.min(nl, cr);
}

/**
 * Markdown 链接屏蔽：手写单向扫描，无回溯，最坏 O(n)。
 * 规则与原正则等价：`[` → 同行的 `]` → 紧邻必须是 `(` → 同行的 `)`，命中区间整体置空白。
 * 关键是「找不到就把 i 推到行尾」——同一行内更靠后的起点必然也找不到，不必重扫。
 */
export function maskMarkdownLinks(text) {
  const n = text.length;
  let i = 0;
  let out = null; // 惰性建数组：绝大多数 prompt 没有链接，不必复制
  const blankRange = (from, to) => {
    if (!out) out = [...text];
    for (let k = from; k <= to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < n) {
    const open = text.indexOf('[', i);
    if (open === -1) break;
    const eol = lineEnd(text, open);
    const close = text.indexOf(']', open + 1);
    if (close === -1 || close >= eol) {
      i = eol + 1; // 本行没有 `]`，行内任何更后的 `[` 也不会有
      continue;
    }
    if (text[close + 1] !== '(') {
      i = close + 1; // 前进到 `]` 之后，保证单向推进
      continue;
    }
    const paren = text.indexOf(')', close + 2);
    if (paren === -1 || paren >= eol) {
      i = eol + 1; // 本行没有配对 `)`
      continue;
    }
    blankRange(open, paren);
    i = paren + 1;
  }
  return out ? out.join('') : text;
}

/** 路径 / 链接 token：`.` 或 `/` 夹在词字符之间（`src/auth.ts`、`commands/team.md`）。
 *  句末标点不算——`use team.` 的 `team.` 必须仍可命中 */
const TOKEN = /\S+/g;
const PATHY_CORE = /\w[./]\w/;

function isPathyToken(token) {
  const core = token.replace(/^[^\w]+/, '').replace(/[^\w]+$/, '');
  return PATHY_CORE.test(core);
}


/**
 * 把代码/引用区域替换为等长空白——长度不变，命中点索引可直接与输入串对照。
 * deadline（epoch ms）非空时，每个阶段之间检查预算，超时立即返回 { aborted: true }。
 * 导出仅供 self-test 与 doctor 观察，不属稳定 API。
 */
export function maskCodeContextDetailed(text, { deadline = null } = {}) {
  let masked = String(text);
  // `>=` 而非 `>`：budgetMs=0（调用方要求「不许花时间」）必须立即判为超预算，而不是恰好相等时放过
  const overBudget = () => deadline !== null && Date.now() >= deadline;
  for (const re of MASK_PATTERNS) {
    if (overBudget()) return { masked, aborted: true };
    re.lastIndex = 0;
    masked = masked.replace(re, (m) => blank(m.length));
  }
  if (overBudget()) return { masked, aborted: true };
  masked = maskMarkdownLinks(masked);
  if (overBudget()) return { masked, aborted: true };
  masked = masked.replace(TOKEN, (m) => (isPathyToken(m) ? blank(m.length) : m));
  return { masked, aborted: overBudget() };
}

export function maskCodeContext(text) {
  return maskCodeContextDetailed(text).masked;
}

/** 词边界受限的全部出现位置（大小写不敏感） */
function wordOccurrences(lower, keyword) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = lower.indexOf(keyword, from);
    if (i === -1) return out;
    const before = i > 0 ? lower[i - 1] : '';
    const after = i + keyword.length < lower.length ? lower[i + keyword.length] : '';
    if (!isWordChar(before) && !isWordChar(after)) out.push(i);
    from = i + 1;
  }
}

/**
 * 屏蔽分析的总扫描预算（字符数）。
 * 上界依据实测（本机 Node v22.14.0，maskCodeContext 单次耗时）：
 *   32KB → 最坏 8ms ｜ 64KB → 17ms ｜ 256KB → 177ms ｜ 1MB → 2672ms
 * （最坏形态是「链接+反引号+引号+路径 token 混排」，它在 TOKEN 阶段呈超线性。）
 * 32KB 相对 hooks.json 的 timeoutMs=3000 有约 350x 余量，被畸形输入逼近预算几乎不可能。
 */
const MAX_SCAN = 32 * 1024;
/** 头窗 / 尾窗：模式词要么在指令开头，要么在长贴文末尾的收尾句里，两头都要看到 */
const SCAN_HEAD = 24 * 1024;
const SCAN_TAIL = MAX_SCAN - SCAN_HEAD;

/**
 * 切出待扫描的片段。超长输入取「头窗 + 尾窗」两段，各自**独立**做屏蔽分析——
 * 拼成一段会让头窗里未闭合的三反引号跨越拼接点吃掉尾窗内容（误判成 code-context）。
 */
export function scanSegments(text, { maxScan = MAX_SCAN, head = SCAN_HEAD, tail = SCAN_TAIL } = {}) {
  if (text.length <= maxScan) return [text];
  return [text.slice(0, head), text.slice(text.length - tail)];
}

/**
 * 自我预算：超过它就放弃屏蔽分析、返回不注入。
 * 宁可漏检一次（用户可以显式打 /ulw），也不能被引擎按 timeoutMs 杀掉——被杀等于零字节输出，
 * 而 hook 契约要求「任何情况都要输出 {}」。1500ms 给下游 emit/写 marker 留足余量。
 */
export const SCAN_BUDGET_MS = 1500;

/**
 * 判定顺序（DESIGN §8.2 + §13 B5 + §15.1）：
 * slash-command → 词边界匹配 → 代码/引用上下文排除 → 多命中优先级 → 命中
 *
 * ⚠️ 必须先 toLowerCase 再 mask（同一个字符串）：toLowerCase **可以改变长度**
 * （`İ` → `i̇` 两个 code unit）。早期实现对原串和 masked 串各自 toLowerCase，
 * 一旦屏蔽区之前出现此类字符，两串索引就整体错位，maskedLower.startsWith(keyword, i)
 * 比到错误偏移——真实意图被误判成 code-context 而吞掉。
 */
export function detectMode(prompt, { budgetMs = SCAN_BUDGET_MS } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return { mode: null, matched: [], reason: 'empty' };
  const started = Date.now();
  const deadline = started + Math.max(0, budgetMs);
  if (prompt.trim().startsWith('/')) return { mode: null, matched: [], reason: 'slash-command' };

  const hitModes = new Map(); // mode -> matched keywords（保留原始关键词写法）
  let sawMaskedOnly = false;

  for (const segment of scanSegments(prompt)) {
    const lower = segment.toLowerCase();
    const { masked: maskedLower, aborted } = maskCodeContextDetailed(lower, { deadline });
    if (aborted) {
      // 屏蔽分析没跑完就无法判断关键词是否落在代码/引用里 → 一律不注入
      // （漏检优于误注入，误注入又优于被引擎杀掉——被杀是零字节输出，直接违反 fail-open 契约）
      return { mode: null, matched: [], reason: 'budget-exceeded', elapsedMs: Date.now() - started };
    }
    for (const [keyword, mode] of Object.entries(MODE_KEYWORDS)) {
      const raw = wordOccurrences(lower, keyword);
      if (raw.length === 0) continue;
      // 命中点必须在 masked 串上仍然可见，才算真实意图；否则是代码/引用/路径里的字面量
      if (!raw.some((i) => maskedLower.startsWith(keyword, i))) {
        sawMaskedOnly = true;
        continue;
      }
      const list = hitModes.get(mode) ?? [];
      if (!list.includes(keyword)) list.push(keyword);
      hitModes.set(mode, list);
    }
  }

  if (hitModes.size === 0) {
    return { mode: null, matched: [], reason: sawMaskedOnly ? 'code-context' : 'no-keyword' };
  }

  const modes = [...hitModes.keys()].sort((a, b) => MODE_PRIORITY[b] - MODE_PRIORITY[a]);
  const matched = modes.flatMap((m) => hitModes.get(m));
  return { mode: modes[0], matched, reason: modes.length > 1 ? 'multi-match' : 'keyword' };
}

/** sessionId 文件名安全化：非 [A-Za-z0-9_-] 一律替换为 `_`（防路径穿越与非法字符） */
function safeSessionId(sessionId) {
  const s = sessionId === undefined || sessionId === null ? '' : String(sessionId);
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 96);
}

/**
 * 断言目标文件在 <projectRoot>/.omz 之下，否则抛（与 adapters/zcode/transport.mjs 同一纪律）。
 * sessionId 侧早有安全化，但 projectRoot 侧曾完全无校验：projectRoot='../../../evil'
 * （来自 hook 输入的 cwd/project_dir，属外部输入）会让 marker 写到项目外任意位置。
 */
export function assertInsideOmz(projectRoot, file) {
  const base = path.resolve(String(projectRoot ?? '.'), '.omz');
  const target = path.resolve(file);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`keyword hook: marker 路径越出 .omz/（拒绝写入）：${target} 不在 ${base} 之下`);
  }
  return target;
}

/**
 * projectRoot 净化。engine 给的项目目录一定是绝对路径；**相对**形态只可能来自畸形/恶意输入，
 * 而相对形态正是穿越的载体（'../../../evil' 会 resolve 到项目外并在那里落 marker）。
 * 因此：非绝对路径一律不采信，退回 process.cwd()，并在 stderr 留一行诊断。
 */
export function resolveProjectRoot(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (s === '') return path.resolve(process.cwd());
  if (!path.isAbsolute(s)) {
    try {
      process.stderr.write(`omz keyword hook: 忽略非绝对的 projectRoot('${s.slice(0, 80)}')，改用 process.cwd()（防路径穿越）\n`);
    } catch {
      /* stderr 不可写不影响判定 */
    }
    return path.resolve(process.cwd());
  }
  return path.resolve(s);
}

/**
 * 标记落在 .omz/ 下——该目录已被 .gitignore，不污染仓库（DESIGN §8.2）。
 * projectRoot 一律经 resolveProjectRoot 净化，返回值即已通过越界断言的绝对路径。
 */
export function sessionMarkerPath(projectRoot, sessionId) {
  const root = resolveProjectRoot(projectRoot);
  const file = path.join(root, '.omz', `.mode-injected-${safeSessionId(sessionId)}`);
  return assertInsideOmz(root, file);
}

/** 文件缺失/BOM/损坏/路径越界一律退回空列表，绝不抛（hook 不得因状态文件问题失败） */
export function readMarker(projectRoot, sessionId) {
  let file;
  try {
    file = sessionMarkerPath(projectRoot, sessionId);
  } catch {
    return { modes: [] };
  }
  const r = readJsonSafe(file);
  if (!r.ok) return { modes: [] };
  const modes = Array.isArray(r.value?.modes) ? r.value.modes.filter((m) => typeof m === 'string') : [];
  return { modes };
}

export function alreadyInjected(projectRoot, sessionId, mode) {
  return readMarker(projectRoot, sessionId).modes.includes(mode);
}

/** 幂等追加；写失败也只报告不抛（写不下去最坏结果是重复注入一次，不能拖垮主流程） */
export function markInjected(projectRoot, sessionId, mode) {
  const current = readMarker(projectRoot, sessionId).modes;
  if (current.includes(mode)) return { ok: true, modes: current };
  const modes = [...current, mode];
  try {
    writeJsonSafe(sessionMarkerPath(projectRoot, sessionId), {
      sessionId: String(sessionId ?? ''),
      modes,
      updatedAt: new Date().toISOString()
    });
    return { ok: true, modes };
  } catch (err) {
    return { ok: false, modes, error: String(err?.message ?? err) };
  }
}

const MODE_FILES = { ulw: 'ulw.md', team: 'team.md', hyperplan: 'hyperplan.md' };

/**
 * 引擎缺省 `maxOutputBytes` = 32768。取证（本机 `E:/APP/Zcode/resources/glm/zcode.cjs` 反查，五处同值）：
 * - 运行时缺省配置：`hooks:{enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}`
 * - 另一处同值兜底：`jdi={enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}`
 * - hook 配置归并的缺省常量 `AEo=32768`（`L2e()` 在没有任何 scope 指定时取它）
 * - 插件 hook 合并进运行时 hooks 配置：`maxOutputBytes:e?.maxOutputBytes??32768`
 * - 工作区 hook 的 runtimeRoot：`maxOutputBytes:Q.hooks?.maxOutputBytes??32768`
 * 本文件旧注释里的 65536 来自 `hooks.json` 顶层那个**引擎从不读取**的死字段（v1.4 已删），不是引擎真值。
 *
 * 超限后的真实后果是 fail-broken，且引擎**不会**替我们优雅降级——两条路径都已反查确证：
 * - 插件 / 工作区 hook 走 executionPort：`outputLimit:{maxBufferBytes:i.maxOutputBytes,
 *   maxInlineBytes:i.maxOutputBytes,persistOutput:"none"}`；`OutputCollector.append()` 在
 *   `this.inlineBytes>=this.maxInlineBytes` 后丢弃余下 chunk（只置 `truncated` 标记，hook 路径从不读它），
 *   于是 `parseHookStdout()` 拿到半截 JSON 后 `try{JSON.parse(r)}catch{return}` —— **静默 undefined，
 *   注入被无声丢掉**，连一条错误都不产生（比报错更难发现）。
 * - 另一形态 `runGitCommand()` 是**直接杀进程**：`Buffer.byteLength(i,'utf8')>r.maxOutputBytes&&
 *   (o.kill(),l({exitCode:-1,stdout:i}))`。它服务 `resolveWorkspaceGitBranch`（自带 512 字节缺省），
 *   不在 hook 执行链上；但它说明引擎对「超出 maxOutputBytes」的通用态度是杀/丢，不是安全截断。
 * 结论：注入体必须**在写 stdout 之前**就落在预算内。
 */
export const ENGINE_DEFAULT_MAX_OUTPUT_BYTES = 32768;

/**
 * 预算余量。`maxOutputBytes` 可被用户配置（`~/.zcode/cli/config.json` 的 `hooks.maxOutputBytes`）或
 * 工作区配置改小，而 hook 进程**拿不到那个值**（引擎不通过 stdin/env 下发），只能按缺省值下限保守估。
 * 8KB = 缺省值的 25%：既能吸收「用户把上限调到 24–32KB」这类常见收紧，也不至于把可注入体压得没意义。
 */
export const PAYLOAD_SAFETY_MARGIN_BYTES = 8 * 1024;

/**
 * stdout 的 JSON 负载预算（24576）。**这才是判定对象**：引擎量的是 stdout 累计字节数，
 * 也就是 `JSON.stringify({additionalContext})` 的完整字节数，而不是 additionalContext 字符串本身。
 * 实测差值：`additionalContext` 11105 字节 → JSON 负载 11372（+267），转义越多差得越大。
 */
export const MAX_PAYLOAD_BYTES = ENGINE_DEFAULT_MAX_OUTPUT_BYTES - PAYLOAD_SAFETY_MARGIN_BYTES;

const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

/** JSON 信封固定开销：`{"additionalContext":""}` = 24 字节（不含正文与转义） */
const JSON_ENVELOPE_BYTES = utf8Len(JSON.stringify({ additionalContext: '' }));

/**
 * `additionalContext` 字符串的**软**上限（24552），由负载预算反推：`MAX_PAYLOAD_BYTES - 信封开销`。
 *
 * 它**不参与任何判定**——降级逻辑一律直接二分实测 JSON 负载（见 fitHeadBytes）。保留它只有两个作用：
 * ① 既有导出面（外部读者/文档引用的那个"注入上限"符号）不断裂；② 给人一个"字符串大概能写多长"的量级参考。
 * 之所以派生而非手写：JSON 转义（`"` `\` 控制字符最多 1→6 字节）让字符串长度与负载没有固定关系，
 * 任何手写的字符串上限都可能像 v1.5 之前的 48KB（49152 > 引擎 32768）那样悄悄错位到引擎真墙之上；
 * 派生之后它恒 < MAX_PAYLOAD_BYTES < ENGINE_DEFAULT_MAX_OUTPUT_BYTES，这条不变量由测试钉死。
 */
export const MAX_CONTEXT_BYTES = MAX_PAYLOAD_BYTES - JSON_ENVELOPE_BYTES;

/** 引擎在 stdout 上真正量的字节数：完整 JSON 负载，不是 additionalContext 字符串 */
export function payloadBytes(additionalContext) {
  return utf8Len(JSON.stringify({ additionalContext: String(additionalContext ?? '') }));
}

/** 按 UTF-8 字节数截断到字符边界（不切出半个码点） */
function truncateUtf8(text, maxBytes) {
  if (utf8Len(text) <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // toString 会把结尾不完整的多字节序列变成 U+FFFD，去掉它即可回到字符边界
  return buf.toString('utf8').replace(/\uFFFD+$/, '');
}

/**
 * 硬裁到负载预算内：最后一道兜底，只在「连提示行都放不下」的病态预算下触发。
 * 前缀越短负载越小（单调），故可二分。宁可把注释切断，也不能让负载越预算。
 */
function fitToPayload(text, maxPayloadBytes) {
  if (payloadBytes(text) <= maxPayloadBytes) return text;
  let lo = 0;
  let hi = utf8Len(text);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (payloadBytes(truncateUtf8(text, mid)) <= maxPayloadBytes) lo = mid;
    else hi = mid - 1;
  }
  return truncateUtf8(text, lo);
}

/**
 * 求「头窗最多能放多少字节」：payload(compose(h)) 对 h 单调不减（更长前缀 → 更长 JSON），故可二分。
 * 返回 -1 表示连 h=0（不带头部）都超预算，调用方据此再降一级。
 * 二分而非「按超出量回减」：JSON 转义可以把 1 字节放大成 6 字节（`"` → `\"`、控制字符 → `\uXXXX`），
 * 线性回减在这种输入上会一次性把头窗砍到 0，浪费掉本来放得下的空间。
 */
function fitHeadBytes(compose, maxBytes, maxPayloadBytes) {
  if (payloadBytes(compose(0)) > maxPayloadBytes) return -1;
  let lo = 0;
  let hi = maxBytes;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (payloadBytes(compose(mid)) <= maxPayloadBytes) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 一级降级：头部（协议开头的目的/约束段）+ 各 Markdown 章节标题清单 + 显式提示。
 * 与「原文截断」相比，保留章节骨架能让模型知道协议还有哪些部分，并明确告知走 /<mode> 拿全文。
 *
 * ⚠️ 自我验证：字符串长度只是自变量，闸门是 JSON 负载——头窗大小由 fitHeadBytes 二分实测得出。
 * 章节清单与提示行始终完整保留（它们才是降级的价值）；清单本身就撑爆预算时返回 null，降到二级。
 */
function summarizeBody(mode, body, banner, maxPayloadBytes) {
  const headings = body
    .split(/\r?\n/)
    .filter((l) => /^#{1,4}\s+\S/.test(l))
    .map((l) => l.trim());
  const tail =
    `\n\n<!-- OMZ keyword hook: 协议全文 ${utf8Len(body)} 字节，超过注入负载预算 ${maxPayloadBytes} 字节，` +
    `已降级为「头部 + 章节清单」。需要完整协议请显式执行 /${mode}。 -->\n` +
    (headings.length ? `\n协议章节清单（全文见 /${mode}）：\n${headings.map((h) => `- ${h.replace(/^#+\s*/, '')}`).join('\n')}\n` : '');
  const compose = (h) => `${banner}\n\n${h > 0 ? truncateUtf8(body, h) : ''}${tail}`;
  const head = fitHeadBytes(compose, utf8Len(body), maxPayloadBytes);
  return head < 0 ? null : compose(head);
}

/**
 * 二级降级：只保留头部 + 一行「内容过长，请显式跑 /<mode>」。
 * 章节清单本身就超预算时（例如几千个 `## ` 标题）走这里。头窗同样二分实测；
 * 末尾 fitToPayload 是兜底，保证**不存在**「降级了但仍超限」的返回路径。
 */
function minimalBody(mode, body, banner, maxPayloadBytes) {
  const notice =
    `\n\n<!-- OMZ keyword hook: 协议全文 ${utf8Len(body)} 字节，连「章节清单」都超出注入负载预算 ` +
    `${maxPayloadBytes} 字节，已降到最简：仅保留开头。内容过长，请显式执行 /${mode} 获取完整协议。 -->\n`;
  const compose = (h) => `${banner}\n\n${h > 0 ? truncateUtf8(body, h) : ''}${notice}`;
  const head = fitHeadBytes(compose, utf8Len(body), maxPayloadBytes);
  // head < 0 只可能出现在病态预算（banner+提示行本身就超）——硬裁保底，绝不返回超预算的串
  return head < 0 ? fitToPayload(compose(0), maxPayloadBytes) : compose(head);
}

/** 降级诊断只走 stderr（stdout 必须保持严格 schema）；stderr 不可写不影响注入 */
function warnDegrade(file, level, bodyBytes, fullPayload, maxPayloadBytes, finalPayload) {
  try {
    process.stderr.write(
      `omz keyword hook: commands/${file} 正文 ${bodyBytes} 字节（原始 JSON 负载 ${fullPayload} 字节）超过负载预算 ` +
        `${maxPayloadBytes} 字节，已降级为 ${level}（降级后负载 ${finalPayload} 字节；` +
        `引擎缺省 maxOutputBytes=${ENGINE_DEFAULT_MAX_OUTPUT_BYTES}，超限会静默丢弃整段注入）\n`
    );
  } catch {
    /* stderr 不可写不影响注入 */
  }
}

/**
 * 注入文本 = 来源说明行 + 命令体，并附带降级诊断。缺文件返回 null（不注入、不抛）。
 * 说明行让模型知道这段协议来自 hook 而非用户，等价 /<mode>，便于人工排查上下文来源。
 *
 * 判定对象是 **stdout 的完整 JSON 负载**（payloadBytes），不是 additionalContext 字符串——
 * 引擎量的就是 stdout 字节数。三级：full → headings → minimal，每级返回前都实测负载。
 */
export function buildAdditionalContextDetailed(mode, pluginRoot, matched = [], { maxPayloadBytes = MAX_PAYLOAD_BYTES } = {}) {
  const file = MODE_FILES[mode];
  if (!file || !pluginRoot) return null;
  const full = path.join(String(pluginRoot), 'commands', file);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const body = stripFrontmatter(raw);
  if (!body.trim()) return null;
  const words = (Array.isArray(matched) ? matched : [matched]).filter(Boolean).join(', ');
  const banner = `<!-- OMZ keyword hook: 检测到 "${words || mode}"，注入 ${mode} 模式协议（等价 /${mode}） -->`;
  const bodyBytes = utf8Len(body);

  const whole = `${banner}\n\n${body}`;
  const wholePayload = payloadBytes(whole);
  if (wholePayload <= maxPayloadBytes) {
    return { text: whole, level: 'full', payloadBytes: wholePayload, bodyBytes };
  }

  const summarized = summarizeBody(mode, body, banner, maxPayloadBytes);
  if (summarized !== null) {
    const p = payloadBytes(summarized);
    warnDegrade(file, 'headings（头部+章节清单）', bodyBytes, wholePayload, maxPayloadBytes, p);
    return { text: summarized, level: 'headings', payloadBytes: p, bodyBytes };
  }

  const minimal = minimalBody(mode, body, banner, maxPayloadBytes);
  const p = payloadBytes(minimal);
  warnDegrade(file, 'minimal（仅头部+提示行）', bodyBytes, wholePayload, maxPayloadBytes, p);
  return { text: minimal, level: 'minimal', payloadBytes: p, bodyBytes };
}

/** 兼容既有调用面：只要注入文本。判定与降级全在 buildAdditionalContextDetailed 内。 */
export function buildAdditionalContext(mode, pluginRoot, matched = [], options = {}) {
  const r = buildAdditionalContextDetailed(mode, pluginRoot, matched, options);
  return r === null ? null : r.text;
}

/** 剥掉 YAML frontmatter（命令体才是协议本文；description 是命令面板用的，注入无意义） */
function stripFrontmatter(text) {
  return stripBom(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^\s+/, '');
}

/**
 * hook 主逻辑。除 marker 落盘外无副作用。
 * 判定链：disabled → detectMode → already-injected → command-missing → inject
 */
export function handleHook(input, ctx = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const prompt = typeof src.prompt === 'string' ? src.prompt : typeof src.user_prompt === 'string' ? src.user_prompt : typeof src.userPrompt === 'string' ? src.userPrompt : '';
  const sessionId = src.session_id ?? src.sessionId ?? '';
  const projectRoot = resolveProjectRoot(ctx.projectRoot ?? src.cwd ?? src.project_dir ?? process.cwd());
  const pluginRoot = ctx.pluginRoot ?? PLUGIN_ROOT;
  const config = ctx.config ?? loadConfig(projectRoot).config;

  if (config?.keyword_hook !== true) return { inject: false, reason: 'disabled' };

  const det = detectMode(prompt);
  if (!det.mode) return { inject: false, reason: det.reason };

  if (alreadyInjected(projectRoot, sessionId, det.mode)) {
    return { inject: false, mode: det.mode, reason: 'already-injected' };
  }

  const built = buildAdditionalContextDetailed(det.mode, pluginRoot, det.matched);
  if (!built || !built.text) return { inject: false, mode: det.mode, reason: 'command-missing' };

  const marked = markInjected(projectRoot, sessionId, det.mode);
  return {
    inject: true,
    mode: det.mode,
    matched: det.matched,
    reason: det.reason,
    marker: marked.ok ? 'written' : `write-failed: ${marked.error}`,
    injectionLevel: built.level,
    payloadBytes: built.payloadBytes,
    additionalContext: built.text
  };
}

/* ------------------------------- CLI 层 ------------------------------- */

function readStdin() {
  try {
    return stripBom(fs.readFileSync(0, 'utf8'));
  } catch {
    return '';
  }
}

/**
 * 输出严格 schema（guide §2：多一个键就整体校验失败）。
 * 不注入 → 空对象；注入 → 只带 additionalContext。exit 恒 0（B15 不阻断主流程）。
 */
function emit(result) {
  if (result?.inject && typeof result.additionalContext === 'string') {
    process.stdout.write(JSON.stringify({ additionalContext: result.additionalContext }));
  } else {
    process.stdout.write('{}');
  }
}

function runCli() {
  let result = { inject: false, reason: 'init' };
  try {
    const raw = readStdin();
    let input = {};
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        process.stderr.write('omz keyword hook: stdin 非合法 JSON，静默跳过\n');
        input = {};
      }
    }
    result = handleHook(input, {});
  } catch (err) {
    process.stderr.write(`omz keyword hook: 内部异常已吞掉 -> ${String(err?.message ?? err)}\n`);
    result = { inject: false, reason: 'error' };
  }
  try {
    emit(result);
  } catch {
    process.stdout.write('{}');
  }
  if (result?.reason && result.reason !== 'init') process.stderr.write(`omz keyword hook: ${result.reason}\n`);
  process.exit(0);
}

/* ----------------------------- self-test ----------------------------- */

const CASES = [
  { name: '/ulw 修复登录 → 不注入(slash)', prompt: '/ulw 修复登录', expect: { inject: false, reason: 'slash-command' } },
  { name: '裸 ulw → 注入 ulw', prompt: 'ulw 修复登录 bug', expect: { inject: true, mode: 'ulw' } },
  { name: 'ultrawork this → 注入 ulw', prompt: 'ultrawork this', expect: { inject: true, mode: 'ulw' } },
  { name: '请用 team 模式处理 → 注入 team', prompt: '请用 team 模式处理', expect: { inject: true, mode: 'team' } },
  { name: 'hyperplan 一下 → 注入 hyperplan', prompt: 'hyperplan 一下', expect: { inject: true, mode: 'hyperplan' } },
  { name: 'ULW 大写 → 注入 ulw', prompt: 'ULW 重构缓存层', expect: { inject: true, mode: 'ulw' } },
  { name: 'teamwork 很重要 → 不注入(子串)', prompt: 'teamwork 很重要', expect: { inject: false, reason: 'no-keyword' } },
  { name: 'multiulw / myteam → 不注入(子串)', prompt: 'multiulw 和 myteam 都不该命中', expect: { inject: false, reason: 'no-keyword' } },
  { name: '行内反引号 `team` → 不注入', prompt: '变量名叫 `team` 的那个', expect: { inject: false, reason: 'code-context' } },
  { name: '双引号 "team" → 不注入', prompt: '"team" 这个字符串', expect: { inject: false, reason: 'code-context' } },
  { name: '单引号 \'ulw\' → 不注入', prompt: "他把标记写成 'ulw' 了", expect: { inject: false, reason: 'code-context' } },
  { name: '三反引号块含 ultrawork → 不注入', prompt: '看这段：\n```js\nconst mode = ultrawork;\n```\n有问题吗', expect: { inject: false, reason: 'code-context' } },
  { name: '路径 commands/team.md → 不注入', prompt: '看下 commands/team.md 的写法', expect: { inject: false, reason: 'code-context' } },
  { name: 'team + hyperplan → hyperplan 优先', prompt: 'team 和 hyperplan 都要', expect: { inject: true, mode: 'hyperplan', reason: 'multi-match' } },
  { name: '同 session 第二次同模式 → already-injected', prompt: 'ulw 再来一次', expect: { inject: false, reason: 'already-injected' }, repeatOf: 'ulw' },
  { name: 'keyword_hook=false → disabled', prompt: 'ulw 修复登录 bug', config: { keyword_hook: false }, expect: { inject: false, reason: 'disabled' } },
  { name: '假 pluginRoot → command-missing', prompt: 'team 上', pluginRoot: 'E:/__omz_no_such_plugin_root__', expect: { inject: false, reason: 'command-missing' } },
  { name: '畸形输入 null → 不崩', input: null, expect: { inject: false } },
  { name: '畸形输入 空字符串 prompt → 不崩', prompt: '', expect: { inject: false, reason: 'empty' } },
  { name: '畸形输入 prompt 非字符串 → 不崩', input: { prompt: 42, session_id: 'sess_num' }, expect: { inject: false, reason: 'empty' } },
  { name: '超长 100KB 字符串 → 不崩', prompt: 'x'.repeat(100 * 1024), expect: { inject: false } },
  { name: '100KB 噪声 + 末尾 ulw → 仍能命中', prompt: `${'噪 '.repeat(20000)}\nulw 收尾`, expect: { inject: true, mode: 'ulw' } },
  { name: 'emoji 与中文标点 → 不崩', prompt: '🚀 用 team 模式，谢谢！（并行）', expect: { inject: true, mode: 'team' } },
  { name: '无 session_id → 不崩', input: { prompt: 'hyperplan 走一遍' }, expect: { inject: true, mode: 'hyperplan' } },
  { name: '别名字段 userPrompt/sessionId → 兼容', input: { userPrompt: 'ultrawork 上', sessionId: 'sess_alias' }, expect: { inject: true, mode: 'ulw' } },
  // 以下两例守住本轮修复：ReDoS 退化输入、toLowerCase 变长导致的索引失配。
  // （projectRoot 穿越不在 self-test 里跑：净化后会退回 process.cwd()，会在真实工作目录落 marker。）
  {
    name: 'Markdown 链接退化输入 32K → 不超预算(线性扫描)',
    prompt: `${'['.repeat(16000)}${']('.repeat(16000)}`,
    expect: { inject: false }
  },
  {
    name: 'İ 前缀 + `team` + 真实 team → 仍命中 team（索引对齐）',
    prompt: 'İ `team` real team',
    expect: { inject: true, mode: 'team' }
  },
  // 以下三例守住注入长度上限：判定对象必须是 stdout 的 JSON 负载（不是 additionalContext 字符串），
  // 且两级降级后都必须仍在预算内——「降级了但仍超限」等于降级逻辑自身有 bug 却不自知。
  {
    name: '真实 ulw.md → level=full 且 JSON 负载在预算内',
    prompt: 'ulw 修复登录 bug',
    derive: withinBudget,
    expect: { inject: true, mode: 'ulw', injectionLevel: 'full', payloadWithinBudget: true }
  },
  {
    name: '超预算命令文件 → 降级 headings 且负载仍在预算内',
    prompt: 'ulw 上',
    pluginRoot: (tmp) => fakeCommandsRoot(tmp, 'oversize', {
      'ulw.md': `---\ndescription: x\n---\n# 大标题\n${'内容内容内容内容内容内容内容内容\n'.repeat(3000)}\n## 次级标题\n收尾\n`
    }),
    derive: withinBudget,
    expect: { inject: true, mode: 'ulw', injectionLevel: 'headings', payloadWithinBudget: true }
  },
  {
    name: '几千个章节标题 → 降级 minimal 且负载仍在预算内',
    prompt: 'team 上',
    pluginRoot: (tmp) => fakeCommandsRoot(tmp, 'headings', {
      'team.md': `---\ndescription: x\n---\n${Array.from({ length: 4000 }, (_, i) => `## 章节标题编号 ${i} 的说明文字`).join('\n')}\n`
    }),
    derive: withinBudget,
    expect: { inject: true, mode: 'team', injectionLevel: 'minimal', payloadWithinBudget: true }
  }
];

/** self-test 用：把「负载是否在预算内」变成可断言的布尔（判定对象是 JSON 负载，不是字符串长度） */
function withinBudget(got) {
  const bytes = typeof got?.additionalContext === 'string' ? payloadBytes(got.additionalContext) : NaN;
  return { payloadWithinBudget: Number.isFinite(bytes) && bytes <= MAX_PAYLOAD_BYTES };
}

/** self-test 用：在 tmp 下造一个只有 commands/ 的假插件根，用来喂超预算的命令文件 */
function fakeCommandsRoot(tmpRoot, name, files) {
  const root = path.join(tmpRoot, `fake-plugin-${name}`);
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'commands', file), content, 'utf8');
  }
  return root;
}

function selfTest() {
  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '.'), 'omz-hook-'));
  const rows = [];
  let pass = 0;
  try {
    for (const c of CASES) {
      const input = c.input !== undefined ? c.input : { prompt: c.prompt, session_id: c.session ?? 'sess_selftest', cwd: tmpRoot };
      const ctx = {
        projectRoot: tmpRoot,
        pluginRoot: typeof c.pluginRoot === 'function' ? c.pluginRoot(tmpRoot) : c.pluginRoot ?? PLUGIN_ROOT,
        config: c.config ?? { keyword_hook: true }
      };
      let got;
      let thrown = null;
      if (c.repeatOf) handleHook({ prompt: `${c.repeatOf} 第一次`, session_id: 'sess_selftest', cwd: tmpRoot }, ctx);
      try {
        got = handleHook(input, ctx);
        if (c.derive) got = { ...got, ...c.derive(got) };
      } catch (err) {
        thrown = String(err?.message ?? err);
        got = {};
      }
      const checks = Object.entries(c.expect).map(([k, v]) => [k, got?.[k], v]);
      const ok = !thrown && checks.every(([, actual, want]) => actual === want);
      if (ok) pass += 1;
      const detail = thrown
        ? `THREW ${thrown}`
        : checks.map(([k, actual, want]) => (actual === want ? `${k}=${actual}` : `${k}=${actual}!=${want}`)).join(' ');
      rows.push({ ok, name: c.name, detail });
      // 每例后清标记，避免用例间串味；already-injected 用例自己造前置状态
      fs.rmSync(path.join(tmpRoot, '.omz'), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  const width = Math.max(...rows.map((r) => [...r.name].length));
  console.log(`OMZ keyword hook self-test  (pluginRoot=${PLUGIN_ROOT})`);
  console.log('-'.repeat(width + 60));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  console.log('-'.repeat(width + 60));
  console.log(`${pass}/${rows.length} 通过`);
  return pass === rows.length;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  } else {
    runCli();
  }
}
