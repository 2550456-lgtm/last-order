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
    me: lsGet(LS.me, ''),
    ui: { mode: 'smart', durationSec: 300, count: 1 },
    uiTouched: false,
    // 单机模式的原因：forced=?offline=1 / file=直接双击 html / static=静态托管没有接口
    localReason: '',
    noticeDismissed: lsGet(LS.notice, false),
    noSse: false
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

  function sideHtml(p, small) {
    if (!p) return '<div class="side"><strong>？</strong></div>';
    const skills = p.skills.slice(0, small ? 3 : 4);
    return '<div class="side">' + avatarHtml(p.name, small ? '' : 'lg', p.avatar) +
      '<strong>' + esc(p.name) + '</strong>' +
      '<span class="tag">' + esc(p.tagline || '') + '</span>' +
      '<span class="sk">' + skills.map((s) => '<span>' + esc(s.name) + '</span>').join('') + '</span>' +
      '<span class="sk">' + p.interests.slice(0, small ? 2 : 3).map((s) =>
        '<span style="background:rgba(168,85,247,.16);color:#d8b4fe">' + esc(s) + '</span>').join('') + '</span>' +
      '</div>';
  }

  function modeLabel(id) {
    const m = M.MODES.find((x) => x.id === id);
    return m ? m.label : id;
  }

  function pairHtml(pair, opts) {
    opts = opts || {};
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
    $('#screen-pairs').innerHTML = active.length
      ? active.map((p) => pairHtml(p, { big: true })).join('')
      : '<p class="empty">还没有进行中的配对。点右上角「开一轮」。</p>';
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

  function renderScreen() {
    const st = Store.online && Store.state ? Store.state : null;
    const round = st ? st.round : 1;
    const active = pairs().filter((p) => p.status === 'active');
    $('#screen-round').textContent = '第 ' + round + ' 轮 · ' + settings().event;
    $('#screen-sub').textContent = active.length
      ? active.length + ' 组正在交流 · 匹配池 ' + pool().length + ' 人'
      : '匹配池 ' + pool().length + ' 人 · 等待开始';
    $('#screen-foot').innerHTML =
      '<span>想加入：手机浏览器打开 ' + esc(joinAddress()) + '</span>' +
      '<span>·</span><span>规则：每组聊 ' + Math.round(Store.ui.durationSec / 60) + ' 分钟，时间到就换人</span>';
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
      if (left <= 0 && !beeped[el.dataset.pair]) {
        beeped[el.dataset.pair] = true;
        if (document.querySelector('#view-screen.on')) beep();
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
    try {
      if (Store.online) {
        const res = await fetch('./api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '匹配失败');
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
          Store.localPairs.push({
            id: uid('lm'), aId: pr.a.id, bId: pr.b.id, score: pr.score, dims: pr.dims, max: pr.max,
            reasons: pr.reasons, topics: pr.topics, mode: payload.mode,
            durationSec: payload.durationSec, extendedSec: 0,
            createdAt: now, endsAt: now + payload.durationSec * 1000, status: 'active'
          });
        });
        saveLocal();
        Store.localBye = plan.bye ? plan.bye.id : null;
        $('#match-msg').textContent = '（离线模式）已开出 ' + plan.pairs.length + ' 组';
        toast('已开出 ' + plan.pairs.length + ' 组');
      }
      Store.uiTouched = false; // 这轮已经按我的参数开了，之后跟着服务端走
      renderPairs();
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
    let name = 'card';
    if (shared) name = 'shared';
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
    renderCard();
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
    $('#btn-screen-match').addEventListener('click', doMatch);
    $('#btn-finish-all').addEventListener('click', finishAll);
    $('#btn-screen-finish').addEventListener('click', finishAll);
    $('#btn-clear-pairs').addEventListener('click', clearPairs);

    $('#btn-find').addEventListener('click', renderMyMatches);
    $('#whoami').addEventListener('change', (e) => {
      Store.me = e.target.value;
      lsSet(LS.me, Store.me);
      if (Store.me) {
        const p = byId(Store.me);
        if (p) toast('已切换身份：' + p.name);
      }
      renderMyMatches();
    });

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
    $('#screen-pairs').addEventListener('click', onPairClick);

    // 「载入演示参与者」可能出现在说明条上，也可能出现在空匹配池里，统一委托
    document.addEventListener('click', (e) => {
      if (e.target.closest('.js-demo')) loadDemo();
    });

    $('#btn-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => toast('这个浏览器不支持全屏', 'err'));
    });
  }

  /* --------------------------------------------------------------- 启动 */

  function boot() {
    bindForm();
    bindMatchUI();
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
})();
