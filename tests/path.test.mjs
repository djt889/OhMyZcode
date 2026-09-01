/**
 * tests/path.test.mjs
 * 覆盖 adapters/zcode/path.mjs 的全部导出：BOM/编码卫生（B4）与路径分隔符归一（B3）。
 * 纪律：所有落盘都在 os.tmpdir() 的独立临时目录里，after() 清零残留；绝不触碰仓库文件。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stripBom,
  readJsonSafe,
  writeJsonSafe,
  toPosixRelative,
  isWindowsAbsolutePath,
  hasBackslashPath,
  isEscapingPath,
  classifyPath,
  normalizePathValue,
  normalizePathFields,
  deepNormalizePaths,
  scanJsonHygiene,
  PATH_FIELD_NAMES,
  JSON_SCAN_DEFAULTS
} from '../adapters/zcode/path.mjs';

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-path-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('stripBom', () => {
  it('带 BOM 的字符串首字符被移除且余下内容不变', () => {
    assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  });

  it('无 BOM 的字符串原样返回（同一引用）', () => {
    const s = '{"a":1}';
    assert.equal(stripBom(s), s);
  });

  it('空字符串不抛且返回空字符串', () => {
    assert.equal(stripBom(''), '');
  });

  it('非字符串输入原样返回，不抛', () => {
    assert.equal(stripBom(null), null);
    assert.equal(stripBom(42), 42);
  });
});

describe('readJsonSafe', () => {
  it('正常 JSON 文件被解析为对象', () => {
    const f = path.join(TMP, 'read-ok.json');
    fs.writeFileSync(f, '{"a":1,"b":["x"]}', 'utf8');
    const r = readJsonSafe(f);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1, b: ['x'] });
  });

  it('文件不存在时报 reason=missing 且不抛', () => {
    const r = readJsonSafe(path.join(TMP, 'no-such-file.json'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
    assert.ok(r.error.length > 0);
  });

  it('语法损坏的 JSON 报 reason=parse', () => {
    const f = path.join(TMP, 'read-broken.json');
    fs.writeFileSync(f, '{"a":1,', 'utf8');
    const r = readJsonSafe(f);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parse');
  });

  it('带 BOM 但内容合法时仍解析成功（BOM 不应导致失败）', () => {
    const f = path.join(TMP, 'read-bom.json');
    fs.writeFileSync(f, '\uFEFF{"ok":true}', 'utf8');
    const r = readJsonSafe(f);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { ok: true });
  });

  it('带 BOM 且内容损坏时用 reason=bom-parse 区分于纯语法错误', () => {
    const f = path.join(TMP, 'read-bom-broken.json');
    fs.writeFileSync(f, '\uFEFF{"a":', 'utf8');
    const r = readJsonSafe(f);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bom-parse');
  });

  it('传入目录路径时报 reason=io（EISDIR 不是 missing）', () => {
    const d = path.join(TMP, 'a-directory');
    fs.mkdirSync(d, { recursive: true });
    const r = readJsonSafe(d);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'io');
  });
});

describe('writeJsonSafe', () => {
  it('写出的内容可被回读且与写入值深度一致', () => {
    const f = path.join(TMP, 'w', 'roundtrip.json');
    writeJsonSafe(f, { a: 1, nested: { list: [1, 2, 3] } });
    const r = readJsonSafe(f);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1, nested: { list: [1, 2, 3] } });
  });

  it('写出的首字节不是 0xEF（无 BOM，B4）', () => {
    const f = path.join(TMP, 'w', 'nobom.json');
    writeJsonSafe(f, { x: 1 });
    const buf = fs.readFileSync(f);
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf[0], '{'.charCodeAt(0));
  });

  it('写出的字节里不含 \\r（LF 行尾，B4）', () => {
    const f = path.join(TMP, 'w', 'lf.json');
    writeJsonSafe(f, { text: 'line1\nline2', arr: [1, 2] });
    const buf = fs.readFileSync(f);
    assert.equal(buf.includes(0x0d), false);
  });

  it('文件结尾恰好一个换行符', () => {
    const f = path.join(TMP, 'w', 'trailing.json');
    writeJsonSafe(f, { x: 1 });
    const raw = fs.readFileSync(f, 'utf8');
    assert.equal(raw.endsWith('}\n'), true);
    assert.equal(raw.endsWith('}\n\n'), false);
  });

  it('父目录不存在时自动递归创建', () => {
    const f = path.join(TMP, 'deep', 'a', 'b', 'c', 'created.json');
    assert.equal(fs.existsSync(path.dirname(f)), false);
    writeJsonSafe(f, { created: true });
    assert.equal(fs.existsSync(f), true);
  });

  it('写完后目录下没有 .tmp-* 中间文件残留（原子 rename）', () => {
    const dir = path.join(TMP, 'no-tmp-residue');
    for (let i = 0; i < 5; i += 1) writeJsonSafe(path.join(dir, `f${i}.json`), { i });
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(fs.readdirSync(dir).length, 5);
  });

  it('返回值携带 ok 与写入的目标文件路径', () => {
    const f = path.join(TMP, 'w', 'result.json');
    const r = writeJsonSafe(f, { a: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.file, f);
  });
});

describe('toPosixRelative', () => {
  it('Windows 绝对路径被转成相对 root 的正斜杠路径', () => {
    assert.equal(toPosixRelative('E:\\proj\\src\\a.rs', 'E:\\proj'), 'src/a.rs');
  });

  it('反斜杠相对路径的分隔符被换成正斜杠', () => {
    assert.equal(toPosixRelative('src\\main.rs', 'E:\\proj'), 'src/main.rs');
  });

  it('已是 posix 相对路径的原样保留', () => {
    assert.equal(toPosixRelative('src/main.rs', 'E:/proj'), 'src/main.rs');
  });

  /**
   * 越界语义的裁决（本轮审计）：旧断言要求跨卷路径静默变成 `../other/x.rs`。
   * 那个相对路径在任何机器上都不指向原文件——它以 root 为基准，而原路径在另一个卷上，
   * 拼回去只会得到一个不存在的位置。把它写进 .omz/ 状态文件等于制造一条看起来合法、
   * 实际指向别处的记录，且事后无从分辨。新语义：默认 'marker' 保留可被 isEscapingPath()
   * 判定出来的绝对形态，让 /omz-doctor 能报警；需要旧行为的调用方显式传 onEscape:'return'。
   */
  it('跨卷路径默认保留可判定的绝对形态，而不是伪造一个相对路径', () => {
    const out = toPosixRelative('E:\\other\\x.rs', 'C:\\proj');
    assert.equal(out, 'E:/other/x.rs');
    assert.equal(isEscapingPath(out), true, '返回值必须能被 isEscapingPath 判出来');
    assert.equal(out.includes('\\'), false, '分隔符仍统一为正斜杠');
  });

  it('同卷但越出 root 时默认也保留绝对形态（不静默截断到 root 内）', () => {
    const out = toPosixRelative('C:\\other\\x.rs', 'C:\\proj');
    assert.equal(out, 'C:/other/x.rs');
    assert.equal(isEscapingPath(out), true);
  });

  it('onEscape=return 时退回旧行为，给出带 ../ 前缀的相对路径', () => {
    assert.equal(toPosixRelative('C:\\other\\x.rs', 'C:\\proj', { onEscape: 'return' }), '../other/x.rs');
    // 跨卷时 path.relative 本身给不出相对路径，'return' 只能拿到绝对形态
    assert.equal(toPosixRelative('E:\\other\\x.rs', 'C:\\proj', { onEscape: 'return' }), 'E:/other/x.rs');
  });

  it('onEscape=throw 时对跨卷/越界/设备命名空间一律抛错', () => {
    assert.throws(() => toPosixRelative('E:\\other\\x.rs', 'C:\\proj', { onEscape: 'throw' }), /跨卷/);
    assert.throws(() => toPosixRelative('C:\\other\\x.rs', 'C:\\proj', { onEscape: 'throw' }), /越界/);
    assert.throws(() => toPosixRelative('\\\\?\\C:\\proj\\d.rs', 'C:\\proj', { onEscape: 'throw' }), /设备命名空间/);
  });

  it('未越界时三种 onEscape 模式结果完全一致（模式只影响越界分支）', () => {
    for (const onEscape of ['marker', 'return', 'throw']) {
      assert.equal(toPosixRelative('C:\\proj\\src\\a.rs', 'C:\\proj', { onEscape }), 'src/a.rs');
    }
  });

  it('UNC 与设备命名空间路径保留绝对形态并可被判为越界', () => {
    const unc = toPosixRelative('\\\\server\\share\\s.rs', 'C:\\proj');
    assert.equal(unc, '//server/share/s.rs');
    assert.equal(isEscapingPath(unc), true);
    const device = toPosixRelative('\\\\?\\C:\\proj\\d.rs', 'C:\\proj');
    assert.equal(device, '//?/C:/proj/d.rs');
    assert.equal(isEscapingPath(device), true);
  });

  it('target 等于 root 时返回空字符串', () => {
    assert.equal(toPosixRelative('E:\\proj', 'E:\\proj'), '');
  });

  it('空串与非字符串原样返回，不抛', () => {
    assert.equal(toPosixRelative('', 'E:\\proj'), '');
    assert.equal(toPosixRelative(null, 'E:\\proj'), null);
    assert.equal(toPosixRelative(7, 'E:\\proj'), 7);
  });
});

describe('isEscapingPath', () => {
  it('以 ../ 开头的相对路径判为越界（正反斜杠两种写法都要判出）', () => {
    assert.equal(isEscapingPath('../x'), true);
    assert.equal(isEscapingPath('..'), true);
    // 反斜杠写法与正斜杠是同一件事：只因分隔符不同就漏判，会让 Windows 形态的越界路径
    // 被 normalizePathValue 当成安全相对路径写进状态文件
    assert.equal(isEscapingPath('..\\x'), true);
    assert.equal(isEscapingPath('..\\up\\y.rs'), true);
  });

  it('盘符绝对路径 / UNC / 设备命名空间都判为越界', () => {
    assert.equal(isEscapingPath('E:/o/x'), true);
    assert.equal(isEscapingPath('E:\\o\\x'), true);
    assert.equal(isEscapingPath('//server/share'), true);
    assert.equal(isEscapingPath('//?/C:/x'), true);
  });

  it('正常 root 内相对路径不判为越界', () => {
    assert.equal(isEscapingPath('src/a.rs'), false);
    assert.equal(isEscapingPath('results/T-001.json'), false);
    // '..' 出现在路径中段不算越界前缀（a/../b 归一后仍在 root 内）
    assert.equal(isEscapingPath('a/..b/c'), false);
  });

  it('空串与非字符串返回 false 而不是抛', () => {
    assert.equal(isEscapingPath(''), false);
    assert.equal(isEscapingPath(null), false);
    assert.equal(isEscapingPath(undefined), false);
    assert.equal(isEscapingPath(42), false);
  });
});

describe('classifyPath', () => {
  const ROOT = 'C:\\proj';

  it('7 种 kind 各有一个代表样本被正确分类', () => {
    const expected = [
      ['src/a.rs', 'posix-relative', 'src/a.rs'],
      ['C:\\proj\\in.rs', 'windows-absolute', 'in.rs'],
      ['\\\\server\\share\\x', 'unc', '//server/share/x'],
      ['\\\\?\\C:\\long\\x', 'device', '//?/C:/long/x'],
      ['../up.rs', 'escaping', '../up.rs'],
      ['E:\\other\\x.rs', 'cross-volume', 'E:/other/x.rs'],
      ['regex \\d+ text', 'plain-text', 'regex \\d+ text']
    ];
    for (const [value, kind, normalized] of expected) {
      const got = classifyPath(value, ROOT);
      assert.equal(got.kind, kind, `${value} 应被判为 ${kind}，实际 ${got.kind}`);
      assert.equal(got.normalized, normalized, `${value} 的 normalized 不符`);
    }
    assert.equal(new Set(expected.map((e) => e[1])).size, 7, '样本必须覆盖全部 7 种 kind');
  });

  it('同卷但越出 root 的绝对路径判为 escaping 而非 windows-absolute', () => {
    const got = classifyPath('C:\\other\\x.rs', ROOT);
    assert.equal(got.kind, 'escaping');
    assert.equal(got.normalized, 'C:/other/x.rs');
  });

  it('POSIX 绝对路径在 Windows root 下判为 escaping', () => {
    assert.equal(classifyPath('/usr/local/x', ROOT).kind, 'escaping');
  });

  it('含空白的字符串按 plain-text 处理（正则/散文/错误消息不当路径）', () => {
    assert.equal(classifyPath('已完成 3 个任务，无异常', ROOT).kind, 'plain-text');
    assert.equal(classifyPath('regex \\d+ and \\w+', ROOT).kind, 'plain-text');
    // 绝对路径即便含空格仍按路径处理（`C:\Program Files\…` 在 Windows 上极常见）
    const spacey = classifyPath('C:\\proj\\Program Files\\x', ROOT);
    assert.equal(spacey.kind, 'windows-absolute');
    assert.equal(spacey.normalized, 'Program Files/x');
  });

  it('空串与非字符串返回 plain-text 且 normalized 原样', () => {
    assert.deepEqual(classifyPath('', ROOT), { kind: 'plain-text', normalized: '' });
    assert.deepEqual(classifyPath(null, ROOT), { kind: 'plain-text', normalized: null });
  });
});

describe('isWindowsAbsolutePath', () => {
  it('盘符加反斜杠的路径判为绝对路径', () => {
    assert.equal(isWindowsAbsolutePath('C:\\x'), true);
  });

  it('盘符加正斜杠的路径判为绝对路径', () => {
    assert.equal(isWindowsAbsolutePath('C:/x'), true);
  });

  it('UNC 路径判为绝对路径', () => {
    assert.equal(isWindowsAbsolutePath('\\\\server\\share'), true);
  });

  it('POSIX 绝对路径不算 Windows 绝对路径', () => {
    assert.equal(isWindowsAbsolutePath('/usr/x'), false);
  });

  it('相对路径与空串都判为 false', () => {
    assert.equal(isWindowsAbsolutePath('src/x'), false);
    assert.equal(isWindowsAbsolutePath(''), false);
  });

  it('非字符串输入返回 false 而不是抛异常', () => {
    assert.equal(isWindowsAbsolutePath(null), false);
    assert.equal(isWindowsAbsolutePath(123), false);
  });
});

describe('hasBackslashPath', () => {
  it('反斜杠相对路径被识别', () => {
    assert.equal(hasBackslashPath('src\\main.rs'), true);
  });

  it('正斜杠路径不被误判', () => {
    assert.equal(hasBackslashPath('src/main.rs'), false);
  });

  it('普通散文文本不被误判为路径', () => {
    assert.equal(hasBackslashPath('just plain text without separators'), false);
    assert.equal(hasBackslashPath('已完成任务，无异常。'), false);
  });

  it('Windows 绝对路径含反斜杠时被识别', () => {
    assert.equal(hasBackslashPath('E:\\proj\\a.rs'), true);
  });

  it('非字符串输入返回 false', () => {
    assert.equal(hasBackslashPath(undefined), false);
  });
});

describe('normalizePathValue', () => {
  it('Windows 绝对路径归一为相对 root 的正斜杠路径', () => {
    assert.equal(normalizePathValue('E:\\proj\\src\\a.rs', 'E:\\proj'), 'src/a.rs');
  });

  it('非路径字符串原样返回', () => {
    assert.equal(normalizePathValue('完成了三个任务', 'E:\\proj'), '完成了三个任务');
  });

  it('空串与非字符串原样返回', () => {
    assert.equal(normalizePathValue('', 'E:\\proj'), '');
    assert.equal(normalizePathValue(7, 'E:\\proj'), 7);
  });
});

/**
 * 白名单语义的裁决（本轮审计）：旧断言要求「嵌套对象与数组里的路径值全部被归一」，
 * 即全量深度遍历。那个语义会把正则（`regex \d+`）、转义序列（`\n`）、错误消息里的反斜杠
 * 一律改成正斜杠——状态文件是跨会话唯一事实源，污染后无法复原。
 * 新语义：只有**键名在 PATH_FIELD_NAMES 里**的字段才归一，与嵌套深度无关；数组元素继承父键名。
 */
describe('deepNormalizePaths（字段白名单驱动）', () => {
  const ROOT = 'E:\\proj';
  const inRoot = (rel) => `${ROOT}\\${rel.split('/').join('\\')}`;

  it('白名单字段被归一为相对 root 的正斜杠路径', () => {
    const out = deepNormalizePaths({ result_file: inRoot('results/T-001.json') }, ROOT);
    assert.equal(out.result_file, 'results/T-001.json');
  });

  it('非白名单字段原样保留（note / msg 不是路径字段）', () => {
    const input = { note: 'src\\main.rs', msg: inRoot('a.json'), error: 'C:\\x\\y' };
    const out = deepNormalizePaths(input, ROOT);
    assert.equal(out.note, 'src\\main.rs');
    assert.equal(out.msg, inRoot('a.json'));
    assert.equal(out.error, 'C:\\x\\y');
  });

  it('白名单判定只看当前键名，与嵌套深度和父键名无关', () => {
    // transport registry 的真实形态：agents 与 <agent_ref> 都不在白名单，
    // 但 result_ref 在——它必须被归一，否则 saveRegistry 这条落盘路径上 B3 失效。
    const reg = {
      team_id: 'team-1',
      agents: { a1: { agent_ref: 'a1', task_id: 1, result_ref: inRoot('results/T-001.json') } },
      bindings: { 1: 'a1' }
    };
    assert.equal(deepNormalizePaths(reg, ROOT).agents.a1.result_ref, 'results/T-001.json');

    // 七层非白名单父键之下的 result_file 同样必须命中
    const deep = { q: { w: { e: { r: { t: { y: { result_file: inRoot('x/y.json') } } } } } } };
    assert.equal(deepNormalizePaths(deep, ROOT).q.w.e.r.t.y.result_file, 'x/y.json');
  });

  it('白名单字段的同层非白名单兄弟字段不受影响', () => {
    const reg = { agents: { a1: { result_ref: inRoot('r.json'), note: 'regex \\d+ and \\w+' } } };
    const out = deepNormalizePaths(reg, ROOT);
    assert.equal(out.agents.a1.result_ref, 'r.json');
    assert.equal(out.agents.a1.note, 'regex \\d+ and \\w+', '兄弟字段被连带改坏即为回归');
  });

  it('数组元素继承父键名的判定：白名单键下的数组归一，非白名单键下的不归一', () => {
    const input = {
      changed_files: [inRoot('a.rs'), 'src\\b.rs'],
      notes: ['src\\c.rs', 'regex \\d+']
    };
    const out = deepNormalizePaths(input, ROOT);
    assert.deepEqual(out.changed_files, ['a.rs', 'src/b.rs']);
    assert.deepEqual(out.notes, ['src\\c.rs', 'regex \\d+']);
  });

  it('数组里的对象元素按各自键名重新判定（不整体继承）', () => {
    const input = { tasks: [{ result_file: inRoot('t/1.json') }, { note: 'src\\x.rs' }] };
    const out = deepNormalizePaths(input, ROOT);
    assert.equal(out.tasks[0].result_file, 't/1.json');
    assert.equal(out.tasks[1].note, 'src\\x.rs');
  });

  it('白名单键的值是对象时，内层键各自重新判定（不继承父键）', () => {
    const out = deepNormalizePaths({ path: { inner: inRoot('z.txt'), file: inRoot('w.txt') } }, ROOT);
    assert.equal(out.path.inner, inRoot('z.txt'), 'inner 不在白名单，不该被归一');
    assert.equal(out.path.file, 'w.txt', 'file 在白名单，应被归一');
  });

  it('顶层裸数组无父键名，故元素一律不归一', () => {
    const out = deepNormalizePaths(['a/b', 'src\\c', 3, null], ROOT);
    assert.equal(out.length, 4);
    assert.deepEqual(out, ['a/b', 'src\\c', 3, null]);
  });

  it('越界/跨卷的白名单字段值原样保留（宁可留可报警的绝对路径）', () => {
    const out = deepNormalizePaths({ result_ref: 'C:\\elsewhere\\r.json' }, ROOT);
    assert.equal(out.result_ref, 'C:\\elsewhere\\r.json');
  });

  it('原对象未被就地改动（返回的是新结构）', () => {
    const input = { a: { result_file: inRoot('x.rs') }, changed_files: [inRoot('y.rs')] };
    const out = deepNormalizePaths(input, ROOT);
    assert.equal(input.a.result_file, inRoot('x.rs'));
    assert.equal(input.changed_files[0], inRoot('y.rs'));
    assert.notStrictEqual(out, input);
    assert.notStrictEqual(out.a, input.a);
  });

  it('null/number/boolean 值不被破坏', () => {
    const out = deepNormalizePaths({ n: null, i: 42, f: 1.5, t: true, f2: false }, ROOT);
    assert.equal(out.n, null);
    assert.equal(out.i, 42);
    assert.equal(out.f, 1.5);
    assert.equal(out.t, true);
    assert.equal(out.f2, false);
  });

  it('PATH_FIELD_NAMES 是导出且冻结的白名单，含 result_ref/result_file 等关键字段', () => {
    assert.equal(Object.isFrozen(PATH_FIELD_NAMES), true);
    for (const field of ['result_ref', 'result_file', 'changed_files', 'path', 'file', 'files', 'cwd']) {
      assert.ok(PATH_FIELD_NAMES.includes(field), `白名单缺 ${field}`);
    }
    // 白名单里出现的每个名字都必须真的生效（防止有人加了名字但没加进 Set）
    for (const field of PATH_FIELD_NAMES) {
      const out = normalizePathFields({ [field]: inRoot('probe.json') }, ROOT);
      assert.equal(out[field], 'probe.json', `PATH_FIELD_NAMES 里的 ${field} 未真正生效`);
    }
  });

  it('normalizePathFields 显式传 fields 时以传入的白名单为准', () => {
    const input = { mine: inRoot('m.txt'), path: inRoot('p.txt') };
    const out = normalizePathFields(input, ROOT, { fields: ['mine'] });
    assert.equal(out.mine, 'm.txt', '显式登记的 mine 应被归一');
    assert.equal(out.path, inRoot('p.txt'), 'fields 覆盖默认白名单，path 不再生效');
  });

  it('normalizePathFields 接受 Set 形态的 fields', () => {
    const out = normalizePathFields({ custom: inRoot('c.txt') }, ROOT, { fields: new Set(['custom']) });
    assert.equal(out.custom, 'c.txt');
  });
});

/**
 * 反向用例：含反斜杠但**不是**路径的字符串必须逐字节原样保留。
 * 这是「全量深度遍历」被否决的直接原因——一旦回归，正则与转义序列会被静默改坏。
 */
describe('deepNormalizePaths 非路径字符串保护', () => {
  const ROOT = 'E:\\proj';

  it('正则字面量里的 \\d \\w 不被改成正斜杠', () => {
    const input = { note: 'regex \\d+ and \\w+' };
    const out = deepNormalizePaths(input, ROOT);
    assert.equal(out.note, 'regex \\d+ and \\w+');
    assert.equal(JSON.stringify(out), JSON.stringify(input), '整体序列化必须逐字节一致');
  });

  it('转义序列 \\n \\t 不被破坏', () => {
    const input = { msg: 'line\\nbreak\\ttab', pattern: '^\\s*#' };
    assert.equal(JSON.stringify(deepNormalizePaths(input, ROOT)), JSON.stringify(input));
  });

  it('中文夹反斜杠的散文原样保留', () => {
    const input = { detail: '路径写成了 中文\\反斜杠 形式，请修正', summary: '完成\\未完成 各一半' };
    assert.equal(JSON.stringify(deepNormalizePaths(input, ROOT)), JSON.stringify(input));
  });

  it('错误消息里的 Windows 绝对路径（非白名单字段）不被归一', () => {
    const input = { last_error: "ENOENT: open 'E:\\proj\\results\\T.json'" };
    assert.equal(deepNormalizePaths(input, ROOT).last_error, input.last_error);
  });

  it('JSON pointer 形态的字符串放在非白名单字段时原样保留', () => {
    const input = { pointer: '/tasks/0/result_file', selector: 'a\\b\\c' };
    assert.equal(JSON.stringify(deepNormalizePaths(input, ROOT)), JSON.stringify(input));
  });
});

describe('scanJsonHygiene', () => {
  it('目录不存在时返回 scanned:0 且不抛', () => {
    const r = scanJsonHygiene(path.join(TMP, 'never-created-dir'));
    assert.equal(r.scanned, 0);
    assert.deepEqual(r.bom, []);
    assert.deepEqual(r.backslash, []);
    assert.deepEqual(r.corrupt, []);
  });

  it('空/未定义目录参数不抛', () => {
    assert.equal(scanJsonHygiene('').scanned, 0);
    assert.equal(scanJsonHygiene(undefined).scanned, 0);
  });

  it('把正常/BOM/反斜杠/损坏四类文件分别正确归类', () => {
    const dir = path.join(TMP, 'hygiene');
    fs.mkdirSync(dir, { recursive: true });
    const clean = path.join(dir, 'clean.json');
    const bom = path.join(dir, 'bom.json');
    const bs = path.join(dir, 'backslash.json');
    const bad = path.join(dir, 'corrupt.json');
    fs.writeFileSync(clean, JSON.stringify({ ok: true, file: 'results/a.json' }) + '\n', 'utf8');
    fs.writeFileSync(bom, '\uFEFF' + JSON.stringify({ ok: true }) + '\n', 'utf8');
    fs.writeFileSync(bs, JSON.stringify({ tasks: [{ result_file: 'E:\\x\\y.rs' }] }) + '\n', 'utf8');
    fs.writeFileSync(bad, '{"broken": ', 'utf8');

    const r = scanJsonHygiene(dir);
    assert.equal(r.scanned, 4);
    assert.deepEqual(r.bom, [bom]);
    assert.deepEqual(r.corrupt.map((c) => c.file), [bad]);
    assert.equal(r.backslash.length, 1);
    assert.equal(r.backslash[0].file, bs);
    assert.equal(r.backslash[0].value, 'E:\\x\\y.rs');
    // clean.json 不该出现在任何问题列表里
    assert.equal(r.bom.includes(clean), false);
    assert.equal(r.backslash.some((b) => b.file === clean), false);
    assert.equal(r.corrupt.some((c) => c.file === clean), false);
  });

  it('backslash 项的 keyPath 精确定位到数组下标与字段名', () => {
    const dir = path.join(TMP, 'keypath');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'T1' }, { result_file: 'E:\\p\\r.json' }] }) + '\n',
      'utf8'
    );
    const r = scanJsonHygiene(dir);
    assert.equal(r.backslash.length, 1);
    assert.equal(r.backslash[0].keyPath, 'tasks.1.result_file');
  });

  it('递归进子目录扫描，非 .json 文件被跳过', () => {
    const dir = path.join(TMP, 'recursive');
    const sub = path.join(dir, 'runtime', 'team-1', 'tasks');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(dir, 'top.json'), '{"a":1}\n', 'utf8');
    fs.writeFileSync(path.join(sub, 'deep.json'), '{"result_file":"src\\\\a.rs"}\n', 'utf8');
    fs.writeFileSync(path.join(sub, 'notes.md'), '# not json\n', 'utf8');
    const r = scanJsonHygiene(dir);
    assert.equal(r.scanned, 2);
    assert.equal(r.backslash.length, 1);
    assert.equal(r.backslash[0].keyPath, 'result_file');
    assert.equal(r.backslash[0].file, path.join(sub, 'deep.json'));
  });
});

/**
 * 护栏上限：极深目录树与超大 .omz/ 都不得让 doctor 栈溢出或跑飞。
 * 超限必须**显式**标 truncated（附原因），否则 doctor 会报「无 BOM/无损坏」，
 * 而实际上根本没扫到那些文件——比直接失败更危险。
 */
describe('scanJsonHygiene 护栏上限', () => {
  it('JSON_SCAN_DEFAULTS 是冻结的默认上限（maxDepth 32 / maxFiles 5000）', () => {
    assert.equal(Object.isFrozen(JSON_SCAN_DEFAULTS), true);
    assert.equal(JSON_SCAN_DEFAULTS.maxDepth, 32);
    assert.equal(JSON_SCAN_DEFAULTS.maxFiles, 5000);
  });

  it('40 层深目录树被截断为 truncated 且不栈溢出', () => {
    const base = path.join(TMP, 'deep-tree');
    let cur = base;
    for (let i = 0; i < 40; i += 1) cur = path.join(cur, `d${i}`);
    fs.mkdirSync(cur, { recursive: true });
    fs.writeFileSync(path.join(base, 'top.json'), '{"a":1}\n', 'utf8');
    fs.writeFileSync(path.join(cur, 'too-deep.json'), '{"a":1}\n', 'utf8');

    let r;
    assert.doesNotThrow(() => {
      r = scanJsonHygiene(base);
    }, '深目录树不得抛（栈溢出即缺陷）');
    assert.equal(r.truncated, true);
    assert.equal(r.scanned, 1, '只应扫到上限内的 top.json');
    assert.ok(r.truncateReasons.some((x) => /目录深度超过上限 32/.test(x)), `缺深度超限原因：${JSON.stringify(r.truncateReasons)}`);
    assert.ok(r.skipped.some((s) => /depth>32/.test(s.reason)), '超深目录必须进 skipped');
  });

  it('显式传入更小的 maxDepth 时按传入值截断', () => {
    const base = path.join(TMP, 'depth-opt');
    fs.mkdirSync(path.join(base, 'a', 'b', 'c', 'd'), { recursive: true });
    fs.writeFileSync(path.join(base, 'root.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(base, 'a', 'b', 'c', 'd', 'deep.json'), '{}\n', 'utf8');
    const r = scanJsonHygiene(base, { maxDepth: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.scanned, 1);
    assert.ok(r.truncateReasons.some((x) => /目录深度超过上限 2/.test(x)));
  });

  it('文件数超过 maxFiles 时截断并给出原因（原因不重复堆叠）', () => {
    const dir = path.join(TMP, 'many-files');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(dir, `f${i}.json`), '{}\n', 'utf8');
    const r = scanJsonHygiene(dir, { maxFiles: 5 });
    assert.equal(r.scanned, 5);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.truncateReasons, ['文件数超过上限 5'], '同一原因不得重复累积');
  });

  it('未超限时 truncated 为 false 且 truncateReasons 为空', () => {
    const dir = path.join(TMP, 'within-limits');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), '{}\n', 'utf8');
    const r = scanJsonHygiene(dir);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.truncateReasons, []);
    assert.deepEqual(r.skipped, []);
  });

  it('不可读目录进 skipped 而非被无声跳过', () => {
    // 传一个「文件」当目录：readdirSync 抛 ENOTDIR，是可移植地制造不可读目录的办法
    // （Windows 上 chmod 000 对目录不生效，用它做断言会在本机永远通过）
    const dir = path.join(TMP, 'not-a-dir');
    fs.mkdirSync(dir, { recursive: true });
    const fake = path.join(dir, 'plain.json');
    fs.writeFileSync(fake, '{"a":1}\n', 'utf8');

    const r = scanJsonHygiene(fake);
    assert.equal(r.scanned, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].dir, fake);
    assert.match(r.skipped[0].reason, /ENOTDIR/);
  });

  it('子目录不可读时其余目录仍被扫到（单点失败不拖垮整次扫描）', () => {
    const base = path.join(TMP, 'partial-scan');
    fs.mkdirSync(path.join(base, 'good'), { recursive: true });
    fs.writeFileSync(path.join(base, 'good', 'ok.json'), '{"a":1}\n', 'utf8');
    const r = scanJsonHygiene(base);
    assert.equal(r.scanned, 1);
    assert.deepEqual(r.corrupt, []);
  });
});
