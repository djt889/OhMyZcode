/**
 * tests/boulder.test.mjs
 * 覆盖 adapters/zcode/boulder.mjs：boulder 槽位化（B32 多会话同根并发丢数据）。
 *
 * 【为什么要有槽位】
 * 旧实现把 `.omz/boulder.json` 当单值事实源，`active_goal` / `works` / `session_ids` 都是单槽。
 * 两个会话在同一项目根各跑一次 /ulw，第二个会话写 boulder 时会把第一个的指针整体覆盖——
 * goal 文件都还在，但指向它们的指针只剩一个，先写的那个会话此后读到的是别人的目标。
 * 加文件锁解决不了：锁只防写交错（writeJsonSafe 的 tmp+rename 本来就没这问题），
 * 排队之后第二个会话照样覆盖——病根是「单槽位两个主人」，不是写的时机。
 * 因此改成每会话一个槽位文件 `.omz/boulder/<stem>.json`，**目录本身就是索引**，
 * 没有共享可变索引也就没有丢更新，全程不需要锁。
 *
 * 纪律：临时目录一律在 os.tmpdir() 下，after 清零；绝不写仓库内任何文件。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOULDER_DIR_REL,
  BOULDER_VIEW_REL,
  BOULDER_STATUSES,
  safeStem,
  boulderDir,
  slotPath,
  viewPath,
  createBoulder,
  readSlot,
  writeSlot,
  listSlots,
  openSlots,
  deriveView,
  writeView,
  migrateLegacyView,
  resolveContinuation
} from '../adapters/zcode/boulder.mjs';

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-boulder-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function makeRoot(label = 'proj') {
  seq += 1;
  const root = path.join(TMP, `${label}-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 造一个已落盘的槽位，updated_at 由调用方指定以便断言排序。 */
function seedSlot(root, stem, patch = {}) {
  const b = createBoulder({ stem, ...patch });
  writeSlot(root, b);
  return b;
}

describe('常量与 safeStem', () => {
  it('槽位目录与派生视图的相对路径都是正斜杠形态（B3）', () => {
    assert.equal(BOULDER_DIR_REL, '.omz/boulder');
    assert.equal(BOULDER_VIEW_REL, '.omz/boulder.json');
    assert.equal(BOULDER_DIR_REL.includes('\\'), false);
  });

  it('BOULDER_STATUSES 是冻结的三态枚举（与 OmO v2 一致）', () => {
    assert.equal(Object.isFrozen(BOULDER_STATUSES), true);
    assert.deepEqual([...BOULDER_STATUSES], ['active', 'paused', 'done']);
  });

  it('真实 sessionId 与回退 stem 两种形态都原样保留（都已是文件名安全的）', () => {
    assert.equal(safeStem('sess_c99601d3-02cd-45d1-a53e-58f7464a1edc'), 'sess_c99601d3-02cd-45d1-a53e-58f7464a1edc');
    assert.equal(safeStem('2026-09-01T1430-a1b2c3d'), '2026-09-01T1430-a1b2c3d');
    assert.equal(safeStem('2026-09-01T1503-nogit'), '2026-09-01T1503-nogit');
  });

  it('非法字符被替换为下划线，路径穿越无法成形', () => {
    // 与 hooks 的 safeSessionId、transport 的 safeTeamId 同一字符集 [^A-Za-z0-9_-]：
    // 点号也被替换，所以文件名里绝不会出现 `..`（这条性质一眼可查）
    assert.equal(safeStem('../../etc/passwd'), '______etc_passwd');
    assert.equal(safeStem('a b:c/d\\e'), 'a_b_c_d_e');
    assert.equal(safeStem('中文stem'), '__stem');
    for (const bad of ['../../etc/passwd', '..\\..\\evil', 'a/../b']) {
      assert.equal(safeStem(bad).includes('..'), false, `${bad} 安全化后仍含 ..`);
      assert.equal(/[\\/]/.test(safeStem(bad)), false, `${bad} 安全化后仍含分隔符`);
    }
  });

  it('空 / null / undefined 退化为 unknown 而非空文件名', () => {
    for (const bad of ['', null, undefined, '   ']) {
      assert.equal(safeStem(bad).length > 0, true, `safeStem(${JSON.stringify(bad)}) 不得为空`);
    }
    assert.equal(safeStem(''), 'unknown');
    assert.equal(safeStem(null), 'unknown');
  });

  it('超长 stem 被截断（不生成超长文件名）', () => {
    assert.ok(safeStem('z'.repeat(500)).length <= 96);
  });
});

describe('路径解析', () => {
  it('boulderDir / slotPath / viewPath 都落在 <root>/.omz 之下', () => {
    const root = makeRoot();
    const base = path.resolve(root, '.omz');
    for (const p of [boulderDir(root), slotPath(root, 'sess_x'), viewPath(root)]) {
      assert.ok(path.resolve(p).startsWith(base), `${p} 逃出了 ${base}`);
    }
  });

  it('槽位文件名就是 <安全化 stem>.json', () => {
    const root = makeRoot();
    assert.equal(path.basename(slotPath(root, 'sess_abc')), 'sess_abc.json');
    assert.equal(path.basename(slotPath(root, '2026-09-01T1430-a1b2c3d')), '2026-09-01T1430-a1b2c3d.json');
  });

  it('带 ../ 的 stem 经安全化后仍在 boulder 目录内（第二道防线：越界即抛）', () => {
    const root = makeRoot();
    const p = path.resolve(slotPath(root, '../../evil'));
    assert.ok(p.startsWith(path.resolve(boulderDir(root)) + path.sep), `${p} 逃出了槽位目录`);
    assert.equal(path.basename(p).includes('..'), false, '文件名里不得出现 ..');
  });
});

describe('createBoulder', () => {
  it('OmO v2 原 5 字段名一字不改，OMZ 扩展字段齐全', () => {
    const b = createBoulder({ stem: 'sess_x' });
    for (const k of ['works', 'active_plan', 'session_ids', 'status', 'worktree_path']) {
      assert.ok(k in b, `缺 OmO v2 原字段 ${k}`);
    }
    for (const k of ['active_goal', 'active_team', 'finished_at', 'stem', 'updated_at']) {
      assert.ok(k in b, `缺 OMZ 扩展字段 ${k}`);
    }
  });

  it('默认值符合协议：status=active、finished_at=null、数组为空', () => {
    const b = createBoulder({ stem: 'sess_x' });
    assert.equal(b.status, 'active');
    assert.equal(b.finished_at, null);
    assert.equal(b.active_plan, null);
    assert.equal(b.active_team, null);
    assert.equal(b.worktree_path, null);
    assert.deepEqual(b.works, []);
    assert.deepEqual(b.session_ids, []);
  });

  it('stem 被写进槽位内容（自证归属，不靠文件名反推）', () => {
    assert.equal(createBoulder({ stem: 'sess_self' }).stem, 'sess_self');
  });

  it('sessionId 为真实值时进 session_ids；回退命名下保持空数组（不塞占位符）', () => {
    assert.deepEqual(createBoulder({ stem: 'sess_real', sessionId: 'sess_real' }).session_ids, ['sess_real']);
    // 回退 stem：拿不到真实 sessionId，数组必须是空的而不是 ['UNAVAILABLE']
    assert.deepEqual(createBoulder({ stem: '2026-09-01T1430-a1b2c3d' }).session_ids, []);
    for (const bad of ['UNAVAILABLE', '', null, undefined]) {
      assert.deepEqual(createBoulder({ stem: 's', sessionId: bad }).session_ids, [], `sessionId=${bad} 不得进数组`);
    }
  });

  it('active_goal 缺省时按 stem 推导为正斜杠相对路径', () => {
    assert.equal(createBoulder({ stem: 'sess_g' }).active_goal, '.omz/goal/sess_g.json');
    assert.equal(createBoulder({ stem: 'sess_g' }).active_goal.includes('\\'), false);
  });

  it('显式传入的 active_goal 优先于推导值', () => {
    const b = createBoulder({ stem: 'sess_g', activeGoal: '.omz/goal/custom.json' });
    assert.equal(b.active_goal, '.omz/goal/custom.json');
  });

  it('缺 stem 时抛出明确错误（槽位没有 stem 就无法归属）', () => {
    assert.throws(() => createBoulder({}), /stem/);
    assert.throws(() => createBoulder(), /stem/);
  });
});

describe('writeSlot / readSlot 往返', () => {
  it('落盘再读回后内容一致，且 updated_at 被刷新', () => {
    const root = makeRoot();
    const b = createBoulder({ stem: 'sess_rt', sessionId: 'sess_rt' });
    writeSlot(root, b, { now: Date.parse('2026-09-01T10:00:00.000Z') });
    const r = readSlot(root, 'sess_rt');
    assert.equal(r.ok, true);
    assert.equal(r.slot.stem, 'sess_rt');
    assert.equal(r.slot.updated_at, '2026-09-01T10:00:00.000Z');
    assert.deepEqual(r.slot.session_ids, ['sess_rt']);
  });

  it('落盘文件无 BOM、无 CRLF、结尾恰好一个换行（B4）', () => {
    const root = makeRoot();
    writeSlot(root, createBoulder({ stem: 'sess_bytes' }));
    const buf = fs.readFileSync(slotPath(root, 'sess_bytes'));
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf.includes(0x0d), false);
    assert.equal(buf.subarray(-1)[0], 0x0a);
  });

  it('active_goal / active_plan / worktree_path 落盘时被归一为正斜杠相对路径（B3）', () => {
    const root = makeRoot();
    const b = createBoulder({ stem: 'sess_paths' });
    b.active_plan = path.join(root, '.omz', 'plans', 'x.md');
    b.worktree_path = path.join(root, 'wt', 'feature');
    writeSlot(root, b);
    const raw = fs.readFileSync(slotPath(root, 'sess_paths'), 'utf8');
    assert.equal(raw.includes('\\\\'), false, `落盘 JSON 不得含转义反斜杠：${raw}`);
    const r = readSlot(root, 'sess_paths');
    assert.equal(r.slot.active_plan, '.omz/plans/x.md');
    assert.equal(r.slot.worktree_path, 'wt/feature');
  });

  it('槽位里的非路径字段不因归一被改坏（正则/错误消息原样）', () => {
    const root = makeRoot();
    const b = createBoulder({ stem: 'sess_notes' });
    b.note = 'regex \\d+ and \\w+';
    b.last_error = "ENOENT: open 'E:\\proj\\x.json'";
    writeSlot(root, b);
    const r = readSlot(root, 'sess_notes');
    assert.equal(r.slot.note, 'regex \\d+ and \\w+');
    assert.equal(r.slot.last_error, "ENOENT: open 'E:\\proj\\x.json'");
  });

  it('槽位不存在时 readSlot 返回 ok:false / reason:missing 且不抛', () => {
    const root = makeRoot();
    const r = readSlot(root, 'sess_none');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
    assert.equal(r.slot, null);
  });

  it('槽位损坏时 readSlot 不抛且给出 reason（不吞掉损坏信号）', () => {
    const root = makeRoot();
    const p = slotPath(root, 'sess_bad');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"stem":', 'utf8');
    let r;
    assert.doesNotThrow(() => {
      r = readSlot(root, 'sess_bad');
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parse');
    assert.equal(r.slot, null);
  });

  it('writeSlot 拒绝缺 stem 的对象（不产生无主槽位）', () => {
    const root = makeRoot();
    assert.throws(() => writeSlot(root, { status: 'active' }), /stem/);
  });

  it('同一槽位重复写只更新自己，不产生第二个文件', () => {
    const root = makeRoot();
    const b = createBoulder({ stem: 'sess_idem' });
    writeSlot(root, b);
    b.status = 'paused';
    writeSlot(root, b);
    assert.deepEqual(fs.readdirSync(boulderDir(root)), ['sess_idem.json']);
    assert.equal(readSlot(root, 'sess_idem').slot.status, 'paused');
  });
});

/**
 * 并发隔离——本模块存在的全部理由。
 * 旧单文件实现下，第二个会话写 boulder 会把第一个的 active_goal/works/session_ids 整体覆盖；
 * 槽位化之后每个会话只写自己那一个文件，目录即索引，不需要任何锁。
 */
describe('多会话同根并发隔离（B32）', () => {
  it('两个会话各写自己的槽位，彼此的指针都不丢', () => {
    const root = makeRoot('concurrent');
    const a = createBoulder({ stem: 'sess_AAA', sessionId: 'sess_AAA' });
    a.works = ['A-work'];
    writeSlot(root, a);

    const b = createBoulder({ stem: 'sess_BBB', sessionId: 'sess_BBB' });
    b.works = ['B-work'];
    writeSlot(root, b);

    // 关键断言：A 的槽位在 B 落盘后依然完整（旧实现在这里会读到 B 的内容）
    const ra = readSlot(root, 'sess_AAA');
    assert.equal(ra.ok, true, 'A 的槽位不该被 B 覆盖');
    assert.equal(ra.slot.active_goal, '.omz/goal/sess_AAA.json');
    assert.deepEqual(ra.slot.works, ['A-work']);
    assert.deepEqual(ra.slot.session_ids, ['sess_AAA']);

    const rb = readSlot(root, 'sess_BBB');
    assert.equal(rb.slot.active_goal, '.omz/goal/sess_BBB.json');
    assert.deepEqual(rb.slot.works, ['B-work']);
    assert.deepEqual(rb.slot.session_ids, ['sess_BBB']);
  });

  it('十个会话交错写入后十个槽位全部完整（目录即索引，无共享可变状态）', () => {
    const root = makeRoot('ten');
    const stems = Array.from({ length: 10 }, (_, i) => `sess_${String(i).padStart(2, '0')}`);
    // 交错两轮写入，模拟并发下的乱序落盘
    for (const stem of stems) writeSlot(root, createBoulder({ stem, sessionId: stem }));
    for (const stem of [...stems].reverse()) {
      const r = readSlot(root, stem);
      r.slot.works = [`${stem}-work`];
      writeSlot(root, r.slot);
    }
    assert.equal(listSlots(root).slots.length, 10);
    for (const stem of stems) {
      const r = readSlot(root, stem);
      assert.equal(r.ok, true, `${stem} 的槽位丢失`);
      assert.equal(r.slot.active_goal, `.omz/goal/${stem}.json`);
      assert.deepEqual(r.slot.works, [`${stem}-work`]);
    }
  });

  it('一个会话把自己的槽位标 done，不影响另一个会话仍是 active', () => {
    const root = makeRoot('done-one');
    seedSlot(root, 'sess_done');
    seedSlot(root, 'sess_live');
    const r = readSlot(root, 'sess_done');
    r.slot.status = 'done';
    r.slot.finished_at = '2026-09-03T12:00:00.000Z';
    writeSlot(root, r.slot);

    assert.equal(readSlot(root, 'sess_live').slot.status, 'active');
    const open = openSlots(root);
    assert.deepEqual(open.slots.map((s) => s.stem), ['sess_live']);
  });

  it('写入 A 的槽位不会创建或改动 B 的文件（mtime 与内容双证）', () => {
    const root = makeRoot('no-touch');
    seedSlot(root, 'sess_untouched');
    const target = slotPath(root, 'sess_untouched');
    const before = { mtime: fs.statSync(target).mtimeMs, body: fs.readFileSync(target, 'utf8') };

    seedSlot(root, 'sess_writer');
    for (let i = 0; i < 3; i += 1) {
      const r = readSlot(root, 'sess_writer');
      r.slot.works = [`w${i}`];
      writeSlot(root, r.slot);
    }
    assert.equal(fs.readFileSync(target, 'utf8'), before.body, 'B 的槽位内容被改动了');
    assert.equal(fs.statSync(target).mtimeMs, before.mtime, 'B 的槽位被重写（mtime 变了）');
  });

  it('槽位目录不存在时 listSlots 返回空且不抛（首次运行）', () => {
    const root = makeRoot('empty');
    const r = listSlots(root);
    assert.deepEqual(r.slots, []);
    assert.deepEqual(r.corrupt, []);
  });

  it('单个槽位损坏不拖垮其余槽位的枚举（损坏项进 corrupt 显式可见）', () => {
    const root = makeRoot('partial');
    seedSlot(root, 'sess_ok1');
    seedSlot(root, 'sess_ok2');
    fs.writeFileSync(slotPath(root, 'sess_broken'), '{"stem":', 'utf8');

    const r = listSlots(root);
    assert.deepEqual(r.slots.map((s) => s.stem).sort(), ['sess_ok1', 'sess_ok2']);
    assert.equal(r.corrupt.length, 1, '损坏槽位必须被显式列出，不得无声跳过');
    assert.match(r.corrupt[0].file, /sess_broken\.json$/);
    assert.equal(typeof r.corrupt[0].reason, 'string');
  });

  it('非 .json 文件被忽略（不当槽位解析）', () => {
    const root = makeRoot('nonjson');
    seedSlot(root, 'sess_real');
    fs.writeFileSync(path.join(boulderDir(root), 'notes.md'), '# not a slot\n', 'utf8');
    const r = listSlots(root);
    assert.deepEqual(r.slots.map((s) => s.stem), ['sess_real']);
    assert.deepEqual(r.corrupt, []);
  });
});

describe('openSlots 与排序', () => {
  it('只返回 status 非 done 的槽位', () => {
    const root = makeRoot('open');
    for (const [stem, status] of [['s_a', 'active'], ['s_p', 'paused'], ['s_d', 'done']]) {
      const b = createBoulder({ stem });
      b.status = status;
      writeSlot(root, b);
    }
    assert.deepEqual(openSlots(root).slots.map((s) => s.stem).sort(), ['s_a', 's_p']);
  });

  it('按 updated_at 倒序返回（最近活动的排最前，便于用户选）', () => {
    const root = makeRoot('sorted');
    writeSlot(root, createBoulder({ stem: 's_old' }), { now: Date.parse('2026-09-01T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 's_new' }), { now: Date.parse('2026-09-03T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 's_mid' }), { now: Date.parse('2026-09-02T00:00:00.000Z') });
    assert.deepEqual(openSlots(root).slots.map((s) => s.stem), ['s_new', 's_mid', 's_old']);
  });

  it('缺 updated_at 的历史槽位排在末尾但不被丢弃', () => {
    const root = makeRoot('no-ts');
    writeSlot(root, createBoulder({ stem: 's_has' }), { now: Date.parse('2026-09-02T00:00:00.000Z') });
    const legacy = createBoulder({ stem: 's_none' });
    delete legacy.updated_at;
    fs.writeFileSync(slotPath(root, 's_none'), JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    const stems = openSlots(root).slots.map((s) => s.stem);
    assert.deepEqual(stems, ['s_has', 's_none']);
  });

  it('未关闭槽位为空时返回空数组（全部 done）', () => {
    const root = makeRoot('all-done');
    const b = createBoulder({ stem: 's_x' });
    b.status = 'done';
    writeSlot(root, b);
    assert.deepEqual(openSlots(root).slots, []);
  });
});

/**
 * 派生视图：只喂 tools/render-status.mjs 与 dashboard，永不参与续跑决策。
 * 正因为它不参与决策，它输给竞态也无害——这是「不需要锁」的另一半理由。
 */
describe('deriveView / writeView 派生视图', () => {
  it('单槽位时视图字段与该槽位一致（旧看板零改动可读）', () => {
    const root = makeRoot('view-one');
    const b = createBoulder({ stem: 'sess_v', sessionId: 'sess_v' });
    b.active_plan = '.omz/plans/x.md';
    b.active_team = 'team-1';
    writeSlot(root, b);

    const view = deriveView(root);
    assert.equal(view.active_goal, '.omz/goal/sess_v.json');
    assert.equal(view.active_plan, '.omz/plans/x.md');
    assert.equal(view.active_team, 'team-1');
    assert.equal(view.status, 'active');
  });

  it('视图保留 render-status 依赖的四个顶层字段（兼容契约）', () => {
    const root = makeRoot('view-shape');
    seedSlot(root, 'sess_shape');
    const view = deriveView(root);
    for (const k of ['active_goal', 'active_plan', 'active_team', 'status']) {
      assert.ok(k in view, `派生视图缺 render-status 依赖的字段 ${k}`);
    }
  });

  it('多槽位时视图指向最近活动的那个，并列出全部未关闭 stem', () => {
    const root = makeRoot('view-many');
    writeSlot(root, createBoulder({ stem: 's_old' }), { now: Date.parse('2026-09-01T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 's_new' }), { now: Date.parse('2026-09-03T00:00:00.000Z') });

    const view = deriveView(root);
    assert.equal(view.active_goal, '.omz/goal/s_new.json', '视图应指向最近活动的槽位');
    assert.deepEqual(view.open_stems, ['s_new', 's_old']);
    assert.equal(view.open_count, 2);
  });

  it('视图显式标注自己是派生物，不得被当作事实源', () => {
    const root = makeRoot('view-note');
    seedSlot(root, 'sess_n');
    const view = deriveView(root);
    assert.equal(view.source, 'derived');
    assert.match(String(view.note ?? ''), /派生|derived/);
  });

  it('无任何槽位时视图给出 status:none 且不抛', () => {
    const root = makeRoot('view-none');
    let view;
    assert.doesNotThrow(() => {
      view = deriveView(root);
    });
    assert.equal(view.status, 'none');
    assert.equal(view.active_goal, null);
    assert.equal(view.open_count, 0);
  });

  it('writeView 落盘到 .omz/boulder.json，字节无 BOM 无 CRLF', () => {
    const root = makeRoot('view-write');
    seedSlot(root, 'sess_w');
    writeView(root);
    const buf = fs.readFileSync(viewPath(root));
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf.includes(0x0d), false);
    assert.equal(JSON.parse(buf.toString('utf8')).active_goal, '.omz/goal/sess_w.json');
  });

  it('writeSlot 顺带刷新派生视图（调用方不必记得两步）', () => {
    const root = makeRoot('view-auto');
    writeSlot(root, createBoulder({ stem: 'sess_auto' }));
    assert.equal(fs.existsSync(viewPath(root)), true, 'writeSlot 应顺带写出派生视图');
    assert.equal(JSON.parse(fs.readFileSync(viewPath(root), 'utf8')).active_goal, '.omz/goal/sess_auto.json');
  });
});

/**
 * 旧单文件 boulder 的一次性迁移：必须确定且可复现，且**绝不丢字段**。
 * 迁移是升级路径上唯一会碰用户既有数据的动作，所以它必须幂等、可重入。
 */
describe('migrateLegacyView 旧单文件迁移', () => {
  /** 造一份 1.7.x 形态的旧 boulder.json（无 stem 字段）。 */
  function seedLegacy(root, patch = {}) {
    const legacy = {
      works: ['legacy-work'],
      active_plan: '.omz/plans/legacy.md',
      session_ids: ['sess_LEGACY'],
      status: 'active',
      worktree_path: null,
      active_goal: '.omz/goal/sess_LEGACY.json',
      active_team: 'team-legacy',
      finished_at: null,
      ...patch
    };
    fs.mkdirSync(path.join(root, '.omz'), { recursive: true });
    fs.writeFileSync(viewPath(root), JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    return legacy;
  }

  it('旧单文件被迁成一个槽位，OmO v2 五字段全部保留', () => {
    const root = makeRoot('mig');
    const legacy = seedLegacy(root);
    const r = migrateLegacyView(root);
    assert.equal(r.migrated, true);
    assert.equal(r.stem, 'sess_LEGACY', 'stem 应从 active_goal 的文件名推导');

    const slot = readSlot(root, 'sess_LEGACY').slot;
    assert.deepEqual(slot.works, legacy.works);
    assert.equal(slot.active_plan, legacy.active_plan);
    assert.deepEqual(slot.session_ids, legacy.session_ids);
    assert.equal(slot.status, legacy.status);
    assert.equal(slot.worktree_path, legacy.worktree_path);
    assert.equal(slot.active_goal, legacy.active_goal);
    assert.equal(slot.active_team, legacy.active_team);
    assert.equal(slot.finished_at, legacy.finished_at);
  });

  it('迁移是幂等的：重复调用不产生第二个槽位、不覆盖已有内容', () => {
    const root = makeRoot('mig-idem');
    seedLegacy(root);
    migrateLegacyView(root);
    // 迁移后用户又更新了槽位
    const slot = readSlot(root, 'sess_LEGACY').slot;
    slot.works = ['updated-after-migration'];
    writeSlot(root, slot);

    const again = migrateLegacyView(root);
    assert.equal(again.migrated, false, '槽位目录已有内容时不得再次迁移');
    assert.deepEqual(readSlot(root, 'sess_LEGACY').slot.works, ['updated-after-migration'], '迁移不得覆盖用户后续更新');
    assert.equal(listSlots(root).slots.length, 1);
  });

  it('active_goal 缺失的旧文件用回退 stem 迁移，不丢数据', () => {
    const root = makeRoot('mig-nogoal');
    seedLegacy(root, { active_goal: null });
    const r = migrateLegacyView(root);
    assert.equal(r.migrated, true);
    assert.ok(r.stem.length > 0, '必须有一个确定的回退 stem');
    const slot = readSlot(root, r.stem).slot;
    assert.deepEqual(slot.works, ['legacy-work'], '回退命名下同样不得丢字段');
  });

  it('已 done 的旧文件也被迁移（历史记录保留，只是不算未关闭）', () => {
    const root = makeRoot('mig-done');
    seedLegacy(root, { status: 'done', finished_at: '2026-09-01T00:00:00.000Z' });
    assert.equal(migrateLegacyView(root).migrated, true);
    assert.equal(readSlot(root, 'sess_LEGACY').slot.status, 'done');
    assert.deepEqual(openSlots(root).slots, [], 'done 的迁移结果不该出现在未关闭列表');
  });

  it('无旧文件时 migrated:false 且不抛（全新项目）', () => {
    const root = makeRoot('mig-fresh');
    let r;
    assert.doesNotThrow(() => {
      r = migrateLegacyView(root);
    });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, 'no-legacy');
  });

  it('旧文件损坏时不迁移、不抛、给出可读原因（不吞损坏信号）', () => {
    const root = makeRoot('mig-broken');
    fs.mkdirSync(path.join(root, '.omz'), { recursive: true });
    fs.writeFileSync(viewPath(root), '{"works":', 'utf8');
    let r;
    assert.doesNotThrow(() => {
      r = migrateLegacyView(root);
    });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, 'legacy-unreadable');
    assert.deepEqual(listSlots(root).slots, [], '损坏的旧文件不得被猜着迁移');
  });

  it('迁移后的派生视图与槽位一致（看板立即可读）', () => {
    const root = makeRoot('mig-view');
    seedLegacy(root);
    migrateLegacyView(root);
    const view = JSON.parse(fs.readFileSync(viewPath(root), 'utf8'));
    assert.equal(view.active_goal, '.omz/goal/sess_LEGACY.json');
    assert.equal(view.source, 'derived');
  });

  it('已经是新形态（有槽位、无旧文件）时不做任何事', () => {
    const root = makeRoot('mig-already');
    seedSlot(root, 'sess_new');
    fs.rmSync(viewPath(root), { force: true });
    const r = migrateLegacyView(root);
    assert.equal(r.migrated, false);
    assert.equal(listSlots(root).slots.length, 1);
  });
});

/**
 * 续跑决策三分支：0 个未关闭 → 全新开始；1 个 → 问续跑还是放弃；≥2 个 → 列出让用户选。
 * 第三分支顺带修掉一个单会话下就存在的隐患：三天前的陈旧 boulder 会静默变成「那个」指针，
 * 用户根本不知道自己在续什么。
 */
describe('resolveContinuation 续跑三分支', () => {
  it('无槽位时 action=fresh（全新开始，不问用户）', () => {
    const root = makeRoot('cont-fresh');
    const r = resolveContinuation(root);
    assert.equal(r.action, 'fresh');
    assert.deepEqual(r.slots, []);
  });

  it('全部 done 时同样 action=fresh（done 不算未关闭）', () => {
    const root = makeRoot('cont-alldone');
    const b = createBoulder({ stem: 's_d' });
    b.status = 'done';
    writeSlot(root, b);
    assert.equal(resolveContinuation(root).action, 'fresh');
  });

  it('恰好一个未关闭时 action=confirm 并带上该槽位（问续跑还是放弃）', () => {
    const root = makeRoot('cont-one');
    seedSlot(root, 'sess_only');
    const r = resolveContinuation(root);
    assert.equal(r.action, 'confirm');
    assert.equal(r.slots.length, 1);
    assert.equal(r.slots[0].stem, 'sess_only');
    assert.equal(r.slots[0].active_goal, '.omz/goal/sess_only.json');
  });

  it('两个及以上未关闭时 action=choose 并按 updated_at 倒序列出全部', () => {
    const root = makeRoot('cont-many');
    writeSlot(root, createBoulder({ stem: 's_1' }), { now: Date.parse('2026-09-01T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 's_2' }), { now: Date.parse('2026-09-03T00:00:00.000Z') });
    writeSlot(root, createBoulder({ stem: 's_3' }), { now: Date.parse('2026-09-02T00:00:00.000Z') });

    const r = resolveContinuation(root);
    assert.equal(r.action, 'choose');
    assert.deepEqual(r.slots.map((s) => s.stem), ['s_2', 's_3', 's_1']);
    // 每个候选都要给出足以让人判断的信息
    for (const s of r.slots) {
      assert.equal(typeof s.stem, 'string');
      assert.equal(typeof s.active_goal, 'string');
      assert.ok('updated_at' in s);
      assert.ok('status' in s);
    }
  });

  it('损坏槽位被单独报出而不是静默影响分支判定', () => {
    const root = makeRoot('cont-corrupt');
    seedSlot(root, 'sess_ok');
    fs.writeFileSync(slotPath(root, 'sess_bad'), '{"stem":', 'utf8');
    const r = resolveContinuation(root);
    assert.equal(r.action, 'confirm', '只有一个可读的未关闭槽位');
    assert.equal(r.corrupt.length, 1, '损坏槽位必须显式暴露给调用方');
  });

  it('迁移后的旧项目走 confirm 分支（升级路径行为不变）', () => {
    const root = makeRoot('cont-migrated');
    fs.mkdirSync(path.join(root, '.omz'), { recursive: true });
    fs.writeFileSync(
      viewPath(root),
      JSON.stringify({
        works: [], active_plan: null, session_ids: [], status: 'active',
        worktree_path: null, active_goal: '.omz/goal/sess_OLD.json', active_team: null, finished_at: null
      }, null, 2) + '\n',
      'utf8'
    );
    migrateLegacyView(root);
    const r = resolveContinuation(root);
    assert.equal(r.action, 'confirm');
    assert.equal(r.slots[0].stem, 'sess_OLD');
  });

  it('projectRoot 不存在时不抛，按 fresh 处理', () => {
    let r;
    assert.doesNotThrow(() => {
      r = resolveContinuation(path.join(TMP, '__never_created__'));
    });
    assert.equal(r.action, 'fresh');
  });
});

describe('对仓库与磁盘的纪律', () => {
  it('全部读写都在传入的 projectRoot 之下（不越界）', () => {
    const root = makeRoot('scoped');
    writeSlot(root, createBoulder({ stem: 'sess_scope' }));
    writeView(root);
    const base = path.resolve(root);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        assert.ok(path.resolve(full).startsWith(base), `${full} 越出了 projectRoot`);
        if (e.isDirectory()) walk(full);
      }
    };
    walk(root);
  });

  it('槽位目录里不残留 .tmp-* 中间文件（原子 rename）', () => {
    const root = makeRoot('no-tmp');
    for (let i = 0; i < 5; i += 1) writeSlot(root, createBoulder({ stem: `sess_${i}` }));
    const leftovers = fs.readdirSync(boulderDir(root)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(fs.readdirSync(boulderDir(root)).length, 5);
  });
});

/**
 * 协议文本一致性：槽位语义必须同时写进 commands/ulw.md 与 skills/ulw-execute/SKILL.md。
 * 实现改了而协议没改，主 agent 仍会按旧描述去写单文件 boulder——那正是本轮要消灭的行为。
 */
describe('协议文本与实现一致（B32）', () => {
  const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

  it('commands/ulw.md 声明槽位路径与三分支续跑，且不再把单文件当事实源', () => {
    const text = readText(path.join(ROOT, 'commands', 'ulw.md'));
    assert.match(text, /\.omz\/boulder\/<[^>]+>\.json/, 'ulw.md 应给出槽位路径形态');
    assert.ok(text.includes('B32'), 'ulw.md 应标注 B32');
    // 三分支必须逐个写明，否则主 agent 会退回「挑一个」的旧行为
    assert.match(text, /0 个/);
    assert.match(text, /1 个/);
    assert.match(text, /≥2 个/);
    assert.ok(text.includes('不得自行挑一个'), '多槽位时必须禁止替用户选');
    assert.ok(text.includes('派生视图'), 'ulw.md 应说明 .omz/boulder.json 已降级为派生视图');
  });

  it('commands/ulw.md 的计划文件名带 stem 前缀（避免跨会话 slug 碰名）', () => {
    const text = readText(path.join(ROOT, 'commands', 'ulw.md'));
    assert.match(text, /\.omz\/plans\/<OMZ_GOAL_STEM>-<slug>\.md/);
    // 旧的裸 slug 形态不该再作为产出路径出现
    assert.equal(/产出 `\.omz\/plans\/<slug>\.md`/.test(text), false, '仍在用裸 slug 作计划路径');
  });

  it('skills/ulw-execute/SKILL.md 的 Boulder schema 升到 v3 且含 stem/updated_at', () => {
    const text = readText(path.join(ROOT, 'skills', 'ulw-execute', 'SKILL.md'));
    assert.match(text, /Boulder schema（v3/, 'schema 版本号应升到 v3');
    assert.match(text, /"stem"/);
    assert.match(text, /"updated_at"/);
    // OmO v2 原 5 字段名必须仍在（一字不改是硬约束）
    for (const f of ['works', 'active_plan', 'session_ids', 'status', 'worktree_path']) {
      assert.ok(text.includes(`"${f}"`), `schema 缺 OmO v2 原字段 ${f}`);
    }
  });

  it('skills/ulw-execute/SKILL.md 的 ledger 行含 stem（否则并发事件无法反解归属）', () => {
    const text = readText(path.join(ROOT, 'skills', 'ulw-execute', 'SKILL.md'));
    const ledgerSection = text.slice(text.indexOf('## ledger.jsonl'));
    assert.ok(ledgerSection.includes('"stem"'), 'ledger 行必须带 stem');
    assert.ok(/反解归属|归属/.test(ledgerSection), '应说明 stem 的用途');
  });

  it('两份协议都禁止写别人的槽位与派生视图', () => {
    const ulw = readText(path.join(ROOT, 'commands', 'ulw.md'));
    const skill = readText(path.join(ROOT, 'skills', 'ulw-execute', 'SKILL.md'));
    assert.ok(/绝不写别人的槽位|不写别人的槽位/.test(ulw), 'ulw.md 应禁止写别人的槽位');
    assert.ok(/不得被写|不得.*读写/.test(skill), 'SKILL.md 应禁止写派生视图');
  });

  it('实现里的常量与协议文本里的路径形态一致', () => {
    const ulw = readText(path.join(ROOT, 'commands', 'ulw.md'));
    assert.ok(ulw.includes(BOULDER_DIR_REL), `ulw.md 应出现槽位目录 ${BOULDER_DIR_REL}`);
    assert.ok(ulw.includes(BOULDER_VIEW_REL), `ulw.md 应出现派生视图路径 ${BOULDER_VIEW_REL}`);
  });
});







