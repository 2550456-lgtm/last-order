#!/usr/bin/env node
/**
 * 演示数据：node scripts/seed.js
 * ---------------------------------------------------------------
 * 往正在运行的服务端塞 8 位「现场参与者」，方便一打开页面就能试匹配。
 * 用真实的 HTTP 接口写入，和手机上手动填表走的是同一条路径。
 *
 *   node scripts/seed.js                      # 默认 http://127.0.0.1:8788
 *   BASE=http://192.168.2.178:8788 node scripts/seed.js
 *
 * 清空：页面上的「清空配对记录」，或直接删掉 data/state.json 后重启。
 */
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

const PEOPLE = [
  {
    name: '林可', tagline: '把动效做得让人想多点两下',
    skills: [{ name: '前端', level: 'pro' }, { name: 'JavaScript', level: 'pro' }, { name: '3D 建模', level: 'learn' }],
    interests: ['独立游戏', '摄影'], lookingFor: ['UI 设计'], contact: 'wx: linke'
  },
  {
    name: '陈墨', tagline: '做界面也做海报，能熬夜',
    skills: [{ name: 'UI 设计', level: 'pro' }, { name: '视频剪辑', level: 'know' }, { name: '前端', level: 'learn' }],
    interests: ['独立游戏', '咖啡'], lookingFor: ['前端'], contact: 'wx: chenmo'
  },
  {
    name: '赵一鸣', tagline: '想把大模型塞进一个具体的小场景',
    skills: [{ name: 'Python', level: 'pro' }, { name: '大模型应用', level: 'pro' }, { name: '后端', level: 'know' }],
    interests: ['AI 应用', '开源'], lookingFor: ['前端'], contact: 'wx: zhaoym'
  },
  {
    name: '苏晴', tagline: '负责把想法砍到能做完',
    skills: [{ name: '产品经理', level: 'pro' }, { name: '数据分析', level: 'know' }, { name: '演讲/PPT', level: 'pro' }],
    interests: ['创业', '读书'], lookingFor: ['后端'], contact: 'wx: suqing'
  },
  {
    name: '郑野', tagline: '焊过板子，也写过驱动',
    skills: [{ name: '硬件/嵌入式', level: 'pro' }, { name: 'Python', level: 'know' }, { name: '算法', level: 'learn' }],
    interests: ['硬件折腾', '攀岩'], lookingFor: ['算法'], contact: 'wx: zhengye'
  },
  {
    name: '何嘉', tagline: '模型调得比人准一点',
    skills: [{ name: '算法', level: 'pro' }, { name: 'Python', level: 'pro' }, { name: '硬件/嵌入式', level: 'learn' }],
    interests: ['AI 应用', '跑步'], lookingFor: ['硬件/嵌入式'], contact: 'wx: hejia'
  },
  {
    name: '吴晓', tagline: '剪片子的人，也写点前端',
    skills: [{ name: '视频剪辑', level: 'pro' }, { name: '前端', level: 'know' }, { name: '运营', level: 'know' }],
    interests: ['摄影', '二次元'], lookingFor: ['产品经理'], contact: 'wx: wuxiao'
  },
  {
    name: '周牧', tagline: '服务别挂就行',
    skills: [{ name: '后端', level: 'pro' }, { name: '运维/部署', level: 'pro' }, { name: '数据分析', level: 'know' }],
    interests: ['开源', '桌游'], lookingFor: ['UI 设计'], contact: 'wx: zhoumu'
  }
];

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(path + ' → ' + res.status + ' ' + (data.error || ''));
  return data;
}

(async function main() {
  console.log('往 ' + BASE + ' 写演示数据…');
  try {
    await (await fetch(BASE + '/api/health')).json();
  } catch (e) {
    console.error('连不上服务端。先另开一个终端跑 `npm start`。');
    process.exit(1);
  }

  let created = 0, updated = 0;
  for (const p of PEOPLE) {
    const r = await post('/api/participants', p);
    if (r.created) created++; else updated++;
  }

  const state = await (await fetch(BASE + '/api/state')).json();
  console.log('完成：新增 ' + created + ' 人，更新 ' + updated + ' 人，现在匹配池里有 ' + state.participants.length + ' 人。');
  console.log('打开 ' + BASE + '/#/match 点「开始匹配」试试。');
})();
