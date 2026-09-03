/**
 * tests/integration.test.mjs
 * 端到端：在临时项目根里跑一次完整 team 编排（不真 spawn agent，用 coordinator + 文件状态模拟）。
 * 覆盖 配置加载 → 能力探测 → profile 解析 → DAG 波次编排 → 失败重试 → lease 回收 →
 *      镜像导出落盘 → /omz-status 渲染 → JSON 卫生扫描 → doctor 自检 → 降级链。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveProfiles, formatDegradeReport } from '../adapters/zcode/fallback.mjs';
import { probeAll, probeCoordinator } from '../adapters/zcode/capability.mjs';
import { scanJsonHygiene, writeJsonSafe, deepNormalizePaths } from '../adapters/zcode/path.mjs';
import { createBoulder, writeSlot, readSlot, migrateLegacyView, resolveContinuation } from '../adapters/zcode/boulder.mjs';
import { closeDb, openDb } from '../mcp/coordinator/db.mjs';
import {
  teamCreate,
  dagSubmit,
  taskClaim,
  taskComplete,
  taskFail,
  reclaimExpired,
  exportMirror,
  status as coordinatorStatus
} from '../mcp/coordinator/core.mjs';
import { collectStatus, render } from '../tools/render-status.mjs';
import { runDoctor } from '../tools/doctor.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const T0 = 1735689600; // 2025-01-01T00:00:00Z

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-integration-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
/** 造一个"健康的"项目根：.gitignore 含 .omz/、.zcode/config.json 开启 orchestration。 */
function makeProject({ orchestration = true } = {}) {
  seq += 1;
  const root = path.join(TMP, `proj-${seq}`);
  fs.mkdirSync(path.join(root, '.zcode'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.omz/\n*.log\n', 'utf8');
  fs.writeFileSync(
    path.join(root, '.zcode', 'config.json'),
    JSON.stringify({ omz: { profile: 'orchestration', orchestration: { enabled: orchestration } } }, null, 2),
    'utf8'
  );
  return root;
}

function openProjectDb(t, root) {
  const dbPath = path.join(root, '.omz', 'runtime', 'coordinator.sqlite');
  const db = openDb(dbPath);
  t.after(() => {
    closeDb(db);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  });
  return { db, dbPath };
}

/** 三波次 6 任务：w1(A,B) → w2(C,D) → w3(E,F)；C/D 依赖 A、B，E/F 依赖 C、D。 */
const WAVE_TASKS = [
  { key: 'A', title: '波1-读现状', wave: 1, payload: { subagent_type: 'omz-junior' } },
  { key: 'B', title: '波1-建基线', wave: 1, payload: { subagent_type: 'omz-junior' } },
  { key: 'C', title: '波2-实现主逻辑', wave: 2, payload: { subagent_type: 'omz-deep' } },
  { key: 'D', title: '波2-实现适配层', wave: 2, payload: { subagent_type: 'omz-junior' } },
  { key: 'E', title: '波3-评审', wave: 3, payload: { subagent_type: 'omz-reviewer' } },
  { key: 'F', title: '波3-收尾文档', wave: 3, payload: { subagent_type: 'omz-junior' } }
];
const WAVE_DEPS = [
  { from: 'A', to: 'C' },
  { from: 'B', to: 'C' },
  { from: 'A', to: 'D' },
  { from: 'B', to: 'D' },
  { from: 'C', to: 'E' },
  { from: 'D', to: 'E' },
  { from: 'C', to: 'F' },
  { from: 'D', to: 'F' }
];

/**
 * 把 exportMirror 的结果按 .omz/runtime/<teamId>/ 布局落盘（state.json + tasks/<key>.json）。
 *
 * 文件名用 **task.key** 而不是 task.id：镜像的 id 现在是自增数字（消除跨图 key 碰撞的歧义），
 * 拿它当文件名会让 tasks/ 目录变成 1.json、2.json——人无法从目录直接指认任务，
 * 而 §7.3 镜像的用途正是给人读。key 在图内唯一，配合 state.json 足以定位。
 *
 * 落盘前过 deepNormalizePaths——与 transport.saveRegistry 同一纪律：
 * exportMirror 是纯查询，原样返回库里存的 result_ref；B3 归一的责任在落盘调用方。
 */
function writeMirror(root, mirror) {
  const teamDir = path.join(root, '.omz', 'runtime', mirror.state.team_id);
  const clean = deepNormalizePaths(mirror, root);
  writeJsonSafe(path.join(teamDir, 'state.json'), clean.state);
  for (const task of clean.tasks) {
    writeJsonSafe(path.join(teamDir, 'tasks', `${task.key}.json`), task);
  }
  return teamDir;
}

describe('配置 → 能力 → profile', () => {
  it('健康项目根上 orchestration profile 被激活且无降级', async () => {
    const root = makeProject();
    const { config, sources } = loadConfig(root);
    assert.equal(config.orchestration.enabled, true);
    assert.equal(sources.find((s) => s.file.includes('.zcode')).ok, true);

    const caps = await probeAll({ pluginRoot: PLUGIN_ROOT, cwd: root });
    assert.equal(caps.coordinator.available, true, `coordinator 应可用：${caps.coordinator.error}`);
    const resolved = resolveProfiles(config, caps);
    assert.equal(resolved.active.core, true);
    assert.equal(resolved.active.orchestration, true);
    assert.equal(resolved.degraded.some((d) => d.profile === 'orchestration'), false);
  });
});

describe('三波次 DAG 编排全流程', () => {
  it('波次顺序被依赖强制：wave2 在 wave1 全 done 前不可认领', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'wave-order' });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS, deps: WAVE_DEPS });

    // 起点只有 wave1 的 A/B 可派
    const first = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-1', now: T0 });
    const second = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-2', now: T0 });
    assert.deepEqual([first.task.key, second.task.key].sort(), ['A', 'B']);
    const third = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-3', now: T0 });
    assert.equal(third.task, null, 'wave1 未完成前不得派出 wave2');

    // 只完成 A，wave2 仍不可派（C/D 各有两个上游）
    taskComplete(db, { task_id: first.task.id, agent_ref: 'w-1', result_ref: 'results/A.json', now: T0 + 1 });
    assert.equal(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-4', now: T0 + 2 }).task, null);

    // 完成 B 后 wave2 的 C/D 同时解锁
    const afterB = taskComplete(db, { task_id: second.task.id, agent_ref: 'w-2', result_ref: 'results/B.json', now: T0 + 3 });
    assert.equal(afterB.unblocked.length, 2);
    const w2a = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-5', now: T0 + 4 });
    const w2b = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-6', now: T0 + 4 });
    assert.deepEqual([w2a.task.key, w2b.task.key].sort(), ['C', 'D']);
    assert.equal(taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w-7', now: T0 + 5 }).task, null, 'wave3 尚不可派');
  });

  it('中途失败的任务重试后仍能成功完成', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'retry' });
    const g = dagSubmit(db, {
      team_id: team.team_id,
      tasks: [{ key: 'A', max_attempts: 3 }, { key: 'B' }],
      deps: [{ from: 'A', to: 'B' }]
    });
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const failed = taskFail(db, {
      task_id: c1.task.id,
      agent_ref: 'w1',
      error: '测试用例首轮红灯',
      retry_at: T0 + 10,
      idempotency_key: 'fail-1',
      now: T0 + 5
    });
    assert.equal(failed.status, 'ready');
    assert.equal(failed.dead_letter, false);

    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1-retry', now: T0 + 10 });
    assert.equal(c2.task.id, c1.task.id);
    assert.equal(c2.task.attempts, 2, 'attempts 应累计，不被重试重置');
    const ok = taskComplete(db, {
      task_id: c2.task.id,
      agent_ref: 'w1-retry',
      result_ref: 'results/A.json',
      idempotency_key: 'done-A',
      now: T0 + 20
    });
    assert.equal(ok.status, 'done');
    assert.deepEqual(ok.unblocked, [g.task_ids.B]);
  });

  it('lease 过期的任务被回收后可重新认领并完成', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'reclaim' });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: [{ key: 'A', max_attempts: 5 }] });

    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'ghost', lease_seconds: 60, now: T0 });
    const reclaimed = reclaimExpired(db, { graph_id: g.graph_id, now: T0 + 61 });
    assert.equal(reclaimed.reclaimed.length, 1);
    assert.equal(reclaimed.reclaimed[0].status, 'ready');

    // 传输维度被标 unknown，调度维度回 ready——两者独立（I3）
    const s = coordinatorStatus(db, { team_id: team.team_id });
    assert.equal(db.prepare('SELECT transport_state FROM agents WHERE agent_ref = ?').get('ghost').transport_state, 'unknown');
    assert.equal(s.tasks.list[0].coordinator_state, 'ready');

    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'fresh', now: T0 + 62 });
    assert.equal(c2.task.id, c1.task.id);
    const done = taskComplete(db, { task_id: c2.task.id, agent_ref: 'fresh', result_ref: 'results/A.json', now: T0 + 70 });
    assert.equal(done.status, 'done');
  });

  it('六个任务全部走完后 counts.done 为 6 且无 ready/running/blocked 残留', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'full-run' });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS, deps: WAVE_DEPS });

    let now = T0;
    let completed = 0;
    for (let round = 0; round < 10 && completed < WAVE_TASKS.length; round += 1) {
      // 一轮内把当前所有 ready 任务派完（波次并行），记录 agent_ref 以便 complete 时校验 owner
      const batch = [];
      for (;;) {
        const agent_ref = `w-${round}-${batch.length}`;
        const r = taskClaim(db, { graph_id: g.graph_id, agent_ref, now });
        if (!r.task) break;
        batch.push({ agent_ref, task: r.task });
      }
      assert.ok(batch.length > 0, `第 ${round} 轮无任务可派，但仍有未完成任务`);
      // 同一轮派出的任务必须属于同一波次：依赖关系强制了波次边界
      const waves = new Set(batch.map((b) => b.task.wave));
      assert.equal(waves.size, 1, `第 ${round} 轮混入了多个波次：${[...waves]}`);
      assert.equal([...waves][0], round + 1, `第 ${round} 轮应是 wave${round + 1}`);
      now += 10;
      for (const { agent_ref, task } of batch) {
        taskComplete(db, {
          task_id: task.id,
          agent_ref,
          result_ref: `results/${task.key}.json`,
          idempotency_key: `done-${task.key}`,
          now
        });
        completed += 1;
      }
    }
    assert.equal(completed, 6);
    const s = coordinatorStatus(db, { team_id: team.team_id });
    assert.equal(s.tasks.counts.done, 6);
    assert.equal(s.tasks.counts.ready, 0);
    assert.equal(s.tasks.counts.running, 0);
    assert.equal(s.tasks.counts.blocked, 0);
  });
});

describe('镜像落盘 → /omz-status 渲染 → 卫生扫描', () => {
  it('exportMirror 落盘后 collectStatus 渲染含所有任务且总行数不超过 40（硬上限）', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'mirror-run' });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS, deps: WAVE_DEPS });

    // 跑完 wave1 让镜像里出现 done/pending 混合态
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    const c2 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w2', now: T0 });
    taskComplete(db, { task_id: c1.task.id, agent_ref: 'w1', result_ref: `results/${c1.task.key}.json`, now: T0 + 1 });
    taskComplete(db, { task_id: c2.task.id, agent_ref: 'w2', result_ref: `results/${c2.task.key}.json`, now: T0 + 2 });

    const mirror = exportMirror(db, { team_id: team.team_id });
    writeMirror(root, mirror);

    const lines = collectStatus(path.join(root, '.omz'));
    assert.ok(lines.length <= 40, `渲染行数 ${lines.length} 超过 40 行硬上限`);
    assert.ok(lines.some((l) => l.startsWith(`[team] ${team.team_id}`)), '应含 team 行');
    for (const task of WAVE_TASKS) {
      assert.ok(lines.some((l) => l.includes(` ${task.key} `)), `渲染缺任务 ${task.key}`);
    }
    // 渲染器自身的 40 行截断逻辑也应保持输出不超限
    const text = render(path.join(root, '.omz'));
    assert.ok(text.split('\n').length <= 40);
  });

  it('镜像落盘后 scanJsonHygiene 扫 .omz/ 的 bom/backslash/corrupt 全空', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'hygiene-run' });
    const g = dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS, deps: WAVE_DEPS });
    const c1 = taskClaim(db, { graph_id: g.graph_id, agent_ref: 'w1', now: T0 });
    // 故意用 Windows 绝对路径作 result_ref，检验落盘归一
    taskComplete(db, {
      task_id: c1.task.id,
      agent_ref: 'w1',
      result_ref: path.join(root, 'results', `${c1.task.key}.json`),
      now: T0 + 1
    });

    const mirror = exportMirror(db, { team_id: team.team_id });
    writeMirror(root, mirror);

    const scan = scanJsonHygiene(path.join(root, '.omz'));
    assert.ok(scan.scanned >= 7, `应至少扫到 state.json + 6 个任务文件，实际 ${scan.scanned}`);
    assert.deepEqual(scan.bom, []);
    assert.deepEqual(scan.corrupt, []);
    assert.deepEqual(
      scan.backslash.map((b) => `${path.relative(root, b.file)}#${b.keyPath}`),
      [],
      `落盘状态里出现反斜杠路径值（B3）：${JSON.stringify(scan.backslash)}`
    );
    // 落盘文件名用 key（人可读），且绝对路径的 result_ref 已归一为正斜杠相对路径
    const taskFile = path.join(root, '.omz', 'runtime', team.team_id, 'tasks', `${c1.task.key}.json`);
    assert.equal(fs.existsSync(taskFile), true, `镜像任务文件应以 key 命名：${taskFile}`);
    const written = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    assert.equal(written.result_file, `results/${c1.task.key}.json`);
    assert.equal(written.key, c1.task.key);
    assert.equal(written.id, c1.task.id, '文件内仍保留数字 id 作为消歧主键');
  });

  it('损坏的单个任务文件不拖垮整板渲染（标 corrupt 继续）', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'corrupt-run' });
    dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS.slice(0, 3), deps: [] });
    const mirror = exportMirror(db, { team_id: team.team_id });
    const teamDir = writeMirror(root, mirror);
    fs.writeFileSync(path.join(teamDir, 'tasks', 'A.json'), '{"id": "A", ', 'utf8');

    const lines = collectStatus(path.join(root, '.omz'));
    assert.ok(lines.some((l) => l.includes('corrupt')), '损坏行应被标 corrupt');
    assert.ok(lines.some((l) => l.includes(' B ')), '其余任务仍应渲染');
  });

  it('镜像文件以 key 命名、内容带数字 id：渲染面板显示可读 key 而非自增数字', (t) => {
    const root = makeProject();
    const { db } = openProjectDb(t, root);
    const team = teamCreate(db, { name: 'naming-run' });
    dagSubmit(db, { team_id: team.team_id, tasks: WAVE_TASKS, deps: WAVE_DEPS });
    const mirror = exportMirror(db, { team_id: team.team_id });
    const teamDir = writeMirror(root, mirror);

    const files = fs.readdirSync(path.join(teamDir, 'tasks')).sort();
    assert.deepEqual(files, WAVE_TASKS.map((t2) => `${t2.key}.json`).sort());
    // 反向断言：不得出现 1.json 这类以自增 id 命名的文件
    assert.equal(files.some((f) => /^\d+\.json$/.test(f)), false, '镜像文件名不得是自增数字');

    const lines = collectStatus(path.join(root, '.omz'));
    for (const t2 of WAVE_TASKS) {
      assert.ok(lines.some((l) => l.includes(` ${t2.key} `)), `面板缺可读 key ${t2.key}`);
    }
  });
});

describe('doctor 自检', () => {
  it('健康临时项目根上无 FAIL；若有 FAIL 则每条都带可执行 fix', async (t) => {
    const root = makeProject();
    const report = await runDoctor({ projectRoot: root });
    const fails = report.checks.filter((c) => c.status === 'FAIL');
    for (const f of fails) {
      assert.ok(typeof f.fix === 'string' && f.fix.length > 0, `FAIL 项 ${f.id} 缺可执行修复指令`);
    }
    assert.deepEqual(fails.map((f) => f.id), [], `不应有 FAIL：${fails.map((f) => `${f.id}: ${f.detail}`).join('；')}`);
    assert.equal(report.ok, true);
    assert.match(report.summaryLine, /① agents/);
  });

  it('缺 .gitignore 的项目根被 doctor 判 FAIL 并给出可执行修复指令（B14）', async () => {
    seq += 1;
    const root = path.join(TMP, `no-gitignore-${seq}`);
    fs.mkdirSync(root, { recursive: true });
    const report = await runDoctor({ projectRoot: root });
    const gitignore = report.checks.find((c) => c.id === 'gitignore');
    assert.equal(gitignore.status, 'FAIL');
    assert.ok(gitignore.fix.includes('.gitignore'));
    assert.equal(report.ok, false);
  });

  it('.omz/ 里有 BOM 或反斜杠路径时 doctor 的卫生检查判 FAIL 并逐项点名', async () => {
    seq += 1;
    const root = path.join(TMP, `dirty-${seq}`);
    fs.mkdirSync(path.join(root, '.omz', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.omz/\n', 'utf8');
    fs.writeFileSync(path.join(root, '.omz', 'bom.json'), '\uFEFF{"a":1}\n', 'utf8');
    fs.writeFileSync(
      path.join(root, '.omz', 'runtime', 'bad.json'),
      JSON.stringify({ tasks: [{ result_file: 'E:\\p\\r.json' }] }) + '\n',
      'utf8'
    );

    const report = await runDoctor({ projectRoot: root });
    const hygiene = report.checks.find((c) => c.id === 'hygiene');
    assert.equal(hygiene.status, 'FAIL');
    assert.match(hygiene.detail, /BOM 1 个/);
    assert.match(hygiene.detail, /反斜杠路径 1 处/);
    assert.ok(hygiene.fix.length > 0);
    assert.equal(report.ok, false);
  });
});

describe('降级链', () => {
  it('orchestration 已启用但 coordinator 不可用时报降级，core 仍为 true', async () => {
    const root = makeProject();
    // 指向一个没有 mcp/coordinator/server.mjs 的假插件根：能力探测必须失败而不抛
    seq += 1;
    const fakePluginRoot = path.join(TMP, `fake-plugin-${seq}`);
    fs.mkdirSync(fakePluginRoot, { recursive: true });

    const coordinator = await probeCoordinator(fakePluginRoot);
    assert.equal(coordinator.available, false);
    assert.ok(coordinator.error.length > 0);

    const { config } = loadConfig(root);
    const resolved = resolveProfiles(config, { coordinator });
    assert.equal(resolved.active.core, true, 'core 必须不受外部依赖影响（I2）');
    assert.equal(resolved.active.orchestration, false);
    const entry = resolved.degraded.find((d) => d.profile === 'orchestration');
    assert.ok(entry, 'orchestration 应进降级表');
    assert.ok(entry.reason.includes('server.mjs'));
    assert.ok(entry.fallback.length > 0);

    const text = formatDegradeReport(resolved);
    assert.match(text, /降级 1 项/);
    assert.ok(text.includes(entry.reason));
  });

  it('coordinator 不可用时 dashboard 快照仍能回退文件视图（展示失效不阻断调度）', async (t) => {
    const root = makeProject();
    // 只写文件视图状态，不建 db
    const teamDir = path.join(root, '.omz', 'runtime', 'team-files');
    writeJsonSafe(path.join(teamDir, 'tasks', 'T-1.json'), { id: 'T-1', wave: 1, status: 'done', title: '文件态任务' });

    const { collectSnapshot } = await import('../dashboard/server.mjs');
    const snap = collectSnapshot({ projectRoot: root });
    assert.equal(snap.source, 'files');
    assert.equal(snap.degraded.length, 1);
    assert.equal(snap.teams[0].id, 'team-files');
    const task = snap.tasks.find((x) => x.key === 'T-1');
    assert.equal(task.coordinator_state, 'done');
    assert.equal(task.transport_state, null);
    assert.ok(Array.isArray(snap.notes));
  });

  it('config 未启用 orchestration 时不算降级（用户没开不等于坏了）', async () => {
    const root = makeProject({ orchestration: false });
    const caps = await probeAll({ pluginRoot: PLUGIN_ROOT, cwd: root });
    const { config } = loadConfig(root);
    const resolved = resolveProfiles(config, caps);
    assert.equal(resolved.active.orchestration, false);
    assert.deepEqual(resolved.degraded.filter((d) => d.profile === 'orchestration'), []);
    assert.equal(resolved.active.core, true);
  });
});

/**
 * 端到端：两个会话在同一项目根各跑一次 /ulw 的状态面，检验槽位化真的解决了 B32。
 * 这里不模拟 LLM 行为，只按协议规定的写入顺序落盘，然后用真实的 render-status 渲染。
 */
describe('两会话同根并发的状态面（B32 端到端）', () => {
  it('两个会话各自的 goal 与槽位都完整，看板同时列出两条 boulder 行', () => {
    const root = makeProject();
    // 会话 A：注册 goal → 写自己的槽位
    writeJsonSafe(path.join(root, '.omz', 'goal', 'sess_AAA.json'), {
      session_id: 'sess_AAA',
      id_source: 'real-session-id',
      outcome: 'A 的目标：重构缓存层'
    });
    const a = createBoulder({ stem: 'sess_AAA', sessionId: 'sess_AAA' });
    a.works = ['A-work'];
    a.active_plan = '.omz/plans/sess_AAA-refactor-cache.md';
    writeSlot(root, a, { now: Date.parse('2026-09-03T10:00:00.000Z') });

    // 会话 B：并发注册自己的 goal 与槽位
    writeJsonSafe(path.join(root, '.omz', 'goal', 'sess_BBB.json'), {
      session_id: 'sess_BBB',
      id_source: 'real-session-id',
      outcome: 'B 的目标：修登录 bug'
    });
    const b = createBoulder({ stem: 'sess_BBB', sessionId: 'sess_BBB' });
    b.works = ['B-work'];
    b.active_plan = '.omz/plans/sess_BBB-fix-login.md';
    writeSlot(root, b, { now: Date.parse('2026-09-03T11:00:00.000Z') });

    // A 的槽位在 B 落盘后依然完整——旧单文件实现在这里会读到 B 的内容
    const ra = readSlot(root, 'sess_AAA');
    assert.equal(ra.ok, true, 'A 的槽位不该被 B 覆盖');
    assert.equal(ra.slot.active_goal, '.omz/goal/sess_AAA.json');
    assert.deepEqual(ra.slot.works, ['A-work']);
    assert.deepEqual(ra.slot.session_ids, ['sess_AAA']);
    assert.equal(readSlot(root, 'sess_BBB').slot.active_goal, '.omz/goal/sess_BBB.json');

    // 两个 goal 文件也都在
    assert.deepEqual(fs.readdirSync(path.join(root, '.omz', 'goal')).sort(), ['sess_AAA.json', 'sess_BBB.json']);

    // 看板同时列出两条 boulder 行（最近活动的 B 在前）
    const lines = collectStatus(path.join(root, '.omz'));
    const boulderLines = lines.filter((l) => l.startsWith('[boulder]'));
    assert.equal(boulderLines.length, 2, `应有两条 boulder 行，实际：${JSON.stringify(boulderLines)}`);
    assert.ok(boulderLines[0].includes('sess_BBB'), '最近活动的槽位应排最前');
    assert.ok(boulderLines[1].includes('sess_AAA'));
    assert.ok(lines.length <= 40, `渲染行数 ${lines.length} 超过 40 行硬上限`);
  });

  it('续跑判定给出 choose 分支并按最近活动倒序列出候选', () => {
    const root = makeProject();
    writeSlot(root, createBoulder({ stem: 'sess_older' }), { now: Date.parse('2026-09-01T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 'sess_newer' }), { now: Date.parse('2026-09-03T00:00:00.000Z') });

    const r = resolveContinuation(root);
    assert.equal(r.action, 'choose', '两个未关闭槽位必须让用户选，不得替他挑');
    assert.deepEqual(r.slots.map((s) => s.stem), ['sess_newer', 'sess_older']);
    for (const s of r.slots) {
      assert.equal(typeof s.active_goal, 'string');
      assert.equal(typeof s.updated_at, 'string');
    }
  });

  it('一个会话收尾后另一个仍是 active，续跑退回 confirm 分支', () => {
    const root = makeProject();
    writeSlot(root, createBoulder({ stem: 'sess_finish' }));
    writeSlot(root, createBoulder({ stem: 'sess_live' }));

    const done = readSlot(root, 'sess_finish').slot;
    done.status = 'done';
    done.finished_at = '2026-09-03T12:00:00.000Z';
    writeSlot(root, done);

    const r = resolveContinuation(root);
    assert.equal(r.action, 'confirm');
    assert.deepEqual(r.slots.map((s) => s.stem), ['sess_live']);
  });

  it('旧单文件项目根被迁成槽位后不丢字段，看板照常渲染', () => {
    const root = makeProject();
    // 1.7.x 的旧布局：只有 .omz/boulder.json，没有 boulder/ 目录
    writeJsonSafe(path.join(root, '.omz', 'boulder.json'), {
      works: ['legacy-work'],
      active_plan: '.omz/plans/legacy.md',
      session_ids: ['sess_LEGACY'],
      status: 'active',
      worktree_path: null,
      active_goal: '.omz/goal/sess_LEGACY.json',
      active_team: 'team-legacy',
      finished_at: null
    });

    const m = migrateLegacyView(root);
    assert.equal(m.migrated, true);
    assert.equal(m.stem, 'sess_LEGACY');
    const slot = readSlot(root, 'sess_LEGACY').slot;
    assert.deepEqual(slot.works, ['legacy-work']);
    assert.equal(slot.active_team, 'team-legacy');

    const lines = collectStatus(path.join(root, '.omz'));
    const boulderLines = lines.filter((l) => l.startsWith('[boulder]'));
    assert.equal(boulderLines.length, 1);
    assert.ok(boulderLines[0].includes('sess_LEGACY'));
  });

  it('落盘的槽位与派生视图经 scanJsonHygiene 扫描后无 BOM/反斜杠/损坏', () => {
    const root = makeProject();
    const b = createBoulder({ stem: 'sess_hygiene', sessionId: 'sess_hygiene' });
    // 故意给 Windows 绝对路径，检验落盘归一（B3）
    b.active_plan = path.join(root, '.omz', 'plans', 'sess_hygiene-x.md');
    b.worktree_path = path.join(root, 'wt', 'feature');
    writeSlot(root, b);

    const scan = scanJsonHygiene(path.join(root, '.omz'));
    assert.deepEqual(scan.bom, []);
    assert.deepEqual(scan.corrupt, []);
    assert.deepEqual(
      scan.backslash.map((x) => `${path.relative(root, x.file)}#${x.keyPath}`),
      [],
      `槽位或派生视图里出现反斜杠路径（B3）：${JSON.stringify(scan.backslash)}`
    );
    const slot = readSlot(root, 'sess_hygiene').slot;
    assert.equal(slot.active_plan, '.omz/plans/sess_hygiene-x.md');
    assert.equal(slot.worktree_path, 'wt/feature');
  });

  it('派生视图自带 derived 标记，且不参与续跑决策（删掉它续跑仍准确）', () => {
    const root = makeProject();
    writeSlot(root, createBoulder({ stem: 'sess_derived' }));
    const view = JSON.parse(fs.readFileSync(path.join(root, '.omz', 'boulder.json'), 'utf8'));
    assert.equal(view.source, 'derived');
    assert.equal(view.active_goal, '.omz/goal/sess_derived.json');

    // 删掉派生视图：续跑决策只读槽位目录，不受影响
    fs.rmSync(path.join(root, '.omz', 'boulder.json'), { force: true });
    const r = resolveContinuation(root);
    assert.equal(r.action, 'confirm');
    assert.equal(r.slots[0].stem, 'sess_derived');
  });

  it('doctor 在含槽位的项目根上仍无 FAIL（槽位不引入新的卫生问题）', async () => {
    const root = makeProject();
    writeSlot(root, createBoulder({ stem: 'sess_doctor', sessionId: 'sess_doctor' }));
    const report = await runDoctor({ projectRoot: root });
    const fails = report.checks.filter((c) => c.status === 'FAIL');
    assert.deepEqual(fails.map((f) => f.id), [], `不应有 FAIL：${fails.map((f) => `${f.id}: ${f.detail}`).join('；')}`);
    assert.equal(report.ok, true);
  });
});
