/**
 * tests/capability.test.mjs
 * 覆盖 adapters/zcode/capability.mjs 的全部导出（DESIGN §13.5 I2 故障隔离）。
 *
 * 本模块的铁律是「所有导出自身永不抛」——探测失败一律降级为 { available: false, error }。
 * 因此本文件的多数用例形态都是「构造一个坏环境，断言不抛且给出可读原因」。
 * 纪律：临时目录一律在 os.tmpdir() 下，after 清零；对仓库只读；不依赖网络。
 *
 * 与本机环境的耦合是刻意的：`.cmd` shim 探测（npm/npx）与 git 探测必须在真实 PATH 上验证，
 * 用 mock 会把「Windows 上 CreateProcess 只能执行 PATHEXT 里登记的后缀」这个根因遮掉。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  probeNode,
  probeSqlite,
  probeCommand,
  probeGit,
  probeCodegraph,
  probeCoordinator,
  probeDashboard,
  probeAll
} from '../adapters/zcode/capability.mjs';
import { resolveProfiles } from '../adapters/zcode/fallback.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const IS_WINDOWS = process.platform === 'win32';

/**
 * Node 版本下限**不硬编码**：capability.mjs 的 MIN_MAJOR/MIN_MINOR 是模块内私有常量（未 export），
 * 测试拿不到；能拿到的唯一权威声明是 package.json 的 `engines.node`。因此用例名与失败消息一律引用
 * 它解析出的下限——门槛以后再动（如 22.13 → 22.x），这条用例的文案会自动跟上，不会像"写死 22.5"
 * 那样在常量改了之后继续显示旧版本号误导读者。
 */
const ENGINES_NODE = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).engines.node;
/** `>=22.13.0` → `22.13`（只取用于文案的主次版本，不参与任何判定） */
const NODE_FLOOR = (ENGINES_NODE.match(/(\d+)\.(\d+)/) ?? [null, '?', '?']).slice(1, 3).join('.');

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-capability-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function makeDir(label) {
  seq += 1;
  const dir = path.join(TMP, `${label}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 一个保证不存在的路径（用于「目标缺失」类断言）。 */
function missingPath(label) {
  return path.join(TMP, `__never_created_${label}_${(seq += 1)}__`);
}

describe('probeNode', () => {
  it('返回当前进程的 Node 版本及拆解出的主次版本号', () => {
    const r = probeNode();
    assert.equal(r.version, process.versions.node);
    assert.equal(Number.isInteger(r.major), true);
    assert.equal(Number.isInteger(r.minor), true);
    assert.equal(typeof r.ok, 'boolean');
  });

  it(`本机 Node 满足 >=${NODE_FLOOR} 的下限（package.json engines 的运行期对照）`, () => {
    const r = probeNode();
    assert.equal(r.ok, true, `本机 Node v${r.version} 低于 ${NODE_FLOOR}（engines.node = ${ENGINES_NODE}），测试套件本身就跑不了`);
  });
});

describe('probeSqlite', () => {
  it('node:sqlite 可用且不抛（orchestration profile 的前提）', async () => {
    const r = await probeSqlite();
    assert.equal(r.available, true, `node:sqlite 不可用：${r.error}`);
    assert.equal(r.error, null);
  });
});

describe('probeCommand', () => {
  it('git 在本机可用，resolvedCommand 含 git 且给出版本行', () => {
    const r = probeCommand('git');
    assert.equal(r.available, true, `git 应可用：${r.error}`);
    assert.ok(String(r.resolvedCommand).includes('git'), `resolvedCommand 应含 git，实际 ${r.resolvedCommand}`);
    assert.match(r.version, /git version/);
    assert.equal(r.error, null);
  });

  it('不存在的命令返回 available:false 且不抛，error 说明按 PATHEXT 找过', () => {
    let r;
    assert.doesNotThrow(() => {
      r = probeCommand('绝对不存在的命令xyz');
    });
    assert.equal(r.available, false);
    assert.equal(r.version, null);
    assert.equal(r.resolvedCommand, null);
    assert.ok(r.error.length > 0);
    if (IS_WINDOWS) assert.match(r.error, /PATHEXT/);
  });

  /**
   * `.cmd` shim 的回归防线。npm 系分发在 PATH 里同时放了无后缀的 shell 脚本（给 Git Bash 用）
   * 和 npm.cmd。早期实现把裸名当候选，existsSync 命中那个 shell 脚本、spawnSync 再报 ENOENT，
   * 于是「npm 明明装了却永远探测不到」。修复后一律按 PATHEXT 拼后缀，并用 cmd.exe /c 执行 .cmd。
   */
  it('Windows 的 .cmd shim 能被探测到（npm 或 npx 至少一个可用且解析出 .cmd）', () => {
    const candidates = ['npm', 'npx'];
    const results = candidates.map((c) => ({ name: c, r: probeCommand(c) }));
    const ok = results.filter((x) => x.r.available);
    assert.ok(ok.length > 0, `npm/npx 都探测不到：${results.map((x) => `${x.name}=${x.r.error}`).join('；')}`);
    if (IS_WINDOWS) {
      assert.ok(
        ok.some((x) => /\.cmd$/i.test(String(x.r.resolvedCommand))),
        `Windows 上应解析到 .cmd shim，实际 ${ok.map((x) => x.r.resolvedCommand).join(', ')}`
      );
    }
    for (const x of ok) assert.ok(String(x.r.version ?? '').length > 0, `${x.name} 应给出版本行`);
  });

  it('命令存在但退出码非 0 时判 available:false，并把首行诊断带出来', () => {
    // node --definitely-not-a-flag 一定失败，且它必然在 PATH 里（本进程就是 node 起的）
    const r = probeCommand('node', ['--definitely-not-a-flag-xyz']);
    assert.equal(r.available, false);
    assert.ok(String(r.resolvedCommand).includes('node'));
    assert.ok(r.error.length > 0, '非 0 退出必须带诊断文本');
  });

  it('shell 元字符不被解释（shell:false，B15 同源注入面）', () => {
    // 若走 shell，`git --version && echo pwned` 会执行两条命令；shell:false 时它只是一个非法参数
    const r = probeCommand('git', ['--version && echo pwned']);
    assert.equal(r.available, false, '元字符被 shell 解释即为注入面');
    assert.equal(String(r.version ?? '').includes('pwned'), false);
  });

  it('cwd 指向不存在的目录时不抛，只降级', () => {
    let r;
    assert.doesNotThrow(() => {
      r = probeCommand('git', ['--version'], { cwd: missingPath('cwd') });
    });
    assert.equal(typeof r.available, 'boolean');
  });

  it('非字符串命令名不抛（内部统一 String 化）', () => {
    for (const bad of [null, undefined, 42, {}]) {
      let r;
      assert.doesNotThrow(() => {
        r = probeCommand(bad);
      }, `probeCommand(${JSON.stringify(bad)}) 不应抛`);
      assert.equal(r.available, false);
    }
  });
});

describe('probeGit', () => {
  it('非 git 目录下 available:true 但 head:null（git 可用 ≠ 当前目录是仓库）', () => {
    const dir = makeDir('not-a-repo');
    const r = probeGit(dir);
    assert.equal(r.available, true, `git 应可用：${r.error}`);
    assert.equal(r.head, null, '非 git 仓库的 HEAD 必须是 null，不能编一个值出来');
    assert.equal(r.dirty, false);
    assert.match(r.version, /git version/);
    assert.equal(r.error, null);
  });

  it('cwd 为不存在的目录时不抛', () => {
    let r;
    assert.doesNotThrow(() => {
      r = probeGit(missingPath('git-cwd'));
    });
    assert.equal(typeof r.available, 'boolean');
    assert.equal(r.head, null);
  });

  it('返回结构含 available/version/head/dirty/resolvedCommand/error 六个字段', () => {
    const r = probeGit(makeDir('git-shape'));
    for (const key of ['available', 'version', 'head', 'dirty', 'resolvedCommand', 'error']) {
      assert.ok(key in r, `probeGit 结果缺字段 ${key}`);
    }
  });
});

describe('probeCodegraph', () => {
  it('无 codegraph 且无索引目录时 errors 累积多条原因（不是只报第一条）', () => {
    const dir = makeDir('no-codegraph');
    const r = probeCodegraph(dir);
    assert.equal(r.available, false);
    assert.ok(Array.isArray(r.errors), 'errors 必须是数组');
    assert.ok(r.errors.length >= 2, `应累积多条原因，实际 ${r.errors.length} 条：${JSON.stringify(r.errors)}`);
    assert.ok(r.errors.some((e) => /可执行文件不可用/.test(e)), '缺「二进制不可用」原因');
    assert.ok(r.errors.some((e) => /索引目录/.test(e)), '缺「索引目录缺失」原因——被二进制原因盖掉即为回归');
    // error 字符串是 errors 的拼接，兼容旧调用方
    assert.equal(r.error, r.errors.join('；'));
  });

  it('.codegraph 存在但不是目录时给出对应原因', () => {
    const dir = makeDir('codegraph-is-file');
    fs.writeFileSync(path.join(dir, '.codegraph'), 'not a dir\n', 'utf8');
    const r = probeCodegraph(dir);
    assert.equal(r.available, false);
    assert.ok(r.errors.some((e) => /不是目录/.test(e)), `缺「不是目录」原因：${JSON.stringify(r.errors)}`);
  });

  /**
   * stale 三态（I1）：git 判不出索引新鲜度时必须是 'unknown' 而不是 false。
   * false 会让一个可能极旧的索引被当成新鲜索引使用，正是 I1 描述的事故。
   */
  it('有索引目录但无 git 提交记录时 stale 为 unknown 而非 false', () => {
    const dir = makeDir('codegraph-no-commit');
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    const r = probeCodegraph(dir);
    assert.equal(r.indexDir, path.join(dir, '.codegraph'));
    assert.equal(typeof r.indexedAt, 'string');
    assert.equal(r.stale, 'unknown', 'stale 必须是三态里的 unknown，不得退化成 false');
    assert.ok(r.errors.some((e) => /新鲜度/.test(e)), '应说明为何判不出新鲜度');
    assert.equal(r.available, false, 'stale=unknown 时不得判为可用');
  });

  it('cwd 为不存在的目录时不抛且给出完整结构', () => {
    let r;
    assert.doesNotThrow(() => {
      r = probeCodegraph(missingPath('codegraph-cwd'));
    });
    for (const key of ['available', 'binary', 'resolvedCommand', 'indexDir', 'indexedAt', 'stale', 'error', 'errors']) {
      assert.ok(key in r, `probeCodegraph 结果缺字段 ${key}`);
    }
  });

  it('cwd 省略时不抛（退化为当前目录）', () => {
    assert.doesNotThrow(() => probeCodegraph());
  });
});

describe('probeCoordinator', () => {
  it('真实插件根下可用并给出 server.mjs 绝对路径', async () => {
    const r = await probeCoordinator(PLUGIN_ROOT);
    assert.equal(r.available, true, `coordinator 应可用：${r.error}`);
    assert.equal(r.serverPath, path.join(PLUGIN_ROOT, 'mcp', 'coordinator', 'server.mjs'));
    assert.equal(r.error, null);
  });

  it('假插件根下 available:false 且 error 点名 server.mjs（不抛）', async () => {
    const fake = makeDir('fake-plugin');
    const r = await probeCoordinator(fake);
    assert.equal(r.available, false);
    assert.ok(r.error.includes('server.mjs'), `error 应点名缺失文件：${r.error}`);
  });
});

describe('probeDashboard', () => {
  it('真实插件根下可用，electron 是布尔（缺 electron 不算 error）', () => {
    const r = probeDashboard(PLUGIN_ROOT);
    assert.equal(r.available, true, `dashboard 应可用：${r.error}`);
    assert.equal(typeof r.electron, 'boolean');
    assert.equal(r.error, null, 'GUI 模式不可用不该计入 error（loopback HTTP 模式仍可跑）');
  });

  it('假插件根下 available:false 且仍给出 electron 字段', () => {
    const r = probeDashboard(makeDir('fake-dash'));
    assert.equal(r.available, false);
    assert.ok(r.error.includes('server.mjs'));
    assert.equal(typeof r.electron, 'boolean');
  });
});

describe('probeAll', () => {
  it('真实插件根下六项齐全且 coordinator/dashboard 可用', async () => {
    const caps = await probeAll({ pluginRoot: PLUGIN_ROOT, cwd: PLUGIN_ROOT });
    assert.deepEqual(Object.keys(caps).sort(), ['codegraph', 'coordinator', 'dashboard', 'git', 'node', 'sqlite']);
    assert.equal(caps.coordinator.available, true);
    assert.equal(caps.dashboard.available, true);
    assert.equal(caps.node.ok, true);
  });

  it('pluginRoot 与 cwd 都不存在时六项齐全且不抛（I2 故障隔离）', async () => {
    let caps;
    await assert.doesNotReject(async () => {
      caps = await probeAll({ pluginRoot: missingPath('plugin'), cwd: missingPath('work') });
    });
    assert.deepEqual(Object.keys(caps).sort(), ['codegraph', 'coordinator', 'dashboard', 'git', 'node', 'sqlite']);
    assert.equal(caps.coordinator.available, false);
    assert.equal(caps.dashboard.available, false);
    // node 与 sqlite 不依赖外部路径，仍应正常
    assert.equal(caps.node.ok, true);
    assert.equal(caps.sqlite.available, true);
  });

  it('完全不传参数时不抛（退化为 process.cwd()）', async () => {
    let caps;
    await assert.doesNotReject(async () => {
      caps = await probeAll();
    });
    assert.equal(typeof caps.node.version, 'string');
  });

  it('传入 null 参数时不抛', async () => {
    await assert.doesNotReject(async () => {
      await probeAll({ pluginRoot: null, cwd: null });
    });
  });

  it('cwd 省略时用 pluginRoot 作工作目录', async () => {
    const caps = await probeAll({ pluginRoot: PLUGIN_ROOT });
    assert.equal(typeof caps.git.available, 'boolean');
    assert.equal(caps.coordinator.available, true);
  });
});

/**
 * resolveProfiles 的输入韧性（§15.3 底线）：caps 可能是 undefined / null / 缺字段 /
 * 字段本身是 Error 实例（某个 probe 抛过）。任何形态都不得抛，core 必须永远 true。
 */
describe('resolveProfiles 对畸形 caps 的韧性', () => {
  const WANT_ALL = {
    graph: { enabled: true },
    orchestration: { enabled: true },
    dashboard: { enabled: true }
  };

  it('caps 为 undefined 时不抛且 core 仍为 true', () => {
    let r;
    assert.doesNotThrow(() => {
      r = resolveProfiles(WANT_ALL, undefined);
    });
    assert.equal(r.active.core, true);
    assert.equal(r.active.orchestration, false);
    assert.equal(r.degraded.length, 3, '三个已启用的 profile 都应进降级表');
    for (const d of r.degraded) assert.ok(d.reason.length > 0 && d.fallback.length > 0);
  });

  it('caps 为 null 时不抛且 core 仍为 true', () => {
    let r;
    assert.doesNotThrow(() => {
      r = resolveProfiles(WANT_ALL, null);
    });
    assert.equal(r.active.core, true);
  });

  it('caps 字段是 Error 实例时不抛，降级原因带上异常消息', () => {
    let r;
    assert.doesNotThrow(() => {
      r = resolveProfiles(WANT_ALL, {
        codegraph: new Error('codegraph 探测炸了'),
        coordinator: new Error('coordinator 探测炸了'),
        dashboard: new Error('dashboard 探测炸了')
      });
    });
    assert.equal(r.active.core, true);
    assert.equal(r.active.graph, false);
    assert.equal(r.active.orchestration, false);
    assert.equal(r.active.dashboard, false);
    assert.equal(r.degraded.length, 3);
    assert.ok(r.degraded.some((d) => /炸了/.test(d.reason)), `降级原因应带异常消息：${JSON.stringify(r.degraded)}`);
  });

  it('caps 是数组 / 字符串 / 数字等非对象形态时不抛', () => {
    for (const bad of [[], 'caps', 42, true, () => {}]) {
      let r;
      assert.doesNotThrow(() => {
        r = resolveProfiles(WANT_ALL, bad);
      }, `caps=${JSON.stringify(bad)} 不应抛`);
      assert.equal(r.active.core, true);
    }
  });

  it('config 为 undefined/null 时不抛，且未启用的 profile 不算降级', () => {
    for (const cfg of [undefined, null, {}, 'nope', 42]) {
      let r;
      assert.doesNotThrow(() => {
        r = resolveProfiles(cfg, {});
      }, `config=${JSON.stringify(cfg)} 不应抛`);
      assert.equal(r.active.core, true);
      assert.deepEqual(r.degraded, [], '用户没开不等于坏了');
    }
  });

  it('真实 probeAll 结果喂进去时 core 为 true 且结构完整', async () => {
    const caps = await probeAll({ pluginRoot: PLUGIN_ROOT, cwd: PLUGIN_ROOT });
    const r = resolveProfiles(WANT_ALL, caps);
    assert.equal(r.active.core, true);
    assert.equal(r.active.orchestration, true, `coordinator 可用时 orchestration 应启用：${JSON.stringify(r.degraded)}`);
    assert.deepEqual(Object.keys(r.active).sort(), ['core', 'dashboard', 'graph', 'orchestration']);
  });
});
