/*!
 * Hackathon 组队雷达 —— 聊天室渲染器
 * ---------------------------------------------------------------
 * 匹配成功之后，这一轮的两个人在同一个「聊天室」里：配对 ID 就是房间号。
 * 这个文件只负责画：对话气泡、头部状态、倒计时挂在现有的 tick() 上、
 * 右侧对家资料和破冰话题。发消息、进房间、已读都归 app.js 管。
 *
 * 两个渲染上的讲究：
 *   1. 头部和消息列表分开记账（记最后一个消息 id），只在真的变了才动 DOM。
 *      否则 SSE 每推一次快照就会重画一遍，气泡上的文字选择会丢、滚动位置会跳。
 *   2. 输入框、话题条这些「用户正在操作的东西」永远不重建，
 *      只有发送按钮的禁用状态会被更新 —— 打字打到一半丢焦点是最烦的。
 */
(function (root) {
  'use strict';

  const M = root.HackathonRadar;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  // 一次渲染最多铺多少条气泡。聊天记录本来就封顶 300 条，
  // 但手机上铺 300 个节点会卡，所以只取最后 120 条（更早的用一句提示带过）。
  const MAX_BUBBLES = 120;

  let lastHeadKey = '';
  let lastMsgId = '';
  let lastCount = -1;
  let lastRoom = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '"><use href="#' + name + '"/></svg>';
  }

  function avatar(p, cls) {
    if (!p) return '<span class="avatar ' + (cls || '') + '">?</span>';
    const c = M.avatarColors(p.name || '?');
    const style = 'background:linear-gradient(135deg,' + c.from + ',' + c.to + ')';
    if (p.avatar && M.AVATAR_RE.test(p.avatar)) {
      return '<span class="avatar ' + (cls || '') + '" style="' + style + '">' +
        '<img src="./avatars/' + esc(p.avatar) + '.png" alt="" loading="lazy"></span>';
    }
    return '<span class="avatar ' + (cls || '') + '" style="' + style + '">' +
      esc(M.initials(p.name)) + '</span>';
  }

  function timeLabel(ms) {
    const d = new Date(ms);
    const hh = ('0' + d.getHours()).slice(-2);
    const mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
  }

  function isActive(pair, now) {
    return pair.status === 'active' && Number(pair.endsAt) > now;
  }

  /**
   * 渲染整个聊天室
   * @param {object} ctx {
   *   pair, people:{a,b}, messages:[], me, now,
   *   handlers:{ send, read, extend, finish }
   * }
   */
  function render(ctx) {
    const pair = ctx.pair;
    if (!pair) return;
    const host = $('#view-chat');
    if (!host || !host.classList.contains('on')) return;   // 没在看聊天页就别白干活

    const me = ctx.me;
    const A = ctx.people.a, B = ctx.people.b;
    const peer = me === pair.aId ? B : (me === pair.bId ? A : null);
    const mine = me === pair.aId || me === pair.bId;
    const now = ctx.now || Date.now();
    const active = isActive(pair, now);
    const msgs = ctx.messages || [];

    renderHead(pair, A, B, peer, active, mine, ctx);
    renderMessages(pair, msgs, me, mine, ctx);

    // ---- 话题条：只在换房间时重建（点一下就是一条消息） ----
    if (lastRoom !== pair.id) {
      $('#chat-topics').innerHTML = topicsHtml(pair);
    }
    // ---- 侧栏 + 输入区：跟房间绑定，但状态每次都要刷新 ----
    renderPeer(peer, pair, active, mine);
    renderComposer(pair, msgs, active, mine, ctx);
    lastRoom = pair.id;
  }

  function renderHead(pair, A, B, peer, active, mine, ctx) {
    const key = [pair.id, active, mine, peer ? peer.id : '', pair.status,
      pair.extendedSec || 0].join('|');
    if (key === lastHeadKey) return;
    lastHeadKey = key;

    const status = pair.status === 'active'
      ? (active ? '交流中' : '时间到')
      : (pair.status === 'done' ? '已结束' : '已取消');
    const badgeCls = active ? 'ok' : (pair.status === 'active' ? 'warn' : 'mute');
    const who = mine
      ? (peer ? '你和 ' + esc(peer.name) : '等待对方')
      : '观战模式（先在上面选「我是」）';

    $('#chat-head').innerHTML =
      '<div class="chat-who">' +
      avatar(A, 'lg') +
      '<span class="chat-who-txt">' +
      '<span class="chat-names"><strong>' + esc(A ? A.name : '?') + '</strong>' +
      '<em>和</em><strong>' + esc(B ? B.name : '?') + '</strong></span>' +
      '<span class="chat-sub">' + who + '</span></span>' +
      avatar(B, 'lg') +
      '</div>' +
      '<div class="chat-head-right">' +
      '<span class="badge ' + badgeCls + '">' + status + '</span>' +
      '<span class="badge">匹配度 ' + pair.score + '</span>' +
      '<div class="timer chat-timer"><div class="num">--:--</div>' +
      '<div class="bar"><i style="width:100%"></i></div></div>' +
      '</div>';

    // 倒计时复用 app.js 里那个每 250ms 跑的 tick()：它扫的是 .pair[data-ends]，
    // 这里把同样的属性挂到聊天头部上，不用再写第二套计时逻辑。
    const head = $('#chat-head');
    const box = head.querySelector('.timer');
    if (box) {
      box.classList.add('pair');
      box.dataset.ends = pair.status === 'active' ? pair.endsAt : 0;
      box.dataset.pair = pair.id + '-chat';
      box.dataset.dur = (pair.durationSec + (pair.extendedSec || 0)) * 1000;
    }
  }

  function renderMessages(pair, all, me, mine, ctx) {
    const box = $('#chat-msgs');
    if (!box) return;

    if (!all.length) {
      if (lastMsgId === '@empty:' + pair.id) return;
      lastMsgId = '@empty:' + pair.id;
      lastCount = 0;
      box.innerHTML =
        '<div class="chat-empty">' +
        icon('i-chat') +
        '<strong>还没有人开口</strong>' +
        '<p>右边那 3 条破冰话题是按你们的资料算出来的，挑一条先问出去。<br>' +
        '点话题就能直接发出来。</p>' +
        (mine ? '' : '<p class="mini">你现在是观战模式，先选「我是」才能发言。</p>') +
        '</div>';
      return;
    }

    const last = all[all.length - 1];
    const key = last.id + '|' + all.length + '|' + me;
    if (key === lastMsgId) return;   // 没有新消息，不碰 DOM（保住选中和滚动位置）
    const grew = all.length > lastCount && lastCount >= 0;
    lastMsgId = key;
    lastCount = all.length;

    const shown = all.slice(-MAX_BUBBLES);
    const cut = all.length - shown.length;
    const head = cut > 0
      ? '<p class="chat-more">省略了更早的 ' + cut + ' 条消息</p>' : '';

    box.innerHTML = head + shown.map((mm) => {
      const isMine = mm.from === me;
      const other = !isMine && mine;         // 观战模式下所有消息都不算「我的」
      const cls = 'msg ' + (isMine ? 'me' : (other ? 'peer' : 'who'));
      const nameTag = isMine ? '我' : ((ctx.people.a && mm.from === pair.aId)
        ? ctx.people.a.name : (ctx.people.b ? ctx.people.b.name : '?'));
      return '<div class="' + cls + '" data-from="' + esc(mm.from) + '">' +
        '<div class="bubble"><span class="txt">' + esc(mm.text) + '</span>' +
        '<span class="ts">' + timeLabel(mm.at) + '</span></div>' +
        '<span class="who-tag">' + esc(nameTag) + '</span>' +
        '</div>';
    }).join('');

    // 只有「新消息进来」或「刚打开房间」才滚到底；
    // 正在往上翻记录时被强行拽回底部是最劝退的体验。
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (grew || nearBottom || lastCount <= 1) {
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }
  }

  function topicsHtml(pair) {
    const list = (pair.topics || []).slice(0, 3);
    if (!list.length) return '';
    return '<span class="mini topics-label">' + icon('i-target') + '点一条直接发出去：</span>' +
      list.map((t) =>
        '<button type="button" class="topic-chip" data-topic="' + esc(t) + '">' + esc(t) + '</button>'
      ).join('');
  }

  function renderPeer(peer, pair, active, mine) {
    const box = $('#chat-peer');
    const key = [peer ? peer.id : '', active, mine, pair.status].join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;

    if (!peer) {
      box.innerHTML = '<p class="empty">还没认出你是谁 —— 在上面选一下「我是」，' +
        '就能看到对面那个人的资料、也能开口说话。</p>';
      return;
    }
    const skills = (peer.skills || []).map((s) =>
      '<span class="chip" data-level="' + esc(s.level) + '">' + esc(s.name) +
      '<span class="lv">' + esc(M.levelLabel(s.level)) + '</span></span>').join('');
    const looks = (peer.lookingFor || []).map((x) =>
      '<span class="chip look">' + esc(x) + '</span>').join('');
    const interests = (peer.interests || []).map((x) =>
      '<span class="chip plain">' + esc(x) + '</span>').join('');

    box.innerHTML =
      '<div class="peer-head">' + avatar(peer, 'xl') +
      '<div><strong>' + esc(peer.name) + '</strong>' +
      '<span class="tag">' + esc(peer.tagline || '（还没写一句话介绍）') + '</span></div></div>' +
      '<div class="peer-block"><label>技能</label><div class="chips">' + (skills || '<span class="mini">没填</span>') + '</div></div>' +
      '<div class="peer-block"><label>兴趣</label><div class="chips">' + (interests || '<span class="mini">没填</span>') + '</div></div>' +
      (looks ? '<div class="peer-block"><label>TA 在找</label><div class="chips">' + looks + '</div></div>' : '') +
      (peer.contact
        ? '<div class="peer-block"><label>联系方式</label>' +
          '<button type="button" class="copy-contact" data-contact="' + esc(peer.contact) + '">' +
          icon('i-link') + esc(peer.contact) + '</button></div>'
        : '<div class="peer-block"><label>联系方式</label><span class="mini">TA 没填，聊完直接在屋里找人吧</span></div>') +
      (pair.reasons && pair.reasons.length
        ? '<div class="peer-block"><label>为什么是你们</label><ul class="reasons">' +
          pair.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></div>'
        : '');
  }

  function renderComposer(pair, msgs, active, mine, ctx) {
    const text = $('#chat-text');
    const btn = $('#chat-send');
    if (!text || !btn) return;
    const open = active && mine;
    text.disabled = !open;
    btn.disabled = !open || !text.value.trim();
    $$('#chat-topics button').forEach((b) => { b.disabled = !open; });

    const others = msgs.filter((m) => m.from !== ctx.me).length;
    $('#chat-hint').textContent = !mine
      ? '你是观战模式：先在上面选「我是」再发言。'
      : (!active
        ? '这一轮已经结束，聊天室还能看，但发不了新消息了。点「开一轮」换人。'
        : (others === 0 && msgs.length === 0
          ? '还没有人说话 —— 发第一条的人往往最占便宜。'
          : '消息实时同步，对面那台手机不用刷新。'));
  }

  /** 切换房间时要把记账清掉，否则新房间的第一屏会被当成「没变化」而不画 */
  function reset() {
    lastHeadKey = '';
    lastMsgId = '';
    lastCount = -1;
    lastRoom = '';
    const peer = $('#chat-peer');
    if (peer) peer.dataset.key = '';
    const btn = $('#chat-send');
    if (btn) btn.disabled = true;
  }

  root.Chat = { render: render, reset: reset };
})(typeof self !== 'undefined' ? self : this);
