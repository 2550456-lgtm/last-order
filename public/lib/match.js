/*!
 * HackMatch · 组队雷达 —— 匹配算法内核
 * ---------------------------------------------------------------
 * 这份文件被两边同时加载：
 *   1. 浏览器：<script src="/lib/match.js">  → window.HackMatch
 *   2. Node 服务端：require('../public/lib/match.js')
 * 目的：算分逻辑只有一份，前端展示的「匹配度」和真正配对用的分数永远一致。
 *
 * 打分维度（满分 100）：
 *   技能互补 30  你会、TA 想学（可互相带）
 *   共同技能 10  双方都会用以上，能一起攻坚
 *   兴趣重合 25  兴趣集合的 Jaccard 相似度
 *   角色互补 30  TA 在找的角色正好是我擅长的（双向各 15）
 *   新鲜度    5  没配对过 +5，配过则递减（避免一晚上老是同一对人）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HackMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LEVELS = [
    { id: 'learn', label: '想学', rank: 1 },
    { id: 'know', label: '会用', rank: 2 },
    { id: 'pro', label: '熟练', rank: 3 }
  ];

  var MODES = [
    { id: 'smart', label: '智能互补', desc: '按互补度加权随机，最容易凑出能干活的组合' },
    { id: 'interest', label: '兴趣同好', desc: '优先兴趣重合度高的人，适合纯聊天破冰' },
    { id: 'random', label: '完全随机', desc: '等概率抽签，最公平也最容易撞见陌生人' }
  ];

  var MAX = { complement: 30, shared: 10, interest: 25, role: 30, novelty: 5 };

  /* 兜底破冰话题：双方数据太少时用，按配对指纹确定性地挑 3 条 */
  var FALLBACK_TOPICS = [
    '用 60 秒说清：你最近一次熬夜在折腾什么？',
    '如果只给你 24 小时和一个队友，你想做出什么最小可用的东西？',
    '你身上最想安利给别人的一个工具或习惯是什么？',
    '这次活动你最怕掉进哪个坑？提前说出来，让对方帮你盯着。',
    '活动结束时，你希望自己手里多了什么？',
    '说一个你完全不懂、但一直想学的技能，看看对方会不会。'
  ];

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function levelRank(level) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === level) return LEVELS[i].rank;
    return 2;
  }

  function levelLabel(level) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === level) return LEVELS[i].label;
    return '会用';
  }

  /* 稳定哈希：用来给头像配色、挑兜底话题做确定性选择 */
  function hash(str) {
    var h = 2166136261;
    str = String(str == null ? '' : str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* 由名字推导头像双色（决定论，同名同色，不需要任何图片素材） */
  function avatarColors(name) {
    var h = hash(name || 'anon');
    var hue = h % 360;
    return {
      from: 'hsl(' + hue + ', 78%, 62%)',
      to: 'hsl(' + ((hue + 48) % 360) + ', 72%, 46%)'
    };
  }

  function initials(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return '?';
    // 中文取后两字（更像称呼），英文取首字母
    if (/[\u4e00-\u9fa5]/.test(s)) return s.length <= 2 ? s : s.slice(-2);
    var parts = s.split(/[\s_-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function skillMap(p) {
    var m = {};
    (p.skills || []).forEach(function (s) {
      if (s && s.name) m[norm(s.name)] = s;
    });
    return m;
  }

  function setOf(list) {
    var s = {};
    (list || []).forEach(function (x) { if (x) s[norm(x)] = true; });
    return s;
  }

  function keysOf(obj) {
    return Object.keys(obj);
  }

  /* 历史配对次数：history 是 [{a:'id', b:'id'}] */
  function timesPaired(history, idA, idB) {
    var n = 0;
    (history || []).forEach(function (h) {
      if (!h) return;
      if ((h.a === idA && h.b === idB) || (h.a === idB && h.b === idA)) n++;
    });
    return n;
  }

  /**
   * 两个人的完整体检报告：分数、各维度拆解、人话理由、破冰话题。
   * @param {object} a 参与者 a
   * @param {object} b 参与者 b
   * @param {array}  history 历史配对记录
   */
  function pairDetail(a, b, history) {
    var am = skillMap(a), bm = skillMap(b);
    var dims = { complement: 0, shared: 0, interest: 0, role: 0, novelty: 0 };
    var reasons = [];
    var topics = [];
    var teach = [];      // 可以互相教的技能
    var sharedSkills = []; // 双方都会的技能

    keysOf(am).forEach(function (k) {
      var sb = bm[k];
      if (!sb) return;
      var sa = am[k];
      var ra = levelRank(sa.level), rb = levelRank(sb.level);
      if (ra >= 3 && rb === 1) teach.push({ from: a, to: b, skill: sa.name });
      else if (rb >= 3 && ra === 1) teach.push({ from: b, to: a, skill: sb.name });
      else if (ra >= 2 && rb >= 2) sharedSkills.push(sa.name);
    });

    // 1）技能互补
    dims.complement = Math.round(Math.min(3, teach.length) / 3 * MAX.complement);
    teach.slice(0, 2).forEach(function (t) {
      reasons.push(t.from.name + ' 会 ' + t.skill + '，' + t.to.name + ' 想学 —— 可以当场互相带一带');
    });

    // 2）共同技能
    dims.shared = Math.round(Math.min(2, sharedSkills.length) / 2 * MAX.shared);
    if (sharedSkills.length) {
      reasons.push('你们都熟悉 ' + sharedSkills.slice(0, 3).join('、') + '，能直接拼一个能跑的东西');
    }

    // 3）兴趣重合（Jaccard）
    var ai = setOf(a.interests), bi = setOf(b.interests);
    var inter = keysOf(ai).filter(function (k) { return bi[k]; });
    var unionMap = {};
    keysOf(ai).concat(keysOf(bi)).forEach(function (k) { unionMap[k] = true; });
    var union = keysOf(unionMap);
    var jac = union.length ? inter.length / union.length : 0;
    dims.interest = Math.round(jac * MAX.interest);
    if (inter.length) {
      reasons.push('共同兴趣：' + inter.slice(0, 4).join('、'));
    }

    // 4）角色互补（双向）
    var wantsA = setOf(a.lookingFor), wantsB = setOf(b.lookingFor);
    var hitAB = keysOf(bm).filter(function (k) {
      return wantsA[k] && levelRank(bm[k].level) >= 2;
    });
    var hitBA = keysOf(am).filter(function (k) {
      return wantsB[k] && levelRank(am[k].level) >= 2;
    });
    if (hitAB.length) {
      dims.role += 15;
      reasons.push(a.name + ' 正在找「' + hitAB[0] + '」，' + b.name + ' 正好会');
    }
    if (hitBA.length) {
      dims.role += 15;
      reasons.push(b.name + ' 正在找「' + hitBA[0] + '」，' + a.name + ' 正好会');
    }
    dims.role = Math.min(MAX.role, dims.role);

    // 5）新鲜度：没配过加分，配过的按次数衰减
    var times = timesPaired(history, a.id, b.id);
    dims.novelty = times === 0 ? MAX.novelty : -Math.min(20, times * 8);

    var score = clamp(
      dims.complement + dims.shared + dims.interest + dims.role + dims.novelty,
      0, 100
    );

    // ---- 破冰话题：先给个性化的，再用兜底话题补齐到 3 条 ----
    teach.slice(0, 1).forEach(function (t) {
      topics.push('先让 ' + t.from.name + ' 用一句话说出 ' + t.skill + ' 最容易踩的坑，' +
        t.to.name + ' 负责追问「为什么」。');
    });
    if (inter.length) {
      topics.push('你们都对「' + inter[0] + '」感兴趣：各自说说最近一次为它花时间是什么时候？');
    }
    if (sharedSkills.length) {
      topics.push('你们都熟悉 ' + sharedSkills[0] + '：聊聊各自踩过的最大一个坑，看能不能拼出共同方案。');
    }
    if (hitAB.length) {
      topics.push(a.name + ' 在找「' + hitAB[0] + '」：直接问 ' + b.name + '，这次愿不愿意一起做？');
    }
    if (hitBA.length) {
      topics.push(b.name + ' 在找「' + hitBA[0] + '」：直接问 ' + a.name + '，这次愿不愿意一起做？');
    }
    if (a.tagline) topics.push('让 ' + a.name + ' 展开讲讲「' + a.tagline + '」，这句话背后是什么。');
    if (b.tagline) topics.push('让 ' + b.name + ' 展开讲讲「' + b.tagline + '」，这句话背后是什么。');

    var seed = hash(String(a.id) + '|' + String(b.id));
    for (var i = 0; topics.length < 3 && i < FALLBACK_TOPICS.length; i++) {
      var pick = FALLBACK_TOPICS[(seed + i * 7) % FALLBACK_TOPICS.length];
      if (topics.indexOf(pick) === -1) topics.push(pick);
    }

    // 理由太多就截断，UI 只展示前 3 条
    var uniqueReasons = reasons.filter(function (r, i) { return reasons.indexOf(r) === i; });

    return {
      score: score,
      dims: dims,
      max: MAX,
      jaccard: jac,
      teach: teach,
      sharedSkills: sharedSkills,
      sharedInterests: inter,
      timesPaired: times,
      reasons: uniqueReasons.slice(0, 3),
      topics: topics.slice(0, 3)
    };
  }

  /* 按模式把分数翻译成抽签权重，再用轮盘赌抽 —— 保证「随机」是真的随机，只是有偏好 */
  function weightOf(detail, mode, history, a, b) {
    var w;
    if (mode === 'random') {
      w = 1;
    } else if (mode === 'interest') {
      w = 0.3 + 2.7 * detail.jaccard;
    } else {
      w = 0.25 + 2.75 * Math.pow(detail.score / 100, 2);
    }
    var times = timesPaired(history, a.id, b.id);
    if (times > 0) w *= Math.pow(0.25, times); // 老搭档快速降权，但不断路
    return w;
  }

  /**
   * 生成一轮配对方案。
   * @param {array}  pool   参与者数组
   * @param {object} opts   { mode, count, history, rng, exclude:Set-like }
   * @returns {{pairs:array, bye:object|null, unmatched:array}}
   */
  function planMatches(pool, opts) {
    opts = opts || {};
    var mode = opts.mode || 'smart';
    var count = Math.max(1, Math.min(12, opts.count || 1));
    var history = opts.history || [];
    var rng = opts.rng || Math.random;

    var remaining = (pool || []).filter(function (p) { return p && p.id; });
    var out = [];

    for (var n = 0; n < count && remaining.length >= 2; n++) {
      var cands = [];
      var total = 0;
      for (var i = 0; i < remaining.length; i++) {
        for (var j = i + 1; j < remaining.length; j++) {
          var a = remaining[i], b = remaining[j];
          var detail = pairDetail(a, b, history);
          var w = weightOf(detail, mode, history, a, b);
          if (!(w > 0)) continue;
          cands.push({ i: i, j: j, detail: detail, w: w });
          total += w;
        }
      }
      if (!cands.length || !(total > 0)) break;

      var r = rng() * total;
      var chosen = cands[cands.length - 1];
      for (var c = 0; c < cands.length; c++) {
        r -= cands[c].w;
        if (r <= 0) { chosen = cands[c]; break; }
      }

      out.push({
        a: remaining[chosen.i],
        b: remaining[chosen.j],
        score: chosen.detail.score,
        dims: chosen.detail.dims,
        max: chosen.detail.max,
        reasons: chosen.detail.reasons,
        topics: chosen.detail.topics,
        mode: mode
      });

      remaining.splice(chosen.j, 1);
      remaining.splice(chosen.i, 1);
    }

    // 落单的人不静默丢弃：给一张「轮空卡」，让他去当计时员或补位。
    // 但一组都没凑出来时不算「轮空」（那样只是人太少，不是这一轮的事）。
    var bye = (out.length && remaining.length === 1) ? remaining[0] : null;
    return { pairs: out, bye: bye, unmatched: remaining };
  }

  /* 把任意输入洗成干净的参与者对象（服务端和前端都走这里，防脏数据） */
  function normalizeProfile(raw, nowIso) {
    raw = raw || {};
    var name = String(raw.name == null ? '' : raw.name).trim().slice(0, 24);
    var skills = [];
    var seenSkill = {};
    (Array.isArray(raw.skills) ? raw.skills : []).forEach(function (s) {
      var nm = typeof s === 'string' ? s : (s && s.name);
      nm = String(nm == null ? '' : nm).trim().slice(0, 20);
      var key = norm(nm);
      if (!nm || seenSkill[key]) return;
      var lv = (s && s.level) || 'know';
      if (['learn', 'know', 'pro'].indexOf(lv) === -1) lv = 'know';
      seenSkill[key] = true;
      skills.push({ name: nm, level: lv });
    });
    var interests = [];
    var seenInt = {};
    (Array.isArray(raw.interests) ? raw.interests : []).forEach(function (x) {
      var nm = String(x == null ? '' : x).trim().slice(0, 16);
      var key = norm(nm);
      if (!nm || seenInt[key]) return;
      seenInt[key] = true;
      interests.push(nm);
    });
    var lookingFor = [];
    var seenLook = {};
    (Array.isArray(raw.lookingFor) ? raw.lookingFor : []).forEach(function (x) {
      var nm = String(x == null ? '' : x).trim().slice(0, 16);
      var key = norm(nm);
      if (!nm || seenLook[key]) return;
      seenLook[key] = true;
      lookingFor.push(nm);
    });

    return {
      id: raw.id || null,
      name: name,
      tagline: String(raw.tagline == null ? '' : raw.tagline).trim().slice(0, 60),
      skills: skills.slice(0, 12),
      interests: interests.slice(0, 12),
      lookingFor: lookingFor.slice(0, 6),
      contact: String(raw.contact == null ? '' : raw.contact).trim().slice(0, 40),
      event: String(raw.event == null ? '' : raw.event).trim().slice(0, 32),
      joinedAt: raw.joinedAt || nowIso || new Date().toISOString(),
      updatedAt: nowIso || new Date().toISOString()
    };
  }

  function validate(profile) {
    var errs = [];
    if (!profile.name) errs.push('昵称不能为空');
    if (!profile.skills.length) errs.push('至少填 1 个技能');
    if (!profile.interests.length) errs.push('至少填 1 个兴趣');
    return errs;
  }

  return {
    LEVELS: LEVELS,
    MODES: MODES,
    MAX: MAX,
    FALLBACK_TOPICS: FALLBACK_TOPICS,
    norm: norm,
    hash: hash,
    clamp: clamp,
    levelRank: levelRank,
    levelLabel: levelLabel,
    avatarColors: avatarColors,
    initials: initials,
    timesPaired: timesPaired,
    pairDetail: pairDetail,
    weightOf: weightOf,
    planMatches: planMatches,
    normalizeProfile: normalizeProfile,
    validate: validate
  };
});
