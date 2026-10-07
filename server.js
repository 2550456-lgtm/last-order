#!/usr/bin/env node
/**
 * Hackathon 组队雷达 —— 零依赖服务端
 * ---------------------------------------------------------------
 * 只用 Node 内置模块（http / fs / path / os / crypto），不需要 npm install。
 * 职责：
 *   1. 托管 public/ 下的静态页面
 *   2. 维护「匹配池 + 配对记录」，匹配算法复用 public/lib/match.js
 *   3. 通过 SSE 把状态实时推给所有屏幕（手机和大屏看到的永远一致）
 *   4. 落盘到 data/state.json，重启不丢人
 *
 * 启动：node server.js        环境变量：PORT（默认 8788）、HOST（默认 0.0.0.0）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const M = require('./public/lib/match.js');

const ROOT = __dirname;

// Windows 的传统 cmd 窗口默认代码页是 936(GBK)，而 Node 往终端写的是 UTF-8，
// 结果启动横幅里的中文全变乱码 —— 偏偏「手机该打开哪个地址」就印在那几行里。
// 有终端时自动切到 65001。重定向到文件时不切（文件本来就该是 UTF-8）。
if (process.platform === 'win32' && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
  } catch (_) { /* 切不了不影响服务本身 */ }
}

const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录可用环境变量覆盖：方便一台机器上开多个「房间」，也方便测试跑在临时目录
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 64 * 1024;
// node server.js --open（或 OPEN=1）：起好之后自动打开浏览器，给双击启动的 .bat 用
const OPEN_BROWSER = process.argv.indexOf('--open') >= 0 || process.env.OPEN === '1';

// 真正在用的端口。8788 被占用时会自动往后找，所以内部一律用这个而不是常量 PORT。
let activePort = PORT;

const DEFAULT_SETTINGS = {
  event: '黑客松现场',
  durationSec: 300,   // 5 分钟
  mode: 'smart',
  count: 1
};

/* ------------------------------------------------------------------ 状态 */

let state = {
  participants: [],
  pairs: [],
  byeId: null,
  round: 1,
  lastMatchAt: null,
  settings: Object.assign({}, DEFAULT_SETTINGS)
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state.participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    state.pairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
    state.byeId = parsed.byeId || null;
    state.round = Number(parsed.round) || 1;
    state.lastMatchAt = parsed.lastMatchAt || null;
    state.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
    console.log('[data] 已载入 ' + state.participants.length + ' 位参与者 / ' + state.pairs.length + ' 条配对记录');
  } catch (e) {
    // 文件坏了不能让服务起不来：备份一份再空跑
    console.warn('[data] state.json 解析失败，已忽略：' + e.message);
    try { fs.renameSync(STATE_FILE, STATE_FILE + '.broken-' + Date.now()); } catch (_) {}
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_FILE); // 原子替换，避免写一半断电留下坏文件
    } catch (e) {
      console.error('[data] 落盘失败：' + e.message);
    }
  }, 250);
}

/* ------------------------------------------------------------- 对外快照 */

function history() {
  return state.pairs.map(p => ({ a: p.aId, b: p.bId }));
}

function snapshot() {
  // 只把还活着的配对设为 active，其余按状态返回，前端据此渲染
  const now = Date.now();
  const all = state.pairs;
  const active = all.filter(p => p.status === 'active');
  // 历史配对可能攒到几百条，每次推送都带上会把 SSE 撑胖；界面只看最近几条，
  // 所以对外只给「进行中 + 最近 40 条已结束」，完整记录仍在 data/state.json 里。
  const finished = all.filter(p => p.status !== 'active').slice(-40);
  const visible = active.concat(finished);
  return {
    now,
    round: state.round,
    byeId: state.byeId,
    lastMatchAt: state.lastMatchAt,
    settings: state.settings,
    participants: state.participants,
    // 大屏要显示「手机该打开哪个地址」：主持人多半是用 localhost 打开的，
    // 直接把局域网 IP 一起给前端，省得现场临时查 ipconfig
    net: { port: activePort, addresses: lanAddresses() },
    pairs: visible.map(p => Object.assign({}, p, {
      remainingMs: p.status === 'active' ? Math.max(0, p.endsAt - now) : 0
    })),
    stats: {
      people: state.participants.length,
      rounds: state.round,
      activePairs: active.length,
      totalPairs: all.length,
      matchedPeople: new Set(all.flatMap(p => [p.aId, p.bId])).size
    }
  };
}

/* ------------------------------------------------------------------ SSE */

const clients = new Set();

function broadcast(event, payload) {
  const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of clients) {
    try { res.write(chunk); } catch (_) { clients.delete(res); }
  }
}

function pushState() {
  broadcast('state', snapshot());
}

setInterval(() => {
  // 心跳，顺便让大屏的倒计时有机会重新校准
  for (const res of clients) {
    try { res.write(': ping ' + Date.now() + '\n\n'); } catch (_) { clients.delete(res); }
  }
}, 25000).unref();

/* ------------------------------------------------------------- HTTP 工具 */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 目录穿越防护：解析后必须仍在 public 内
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('403');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      // 没有后缀的路径（哈希路由刷新）回落到首页
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // 图片可以长缓存（文件名不变时内容也不会变），页面和脚本保持不缓存
    const cache = /\.(png|jpg|jpeg|svg|ico|webp)$/.test(ext)
      ? 'public, max-age=86400' : 'no-cache';

    // index.html 里 og:image / og:url 需要绝对地址，微信之类的爬虫不会执行 JS，
    // 所以在这里按请求实际用的 Host 替换掉占位符 —— 换成局域网 IP 或域名都不用改代码。
    if (ext === '.html') {
      fs.readFile(target, 'utf8', (e2, html) => {
        if (e2) { res.writeHead(500).end('500'); return; }
        const host = req.headers.host || ('localhost:' + activePort);
        const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const origin = proto + '://' + host;
        const body = Buffer.from(html.split('__ORIGIN__').join(origin), 'utf8');
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': cache,
          'Content-Length': body.length
        });
        res.end(body);
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': st.size });
    fs.createReadStream(target).pipe(res);
  });
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

/* --------------------------------------------------------------- 业务逻辑 */

function upsertParticipant(input) {
  const nowIso = new Date().toISOString();
  const clean = M.normalizeProfile(input, nowIso);
  const errs = M.validate(clean);
  if (errs.length) return { error: errs.join('；') };

  let existing = null;
  if (clean.id) existing = state.participants.find(p => p.id === clean.id);
  if (!existing && clean.contact) {
    // 同名 + 同联系方式的重复提交，视为同一个人（现场很常见：刷新页面又填了一次）。
    // 只在填了联系方式时合并 —— 否则两个都叫「张伟」且都没填联系方式的人会被错误地并成一个。
    existing = state.participants.find(p =>
      p.name === clean.name && (p.contact || '') === clean.contact);
  }
  if (existing) {
    Object.assign(existing, clean, { id: existing.id, joinedAt: existing.joinedAt, updatedAt: nowIso });
    saveState(); pushState();
    return { participant: existing, created: false };
  }
  const person = Object.assign(clean, { id: clean.id || newId('p'), updatedAt: nowIso });
  state.participants.push(person);
  saveState(); pushState();
  return { participant: person, created: true };
}

function createMatch(body) {
  const mode = M.MODES.some(m => m.id === body.mode) ? body.mode : state.settings.mode;
  const count = Math.max(1, Math.min(12, parseInt(body.count, 10) || state.settings.count));
  const durationSec = Math.max(60, Math.min(3600, parseInt(body.durationSec, 10) || state.settings.durationSec));
  state.settings = Object.assign(state.settings, { mode, count, durationSec });

  // 已经在进行中的配对，本轮不再参与，避免一个人被安排两次
  const busy = new Set();
  state.pairs.forEach(p => { if (p.status === 'active') { busy.add(p.aId); busy.add(p.bId); } });
  const pool = state.participants.filter(p => !busy.has(p.id));

  if (pool.length < 2) {
    return { error: busy.size ? '所有人都已经在交流中了，先结束上一轮' : '匹配池不足 2 人，先去登记名片' };
  }

  const plan = M.planMatches(pool, { mode, count, history: history() });
  if (!plan.pairs.length) return { error: '没有可配对的人' };

  const now = Date.now();
  const created = plan.pairs.map(pr => ({
    id: newId('m'),
    aId: pr.a.id,
    bId: pr.b.id,
    score: pr.score,
    dims: pr.dims,
    max: pr.max,
    reasons: pr.reasons,
    topics: pr.topics,
    mode,
    durationSec,
    extendedSec: 0,
    createdAt: now,
    endsAt: now + durationSec * 1000,
    status: 'active'
  }));
  state.pairs = state.pairs.concat(created);
  state.byeId = plan.bye ? plan.bye.id : null;
  state.round += 1;
  state.lastMatchAt = new Date(now).toISOString();

  saveState(); pushState();
  return { pairs: created, bye: plan.bye || null, round: state.round };
}

function pairAction(id, action, minutes) {
  const pair = state.pairs.find(p => p.id === id);
  if (!pair) return { error: '找不到这条配对' };
  if (action === 'extend') {
    const add = Math.max(1, Math.min(30, Number(minutes) || 2)) * 60 * 1000;
    pair.endsAt += add;
    pair.extendedSec += add / 1000;
    pair.status = 'active';
  } else if (action === 'finish') {
    pair.status = 'done';
    pair.finishedAt = Date.now();
  } else if (action === 'cancel') {
    pair.status = 'cancelled';
    pair.finishedAt = Date.now();
  } else {
    return { error: '未知操作：' + action };
  }
  saveState(); pushState();
  return { pair };
}

function reset(what) {
  if (what === 'all') {
    state.participants = [];
    state.pairs = [];
    state.byeId = null;
    state.lastMatchAt = null;
  } else {
    // 「清空配对记录」按字面执行：连进行中的一起清掉（想保留就先「结束全部」）
    state.pairs = [];
    state.byeId = null;
  }
  state.round = 1;
  saveState(); pushState();
  return { ok: true };
}

/* ------------------------------------------------------------ 路由与服务 */

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const urlPath = url.split('?')[0];
  const method = req.method || 'GET';

  if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

  try {
    if (method === 'GET' && urlPath === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime(), version: '1.0.0' });
    }

    if (method === 'GET' && urlPath === '/api/state') {
      return sendJson(res, 200, snapshot());
    }

    if (method === 'GET' && urlPath === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      res.write('event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }

    if (method === 'GET' && urlPath.startsWith('/api/match/preview')) {
      // 只算分不落库：用于匹配池列表里实时显示「和我的匹配度」
      const me = new URL(url, 'http://x').searchParams.get('id');
      const src = state.participants.find(p => p.id === me);
      if (!src) return sendJson(res, 404, { error: '找不到这位参与者' });
      const scored = state.participants
        .filter(p => p.id !== src.id)
        .map(p => {
          const d = M.pairDetail(src, p, history());
          return { id: p.id, score: d.score, reasons: d.reasons };
        })
        .sort((x, y) => y.score - x.score);
      return sendJson(res, 200, { me: src.id, scored });
    }

    const body = (method === 'POST' || method === 'PATCH' || method === 'PUT')
      ? await readBody(req) : {};

    if (method === 'POST' && urlPath === '/api/participants') {
      const r = upsertParticipant(body);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, r.created ? 201 : 200, r);
    }

    let m;
    if ((m = urlPath.match(/^\/api\/participants\/([\w-]+)$/)) && method === 'DELETE') {
      const before = state.participants.length;
      state.participants = state.participants.filter(p => p.id !== m[1]);
      state.pairs = state.pairs.filter(p => p.aId !== m[1] && p.bId !== m[1]);
      if (state.byeId === m[1]) state.byeId = null;
      if (state.participants.length === before) return sendJson(res, 404, { error: '找不到这个人' });
      saveState(); pushState();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && urlPath === '/api/match') {
      const r = createMatch(body);
      if (r.error) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 200, r);
    }

    if ((m = urlPath.match(/^\/api\/pairs\/([\w-]+)$/)) && method === 'POST') {
      const r = pairAction(m[1], body.action, body.minutes);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
    }

    if (method === 'POST' && urlPath === '/api/settings') {
      state.settings = Object.assign(state.settings, {
        event: String(body.event || state.settings.event).slice(0, 32),
        durationSec: Math.max(60, Math.min(3600, parseInt(body.durationSec, 10) || state.settings.durationSec)),
        mode: M.MODES.some(x => x.id === body.mode) ? body.mode : state.settings.mode,
        count: Math.max(1, Math.min(12, parseInt(body.count, 10) || state.settings.count))
      });
      saveState(); pushState();
      return sendJson(res, 200, { settings: state.settings });
    }

    if (method === 'POST' && urlPath === '/api/reset') {
      return sendJson(res, 200, reset(body.what));
    }

    return sendJson(res, 404, { error: '没有这个接口：' + method + ' ' + urlPath });
  } catch (e) {
    return sendJson(res, 400, { error: e.message || '请求处理失败' });
  }
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 启动 */

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const { spawn } = require('child_process');
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* 打不开就算了，地址已经印在下面了 */ }
}

function banner() {
  const lines = [
    '',
    '  Hackathon 组队雷达 已启动',
    '  ─────────────────────────────────────────────',
    '  本机访问 : http://localhost:' + activePort + '/',
    ...lanAddresses().map(ip => '  手机访问 : http://' + ip + ':' + activePort + '/   (同一 WiFi 下)'),
    '  大屏模式 : http://localhost:' + activePort + '/#/screen',
    '  数据文件 : ' + STATE_FILE,
    '',
    '  按 Ctrl+C 停止。数据会自动存盘。',
    ''
  ];
  console.log(lines.join('\n'));
}

/**
 * 监听端口，被占用就自动往后找。
 * 现场经常出现「上一个窗口没关掉」或者别的程序占了 8788，
 * 原来这种情况会直接抛 EADDRINUSE 一长串栈，看起来像程序坏了。
 */
function listen(port, attemptsLeft) {
  attemptsLeft = attemptsLeft === undefined ? 5 : attemptsLeft;

  // 每次尝试前先清掉上一轮挂上的回调。
  // 踩过的坑：EADDRINUSE 时 'listening' 从来没触发过，它的回调会一直留着，
  // 等下一次监听成功时两个回调一起执行 —— 表现为横幅打印两遍，
  // 而且第一遍里的端口号是错的（旧闭包里的 port）。
  server.removeAllListeners('listening');
  server.removeAllListeners('error');

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      console.log('  端口 ' + port + ' 已被占用，改用 ' + (port + 1) + ' …');
      activePort = port + 1;
      setTimeout(() => listen(port + 1, attemptsLeft - 1), 120);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error('\n  端口 ' + port + ' 起不来：连续试了 5 个端口都被占用。');
      console.error('  关掉多余的窗口，或者指定一个别的端口：PORT=9000 node server.js\n');
    } else if (err.code === 'EACCES') {
      console.error('\n  没有权限监听端口 ' + port + '。换一个 1024 以上的端口试试：PORT=9000 node server.js\n');
    } else {
      console.error('\n  启动失败：' + err.message + '\n');
    }
    process.exit(1);
  });

  server.once('listening', () => {
    activePort = port;
    banner();
    if (OPEN_BROWSER) openBrowser('http://localhost:' + activePort + '/');
    // 起好之后换个常驻的错误处理：宁可打日志也不要让服务在活动中途直接崩掉
    server.on('error', (err) => console.error('  [服务端错误] ' + err.message));
  });

  server.listen(port, HOST);
}

loadState();
listen(PORT);

process.on('SIGINT', () => {
  console.log('\n正在退出，写入数据…');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
  process.exit(0);
});
