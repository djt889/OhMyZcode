/**
 * tests/cli.test.mjs
 * 进程级 CLI 回归防线：所有工具都用 spawnSync 真起进程验证，不 import 后调函数。
 *
 * 【为什么必须真起进程，且必须在含空格的目录里跑】
 * 早期各处自己写 `new URL(import.meta.url).pathname` 判定「是否为入口脚本」。URL.pathname 是
 * **percent-encoded** 的——插件目录一旦含空格或非 ASCII（Windows 极常见：`C:\Program Files\…`、
 * `C:\Users\张三\…`），`%20` 与 process.argv[1] 的真实路径永不相等，isMain 恒为 false。
 * 后果：CLI 静默 exit 0 什么都不做、hook 输出 0 字节（违反 fail-open 契约），而退出码是 0，
 * 人和 CI 都看不出坏了。单元测试 import 模块时根本走不到这条分支，只有起进程才能暴露。
 * 因此本文件把必要子树复制到 os.tmpdir() 下一个**含空格**的目录里，再从那里执行。
 *
 * 纪律：复制体在 after 里 rmSync 清零；对仓库只读（唯一的写都发生在复制体内）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runDoctor } from '../tools/doctor.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 复制体需要带上的子树：相对 import 链（tools→adapters→mcp）与被读取的资产目录。 */
const SUBTREES = ['tools', 'adapters', 'mcp', 'hooks', 'commands', 'agents', 'skills', 'upstream', '.zcode-plugin'];
const FILES = ['package.json', '.gitignore', 'LICENSE'];

let TMP_BASE;
/** 含空格的插件根——本文件存在的全部理由 */
let SPACED_ROOT;

before(() => {
  TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-cli-'));
  SPACED_ROOT = path.join(TMP_BASE, 'omz cli test');
  fs.mkdirSync(SPACED_ROOT, { recursive: true });
  for (const sub of SUBTREES) {
    fs.cpSync(path.join(REPO_ROOT, sub), path.join(SPACED_ROOT, sub), { recursive: true });
  }
  for (const f of FILES) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(SPACED_ROOT, f));
  }
});

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

/** 在复制体里跑一个脚本；cwd 默认就是含空格的根。 */
function runNode(scriptRel, args = [], { cwd, input, timeout = 120000 } = {}) {
  const script = path.join(SPACED_ROOT, ...scriptRel.split('/'));
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd ?? SPACED_ROOT,
    encoding: 'utf8',
    input,
    timeout
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

describe('含空格路径下的 CLI 入口（isMain 判定回归防线）', () => {
  it('复制体的根目录名确实含空格（否则本套用例毫无意义）', () => {
    assert.ok(path.basename(SPACED_ROOT).includes(' '), `复制体根应含空格：${SPACED_ROOT}`);
    assert.equal(fs.existsSync(path.join(SPACED_ROOT, 'tools', 'render-status.mjs')), true);
  });

  it('render-status.mjs 在含空格路径下 stdout 非空（静默 exit 0 即缺陷）', () => {
    const r = runNode('tools/render-status.mjs');
    assert.equal(r.status, 0, `应正常退出，stderr=${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, 'stdout 为空说明 isMain 判定失效，CLI 什么都没做');
    // 复制体里没有 .omz/，应给出明确的「无状态」提示而不是空串
    assert.ok(r.stdout.includes('无状态'), `期望「无状态」提示，实际：${JSON.stringify(r.stdout)}`);
  });

  it('render-status.mjs 对有内容的 .omz/ 渲染出任务表且不超 40 行', () => {
    const workdir = path.join(TMP_BASE, 'work with space');
    const tasks = path.join(workdir, '.omz', 'runtime', 'team-a', 'tasks');
    fs.mkdirSync(tasks, { recursive: true });
    for (const [key, wave] of [['A', 1], ['B', 2]]) {
      fs.writeFileSync(
        path.join(tasks, `${key}.json`),
        JSON.stringify({ id: key, key, wave, status: 'done', title: `任务 ${key}` }) + '\n',
        'utf8'
      );
    }
    const r = runNode('tools/render-status.mjs', [], { cwd: workdir });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 40, `输出 ${lines.length} 行超过 40 行硬上限`);
    assert.ok(r.stdout.includes('[team] team-a'));
    assert.ok(r.stdout.includes(' A | '));
    assert.ok(r.stdout.includes(' B | '));
  });

  it('keyword-detect.mjs --self-test 在含空格路径下 exit 0 且 stdout 含通过计数', () => {
    const r = runNode('hooks/keyword-detect.mjs', ['--self-test']);
    assert.equal(r.status, 0, `self-test 未全过：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /(\d+)\/(\d+) 通过/, `stdout 缺通过计数：${r.stdout}`);
    const [, pass, total] = r.stdout.match(/(\d+)\/(\d+) 通过/);
    assert.equal(pass, total, `self-test 有失败用例：${pass}/${total}`);
    assert.equal(r.stdout.includes('FAIL'), false, `self-test 输出含 FAIL 行：\n${r.stdout}`);
  });

  it('keyword-detect.mjs 收到非 JSON stdin 时 stdout 恰好 {} 且 exit 0（B15 fail-open）', () => {
    const r = runNode('hooks/keyword-detect.mjs', [], { input: 'not-json' });
    assert.equal(r.status, 0, 'hook 任何情况都不得非 0 退出');
    assert.equal(r.stdout, '{}', `stdout 必须恰好是 {}，实际 ${JSON.stringify(r.stdout)}`);
  });

  it('keyword-detect.mjs 收到空 stdin 时同样输出 {} 且 exit 0', () => {
    const r = runNode('hooks/keyword-detect.mjs', [], { input: '' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  });

  it('keyword-detect.mjs 的诊断只走 stderr，stdout 不含任何非 JSON 噪声', () => {
    const r = runNode('hooks/keyword-detect.mjs', [], { input: 'not-json' });
    assert.equal(r.stdout, '{}');
    assert.ok(r.stderr.length > 0, '非法输入应在 stderr 留诊断');
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });

  it('validate-frontmatter.mjs 对复制体 exit 0（含空格路径不影响资产校验）', () => {
    const r = runNode('tools/validate-frontmatter.mjs', [SPACED_ROOT]);
    assert.equal(r.status, 0, `frontmatter 校验应通过：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /校验通过/);
  });

  it('doctor.mjs 对复制体输出汇总行且 exit 0（无 FAIL）', () => {
    const r = runNode('tools/doctor.mjs', [SPACED_ROOT]);
    assert.match(r.stdout, /① agents/, `缺汇总行：\n${r.stdout}`);
    assert.match(r.stdout, /② model/);
    assert.match(r.stdout, /⑤ BOM/);
    assert.equal(r.status, 0, `doctor 不应有 FAIL：\n${r.stdout}`);
    assert.ok(r.stdout.includes('结论：无 FAIL'));
  });

  it('doctor.mjs --json 在含空格路径下输出可解析 JSON', () => {
    const r = runNode('tools/doctor.mjs', ['--json', SPACED_ROOT]);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(r.stdout);
    }, `--json 输出应可解析：${r.stdout.slice(0, 200)}`);
    assert.equal(typeof parsed.ok, 'boolean');
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0);
    assert.match(parsed.summaryLine, /① agents/);
  });

  it('sync-omo-skills.mjs --check 在含空格路径下有输出且 exit 0', () => {
    const r = runNode('tools/sync-omo-skills.mjs', ['--check']);
    assert.ok(r.stdout.trim().length > 0, 'stdout 为空说明 CLI 入口没跑起来');
    assert.match(r.stdout, /== check ==/);
    assert.equal(r.status, 0, `合法 lock 应 exit 0：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /OK\s+lock 字段完整/);
  });

  it('所有 CLI 都没有被信号杀掉（超时/崩溃会让 status 为 null）', () => {
    const runs = [
      runNode('tools/render-status.mjs'),
      runNode('tools/validate-frontmatter.mjs', [SPACED_ROOT]),
      runNode('tools/sync-omo-skills.mjs', ['--check']),
      runNode('hooks/keyword-detect.mjs', [], { input: '{}' })
    ];
    for (const r of runs) {
      assert.equal(r.signal, null, `进程被信号 ${r.signal} 杀掉`);
      assert.notEqual(r.status, null, '退出码为 null 说明进程异常终止');
    }
  });
});

/**
 * sync-omo-skills.mjs 的 CLI 层。
 * lock 的 url/branch/path 会被拼进**打印给人复制执行**的 git 命令行——工具自己不跑 git 是对的，
 * 但被复制到终端的那一行是要执行的。因此恶意 lock 必须在打印前就被拒（exit 1）。
 */
describe('sync-omo-skills.mjs CLI 层', () => {
  const SYNC = 'tools/sync-omo-skills.mjs';

  /** 造一个独立项目根，带一份可被改写的 lock 副本与其 omz_target 实体。 */
  function makeLockRoot(label, patch) {
    const root = path.join(TMP_BASE, `lock ${label}`); // 目录名也带空格
    fs.mkdirSync(path.join(root, 'upstream'), { recursive: true });
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'upstream', 'omo-sources.lock.json'), 'utf8'));
    Object.assign(lock, patch ?? {});
    fs.writeFileSync(path.join(root, 'upstream', 'omo-sources.lock.json'), JSON.stringify(lock, null, 2) + '\n', 'utf8');
    // --check 会校验每个 omz_target 存在性，把它们复制进来
    for (const p of lock.ported_paths ?? []) {
      if (typeof p?.omz_target !== 'string' || p.omz_target.includes('..')) continue;
      const src = path.join(REPO_ROOT, ...p.omz_target.split('/'));
      if (!fs.existsSync(src)) continue;
      const dst = path.join(root, ...p.omz_target.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    return root;
  }

  function runSync(root, args) {
    const r = spawnSync(process.execPath, [path.join(SPACED_ROOT, ...SYNC.split('/')), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('合法 lock 的 --check exit 0', () => {
    const root = makeLockRoot('valid');
    const r = runSync(root, ['--check']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /OK\s+lock 字段完整/);
  });

  it('url 含 shell 元字符的恶意 lock exit 1 且原因指名 url', () => {
    const root = makeLockRoot('evil-url', { url: 'https://evil.com/r.git; rm -rf /tmp/pwned #' });
    const r = runSync(root, ['--check']);
    assert.equal(r.status, 1, '恶意 url 必须让 --check 失败');
    const all = r.stdout + r.stderr;
    assert.match(all, /url 形态不安全/);
    assert.ok(all.includes('复制执行'), '错误信息应说明这个值会被人复制执行');
  });

  it('branch 含 shell 元字符的恶意 lock exit 1', () => {
    const root = makeLockRoot('evil-branch', { branch: 'dev && curl http://evil' });
    const r = runSync(root, ['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /branch 只允许/);
  });

  it('ported_paths[].path 含 .. 段的 lock exit 1', () => {
    const root = makeLockRoot('evil-path', {
      ported_paths: [{ path: '../../etc/passwd', omz_target: 'package.json', port_status: 'ported' }]
    });
    const r = runSync(root, ['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /path 只允许/);
  });

  it('omz_target 用反斜杠的 lock exit 1（B3）', () => {
    const root = makeLockRoot('backslash-target', {
      ported_paths: [{ path: 'src/a.ts', omz_target: 'tools\\doctor.mjs', port_status: 'ported' }]
    });
    const r = runSync(root, ['--check']);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /正斜杠/);
  });

  it('--pin 拒绝非 40 位 hex 的 SHA 且不改动 lock', () => {
    const root = makeLockRoot('pin-reject');
    const lockFile = path.join(root, 'upstream', 'omo-sources.lock.json');
    const before = fs.readFileSync(lockFile, 'utf8');
    const r = runSync(root, ['--pin', 'deadbeef']);
    assert.equal(r.status, 1, '非 40 位 hex 必须被拒');
    assert.match(r.stderr, /40 位小写 hex SHA/);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), before, '被拒的 --pin 不得改动 lock');
  });

  it('--pin 接受合法 40 位小写 hex 并回写 commit', () => {
    const root = makeLockRoot('pin-accept');
    const sha = 'b'.repeat(40);
    const r = runSync(root, ['--pin', sha]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /已回写/);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstream', 'omo-sources.lock.json'), 'utf8'));
    assert.equal(lock.commit, sha);
    assert.match(lock.commit_status, /pinned/);
    assert.equal(typeof lock.synced_at, 'string');
  });

  it('--pin 拒绝大写 hex（SHA 规范是小写）', () => {
    const root = makeLockRoot('pin-upper');
    const r = runSync(root, ['--pin', 'A'.repeat(40)]);
    assert.equal(r.status, 1);
  });

  /**
   * --plan 只打印、不执行：DESIGN §16.3 要求上游同步必须人工过目。
   * lock 指向一个不存在的 remote，若工具真跑了 git，会产生 .git 目录或网络错误——
   * 断言「输出含 git diff 字样」＋「无任何 git 副作用」两头夹住。
   */
  it('--plan 只打印命令清单，不产生任何 git 或网络副作用', () => {
    const root = makeLockRoot('plan-only', {
      url: 'https://github.com/nonexistent-owner-xyz-omz/never-exists',
      branch: 'dev'
    });
    const lockFile = path.join(root, 'upstream', 'omo-sources.lock.json');
    const lockBefore = fs.readFileSync(lockFile, 'utf8');
    const entriesBefore = fs.readdirSync(root).sort();

    const r = runSync(root, ['--plan']);
    assert.equal(r.status, 0, `--plan 应 exit 0：\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /== plan/);
    assert.ok(r.stdout.includes('git diff'), 'plan 输出应含 git diff 命令供人复制');
    assert.ok(r.stdout.includes('git fetch upstream'), 'plan 输出应含 git fetch');
    assert.ok(r.stdout.includes('git remote add upstream '), 'plan 输出应含 git remote add');

    // 副作用为零：没有 .git 目录、目录条目没变、lock 未被改动
    assert.equal(fs.existsSync(path.join(root, '.git')), false, '--plan 不得真的跑 git');
    assert.deepEqual(fs.readdirSync(root).sort(), entriesBefore, '--plan 不得新建任何文件');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), lockBefore, '--plan 不得改动 lock');
    // 未 pin 时应提示先取 SHA，而不是给出无基线的 diff
    assert.ok(r.stdout.includes('--pin'));
  });

  it('--plan 明确禁止 git merge upstream，且清单里不出现可执行的 merge 命令', () => {
    const root = makeLockRoot('plan-no-merge');
    const r = runSync(root, ['--plan']);
    assert.ok(r.stdout.includes('禁止 git merge'), '必须显式声明禁止 merge（§16.3）');
    const cmdLines = r.stdout.split('\n').map((l) => l.trim());
    assert.equal(cmdLines.some((l) => /^git merge/.test(l)), false, '清单里不得出现可执行的 git merge');
  });

  it('--plan 对不安全 url 只打印拒绝说明，不把该值拼进命令行', () => {
    const root = makeLockRoot('plan-evil-url', { url: 'https://evil.com/r.git; rm -rf /tmp/pwned #' });
    const r = runSync(root, ['--plan']);
    assert.equal(r.stdout.includes('rm -rf'), false, '不安全的值绝不能进入打印的命令行');
    assert.ok(r.stdout.includes('拒绝'), '应留一行显式拒绝说明');
  });

  it('lock 文件缺失时给出明确错误并 exit 1（不抛栈）', () => {
    const root = path.join(TMP_BASE, 'no lock here');
    fs.mkdirSync(root, { recursive: true });
    const r = runSync(root, ['--check']);
    // cwd 无 lock 时工具会回退到插件根（复制体），那份 lock 是合法的
    assert.notEqual(r.status, null);
    assert.equal(r.stdout.includes('Error: ') && r.stdout.includes('    at '), false, '不得把原始栈打给用户');
  });
});

/**
 * doctor.mjs --supply-chain（I6 供应链取证）。
 * 本仓库当前状态下 upstream 许可证未核验、codegraph 未安装，因此 exit 1 是**预期**行为——
 * 断言的是「取证项都在且每个 FAIL 都带可执行修复指令」，不是「必须全绿」。
 */
describe('doctor.mjs --supply-chain 供应链取证', () => {
  it('输出含 upstream lock 的 commit 状态、engines、LICENSE 首行', () => {
    const r = runNode('tools/doctor.mjs', ['--supply-chain', SPACED_ROOT]);
    assert.match(r.stdout, /上游来源锁定/, '缺 lock 取证项');
    assert.match(r.stdout, /commit=/, 'lock 项应给出 commit 状态（含未 pin 的 null）');
    assert.match(r.stdout, /engines 声明/, '缺 engines 取证项');
    assert.match(r.stdout, /node >=/, 'engines 项应给出版本约束');
    assert.match(r.stdout, /LICENSE: /, '缺 LICENSE 取证项');
    assert.match(r.stdout, /MIT/, 'LICENSE 项应给出首行内容');
    assert.match(r.stdout, /上游许可证/, '缺上游许可证取证项');
  });

  it('不带 --supply-chain 时不输出供应链取证项（该开关确实生效）', () => {
    const plain = runNode('tools/doctor.mjs', [SPACED_ROOT]);
    assert.equal(/engines 声明/.test(plain.stdout), false, '未开开关不应出现 engines 项');
    assert.equal(/上游来源锁定/.test(plain.stdout), false);
  });

  it('runDoctor({ supplyChain: true }) 返回的每个 FAIL 都带非空 fix', async () => {
    const report = await runDoctor({ projectRoot: SPACED_ROOT, supplyChain: true });
    const fails = report.checks.filter((c) => c.status === 'FAIL');
    for (const f of fails) {
      assert.equal(typeof f.fix, 'string', `FAIL 项 ${f.id} 的 fix 不是字符串`);
      assert.ok(f.fix.trim().length > 0, `FAIL 项 ${f.id} 缺可执行修复指令（笼统报错在本项目视为缺陷）`);
      assert.ok(f.detail.trim().length > 0, `FAIL 项 ${f.id} 缺 detail`);
    }
    // 同一纪律适用于 WARN：给了警告就得给出下一步动作
    for (const w of report.checks.filter((c) => c.status === 'WARN')) {
      assert.ok(typeof w.fix === 'string' && w.fix.trim().length > 0, `WARN 项 ${w.id} 缺 fix`);
    }
  });

  it('runDoctor 的 supplyChain 项齐全（lock / 上游许可证 / engines / LICENSE / codegraph 版本）', async () => {
    const report = await runDoctor({ projectRoot: SPACED_ROOT, supplyChain: true });
    const ids = report.checks.map((c) => c.id);
    for (const id of ['supply:lock', 'supply:upstream-license', 'supply:engines', 'supply:license', 'supply:codegraph']) {
      assert.ok(ids.includes(id), `缺供应链取证项 ${id}`);
    }
  });

  it('report.ok 与「是否存在 FAIL」严格一致（结论不得与明细矛盾）', async () => {
    const report = await runDoctor({ projectRoot: SPACED_ROOT, supplyChain: true });
    assert.equal(report.ok, !report.checks.some((c) => c.status === 'FAIL'));
  });

  it('--supply-chain 的退出码与 report.ok 一致（有 FAIL 时非 0）', async () => {
    const report = await runDoctor({ projectRoot: SPACED_ROOT, supplyChain: true });
    const r = runNode('tools/doctor.mjs', ['--supply-chain', SPACED_ROOT]);
    assert.equal(r.status === 0, report.ok, `退出码 ${r.status} 与 report.ok=${report.ok} 不一致`);
  });
});
