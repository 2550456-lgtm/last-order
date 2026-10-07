#!/usr/bin/env node
/**
 * HackMatch 冒烟测试：node test/smoke.js
 * ---------------------------------------------------------------
 * 分两段：
 *   A. 算法单测 —— 不依赖服务端，直接 require 匹配内核
 *   B. 端到端 —— 用一个临时数据目录真起一个服务端，走完整 HTTP 流程
 * 只使用 Node 内置模块，不需要 npm install。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.TEST_PORT || 8899);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hackmatch-test-'));
const M = require('../public/lib/match.js');

let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log('  \u2713 ' + label);
  } else {
    failed++;
    console.log('  \u2717 ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

/* 固定种子的伪随机，方便复现 */
function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PEOPLE = [
  {
    id: 'p_a', name: '阿离', tagline: '想把语音助手塞进小硬件',
    skills: [{ name: 'Rust', level: 'pro' }, { name: '硬件', level: 'know' }],
    interests: ['独立游戏', '攀岩'], lookingFor: ['UI 设计'], contact: 'wx: ali'
  },
  {
    id: 'p_b', name: '小柯', tagline: '做让人想点第二次的界面',
    skills: [{ name: 'UI 设计', level: 'pro' }, { name: 'Rust', level: 'learn' }],
    interests: ['独立游戏', '咖啡'], lookingFor: ['Rust'], contact: 'wx: ke'
  },
  {
    id: 'p_c', name: '老周', tagline: '数据管道工',
    skills: [{ name: 'Python', level: 'pro' }, { name: '数据分析', level: 'pro' }],
    interests: ['开源', '跑步'], lookingFor: ['前端'], contact: 'wx: zhou'
  },
  {
    id: 'p_d', name: 'Momo', tagline: '写前端也写点后端',
    skills: [{ name: 'Python', level: 'know' }, { name: '前端', level: 'pro' }],
    interests: ['开源', '摄影'], lookingFor: ['数据分析'], contact: 'wx: momo'
  },
  {
    id: 'p_e', name: '阿树', tagline: '什么都想试一下',
    skills: [{ name: '产品经理', level: 'know' }],
    interests: ['桌游'], lookingFor: ['什么都行'], contact: ''
  }
];

/* ============================================================ A. 算法单测 */

function testAlgorithm() {
  section('A. 匹配算法单测');

  const a = PEOPLE[0], b = PEOPLE[1];
  const d = M.pairDetail(a, b, []);

  ok(d.score > 0 && d.score <= 100, '匹配度落在 0–100：' + d.score);
  ok(d.teach.length >= 1, '识别出「你会我想学」的组合：' + d.teach.length + ' 条');
  ok(d.dims.complement > 0, '技能互补维度有分：' + d.dims.complement + '/' + M.MAX.complement);
  ok(d.sharedInterests.indexOf('独立游戏') >= 0, '找到共同兴趣「独立游戏」');
  ok(d.reasons.length > 0 && d.reasons.length <= 3, '给出不超过 3 条理由');
  ok(d.topics.length === 3, '破冰话题正好 3 条');
  ok(d.topics.every((t) => typeof t === 'string' && t.length > 6), '话题都不是空话');

  // 双向互补：我熟练 A 想学 B，你熟练 B 想学 A → 两个方向都要抓到
  const x = M.normalizeProfile({ name: 'X', skills: [{ name: 'Rust', level: 'pro' }, { name: 'Go', level: 'learn' }], interests: ['开源'] });
  const y = M.normalizeProfile({ name: 'Y', skills: [{ name: 'Go', level: 'pro' }, { name: 'Rust', level: 'learn' }], interests: ['开源'] });
  const xy = M.pairDetail(x, y, []);
  ok(xy.teach.length === 2, '双向互补抓到 2 条教学关系：' + xy.teach.length);
  ok(xy.dims.complement === 20, '两条教学关系 → 互补维度 20 分：' + xy.dims.complement);

  const again = M.pairDetail(a, b, [{ a: a.id, b: b.id }]);
  ok(again.score < d.score, '配对过的人分数被扣（' + d.score + ' → ' + again.score + '）');

  const rev = M.pairDetail(b, a, []);
  ok(rev.score === d.score, '分数与顺序无关（对称）');

  const plan = M.planMatches(PEOPLE, { mode: 'smart', count: 2, rng: seededRng(42) });
  ok(plan.pairs.length === 2, '5 人开 2 组 → 得到 2 组');
  ok(plan.bye && plan.bye.id === PEOPLE[4].id || !!plan.bye, '落单的人拿到轮空卡：' + (plan.bye && plan.bye.name));
  const ids = plan.pairs.flatMap((p) => [p.a.id, p.b.id]);
  ok(new Set(ids).size === ids.length, '同一个人不会被排进两组');
  ok(plan.pairs.every((p) => p.topics.length === 3), '每组都带 3 条话题');

  const many = M.planMatches(PEOPLE, { mode: 'smart', count: 12, rng: seededRng(7) });
  ok(many.pairs.length === 2, '5 人最多只能开出 2 组（不会硬凑）');

  const one = M.planMatches([PEOPLE[0]], { mode: 'smart', count: 1 });
  ok(one.pairs.length === 0 && one.bye === null, '只有 1 个人时不配对、也不报错');

  // 随机性：固定种子应可复现，不同种子应该有差异
  const r1 = M.planMatches(PEOPLE, { mode: 'random', count: 1, rng: seededRng(1) }).pairs[0];
  const r2 = M.planMatches(PEOPLE, { mode: 'random', count: 1, rng: seededRng(1) }).pairs[0];
  ok(r1.a.id === r2.a.id && r1.b.id === r2.b.id, '同种子结果可复现（随机不等于不可测）');

  // 智能模式应该比纯随机更倾向于高分组合：跑 200 次取平均
  let smartSum = 0, randSum = 0;
  for (let i = 0; i < 200; i++) {
    smartSum += M.planMatches(PEOPLE, { mode: 'smart', count: 1, rng: seededRng(i + 1) }).pairs[0].score;
    randSum += M.planMatches(PEOPLE, { mode: 'random', count: 1, rng: seededRng(i + 1) }).pairs[0].score;
  }
  const smartAvg = smartSum / 200, randAvg = randSum / 200;
  ok(smartAvg > randAvg, '智能模式平均分高于纯随机（' + smartAvg.toFixed(1) + ' vs ' + randAvg.toFixed(1) + '）');

  // 老搭档降权：3 人池里有 1 对配过，跑 300 次看它有多常被再次抽中（均等概率应为 100 次）
  const trio = [PEOPLE[0], PEOPLE[1], PEOPLE[4]];
  const hist = [{ a: PEOPLE[0].id, b: PEOPLE[1].id }];
  let repeated = 0;
  for (let i = 0; i < 300; i++) {
    const picked = M.planMatches(trio, { mode: 'smart', count: 1, history: hist, rng: seededRng(i + 1) }).pairs[0];
    const ids = [picked.a.id, picked.b.id];
    if (ids.indexOf(PEOPLE[0].id) >= 0 && ids.indexOf(PEOPLE[1].id) >= 0) repeated++;
  }
  ok(repeated < 100, '老搭档被重复抽中的次数明显低于均等概率：' + repeated + '/300');
  ok(repeated > 0, '但没有被硬性排除，仍有机会再聊一次：' + repeated + '/300');

  // 冷启动：完全空资料的人也不能崩
  const empty = M.pairDetail(
    M.normalizeProfile({ name: 'x' }), M.normalizeProfile({ name: 'y' }), []);
  ok(empty.score >= 0 && empty.topics.length === 3, '空资料兜底不崩，仍给 3 条通用话题');

  // 输入清洗
  const dirty = M.normalizeProfile({
    name: '  测试  ', skills: ['Python', 'python', '', { name: 'Python' }, { name: 'Rust', level: '乱填' }],
    interests: ['A', 'a', 'B'], lookingFor: ['前端']
  });
  ok(dirty.name === '测试', '昵称去空格');
  ok(dirty.skills.length === 2, '技能去重（大小写不敏感）：' + dirty.skills.length + ' 个');
  ok(dirty.skills[1].level === 'know', '非法等级回落到「会用」');
  ok(dirty.interests.length === 2, '兴趣去重：' + dirty.interests.length + ' 个');
  ok(M.validate(dirty).length === 0, '合法资料校验通过');
  ok(M.validate(M.normalizeProfile({ name: '' })).length === 3, '空资料报出 3 条错误');

  // 头像配色决定论
  ok(M.avatarColors('阿离').from === M.avatarColors('阿离').from, '同名同色（决定论，无需图片素材）');
  ok(M.avatarColors('阿离').from !== M.avatarColors('小柯').from, '不同名字不同色');
}

/* ============================================================ B. 端到端 */

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data, res: res };
}

function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(BASE + '/api/health')
        .then((r) => r.json())
        .then((j) => { if (j && j.ok) resolve(j); else throw new Error('not ok'); })
        .catch(() => {
          if (Date.now() > deadline) reject(new Error('服务端 8 秒内没起来'));
          else setTimeout(poll, 200);
        });
    })();
  });
}

async function testEndToEnd() {
  section('B. 端到端（真起服务端，临时数据目录）');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});   // 吞掉启动横幅，保持测试输出干净
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

  try {
    await waitHealth(8000);
    ok(true, '服务端起来了：' + BASE);

    // 静态资源
    const home = await fetch(BASE + '/');
    const homeHtml = await home.text();
    ok(home.status === 200 && homeHtml.indexOf('HackMatch') >= 0, 'GET / 返回首页');
    const lib = await fetch(BASE + '/lib/match.js');
    ok(lib.status === 200, 'GET /lib/match.js 能取到匹配内核（前后端共用一份）');
    const css = await fetch(BASE + '/styles.css');
    ok(css.status === 200, 'GET /styles.css 正常');
    const trav = await fetch(BASE + '/../server.js');
    ok(trav.status === 403 || trav.status === 404, '目录穿越被挡（' + trav.status + '）');

    // 登记
    for (const p of PEOPLE) {
      const r = await api('POST', '/api/participants', p);
      if (r.status !== 201) ok(false, '登记 ' + p.name, r);
    }
    ok(true, '登记 5 个人');

    const dup = await api('POST', '/api/participants', PEOPLE[0]);
    ok(dup.status === 200 && dup.data.created === false, '同名同联系方式重复提交 → 更新而不是新增');

    let st = await api('GET', '/api/state');
    ok(st.data.participants.length === 5, '匹配池是 5 人（没有重复）');

    const bad = await api('POST', '/api/participants', { name: '只有名字' });
    ok(bad.status === 400 && /技能/.test(bad.data.error), '缺技能被拒：' + bad.data.error);

    // 匹配
    const match = await api('POST', '/api/match', { mode: 'smart', count: 2, durationSec: 300 });
    ok(match.status === 200 && match.data.pairs.length === 2, '开 2 组成功');
    const pair = match.data.pairs[0];
    ok(pair.score >= 0 && pair.score <= 100, '配对带匹配度：' + pair.score);
    ok(pair.topics.length === 3, '配对带 3 条破冰话题');
    ok(pair.endsAt - pair.createdAt === 300000, '默认时长 = 5 分钟');
    ok(match.data.bye && match.data.bye.name, '第 5 个人拿到轮空：' + match.data.bye.name);

    const busy = await api('POST', '/api/match', { mode: 'random', count: 1 });
    ok(busy.status === 409, '4 个人都在聊，再开会明确拒绝：' + busy.data.error);

    // 延长 + 结束
    const ext = await api('POST', '/api/pairs/' + pair.id, { action: 'extend', minutes: 2 });
    ok(ext.data.pair.endsAt - pair.endsAt === 120000, '延长 2 分钟生效');
    const fin = await api('POST', '/api/pairs/' + pair.id, { action: 'finish' });
    ok(fin.data.pair.status === 'done', '结束这组生效');

    const badAct = await api('POST', '/api/pairs/' + pair.id, { action: '乱写' });
    ok(badAct.status === 400, '非法操作被拒');

    // 结束后可以再开一轮（服务端用真随机，具体抽到谁不做断言，只验证流程与字段）
    const again = await api('POST', '/api/match', { mode: 'smart', count: 1, durationSec: 180 });
    ok(again.status === 200 && again.data.pairs.length === 1, '结束后能开新一轮');
    const newPair = again.data.pairs[0];
    ok(newPair.aId !== newPair.bId && newPair.topics.length === 3, '新一轮的配对结构完整');

    // 持久化
    await new Promise((r) => setTimeout(r, 500));
    const file = path.join(DATA_DIR, 'state.json');
    ok(fs.existsSync(file), '状态落盘到 ' + path.basename(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(saved.participants.length === 5, '落盘内容包含 5 位参与者');
    ok(saved.pairs.length === 3, '落盘内容包含 3 条配对记录');

    // 预览接口
    const meId = st.data.participants[0].id;
    const prev = await api('GET', '/api/match/preview?id=' + meId);
    ok(prev.status === 200 && prev.data.scored.length === 4, '「谁和我最搭」接口返回 4 个候选');

    // 重置
    const reset = await api('POST', '/api/reset', { what: 'pairs' });
    ok(reset.status === 200, '清空配对记录');
    st = await api('GET', '/api/state');
    ok(st.data.pairs.length === 0 && st.data.participants.length === 5, '配对（含进行中的）清了、人还在');

    const matchAgain = await api('POST', '/api/match', { mode: 'random', count: 1 });
    ok(matchAgain.status === 200, '清空后能重新开一轮（round 从 1 重数）');
    ok(matchAgain.data.round === 2, '轮次重新从 1 开始计数：现在第 ' + matchAgain.data.round + ' 轮');

    const del = await api('DELETE', '/api/participants/' + meId);
    ok(del.status === 200, '删除参与者');
    st = await api('GET', '/api/state');
    ok(st.data.participants.length === 4, '删完剩 4 人');

    const nf = await api('GET', '/api/nope');
    ok(nf.status === 404, '未知接口返回 404');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ============================================================ 跑 */

(async function main() {
  console.log('HackMatch 冒烟测试');
  testAlgorithm();
  try {
    await testEndToEnd();
  } catch (e) {
    failed++;
    console.log('  \u2717 端到端流程异常中断：' + e.message);
  }
  console.log('\n──────────────────────────────');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();
