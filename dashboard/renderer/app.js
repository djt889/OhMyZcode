/**
 * OMZ dashboard renderer（原生 JS，无框架、无第三方依赖）。
 *
 * I5 防注入硬约束：
 *   - 一切来自服务端的字符串只经 textContent / document.createTextNode 落地。
 *     本文件不调用任何以 HTML 字符串建 DOM 的接口（grep 该类接口名应无匹配）；
 *     结构一律用 createElement 组装，因此 <script>、on* 属性、标签片段都只会显示为字面文本。
 *   - ANSI 转义序列（ESC[...m 等）在渲染前剥离：终端着色码不该出现在 DOM 里。
 *   - 超长字符串截断到 MAX_LEN 并标注截断量，配合 CSS 的 table-layout: fixed +
 *     overflow-wrap: anywhere，保证单个恶意长 title 无法撑破布局。
 *
 * token 取舍：EventSource 不支持自定义请求头，所以 SSE 的 token 只能走 query（?token=）。
 * 这在 loopback-only + 随机端口 + 每次启动重生成 token 的前提下可接受：token 不落磁盘、
 * 不进 stdout（服务端只打到 stderr），且 Referrer-Policy: no-referrer 阻止 URL 外泄。
 * 普通 fetch 仍走 Authorization: Bearer，不把 token 放进请求行。
 */
'use strict';

var MAX_LEN = 2000;
// ANSI/CSI/OSC 控制序列；\u001b 是 ESC。也顺带清掉裸控制字符（除 \n \t）。
var ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
var CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * 状态白名单（**唯一定义处**，新增状态只改这里 + app.css 的 [data-state=...] 配色）。
 *
 * 它必须同时覆盖两个数据源的取值域，否则未知取值会退化成紫色 unknown 药丸，
 * 把有明确语义的状态误显示为「不可判定」：
 *   · coordinator（SQLite tasks.status，7 态）：blocked | ready | running | done | failed | dead | unknown
 *   · 文件视图回退（tools/render-status.mjs → server.mjs 的 parseFileView）：
 *       pending —— DESIGN §7.3 四态之一（待执行），coordinator 侧 blocked/ready 都投影为它；
 *       corrupt —— 任务 JSON 解析失败的**数据损坏信号**，必须与 unknown 区分开：
 *                  unknown 是「状态不可判定」，corrupt 是「文件读不出来」，运维动作完全不同。
 * 同步纪律：coordinator 的枚举定义见 mcp/coordinator/schema.sql 的 tasks.status 注释。
 */
var STATES = [
  // coordinator 7 态
  'ready', 'running', 'done', 'failed', 'dead', 'blocked', 'unknown',
  // 文件视图附加 2 态
  'pending', 'corrupt'
];

function token() {
  try {
    return new URLSearchParams(location.search).get('token') || '';
  } catch (e) {
    return '';
  }
}

/** 剥 ANSI + 控制字符 + 超长截断。所有进入 DOM 的服务端字符串必须先过这里。 */
function clean(value) {
  if (value === null || value === undefined) return '—';
  var s = typeof value === 'string' ? value : String(value);
  s = s.replace(ANSI_RE, '').replace(CTRL_RE, '');
  if (s.length > MAX_LEN) {
    var cut = s.length - MAX_LEN;
    return s.slice(0, MAX_LEN) + '…(截断 ' + cut + ' 字符)';
  }
  return s === '' ? '—' : s;
}

function el(tag, cls) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** 纯文本单元格：唯一的文本落地路径，全部经 clean() + createTextNode。 */
function td(text, cls) {
  var c = el('td', cls);
  c.appendChild(document.createTextNode(clean(text)));
  return c;
}

/** 状态单元格：文本仍是 textContent，颜色只由 data-state 属性驱动（不拼样式字符串）。 */
function stateTd(value) {
  var c = el('td', 'state');
  var raw = value === null || value === undefined ? '' : String(value);
  var pill = el('span', 'pill');
  pill.setAttribute('data-state', STATES.indexOf(raw) >= 0 ? raw : 'unknown');
  pill.appendChild(document.createTextNode(raw === '' ? '—' : clean(raw)));
  c.appendChild(pill);
  return c;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setText(id, text) {
  var n = document.getElementById(id);
  if (n) {
    clear(n);
    n.appendChild(document.createTextNode(clean(text)));
  }
}

function tsText(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '—';
  try {
    return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  } catch (e) {
    return String(sec);
  }
}

function renderTeams(teams) {
  var strip = document.getElementById('teams-strip');
  clear(strip);
  (teams || []).forEach(function (t) {
    var box = el('div', 'team-card');
    var head = el('div', 'team-name');
    head.appendChild(document.createTextNode(clean(t.name || t.id)));
    box.appendChild(head);

    var sub = el('div', 'team-sub');
    sub.appendChild(document.createTextNode(clean(t.id) + ' · status=' + clean(t.status) +
      ' · max_parallel=' + clean(t.max_parallel)));
    box.appendChild(sub);

    var counts = el('div', 'team-counts');
    var c = t.counts || {};
    Object.keys(c).forEach(function (k) {
      var pill = el('span', 'pill');
      pill.setAttribute('data-state', STATES.indexOf(k) >= 0 ? k : 'unknown');
      pill.appendChild(document.createTextNode(clean(k) + ' ' + clean(c[k])));
      counts.appendChild(pill);
    });
    box.appendChild(counts);
    strip.appendChild(box);
  });
}

function renderTasks(tasks) {
  var body = document.getElementById('tasks-body');
  clear(body);
  var list = tasks || [];
  setText('tasks-count', list.length);
  list.forEach(function (t) {
    var tr = el('tr');
    tr.appendChild(td(t.team_id, 'mono dim'));
    tr.appendChild(td(t.wave, 'mono'));
    tr.appendChild(td(t.key, 'mono'));
    tr.appendChild(td(t.title, 'wrap'));
    // I3：两列各自独立，null 显示 —，不由另一维度推断。
    tr.appendChild(stateTd(t.transport_state));
    tr.appendChild(stateTd(t.coordinator_state));
    tr.appendChild(td(t.owner_agent, 'mono dim'));
    tr.appendChild(td(t.attempts, 'mono num'));
    body.appendChild(tr);
  });
}

function renderAgents(agents) {
  var body = document.getElementById('agents-body');
  clear(body);
  var list = agents || [];
  setText('agents-count', list.length);
  list.forEach(function (a) {
    var tr = el('tr');
    tr.appendChild(td(a.team_id, 'mono dim'));
    tr.appendChild(td(a.agent_ref, 'mono'));
    tr.appendChild(td(a.role, 'mono'));
    tr.appendChild(stateTd(a.transport_state));
    tr.appendChild(td(a.resume_ref, 'wrap dim'));
    tr.appendChild(td(tsText(a.last_seen), 'mono dim'));
    body.appendChild(tr);
  });
}

function renderMailbox(mailbox) {
  var mb = mailbox || { pending: 0, by_agent: {} };
  setText('mail-pending', mb.pending || 0);
  var body = document.getElementById('mail-body');
  clear(body);
  var byAgent = mb.by_agent || {};
  var keys = Object.keys(byAgent);
  if (keys.length === 0) {
    var tr0 = el('tr');
    var c0 = td('（无未 ack 消息）', 'dim');
    c0.colSpan = 2;
    tr0.appendChild(c0);
    body.appendChild(tr0);
    return;
  }
  keys.forEach(function (k) {
    var tr = el('tr');
    tr.appendChild(td(k, 'mono'));
    tr.appendChild(td(byAgent[k], 'mono num'));
    body.appendChild(tr);
  });
}

function renderEvents(events) {
  var list = document.getElementById('events-list');
  clear(list);
  var rows = events || [];
  setText('events-count', rows.length);
  rows.forEach(function (e) {
    var li = el('li', 'event');
    var head = el('span', 'event-head');
    head.appendChild(document.createTextNode(
      '#' + clean(e.id) + ' ' + tsText(e.created_at) + ' [' + clean(e.kind) + ']'
    ));
    li.appendChild(head);
    var tail = el('span', 'event-tail');
    var parts = [];
    if (e.team_id) parts.push('team=' + e.team_id);
    if (e.task_id !== null && e.task_id !== undefined) parts.push('task=' + e.task_id);
    if (e.agent_ref) parts.push('agent=' + e.agent_ref);
    if (e.detail !== null && e.detail !== undefined) {
      var d;
      try {
        d = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
      } catch (err) {
        d = '[detail 无法序列化]';
      }
      parts.push(d);
    }
    tail.appendChild(document.createTextNode(clean(parts.join(' · '))));
    li.appendChild(tail);
    list.appendChild(li);
  });
}

function renderDegrade(degraded) {
  var box = document.getElementById('degrade-box');
  var list = document.getElementById('degrade-list');
  clear(list);
  var rows = degraded || [];
  box.hidden = rows.length === 0;
  rows.forEach(function (d) {
    var li = el('li');
    li.appendChild(document.createTextNode(
      clean(d.component) + '：' + clean(d.reason) + ' → 回退 ' + clean(d.fallback)
    ));
    list.appendChild(li);
  });
}

function renderNotes(notes) {
  var panel = document.getElementById('notes-panel');
  var box = document.getElementById('notes-box');
  var rows = notes || [];
  panel.hidden = rows.length === 0;
  clear(box);
  if (rows.length) box.appendChild(document.createTextNode(clean(rows.join('\n'))));
}

function renderSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  var badge = document.getElementById('source-badge');
  var src = snap.source === 'coordinator' ? 'coordinator' : snap.source === 'files' ? 'files' : 'unknown';
  badge.setAttribute('data-source', src);
  clear(badge);
  badge.appendChild(document.createTextNode(
    '数据源 ' + src + (src === 'coordinator' ? '（SQLite）' : src === 'files' ? '（.omz/ 回退）' : '')
  ));
  setText('generated-at', snap.generated_at || '—');
  renderDegrade(snap.degraded);
  renderTeams(snap.teams);
  renderTasks(snap.tasks);
  renderAgents(snap.agents);
  renderMailbox(snap.mailbox);
  renderEvents(snap.events);
  renderNotes(snap.notes);
}

function setConn(state, text) {
  var badge = document.getElementById('conn-badge');
  badge.setAttribute('data-conn', state);
  clear(badge);
  badge.appendChild(document.createTextNode('连接 ' + text));
}

/**
 * 首屏：fetch 全量快照（token 走 Authorization 头，不进 URL）。
 * 返回 { ok: true } 或 { ok: false, status } —— status 供调用方判断是否值得重连。
 */
function bootstrap() {
  var t = token();
  var headers = t ? { Authorization: 'Bearer ' + t } : {};
  setConn('init', '加载中…');
  return fetch('/api/snapshot', { headers: headers, cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    })
    .then(function (snap) {
      renderSnapshot(snap);
      setConn('ok', '快照已加载');
      return { ok: true };
    })
    .catch(function (err) {
      var status = err && typeof err.status === 'number' ? err.status : 0;
      setConn('down', '快照失败 ' + clean(err && err.message));
      return { ok: false, status: status };
    });
}

/** 凭据无效时的终态提示：不重连，明确告诉用户去哪儿拿正确 URL。 */
function showAuthFailure(status) {
  setConn('down', '凭据无效（HTTP ' + status + '）');
  var box = document.getElementById('degrade-box');
  var list = document.getElementById('degrade-list');
  if (!box || !list) return;
  clear(list);
  var li = document.createElement('li');
  li.appendChild(document.createTextNode(
    '凭据无效（HTTP ' + status + '）——请使用启动时 stderr 打印的 URL（含 token）访问本页面。' +
    ' token 每次启动重新生成，旧链接会失效；已停止自动重连以免无效重试。'
  ));
  list.appendChild(li);
  box.hidden = false;
}

/**
 * SSE：EventSource 无法带自定义头，故 token 只能进 query（见文件头取舍说明）。
 * 断线重连由 EventSource 原生负责（服务端已下发 retry: 2000），此处只更新连接状态显示。
 */
function connect() {
  var t = token();
  var url = '/api/events' + (t ? '?token=' + encodeURIComponent(t) : '');
  var es;
  try {
    es = new EventSource(url);
  } catch (e) {
    setConn('down', 'SSE 不可用');
    return null;
  }
  es.addEventListener('open', function () {
    setConn('live', 'SSE 已连接');
  });
  es.addEventListener('snapshot', function (ev) {
    try {
      renderSnapshot(JSON.parse(ev.data));
      setConn('live', 'SSE 已连接');
    } catch (e) {
      setConn('warn', '快照解析失败');
    }
  });
  es.addEventListener('heartbeat', function () {
    setConn('live', 'SSE 心跳');
  });
  es.addEventListener('error', function () {
    // readyState 0 = 正在重连；2 = 已关闭。
    setConn(es.readyState === 2 ? 'down' : 'retry', es.readyState === 2 ? 'SSE 已关闭' : 'SSE 重连中…');
  });
  return es;
}

/**
 * 启动序列。首屏 401/403 = 凭据问题：EventSource 用同一个 token 也必然失败，
 * 而它会按 retry 无限重连（每次都 401），既刷屏也无意义 → 直接给出终态提示，不 connect。
 * 其它失败（网络抖动、500、服务重启中）保留 SSE 重连能力。
 */
bootstrap().then(function (r) {
  if (r && r.ok === false && (r.status === 401 || r.status === 403)) {
    showAuthFailure(r.status);
    return null;
  }
  return connect();
});
