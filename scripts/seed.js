#!/usr/bin/env node
/**
 * 演示数据：node scripts/seed.js
 * ---------------------------------------------------------------
 * 往正在运行的服务端塞 8 位「现场参与者」，方便一打开页面就能试匹配。
 * 用真实的 HTTP 接口写入，和手机上手动填表走的是同一条路径。
 *
 * 数据本身在 public/lib/demo-people.js —— 和网页端「载入演示数据」按钮
 * 共用同一份，避免两边各维护一套假数据。
 *
 *   node scripts/seed.js                      # 默认 http://127.0.0.1:8788
 *   BASE=http://<你的局域网IP>:8788 node scripts/seed.js
 *
 * 清空：页面上的「清空配对记录」，或直接删掉 data/state.json 后重启。
 */
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const PEOPLE = require('../public/lib/demo-people.js').people;

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
    console.error('连不上服务端。先另开一个终端跑 `node server.js`。');
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
