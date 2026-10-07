/*!
 * Hackathon 组队雷达 —— 前端主逻辑
 * ---------------------------------------------------------------
 * 两种运行模式，同一套代码：
 *   在线：连上 server.js，匹配池和配对记录在服务端，多台手机 + 大屏实时同步（SSE）
 *   离线：直接双击 index.html 打开也能用，数据退化成 localStorage，只影响本机
 * 匹配算法始终调用 ./lib/match.js 那一份，两种模式算出来的分数完全一致。
 */
(function () {
  'use strict';

  const M = window.HackathonRadar;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  // 自选头像：文件在 public/avatars/ 下，由 scripts 里的图片处理流程生成
  const AVATARS = ['avatar-01', 'avatar-02', 'avatar-03', 'avatar-04', 'avatar-05',
    'avatar-06', 'avatar-07', 'avatar-08', 'avatar-09', 'avatar-10'];

  const LS = {
    profile: 'hackathon.profile.v1',
    pool: 'hackathon.pool.v1',
    pairs: 'hackathon.pairs.v1',
    chat: 'hackathon.chat.v1',
    settings: 'hackathon.settings.v1',
    me: 'hackathon.me.v1',
    notice: 'hackathon.notice.v1'
  };

  const PRESET_SKILLS = ['JavaScript', 'Python', '前端', '后端', 'UI 设计', '产品经理', '硬件/嵌入式',
    '数据分析', '大模型应用', '3D 建模', '视频剪辑', '算法', 'Android/iOS', '运维/部署'];

  const PRESET_INTERESTS = ['独立游戏', 'AI 应用', '开源', '硬件折腾', '桌游', '攀岩',
    '咖啡', '音乐', '摄影', '跑步', '二次元', '创业', '读书', '美食'];

  const PRESET_LOOKING = ['前端', '后端', 'UI 设计', '产品经理', '算法', '硬件/嵌入式',
    '运营', '演讲/PPT', '视频剪辑', '什么都行'];

  /* ------------------------------------------------------------------ 工具 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast on' + (kind === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  function mmss(ms) {
    ms = Math.max(0, ms);
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function avatarHtml(name, cls, avatarId) {
    const c = M.avatarColors(name || '?');
    const style = 'background:linear-gradient(135deg,' + c.from + ',' + c.to + ')';
    // 选了自选头像就画图，否则用名字哈希生成的双色圆 + 首字母兜底。
    // avatarId 已经在 M.normalizeProfile 里按白名单校验过，这里再 esc 一层。
    if (avatarId && M.AVATAR_RE.test(avatarId)) {
      return '<span class="avatar ' + (cls || '') + '" style="' + style + '">' +
        '<img src="./avatars/' + esc(avatarId) + '.png" alt="" loading="lazy"></span>';
    }
    return '<span class="avatar ' + (cls || '') + '" style="' + style + '">' +
      esc(M.initials(name)) + '</span>';
  }

  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '"><use href="#' + name + '"/></svg>';
  }

  /** 当前地址栏里的聊天室：'#/chat/<配对ID>'，不在聊天室里就是空字符串 */
  function roomHash() {
    const m = String(location.hash || '').match(/^#\/chat\/([\w-]+)/);
    return m ? '#/chat/' + m[1] : '';
  }

  /**
   * 把人写明「我是谁」。
   * 手机浏览器刷新之后 localStorage 还在，所以正常情况下不用再选一次；
   * 换人用同一台手机时会走 select 的 change，那时不该被自动跳转覆盖。
   */
  function setMe(id, quiet) {
    if (!id) return;
    Store.me = id;
    lsSet(LS.me, Store.me);
    if (!quiet) {
      const p = byId(id);
      if (p) toast('已切换身份：' + p.name);
    }
  }

  /* 局域网 http 下 navigator.clipboard 不可用（非安全上下文），必须有兜底 */
  function copyText(text) {
    const done = () => toast('已复制到剪贴板');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    } else {
      legacyCopy(text, done);
    }
  }

  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) done();
    else toast('复制失败，请手动长按选中链接', 'err');
  }

  /* 名片分享链接：把资料编码进 URL，对方不用连服务端也能看到卡片 */
  function encodeProfile(p) {
    const compact = {
      n: p.name, t: p.tagline, a: p.avatar || '',
      s: (p.skills || []).map((s) => [s.name, s.level]),
      i: p.interests || [], l: p.lookingFor || [], c: p.contact || '', e: p.event || ''
    };
    const json = JSON.stringify(compact);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeProfile(token) {
    try {
      let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const json = decodeURIComponent(escape(atob(b64)));
      const c = JSON.parse(json);
      return M.normalizeProfile({
        name: c.n, tagline: c.t, avatar: c.a,
        skills: (c.s || []).map((pair) => ({ name: pair[0], level: pair[1] })),
        interests: c.i, lookingFor: c.l, contact: c.c, event: c.e
      });
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------------- 全局状态 */

  const Store = {
    online: false,
    state: null,          // 服务端快照
    offset: 0,            // 服务端时间 - 本机时间
    localPool: lsGet(LS.pool, []),
    localPairs: lsGet(LS.pairs, []),
    localBye: null,
    localSettings: lsGet(LS.settings, { event: '黑客松现场', durationSec: 300, mode: 'smart', count: 1 }),
    // 离线模式的聊天记录：{ [pairId]: [{id, from, text, at}] }，和服务端存同一套字段
    localChat: lsGet(LS.chat, {}),
    me: lsGet(LS.me, ''),
    ui: { mode: 'smart', durationSec: 300, count: 1 },
    uiTouched: false,
    // 单机模式的原因：forced=?offline=1 / file=直接双击 html / static=静态托管没有接口
    localReason: '',
    noticeDismissed: lsGet(LS.notice, false),
    noSse: false,
    // 聊天室相关：正在看的房间、它的完整记录，以及已经自动进过的房间
    chatId: '',
    chatData: null,
    chatStale: false,       // 正在重拉完整记录，别重复发请求
    chatFetchedFor: '',     // 已经取回来的那一份记录（每个条数只取一次）
    navigatedFor: ''        // 已经替用户跳转过的那条配对，同一条不重复跳
  };

  function serverNow() { return Date.now() + Store.offset; }
  function pool() { return Store.online && Store.state ? Store.state.participants : Store.localPool; }
  function pairs() { return Store.online && Store.state ? Store.state.pairs : Store.localPairs; }
  function settings() { return Store.online && Store.state ? Store.state.settings : Store.localSettings; }
  function byId(id) { return pool().find((p) => p.id === id) || null; }
  function history() { return pairs().map((p) => ({ a: p.aId, b: p.bId })); }

  function saveLocal() {
    lsSet(LS.pool, Store.localPool);
    lsSet(LS.pairs, Store.localPairs);
    lsSet(LS.settings, Store.localSettings);
    lsSet(LS.chat, Store.localChat);
  }

  /* ------------------------------------------------ 聊天（在线/离线同一套接口）
     界面只认这一层的几个动作，不关心底下是服务端还是 localStorage。
     离线模式的实现刻意和服务端逐条对齐（同样按时间戳记已读、同样的条数上限），
     这样「本机演示」和「现场模式」的聊天表现一致。 */

  const LOCAL_MSG_CAP = 300;

  // 老版本存下来的配对没有 readsAt / msgCount 这些聊天字段，启动时补齐一次。
  // 不补的话第一次进聊天室会因为 undefined 直接炸掉整页。
  function migrateLocal() {
    let touched = false;
    Store.localPairs.forEach((p) => {
      if (!p.readsAt || typeof p.readsAt !== 'object') { p.readsAt = {}; touched = true; }
      const mine = Store.localChat[p.id];
      if (mine && !p.msgCount) { p.msgCount = mine.length; touched = true; }
    });
    Object.keys(Store.localChat).forEach((pid) => {
      const list = Store.localChat[pid];
      if (!Array.isArray(list)) { delete Store.localChat[pid]; touched = true; return; }
      if (list.length > LOCAL_MSG_CAP) {
        Store.localChat[pid] = list.slice(-LOCAL_MSG_CAP);
        touched = true;
      }
    });
    if (touched) saveLocal();
  }

  function localRecord(pair, from, text) {
    const list = Store.localChat[pair.id] || (Store.localChat[pair.id] = []);
    const msg = { id: uid('c'), from: from, text: text.slice(0, 500), at: Date.now() };
    list.push(msg);
    if (list.length > LOCAL_MSG_CAP) Store.localChat[pair.id] = list.slice(-LOCAL_MSG_CAP);
    pair.msgCount = Store.localChat[pair.id].length;
    pair.lastMsgAt = msg.at;
    if (!pair.readsAt) pair.readsAt = {};
    pair.readsAt[from] = Math.max(pair.readsAt[from] || 0, msg.at);
    saveLocal();
    return { message: msg };
  }

  /** 未读条数：离线模式得自己算（服务端模式由快照里的 presence 给） */
  function localUnread(pair, pid) {
    const since = (pair.readsAt && pair.readsAt[pid]) || 0;
    return (Store.localChat[pair.id] || []).filter((m) => m.from !== pid && m.at > since).length;
  }

  const chatApi = {
    /** 打开聊天室：拉这一次的完整记录，之后由推送触发重拉跟进 */
    fetchPair: async function (id) {
      if (Store.online) {
        try {
          const res = await fetch('./api/pairs/' + encodeURIComponent(id), { cache: 'no-store' });
          if (!res.ok) return null;
          const data = await res.json();
          if (data && data.pair) {
            data.messages = data.messages || [];
            Store.chatData = data;
          }
          return data;
        } catch (e) {
          return Store.chatData;
        }
      }
      const pair = pairOf(id);
      if (!pair) return null;
      const data = {
        pair: pair,
        people: { a: byId(pair.aId), b: byId(pair.bId) },
        messages: (Store.localChat[id] || []).slice(),
        now: Date.now()
      };
      Store.chatData = data;
      return data;
    },

    send: async function (pairId, text) {
      const pair = pairOf(pairId);
      if (!pair) return { error: '找不到这条配对' };
      const body = String(text == null ? '' : text).trim().slice(0, 500);
      if (!body) return { error: '消息不能为空' };
      if (!mySide(pair)) return { error: '你不在这条配对里，先选「我是」' };
      if (Store.online) {
        try {
          const res = await fetch('./api/pairs/' + encodeURIComponent(pairId) + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: Store.me, text: body })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return { error: data.error || '发送失败' };
          // 服务端返回的是完整消息（带 id 和时间），直接放进当前这份记录里：
          // 自己发的消息立刻就能看见，不用等下一次推送回来才知道发成功了
          if (Store.chatData && Store.chatData.pair && Store.chatData.pair.id === pairId && data.message) {
            Store.chatData.messages = Store.chatData.messages.concat([data.message]);
          }
          return data;
        } catch (e) {
          return { error: '发不出去：' + e.message };
        }
      }
      return localRecord(pair, Store.me, body);
    },

    read: async function (pairId) {
      if (!Store.me) return;
      if (Store.online) {
        try {
          await fetch('./api/pairs/' + encodeURIComponent(pairId) + '/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: Store.me })
          });
        } catch (e) { /* 已读回执失败不影响聊天本身 */ }
        return;
      }
      const pair = pairOf(pairId);
      if (!pair) return;
      pair.readsAt = pair.readsAt || {};
      pair.readsAt[Store.me] = Date.now();
      Store.chatData = null;
      saveLocal();
    }
  };

  /* ------------------------------------------------------------- 聊天辅助 */

  function isOnId(id) { return !!id && id === Store.me; }

  function pairOf(id) { return pairs().find((p) => p.id === id) || null; }

  function pairIsActive(pair, now) {
    return !!pair && pair.status === 'active' && Number(pair.endsAt) > (now || serverNow());
  }

  /** 我（或某个人）现在该进哪个聊天室：进行中 + 我在里面 */
  function activePairIdFor(pid) {
    const p = pid || Store.me;
    if (!p) return null;
    const found = pairs().find((x) =>
      x.status === 'active' && (x.aId === p || x.bId === p));
    return found ? found.id : null;
  }

  /** 我在配对里的那一侧：'a' | 'b' | ''（不在里面就是观战） */
  function mySide(pair) {
    if (!pair || !Store.me) return '';
    if (pair.aId === Store.me) return 'a';
    if (pair.bId === Store.me) return 'b';
    return '';
  }

  function messagesIn(pairId) {
    if (Store.chatData && Store.chatData.pair && Store.chatData.pair.id === pairId) {
      const live = pairOf(pairId);
      const meta = live && live.chat;
      // 服务端推来的条数比手上这份多，说明有新消息，重新拉一次
      if (meta && meta.count > Store.chatData.messages.length) return null;
      return Store.chatData.messages;
    }
    return Store.localChat[pairId] || null;
  }

  function myPresence() {
    const st = Store.online && Store.state ? Store.state : null;
    if (st && Array.isArray(st.presence)) {
      return st.presence.find((x) => x.id === Store.me) || { unread: 0, activePairId: null };
    }
    const pid = activePairIdFor(Store.me);
    if (!pid) return { unread: 0, activePairId: null };
    const pair = pairOf(pid);
    return { unread: pair ? localUnread(pair, Store.me) : 0, activePairId: pid };
  }

  /** 观战提示：我要在哪个聊天室、要不要先认领身份 */
  function chatNotice(pair) {
    if (!pair) return { text: '', kind: '' };
    if (!Store.me) {
      return { text: '先在下面选「我是」——认领身份后这段对话就归你了。', kind: 'warn' };
    }
    if (!mySide(pair)) {
      const p = byId(Store.me);
      return {
        text: '你现在是观战模式（' + (p ? p.name : '?') + ' 不在这条配对里），换个名字就能发言。',
        kind: 'warn'
      };
    }
    if (!pairIsActive(pair)) return { text: '这一轮已经结束，记录还能看。', kind: '' };
    return { text: '', kind: '' };
  }

  /** 匹配成功后双方自动落到聊天页；同一条配对只自动跳一次 */
  function autoEnterChat(pair) {
    const now = serverNow();
    if (!pair || !pairIsActive(pair, now)) return false;
    const side = mySide(pair);
    if (!side) return false;
    if (Store.navigatedFor === pair.id) return false;
    Store.navigatedFor = pair.id;

    const peerId = side === 'a' ? pair.bId : pair.aId;
    const peer = byId(peerId) || byId(pair.bId) || byId(pair.aId);
    if (roomHash() !== '#/chat/' + pair.id) {
      location.hash = '#/chat/' + pair.id;
      Store.autoNav = true;    // 这次跳转是程序干的，别盖掉用户手选的身份
    }
    Store.chatId = pair.id;
    toast('匹配成功！你和 ' + (peer ? peer.name : '对面') + ' 进入聊天室');
    return true;
  }

  function noteChat(unread) {
    const link = $('#tabs a[data-tab=chat]');
    if (link) link.classList.toggle('unread', unread > 0);
  }

  /* ------------------------------------------------------------- 名片草稿 */

  let draft = lsGet(LS.profile, {
    id: null, name: '', tagline: '', avatar: '', skills: [], interests: [], lookingFor: [], contact: '', event: ''
  });

  function draftProfile() {
    const clean = M.normalizeProfile(draft);
    if (draft.id) clean.id = draft.id;
    clean.event = draft.event || settings().event;
    return clean;
  }

  function persistDraft() { lsSet(LS.profile, draft); }

  /* --------------------------------------------------------------- 表单渲染 */

  function chipHtml(item, type) {
    // 技能存的是 {name, level} 对象，兴趣/我在找存的是纯字符串 —— 两种都要能渲染。
    // 之前这里一律取 item.name，纯字符串就取到 undefined，标签会渲染成只有 × 的空胶囊。
    const name = (item && typeof item === 'object') ? item.name : item;
    if (type === 'skill') {
      const level = (item && item.level) || 'know';
      return '<span class="chip" data-level="' + esc(level) + '" data-name="' + esc(name) + '">' +
        esc(name) + '<span class="lv">' + esc(M.levelLabel(level)) + '</span>' +
        '<span class="x">×</span></span>';
    }
    return '<span class="chip ' + (type === 'look' ? 'look' : 'plain') + '" data-name="' + esc(name) + '">' +
      esc(name) + '<span class="x">×</span></span>';
  }

  function renderChips() {
    $('#chips-skills').innerHTML = draft.skills.map((s) => chipHtml(s, 'skill')).join('');
    $('#chips-interests').innerHTML = draft.interests.map((s) => chipHtml(s, 'interest')).join('');
    $('#chips-looking').innerHTML = draft.lookingFor.map((s) => chipHtml(s, 'look')).join('');
    renderPresets();
    renderAvatarPicker();
  }

  function renderAvatarPicker() {
    const box = $('#avatar-picker');
    if (!box) return;
    const head = '<button type="button" data-av="" class="none' + (draft.avatar ? '' : ' on') +
      '" title="用名字首字母">首字母</button>';
    box.innerHTML = head + AVATARS.map((id) => {
      const n = id.slice(-2);
      return '<button type="button" data-av="' + id + '"' + (draft.avatar === id ? ' class="on"' : '') +
        ' title="像素头像 ' + n + '"><img src="./avatars/' + id + '.png" alt="头像 ' + n + '" loading="lazy"></button>';
    }).join('');
  }

  function renderPresets() {
    const used = (list, key) => list.some((x) => M.norm(x.name || x) === M.norm(key));
    $('#preset-skills').innerHTML = PRESET_SKILLS.map((s) =>
      '<button type="button" data-v="' + esc(s) + '" class="' + (used(draft.skills, s) ? 'used' : '') + '">+ ' + esc(s) + '</button>').join('');
    $('#preset-interests').innerHTML = PRESET_INTERESTS.map((s) =>
      '<button type="button" data-v="' + esc(s) + '" class="' + (used(draft.interests, s) ? 'used' : '') + '">+ ' + esc(s) + '</button>').join('');
    $('#preset-looking').innerHTML = PRESET_LOOKING.map((s) =>
      '<button type="button" data-v="' + esc(s) + '" class="' + (used(draft.lookingFor, s) ? 'used' : '') + '">+ ' + esc(s) + '</button>').join('');
  }

  function renderCard() {
    const profile = draftProfile();
    window.Card.render($('#card-canvas'), profile, { event: settings().event });
    $('#save-state').textContent = draft.id
      ? '已保存，名片 ID：' + draft.id
      : '还没有保存到匹配池';
  }

  /* ------------------------------------------------------------- 表单交互 */

  function addSkill(name, level) {
    name = String(name || '').trim();
    if (!name) return;
    if (draft.skills.length >= 12) return toast('技能最多 12 个', 'err');
    if (draft.skills.some((s) => M.norm(s.name) === M.norm(name))) return toast('这个技能已经加过了', 'err');
    draft.skills.push({ name: name, level: level || 'know' });
    persistDraft(); renderChips(); renderCard();
  }

  function addList(key, name) {
    name = String(name || '').trim();
    if (!name) return;
    if (draft[key].length >= 12) return toast('最多 12 个', 'err');
    if (draft[key].some((s) => M.norm(s) === M.norm(name))) return toast('已经加过了', 'err');
    draft[key].push(name);
    persistDraft(); renderChips(); renderCard();
  }

  function bindTagInput(inputSel, btnSel, handler) {
    const input = $(inputSel);
    const fire = () => { handler(input.value); input.value = ''; input.focus(); };
    $(btnSel).addEventListener('click', fire);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); fire(); }
    });
  }

  let skillLevel = 'know';

  function bindForm() {
    $('#f-name').addEventListener('input', (e) => { draft.name = e.target.value; persistDraft(); renderCard(); });
    $('#f-tagline').addEventListener('input', (e) => { draft.tagline = e.target.value; persistDraft(); renderCard(); });
    $('#f-contact').addEventListener('input', (e) => { draft.contact = e.target.value; persistDraft(); renderCard(); });

    bindTagInput('#f-skill', '#add-skill', (v) => addSkill(v, skillLevel));
    bindTagInput('#f-interest', '#add-interest', (v) => addList('interests', v));
    bindTagInput('#f-looking', '#add-looking', (v) => addList('lookingFor', v));

    $('#seg-skill').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-level]');
      if (!b) return;
      skillLevel = b.dataset.level;
      $$('#seg-skill button').forEach((x) => x.classList.toggle('on', x === b));
    });

    // 预设标签：现场打字慢，点一下比输入快
    $('#preset-skills').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (b) addSkill(b.dataset.v, skillLevel);
    });
    $('#preset-interests').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (b) addList('interests', b.dataset.v);
    });
    $('#preset-looking').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (b) addList('lookingFor', b.dataset.v);
    });

    // 技能标签：点一下循环等级，点 × 删除
    $('#chips-skills').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip'); if (!chip) return;
      const i = draft.skills.findIndex((s) => M.norm(s.name) === M.norm(chip.dataset.name));
      if (i < 0) return;
      if (e.target.classList.contains('x')) draft.skills.splice(i, 1);
      else {
        const order = ['learn', 'know', 'pro'];
        const next = order[(order.indexOf(draft.skills[i].level) + 1) % order.length];
        draft.skills[i].level = next;
      }
      persistDraft(); renderChips(); renderCard();
    });

    const removeFrom = (key) => (e) => {
      const chip = e.target.closest('.chip'); if (!chip) return;
      draft[key] = draft[key].filter((s) => M.norm(s) !== M.norm(chip.dataset.name));
      persistDraft(); renderChips(); renderCard();
    };
    $('#chips-interests').addEventListener('click', removeFrom('interests'));
    $('#chips-looking').addEventListener('click', removeFrom('lookingFor'));

    $('#btn-save').addEventListener('click', saveProfile);
    $('#btn-download').addEventListener('click', downloadCard);
    $('#btn-share').addEventListener('click', shareCard);
    $('#btn-clear').addEventListener('click', () => {
      if (!confirm('清空这张名片？（不会把已保存的人从匹配池里删掉）')) return;
      draft = {
        id: null, name: '', tagline: '', avatar: '', skills: [], interests: [],
        lookingFor: [], contact: '', event: ''
      };
      persistDraft(); fillForm(); renderChips(); renderCard(); toast('已清空');
    });

    // 自选头像：点一下选中，再点一下同一张就取消，回到「首字母」兜底
    $('#avatar-picker').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-av]');
      if (!b) return;
      const id = b.dataset.av || '';
      draft.avatar = (draft.avatar === id) ? '' : id;
      persistDraft(); renderAvatarPicker(); renderCard();
    });

    fillForm();
  }

  function fillForm() {
    $('#f-name').value = draft.name || '';
    $('#f-tagline').value = draft.tagline || '';
    $('#f-contact').value = draft.contact || '';
  }

  async function saveProfile() {
    const profile = draftProfile();
    const errs = M.validate(profile);
    if (errs.length) return toast(errs[0], 'err');

    profile.event = settings().event;
    if (Store.online) {
      try {
        const res = await fetch('./api/participants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存失败');
        draft.id = data.participant.id;
        Store.me = draft.id;
        lsSet(LS.me, Store.me);
        persistDraft();
        renderCard();
        toast(data.created ? '已加入匹配池' : '资料已更新');
        return;
      } catch (e) {
        toast('服务端没连上，已存到本机：' + e.message, 'err');
      }
    }
    // 离线模式：本机匹配池
    const local = Object.assign({}, profile, { id: draft.id || uid('l') });
    const i = Store.localPool.findIndex((p) => p.id === local.id);
    if (i >= 0) Store.localPool[i] = local; else Store.localPool.push(local);
    draft.id = local.id;
    Store.me = local.id;
    lsSet(LS.me, Store.me);
    persistDraft(); saveLocal();
    renderCard(); renderAll();
    toast('已存到本机匹配池（离线模式）');
  }

  function downloadCard() {
    const canvas = $('#card-canvas');
    const name = (draft.name || '名片').replace(/[\\/:*?"<>|]/g, '');
    canvas.toBlob((blob) => {
      if (!blob) return toast('导出失败，试试换个浏览器', 'err');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '组队名片-' + name + '.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已开始下载 PNG');
    }, 'image/png');
  }

  function shareCard() {
    const profile = draftProfile();
    if (M.validate(profile).length) return toast('先把昵称、技能、兴趣填一下', 'err');
    const url = location.origin + location.pathname + '#/c/' + encodeProfile(profile);
    copyText(url);
  }

  /* ------------------------------------------------------------ 匹配相关 */

  function modeListHtml() {
    return M.MODES.map((m) => (
      '<div class="mode-card ' + (Store.ui.mode === m.id ? 'on' : '') + '" data-mode="' + m.id + '">' +
      '<span class="radio"></span>' +
      '<svg class="ic mode-ic"><use href="#' + (m.icon || 'i-target') + '"/></svg>' +
      '<span><strong>' + esc(m.label) + '</strong>' +
      '<span>' + esc(m.desc) + '</span></span></div>'
    )).join('');
  }

  function renderControl() {
    $('#mode-list').innerHTML = modeListHtml();
    $$('#seg-duration button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.sec) === Store.ui.durationSec);
    });
    $('#f-count').value = Store.ui.count;
    $('#pool-count').textContent = '匹配池 ' + pool().length + ' 人';
  }

  function renderPool() {
    const list = pool();
    const el = $('#pool-list');
    if (!list.length) {
      const n = Store.online ? 0 : demoPeople().length;
      el.innerHTML = '<p class="empty">匹配池还是空的。先在「组队名片」里填一张，或者把链接发到群里让大家自己填。' +
        (n ? ' 只想先看看效果？' : '') + '</p>' +
        (n ? '<button class="primary js-demo">' + icon('i-users') + '载入 ' + n + ' 个演示参与者</button>' : '');
      return;
    }
    el.innerHTML = list.map((p) => (
      '<span class="pool-item">' + avatarHtml(p.name, '', p.avatar) +
      '<span class="who">' + esc(p.name) +
      '<em>' + esc(p.skills.slice(0, 3).map((s) => s.name).join(' · ') || '没填技能') + '</em></span></span>'
    )).join('');
  }

  function renderWhoami() {
    const sel = $('#whoami');
    const list = pool();
    const keep = sel.value || Store.me;
    sel.innerHTML = '<option value="">— 选择 —</option>' + list.map((p) =>
      '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    if (keep && list.some((p) => p.id === keep)) sel.value = keep;
  }

  function renderMyMatches() {
    const box = $('#my-matches');
    const meId = $('#whoami').value;
    if (!meId) {
      box.innerHTML = '<p class="hint">选一个名字，看看按技能互补 + 兴趣重合算出来的前 3 名。</p>';
      $('#mymatch-pill').textContent = '未选择';
      return;
    }
    const me = byId(meId);
    if (!me) return;
    const scored = pool().filter((p) => p.id !== meId)
      .map((p) => ({ p: p, d: M.pairDetail(me, p, history()) }))
      .sort((a, b) => b.d.score - a.d.score)
      .slice(0, 3);
    $('#mymatch-pill').textContent = me.name;
    if (!scored.length) {
      box.innerHTML = '<p class="hint">池子里只有你一个人，再拉个人进来。</p>';
      return;
    }
    box.innerHTML = scored.map((row) => (
      '<div class="mymatch-row">' + avatarHtml(row.p.name, '', row.p.avatar) +
      '<span style="flex:1;min-width:0"><strong>' + esc(row.p.name) + '</strong>' +
      '<div class="why">' + esc(row.d.reasons[0] || '还没找到明显的交集，去聊聊看') + '</div></span>' +
      '<span class="bar"><i style="width:' + row.d.score + '%"></i></span>' +
      '<span class="num">' + row.d.score + '</span></div>'
    )).join('');
  }

  // 配对卡只出现在「破冰匹配」页这一处，所以没有大小两套排版了：
  // 大屏那边现在只显示时钟和加入地址，不再公布谁和谁配对。
  function sideHtml(p) {
    if (!p) return '<div class="side"><strong>？</strong></div>';
    const skills = p.skills.slice(0, 4);
    return '<div class="side">' + avatarHtml(p.name, 'lg', p.avatar) +
      '<strong>' + esc(p.name) + '</strong>' +
      '<span class="tag">' + esc(p.tagline || '') + '</span>' +
      '<span class="sk">' + skills.map((s) => '<span>' + esc(s.name) + '</span>').join('') + '</span>' +
      '<span class="sk">' + p.interests.slice(0, 3).map((s) =>
        '<span style="background:rgba(168,85,247,.16);color:#d8b4fe">' + esc(s) + '</span>').join('') + '</span>' +
      '</div>';
  }

  function modeLabel(id) {
    const m = M.MODES.find((x) => x.id === id);
    return m ? m.label : id;
  }

  function pairHtml(pair) {
    const A = byId(pair.aId), B = byId(pair.bId);
    if (!A || !B) return '';
    const active = pair.status === 'active';
    const dur = (pair.durationSec + (pair.extendedSec || 0)) * 1000;
    const reasonHtml = (pair.reasons || []).length
      ? '<ul class="reasons">' + pair.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '';
    const dims = pair.dims ? (
      '<div class="dims">' +
      '<span class="dim">技能互补 <b>' + pair.dims.complement + '</b>/' + (pair.max ? pair.max.complement : 30) + '</span>' +
      '<span class="dim">共同技能 <b>' + pair.dims.shared + '</b>/' + (pair.max ? pair.max.shared : 10) + '</span>' +
      '<span class="dim">兴趣 <b>' + pair.dims.interest + '</b>/' + (pair.max ? pair.max.interest : 25) + '</span>' +
      '<span class="dim">角色互补 <b>' + pair.dims.role + '</b>/' + (pair.max ? pair.max.role : 30) + '</span>' +
      (pair.mode === 'random' ? '<span class="dim">抽签抽中的，分数仅供参考</span>' : '') +
      '</div>') : '';

    return '<article class="pair' + (active ? '' : ' done') + '" data-pair="' + esc(pair.id) + '"' +
      ' data-ends="' + (active ? pair.endsAt : 0) + '" data-dur="' + dur + '">' +
      '<div class="pair-top"><div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">' +
      '<span class="badge ' + (active ? 'ok' : 'mute') + '">' + (active ? '交流中' : (pair.status === 'done' ? '已结束' : '已取消')) + '</span>' +
      '<span class="badge">' + esc(modeLabel(pair.mode)) + '</span>' +
      '<span class="badge mute">' + Math.round(dur / 60000) + ' 分钟</span>' +
      (pair.dims && pair.dims.novelty < 5 ? '<span class="badge warn">又见面了</span>' : '') +
      '</div>' +
      '<div class="score" style="--p:' + pair.score + '"><span class="score-inner"><b>' + pair.score +
      '</b><small>匹配度</small></span></div></div>' +
      '<div class="vs">' + sideHtml(A) + '<div class="link">&amp;</div>' + sideHtml(B) + '</div>' +
      reasonHtml +
      '<div class="timer"><div class="num">--:--</div><div class="bar"><i style="width:100%"></i></div></div>' +
      '<ul class="topics">' + (pair.topics || []).map((t, i) =>
        '<li><i>' + (i + 1) + '</i><span>' + esc(t) + '</span></li>').join('') + '</ul>' +
      dims +
      (active ? '<div class="pair-actions">' +
        '<button data-act="extend">' + icon('i-clock') + '延长 2 分钟</button>' +
        '<button data-act="finish">' + icon('i-check') + '结束这组</button>' +
        '<button data-act="copy">' + icon('i-link') + '复制话题</button>' +
        '</div>' : '') +
      '</article>';
  }

  function byeHtml() {
    const id = Store.online && Store.state ? Store.state.byeId : Store.localBye;
    if (!id) return '';
    const p = byId(id);
    if (!p) return '';
    return '<article class="pair"><div class="pair-top">' +
      '<div style="display:flex;gap:7px;align-items:center"><span class="badge warn">本轮轮空</span></div></div>' +
      '<div class="vs">' + sideHtml(p) + '</div>' +
      '<ul class="topics"><li><i>1</i><span>人数组不成对，这一轮先当计时员：帮大家看表，顺便去拉两个人进匹配池。</span></li></ul>' +
      '</article>';
  }

  function renderPairs() {
    const active = pairs().filter((p) => p.status === 'active');
    const recent = pairs().filter((p) => p.status !== 'active').slice(-3).reverse();
    $('#active-count').textContent = active.length + ' 组';
    const html = active.map((p) => pairHtml(p)).join('') + byeHtml() + recent.map((p) => pairHtml(p)).join('');
    $('#pairs').innerHTML = html;
    renderScreen();
    renderHistory();
    tick();
  }

  function joinAddress() {
    const st = Store.online && Store.state ? Store.state : null;
    const net = st && st.net;
    if (net && net.addresses && net.addresses.length) return net.addresses[0] + ':' + net.port;
    return location.host || 'localhost';
  }

  /* ------------------------------------------------------------- 聊天室渲染 */

  /**
   * 顶部「我是」下拉。
   * 踩过的坑：<option> 上不写 selected 时，浏览器会默认选中「第一个」——
   * 于是还没认领身份的人，下拉框里显示的是这一轮的第一位，
   * 看起来像已经认领了，实际发不出消息（观战模式），非常容易被当成 bug。
   * 所以这里显式放一个「我还没认领」的占位项，并给真正的那个人写 selected。
   */
  function renderChatIdentity(pair) {
    const sel = $('#chat-whoami');
    const av = $('#chat-me-av');
    if (!sel) return;

    const all = pool();
    if (!all.length) {
      sel.innerHTML = '<option value="">— 匹配池里还没有人 —</option>';
      sel.disabled = true;
      if (av) av.innerHTML = '';
      return;
    }
    sel.disabled = false;

    const meId = byId(Store.me) ? Store.me : '';
    const inPair = pair ? all.filter((p) => isOnPair(pair, p.id)) : [];
    const rest = pair ? all.filter((p) => !isOnPair(pair, p.id)) : all;
    const opt = (p) => '<option value="' + esc(p.id) + '"' +
      (meId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';

    sel.innerHTML =
      '<option value=""' + (meId ? '' : ' selected') + '>— 我还没认领 —</option>' +
      (inPair.length ? '<optgroup label="这一轮的两个人">' + inPair.map(opt).join('') + '</optgroup>' : '') +
      (rest.length ? '<optgroup label="匹配池里的其他人">' + rest.map(opt).join('') + '</optgroup>' : '');

    const me = byId(Store.me);
    if (av) {
      av.innerHTML = me
        ? avatarHtml(me.name, '', me.avatar)
        : '<span class="avatar">?</span>';
      av.title = me ? ('当前身份：' + me.name + '，点一下换成对家') : '还没认领身份，点一下选一个';
      av.style.cursor = 'pointer';
    }
  }

  function isOnPair(pair, id) {
    return !!pair && (pair.aId === id || pair.bId === id);
  }

  function renderChatNotice(pair) {
    const box = $('#chat-warn');
    if (!box) return;
    const n = chatNotice(pair);
    box.textContent = n.text;
    box.className = 'chat-warn' + (n.kind === 'warn' ? ' warn' : '');
  }

  /** 房间要显示的那一份数据（拉取中和拉取失败时退回上一份，不闪屏） */
  function chatView() {
    const pair = pairOf(Store.chatId);
    const cached = Store.chatData && Store.chatData.pair && Store.chatData.pair.id === Store.chatId
      ? Store.chatData : null;
    if (!pair) return cached;

    // 缓存里的条数比配对上记的少，说明有新消息还没取回来：这一帧先照着旧的画，
    // 取回来之后再重画一次。绝不能直接渲染成空 —— 那就是「消息发出去了但看不见」。
    const known = pair.chat ? pair.chat.count : (Store.localChat[pair.id] || []).length;
    if (cached && known > cached.messages.length) scheduleChatRefresh(pair.id, cached.messages.length);
    if (cached) return { pair: pair, people: cached.people, messages: cached.messages };

    return {
      pair: pair,
      people: { a: byId(pair.aId), b: byId(pair.bId) },
      messages: known ? [] : (Store.localChat[pair.id] || [])
    };
  }

  /**
   * 把某个房间的完整记录重新拉一次。
   * 用「发消息」触发的重拉做例子：POST 成功之后本地并不知道服务端给的 id 和时间，
   * 必须重拉一次才能显示出准确的气泡；而重拉是异步的，所以拉完一定要再画一帧。
   */
  function scheduleChatRefresh(pairId, fromCount) {
    if (Store.chatStale) return;
    const key = pairId + '@' + fromCount;
    if (Store.chatFetchedFor === key) return;   // 这份数据已经取过了，别转圈
    Store.chatStale = true;
    chatApi.fetchPair(pairId).then(() => {
      Store.chatStale = false;
      Store.chatFetchedFor = key;
      renderChatRoom();
    }, () => { Store.chatStale = false; });
  }

  /** 房间详情变了（新消息 / 换轮次）就重新拉一份完整记录 */
  function syncChatData() {
    const id = Store.chatId;
    const pair = pairOf(id);
    if (!pair) return;
    const mine = messagesIn(id);
    if (mine === null) return;                     // 已经是最新的
    if (!pair.chat && !(Store.localChat[id] || []).length) return;  // 还没人说话，不必拉
    scheduleChatRefresh(id, mine.length);
  }

  function renderChatRoom() {
    if (!$('#view-chat').classList.contains('on')) return;
    const data = chatView();
    const badge = $('#mymatch-pill');

    if (!data) {
      window.Chat.reset();
      $('#chat-head').innerHTML = '';
      $('#chat-topics').innerHTML = '';
      $('#chat-peer').innerHTML = '';
      $('#chat-hint').textContent = '';
      $('#chat-text').disabled = true;
      $('#chat-send').disabled = true;
      $('#chat-msgs').innerHTML =
        '<div class="chat-empty">' + icon('i-chat') +
        '<strong>还没有进行中的聊天室</strong>' +
        '<p>回到「破冰匹配」点一下「开始匹配」：匹配成功的两个人会一起落到这里，' +
        '各自的手机上也能接着聊。</p>' +
        '<a class="link-btn" href="#/match">' + icon('i-shuffle') + '去开一轮匹配</a>' +
        '</div>';
      renderChatIdentity(null);
      renderChatNotice(null);
      return;
    }

    const pair = data.pair;
    const messages = data.messages || [];
    window.Chat.render({
      pair: pair,
      people: data.people || { a: byId(pair.aId), b: byId(pair.bId) },
      messages: messages,
      me: Store.me,
      now: serverNow(),
      handlers: {
        send: sendChat,
        read: () => chatApi.read(pair.id),
        extend: () => pairAction(pair.id, 'extend', { minutes: 2 }),
        finish: () => finishOne(pair.id)
      }
    });
    renderChatIdentity(pair);
    renderChatNotice(pair);
    if (badge && mySide(pair)) badge.textContent = pair.score + ' 分 · 聊天中';
  }

  /** 打开某个聊天室（拉记录 + 标记已读），供路由和匹配成功后的自动跳转共用 */
  function openChatRoom(id) {
    const pair = pairOf(id);
    if (!pair) { Store.chatId = id; Store.chatData = null; renderChatRoom(); return; }
    const known = Store.chatData && Store.chatData.pair && Store.chatData.pair.id === id;
    if (!known) Store.chatData = null;
    chatApi.fetchPair(id).then(() => {
      renderChatRoom();
      if (pair.chat || (Store.localChat[id] || []).length) chatApi.read(id);
    });
  }

  /**
   * 标记已读，但同一个条数只发一次：SSE 每推一次快照都会走到这里，
   * 不记一笔的话会变成「推一次 → 已读一次 → 服务端再推一次」的循环。
   */
  function markChatRead(id, count) {
    const key = id + '@' + count;
    if (Store.readMarked === key) return;
    Store.readMarked = key;
    chatApi.read(id);
  }

  function renderChat() {
    const hashRoom = roomHash();
    if (hashRoom) Store.chatId = hashRoom.slice('#/chat/'.length);
    else if (!Store.chatId) {
      // 没带房间号的 #/chat：优先我正在进行中的那一间，其次最近开过的
      const last = pairs().filter((p) => p.status === 'active').slice(-1)[0];
      Store.chatId = activePairIdFor(Store.me) || (last ? last.id : '');
    }
    if (Store.chatId && !pairOf(Store.chatId)) Store.chatId = '';
    renderChatRoom();
    if (!Store.chatId) return;

    // 有新消息就重拉：服务端的推送里只带条数摘要，不带全量消息
    const pair = pairOf(Store.chatId);
    if (!pair) return;
    const mine = messagesIn(Store.chatId);
    if (mine === null) return syncChatData();

    const hasOthers = mine.some((m) => m.from !== Store.me);
    if (hasOthers && pairIsActive(pair) && mySide(pair)) markChatRead(Store.chatId, mine.length);
  }

  /* ------------------------------------------------------------- 聊天操作 */

  async function sendChat(explicit) {
    const text = String(explicit == null ? $('#chat-text').value : explicit).trim();
    if (!text) return;
    if (!Store.chatId) return toast('先开一轮匹配再聊', 'err');
    const pair = pairOf(Store.chatId);
    if (!pair) return toast('这个聊天室已经不在了', 'err');
    if (!mySide(pair)) return toast('先在上面的「我是」里选自己', 'err');
    if (!pairIsActive(pair)) return toast('这一轮已经结束，开新一轮再聊', 'err');

    const input = $('#chat-text');
    input.value = '';
    autoGrow(input);
    $('#chat-send').disabled = true;
    Store.readMarked = '';   // 自己发的消息也算已读，让下一次重拉重新记一次

    const r = await chatApi.send(pair.id, text);
    if (r && r.error) {
      toast(r.error, 'err');
      input.value = text;    // 发失败就把话还给用户，别让他重新打一遍
      autoGrow(input);
      $('#chat-send').disabled = false;
      return;
    }
    renderAll();
  }

  async function finishOne(pairId) {
    const pair = pairOf(pairId);
    if (!pair) return;
    if (!confirm('结束这一轮？双方都会看到「已结束」。')) return;
    await pairAction(pairId, 'finish');
    toast('这一轮结束了');
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(140, el.scrollHeight) + 'px';
  }

  /** 「我是谁」变了：换身份、清已读记账、重新渲染聊天室和「谁和我最搭」 */
  function applyIdentity(id, quiet) {
    setMe(id, quiet);
    Store.readMarked = '';
    Store.chatData = null;
    $('#whoami').value = Store.me;
    renderChatRoom();
    renderMyMatches();
    renderControl();
    if (Store.chatId) openChatRoom(Store.chatId);
  }

  function renderScreen() {
    const st = Store.online && Store.state ? Store.state : null;
    const round = st ? st.round : 1;
    const active = pairs().filter((p) => p.status === 'active');
    const people = pool().length;
    const minutes = Math.round((Store.ui.durationSec + 0) / 60);

    $('#screen-round').textContent = '第 ' + round + ' 轮 · ' + settings().event;
    $('#screen-sub').innerHTML = active.length
      ? '<b>' + active.length + '</b> 组正在交流 · 匹配池 ' + people + ' 人'
      : (people < 2
        ? '匹配池 ' + people + ' 人 —— 还不够开一轮，先让身边的人扫码进来'
        : '匹配池 ' + people + ' 人 · 等待主持人开新一轮');

    // 现场唯一需要大屏回答的问题：「我该在手机里输哪个地址」。
    // 复制按钮给的是主持人这台机器的地址栏（不是局域网 IP），
    // 因为「复制到群里给大家点」和「照着投影敲」是两种不同的用法。
    const addr = joinAddress();
    $('#screen-join').innerHTML =
      '<span class="screen-join-label">' + icon('i-users') + '想加入</span>' +
      '<span class="screen-url">' + esc(addr) + '</span>' +
      '<button class="ghost screen-copy" data-copy="' + esc(location.href.split('#')[0]) + '">' +
      icon('i-link') + '复制这条地址</button>';

    $('#screen-foot').innerHTML =
      '<span>规则：每组聊 ' + minutes + ' 分钟，时间到就换人</span>' +
      '<span>·</span><span>匹配成功的两个人会自动进入同一间聊天室</span>' +
      '<span>·</span><span>手机打开上面这个地址就能登记</span>';
  }

  function renderHistory() {
    const done = pairs().filter((p) => p.status !== 'active');
    $('#history-count').textContent = done.length + ' 条';
    $('#history-list').innerHTML = done.slice().reverse().slice(0, 40).map((p) => {
      const A = byId(p.aId), B = byId(p.bId);
      const when = p.createdAt ? new Date(p.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      return '<div class="hist-row"><span class="st ' + esc(p.status) + '">' +
        (p.status === 'done' ? '完成' : '取消') + '</span>' +
        '<span>' + esc(A ? A.name : '?') + ' &amp; ' + esc(B ? B.name : '?') + '</span>' +
        '<span>匹配度 ' + p.score + '</span><span>' + esc(modeLabel(p.mode)) + '</span><span>' + when + '</span></div>';
    }).join('') || '<p class="empty">还没有历史记录。</p>';
  }

  /* --------------------------------------------------------------- 倒计时 */

  let beeped = {};

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain); gain.connect(ac.destination);
      const t = ac.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.start(t); osc.stop(t + 0.95);
      setTimeout(() => ac.close(), 1200);
    } catch (e) { /* 浏览器不给放就算了 */ }
  }

  function tick() {
    const now = serverNow();
    $$('.pair[data-ends]').forEach((el) => {
      const ends = Number(el.dataset.ends) || 0;
      const dur = Number(el.dataset.dur) || 1;
      const numEl = el.querySelector('.timer .num');
      const barEl = el.querySelector('.timer .bar i');
      if (!numEl || !ends) return;
      const left = ends - now;
      numEl.textContent = left > 0 ? mmss(left) : '时间到';
      if (barEl) barEl.style.width = Math.max(0, Math.min(100, left / dur * 100)) + '%';
      const urgent = left <= 60000;
      el.classList.toggle('urgent', urgent);
      // 大屏的倒计时是包在 .screen-bar 里的，变红要作用到整条状态栏上
      const bar = el.closest ? el.closest('.screen-bar') : null;
      if (bar) bar.classList.toggle('urgent', urgent);
      if (left <= 0 && !beeped[el.dataset.pair]) {
        beeped[el.dataset.pair] = true;
        // 时间到的提示音只在这两个页面响：大屏（投影，全场都听得到）
        // 和聊天室（两个人正在聊，该知道时间到了）
        if (document.querySelector('#view-screen.on') || document.querySelector('#view-chat.on')) beep();
      }
    });

    // 大屏总时钟 = 剩余时间最长的那一组
    const active = pairs().filter((p) => p.status === 'active');
    const clock = $('#screen-clock');
    if (active.length) {
      const maxLeft = Math.max.apply(null, active.map((p) => p.endsAt - now));
      clock.textContent = mmss(maxLeft);
    } else {
      clock.textContent = mmss(Store.ui.durationSec * 1000);
    }
  }

  setInterval(tick, 250);

  /* --------------------------------------------------------------- 操作 */

  async function doMatch() {
    const btn = $('#btn-match');
    btn.disabled = true;
    const payload = { mode: Store.ui.mode, count: Store.ui.count, durationSec: Store.ui.durationSec };
    let created = [];
    let bye = null;
    try {
      if (Store.online) {
        const res = await fetch('./api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '匹配失败');
        created = data.pairs || [];
        bye = data.bye;
        $('#match-msg').textContent = '第 ' + data.round + ' 轮已开始，' +
          data.pairs.length + ' 组' + (data.bye ? '，' + data.bye.name + ' 轮空' : '');
        toast('已开出 ' + data.pairs.length + ' 组');
      } else {
        // 离线模式：本地算法直接算，规则与服务端完全一致
        const busy = new Set();
        Store.localPairs.forEach((p) => { if (p.status === 'active') { busy.add(p.aId); busy.add(p.bId); } });
        const avail = Store.localPool.filter((p) => !busy.has(p.id));
        if (avail.length < 2) throw new Error('匹配池不足 2 人（离线模式只算本机登记的）');
        const plan = M.planMatches(avail, { mode: payload.mode, count: payload.count, history: history() });
        const now = Date.now();
        plan.pairs.forEach((pr) => {
          const created_pair = {
            id: uid('lm'), aId: pr.a.id, bId: pr.b.id, score: pr.score, dims: pr.dims, max: pr.max,
            reasons: pr.reasons, topics: pr.topics, mode: payload.mode,
            durationSec: payload.durationSec, extendedSec: 0, msgCount: 0, lastMsgAt: 0, readsAt: {},
            createdAt: now, endsAt: now + payload.durationSec * 1000, status: 'active'
          };
          Store.localPairs.push(created_pair);
          created.push(created_pair);
        });
        saveLocal();
        Store.localBye = plan.bye ? plan.bye.id : null;
        bye = plan.bye;
        $('#match-msg').textContent = '（离线模式）已开出 ' + plan.pairs.length + ' 组';
        toast('已开出 ' + plan.pairs.length + ' 组');
      }
      Store.uiTouched = false; // 这轮已经按我的参数开了，之后跟着服务端走

      // 匹配成功 → 直接进聊天室。
      // 手机端通常早就在手机上选过自己是谁，所以 SSE 一到就会被自动带进同一间房；
      // 主持人这台机器优先进「我在里面」的那一组，我谁也不是就进第一组。
      const minePair = created.find((p) => mySide(p)) || created[0];
      if (minePair) {
        if (mySide(minePair)) Store.navigatedFor = minePair.id;   // 别再报一次「匹配成功」
        location.hash = '#/chat/' + minePair.id;
        Store.autoNav = true;
        Store.chatId = minePair.id;
        Store.chatData = null;
        openChatRoom(minePair.id);
      }
      renderAll();
    } catch (e) {
      $('#match-msg').textContent = e.message;
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function pairAction(pairId, action, payload) {
    if (Store.online) {
      try {
        const res = await fetch('./api/pairs/' + encodeURIComponent(pairId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ action: action }, payload || {}))
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '操作失败');
      } catch (e) { return toast(e.message, 'err'); }
    } else {
      const p = Store.localPairs.find((x) => x.id === pairId);
      if (!p) return;
      if (action === 'extend') { p.endsAt += 120000; p.extendedSec = (p.extendedSec || 0) + 120; }
      else if (action === 'finish') { p.status = 'done'; p.finishedAt = Date.now(); }
      else if (action === 'cancel') { p.status = 'cancelled'; p.finishedAt = Date.now(); }
      saveLocal();
    }
    renderPairs();
  }

  async function finishAll() {
    const active = pairs().filter((p) => p.status === 'active');
    if (!active.length) return toast('当前没有进行中的配对');
    if (!confirm('结束全部 ' + active.length + ' 组？')) return;
    if (Store.online) {
      await Promise.all(active.map((p) => fetch('./api/pairs/' + encodeURIComponent(p.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish' })
      })));
    } else {
      active.forEach((p) => { p.status = 'done'; p.finishedAt = Date.now(); });
      saveLocal();
    }
    renderPairs();
    toast('已结束全部');
  }

  async function clearPairs() {
    if (!confirm('清空所有配对记录？（匹配池里的人保留）')) return;
    if (Store.online) {
      await fetch('./api/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'pairs' })
      });
    } else {
      Store.localPairs = [];
      saveLocal();
    }
    renderPairs(); renderMyMatches();
    toast('配对记录已清空');
  }

  /* --------------------------------------------------------------- 路由 */

  function route() {
    const hash = location.hash || '#/card';
    const shared = hash.match(/^#\/c\/(.+)$/);
    const chat = hash.match(/^#\/chat\/([\w-]+)/);
    let name = 'card';
    if (shared) name = 'shared';
    else if (chat || hash.indexOf('#/chat') === 0) name = 'chat';
    else if (hash.indexOf('#/match') === 0) name = 'match';
    else if (hash.indexOf('#/screen') === 0) name = 'screen';

    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
    $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));

    if (name === 'shared') {
      const p = decodeProfile(decodeURIComponent(shared[1]));
      if (!p) {
        $('#shared-title').textContent = '这个分享链接坏了';
        return;
      }
      window.Card.render($('#shared-canvas'), p, { event: p.event || '黑客松现场' });
      $('#shared-title').textContent = p.name + ' 的组队名片';
      $('#btn-shared-contact').onclick = () => toast(p.contact ? ('联系方式：' + p.contact) : 'TA 没填联系方式');
      $('#btn-shared-copy').onclick = () => copyText(location.href);
      $('#btn-shared-mine').onclick = () => { location.hash = '#/card'; };
    }

    if (name === 'chat') {
      // 打开聊天室：拉一次完整记录，并把「看到这里了」回报给服务端
      const wanted = chat ? chat[1] : Store.chatId;
      if (wanted && wanted !== Store.chatId) {
        if (!Store.autoNav) Store.navigatedFor = '';   // 用户自己手点进来的，允许下次自动跳转
        Store.chatId = wanted;
        Store.chatData = null;
      }
      Store.autoNav = false;
      openChatRoom(Store.chatId);
    }

    tick();
  }

  /* --------------------------------------------------------------- 连接服务端 */

  function setConn(state, text) {
    const el = $('#conn');
    el.className = 'conn ' + state;
    el.querySelector('span').textContent = text;
    $('#foot-mode').textContent = state === 'on'
      ? (Store.noSse ? '已连服务端（不实时刷新）' : '已连服务端（多设备同步）')
      : '单机模式（数据只在这台设备）';
  }

  function applyState(snap) {
    Store.state = snap;
    Store.offset = snap.now - Date.now();
    // 服务端设置跟着「最近一次实际开局」走；但如果用户正在自己调参数，就别打断他
    if (snap.settings && !Store.uiTouched) {
      Store.ui.durationSec = snap.settings.durationSec;
      Store.ui.count = snap.settings.count;
      Store.ui.mode = snap.settings.mode;
    }
    renderAll();
    // 匹配成功的这一刻，把配对里的两个人各自带到自己的聊天室
    // （主持人点「开始匹配」时由 doMatch 直接跳，其余手机靠这一条）
    if (Store.me) {
      const mine = pairs().find((p) =>
        pairIsActive(p, snap.now) && (p.aId === Store.me || p.bId === Store.me));
      if (mine) autoEnterChat(mine);
    }
  }

  async function connect() {
    // ?offline=1 强制单机模式：活动现场网络不稳、或者只是想先看看界面时用
    if (/[?&]offline=1/.test(location.search)) {
      Store.online = false;
      Store.localReason = 'forced';
      setConn('off', '单机模式（?offline=1）');
      renderAll();
      return;
    }
    // ?nosse=1 只拉一次数据、不订阅实时推送：投屏机长时间挂着、或者弱网时更省心
    Store.noSse = /[?&]nosse=1/.test(location.search);
    try {
      const res = await fetch('./api/state', { cache: 'no-store' });
      // 静态托管（GitHub Pages 之类）这里会返回 404 的 HTML，内容不是 JSON，
      // 所以状态码和 Content-Type 都要看一眼，别把 404 页面当数据解析。
      if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) {
        throw new Error('这个地址没有服务端接口');
      }
      // 注意顺序：必须先切成在线，再渲染，否则第一次渲染读的还是本地空池子
      Store.online = true;
      applyState(await res.json());
      setConn('on', Store.noSse ? '已连服务端（本次不实时刷新）' : '已连接 · 多设备同步');
    } catch (e) {
      Store.online = false;
      Store.localReason = location.protocol === 'file:' ? 'file' : 'static';
      setConn('off', '单机模式');
      renderAll();
      return;
    }
    if (Store.noSse) return;

    const es = new EventSource('./api/stream');
    es.addEventListener('state', (ev) => {
      try { applyState(JSON.parse(ev.data)); } catch (e) { /* 忽略半包 */ }
    });
    es.onopen = () => { Store.online = true; setConn('on', '已连接 · 多设备同步'); };
    es.onerror = () => { Store.online = false; setConn('off', '连接断开，正在重连…'); };
  }

  /* ------------------------------------------------- 单机模式说明 + 演示数据 */

  const demoPeople = () => (window.HackathonDemoPeople && window.HackathonDemoPeople.people) || [];

  /**
   * 把演示参与者塞进本机匹配池。
   * 静态部署时匹配池默认是空的 —— 打开网站的人只会看到「还没有配对」，
   * 根本没有东西可试。这个按钮让任何人都能立刻看到完整效果。
   */
  function loadDemo() {
    const demo = demoPeople();
    if (!demo.length) return toast('演示数据没加载进来', 'err');
    let added = 0;
    demo.forEach((p) => {
      const clean = M.normalizeProfile(p);
      if (Store.localPool.some((x) => M.norm(x.name) === M.norm(clean.name))) return;
      clean.id = uid('l');
      Store.localPool.push(clean);
      added++;
    });
    saveLocal();
    renderAll();
    toast(added ? ('已载入 ' + added + ' 个演示参与者，去「破冰匹配」点开始匹配') : '演示参与者都已经在池子里了');
  }

  function renderNotice() {
    const box = $('#notice');
    if (!box) return;
    if (Store.online || Store.noticeDismissed) { box.hidden = true; return; }

    const why = Store.localReason === 'forced' ? '（?offline=1）'
      : Store.localReason === 'file' ? '（直接打开的本地文件）' : '（这个地址上没有服务端）';
    const n = demoPeople().length;

    box.hidden = false;
    box.innerHTML =
      '<div class="notice-icon">' + icon('i-users') + '</div>' +
      '<div class="notice-body">' +
      '<strong>单机模式' + why + '</strong>' +
      '<p>名片、下载 PNG、分享链接、配对和倒计时都能正常用，' +
      '但<b>数据只存在这台设备的浏览器里</b>——换一台手机打开，看不到同一个人。' +
      '现场那种「多台手机 + 一块大屏同步」的用法需要跑一下服务端：' +
      '<code>node server.js</code>，README 里有说明。</p>' +
      '</div>' +
      '<div class="notice-actions">' +
      (n ? '<button class="primary js-demo">' + icon('i-users') + '载入 ' + n + ' 个演示参与者</button>' : '') +
      '<button class="ghost" id="btn-notice-close">知道了</button>' +
      '</div>';

    const close = $('#btn-notice-close');
    if (close) {
      close.addEventListener('click', () => {
        Store.noticeDismissed = true;
        lsSet(LS.notice, true);
        renderNotice();
      });
    }
  }

  /* --------------------------------------------------------------- 渲染总入口 */

  function renderAll() {
    renderNotice();
    renderControl();
    renderPool();
    renderWhoami();
    renderPairs();
    renderMyMatches();
    renderChat();
    renderCard();
    noteChat(myPresence().unread || 0);
  }

  /* --------------------------------------------------------------- 事件绑定 */

  function bindMatchUI() {
    $('#mode-list').addEventListener('click', (e) => {
      const card = e.target.closest('.mode-card');
      if (!card) return;
      Store.ui.mode = card.dataset.mode;
      Store.uiTouched = true;
      renderControl();
    });

    $('#seg-duration').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sec]');
      if (!b) return;
      Store.ui.durationSec = Number(b.dataset.sec);
      Store.uiTouched = true;
      renderControl();
    });

    $('#f-count').addEventListener('change', (e) => {
      Store.ui.count = Math.max(1, Math.min(12, Number(e.target.value) || 1));
      Store.uiTouched = true;
      e.target.value = Store.ui.count;
    });

    $('#btn-match').addEventListener('click', doMatch);
    $('#btn-finish-all').addEventListener('click', finishAll);
    $('#btn-clear-pairs').addEventListener('click', clearPairs);

    $('#btn-find').addEventListener('click', renderMyMatches);
    $('#whoami').addEventListener('change', (e) => applyIdentity(e.target.value));

    // 配对卡上的按钮（事件委托，卡片重绘后依然有效）
    const onPairClick = (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const card = btn.closest('.pair');
      if (!card) return;
      const id = card.dataset.pair;
      const act = btn.dataset.act;
      if (act === 'extend') { pairAction(id, 'extend', { minutes: 2 }); toast('已延长 2 分钟'); }
      else if (act === 'finish') { pairAction(id, 'finish'); toast('这组结束了'); }
      else if (act === 'copy') {
        const pair = pairs().find((p) => p.id === id);
        if (pair) copyText(pair.topics.map((t, i) => (i + 1) + '. ' + t).join('\n'));
      }
    };
    $('#pairs').addEventListener('click', onPairClick);

    // 大屏上的「复制这条地址」：主持人投影时常要把它发到群里
    $('#screen-join').addEventListener('click', (e) => {
      const b = e.target.closest('.screen-copy');
      if (b) copyText(b.dataset.copy || '');
    });

    // 「载入演示参与者」可能出现在说明条上，也可能出现在空匹配池里，统一委托
    document.addEventListener('click', (e) => {
      if (e.target.closest('.js-demo')) loadDemo();
    });

    $('#btn-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => toast('这个浏览器不支持全屏', 'err'));
    });
  }

  /** 聊天室的交互：认领身份、发消息、点话题、结束/延长这一轮 */
  function bindChatUI() {
    const text = $('#chat-text');
    const send = $('#chat-send');

    const syncSend = () => { send.disabled = text.disabled || !text.value.trim(); };

    text.addEventListener('input', () => { autoGrow(text); syncSend(); });
    text.addEventListener('keydown', (e) => {
      // Enter 发送、Shift+Enter 换行：手机上 Enter 就是换行，不会误发
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    send.addEventListener('click', () => sendChat());

    // 破冰话题：点一条直接发出去（这本来就是匹配算法的产出，不该只是装饰）
    $('#chat-topics').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-topic]');
      if (!b || b.disabled) return;
      sendChat(b.dataset.topic);
    });

    // 「我是」：现场两个人可能共用一块屏幕，也可能各拿一台手机
    $('#chat-whoami').addEventListener('change', (e) => applyIdentity(e.target.value));
    $('#chat-me-av').addEventListener('click', () => {
      const pair = pairOf(Store.chatId);
      if (!pair) return;
      const other = isOnId(pair.aId) ? pair.bId : pair.aId;
      if (other) applyIdentity(other);
    });

    const peerBox = $('#chat-peer');
    peerBox.addEventListener('click', (e) => {
      const b = e.target.closest('.copy-contact');
      if (b) copyText(b.dataset.contact || '');
    });

    $('#chat-finish').addEventListener('click', () => finishOne(Store.chatId));
    $('#chat-extend').addEventListener('click', () => {
      if (!Store.chatId) return;
      pairAction(Store.chatId, 'extend', { minutes: 2 });
      toast('已延长 2 分钟');
    });

    // 点「聊天」标签进来时，如果手上还没有房间，就挑一个（我在里面的优先）
    $('#tabs a[data-tab=chat]').addEventListener('click', () => {
      if (!Store.chatId) {
        const last = pairs().filter((p) => p.status === 'active').slice(-1)[0];
        Store.chatId = activePairIdFor(Store.me) || (last ? last.id : '');
      }
    });
  }

  /* --------------------------------------------------------------- 启动 */
  function boot() {
    migrateLocal();
    bindForm();
    bindMatchUI();
    bindChatUI();
    Store.ui = {
      mode: settings().mode || 'smart',
      durationSec: settings().durationSec || 300,
      count: settings().count || 1
    };
    renderChips();
    renderAll();
    route();
    window.addEventListener('hashchange', route);
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 调试口子：index.html 里已经有 window.__hsErrors（页面报错直接摊在屏幕上）。
  // 这里把内存状态也挂出去，现场排查「我是谁没认出来 / 消息没到」时能在控制台一眼看清。
  window.__hsStore = Store;
})();
