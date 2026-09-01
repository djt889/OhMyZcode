/**
 * tests/fallback.test.mjs
 * 覆盖 adapters/zcode/fallback.mjs：默认配置（§15.5）、两层配置合并、profile 解析与降级链（I2）。
 * 每个用例造独立临时项目根，绝不读写仓库内的 .zcode/ 或 .omz/。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveProfiles,
  fallbackFor,
  formatDegradeReport
} from '../adapters/zcode/fallback.mjs';

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-fallback-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
/** 造一个独立项目根；zcode/omz 任一为对象则写入对应配置文件，为字符串则原样写（造损坏 JSON） */
function makeRoot({ zcode, omz } = {}) {
  seq += 1;
  const root = path.join(TMP, `root-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  if (zcode !== undefined) {
    fs.mkdirSync(path.join(root, '.zcode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.zcode', 'config.json'),
      typeof zcode === 'string' ? zcode : JSON.stringify(zcode, null, 2),
      'utf8'
    );
  }
  if (omz !== undefined) {
    fs.mkdirSync(path.join(root, '.omz'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.omz', 'config.json'),
      typeof omz === 'string' ? omz : JSON.stringify(omz, null, 2),
      'utf8'
    );
  }
  return root;
}

const OK = { available: true, error: null };
const BAD = { available: false, error: '探测失败：可执行文件不在 PATH' };

describe('DEFAULT_CONFIG', () => {
  it('默认 profile 为 core', () => {
    assert.equal(DEFAULT_CONFIG.profile, 'core');
  });

  it('keyword_hook / auto_team / auto_ulw 三个开关默认全部为 false（安装即静默）', () => {
    assert.equal(DEFAULT_CONFIG.keyword_hook, false);
    assert.equal(DEFAULT_CONFIG.auto_team, false);
    assert.equal(DEFAULT_CONFIG.auto_ulw, false);
  });

  it('graph / orchestration / dashboard 三个 profile 默认 enabled 全部为 false', () => {
    assert.equal(DEFAULT_CONFIG.graph.enabled, false);
    assert.equal(DEFAULT_CONFIG.orchestration.enabled, false);
    assert.equal(DEFAULT_CONFIG.dashboard.enabled, false);
  });

  it('结构里只有约定的七个顶层键', () => {
    assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), [
      'auto_team',
      'auto_ulw',
      'dashboard',
      'graph',
      'keyword_hook',
      'orchestration',
      'profile'
    ]);
  });
});

describe('loadConfig', () => {
  it('两个配置文件都不存在时得到默认值，且 sources 全部标记为读取失败', () => {
    const root = makeRoot();
    const { config, sources } = loadConfig(root);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(sources.length, 2);
    assert.equal(sources.every((s) => s.ok === false), true);
  });

  it('.zcode/config.json 的 omz 键被合并进配置', () => {
    const root = makeRoot({ zcode: { otherTool: { x: 1 }, omz: { keyword_hook: true, profile: 'orchestration' } } });
    const { config, sources } = loadConfig(root);
    assert.equal(config.keyword_hook, true);
    assert.equal(config.profile, 'orchestration');
    assert.equal(sources[0].ok, true);
    assert.equal(sources[0].error, null);
  });

  it('.zcode/config.json 没有 omz 段时被忽略且不影响默认值', () => {
    const root = makeRoot({ zcode: { somethingElse: true } });
    const { config, sources } = loadConfig(root);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(sources[0].ok, true);
    assert.match(sources[0].error, /omz/);
  });

  it('.omz/config.json 优先级高于 .zcode/config.json（后者被覆盖）', () => {
    const root = makeRoot({
      zcode: { omz: { profile: 'core', keyword_hook: false } },
      omz: { profile: 'dashboard', keyword_hook: true }
    });
    const { config } = loadConfig(root);
    assert.equal(config.profile, 'dashboard');
    assert.equal(config.keyword_hook, true);
  });

  it('损坏的 JSON 不使加载崩溃，且在 sources 里记录 ok:false 与原因', () => {
    const root = makeRoot({ zcode: '{"omz": ', omz: { keyword_hook: true } });
    const { config, sources } = loadConfig(root);
    assert.equal(config.keyword_hook, true); // 上层坏了不影响下层
    const zcodeSource = sources.find((s) => s.file.includes('.zcode'));
    assert.equal(zcodeSource.ok, false);
    assert.match(zcodeSource.error, /parse/);
  });

  it('深合并只覆盖指定子键，兄弟键不丢失', () => {
    const root = makeRoot({ omz: { orchestration: { enabled: true } } });
    const { config } = loadConfig(root);
    assert.equal(config.orchestration.enabled, true);
    // graph/dashboard 段整体保留
    assert.deepEqual(config.graph, { enabled: false });
    assert.deepEqual(config.dashboard, { enabled: false });
    assert.equal(config.profile, 'core');
  });

  it('深合并保留同一段内未被覆盖的兄弟字段', () => {
    const root = makeRoot({
      zcode: { omz: { orchestration: { enabled: true, max_parallel: 6 } } },
      omz: { orchestration: { enabled: false } }
    });
    const { config } = loadConfig(root);
    assert.equal(config.orchestration.enabled, false);
    assert.equal(config.orchestration.max_parallel, 6);
  });

  it('不修改 DEFAULT_CONFIG 本体（模块级常量不被污染）', () => {
    const root = makeRoot({ omz: { profile: 'dashboard', graph: { enabled: true } } });
    loadConfig(root);
    assert.equal(DEFAULT_CONFIG.profile, 'core');
    assert.equal(DEFAULT_CONFIG.graph.enabled, false);
  });
});

describe('resolveProfiles', () => {
  it('core 恒为 true，即使所有外部能力都不可用', () => {
    const r = resolveProfiles(DEFAULT_CONFIG, { codegraph: BAD, coordinator: BAD, dashboard: BAD });
    assert.equal(r.active.core, true);
  });

  it('配置已启用但能力不可用时该 profile 不激活且进降级表并带非空 reason', () => {
    const config = { ...DEFAULT_CONFIG, orchestration: { enabled: true } };
    const r = resolveProfiles(config, { coordinator: BAD });
    assert.equal(r.active.orchestration, false);
    const entry = r.degraded.find((d) => d.profile === 'orchestration');
    assert.ok(entry, 'orchestration 应出现在 degraded');
    assert.ok(entry.reason.length > 0);
    assert.ok(entry.fallback.length > 0);
  });

  it('配置已启用且能力可用时该 profile 激活且不进降级表', () => {
    const config = { ...DEFAULT_CONFIG, orchestration: { enabled: true }, dashboard: { enabled: true } };
    const r = resolveProfiles(config, { coordinator: OK, dashboard: OK });
    assert.equal(r.active.orchestration, true);
    assert.equal(r.active.dashboard, true);
    assert.deepEqual(r.degraded, []);
  });

  it('配置未启用但能力可用时不激活也不算降级（用户没开不等于坏了）', () => {
    const r = resolveProfiles(DEFAULT_CONFIG, { codegraph: OK, coordinator: OK, dashboard: OK });
    assert.equal(r.active.graph, false);
    assert.equal(r.active.orchestration, false);
    assert.equal(r.active.dashboard, false);
    assert.deepEqual(r.degraded, []);
  });

  it('能力对象缺失（undefined）且配置已启用时给出兜底 reason 而非崩溃', () => {
    const config = { ...DEFAULT_CONFIG, graph: { enabled: true } };
    const r = resolveProfiles(config, {});
    assert.equal(r.active.graph, false);
    const entry = r.degraded.find((d) => d.profile === 'graph');
    assert.ok(entry.reason.length > 0);
  });

  it('布尔简写形式的开关（graph: true）同样被识别为启用', () => {
    const r = resolveProfiles({ ...DEFAULT_CONFIG, graph: true }, { codegraph: OK });
    assert.equal(r.active.graph, true);
  });

  it('三个 profile 同时启用而全部不可用时降级表有三条', () => {
    const config = {
      ...DEFAULT_CONFIG,
      graph: { enabled: true },
      orchestration: { enabled: true },
      dashboard: { enabled: true }
    };
    const r = resolveProfiles(config, { codegraph: BAD, coordinator: BAD, dashboard: BAD });
    assert.equal(r.degraded.length, 3);
    assert.deepEqual(r.degraded.map((d) => d.profile).sort(), ['dashboard', 'graph', 'orchestration']);
    assert.equal(r.active.core, true);
  });
});

describe('fallbackFor', () => {
  it('graph / orchestration / dashboard 三个 profile 都有非空回退文案', () => {
    for (const p of ['graph', 'orchestration', 'dashboard']) {
      const text = fallbackFor(p);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, `${p} 回退文案不应为空`);
    }
  });

  it('未知 profile 返回明确的兜底文案而非 undefined', () => {
    assert.equal(typeof fallbackFor('nope'), 'string');
    assert.ok(fallbackFor('nope').length > 0);
  });
});

describe('formatDegradeReport', () => {
  it('无降级时输出固定的「无降级」文案并列出激活 profile', () => {
    const resolved = resolveProfiles(DEFAULT_CONFIG, {});
    const text = formatDegradeReport(resolved);
    assert.equal(text, 'profiles: core（无降级）');
  });

  it('有降级时每条 profile 名、reason 与回退都出现在输出里', () => {
    const config = { ...DEFAULT_CONFIG, graph: { enabled: true }, dashboard: { enabled: true } };
    const caps = {
      codegraph: { available: false, error: '索引早于最后一次提交' },
      dashboard: { available: false, error: 'dashboard/server.mjs 不存在' }
    };
    const resolved = resolveProfiles(config, caps);
    const text = formatDegradeReport(resolved);
    assert.match(text, /降级 2 项/);
    for (const d of resolved.degraded) {
      assert.ok(text.includes(d.profile), `输出应含 profile ${d.profile}`);
      assert.ok(text.includes(d.reason), `输出应含 reason ${d.reason}`);
      assert.ok(text.includes(d.fallback), `输出应含 fallback ${d.fallback}`);
    }
  });

  it('有额外 profile 激活时无降级文案里一并列出它们', () => {
    const config = { ...DEFAULT_CONFIG, orchestration: { enabled: true } };
    const text = formatDegradeReport(resolveProfiles(config, { coordinator: OK }));
    assert.match(text, /core/);
    assert.match(text, /orchestration/);
    assert.match(text, /无降级/);
  });

  it('传入空对象/undefined 时不抛且退化为 core', () => {
    assert.match(formatDegradeReport(undefined), /core/);
    assert.match(formatDegradeReport({}), /core/);
  });
});
