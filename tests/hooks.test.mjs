/**
 * tests/hooks.test.mjs
 * 覆盖 hooks/keyword-detect.mjs：关键词判定（§15.1 误触发红线）、marker 幂等与路径穿越防护、
 * 注入内容构造、handleHook 判定链，以及进程级严格输出 schema（多一个键整体失效）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  MODE_KEYWORDS,
  SCAN_BUDGET_MS,
  ENGINE_DEFAULT_MAX_OUTPUT_BYTES,
  PAYLOAD_SAFETY_MARGIN_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_CONTEXT_BYTES,
  payloadBytes,
  maskCodeContext,
  maskMarkdownLinks,
  scanSegments,
  detectMode,
  sessionMarkerPath,
  readMarker,
  markInjected,
  alreadyInjected,
  buildAdditionalContext,
  buildAdditionalContextDetailed,
  handleHook
} from '../hooks/keyword-detect.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOOK_SCRIPT = fileURLToPath(new URL('../hooks/keyword-detect.mjs', import.meta.url));

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-hooks-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
/** 造独立项目根；config 非空时写 .zcode/config.json 的 omz 段。 */
function makeRoot(config) {
  seq += 1;
  const root = path.join(TMP, `proj-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(root, '.zcode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.zcode', 'config.json'), JSON.stringify({ omz: config }, null, 2), 'utf8');
  }
  return root;
}

const ENABLED = { keyword_hook: true };

describe('detectMode 命中与优先级', () => {
  it('slash 前缀的 prompt 不注入（命令系统已展开，B5）', () => {
    assert.equal(detectMode('/ulw 修复登录').mode, null);
    assert.equal(detectMode('/ulw 修复登录').reason, 'slash-command');
    assert.equal(detectMode('   /team 上').reason, 'slash-command');
  });

  it('独立词命中三种模式及其别名', () => {
    assert.equal(detectMode('ulw 修复登录 bug').mode, 'ulw');
    assert.equal(detectMode('ultrawork this').mode, 'ulw');
    assert.equal(detectMode('ultra-work 一下').mode, 'ulw');
    assert.equal(detectMode('请用 team 模式处理').mode, 'team');
    assert.equal(detectMode('hyperplan 一下').mode, 'hyperplan');
    assert.equal(detectMode('hyper-plan 走一遍').mode, 'hyperplan');
  });

  it('子串不命中：teamwork / myteam / multiulw 都不触发', () => {
    for (const prompt of ['teamwork 很重要', 'myteam 的约定', 'multiulw 不该命中', 'teamwork 与 myteam']) {
      const r = detectMode(prompt);
      assert.equal(r.mode, null, `${prompt} 不应命中`);
      assert.equal(r.reason, 'no-keyword');
    }
  });

  it('行内反引号里的关键词不命中', () => {
    const r = detectMode('变量名叫 `team` 的那个');
    assert.equal(r.mode, null);
    assert.equal(r.reason, 'code-context');
  });

  it('三反引号代码块里的关键词不命中（含未闭合块）', () => {
    assert.equal(detectMode('看这段：\n```js\nconst mode = ultrawork;\n```\n有问题吗').reason, 'code-context');
    assert.equal(detectMode('未闭合：\n```\nteam = 1\n').reason, 'code-context');
  });

  it('双引号与单引号里的关键词不命中', () => {
    assert.equal(detectMode('"team" 这个字符串').reason, 'code-context');
    assert.equal(detectMode("他把标记写成 'ulw' 了").reason, 'code-context');
  });

  it('中文全角引号里的关键词不命中', () => {
    assert.equal(detectMode('他说“hyperplan”只是个词').reason, 'code-context');
  });

  it('路径 / 链接 token 里的关键词不命中', () => {
    assert.equal(detectMode('看下 commands/team.md 的写法').reason, 'code-context');
    assert.equal(detectMode('参见 docs/ulw.md').reason, 'code-context');
    assert.equal(detectMode('见 [说明](https://x.example/team)').reason, 'code-context');
  });

  it('句末标点不影响命中（team. 仍算独立词）', () => {
    assert.equal(detectMode('let us use team.').mode, 'team');
    assert.equal(detectMode('用 ulw，谢谢').mode, 'ulw');
  });

  it('多命中时按 hyperplan > team > ulw 取优先级', () => {
    assert.equal(detectMode('team 和 hyperplan 都要').mode, 'hyperplan');
    assert.equal(detectMode('team 和 hyperplan 都要').reason, 'multi-match');
    assert.equal(detectMode('ulw 和 team 一起').mode, 'team');
    assert.equal(detectMode('ulw 与 hyperplan').mode, 'hyperplan');
  });

  it('大小写不敏感', () => {
    assert.equal(detectMode('ULW 重构缓存层').mode, 'ulw');
    assert.equal(detectMode('Team 模式').mode, 'team');
    assert.equal(detectMode('HyperPlan 一下').mode, 'hyperplan');
  });

  it('matched 里保留命中的原始关键词', () => {
    const r = detectMode('ultrawork 上');
    assert.deepEqual(r.matched, ['ultrawork']);
  });

  it('MODE_KEYWORDS 是冻结的关键词→模式映射', () => {
    assert.equal(Object.isFrozen(MODE_KEYWORDS), true);
    assert.equal(MODE_KEYWORDS.ultrawork, 'ulw');
    assert.equal(MODE_KEYWORDS['hyper-plan'], 'hyperplan');
  });

  it('maskCodeContext 保持字符串长度不变（命中点索引可对照）', () => {
    const text = '前面 `team` 中间 "ulw" 后面';
    assert.equal(maskCodeContext(text).length, text.length);
  });
});

describe('detectMode 边界输入', () => {
  it('null / undefined / 空串 / 非字符串都不抛且不命中', () => {
    for (const input of [null, undefined, '', '   ', 42, {}, [], true]) {
      let r;
      assert.doesNotThrow(() => {
        r = detectMode(input);
      }, `输入 ${JSON.stringify(input)} 不应抛`);
      assert.equal(r.mode, null);
    }
  });

  it('100KB 长串不抛', () => {
    let r;
    assert.doesNotThrow(() => {
      r = detectMode('x'.repeat(100 * 1024));
    });
    assert.equal(r.mode, null);
  });

  it('超长噪声后仍能命中末尾关键词', () => {
    const r = detectMode(`${'噪 '.repeat(20000)}\nulw 收尾`);
    assert.equal(r.mode, 'ulw');
  });

  it('含 emoji 与中文全角标点不抛且能正常命中', () => {
    const r = detectMode('🚀 用 team 模式，谢谢！（并行）');
    assert.equal(r.mode, 'team');
  });
});

/**
 * ReDoS 预算（blocker 级缺陷的回归防线）。
 * hooks.json 的 timeoutMs=3000 会直接杀进程，被杀就是「零字节输出」——
 * 而 hook 契约要求任何情况都输出 `{}`，于是 fail-open 瞬间变成 fail-broken，
 * 且退出码看不出异常，人和 CI 都发现不了。
 * 历史根因：Markdown 链接屏蔽用 /\[[^\]\r\n]*\]\([^)\r\n]*\)/ 呈灾难性回溯
 * （`'['.repeat(32000) + ']('.repeat(32000)` 实测 18.4s）。现改为单向线性扫描。
 * 下面每条都断挂钟上界 1500ms（= SCAN_BUDGET_MS，相对 3000ms 引擎预算留一半余量）。
 */
describe('detectMode ReDoS 预算', () => {
  const WALL_LIMIT_MS = 1500;

  /**
   * 跑一次 detectMode，返回 { ms, cpuMs, result }。
   *
   * 断言量 **cpuMs 而不是墙钟**：这两个数在机器繁忙时会分道扬镳，而我们要防的是
   * 算法回溯（CPU 密集），不是调度延迟。实测同一段 5MB 降级：空闲 wall=708ms/cpu=718ms，
   * 24 个占满核的 worker 抢 16 核时 wall 涨到 4976–5673ms 而 cpu 只到 953–1062ms。
   * 墙钟断言在这种情况下会假红——本仓库确实撞到过一次（577 里 1 条红，
   * 那次 npm test 总耗时 36772ms 对常态 21500ms，慢 70%）。
   * cpuMs 也不是完全不受影响（缓存与 SMT 争抢会让同样的工作多烧一点 CPU），
   * 所以上界仍留了两倍余量，只是它不再随「机器上还跑着什么」而线性漂移。
   */
  function timed(prompt, options) {
    const c0 = process.cpuUsage();
    const t0 = Date.now();
    const result = detectMode(prompt, options);
    const wall = Date.now() - t0;
    const used = process.cpuUsage(c0);
    return { ms: wall, cpuMs: Math.round((used.user + used.system) / 1000), result };
  }

  it('SCAN_BUDGET_MS 是 1500ms（相对 hooks.json 的 timeoutMs=3000 留一半余量）', () => {
    assert.equal(SCAN_BUDGET_MS, 1500);
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const timeouts = JSON.stringify(hooks).match(/"timeoutMs"\s*:\s*(\d+)/g) ?? [];
    assert.ok(timeouts.length > 0, 'hooks.json 应声明 timeoutMs');
    for (const t of timeouts) {
      const value = Number(t.match(/(\d+)/)[1]);
      assert.ok(SCAN_BUDGET_MS * 2 <= value, `SCAN_BUDGET_MS(${SCAN_BUDGET_MS}) 相对 timeoutMs(${value}) 余量不足`);
    }
  });

  it('Markdown 链接退化输入 32000×2 在 1500ms 内返回（历史 18.4s 的那个形态）', () => {
    const { cpuMs, result } = timed('['.repeat(32000) + ']('.repeat(32000));
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过 ${WALL_LIMIT_MS}ms 上界（灾难性回溯复发）`);
    assert.equal(result.mode, null);
  });

  it('未闭合三反引号 + 60KB 正文在 1500ms 内返回', () => {
    const { cpuMs, result } = timed('```\n' + 'x'.repeat(60000) + '\nteam');
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
    assert.equal(typeof result.reason, 'string');
  });

  it('两万个行内反引号对在 1500ms 内返回', () => {
    const { cpuMs } = timed('`a`'.repeat(20000));
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
  });

  it('链接+反引号+引号+路径 token 混排（最坏形态）在 1500ms 内返回', () => {
    const { cpuMs } = timed('[a](b) `c` "d" src/x.ts '.repeat(4000));
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
  });

  it('四万个未配对双引号在 1500ms 内返回', () => {
    const { cpuMs } = timed('"'.repeat(40000) + ' team');
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
  });

  it('未闭合 ~~~ 块与嵌套引号混排在 1500ms 内返回', () => {
    const { cpuMs } = timed('~~~\n' + '“ulw” \'team\' "hyperplan" '.repeat(3000));
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
  });

  it('1MB 纯文本在 1500ms 内返回（超长输入靠头尾窗切片，不整串扫）', () => {
    const { cpuMs, result } = timed('x'.repeat(1024 * 1024));
    assert.ok(cpuMs < WALL_LIMIT_MS, `CPU 耗时 ${cpuMs}ms 超过上界`);
    assert.equal(result.mode, null);
  });

  it('scanSegments 对超长输入切成头尾两段，各自独立做屏蔽分析', () => {
    const short = 'x'.repeat(1000);
    assert.deepEqual(scanSegments(short), [short], '未超上限时不切片');
    const long = 'a'.repeat(200 * 1024);
    const segs = scanSegments(long);
    assert.equal(segs.length, 2, '超上限应切成头尾两段');
    assert.equal(segs[0].length + segs[1].length, 32 * 1024, '两段合计等于扫描预算 32KB');
    // 头窗里未闭合的三反引号不得跨越拼接点吃掉尾窗内容
    const trap = '```\n' + 'y'.repeat(200 * 1024) + '\nulw 收尾';
    assert.equal(detectMode(trap).mode, 'ulw', '尾窗里的真实意图不该被头窗的未闭合代码块吞掉');
  });

  it('maskMarkdownLinks 对退化输入线性返回且保持长度不变', () => {
    const input = '['.repeat(16000) + ']('.repeat(16000);
    const c0 = process.cpuUsage();
    const masked = maskMarkdownLinks(input);
    const used = process.cpuUsage(c0);
    const cpuMs = Math.round((used.user + used.system) / 1000);
    assert.ok(cpuMs < WALL_LIMIT_MS, `maskMarkdownLinks CPU 耗时 ${cpuMs}ms 超过上界`);
    assert.equal(masked.length, input.length, '屏蔽必须等长（命中点索引要能与原串对照）');
  });

  it('budgetMs=0 时立即判为超预算并给出 budget-exceeded（不注入优于被引擎杀掉）', () => {
    const r = detectMode('请用 team 模式处理', { budgetMs: 0 });
    assert.equal(r.mode, null);
    assert.equal(r.reason, 'budget-exceeded');
    assert.equal(typeof r.elapsedMs, 'number');
    assert.ok(r.elapsedMs >= 0);
    assert.deepEqual(r.matched, []);
  });

  it('budget-exceeded 优先于关键词命中（宁可漏检也不带着半截屏蔽结果注入）', () => {
    // 同一个 prompt 在正常预算下必然命中 hyperplan；预算为 0 时必须退成 budget-exceeded
    assert.equal(detectMode('hyperplan 一下').mode, 'hyperplan');
    assert.equal(detectMode('hyperplan 一下', { budgetMs: 0 }).reason, 'budget-exceeded');
  });

  it('负数 budgetMs 被夹到 0，同样得到 budget-exceeded 而不是抛', () => {
    let r;
    assert.doesNotThrow(() => {
      r = detectMode('team 上', { budgetMs: -1000 });
    });
    assert.equal(r.reason, 'budget-exceeded');
  });

  it('slash-command 判定在预算检查之前，budgetMs=0 也仍报 slash-command', () => {
    assert.equal(detectMode('/team 上', { budgetMs: 0 }).reason, 'slash-command');
  });

  it('handleHook 在退化输入下仍在预算内返回且不注入', () => {
    const root = makeRoot(ENABLED);
    const c0 = process.cpuUsage();
    const r = handleHook(
      { prompt: '['.repeat(32000) + ']('.repeat(32000), session_id: 's-redos', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT }
    );
    const used = process.cpuUsage(c0);
    const cpuMs = Math.round((used.user + used.system) / 1000);
    assert.ok(cpuMs < WALL_LIMIT_MS * 2, `handleHook CPU 耗时 ${cpuMs}ms 过长`);
    assert.equal(r.inject, false);
  });
});

describe('sessionMarkerPath 路径穿越防护', () => {
  it('正常 sessionId 落在 .omz/ 下', () => {
    const root = makeRoot();
    const p = sessionMarkerPath(root, 'sess_abc-123');
    assert.equal(path.dirname(p), path.join(root, '.omz'));
    assert.ok(path.basename(p).startsWith('.mode-injected-'));
  });

  it('含 ../ 的 sessionId 被安全化，结果仍在 .omz/ 内', () => {
    const root = makeRoot();
    const p = path.resolve(sessionMarkerPath(root, '../../etc/passwd'));
    const omzDir = path.resolve(path.join(root, '.omz'));
    assert.equal(p.startsWith(omzDir + path.sep), true, `${p} 逃出了 ${omzDir}`);
    assert.equal(p.includes('..'), false);
  });

  it('含空格与冒号的 sessionId 被替换为下划线', () => {
    const root = makeRoot();
    const p = sessionMarkerPath(root, 'a b:c/d\\e');
    assert.equal(path.dirname(path.resolve(p)), path.resolve(path.join(root, '.omz')));
    assert.equal(path.basename(p), '.mode-injected-a_b_c_d_e');
  });

  it('空 / null sessionId 退化为 unknown 而非空文件名', () => {
    const root = makeRoot();
    assert.equal(path.basename(sessionMarkerPath(root, '')), '.mode-injected-unknown');
    assert.equal(path.basename(sessionMarkerPath(root, null)), '.mode-injected-unknown');
  });

  it('超长 sessionId 被截断（不生成超长文件名）', () => {
    const root = makeRoot();
    const name = path.basename(sessionMarkerPath(root, 'z'.repeat(500)));
    assert.ok(name.length <= '.mode-injected-'.length + 96);
  });
});

describe('readMarker / markInjected / alreadyInjected', () => {
  it('marker 文件缺失时返回空 modes 且不抛', () => {
    const root = makeRoot();
    assert.deepEqual(readMarker(root, 'sess_x'), { modes: [] });
  });

  it('marker 文件损坏时返回空 modes 且不抛', () => {
    const root = makeRoot();
    const p = sessionMarkerPath(root, 'sess_broken');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"modes":', 'utf8');
    assert.doesNotThrow(() => readMarker(root, 'sess_broken'));
    assert.deepEqual(readMarker(root, 'sess_broken').modes, []);
  });

  it('marker 内 modes 非数组时退化为空列表', () => {
    const root = makeRoot();
    const p = sessionMarkerPath(root, 'sess_shape');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ modes: 'ulw' }), 'utf8');
    assert.deepEqual(readMarker(root, 'sess_shape').modes, []);
  });

  it('同一 mode 追加两次后 modes 里只有一个（幂等）', () => {
    const root = makeRoot();
    markInjected(root, 'sess_idem', 'ulw');
    const second = markInjected(root, 'sess_idem', 'ulw');
    assert.deepEqual(second.modes, ['ulw']);
    assert.deepEqual(readMarker(root, 'sess_idem').modes, ['ulw']);
  });

  it('不同 mode 各自累加', () => {
    const root = makeRoot();
    markInjected(root, 'sess_multi', 'ulw');
    markInjected(root, 'sess_multi', 'team');
    assert.deepEqual(readMarker(root, 'sess_multi').modes.sort(), ['team', 'ulw']);
  });

  it('alreadyInjected 只对已写入的 mode 为 true', () => {
    const root = makeRoot();
    markInjected(root, 'sess_a', 'team');
    assert.equal(alreadyInjected(root, 'sess_a', 'team'), true);
    assert.equal(alreadyInjected(root, 'sess_a', 'ulw'), false);
    assert.equal(alreadyInjected(root, 'sess_other', 'team'), false);
  });

  it('marker 文件无 BOM 且以 LF 结尾（B4）', () => {
    const root = makeRoot();
    markInjected(root, 'sess_bytes', 'ulw');
    const buf = fs.readFileSync(sessionMarkerPath(root, 'sess_bytes'));
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf.includes(0x0d), false);
  });
});

describe('buildAdditionalContext', () => {
  it('真实 pluginRoot 下三个 mode 都能取到非空内容', () => {
    for (const mode of ['ulw', 'team', 'hyperplan']) {
      const text = buildAdditionalContext(mode, PLUGIN_ROOT, [mode]);
      assert.equal(typeof text, 'string', `${mode} 应返回字符串`);
      assert.ok(text.length > 100, `${mode} 注入内容过短`);
    }
  });

  it('注入内容已剥掉 YAML frontmatter（不含 description 行）', () => {
    for (const mode of ['ulw', 'team', 'hyperplan']) {
      const text = buildAdditionalContext(mode, PLUGIN_ROOT, [mode]);
      const body = text.split('\n').slice(2).join('\n'); // 跳过来源注释行与空行
      assert.equal(body.startsWith('---'), false, `${mode} 仍带 frontmatter 起始分隔符`);
      assert.equal(/^description:/m.test(body), false, `${mode} 仍含 frontmatter 的 description 行`);
    }
  });

  it('注入内容首行是标明来源的注释行', () => {
    const text = buildAdditionalContext('ulw', PLUGIN_ROOT, ['ultrawork']);
    const first = text.split('\n')[0];
    assert.match(first, /^<!-- OMZ keyword hook:/);
    assert.ok(first.includes('ultrawork'));
    assert.ok(first.includes('/ulw'));
  });

  it('假 pluginRoot 返回 null（不抛）', () => {
    assert.equal(buildAdditionalContext('ulw', path.join(TMP, '__no_such_plugin_root__'), ['ulw']), null);
  });

  it('未知 mode 或空 pluginRoot 返回 null', () => {
    assert.equal(buildAdditionalContext('nope', PLUGIN_ROOT, []), null);
    assert.equal(buildAdditionalContext('ulw', '', []), null);
    assert.equal(buildAdditionalContext('ulw', null, []), null);
  });
});

/**
 * 注入长度上限（blocker 级缺陷的回归防线）。
 *
 * 引擎缺省 `maxOutputBytes` 是 **32768**（不是 65536），取证于 `E:/APP/Zcode/resources/glm/zcode.cjs`：
 * `hooks:{enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}`、
 * `jdi={enabled:!1,events:{},maxOutputBytes:32768,timeoutMs:6e4}`、归并缺省常量 `AEo=32768`、
 * 以及 `maxOutputBytes:e?.maxOutputBytes??32768` / `Q.hooks?.maxOutputBytes??32768` 两处兜底。
 * 超限的后果不是安全截断：hook 走 executionPort 时 `OutputCollector` 丢弃超出部分（`truncated` 标记
 * 在 hook 路径上从不被读），`parseHookStdout` 对半截 JSON `catch{return}` —— **整段注入被静默丢弃**；
 * 另一形态 `runGitCommand` 直接 `o.kill()` + `exitCode:-1`。两者都是 fail-broken。
 *
 * 历史错位：`MAX_CONTEXT_BYTES = 48 * 1024`（49152）> 32768，且它约束的是 additionalContext
 * **字符串**字节数，而引擎量的是 **stdout 的 JSON 负载**（实测 11105 → 11372，差 267，中文/转义越多差越大）。
 * 现在唯一权威闸门是 `payloadBytes(text) <= MAX_PAYLOAD_BYTES`，下面把这些不变量全部钉死。
 */
describe('注入负载预算与降级', () => {
  /** 造只有 commands/ 的假插件根，用来喂超预算的命令文件 */
  function fakePluginRoot(name, files) {
    const root = path.join(TMP, `fake-plugin-${name}`);
    fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, 'commands', file), content, 'utf8');
    }
    return root;
  }

  it('ENGINE_DEFAULT_MAX_OUTPUT_BYTES 是引擎缺省的 32768（不是 hooks.json 里那个已删的 65536）', () => {
    assert.equal(ENGINE_DEFAULT_MAX_OUTPUT_BYTES, 32768);
    // hooks.json 顶层不得再出现 maxOutputBytes（引擎从不读它，写了只会误导）
    const rawHooks = fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8');
    const parsed = JSON.parse(rawHooks);
    assert.equal(Object.hasOwn(parsed, 'maxOutputBytes'), false, 'hooks.json 顶层不该有 maxOutputBytes');
  });

  it('预算 + 安全余量 <= 引擎缺省上限（我们的墙必须低于引擎真墙）', () => {
    assert.ok(
      MAX_PAYLOAD_BYTES + PAYLOAD_SAFETY_MARGIN_BYTES <= ENGINE_DEFAULT_MAX_OUTPUT_BYTES,
      `预算(${MAX_PAYLOAD_BYTES}) + 余量(${PAYLOAD_SAFETY_MARGIN_BYTES}) 必须 <= 引擎缺省(${ENGINE_DEFAULT_MAX_OUTPUT_BYTES})`
    );
    assert.ok(MAX_PAYLOAD_BYTES < ENGINE_DEFAULT_MAX_OUTPUT_BYTES, '预算不得触到引擎缺省上限');
    assert.ok(PAYLOAD_SAFETY_MARGIN_BYTES >= 4096, '余量太小则用户把 maxOutputBytes 调小后防线即失效');
    assert.equal(MAX_PAYLOAD_BYTES, 24576, '预算是 24KB（缺省 32768 - 8KB 余量）');
  });

  it('MAX_CONTEXT_BYTES 是由负载预算反推的字符串软上限，不再是独立魔法数', () => {
    const envelope = Buffer.byteLength(JSON.stringify({ additionalContext: '' }), 'utf8');
    assert.equal(MAX_CONTEXT_BYTES, MAX_PAYLOAD_BYTES - envelope);
    assert.ok(MAX_CONTEXT_BYTES < MAX_PAYLOAD_BYTES, '字符串软上限必须严格小于负载预算');
    assert.ok(MAX_CONTEXT_BYTES < ENGINE_DEFAULT_MAX_OUTPUT_BYTES, '历史 bug：49152 > 32768 属防线错位');
  });

  it('payloadBytes 量的是 stdout 的 JSON 负载，恒 >= 字符串字节数（转义与信封开销）', () => {
    const text = buildAdditionalContext('ulw', PLUGIN_ROOT, ['ulw']);
    const strBytes = Buffer.byteLength(text, 'utf8');
    assert.ok(payloadBytes(text) > strBytes, 'JSON 负载必须大于字符串本身（信封 + 转义）');
    assert.equal(payloadBytes(text), Buffer.byteLength(JSON.stringify({ additionalContext: text }), 'utf8'));
    // 转义放大最坏形态：每个 `"` 变两字节，每个控制字符变 6 字节
    assert.ok(payloadBytes('"'.repeat(100)) >= 200);
    assert.ok(payloadBytes('\u0001'.repeat(100)) >= 600);
  });

  it('不变量：三个 mode 的 JSON 负载都 < 预算（有人再调大常量又错位就会红）', () => {
    for (const mode of ['ulw', 'team', 'hyperplan']) {
      const text = buildAdditionalContext(mode, PLUGIN_ROOT, [mode]);
      const bytes = payloadBytes(text);
      assert.ok(bytes < MAX_PAYLOAD_BYTES, `${mode} 的 JSON 负载 ${bytes} 必须 < 预算 ${MAX_PAYLOAD_BYTES}`);
      assert.ok(bytes < ENGINE_DEFAULT_MAX_OUTPUT_BYTES, `${mode} 的 JSON 负载 ${bytes} 必须 < 引擎缺省上限`);
    }
  });

  it('回归哨兵：真实 ulw.md 的 JSON 负载 < 预算（ulw.md 再膨胀先撞这条，而不是撞引擎）', () => {
    const built = buildAdditionalContextDetailed('ulw', PLUGIN_ROOT, ['ultrawork']);
    assert.equal(built.level, 'full', 'ulw.md 当前不该触发降级');
    assert.ok(
      built.payloadBytes < MAX_PAYLOAD_BYTES,
      `ulw.md 的 JSON 负载 ${built.payloadBytes} 已达/超预算 ${MAX_PAYLOAD_BYTES}：` +
        '要么精简 commands/ulw.md，要么重新论证预算——不要直接调大常量'
    );
    // 余量倍数写进断言：低于 1.5x 就该在膨胀失控前先看到红灯
    const ratio = MAX_PAYLOAD_BYTES / built.payloadBytes;
    assert.ok(ratio > 1.5, `ulw.md 余量仅 ${ratio.toFixed(2)}x，已进入危险区（预算 ${MAX_PAYLOAD_BYTES}）`);
  });

  it('一级降级：超预算命令文件降为 headings，且降级后负载仍在预算内', () => {
    const root = fakePluginRoot('oversize', {
      'ulw.md': `---\ndescription: x\n---\n# 大标题\n${'内容内容内容内容内容内容内容内容\n'.repeat(3000)}\n## 次级标题\n收尾\n`
    });
    const built = buildAdditionalContextDetailed('ulw', root, ['ulw']);
    assert.equal(built.level, 'headings');
    assert.ok(built.bodyBytes > MAX_PAYLOAD_BYTES, '前置条件：正文本身必须超预算');
    assert.ok(built.payloadBytes <= MAX_PAYLOAD_BYTES, `降级后负载 ${built.payloadBytes} 仍超预算 ${MAX_PAYLOAD_BYTES}`);
    assert.equal(payloadBytes(built.text), built.payloadBytes, '自报负载必须与实测一致');
    assert.match(built.text, /章节清单/, '一级降级必须保留章节标题清单');
    assert.match(built.text, /\/ulw/, '必须提示显式执行 /ulw 拿全文');
  });

  it('二级降级：连章节清单都超预算时降为 minimal，且最终负载仍在预算内', () => {
    const root = fakePluginRoot('headings', {
      'team.md': `---\ndescription: x\n---\n${Array.from({ length: 4000 }, (_, i) => `## 章节标题编号 ${i} 的说明文字`).join('\n')}\n`
    });
    const built = buildAdditionalContextDetailed('team', root, ['team']);
    assert.equal(built.level, 'minimal', '几千个标题行必须逼出二级降级');
    assert.ok(built.payloadBytes <= MAX_PAYLOAD_BYTES, `二级降级后负载 ${built.payloadBytes} 仍超预算`);
    assert.match(built.text, /内容过长，请显式执行 \/team/, '二级降级必须给出显式命令提示');
    assert.equal(/协议章节清单（全文见/.test(built.text), false, '二级降级不应再渲染一级的章节清单块');
    // 一级降级确实被尝试过并被判定放不下：同输入在更大预算下应回到 headings
    const roomy = buildAdditionalContextDetailed('team', root, ['team'], { maxPayloadBytes: 300 * 1024 });
    assert.equal(roomy.level, 'full', '预算足够大时同一文件不该降级——证明降级是预算驱动的');
  });

  it('JSON 转义放大也不能突破预算（引号/反斜杠密集的正文）', () => {
    const root = fakePluginRoot('escape', {
      'hyperplan.md': `---\nd: x\n---\n# H\n${'"\\\\"控制\u0001符\n'.repeat(4000)}`
    });
    const built = buildAdditionalContextDetailed('hyperplan', root, ['hyperplan']);
    assert.ok(built.payloadBytes <= MAX_PAYLOAD_BYTES, `转义放大下负载 ${built.payloadBytes} 超预算`);
    assert.ok(
      built.payloadBytes > Buffer.byteLength(built.text, 'utf8'),
      '这类正文的负载必须显著大于字符串字节数——正是「按字符串判定」会漏掉的形态'
    );
  });

  it('不存在「降级了但仍超限」的路径：从病态小预算到正常预算全程扫描', () => {
    const root = fakePluginRoot('sweep', {
      'ulw.md': `---\nd: x\n---\n# T\n${'正文内容与"引号"混排\n'.repeat(2000)}${'## 小节标题\n'.repeat(500)}`
    });
    for (const budget of [24, 32, 64, 128, 512, 2048, 8192, 24576]) {
      const built = buildAdditionalContextDetailed('ulw', root, ['ulw'], { maxPayloadBytes: budget });
      assert.ok(
        built.payloadBytes <= budget,
        `预算 ${budget} 下返回的负载 ${built.payloadBytes}（level=${built.level}）越界`
      );
      assert.equal(payloadBytes(built.text), built.payloadBytes);
      assert.doesNotThrow(() => JSON.parse(JSON.stringify({ additionalContext: built.text })));
    }
  });

  it('空章节的超长正文（无任何标题行）也能降级且不越预算', () => {
    const root = fakePluginRoot('noheading', {
      'team.md': `---\nd: x\n---\n${'一段没有任何 Markdown 标题的长正文。'.repeat(2000)}`
    });
    const built = buildAdditionalContextDetailed('team', root, ['team']);
    assert.ok(['headings', 'minimal'].includes(built.level));
    assert.ok(built.payloadBytes <= MAX_PAYLOAD_BYTES);
  });

  it('降级路径本身要在 3s 引擎超时内完成（二分实测负载是 O(n log n)，不能吃掉超时预算）', () => {
    // 5MB 病态正文：二分每一步都要 JSON.stringify 整个前缀，代价随文件线性放大。
    // 与 detectMode 的 SCAN_BUDGET_MS=1500 叠加后必须仍远低于 hooks.json 的 timeoutMs=3000——
    // 被引擎杀掉是零字节输出，比降级失败更糟（fail-open 契约直接失效）。
    //
    // 量 CPU 时间而不是墙钟：这条正是本仓库唯一撞过假红的用例（机器繁忙时
    // wall 从 708ms 涨到 5673ms 而 cpu 只到 1062ms）。要防的是算法退化，不是调度延迟。
    const root = fakePluginRoot('perf', {
      'team.md': `---\nd: x\n---\n${'## 章节\n内容内容内容\n'.repeat(150000)}`
    });
    const c0 = process.cpuUsage();
    const built = buildAdditionalContextDetailed('team', root, ['team']);
    const used = process.cpuUsage(c0);
    const cpuMs = Math.round((used.user + used.system) / 1000);
    assert.ok(built.payloadBytes <= MAX_PAYLOAD_BYTES);
    assert.ok(cpuMs < 1500, `5MB 正文降级 CPU 耗时 ${cpuMs}ms，与 timeoutMs=3000 余量不足（含 detectMode 的 1500ms 预算）`);
  });

  it('handleHook 回报 injectionLevel 与 payloadBytes，且真实注入恒在预算内', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook(
      { prompt: 'ulw 修复登录', session_id: 's-budget', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT }
    );
    assert.equal(r.inject, true);
    assert.equal(r.injectionLevel, 'full');
    assert.equal(r.payloadBytes, payloadBytes(r.additionalContext));
    assert.ok(r.payloadBytes < MAX_PAYLOAD_BYTES);
  });

  it('降级时 stderr 记一行（原始字节数 / 预算 / 降到哪一级），stdout 不受影响', () => {
    const root = makeRoot(ENABLED);
    const fake = fakePluginRoot('stderr-line', {
      'ulw.md': `---\nd: x\n---\n# T\n${'内容内容内容内容内容内容\n'.repeat(3000)}\n## S\n`
    });
    const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ prompt: 'ulw 上', session_id: 'sess_degrade', cwd: root }),
      encoding: 'utf8',
      cwd: root,
      timeout: 30000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: fake, ZCODE_PLUGIN_ROOT: fake }
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /已降级为 headings/);
    assert.match(r.stderr, /超过负载预算 24576/);
    assert.match(r.stderr, /maxOutputBytes=32768/);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['additionalContext']);
    assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= MAX_PAYLOAD_BYTES, 'stdout 字节数就是引擎量的那个数');
  });

  it('进程级：真实注入的 stdout 字节数在预算内且是合法 JSON（引擎量的就是 stdout）', () => {
    const root = makeRoot(ENABLED);
    const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ prompt: 'ulw 修复登录 bug', session_id: 'sess_payload', cwd: root }),
      encoding: 'utf8',
      cwd: root,
      timeout: 30000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
    });
    assert.equal(r.status, 0);
    const stdoutBytes = Buffer.byteLength(r.stdout, 'utf8');
    assert.ok(stdoutBytes < MAX_PAYLOAD_BYTES, `stdout ${stdoutBytes} 字节超出预算 ${MAX_PAYLOAD_BYTES}`);
    assert.ok(stdoutBytes < ENGINE_DEFAULT_MAX_OUTPUT_BYTES, 'stdout 必须低于引擎缺省上限');
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['additionalContext']);
    assert.equal(payloadBytes(parsed.additionalContext), stdoutBytes, 'payloadBytes 必须等于真实 stdout 字节数');
  });
});

describe('handleHook 判定链', () => {
  it('配置未开启 keyword_hook 时 reason 为 disabled', () => {
    const root = makeRoot({ keyword_hook: false });
    const r = handleHook({ prompt: 'ulw 修复登录', session_id: 's1', cwd: root }, { projectRoot: root });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'disabled');
  });

  it('缺配置文件时默认关闭（安装即静默）', () => {
    const root = makeRoot();
    const r = handleHook({ prompt: 'ulw 修复登录', session_id: 's1', cwd: root }, { projectRoot: root });
    assert.equal(r.reason, 'disabled');
  });

  it('slash 命令 prompt 的 reason 为 slash-command', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook({ prompt: '/ulw 修复', session_id: 's1', cwd: root }, { projectRoot: root });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'slash-command');
  });

  it('无关键词的 prompt 的 reason 为 no-keyword', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook({ prompt: '帮我看看这个报错', session_id: 's1', cwd: root }, { projectRoot: root });
    assert.equal(r.reason, 'no-keyword');
  });

  it('同 session 同 mode 第二次的 reason 为 already-injected', () => {
    const root = makeRoot(ENABLED);
    const ctx = { projectRoot: root, pluginRoot: PLUGIN_ROOT };
    const first = handleHook({ prompt: 'ulw 修复登录', session_id: 's-dup', cwd: root }, ctx);
    assert.equal(first.inject, true);
    const second = handleHook({ prompt: 'ulw 再来一次', session_id: 's-dup', cwd: root }, ctx);
    assert.equal(second.inject, false);
    assert.equal(second.reason, 'already-injected');
    assert.equal(second.mode, 'ulw');
  });

  it('命令文件缺失时 reason 为 command-missing', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook(
      { prompt: 'team 上', session_id: 's1', cwd: root },
      { projectRoot: root, pluginRoot: path.join(TMP, '__no_plugin__') }
    );
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'command-missing');
    assert.equal(r.mode, 'team');
  });

  it('成功注入时返回 additionalContext、mode、matched 并写下 marker', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook(
      { prompt: 'hyperplan 走一遍', session_id: 's-ok', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT }
    );
    assert.equal(r.inject, true);
    assert.equal(r.mode, 'hyperplan');
    assert.deepEqual(r.matched, ['hyperplan']);
    assert.equal(r.marker, 'written');
    assert.ok(r.additionalContext.length > 100);
    assert.equal(alreadyInjected(root, 's-ok', 'hyperplan'), true);
  });

  it('ctx.config 显式传入时覆盖磁盘配置', () => {
    const root = makeRoot({ keyword_hook: false });
    const r = handleHook(
      { prompt: 'ulw 上', session_id: 's1', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT, config: { keyword_hook: true } }
    );
    assert.equal(r.inject, true);
  });

  it('兼容 userPrompt / sessionId 别名字段', () => {
    const root = makeRoot(ENABLED);
    const r = handleHook(
      { userPrompt: 'ultrawork 上', sessionId: 's-alias', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT }
    );
    assert.equal(r.inject, true);
    assert.equal(r.mode, 'ulw');
  });

  it('输入为 null / 非对象时不抛', () => {
    const root = makeRoot(ENABLED);
    for (const input of [null, undefined, 42, 'string', []]) {
      assert.doesNotThrow(() => handleHook(input, { projectRoot: root, pluginRoot: PLUGIN_ROOT }));
    }
  });
});

describe('进程级 CLI', () => {
  function runHook(input, { cwd } = {}) {
    return spawnSync(process.execPath, [HOOK_SCRIPT], {
      input,
      encoding: 'utf8',
      cwd: cwd ?? TMP,
      timeout: 30000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
    });
  }

  it('非法 JSON 输入时 stdout 为 {} 且 exit 0（B15 不阻断主流程）', () => {
    const r = runHook('{ not json at all');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  });

  it('空对象输入不崩溃且输出 {}', () => {
    const r = runHook('{}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  });

  it('完全空输入不崩溃且输出 {}', () => {
    const r = runHook('');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  });

  it('正常注入时 stdout 是合法 JSON 且顶层只有 additionalContext 一个键（schema 严格）', () => {
    const root = makeRoot(ENABLED);
    const r = runHook(JSON.stringify({ prompt: 'ulw 修复登录 bug', session_id: 'sess_cli', cwd: root }), { cwd: root });
    assert.equal(r.status, 0);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(r.stdout);
    }, `stdout 应是合法 JSON：${r.stdout}`);
    assert.deepEqual(Object.keys(parsed), ['additionalContext'], 'ZCode hook 输出多一个键即整体校验失败');
    assert.equal(typeof parsed.additionalContext, 'string');
    assert.ok(parsed.additionalContext.length > 100);
  });

  it('同 session 同 mode 第二次执行输出 {}', () => {
    const root = makeRoot(ENABLED);
    const payload = JSON.stringify({ prompt: 'team 模式来一次', session_id: 'sess_twice', cwd: root });
    const first = runHook(payload, { cwd: root });
    assert.deepEqual(Object.keys(JSON.parse(first.stdout)), ['additionalContext']);
    const second = runHook(payload, { cwd: root });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '{}');
  });

  it('keyword_hook 未开启时输出 {} 且不写 marker', () => {
    const root = makeRoot({ keyword_hook: false });
    const r = runHook(JSON.stringify({ prompt: 'ulw 上', session_id: 'sess_off', cwd: root }), { cwd: root });
    assert.equal(r.stdout, '{}');
    assert.equal(fs.existsSync(path.join(root, '.omz')), false);
  });

  it('诊断信息只走 stderr，不污染 stdout', () => {
    const root = makeRoot(ENABLED);
    const r = runHook(JSON.stringify({ prompt: '普通问题没有关键词', session_id: 'sess_diag', cwd: root }), { cwd: root });
    assert.equal(r.stdout, '{}');
    assert.match(r.stderr, /omz keyword hook/);
  });

  it('--self-test 全部用例通过（脚本自带回归）', () => {
    const r = spawnSync(process.execPath, [HOOK_SCRIPT, '--self-test'], {
      encoding: 'utf8',
      cwd: TMP,
      timeout: 60000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
    });
    assert.equal(r.status, 0, `self-test 未全过：\n${r.stdout}`);
    assert.equal(r.stdout.includes('FAIL'), false, `self-test 有 FAIL 行：\n${r.stdout}`);
  });
});
