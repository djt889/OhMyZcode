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
  maskCodeContext,
  maskMarkdownLinks,
  scanSegments,
  detectMode,
  sessionMarkerPath,
  readMarker,
  markInjected,
  alreadyInjected,
  buildAdditionalContext,
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

  /** 跑一次 detectMode 并返回 { ms, result }。 */
  function timed(prompt, options) {
    const t0 = Date.now();
    const result = detectMode(prompt, options);
    return { ms: Date.now() - t0, result };
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
    const { ms, result } = timed('['.repeat(32000) + ']('.repeat(32000));
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过 ${WALL_LIMIT_MS}ms 上界（灾难性回溯复发）`);
    assert.equal(result.mode, null);
  });

  it('未闭合三反引号 + 60KB 正文在 1500ms 内返回', () => {
    const { ms, result } = timed('```\n' + 'x'.repeat(60000) + '\nteam');
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
    assert.equal(typeof result.reason, 'string');
  });

  it('两万个行内反引号对在 1500ms 内返回', () => {
    const { ms } = timed('`a`'.repeat(20000));
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
  });

  it('链接+反引号+引号+路径 token 混排（最坏形态）在 1500ms 内返回', () => {
    const { ms } = timed('[a](b) `c` "d" src/x.ts '.repeat(4000));
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
  });

  it('四万个未配对双引号在 1500ms 内返回', () => {
    const { ms } = timed('"'.repeat(40000) + ' team');
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
  });

  it('未闭合 ~~~ 块与嵌套引号混排在 1500ms 内返回', () => {
    const { ms } = timed('~~~\n' + '“ulw” \'team\' "hyperplan" '.repeat(3000));
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
  });

  it('1MB 纯文本在 1500ms 内返回（超长输入靠头尾窗切片，不整串扫）', () => {
    const { ms, result } = timed('x'.repeat(1024 * 1024));
    assert.ok(ms < WALL_LIMIT_MS, `耗时 ${ms}ms 超过上界`);
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
    const t0 = Date.now();
    const masked = maskMarkdownLinks(input);
    const ms = Date.now() - t0;
    assert.ok(ms < WALL_LIMIT_MS, `maskMarkdownLinks 耗时 ${ms}ms 超过上界`);
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
    const t0 = Date.now();
    const r = handleHook(
      { prompt: '['.repeat(32000) + ']('.repeat(32000), session_id: 's-redos', cwd: root },
      { projectRoot: root, pluginRoot: PLUGIN_ROOT }
    );
    const ms = Date.now() - t0;
    assert.ok(ms < WALL_LIMIT_MS * 2, `handleHook 耗时 ${ms}ms 过长`);
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
