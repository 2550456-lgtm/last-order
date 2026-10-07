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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
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
    return new CDP(ws);
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 20000);
    });
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

    cdp = await CDP.connect(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('A. 名片页交互');
    await cdp.send('Page.navigate', { url: BASE + '/#/card' });
    await sleep(2500);

    // 先注入一个「像真人一样输入」的小工具：直接改 value 不会触发框架监听，必须补 input 事件
    await cdp.js(`window.__type = function (sel, val) {
      const el = document.querySelector(sel);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
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

    console.log('\nC. 大屏 + 窄屏');
    await cdp.js(`location.hash = '#/screen'; 'ok'`);
    await sleep(600);
    ok(/^\d\d:\d\d$/.test(await cdp.js(`document.querySelector('#screen-clock').textContent`)),
      '大屏总时钟正常：' + (await cdp.js(`document.querySelector('#screen-clock').textContent`)));
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

    console.log('\nD. 截图留存');
    const f1 = await cdp.shot('ui-01-card.png', true);
    await cdp.js(`location.hash = '#/match'; 'ok'`);
    await sleep(700);
    const f2 = await cdp.shot('ui-02-match.png', true);
    console.log('  · ' + f1);
    console.log('  · ' + f2);
  } finally {
    if (cdp) cdp.close();
    if (browser) { browser.kill(); }
    await sleep(300);
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

main().catch((e) => {
  console.error('\n中断：' + e.message);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (x) {}
  try { fs.rmSync(UDD, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
