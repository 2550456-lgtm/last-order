#!/usr/bin/env node
/**
 * 真实浏览器 UI 验收：node scripts/ui-check.js
 * ---------------------------------------------------------------
 * 前面 test/smoke.js 测的是接口，测不到「页面点下去有没有反应」。
 * 这个脚本用 Chrome DevTools Protocol 驱动一个真的浏览器（无头 Edge/Chrome），
 * 把关键交互逐个点一遍，并且断言点击之后 DOM 真的变了。
 *
 * 为什么不用 puppeteer：本项目的硬约束是零依赖。Node 22 自带全局 WebSocket，
 * 直接连 CDP 就够了，两百行以内解决。
 *
 * 它会自己起一个隔离的服务端（独立端口 + 临时数据目录），不碰你正在用的那份数据。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PORT = Number(process.env.UI_APP_PORT || 8898);
const CDP_PORT = Number(process.env.UI_CDP_PORT || 9333);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const SHOT_DIR = path.join(__dirname, '..', 'shots');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hackathon-ui-data-'));
const UDD = fs.mkdtempSync(path.join(os.tmpdir(), 'hackathon-ui-profile-'));

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + label); }
  else { failed++; console.log('  \u2717 ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- 找浏览器 */
function findBrowser() {
  const cands = [
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome，可用 BROWSER_PATH 环境变量指定');
}

/* --------------------------------------------------------------- CDP */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;   // 当前操作哪个标签页（见 useSession / openTab）
    this.dialogHandler = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      // 没有 id 的是事件。confirm() 这种原生弹窗必须显式应答，
      // 否则页面会一直停在那儿等用户点确定（无头浏览器里就是卡死）。
      if (msg.method === 'Page.javascriptDialogOpening' && this.dialogHandler) {
        const p = this.dialogHandler(msg.params);
        if (p) p.catch(() => {});
        return;
      }
      if (msg.method === 'Target.attachedToTarget' && this.attachWaiter) {
        this.attachWaiter(msg.params);
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  /** 注册原生弹窗的应答方式；传 null 恢复成「一律取消」 */
  onDialog(handler) {
    this.dialogHandler = handler;
  }

  static async connect(port) {
    const deadline = Date.now() + 15000;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (e) { /* 浏览器还没起来 */ }
      await sleep(250);
    }
    if (!target) throw new Error('CDP 端口 15 秒内没就绪');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    const cdp = new CDP(ws);
    // 主标签页走的是「页面级」WebSocket，命令里不能带 sessionId；
    // openTab() 开的第二个标签页才需要 attach 拿到的 sessionId（实测过：
    // 页面级连接带上 targetId 当 sessionId 会被回 "Session with given id not found"）
    cdp.sessionId = null;
    return cdp;
  }

  send(method, params) {
    return this.sendTo(this.sessionId, method, params);
  }

  /** 指定会话（标签页）执行命令；sessionId 为 null 时是浏览器级命令 */
  sendTo(sessionId, method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 20000);
    });
  }

  useSession(sessionId) {
    const prev = this.sessionId;
    this.sessionId = sessionId;
    return prev;
  }

  /**
   * 再开一个标签页，等价于「现场第二台手机」。
   * initJs 会在页面加载前注入 —— localStorage 必须在这一刻写好，
   * 页面里第一行脚本就要读它（决定「我是谁」）。
   */
  async openTab(url, initJs) {
    const res = await this.sendTo(null, 'Target.createTarget', { url: 'about:blank' });
    const targetId = res.targetId;
    // attachToTarget 可能同步返回 sessionId，也可能只推一个 attachedToTarget 事件，
    // 两种都要接住（不同浏览器版本的取舍不一样）
    let attached = null;
    this.attachWaiter = (params) => { if (params.targetInfo.targetId === targetId) attached = params; };
    const att = await this.sendTo(null, 'Target.attachToTarget', { targetId: targetId, flatten: true })
      .catch(() => ({}));
    this.attachWaiter = null;
    const sessionId = att.sessionId || (attached && attached.sessionId);
    if (!sessionId) throw new Error('没能挂上第二个标签页');

    const prev = this.useSession(sessionId);
    await this.sendTo(sessionId, 'Page.enable');
    await this.sendTo(sessionId, 'Runtime.enable');
    if (initJs) await this.sendTo(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source: initJs });
    await this.sendTo(sessionId, 'Page.navigate', { url: url });
    return { targetId: targetId, sessionId: sessionId, prev: prev };
  }

  /** 在页面里求值，异常直接抛出来（不然断言会拿到 undefined 装死） */
  async js(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text) + '\n  表达式：' + expression);
    }
    return r.result.value;
  }

  /** 轮询等一个条件成立：页面是异步渲染的，固定 sleep 既慢又不可靠 */
  async waitFor(expression, label, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    for (;;) {
      let v = false;
      try { v = await this.js(expression); } catch (e) { v = false; }
      if (v) return true;
      if (Date.now() > deadline) throw new Error('等待超时：' + (label || expression));
      await sleep(120);
    }
  }

  /** 真出事的时候光看「超时」没用，把相关 DOM 和报错一起打出来 */
  async dump(expr) {
    try { return await this.js('JSON.stringify(' + expr + ')'); }
    catch (e) { return '（快照也失败了：' + e.message + '）'; }
  }

  async shot(file, fullPage) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: !!fullPage
    });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(r.data, 'base64'));
    return path.join(SHOT_DIR, file);
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

/* ------------------------------------------------------------- 准备数据 */
const SEED = [
  { name: '林可', avatar: 'avatar-01', tagline: '把动效做得让人想多点两下', skills: [{ name: '前端', level: 'pro' }, { name: 'JavaScript', level: 'pro' }], interests: ['独立游戏', '摄影'], lookingFor: ['UI 设计'], contact: 'wx: linke' },
  { name: '陈墨', avatar: 'avatar-02', tagline: '做界面也做海报', skills: [{ name: 'UI 设计', level: 'pro' }, { name: '前端', level: 'learn' }], interests: ['独立游戏', '咖啡'], lookingFor: ['前端'], contact: 'wx: chenmo' },
  { name: '赵一鸣', avatar: 'avatar-03', tagline: '把大模型塞进小场景', skills: [{ name: 'Python', level: 'pro' }, { name: '大模型应用', level: 'pro' }], interests: ['AI 应用', '开源'], lookingFor: ['前端'], contact: 'wx: zhaoym' },
  { name: '苏晴', avatar: 'avatar-04', tagline: '把想法砍到能做完', skills: [{ name: '产品经理', level: 'pro' }, { name: '数据分析', level: 'know' }], interests: ['创业', '读书'], lookingFor: ['后端'], contact: 'wx: suqing' },
  { name: '郑野', avatar: 'avatar-05', tagline: '焊过板子也写过驱动', skills: [{ name: '硬件/嵌入式', level: 'pro' }, { name: 'Python', level: 'know' }], interests: ['硬件折腾', '攀岩'], lookingFor: ['算法'], contact: 'wx: zhengye' },
  { name: '何嘉', avatar: 'avatar-06', tagline: '模型调得比人准一点', skills: [{ name: '算法', level: 'pro' }, { name: 'Python', level: 'pro' }], interests: ['AI 应用', '跑步'], lookingFor: ['硬件/嵌入式'], contact: 'wx: hejia' }
];

/* --------------------------------------- 纯静态服务器（模拟 GitHub Pages 那种托管）
   静态托管上没有 /api/*，访问会返回一个 404 的 HTML 页面。
   这里起一个只发静态文件的服务来复现这种情况，验证前端能识别出来并切到单机模式。 */
function startStaticServer(port, rootDir) {
  const http = require('http');
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json'
  };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.indexOf('/api/') === 0) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>404</title><h1>404 Not Found</h1>');
      return;
    }
    const file = path.join(rootDir, rel === '/' ? 'index.html' : rel);
    if (path.normalize(file).indexOf(path.normalize(rootDir)) !== 0 ||
      !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>404</title>');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

/* ----------------------------------------------------------------- 主流程 */
async function main() {
  const browserPath = findBrowser();
  console.log('Hackathon 组队雷达 · 真实浏览器 UI 验收');
  console.log('浏览器：' + browserPath);
  console.log('隔离服务端：' + BASE + '\n');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), DATA_DIR }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const STATIC_PORT = APP_PORT + 1;
  const STATIC_BASE = 'http://127.0.0.1:' + STATIC_PORT;
  let staticSrv = null;

  let browser = null, cdp = null;
  try {
    // 等服务端
    const deadline = Date.now() + 8000;
    for (;;) {
      try { if ((await (await fetch(BASE + '/api/health')).json()).ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error('服务端没起来');
      await sleep(200);
    }
    for (const p of SEED) {
      await fetch(BASE + '/api/participants', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
      });
    }

    browser = spawn(browserPath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + UDD,
      '--window-size=1440,1000', '--hide-scrollbars', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    const cdp = await CDP.connect(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('A. 名片页交互');
    await cdp.send('Page.navigate', { url: BASE + '/#/card' });
    await sleep(2500);

    // 先注入一个「像真人一样输入」的小工具：直接改 value 不会触发框架监听，必须补 input 事件。
    // input 和 textarea 的 value setter 在不同的原型上，取错了会报 Illegal invocation。
    await cdp.js(`window.__type = function (sel, val) {
      const el = document.querySelector(sel);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    }; 'ok'`);

    ok((await cdp.js('window.__hsErrors.length')) === 0,
      '页面加载零 JS 报错', await cdp.js('window.__hsErrors'));

    // 预设技能标签：点三下
    await cdp.js(`document.querySelectorAll('#preset-skills button')[0].click();
                  document.querySelectorAll('#preset-skills button')[1].click();
                  document.querySelectorAll('#preset-skills button')[2].click(); 'ok'`);
    await sleep(150);
    ok((await cdp.js(`document.querySelectorAll('#chips-skills .chip').length`)) === 3,
      '点 3 个预设技能 → 出现 3 个技能标签');

    await cdp.js(`document.querySelectorAll('#preset-interests button')[0].click();
                  document.querySelectorAll('#preset-interests button')[1].click(); 'ok'`);
    await sleep(150);
    ok((await cdp.js(`document.querySelectorAll('#chips-interests .chip').length`)) === 2,
      '点 2 个预设兴趣 → 出现 2 个兴趣标签');

    // 标签必须真的显示文字。技能存对象、兴趣存字符串，曾经因为取 item.name
    // 让兴趣标签渲染成「只有 × 的空胶囊」，而静态截图从来没拍到过这个状态。
    const intText = await cdp.js(`Array.from(document.querySelectorAll('#chips-interests .chip'))
      .map(c => c.textContent.replace('×','').trim())`);
    ok(intText.length === 2 && intText.every((t) => t.length > 0),
      '兴趣标签上真的有文字：' + JSON.stringify(intText));
    await cdp.js(`document.querySelectorAll('#preset-looking button')[0].click(); 'ok'`);
    await sleep(150);
    const lookText = await cdp.js(`Array.from(document.querySelectorAll('#chips-looking .chip'))
      .map(c => c.textContent.replace('×','').trim())`);
    ok(lookText.length === 1 && lookText[0].length > 0,
      '「我在找」标签上真的有文字：' + JSON.stringify(lookText));

    // 点 × 删除
    await cdp.js(`document.querySelectorAll('#chips-interests .chip .x')[0].click(); 'ok'`);
    await sleep(150);
    ok((await cdp.js(`document.querySelectorAll('#chips-interests .chip').length`)) === 1,
      '点 × 能删掉一个兴趣标签');
    await cdp.js(`document.querySelectorAll('#preset-interests button')[1].click(); 'ok'`);
    await sleep(150);

    // 点技能标签循环等级：会用 → 熟练 → 想学
    const lv0 = await cdp.js(`document.querySelector('#chips-skills .chip').dataset.level`);
    await cdp.js(`document.querySelector('#chips-skills .chip').click(); 'ok'`);
    await sleep(120);
    const lv1 = await cdp.js(`document.querySelector('#chips-skills .chip').dataset.level`);
    ok(lv0 !== lv1, '点技能标签会切换等级：' + lv0 + ' → ' + lv1);

    // 自选头像
    const avCount = await cdp.js(`document.querySelectorAll('#avatar-picker button[data-av]').length`);
    ok(avCount >= 11, '头像选择器渲染出「首字母 + 10 张头像」：' + avCount + ' 个');
    await cdp.js(`document.querySelectorAll('#avatar-picker button')[4].click(); 'ok'`);
    await sleep(400);
    const picked = await cdp.js(`(document.querySelector('#avatar-picker button.on img') || {}).src || ''`);
    ok(/avatar-0\d\.png$/.test(picked), '点第 4 张头像 → 选中态落到它身上：' + picked.split('/').pop());
    await cdp.js(`document.querySelector('#avatar-picker button.on').click(); 'ok'`);
    await sleep(200);
    ok((await cdp.js(`document.querySelectorAll('#avatar-picker button.on').length`)) === 1
      && (await cdp.js(`document.querySelector('#avatar-picker button.on').dataset.av`)) === '',
      '再点一次同一张 → 取消选择，回到「首字母」');
    await cdp.js(`document.querySelectorAll('#avatar-picker button')[3].click(); 'ok'`);
    await sleep(600);

    // 头像要真的画进 canvas：比较选头像前后导出图的长度
    const dataUrlLen = await cdp.js(`document.querySelector('#card-canvas').toDataURL('image/png').length`);
    ok(dataUrlLen > 20000, '名片 canvas 有实际内容（导出 PNG 的 base64 长度 ' + dataUrlLen + '）');

    // 填名字 + 一句话
    await cdp.js(`window.__type('#f-name', 'UI 验收机器人'); window.__type('#f-tagline', '用真实浏览器点出来的名片'); 'ok'`);
    await sleep(500);
    const titleChanged = await cdp.js(`
      (function () {
        const c = document.querySelector('#card-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(400, c.height)).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 500) dark++;
        return dark;   // 名字是浅色大字，像素数应该明显变多
      })()`);
    ok(titleChanged > 500, '输入昵称后 canvas 上的文字真的重绘了（浅色像素 ' + titleChanged + ' 个）');

    console.log('\nB. 存进匹配池 + 开一轮匹配');
    const before = (await (await fetch(BASE + '/api/state')).json()).participants.length;
    await cdp.js(`document.querySelector('#btn-save').click(); 'ok'`);
    await sleep(1200);
    const after = (await (await fetch(BASE + '/api/state')).json()).participants.length;
    ok(after === before + 1, '点「保存并加入匹配池」→ 服务端人数 ' + before + ' → ' + after);
    ok(/已保存/.test(await cdp.js(`document.querySelector('#save-state').textContent`)),
      '页面提示已保存：' + (await cdp.js(`document.querySelector('#save-state').textContent`)));

    // 切到匹配页
    await cdp.js(`location.hash = '#/match'; 'ok'`);
    await sleep(700);
    ok((await cdp.js(`document.querySelector('#view-match').classList.contains('on')`)) === true,
      '哈希路由切到匹配页');
    ok((await cdp.js(`document.querySelectorAll('#pool-list .pool-item').length`)) >= 6,
      '匹配池列出全部登记的人：' + (await cdp.js(`document.querySelectorAll('#pool-list .pool-item').length`)) + ' 个');
    ok((await cdp.js(`document.querySelectorAll('#pool-list .pool-item img').length`)) >= 6,
      '池子里带头像的人都渲染出了头像图');

    // 模式切换
    await cdp.js(`document.querySelectorAll('#mode-list .mode-card')[1].click(); 'ok'`);
    await sleep(150);
    ok((await cdp.js(`document.querySelector('#mode-list .mode-card.on').dataset.mode`)) === 'interest',
      '点第二种抽签方式 → 选中态跟着切');

    // 开一轮
    await cdp.js(`document.querySelector('#btn-match').click(); 'ok'`);
    await sleep(1500);
    const pairCount = await cdp.js(`document.querySelectorAll('#pairs .pair').length`);
    ok(pairCount >= 1, '点「开始匹配」→ 出现 ' + pairCount + ' 张配对卡');
    const t1 = await cdp.js(`document.querySelector('#pairs .pair .timer .num').textContent`);
    ok(/^\d\d:\d\d$/.test(t1), '配对卡上有倒计时：' + t1);
    await sleep(2200);
    const t2 = await cdp.js(`document.querySelector('#pairs .pair .timer .num').textContent`);
    ok(t1 !== t2, '倒计时真的在走：' + t1 + ' → ' + t2);

    // 结束这组
    await cdp.js(`document.querySelector('#pairs .pair button[data-act="finish"]').click(); 'ok'`);
    await sleep(1200);
    ok((await cdp.js(`document.querySelectorAll('#pairs .pair.done').length`)) >= 1,
      '点「结束这组」→ 卡片变成已结束状态');
    ok((await cdp.js(`document.querySelector('#history-count').textContent`)) !== '0 条',
      '配对历史记录了这一条：' + (await cdp.js(`document.querySelector('#history-count').textContent`)));

    /* ------------------------------------------------ C. 聊天室
       匹配成功之后双方要落到聊天页 —— 这是本轮的改动重点，所以要点到底：
       自动进房、认领身份、发消息、话题一键发送、第二台设备实时同步。 */
    console.log('\nC. 聊天室（匹配成功后双方进来聊天）');
    let chatShot = '';
    const pairSel = '#chat-whoami optgroup[label="这一轮的两个人"] option';
    await cdp.js(`location.hash = '#/match'; 'ok'`);
    await sleep(500);
    await cdp.js(`document.querySelector('#btn-match').click(); 'ok'`);
    await cdp.waitFor(`location.hash.indexOf('#/chat/') === 0`, '匹配成功后自动跳到聊天页');
    await cdp.waitFor(`document.querySelectorAll('${pairSel}').length === 2`, '聊天页认出这一轮的两个人');

    // 主持人这台机器不一定在配对里（随机抽的），所以显式认领这一轮的第一位。
    // 认领会往服务端写一次，UI 也要从「观战」切成「可以发言」，所以轮询等它落地。
    const claimedName = await cdp.waitFor(`(function () {
      var sel = document.querySelector('#chat-whoami');
      if (!sel) return false;
      var pairOpts = document.querySelectorAll('${pairSel}');
      if (pairOpts.length !== 2) return false;
      if (pairOpts.length) {
        var mine = Array.prototype.slice.call(pairOpts).filter(function (o) { return o.selected; })[0];
        if (!mine) {
          var want = pairOpts[0].value;
          sel.value = want;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return false;
        }
      }
      var chip = document.querySelector('#chat-topics .topic-chip');
      return !!(chip && !chip.disabled && !document.querySelector('#chat-text').disabled);
    })()`).then(
      () => cdp.js(`(function () {
        var sel = document.querySelector('#chat-whoami');
        var o = Array.prototype.slice.call(sel.options).filter(function (x) { return x.selected; })[0];
        return o ? o.textContent : '';
      })()`),
      async (e) => {
        console.log('  调试快照：' + await cdp.dump(`{
          selValue: (document.querySelector('#chat-whoami') || {}).value,
          options: document.querySelectorAll('${pairSel}').length,
          chips: document.querySelectorAll('#chat-topics .topic-chip').length,
          chipDisabled: (document.querySelector('#chat-topics .topic-chip') || {}).disabled,
          warn: document.querySelector('#chat-warn').textContent,
          me: localStorage.getItem('hackathon.me.v1')
        }`));
        throw e;
      });
    await sleep(300);

    const room = await cdp.js(`location.hash.replace('#/chat/', '')`);
    ok(/^m_[\w-]+$/.test(room), '匹配成功后地址栏就是聊天室：' + room);
    ok((await cdp.js(`document.querySelector('#view-chat').classList.contains('on')`)) === true,
      '页面切到了聊天视图');
    ok((await cdp.js(`document.querySelector('#tabs a[data-tab=chat]').classList.contains('on')`)) === true,
      '顶部「聊天」标签处于选中态');

    const sides = await cdp.js(`Array.from(document.querySelectorAll('${pairSel}')).map(o => o.value)`);
    const sideNames = await cdp.js(`Array.from(document.querySelectorAll('${pairSel}')).map(o => o.textContent)`);
    ok(sides.length === 2 && sides.every(Boolean), '「我是」里列出这一轮的两个人：' + JSON.stringify(sideNames));
    const claimed = await cdp.js(`(function () {
      var sel = document.querySelector('#chat-whoami');
      var o = Array.prototype.slice.call(sel.options).filter(function (x) { return x.selected; })[0];
      return o ? o.value : '';
    })()`);
    ok(sides.indexOf(claimed) >= 0, '当前身份就是这一轮的其中一位：' + claimedName);
    ok((await cdp.js(`document.querySelector('#chat-warn').textContent`)) === '',
      '认领之后不再是观战模式，可以直接发言');
    const peerIdx = sides.indexOf(claimed) === 0 ? 1 : 0;
    const peerName = sideNames[peerIdx];
    const peerId = sides[peerIdx];
    ok((await cdp.js(`document.querySelector('#chat-peer').textContent`)).indexOf(peerName) >= 0,
      '右栏显示的是对家「' + peerName + '」的资料');
    ok((await cdp.js(`document.querySelectorAll('#chat-topics .topic-chip').length`)) === 3,
      '聊天室带着 3 条破冰话题（点一条就能直接发出去）');
    ok((await cdp.js(`document.querySelector('#chat-msgs .chat-empty') !== null`)) === true,
      '刚开出来的房间是空状态，给了「怎么开口」的提示');

    // 空消息不允许发出去（发送按钮在没内容时是禁用的）
    const cnt0 = await cdp.js(`document.querySelectorAll('#chat-msgs .msg').length`);
    await cdp.js(`document.querySelector('#chat-send').click(); 'ok'`);
    await sleep(600);
    ok((await cdp.js(`document.querySelectorAll('#chat-msgs .msg').length`)) === cnt0,
      '输入框是空的时点发送 → 什么都不发');

    // 点破冰话题 = 直接把这句话发出去
    const topic0 = await cdp.js(`document.querySelector('#chat-topics .topic-chip').dataset.topic`);
    ok(typeof topic0 === 'string' && topic0.length > 6,
      '破冰话题上带着可以一键发出去的正文：' + String(topic0).slice(0, 16) + '…');
    await cdp.js(`document.querySelector('#chat-topics .topic-chip').click(); 'ok'`);
    await cdp.waitFor(`document.querySelectorAll('#chat-msgs .msg.me').length >= 1`, '话题消息出现在气泡里')
      .catch(async (e) => {
        console.log('  调试快照：' + await cdp.dump(`{
          me: localStorage.getItem('hackathon.me.v1'),
          hash: location.hash,
          msgs: document.querySelectorAll('#chat-msgs .msg').length,
          meMsgs: document.querySelectorAll('#chat-msgs .msg.me').length,
          hint: document.querySelector('#chat-hint').textContent,
          warn: document.querySelector('#chat-warn').textContent,
          errors: window.__hsErrors,
          toast: document.querySelector('#toast').textContent
        }`));
        throw e;
      });
    ok((await cdp.js(`document.querySelector('#chat-msgs .msg.me .bubble .txt').textContent`)) === topic0,
      '点破冰话题 → 那句话真的发出去了：' + topic0.slice(0, 16) + '…');
    ok((await cdp.js(`document.querySelectorAll('#chat-msgs .msg.me .who-tag').length`)) >= 1,
      '自己的消息带「我」的署名');

    // 手打一条
    await cdp.js(`window.__type('#chat-text', '我是主持人这台机器，先打个招呼'); 'ok'`);
    await sleep(150);
    ok((await cdp.js(`document.querySelector('#chat-send').disabled`)) === false,
      '输入框有字之后发送按钮自己亮起来');
    await cdp.js(`document.querySelector('#chat-send').click(); 'ok'`);
    await cdp.waitFor(`document.querySelectorAll('#chat-msgs .msg.me').length >= 2`, '手打的消息也发出去了');
    ok((await cdp.js(`document.querySelector('#chat-text').value`)) === '', '发完输入框自动清空');

    /* ---- 第二台设备：新开一个标签页，用对家的身份进同一间房 ----
       注意 identity 是按 JSON 存的（lsGet 会 JSON.parse），所以这里也必须写
       JSON.stringify 之后的值，直接塞裸字符串会被当成坏数据、静默退回「没认领」。 */
    const tab2 = await cdp.openTab(BASE + '/#/card',
      "try { localStorage.setItem('hackathon.me.v1', " + JSON.stringify(JSON.stringify(peerId)) + "); } catch (e) {}");
    const mainSession = tab2.prev;
    try {
      await sleep(2500);
      cdp.useSession(tab2.sessionId);
      await cdp.js(`window.__type = function (sel, val) {
        const el = document.querySelector(sel);
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      }; 'ok'`);
      await cdp.js(`location.hash = '#/chat/${room}'; 'ok'`);
      await cdp.waitFor(`document.querySelectorAll('#chat-msgs .msg').length >= 2`,
        '第二台设备看到同一间房的聊天记录');
      const peerSel = await cdp.js(`(function () {
        var s = document.querySelector('#chat-whoami');
        var o = Array.prototype.slice.call(s.options).filter(function (x) { return x.selected; })[0];
        return o ? o.value : '';
      })()`);
      ok(peerSel === peerId, '第二台设备认领的是对家 ' + peerName + '（' + peerSel + '）');
      ok((await cdp.js(`document.querySelectorAll('#chat-msgs .msg.peer').length`)) >= 2,
        '在对面那台手机上，主持人发的消息显示在左边');

      await cdp.js(`window.__type('#chat-text', '我是对家，收到你的话题了'); 'ok'`);
      await cdp.js(`document.querySelector('#chat-send').click(); 'ok'`);
      await sleep(1200);

      cdp.useSession(mainSession);
      await cdp.waitFor(`document.querySelectorAll('#chat-msgs .msg.peer').length >= 1`,
        '主持人这台不刷新就收到对家的消息');
      ok((await cdp.js(`document.querySelector('#chat-msgs .msg.peer .bubble .txt').textContent`))
        .indexOf('我是对家') >= 0, '实时同步成立：第二台设备发的消息出现在第一台上');
      ok((await cdp.js(`document.querySelector('#tabs a[data-tab=chat]').classList.contains('unread')`)) === false,
        '人就在聊天页时不会误报未读红点');
      ok((await cdp.js(`window.__hsErrors.length`)) === 0,
        '整个聊天流程零 JS 报错', await cdp.js(`window.__hsErrors`));
      chatShot = await cdp.shot('ui-04-chat.png', false);

      // 结束后房间还能看，但不能再发言
      cdp.onDialog((params) => cdp.send('Page.handleJavaScriptDialog', { accept: true }));
      await cdp.js(`document.querySelector('#chat-finish').click(); 'ok'`);
      await cdp.waitFor(`document.querySelector('#chat-text').disabled === true`, '结束后输入框被禁用');
      cdp.onDialog(null);
      ok((await cdp.js(`document.querySelectorAll('#chat-msgs .msg').length`)) >= 2,
        '这一轮结束后聊天记录仍然留在页面上');

      // 没有房间时的兜底：不能是空白页，要明确告诉人去哪儿开一轮。
      // 直接清内存快照（不走「清空配对记录」那个带 confirm 的按钮，避免弹窗卡住无头浏览器）。
      await cdp.js(`(function () {
        var S = window.__hsStore;
        S.chatId = '';
        S.chatData = null;
        if (S.state) S.state.pairs = [];
        location.hash = '#/chat';
        return 'ok';
      })()`);
      await cdp.waitFor(`document.querySelector('#chat-msgs .chat-empty') !== null`,
        '没有进行中的配对时，聊天页给兜底提示');
      ok((await cdp.js(`document.querySelector('#chat-msgs .chat-empty').textContent`)).indexOf('开始匹配') >= 0,
        '空聊天页明确引导去「开始匹配」，而不是留一片空白');
      ok((await cdp.js(`document.querySelector('#chat-text').disabled`)) === true,
        '没有房间时输入框是禁用的（不会让人白打一段话）');
    } finally {
      cdp.onDialog(null);
      try { await cdp.sendTo(null, 'Target.closeTarget', { targetId: tab2.targetId }); } catch (e) {}
      cdp.useSession(mainSession);
      await sleep(500);
    }

    console.log('\nD. 大屏 + 窄屏');
    let screenShot = '';
    await cdp.js(`location.hash = '#/screen'; 'ok'`);
    await sleep(600);
    ok(/^\d\d:\d\d$/.test(await cdp.js(`document.querySelector('#screen-clock').textContent`)),
      '大屏总时钟正常：' + (await cdp.js(`document.querySelector('#screen-clock').textContent`)));
    // 大屏被砍到只回答三个问题：第几轮、还有多久、手机输哪个地址
    ok(/第 \d+ 轮/.test(await cdp.js(`document.querySelector('#screen-round').textContent`)),
      '大屏显示第几轮：' + (await cdp.js(`document.querySelector('#screen-round').textContent`)));
    const joinText = await cdp.js(`document.querySelector('#screen-join').textContent`);
    ok(/\d+\.\d+\.\d+\.\d+:\d+/.test(joinText),
      '大屏给出局域网加入地址：' + joinText.replace('想加入', '').replace('复制这条地址', '').trim());
    ok((await cdp.js(`document.querySelectorAll('#view-screen .pair').length`)) === 0,
      '大屏不再公布配对清单（谁和谁配对属于聊天室里的私事）');
    ok((await cdp.js(`document.querySelectorAll('#view-screen #btn-match, #view-screen #btn-finish-all').length`)) === 0,
      '大屏上没有「开一轮 / 结束全部」按钮（投影前不会误点）');
    ok((await cdp.js(`window.__hsErrors.length`)) === 0,
      '大屏页零 JS 报错', await cdp.js(`window.__hsErrors`));
    screenShot = await cdp.shot('ui-05-screen.png', false);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await cdp.js(`location.hash = '#/card'; 'ok'`);
    await sleep(800);
    const overflow = await cdp.js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    ok(overflow <= 1, '窄屏（390px）没有横向溢出：' + overflow + 'px');
    ok((await cdp.js(`getComputedStyle(document.querySelector('.grid-2')).gridTemplateColumns.split(' ').length`)) === 1,
      '窄屏下双栏收成单栏');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    console.log('\nE. 静态部署（没有服务端，模拟 GitHub Pages）');
    staticSrv = await startStaticServer(STATIC_PORT, path.join(__dirname, '..', 'public'));
    await cdp.send('Page.navigate', { url: STATIC_BASE + '/#/card' });
    await sleep(2500);

    ok((await cdp.js('window.__hsErrors.length')) === 0,
      '静态托管下页面零 JS 报错', await cdp.js('window.__hsErrors'));
    ok((await cdp.js(`document.querySelector('#notice').hidden`)) === false,
      '自动识别出没有服务端，弹出单机模式说明条');
    const noticeText = await cdp.js(`document.querySelector('#notice').textContent`);
    ok(/单机模式/.test(noticeText) && /node server\.js/.test(noticeText),
      '说明条讲清楚了能做什么、以及怎么才能多设备同步');
    ok((await cdp.js(`/单机模式/.test(document.querySelector('#foot-mode').textContent)`)) === true,
      '页脚也标成单机模式：' + (await cdp.js(`document.querySelector('#foot-mode').textContent`)));

    // 静态部署下匹配池默认是空的，必须能一键载入演示数据，否则没东西可试
    ok((await cdp.js(`document.querySelectorAll('#notice .js-demo').length`)) === 1,
      '说明条上有「载入演示参与者」按钮');
    await cdp.js(`document.querySelector('#notice .js-demo').click(); 'ok'`);
    await sleep(500);
    await cdp.js(`location.hash = '#/match'; 'ok'`);
    await sleep(600);
    const staticPool = await cdp.js(`document.querySelectorAll('#pool-list .pool-item').length`);
    ok(staticPool === 8, '一键载入 8 个演示参与者：' + staticPool + ' 个');

    await cdp.js(`document.querySelector('#btn-match').click(); 'ok'`);
    await sleep(1200);
    ok((await cdp.js(`document.querySelectorAll('#pairs .pair').length`)) >= 1,
      '没有服务端也能在本地开出配对（纯前端跑匹配算法）');
    ok(/^\d\d:\d\d$/.test(await cdp.js(`document.querySelector('#pairs .pair .timer .num').textContent`)),
      '本地配对的倒计时也正常：' + (await cdp.js(`document.querySelector('#pairs .pair .timer .num').textContent`)));

    // 离线模式的聊天室：没有服务端也得能进去说话（匹配成功自动跳转 → 认领身份 → 发消息）
    await cdp.waitFor(`location.hash.indexOf('#/chat/') === 0`, '离线模式匹配后也自动进聊天页');
    await cdp.waitFor(`(function () {
      var sel = document.querySelector('#chat-whoami');
      if (!sel || document.querySelectorAll('${pairSel}').length !== 2) return false;
      var opts = document.querySelectorAll('${pairSel}');
      var mine = Array.prototype.slice.call(opts).filter(function (o) { return o.selected; })[0];
      if (!mine) {
        sel.value = opts[0].value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
      }
      var chip = document.querySelector('#chat-topics .topic-chip');
      return !!(chip && !chip.disabled && !document.querySelector('#chat-text').disabled);
    })()`, '离线模式认领身份后可以发言');

    // 静态页是整页导航过的，之前注入的小工具没了，重新装一遍
    await cdp.js(`window.__type = function (sel, val) {
      const el = document.querySelector(sel);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    }; 'ok'`);
    await cdp.js(`window.__type('#chat-text', '没有服务端也能聊'); 'ok'`);
    await cdp.js(`document.querySelector('#chat-send').click(); 'ok'`);
    await cdp.waitFor(`document.querySelectorAll('#chat-msgs .msg.me').length >= 1`, '离线模式的消息发得出去');
    ok((await cdp.js(`document.querySelectorAll('#chat-msgs .msg.me').length`)) >= 1,
      '静态托管（单机模式）下聊天照样能用，数据存在本机');
    ok((await cdp.js(`window.__hsErrors.length`)) === 0,
      '离线聊天零 JS 报错', await cdp.js(`window.__hsErrors`));
    const staticShot = await cdp.shot('ui-03-static.png', true);

    console.log('\nF. 截图留存');
    await cdp.send('Page.navigate', { url: BASE + '/#/card' });
    await sleep(2000);
    const f1 = await cdp.shot('ui-01-card.png', true);
    await cdp.js(`location.hash = '#/match'; 'ok'`);
    await sleep(700);
    const f2 = await cdp.shot('ui-02-match.png', true);
    console.log('  · ' + f1);
    console.log('  · ' + f2);
    console.log('  · ' + staticShot);
    if (chatShot) console.log('  · ' + chatShot);
    if (screenShot) console.log('  · ' + screenShot);
  } finally {
    if (cdp) cdp.close();
    if (browser) { browser.kill(); }
    await sleep(300);
    if (staticSrv) staticSrv.close();
    server.kill();
    await sleep(200);
    for (const d of [DATA_DIR, UDD]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
}

// 只有直接 `node scripts/ui-check.js` 时才跑主流程。
// 加这道判断是为了让别的地方（比如验收已发布的 Pages 站点）能 require 这个文件
// 复用上面的 CDP 封装，而不会顺带把整套本地验收又跑一遍。
if (require.main === module) {
  main().catch((e) => {
    console.error('\n中断：' + e.message);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (x) {}
    try { fs.rmSync(UDD, { recursive: true, force: true }); } catch (x) {}
    process.exit(1);
  });
}

module.exports = { CDP };
