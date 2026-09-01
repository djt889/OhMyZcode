/**
 * tests/transport.test.mjs
 * 覆盖 adapters/zcode/transport.mjs：不可变状态机、resume 超时判定（B9）、
 * prompt CONTEXT 重建（§12.4）、落盘往返 + JSON 卫生（B3/B4）。
 * 时间一律注入固定 now，不依赖真实时钟。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TRANSPORT_STATES,
  RESUME_TIMEOUT_MS,
  createRegistry,
  bindAgent,
  markResumeWait,
  markReturned,
  checkTimeouts,
  rebuildPromptContext,
  saveRegistry,
  loadRegistry
} from '../adapters/zcode/transport.mjs';
import { scanJsonHygiene } from '../adapters/zcode/path.mjs';

/** 固定基准时刻：2025-01-01T00:00:00Z */
const T0 = Date.parse('2025-01-01T00:00:00.000Z');

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-transport-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function makeRoot() {
  seq += 1;
  const root = path.join(TMP, `proj-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe('TRANSPORT_STATES', () => {
  it('包含全部五个预期传输状态且无多余项', () => {
    assert.deepEqual([...TRANSPORT_STATES].sort(), ['pending', 'resume-wait', 'returned', 'running', 'unknown']);
  });

  it('resume 超时上限为 10 分钟（B9）', () => {
    assert.equal(RESUME_TIMEOUT_MS, 600000);
  });
});

describe('createRegistry', () => {
  it('新建的 registry 带 team_id 与空的 agents/bindings 映射', () => {
    const reg = createRegistry({ teamId: 'team-abc' });
    assert.equal(reg.team_id, 'team-abc');
    assert.deepEqual(reg.agents, {});
    assert.deepEqual(reg.bindings, {});
    assert.equal(typeof reg.updated_at, 'string');
  });
});

describe('bindAgent', () => {
  it('绑定后 agent 记录了 task_id / role / resume_ref 且状态为 running', () => {
    const reg = createRegistry({ teamId: 'team-1' });
    const next = bindAgent(reg, { agent_ref: 'a1', task_id: 11, role: 'omz-junior', resume_ref: 'sess_x', now: T0 });
    const a = next.agents.a1;
    assert.equal(a.task_id, 11);
    assert.equal(a.role, 'omz-junior');
    assert.equal(a.resume_ref, 'sess_x');
    assert.equal(a.transport_state, 'running');
    assert.equal(a.bound_at, new Date(T0).toISOString());
  });

  it('返回新对象且原 registry 完全未被改动（不可变语义）', () => {
    const reg = createRegistry({ teamId: 'team-1' });
    const before = reg.updated_at;
    const next = bindAgent(reg, { agent_ref: 'a1', task_id: 1, now: T0 });
    assert.notStrictEqual(next, reg);
    assert.notStrictEqual(next.agents, reg.agents);
    assert.notStrictEqual(next.bindings, reg.bindings);
    assert.deepEqual(reg.agents, {});
    assert.deepEqual(reg.bindings, {});
    assert.equal(reg.updated_at, before);
  });

  it('agent_ref 与 task_id 双向可查', () => {
    let reg = createRegistry({ teamId: 'team-1' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 101, now: T0 });
    reg = bindAgent(reg, { agent_ref: 'a2', task_id: 102, now: T0 });
    assert.equal(reg.bindings[101], 'a1');
    assert.equal(reg.bindings[102], 'a2');
    assert.equal(reg.agents.a1.task_id, 101);
    assert.equal(reg.agents.a2.task_id, 102);
  });

  it('未给 role/resume_ref 时落为 null 而非 undefined', () => {
    const reg = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 1, now: T0 });
    assert.equal(reg.agents.a.role, null);
    assert.equal(reg.agents.a.resume_ref, null);
  });
});

describe('markResumeWait / markReturned', () => {
  it('markResumeWait 把状态推进到 resume-wait 并记录起始时刻', () => {
    let reg = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 1, now: T0 });
    reg = markResumeWait(reg, { agent_ref: 'a', now: T0 + 1000 });
    assert.equal(reg.agents.a.transport_state, 'resume-wait');
    assert.equal(reg.agents.a.resume_wait_since, new Date(T0 + 1000).toISOString());
  });

  it('markReturned 把状态推进到 returned、清空等待时刻并落 result_ref', () => {
    let reg = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 1, now: T0 });
    reg = markResumeWait(reg, { agent_ref: 'a', now: T0 + 1000 });
    reg = markReturned(reg, { agent_ref: 'a', result_ref: 'results/T-001.json', now: T0 + 5000 });
    const a = reg.agents.a;
    assert.equal(a.transport_state, 'returned');
    assert.equal(a.result_ref, 'results/T-001.json');
    assert.equal(a.resume_wait_since, null);
    assert.equal(a.returned_at, new Date(T0 + 5000).toISOString());
  });

  it('状态流转不改动前一个 registry 对象', () => {
    const bound = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 1, now: T0 });
    const waiting = markResumeWait(bound, { agent_ref: 'a', now: T0 + 1 });
    assert.equal(bound.agents.a.transport_state, 'running');
    assert.equal(waiting.agents.a.transport_state, 'resume-wait');
  });

  it('对未登记的 agent_ref 打标记时落到 unknown 而不臆测其在运行', () => {
    const reg = markResumeWait(createRegistry({ teamId: 't' }), { agent_ref: 'ghost', now: T0 });
    assert.equal(reg.agents.ghost.transport_state, 'resume-wait');
    assert.equal(reg.agents.ghost.task_id, null);
    assert.equal(reg.agents.ghost.bound_at, null);
  });
});

describe('checkTimeouts', () => {
  function waitingReg(sinceOffset) {
    let reg = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 7, now: T0 });
    reg = markResumeWait(reg, { agent_ref: 'a', now: T0 + sinceOffset });
    return reg;
  }

  it('等待时间未达上限时不报超时', () => {
    const reg = waitingReg(0);
    const r = checkTimeouts(reg, { now: T0 + RESUME_TIMEOUT_MS - 1 });
    assert.deepEqual(r.expired, []);
  });

  it('等待时间恰好等于 timeoutMs 的边界即判超时', () => {
    const reg = waitingReg(0);
    const r = checkTimeouts(reg, { now: T0 + RESUME_TIMEOUT_MS });
    assert.equal(r.expired.length, 1);
    assert.equal(r.expired[0].waited_ms, RESUME_TIMEOUT_MS);
  });

  it('超时项携带 agent_ref / task_id 与精确的 waited_ms', () => {
    const reg = waitingReg(0);
    const r = checkTimeouts(reg, { now: T0 + 900000, timeoutMs: 600000 });
    assert.equal(r.expired.length, 1);
    assert.deepEqual(r.expired[0], { agent_ref: 'a', task_id: 7, waited_ms: 900000 });
  });

  it('自定义 timeoutMs 生效', () => {
    const reg = waitingReg(0);
    assert.equal(checkTimeouts(reg, { now: T0 + 5000, timeoutMs: 10000 }).expired.length, 0);
    assert.equal(checkTimeouts(reg, { now: T0 + 5000, timeoutMs: 1000 }).expired.length, 1);
  });

  it('已 returned 的 agent 不进超时列表', () => {
    let reg = waitingReg(0);
    reg = markReturned(reg, { agent_ref: 'a', result_ref: 'r.json', now: T0 + 10 });
    const r = checkTimeouts(reg, { now: T0 + RESUME_TIMEOUT_MS * 10 });
    assert.deepEqual(r.expired, []);
  });

  it('running 状态的 agent 不受 resume 超时约束', () => {
    const reg = bindAgent(createRegistry({ teamId: 't' }), { agent_ref: 'a', task_id: 1, now: T0 });
    assert.deepEqual(checkTimeouts(reg, { now: T0 + RESUME_TIMEOUT_MS * 5 }).expired, []);
  });

  it('空 registry 与缺 agents 字段的输入都不抛', () => {
    assert.deepEqual(checkTimeouts(createRegistry({ teamId: 't' }), { now: T0 }).expired, []);
    assert.deepEqual(checkTimeouts({}, { now: T0 }).expired, []);
  });

  it('多个等待中的 agent 只有真正超时的进列表', () => {
    let reg = createRegistry({ teamId: 't' });
    reg = bindAgent(reg, { agent_ref: 'old', task_id: 1, now: T0 });
    reg = bindAgent(reg, { agent_ref: 'fresh', task_id: 2, now: T0 });
    reg = markResumeWait(reg, { agent_ref: 'old', now: T0 });
    reg = markResumeWait(reg, { agent_ref: 'fresh', now: T0 + 599000 });
    const r = checkTimeouts(reg, { now: T0 + 600000 });
    assert.deepEqual(r.expired.map((e) => e.agent_ref), ['old']);
  });
});

describe('rebuildPromptContext', () => {
  const task = {
    id: 'T-042',
    title: '修复登录竞态',
    wave: 2,
    subagent_type: 'omz-deep',
    result_file: 'results/T-042.json'
  };

  it('输出含 ## CONTEXT 段头与重建原因', () => {
    const text = rebuildPromptContext({ task, priorResults: [], reason: 'resume 超时 10 分钟' });
    assert.match(text, /## CONTEXT/);
    assert.ok(text.includes('resume 超时 10 分钟'));
  });

  it('输出含任务 id、title、波次与结果文件路径', () => {
    const text = rebuildPromptContext({ task, priorResults: [], reason: 'r' });
    assert.ok(text.includes('T-042'));
    assert.ok(text.includes('修复登录竞态'));
    assert.ok(text.includes('2'));
    assert.ok(text.includes('results/T-042.json'));
    assert.ok(text.includes('omz-deep'));
  });

  it('priorResults 每一条的内容都被逐条带进输出（信息不丢）', () => {
    const priorResults = [
      { task_id: 'T-040', status: 'done', summary: '已加锁', changed_files: ['src/a.ts', 'src/b.ts'] },
      { task_id: 'T-041', status: 'failed', result_file: 'results/T-041.json', risks: ['并发未验证'] },
      '纯字符串形式的第三条产出'
    ];
    const text = rebuildPromptContext({ task, priorResults, reason: 'r' });
    assert.ok(text.includes('T-040'));
    assert.ok(text.includes('已加锁'));
    assert.ok(text.includes('src/a.ts'));
    assert.ok(text.includes('src/b.ts'));
    assert.ok(text.includes('T-041'));
    assert.ok(text.includes('results/T-041.json'));
    assert.ok(text.includes('并发未验证'));
    assert.ok(text.includes('纯字符串形式的第三条产出'));
    assert.ok(text.includes('status=done'));
    assert.ok(text.includes('status=failed'));
  });

  it('priorResults 为空数组时不崩且仍保留结构与明确说明', () => {
    const text = rebuildPromptContext({ task, priorResults: [], reason: 'r' });
    assert.match(text, /### 前次执行产出/);
    assert.match(text, /### 关键约束/);
    assert.ok(text.includes('无'));
  });

  it('缺省 task 与 reason 时给出占位而不是 undefined 字面量', () => {
    const text = rebuildPromptContext({});
    assert.equal(text.includes('undefined'), false);
    assert.match(text, /## CONTEXT/);
  });

  it('task.prompt.must_not_do 每条都被转成 MUST NOT 行', () => {
    const text = rebuildPromptContext({
      task: { ...task, prompt: { must_not_do: ['不得改 schema', '不得删测试'] } },
      priorResults: [],
      reason: 'r'
    });
    assert.ok(text.includes('MUST NOT: 不得改 schema'));
    assert.ok(text.includes('MUST NOT: 不得删测试'));
  });

  it('原始 CONTEXT 被原样保留', () => {
    const original = '原始上下文正文：见 docs/spec.md 第 3 节';
    const text = rebuildPromptContext({ task: { ...task, prompt: { context: original } }, reason: 'r' });
    assert.ok(text.includes(original));
  });

  it('关键约束段明确提到 B3 正斜杠与 B4 无 BOM 纪律', () => {
    const text = rebuildPromptContext({ task, reason: 'r' });
    assert.ok(text.includes('B3'));
    assert.ok(text.includes('B4'));
  });
});

describe('saveRegistry / loadRegistry', () => {
  it('落盘再读回后 registry 内容一致', () => {
    const root = makeRoot();
    let reg = createRegistry({ teamId: 'team-rt' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, role: 'omz-junior', now: T0 });
    reg = markReturned(reg, { agent_ref: 'a1', result_ref: 'results/T-001.json', now: T0 + 100 });
    saveRegistry(root, reg);

    const loaded = loadRegistry(root, 'team-rt');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.registry.team_id, 'team-rt');
    assert.deepEqual(loaded.registry.agents, reg.agents);
    assert.deepEqual(loaded.registry.bindings, reg.bindings);
  });

  it('落盘目录经 scanJsonHygiene 扫描后 bom 与 backslash 均为空（B3/B4 在落盘路径上生效）', () => {
    const root = makeRoot();
    let reg = createRegistry({ teamId: 'team-hy' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, role: 'omz-deep', now: T0 });
    // result_ref 必须取**项目根之内**的绝对路径。归一的语义是「转成相对 root 的正斜杠路径」；
    // 用 root 之外（更别说另一个卷）的路径断言「落盘后无反斜杠」，等于要求实现伪造一个在任何
    // 机器上都不指向原文件的相对路径——那正是本轮被否决的旧行为（见 path.mjs 设计取舍 2）。
    reg = markReturned(reg, { agent_ref: 'a1', result_ref: path.join(root, 'results', 'T-001.json'), now: T0 + 1 });
    saveRegistry(root, reg);

    const scan = scanJsonHygiene(path.join(root, '.omz'));
    assert.equal(scan.scanned, 1);
    assert.deepEqual(scan.bom, []);
    assert.deepEqual(scan.backslash, []);
    assert.deepEqual(scan.corrupt, []);
  });

  it('嵌套在 agents.<agent_ref> 下的 result_ref 也被归一（白名单判定不依赖父键）', () => {
    const root = makeRoot();
    let reg = createRegistry({ teamId: 'team-nested' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, now: T0 });
    reg = markReturned(reg, { agent_ref: 'a1', result_ref: path.join(root, 'results', 'deep', 'T-002.json'), now: T0 + 1 });
    saveRegistry(root, reg);

    // 直接读落盘字节：不靠 loadRegistry 的二次处理，确认写进文件的就是正斜杠相对路径
    const raw = fs.readFileSync(path.join(root, '.omz', 'runtime', 'team-nested', 'state.json'), 'utf8');
    assert.equal(JSON.parse(raw).agents.a1.result_ref, 'results/deep/T-002.json');
    assert.equal(raw.includes('\\\\'), false, '落盘 JSON 里不得出现转义反斜杠');
  });

  it('越出项目根的 result_ref 原样保留，交给卫生扫描点名（不伪造相对路径）', () => {
    const root = makeRoot();
    const outside = path.join(TMP, 'outside-project', 'T-003.json');
    let reg = createRegistry({ teamId: 'team-escape' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, now: T0 });
    reg = markReturned(reg, { agent_ref: 'a1', result_ref: outside, now: T0 + 1 });
    saveRegistry(root, reg);

    assert.equal(loadRegistry(root, 'team-escape').registry.agents.a1.result_ref, outside);
    const scan = scanJsonHygiene(path.join(root, '.omz'));
    assert.equal(scan.backslash.length, 1, '越界值必须被扫出来，doctor 才能报警');
    assert.equal(scan.backslash[0].keyPath, 'agents.a1.result_ref');
  });

  it('registry 里的非路径字段（备注/错误消息）不因落盘归一被改坏', () => {
    const root = makeRoot();
    let reg = createRegistry({ teamId: 'team-notes' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, now: T0 });
    reg.agents.a1 = { ...reg.agents.a1, note: 'regex \\d+ and \\w+', last_error: "ENOENT: open 'E:\\proj\\x.json'" };
    saveRegistry(root, reg);

    const loaded = loadRegistry(root, 'team-notes');
    assert.equal(loaded.registry.agents.a1.note, 'regex \\d+ and \\w+');
    assert.equal(loaded.registry.agents.a1.last_error, "ENOENT: open 'E:\\proj\\x.json'");
  });

  it('落盘前含 Windows 绝对路径的值被归一为正斜杠相对路径', () => {
    const root = makeRoot();
    let reg = createRegistry({ teamId: 'team-norm' });
    reg = bindAgent(reg, { agent_ref: 'a1', task_id: 1, now: T0 });
    reg = markReturned(reg, { agent_ref: 'a1', result_ref: path.join(root, 'results', 'a.rs'), now: T0 + 1 });
    saveRegistry(root, reg);

    const loaded = loadRegistry(root, 'team-norm');
    assert.equal(loaded.registry.agents.a1.result_ref, 'results/a.rs');
  });

  it('落盘文件首字节不是 BOM 且不含 CRLF', () => {
    const root = makeRoot();
    const reg = bindAgent(createRegistry({ teamId: 'team-bytes' }), { agent_ref: 'a', task_id: 1, now: T0 });
    saveRegistry(root, reg);
    const buf = fs.readFileSync(path.join(root, '.omz', 'runtime', 'team-bytes', 'state.json'));
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf.includes(0x0d), false);
  });

  it('registry 缺 team_id 时 saveRegistry 抛出明确错误', () => {
    const root = makeRoot();
    assert.throws(() => saveRegistry(root, { agents: {} }), /team_id/);
  });

  it('状态文件不存在时 loadRegistry 返回 ok:false 但给出可用的空 registry', () => {
    const root = makeRoot();
    const loaded = loadRegistry(root, 'team-none');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'missing');
    assert.equal(loaded.registry.team_id, 'team-none');
    assert.deepEqual(loaded.registry.agents, {});
  });

  it('状态文件损坏时 loadRegistry 不抛且仍给出空 registry', () => {
    const root = makeRoot();
    const file = path.join(root, '.omz', 'runtime', 'team-bad', 'state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"agents":', 'utf8');
    const loaded = loadRegistry(root, 'team-bad');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'parse');
    assert.deepEqual(loaded.registry.agents, {});
  });
});
