/**
 * tests/protocol.test.mjs
 * OMZ 协议文本与供应链清单的静态回归防线：agents/commands/skills 是本项目的核心资产，
 * 结构性只读保证（DESIGN §4）、失控护栏（B6）、跨文件契约一致性都必须有断言兜住。
 * 对仓库只读；唯一的写操作（updateLock）在临时目录的 lock 副本上进行。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, validateAll } from '../tools/validate-frontmatter.mjs';
import { loadLock, planSync, checkTargets, updateLock } from '../tools/sync-omo-skills.mjs';

let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omz-protocol-'));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const AGENTS_DIR = path.join(ROOT, 'agents');
const COMMANDS_DIR = path.join(ROOT, 'commands');
const SKILLS_DIR = path.join(ROOT, 'skills');

const AGENT_NAMES = [
  'omz-atlas',
  'omz-critic',
  'omz-deep',
  'omz-junior',
  'omz-librarian',
  'omz-looker',
  'omz-oracle',
  'omz-planner',
  'omz-reviewer'
];

/** 只读角色：结构上不可能"顺手帮改"（DESIGN §4 的核心保证） */
const READONLY_AGENTS = ['omz-critic', 'omz-oracle', 'omz-reviewer', 'omz-librarian', 'omz-looker'];
/** 全工具角色：省略 tools 字段 = 继承全工具 */
const FULL_TOOL_AGENTS = ['omz-deep', 'omz-junior', 'omz-atlas'];

const COMMAND_NAMES = ['hyperplan', 'omz-doctor', 'omz-status', 'team', 'ulw'];
const SKILL_NAMES = ['review-work', 'ulw-execute', 'ulw-plan', 'ulw-research'];

const THOUGHT_LEVELS = new Set(['off', 'low', 'medium', 'high', 'max']);

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function agentFm(name) {
  return parseFrontmatter(readText(path.join(AGENTS_DIR, `${name}.md`)));
}

/** 递归收集指定后缀的文件（跳过 node_modules / .git）。 */
function walk(dir, exts, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.omz') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, acc);
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) acc.push(full);
  }
  return acc;
}

describe('validateAll', () => {
  it('仓库清单的 frontmatter 校验无任何错误', () => {
    const errors = validateAll(ROOT);
    assert.deepEqual(errors, [], `frontmatter 校验失败：\n${errors.join('\n')}`);
  });
});

describe('agents 清单', () => {
  it('9 个 agents/omz-*.md 全部存在，且目录下没有多余的 agent 文件', () => {
    for (const name of AGENT_NAMES) {
      assert.equal(fs.existsSync(path.join(AGENTS_DIR, `${name}.md`)), true, `缺 agents/${name}.md`);
    }
    const found = fs.readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.md')).sort();
    assert.deepEqual(found, AGENT_NAMES.map((n) => `${n}.md`).sort());
  });

  it('每个 agent 的 frontmatter name 与文件名一致', () => {
    for (const name of AGENT_NAMES) {
      assert.equal(agentFm(name).name, name, `agents/${name}.md 的 name 与文件名不一致`);
    }
  });

  it('每个 agent 都有 description', () => {
    for (const name of AGENT_NAMES) {
      const fm = agentFm(name);
      assert.equal(typeof fm.description, 'string');
      assert.ok(fm.description.length > 0, `${name} 缺 description`);
    }
  });

  it('只读角色的 tools 数组不含 Edit/Write（DESIGN §4 结构性只读保证）', () => {
    for (const name of READONLY_AGENTS) {
      const fm = agentFm(name);
      assert.ok(Array.isArray(fm.tools), `${name} 必须显式声明 tools 白名单`);
      assert.equal(fm.tools.includes('Edit'), false, `${name} 不得拥有 Edit`);
      assert.equal(fm.tools.includes('Write'), false, `${name} 不得拥有 Write`);
      assert.equal(fm.tools.includes('Agent'), false, `${name} 不得能再委派`);
      assert.ok(fm.tools.includes('Read'), `${name} 至少应有 Read`);
    }
  });

  it('全工具角色不声明 tools 字段（省略即全工具）', () => {
    for (const name of FULL_TOOL_AGENTS) {
      assert.equal(agentFm(name).tools, undefined, `${name} 不应声明 tools 白名单`);
    }
  });

  it('所有 agent 都有 maxTurns 且为正整数（B6 失控护栏）', () => {
    for (const name of AGENT_NAMES) {
      const fm = agentFm(name);
      assert.equal(typeof fm.maxTurns, 'number', `${name} 缺 maxTurns`);
      assert.ok(Number.isInteger(fm.maxTurns) && fm.maxTurns > 0, `${name} 的 maxTurns 非正整数：${fm.maxTurns}`);
    }
  });

  it('声明了 thoughtLevel 的 agent 取值都在枚举内', () => {
    for (const name of AGENT_NAMES) {
      const fm = agentFm(name);
      if (fm.thoughtLevel === undefined) continue;
      assert.ok(THOUGHT_LEVELS.has(String(fm.thoughtLevel)), `${name} 的 thoughtLevel 非法：${fm.thoughtLevel}`);
    }
  });

  it('agent frontmatter 不含未知字段', () => {
    const known = new Set(['name', 'description', 'tools', 'model', 'thoughtLevel', 'permissionMode', 'maxTurns', 'memory', 'color', 'mcpServers']);
    for (const name of AGENT_NAMES) {
      for (const key of Object.keys(agentFm(name))) {
        assert.ok(known.has(key), `${name} 含未知 frontmatter 字段 '${key}'`);
      }
    }
  });
});

describe('commands 清单', () => {
  it('5 个 commands/*.md 全部存在且各有 description', () => {
    for (const name of COMMAND_NAMES) {
      const file = path.join(COMMANDS_DIR, `${name}.md`);
      assert.equal(fs.existsSync(file), true, `缺 commands/${name}.md`);
      const fm = parseFrontmatter(readText(file));
      assert.ok(fm, `commands/${name}.md 缺 frontmatter`);
      assert.equal(typeof fm.description, 'string');
      assert.ok(fm.description.length > 0, `commands/${name}.md 的 description 为空`);
    }
    const found = fs.readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md')).sort();
    assert.deepEqual(found, COMMAND_NAMES.map((n) => `${n}.md`).sort());
  });

  it('ulw.md 含 8 要素委派协议的全部要素名', () => {
    const text = readText(path.join(COMMANDS_DIR, 'ulw.md'));
    for (const element of [
      'TASK',
      'EXPECTED OUTCOME',
      'failing-first',
      'REQUIRED SKILLS',
      'REQUIRED TOOLS',
      'MUST DO',
      'MUST NOT DO',
      'CONTEXT'
    ]) {
      assert.ok(text.includes(element), `ulw.md 缺 8 要素之一：${element}`);
    }
  });

  it('ulw.md 的 Hard rules 编号 1..10 全部出现', () => {
    const text = readText(path.join(COMMANDS_DIR, 'ulw.md'));
    const section = text.slice(text.indexOf('## Hard rules'));
    assert.ok(section.length > 0, 'ulw.md 缺 Hard rules 段');
    for (let n = 1; n <= 10; n += 1) {
      assert.ok(new RegExp(`^${n}\\. `, 'm').test(section), `Hard rules 缺第 ${n} 条`);
    }
    assert.match(text, /Hard rules（10 条/);
  });

  it('ulw.md 的 category 路由表含 8 个 category 名', () => {
    const text = readText(path.join(COMMANDS_DIR, 'ulw.md'));
    for (const category of [
      'visual-engineering',
      'ultrabrain',
      'deep',
      'artistry',
      'quick',
      'unspecified-low',
      'unspecified-high',
      'writing'
    ]) {
      assert.ok(text.includes(category), `category 路由表缺 ${category}`);
    }
  });

  it('omz-status.md 含 ```! 内联执行块', () => {
    const text = readText(path.join(COMMANDS_DIR, 'omz-status.md'));
    assert.match(text, /```!\r?\n/);
  });

  /**
   * 两路渲染的定位裁决（本轮审计）：不再断言内联块与 render-status.mjs「逐字一致」——
   * 那是个做不到也不该做的目标（内联块是单行 node -e 的兜底最小实现，字段顺序等细节必然有差）。
   * 改为断言两件事：① 文档诚实交代了这个差异并指明以哪一路为准；② 两路对同一 fixture 都能
   * 跑出非空且不超 40 行的输出（功能等价而非字面等价）。
   */
  it('omz-status.md 诚实交代两路输出不保证逐字一致，并指明以 render-status.mjs 为准', () => {
    const text = readText(path.join(COMMANDS_DIR, 'omz-status.md'));
    assert.match(text, /两路输出不保证逐字一致/);
    assert.match(text, /以\s*`?tools\/render-status\.mjs`?\s*的输出为准|以 render-status\.mjs 的输出为准/);
    assert.ok(text.includes('兜底最小实现'), '应说明内联块的定位是兜底最小实现');
  });

  it('team.md 与 hyperplan.md 各自声明了核心纪律', () => {
    const team = readText(path.join(COMMANDS_DIR, 'team.md'));
    assert.ok(team.includes('B8'), 'team.md 应声明以文件为准的收点原则（B8）');
    const hyperplan = readText(path.join(COMMANDS_DIR, 'hyperplan.md'));
    assert.ok(hyperplan.includes('omz-planner') && hyperplan.includes('omz-critic'), 'hyperplan.md 应含规划与评审角色');
  });
});

/**
 * 两路 status 渲染的功能等价：内联块（commands/omz-status.md 的 ```! 段）与
 * tools/render-status.mjs 对同一 .omz/ fixture 都必须给出可用输出。
 * 内联块是 hook/命令展开时的兜底路径，它坏掉时用户看到的是空面板——必须有回归防线。
 */
describe('两路 status 渲染一致性', () => {
  const RENDER_STATUS = path.join(ROOT, 'tools', 'render-status.mjs');

  /** 从 omz-status.md 里抽出内联块内部的 node -e 代码体。 */
  function inlineCode() {
    const md = readText(path.join(COMMANDS_DIR, 'omz-status.md'));
    const block = md.match(/```!\r?\n([\s\S]*?)\r?\n```/);
    assert.ok(block, 'omz-status.md 缺 ```! 内联块');
    const body = block[1].trim();
    const m = body.match(/^node -e "([\s\S]*)"$/);
    assert.ok(m, `内联块应是单条 node -e "..." 命令，实际开头：${body.slice(0, 40)}`);
    return m[1];
  }

  /** 造一个含 boulder/goal/team-tasks/plan 四类内容的 fixture 项目根。 */
  function makeFixture(label) {
    const root = path.join(TMP, `render-${label}`);
    const omz = path.join(root, '.omz');
    fs.mkdirSync(path.join(omz, 'runtime', 'team-x', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(omz, 'goal'), { recursive: true });
    fs.mkdirSync(path.join(omz, 'plans'), { recursive: true });
    fs.writeFileSync(
      path.join(omz, 'boulder.json'),
      JSON.stringify({ active_goal: 'g1', active_plan: 'p1.md', active_team: 'team-x', status: 'active' }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(omz, 'goal', 'g1.json'),
      JSON.stringify({
        outcome: '把测试跑绿',
        binary_success_criteria: [{ id: 'sc1', status: 'done' }, { id: 'sc2', status: 'pending' }]
      }) + '\n',
      'utf8'
    );
    for (const [key, wave, status] of [['A', 1, 'done'], ['B', 1, 'running'], ['C', 2, 'pending']]) {
      fs.writeFileSync(
        path.join(omz, 'runtime', 'team-x', 'tasks', `${key}.json`),
        JSON.stringify({ id: key, key, wave, status, title: `任务 ${key}` }) + '\n',
        'utf8'
      );
    }
    fs.writeFileSync(path.join(omz, 'plans', 'p1.md'), '# plan\n', 'utf8');
    return root;
  }

  it('内联块对 fixture 输出非空且行数不超过 40', () => {
    const root = makeFixture('inline');
    const r = spawnSync(process.execPath, ['-e', inlineCode()], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `内联块应正常退出，stderr=${r.stderr}`);
    const lines = r.stdout.trimEnd().split('\n');
    assert.ok(lines.length > 0 && r.stdout.trim().length > 0, '内联块输出为空');
    assert.ok(lines.length <= 40, `内联块输出 ${lines.length} 行，超过 40 行硬上限`);
  });

  it('render-status.mjs 对同一 fixture 输出非空且行数不超过 40', () => {
    const root = makeFixture('renderer');
    const r = spawnSync(process.execPath, [RENDER_STATUS], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `render-status.mjs 应正常退出，stderr=${r.stderr}`);
    const lines = r.stdout.trimEnd().split('\n');
    assert.ok(r.stdout.trim().length > 0, 'render-status.mjs 输出为空');
    assert.ok(lines.length <= 40, `render-status.mjs 输出 ${lines.length} 行，超过 40 行硬上限`);
  });

  it('两路都渲染出 boulder / goal / team / 三个任务 / plan 五类信息（功能等价）', () => {
    const root = makeFixture('equiv');
    const outs = {
      inline: spawnSync(process.execPath, ['-e', inlineCode()], { cwd: root, encoding: 'utf8', timeout: 30000 }),
      renderer: spawnSync(process.execPath, [RENDER_STATUS], { cwd: root, encoding: 'utf8', timeout: 30000 })
    };
    for (const [label, r] of Object.entries(outs)) {
      assert.equal(r.status, 0, `${label} 退出码非 0：${r.stderr}`);
      const text = r.stdout;
      assert.match(text, /^\[boulder\] /m, `${label} 缺 boulder 行`);
      assert.match(text, /^\[goal\] g1\.json/m, `${label} 缺 goal 行`);
      assert.ok(text.includes('SC 1/2'), `${label} 的 goal 行缺 SC 计数`);
      assert.match(text, /^\[team\] team-x$/m, `${label} 缺 team 行`);
      assert.ok(text.includes('wave | task | status | title'), `${label} 缺任务表头`);
      for (const key of ['A', 'B', 'C']) {
        assert.ok(text.includes(` ${key} | `), `${label} 缺任务 ${key} 的行`);
      }
      assert.match(text, /^\[plan\] p1\.md$/m, `${label} 缺 plan 行`);
    }
  });

  it('空 .omz/ 时两路都给出同一句「无状态」提示', () => {
    const root = path.join(TMP, 'render-empty');
    fs.mkdirSync(path.join(root, '.omz'), { recursive: true });
    const inline = spawnSync(process.execPath, ['-e', inlineCode()], { cwd: root, encoding: 'utf8', timeout: 30000 });
    const renderer = spawnSync(process.execPath, [RENDER_STATUS], { cwd: root, encoding: 'utf8', timeout: 30000 });
    for (const [label, r] of [['inline', inline], ['renderer', renderer]]) {
      assert.equal(r.status, 0, `${label} 退出码非 0：${r.stderr}`);
      assert.ok(r.stdout.includes('无状态'), `${label} 空目录时应给出「无状态」提示，实际：${r.stdout}`);
    }
  });

  it('损坏任务文件时两路都标 corrupt 且不崩', () => {
    const root = makeFixture('corrupt');
    fs.writeFileSync(path.join(root, '.omz', 'runtime', 'team-x', 'tasks', 'A.json'), '{"key": "A", ', 'utf8');
    const inline = spawnSync(process.execPath, ['-e', inlineCode()], { cwd: root, encoding: 'utf8', timeout: 30000 });
    const renderer = spawnSync(process.execPath, [RENDER_STATUS], { cwd: root, encoding: 'utf8', timeout: 30000 });
    for (const [label, r] of [['inline', inline], ['renderer', renderer]]) {
      assert.equal(r.status, 0, `${label} 遇损坏文件不得非 0 退出：${r.stderr}`);
      assert.ok(r.stdout.includes('corrupt'), `${label} 应标出 corrupt`);
      assert.ok(r.stdout.includes(' B | '), `${label} 其余任务仍应渲染`);
    }
  });
});

/**
 * 状态枚举的三方闭环：coordinator 的 7 态 + 文件视图的 pending/corrupt 共 9 个取值，
 * 必须与 dashboard/renderer/app.js 的 STATES 常量、app.css 的 [data-state=...] 选择器完全一致。
 * 任一方少一个取值，看板就会把有明确语义的状态显示成紫色 unknown 药丸——
 * 「待执行」与「文件损坏」被混同为「不可判定」，运维动作完全走偏。
 * 三个集合都从源码正则提取，不硬编码，否则测试自己会先漂移。
 */
describe('状态枚举三方闭环（coordinator / app.js / app.css）', () => {
  const APP_JS = path.join(ROOT, 'dashboard', 'renderer', 'app.js');
  const APP_CSS = path.join(ROOT, 'dashboard', 'renderer', 'app.css');
  const SCHEMA = path.join(ROOT, 'mcp', 'coordinator', 'schema.sql');

  /** 从 core.mjs 的 COUNT_KEYS 提取 coordinator 的 7 态（唯一定义处）。 */
  function coordinatorStates() {
    const src = readText(path.join(ROOT, 'mcp', 'coordinator', 'core.mjs'));
    const m = src.match(/const COUNT_KEYS = \[([^\]]*)\]/);
    assert.ok(m, 'core.mjs 未找到 COUNT_KEYS 定义');
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  /** 从 core.mjs 的 MIRROR_STATUS 提取文件视图的四态投影值。 */
  function mirrorStates() {
    const src = readText(path.join(ROOT, 'mcp', 'coordinator', 'core.mjs'));
    const m = src.match(/const MIRROR_STATUS = \{([\s\S]*?)\};/);
    assert.ok(m, 'core.mjs 未找到 MIRROR_STATUS 定义');
    return [...m[1].matchAll(/:\s*'([a-z-]+)'/g)].map((x) => x[1]);
  }

  /** 从 app.js 的 STATES 数组提取（跳过注释行里的词）。 */
  function rendererStates() {
    const src = readText(APP_JS);
    const m = src.match(/var STATES = \[([\s\S]*?)\];/);
    assert.ok(m, 'app.js 未找到 STATES 定义');
    return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  }

  /** 从 app.css 提取所有 [data-state="..."] 选择器值。 */
  function cssStates() {
    const src = readText(APP_CSS);
    return [...src.matchAll(/\[data-state="([a-z-]+)"\]/g)].map((x) => x[1]);
  }

  it('三方集合完全一致（coordinator 7 态 + 文件视图 pending/corrupt = app.js STATES = app.css 选择器）', () => {
    const coordinator = coordinatorStates();
    assert.equal(coordinator.length, 7, `coordinator 应有 7 态，实际 ${coordinator.length}：${coordinator}`);

    // 期望集合 = coordinator 7 态 ∪ 文件视图附加的 pending/corrupt
    const expected = [...new Set([...coordinator, 'pending', 'corrupt'])].sort();
    const renderer = [...new Set(rendererStates())].sort();
    const css = [...new Set(cssStates())].sort();

    assert.deepEqual(renderer, expected, 'app.js 的 STATES 与 coordinator+文件视图取值域不一致');
    assert.deepEqual(css, expected, 'app.css 的 [data-state] 选择器与 STATES 不一致');
    assert.equal(expected.length, 9, `三方集合应是 9 个取值，实际 ${expected.length}：${expected}`);
  });

  it('app.js STATES 与 app.css 选择器无重复项（重复即定义处漂移的信号）', () => {
    const renderer = rendererStates();
    const css = cssStates();
    assert.equal(new Set(renderer).size, renderer.length, `app.js STATES 有重复项：${renderer}`);
    assert.equal(new Set(css).size, css.length, `app.css 的 [data-state] 有重复选择器：${css}`);
  });

  it('pending 与 corrupt 都在三方集合里且语义被区分（不得只留 unknown）', () => {
    for (const state of ['pending', 'corrupt', 'unknown']) {
      assert.ok(rendererStates().includes(state), `app.js STATES 缺 ${state}`);
      assert.ok(cssStates().includes(state), `app.css 缺 [data-state="${state}"]`);
    }
    // corrupt 与 unknown 必须有各自的样式（同一配色等于把两种运维动作混同）
    const css = readText(APP_CSS);
    const corruptRule = css.match(/\[data-state="corrupt"\][^}]*\}/);
    const unknownRule = css.match(/\[data-state="unknown"\][^}]*\}/);
    assert.ok(corruptRule && unknownRule, 'corrupt 与 unknown 都应有独立样式规则');
    assert.notEqual(corruptRule[0], unknownRule[0], 'corrupt 与 unknown 的样式不得完全相同');
  });

  it('MIRROR_STATUS 的四态投影值全在三方集合内', () => {
    const renderer = new Set(rendererStates());
    for (const projected of new Set(mirrorStates())) {
      assert.ok(renderer.has(projected), `MIRROR_STATUS 投影出的 ${projected} 不在 app.js STATES 里`);
    }
  });

  it('schema.sql 注释里登记的 tasks.status 枚举与 core.mjs 的 COUNT_KEYS 一致', () => {
    const sql = readText(SCHEMA);
    const m = sql.match(/tasks\.status 枚举：([^\n。]*)/);
    assert.ok(m, 'schema.sql 缺 tasks.status 枚举注释');
    const declared = m[1]
      .split('|')
      .map((s) => s.trim())
      .filter((s) => /^[a-z]+$/.test(s))
      .sort();
    assert.deepEqual(declared, [...coordinatorStates()].sort(), 'schema.sql 注释与 core.mjs COUNT_KEYS 不一致');
  });
});

describe('skills 清单与 references 一致性', () => {
  it('4 个 skills/*/SKILL.md 全部存在且 description 含严格触发语义', () => {
    for (const name of SKILL_NAMES) {
      const file = path.join(SKILLS_DIR, name, 'SKILL.md');
      assert.equal(fs.existsSync(file), true, `缺 skills/${name}/SKILL.md`);
      const fm = parseFrontmatter(readText(file));
      assert.equal(fm.name, name, `skills/${name} 的 frontmatter name 不一致`);
      assert.ok(
        /仅当|当.+激活|不得激活/.test(fm.description),
        `skills/${name} 的 description 缺严格触发语义（防误触发）：${fm.description}`
      );
    }
  });

  it('skills 目录下没有多余的技能目录', () => {
    const dirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.deepEqual(dirs, [...SKILL_NAMES].sort());
  });

  /**
   * 断言方向的裁决（本轮审计）：旧断言 `deepEqual(actual, declared)` 把 references 钉死为 5 个，
   * 新增一份 SKILL.md 已显式声明的文档（worker-prompt.md）就误报。
   * 改成「declared ⊆ actual」：漏掉**声明过**的文档仍会被抓（那才是真正的不一致），
   * 扩充 references 不再算回归。目录里多出的文件另行断言「必须被 SKILL.md 引用」，
   * 于是「声明了但没有」与「有但没人引用」两类问题都仍在防线内。
   */
  it('ulw-research/SKILL.md 声明的 references 文档全部真实存在且非空', () => {
    const text = readText(path.join(SKILLS_DIR, 'ulw-research', 'SKILL.md'));
    const declared = [
      'intent-diff.md',
      'claim-graph.md',
      'observation-manifest.md',
      'verification-economics.md',
      'cause-disappearance.md',
      'worker-prompt.md'
    ];
    const refDir = path.join(SKILLS_DIR, 'ulw-research', 'references');
    const actual = fs.readdirSync(refDir).sort();
    for (const doc of declared) {
      assert.ok(text.includes(doc), `SKILL.md 未声明 ${doc}`);
      assert.ok(actual.includes(doc), `声明了 ${doc} 但 references/ 下不存在`);
      assert.ok(fs.statSync(path.join(refDir, doc)).size > 0, `${doc} 是空文件（文档与实体不一致）`);
    }
  });

  it('ulw-research/references/ 下没有未被 SKILL.md 引用的孤儿文档', () => {
    const text = readText(path.join(SKILLS_DIR, 'ulw-research', 'SKILL.md'));
    const refDir = path.join(SKILLS_DIR, 'ulw-research', 'references');
    const orphans = fs.readdirSync(refDir).filter((f) => !text.includes(f));
    assert.deepEqual(orphans, [], `references/ 下有未被 SKILL.md 引用的文档：${orphans.join(', ')}`);
  });

  it('worker-prompt.md 存在且被 SKILL.md 当作强制派发模板引用', () => {
    const file = path.join(SKILLS_DIR, 'ulw-research', 'references', 'worker-prompt.md');
    assert.equal(fs.existsSync(file), true, '缺 ulw-research/references/worker-prompt.md');
    assert.ok(fs.statSync(file).size > 0, 'worker-prompt.md 为空');
    const text = readText(path.join(SKILLS_DIR, 'ulw-research', 'SKILL.md'));
    // 它承载的是「派发任何调查轴之前必读」的强制语义，不是可选附录
    assert.match(text, /references\/worker-prompt\.md/);
    assert.ok(/必读|必须/.test(text), 'SKILL.md 应把 worker-prompt.md 声明为强制模板');
  });

  it('review-work/references/ 的 2 个文件存在且非空', () => {
    const dir = path.join(SKILLS_DIR, 'review-work', 'references');
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['lane-prompts.md', 'verdict-schema.md']);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size > 0, `${f} 为空`);
  });

  it('ulw-plan/references/ 的 3 个文件存在，且 SKILL.md 逐个声明过', () => {
    const dir = path.join(SKILLS_DIR, 'ulw-plan', 'references');
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['full-workflow.md', 'intent-clear.md', 'intent-unclear.md']);
    const text = readText(path.join(SKILLS_DIR, 'ulw-plan', 'SKILL.md'));
    for (const f of files) {
      assert.ok(text.includes(f), `ulw-plan/SKILL.md 未声明 references/${f}`);
      assert.ok(fs.statSync(path.join(dir, f)).size > 0, `${f} 为空`);
    }
  });
});

describe('跨文件契约一致性', () => {
  it('omz-reviewer.md 与 verdict-schema.md 的 AdversarialVerify 四个字段名完全一致', () => {
    const reviewer = readText(path.join(AGENTS_DIR, 'omz-reviewer.md'));
    const schema = readText(path.join(SKILLS_DIR, 'review-work', 'references', 'verdict-schema.md'));
    const fields = ['verdict', 'evidence', 'repro', 'confidence'];
    for (const f of fields) {
      assert.ok(new RegExp(`"${f}"\\s*:`).test(reviewer), `omz-reviewer.md 缺字段 "${f}"`);
      assert.ok(new RegExp(`"${f}"\\s*:`).test(schema), `verdict-schema.md 缺字段 "${f}"`);
    }
  });

  it('AdversarialVerify 的四个 verdict 枚举值在两处完全一致', () => {
    const reviewer = readText(path.join(AGENTS_DIR, 'omz-reviewer.md'));
    const schema = readText(path.join(SKILLS_DIR, 'review-work', 'references', 'verdict-schema.md'));
    for (const v of ['confirmed', 'false-positive', 'needs-fix', 'needs-human-review']) {
      assert.ok(reviewer.includes(v), `omz-reviewer.md 缺 verdict 值 ${v}`);
      assert.ok(schema.includes(v), `verdict-schema.md 缺 verdict 值 ${v}`);
    }
    // confirmed 是唯一通过裁决，两处都必须写明
    assert.ok(reviewer.includes('confirmed') && /唯一通过裁决/.test(reviewer));
    assert.ok(schema.includes('confirmed') && /唯一通过裁决/.test(schema));
  });

  it('复审上限 2 次的纪律在 reviewer 与 verdict-schema 两处一致声明', () => {
    const reviewer = readText(path.join(AGENTS_DIR, 'omz-reviewer.md'));
    const schema = readText(path.join(SKILLS_DIR, 'review-work', 'references', 'verdict-schema.md'));
    assert.match(reviewer, /上限\s*\*{0,2}2\s*次/);
    assert.match(schema, /上限\s*\*{0,2}2\s*次/);
  });

  it('lane verdict 枚举（PASS/FAIL/INCONCLUSIVE）在 SKILL.md 与 verdict-schema.md 一致', () => {
    const skill = readText(path.join(SKILLS_DIR, 'review-work', 'SKILL.md'));
    const schema = readText(path.join(SKILLS_DIR, 'review-work', 'references', 'verdict-schema.md'));
    for (const v of ['PASS', 'FAIL', 'INCONCLUSIVE']) {
      assert.ok(skill.includes(v), `review-work/SKILL.md 缺 lane verdict ${v}`);
      assert.ok(schema.includes(v), `verdict-schema.md 缺 lane verdict ${v}`);
    }
  });

  it('plugin.json 声明的 commands/skills 路径都真实存在', () => {
    const manifest = JSON.parse(readText(path.join(ROOT, '.zcode-plugin', 'plugin.json')));
    for (const key of ['commands', 'skills']) {
      const value = manifest[key];
      assert.equal(typeof value, 'string', `plugin.json 缺 ${key}`);
      assert.equal(fs.existsSync(path.resolve(ROOT, value)), true, `plugin.json 的 ${key}=${value} 不存在`);
    }
  });

  /**
   * 引擎的 ZMo() 对清单里出现的每个「诊断-only 组件」键推一条 plugin_unsupported_component
   * warning（常量 $Mo/n5o = agents/channels/lspServers/outputStyles/settings）。
   * agents 尤其容易误加：子代理确实能用，但那是 loadPluginAgentProfiles 从 <root>/agents/*.md
   * 目录扫出来的，与清单声明无关——写进清单只换来一条 warning。
   * 实测依据：写了 "agents" 时 `zcode plugins list --verbose` 报
   * "Plugin component is diagnostic-only in this ZCode runtime: agents"，删掉后归零。
   */
  it('plugin.json 不含引擎判为「诊断-only」的组件键（装机零 warning）', () => {
    const manifest = JSON.parse(readText(path.join(ROOT, '.zcode-plugin', 'plugin.json')));
    const diagnosticOnly = ['agents', 'channels', 'lspServers', 'outputStyles', 'settings'];
    const hit = diagnosticOnly.filter((key) => key in manifest);
    assert.deepEqual(hit, [], `这些键会让引擎报 plugin_unsupported_component warning：${hit.join(', ')}`);
  });

  /**
   * 引擎的 listPluginHookSources 先按 join(rootPath, 'hooks', 'hooks.json') **自动发现**，
   * 再读清单的 hooks 键；两者 realpath 相同即报 plugin_hook_invalid
   * "Duplicate plugin hooks file ignored"（该条被忽略，自动发现那条仍生效）。
   * 所以 hooks/hooks.json 存在时清单**不能**再声明它。
   */
  it('hooks/hooks.json 走引擎自动发现，清单不得重复声明（否则 Duplicate warning）', () => {
    const manifest = JSON.parse(readText(path.join(ROOT, '.zcode-plugin', 'plugin.json')));
    const autoDiscovered = path.join(ROOT, 'hooks', 'hooks.json');
    assert.equal(fs.existsSync(autoDiscovered), true, 'hooks/hooks.json 不存在——自动发现路径断了');
    assert.equal(
      'hooks' in manifest,
      false,
      'hooks/hooks.json 已被引擎自动发现，清单再声明会产生 Duplicate plugin hooks file ignored warning'
    );
  });

  /**
   * 自建市场索引：引擎按 .claude-plugin/marketplace.json → marketplace.json 顺序发现（Not()/JRo）。
   * 条目 name/version 必须与插件清单同源，否则安装时 f5o() 抛
   * "Plugin manifest name does not match marketplace entry"。
   */
  it('marketplace.json 的条目与 plugin.json 同源（name/version 一致）', () => {
    const marketFile = path.join(ROOT, '.claude-plugin', 'marketplace.json');
    assert.equal(fs.existsSync(marketFile), true, '缺 .claude-plugin/marketplace.json');
    const market = JSON.parse(readText(marketFile));
    const manifest = JSON.parse(readText(path.join(ROOT, '.zcode-plugin', 'plugin.json')));
    const entry = market.plugins.find((p) => p.name === manifest.name);
    assert.ok(entry, `marketplace.json 里没有 name=${manifest.name} 的条目`);
    assert.equal(entry.version, manifest.version, 'marketplace 条目版本与 plugin.json 不一致');
    assert.equal(entry.source?.source, 'github', 'source.source 应为 github（引擎优先走 tarball API，无需本机 git）');
    assert.equal(entry.source?.ref, `v${manifest.version}`, 'source.ref 应钉到 v<version> tag');
  });

  /**
   * 引擎的 readMarkdownFrontmatter 只取 name/description 两键；缺 name 时命令名回落到文件名。
   * 显式写 name 才能让「命令名」与「文件名」解耦——重命名文件不会悄悄改掉用户打的命令。
   */
  it('每个 command 都显式声明 name 且与文件名一致', () => {
    for (const file of fs.readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md'))) {
      const fm = parseFrontmatter(readText(path.join(COMMANDS_DIR, file)));
      const stem = file.replace(/\.md$/, '');
      assert.equal(typeof fm?.name, 'string', `${file}: 缺 frontmatter name`);
      assert.equal(fm.name, stem, `${file}: name(${fm.name}) 与文件名不一致`);
    }
  });

  it('.gitignore 忽略 .omz/（B14）', () => {
    const lines = readText(path.join(ROOT, '.gitignore')).split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.some((l) => ['.omz/', '.omz', '/.omz/', '/.omz'].includes(l)), '.gitignore 未忽略 .omz/');
  });
});

describe('全仓库编码卫生（B4）', () => {
  it('所有 .md / .json / .mjs 文件的首字节都不是 BOM', () => {
    const files = walk(ROOT, ['.md', '.json', '.mjs']);
    assert.ok(files.length > 30, `扫描到的文件数异常偏少：${files.length}`);
    const withBom = files.filter((f) => {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(3);
      fs.readSync(fd, buf, 0, 3, 0);
      fs.closeSync(fd);
      return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    });
    assert.deepEqual(
      withBom.map((f) => path.relative(ROOT, f).split(path.sep).join('/')),
      [],
      '这些文件带 BOM（B4）'
    );
  });

  it('所有 .json 文件都是可解析的合法 JSON', () => {
    const bad = [];
    for (const f of walk(ROOT, ['.json'])) {
      try {
        JSON.parse(readText(f));
      } catch (err) {
        bad.push(`${path.relative(ROOT, f)}: ${err.message}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe('上游来源锁定（I6 供应链取证）', () => {
  it('仓库的 lock 文件字段完整（未 pin 的 commit 只给 WARN，不是 ERROR）', () => {
    const { ok, lock, errors, warnings } = loadLock(ROOT);
    assert.deepEqual(errors, [], `lock 校验有错误：\n${errors.join('\n')}`);
    assert.equal(ok, true);
    assert.equal(lock.source, 'code-yeongyu/oh-my-openagent');
    assert.ok(Array.isArray(lock.ported_paths) && lock.ported_paths.length > 0);
    // commit 为 null 是诚实的未 pin 状态：必须有 commit_status 说明并产生 WARN
    assert.equal(lock.commit, null);
    assert.equal(typeof lock.commit_status, 'string');
    assert.ok(warnings.some((w) => /commit 未 pin/.test(w)), 'commit 未 pin 应给 WARN');
  });

  it('lock 里每个 omz_target 在仓库中真实存在且用正斜杠（B3）', () => {
    const { lock } = loadLock(ROOT);
    assert.deepEqual(checkTargets(ROOT, lock), [], 'lock 声明的 omz_target 有缺失');
    for (const p of lock.ported_paths) {
      assert.equal(p.omz_target.includes('\\'), false, `${p.omz_target} 应用正斜杠`);
      assert.ok(['ported', 'adapted', 'pending'].includes(p.port_status), `${p.omz_target} 的 port_status 非法`);
    }
  });

  it('planSync 只生成待人工执行的命令清单，且明确禁止 git merge upstream', () => {
    const { lock } = loadLock(ROOT);
    const cmds = planSync(lock, { remoteExists: false });
    assert.ok(cmds.includes('git fetch upstream'));
    assert.ok(cmds.some((c) => c.startsWith('git remote add upstream ')));
    assert.ok(cmds.some((c) => /禁止 git merge/.test(c)), '必须显式声明禁止 merge（§16.3）');
    // commit 未 pin 时应提示先取 SHA 再 diff，而不是直接给出无基线的 diff
    assert.ok(cmds.some((c) => /--pin/.test(c)));
    assert.ok(cmds.some((c) => /<pin 后的 SHA>/.test(c)));
    assert.equal(cmds.some((c) => /^git merge/.test(c)), false, '清单里不得出现 git merge');
  });

  it('缺必填字段或 port_status 非法的 lock 被判 ERROR', () => {
    const dir = path.join(TMP, 'bad-lock', 'upstream');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'omo-sources.lock.json'),
      JSON.stringify({ source: 'x', url: 'u', branch: 'dev', ported_paths: [{ path: 'a', omz_target: 'b', port_status: 'bogus' }] }) + '\n',
      'utf8'
    );
    const { ok, errors } = loadLock(path.join(TMP, 'bad-lock'));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /port_status 非法值/.test(e)));
    assert.ok(errors.some((e) => /'commit'/.test(e)));
    assert.ok(errors.some((e) => /'synced_at'/.test(e)));
  });

  it('lock 文件不存在时给出明确错误而非抛异常', () => {
    const dir = path.join(TMP, 'no-lock');
    fs.mkdirSync(dir, { recursive: true });
    let r;
    assert.doesNotThrow(() => {
      r = loadLock(dir);
    });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /文件不存在/);
  });

  it('updateLock 只接受 40 位小写 hex SHA，并写出无 BOM、LF 结尾的文件', () => {
    const dir = path.join(TMP, 'pin');
    fs.mkdirSync(path.join(dir, 'upstream'), { recursive: true });
    const lockFile = path.join(dir, 'upstream', 'omo-sources.lock.json');
    fs.copyFileSync(path.join(ROOT, 'upstream', 'omo-sources.lock.json'), lockFile);

    assert.throws(() => updateLock(dir, { commit: 'not-a-sha' }), /40 位小写 hex/);

    const sha = 'a'.repeat(40);
    const updated = updateLock(dir, { commit: sha, synced_at: '2025-01-01T00:00:00.000Z', notes: `pin ${sha}` });
    assert.equal(updated.commit, sha);
    assert.match(updated.commit_status, /pinned/);
    assert.equal(updated.synced_at_status, 'synced');
    assert.ok(updated.notes.includes(`pin ${sha}`));

    const buf = fs.readFileSync(lockFile);
    assert.notEqual(buf[0], 0xef);
    assert.equal(buf.includes(0x0d), false);
    assert.equal(buf.subarray(-1)[0], 0x0a);

    // pin 之后再校验：commit 已是合法 SHA，不再有未 pin 的 WARN
    const after = loadLock(dir);
    assert.deepEqual(after.errors, []);
    assert.equal(after.warnings.some((w) => /commit 未 pin/.test(w)), false);
  });

  it('仓库的 lock 文件在本轮测试后内容未被改动（测试只读仓库）', () => {
    const { lock } = loadLock(ROOT);
    assert.equal(lock.commit, null, '仓库 lock 的 commit 应仍是未 pin 状态');
    assert.equal(lock.synced_at, null);
  });
});
