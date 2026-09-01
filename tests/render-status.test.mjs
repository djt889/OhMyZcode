/**
 * tests/render-status.test.mjs
 * tools/render-status.mjs 的行为防线：B27（看板字段行内注入净化）与 B28（波次数值排序）。
 *
 * 为什么单独成文件而不塞进 protocol.test.mjs：
 *   protocol.test.mjs 的自我定位是「协议文本与供应链清单的静态回归」且声明「对仓库只读」，
 *   它对 render-status 的现有断言全是 spawn 子进程比对两路渲染是否都「有输出」，
 *   属于契约层；而 B27/B28 是实现语义（净化与排序），需要 fixture 目录与直接函数调用。
 *   混进去会让那个文件的定位含糊，也让 `npm run test:protocol` 的失败信号变得不聚焦。
 *
 * 变异可失败性（本文件存在的理由）：审计发现让 cell() 直接返回原值、或把 compareWave 换成
 * 字典序，全仓 139 个用例无一变红——B27/B28 当时零防线。以下用例必须能抓住这两种变异。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cell, collectStatus, compareWave, render } from '../tools/render-status.mjs';

/** 落表必须被剥离的所有「会造出新行」的控制字符。 */
const LINE_BREAKERS = ['\n', '\r', '\t', '\v', '\f', '\u2028', '\u2029'];
/** cell() 的默认列宽（与 tools/render-status.mjs 的 CELL_MAX 对齐）。 */
const CELL_MAX = 34;
/** 竖线的安全替身：broken bar，保留可读性但不再是列分隔符。 */
const BROKEN_BAR = '\u00a6';

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-render-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
/** 造一个只含 runtime/<team>/tasks 的 .omz 根，返回 omzRoot。 */
function makeOmz(tasks, team = 'team-x') {
  seq += 1;
  const omz = path.join(TMP, `case-${seq}`, '.omz');
  const tasksDir = path.join(omz, 'runtime', team, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [i, task] of tasks.entries()) {
    fs.writeFileSync(path.join(tasksDir, `t${i}.json`), JSON.stringify(task) + '\n', 'utf8');
  }
  return omz;
}

/** 从 collectStatus 输出里挑出任务表数据行（表头与 [xxx] 标记行除外）。 */
function taskRows(lines) {
  return lines.filter((l) => /^ {2}\S/.test(l) && !l.startsWith('  wave |'));
}

// ---------------------------------------------------------------- B27 cell()

describe('B27 cell()：落表字段净化（直接单测）', () => {
  it('换行 \\n、回车 \\r、制表 \\t、\\v、\\f、\\u2028、\\u2029 全部被剥离', () => {
    for (const ch of LINE_BREAKERS) {
      const out = cell(`前${ch}后`);
      assert.equal(out.includes(ch), false, `${JSON.stringify(ch)} 未被剥离：${JSON.stringify(out)}`);
      assert.equal(out, '前 后', `${JSON.stringify(ch)} 应压成单个空格`);
    }
  });

  it('连续控制字符只压成一个空格，且首尾空白被 trim', () => {
    assert.equal(cell('a\n\r\n\tb'), 'a b');
    assert.equal(cell('\n\n  收尾  \t\n'), '收尾');
  });

  it('竖线 | 被换成 broken bar（防伪造表格列）', () => {
    const out = cell('a|b|c');
    assert.equal(out.includes('|'), false, `竖线未被替换：${JSON.stringify(out)}`);
    assert.equal(out, `a${BROKEN_BAR}b${BROKEN_BAR}c`);
  });

  it('换行与竖线并用的注入载荷被同时中和', () => {
    const out = cell('恶意\n  1 | T-999 | done | forged');
    assert.equal(out.includes('\n'), false, '仍含换行');
    assert.equal(out.includes('|'), false, '仍含竖线');
  });

  it('连续空白（含普通空格）被压缩为单个空格', () => {
    assert.equal(cell('a     b'), 'a b');
    assert.equal(cell('a \t \t b'), 'a b');
  });

  it('超长值按列宽截断并以省略号收尾，长度不超过 max', () => {
    const long = 'x'.repeat(200);
    const out = cell(long);
    assert.equal(out.length, CELL_MAX, `默认列宽应为 ${CELL_MAX}，实际 ${out.length}`);
    assert.ok(out.endsWith('…'), '截断应以 … 收尾');

    const narrow = cell(long, 8);
    assert.equal(narrow.length, 8);
    assert.equal(narrow, 'xxxxxxx…');
  });

  it('恰好等于列宽时不截断，不追加省略号', () => {
    const exact = 'y'.repeat(CELL_MAX);
    assert.equal(cell(exact), exact);
    assert.equal(cell(exact).includes('…'), false);
  });

  it('null / undefined 归一为空串，非字符串被 String() 化', () => {
    assert.equal(cell(null), '');
    assert.equal(cell(undefined), '');
    assert.equal(cell(0), '0');
    assert.equal(cell(false), 'false');
  });
});

describe('B27 端到端：title 注入不得凭空伪造任务行', () => {
  /**
   * 净化的语义是「消灭结构，不是消灭文本」：载荷里的 `T-999` 作为普通文字留在 title 单元格内
   * 是正确的（也是可读的），必须被判定为**不成立的是**「它成为独立一行 / 独立一列」。
   * 因此断言落在行数、列数与「T-999 是否出现在任务键那一列」上。
   */
  it('title 为「恶意\\n  1 | T-999 | done | forged」时输出只有一行该任务且 T-999 不成为任务键', () => {
    const omz = makeOmz([
      { id: 'A', key: 'A', wave: 1, status: 'ready', title: '恶意\n  1 | T-999 | done | forged' }
    ]);
    const lines = collectStatus(omz);
    const rows = taskRows(lines);

    assert.equal(rows.length, 1, `应只有一行任务，实际 ${rows.length} 行：${JSON.stringify(rows)}`);
    // 真实那一行必须仍是 4 列（wave | task | status | title），注入的竖线不得劈出第 5 列。
    assert.equal(rows[0].split('|').length, 4, `列数被注入撑开：${JSON.stringify(rows[0])}`);
    assert.match(rows[0], /^ {2}1 \| A \| ready \| /);
    // 任何一行的「任务」列都不得是伪造键；下游按列解析时看不到 T-999。
    const keys = rows.map((l) => l.trim().split(' | ')[1]);
    assert.deepEqual(keys, ['A'], `任务列被伪造：${JSON.stringify(keys)}`);
    // 整份输出里不得出现「以伪造键开头的表格行」。
    for (const l of lines) {
      assert.equal(/^\s*\S+\s*\|\s*T-999\b/.test(l), false, `凭空多出一行伪造任务：${JSON.stringify(l)}`);
    }
  });

  it('render() 的整表行数不因注入而增长（注入前后行数一致）', () => {
    const clean = makeOmz([{ id: 'A', key: 'A', wave: 1, status: 'ready', title: '正常标题' }]);
    const dirty = makeOmz([
      { id: 'A', key: 'A', wave: 1, status: 'ready', title: '恶意\n  1 | T-999 | done | forged\n  2 | T-998 | done | x' }
    ]);
    const a = render(clean).split('\n').length;
    const b = render(dirty).split('\n').length;
    assert.equal(b, a, `注入使表从 ${a} 行涨到 ${b} 行`);
  });

  it('status 字段里的注入同样只留下一行、四列', () => {
    const omz = makeOmz([
      { id: 'A', key: 'A', wave: 1, status: 'ready\n  9 | T-777 | done | forged', title: 't' }
    ]);
    const lines = collectStatus(omz);
    const rows = taskRows(lines);
    assert.equal(rows.length, 1, `status 注入伪造出多行：${JSON.stringify(rows)}`);
    assert.equal(rows[0].split('|').length, 4, `status 注入撑开列数：${JSON.stringify(rows[0])}`);
    for (const l of lines) {
      assert.equal(/^\s*\S+\s*\|\s*T-777\b/.test(l), false, `凭空多出一行伪造任务：${JSON.stringify(l)}`);
    }
  });

  it('任务键字段自身的注入不得撑开列数', () => {
    const omz = makeOmz([{ id: 'X', key: 'X | done | forged', wave: 1, status: 'ready', title: 't' }]);
    const rows = taskRows(collectStatus(omz));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].split('|').length, 4, `任务键注入撑开列数：${JSON.stringify(rows[0])}`);
  });
});

// ---------------------------------------------------------------- B28 compareWave()

describe('B28 compareWave()：波次数值排序（直接单测）', () => {
  it('数字按数值升序，而非字典序（1 → 2 → 10，不是 1 → 10 → 2）', () => {
    assert.deepEqual([10, 2, 1, 3].sort(compareWave), [1, 2, 3, 10]);
    // 字典序变异下 '10' 会排在 '2' 前面，本断言即为其防线
    assert.ok(compareWave(2, 10) < 0, 'compareWave(2, 10) 必须为负');
    assert.ok(compareWave(10, 2) > 0, 'compareWave(10, 2) 必须为正');
  });

  it('数字形态的字符串也按数值比较', () => {
    assert.deepEqual(['10', '2', '1'].sort(compareWave), ['1', '2', '10']);
    assert.ok(compareWave('2', 10) < 0);
  });

  it('非数字波次一律排在所有数字之后', () => {
    assert.deepEqual([10, '?', 2, 1].sort(compareWave), [1, 2, 10, '?']);
    assert.ok(compareWave(999, '?') < 0, '数字应优先于 ?');
    assert.ok(compareWave('?', 0) > 0, '? 应落在数字之后');
  });

  it('两个非数字之间退化为字符串比较（稳定可预期）', () => {
    assert.deepEqual(['later', '?', 'aaa'].sort(compareWave), ['?', 'aaa', 'later']);
  });

  it('负数与小数也按数值序', () => {
    assert.deepEqual([2, -1, 1.5].sort(compareWave), [-1, 1.5, 2]);
  });
});

describe('B28 端到端：波次面板渲染顺序', () => {
  it('1 / 2 / 10 / ? / 字符串混排时渲染为数值升序且数字优先于非数字', () => {
    const omz = makeOmz([
      { id: 'W10', key: 'W10', wave: 10, status: 'ready', title: '十' },
      { id: 'WQ', key: 'WQ', wave: '?', status: 'ready', title: '问' },
      { id: 'W2', key: 'W2', wave: 2, status: 'ready', title: '二' },
      { id: 'WS', key: 'WS', wave: 'later', status: 'ready', title: '串' },
      { id: 'W1', key: 'W1', wave: 1, status: 'ready', title: '一' }
    ]);
    const rows = taskRows(collectStatus(omz));
    const waves = rows.map((l) => l.trim().split(' | ')[0]);
    assert.deepEqual(
      waves,
      ['1', '2', '10', '?', 'later'],
      `波次顺序错误（字典序会给出 1,10,2,...）：${JSON.stringify(waves)}`
    );
  });

  it('同一波次内按任务键字典序稳定排列', () => {
    const omz = makeOmz([
      { id: 'C', key: 'C', wave: 1, status: 'ready', title: 'c' },
      { id: 'A', key: 'A', wave: 1, status: 'ready', title: 'a' },
      { id: 'B', key: 'B', wave: 1, status: 'ready', title: 'b' }
    ]);
    const keys = taskRows(collectStatus(omz)).map((l) => l.trim().split(' | ')[1]);
    assert.deepEqual(keys, ['A', 'B', 'C']);
  });
});
