/*!
 * Hackathon 组队雷达 —— 组队名片渲染器
 * ---------------------------------------------------------------
 * 整张名片用 Canvas 2D 画出来，不依赖外部图片素材（除了两张本地图：
 * 用户自选的像素头像，以及页脚的 logo）。
 * 没选头像时，头像 = 名字哈希推导的双色渐变圆形 + 文字缩写，保证永远不空。
 * 好处是「屏幕上看到的」和「下载到的 PNG」必然一模一样（同一份绘制代码）。
 */
(function (root) {
  'use strict';

  const M = root.HackathonRadar;
  const W = 720;          // 逻辑宽度
  const SCALE = 2;        // 导出 2 倍图，手机上看也清晰
  const PAD = 60;

  const LEVEL_COLOR = {
    pro: { bg: 'rgba(16,185,129,.16)', fg: '#5eead4', line: 'rgba(94,234,212,.38)' },
    know: { bg: 'rgba(59,130,246,.16)', fg: '#93c5fd', line: 'rgba(147,197,253,.38)' },
    learn: { bg: 'rgba(245,158,11,.16)', fg: '#fcd34d', line: 'rgba(252,211,77,.38)' }
  };

  /* ---------------------------------------------------------- 图片缓存
     头像和 logo 是本地文件，第一帧可能还没加载完。策略是：先用兜底图形顶上，
     加载完再把「最新一次渲染的参数」重画一遍 —— 只重画一次，不会循环。 */
  const imgCache = {};

  function getImage(key, src, args) {
    let rec = imgCache[key];
    if (!rec) {
      rec = { img: new Image(), ready: false, failed: false, args: null };
      rec.img.onload = function () {
        rec.ready = true;
        if (rec.args) render(rec.args.canvas, rec.args.profile, rec.args.opts);
      };
      rec.img.onerror = function () { rec.failed = true; };
      rec.img.src = src;
      imgCache[key] = rec;
    }
    if (!rec.ready) rec.args = args;
    return rec;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /* 按宽度折行，中英文都按字符测宽，避免中文长句溢出 */
  function wrap(ctx, text, maxWidth) {
    const s = String(text || '');
    const lines = [];
    let line = '';
    for (const ch of s) {
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /* 把一组标签排成多行，返回行的数组（先量后排，方便算总高度） */
  function layoutChips(ctx, items, maxWidth, font, padX, h, gap) {
    ctx.font = font;
    const rows = [];
    let row = [];
    let x = 0;
    for (const it of items) {
      const tw = ctx.measureText(it.label).width;
      const w = tw + padX * 2;
      if (x + w > maxWidth && row.length) {
        rows.push(row);
        row = [];
        x = 0;
      }
      row.push(Object.assign({}, it, { w: w }));
      x += w + gap;
    }
    if (row.length) rows.push(row);
    return rows;
  }

  function rowsHeight(rows, h, gap) {
    if (!rows.length) return 0;
    return rows.length * h + (rows.length - 1) * gap;
  }

  function drawChips(ctx, rows, x0, y0, h, gap, styleOf) {
    let y = y0;
    for (const row of rows) {
      let x = x0;
      for (const chip of row) {
        const st = styleOf(chip);
        ctx.fillStyle = st.bg;
        roundRect(ctx, x, y, chip.w, h, h / 2);
        ctx.fill();
        if (st.line) {
          ctx.strokeStyle = st.line;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.fillStyle = st.fg;
        ctx.font = st.font || '500 22px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(chip.label, x + 22, y + h / 2 + 1);
        x += chip.w + gap;
      }
      y += h + gap;
    }
    return y;
  }

  function sectionTitle(ctx, text, x, y) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 20px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,.95)';
    ctx.fillText(text, x, y);
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(148,163,184,.25)';
    ctx.fillRect(x + w + 14, y - 7, W - PAD * 2 - w - 14, 1);
  }

  function drawBackground(ctx, height, colors) {
    const g = ctx.createLinearGradient(0, 0, W, height);
    g.addColorStop(0, '#0b1020');
    g.addColorStop(0.55, '#111a34');
    g.addColorStop(1, '#0a1122');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, height);

    // 程序化点阵，替代背景图
    ctx.fillStyle = 'rgba(148,163,184,.055)';
    for (let y = 24; y < height; y += 34) {
      for (let x = 22; x < W; x += 34) ctx.fillRect(x, y, 2, 2);
    }

    // 右上角光晕
    const rg = ctx.createRadialGradient(W - 90, 60, 10, W - 90, 60, 460);
    rg.addColorStop(0, colors.glow);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, height);

    // 顶部渐变条
    const bar = ctx.createLinearGradient(0, 0, W, 0);
    bar.addColorStop(0, colors.from);
    bar.addColorStop(1, colors.to);
    ctx.fillStyle = bar;
    ctx.fillRect(0, 0, W, 10);
  }

  function drawAvatar(ctx, cx, cy, r, profile, colors, avatarRec) {
    // 外圈
    const ring = () => {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    if (avatarRec && avatarRec.ready) {
      // 选了自选头像：圆形裁切后画进去
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatarRec.img, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ring();
      return;
    }

    // 兜底（也是没选头像时的正常形态）：渐变圆 + 首字母
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, colors.from);
    g.addColorStop(1, colors.to);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.fillStyle = '#0b1020';
    ctx.font = '800 52px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(M.initials(profile.name), cx, cy + 3);

    ring();
  }

  /**
   * 渲染名片
   * @param {HTMLCanvasElement} canvas
   * @param {object} profile 参与者资料
   * @param {object} opts { event }
   */
  function render(canvas, profile, opts) {
    opts = opts || {};
    profile = profile || {};
    const colors = M.avatarColors(profile.name || 'anon');
    colors.glow = 'hsla(' + (M.hash(profile.name || 'anon') % 360) + ', 80%, 60%, .16)';

    const ctx = canvas.getContext('2d');

    // --- 先量一遍，决定画布要有多高（内容多就长一点，不裁切） ---
    const skills = (profile.skills || []).map(s => ({
      label: s.name + ' · ' + M.levelLabel(s.level),
      level: s.level
    }));
    const interests = (profile.interests || []).map(x => ({ label: x }));
    const looks = (profile.lookingFor || []).map(x => ({ label: x }));

    const meas = canvas.getContext('2d');
    const chipFont = '500 22px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    const innerW = W - PAD * 2;
    const skillRows = layoutChips(meas, skills, innerW, chipFont, 22, 46, 12);
    const intRows = layoutChips(meas, interests, innerW, chipFont, 22, 46, 12);
    const lookRows = layoutChips(meas, looks, innerW, chipFont, 22, 46, 12);

    let height = 0;
    // 先按「真实绘制顺序」量出正文底部在哪，再倒推画布高度。
    // 之前这里用固定 150 估算页脚，结果联系方式盒子会压到页脚上（多技能时尤其明显）。
    const CHIP_H = 46, CHIP_GAP = 12;
    const sectionAdvance = (rows) => 18 + rows.length * (CHIP_H + CHIP_GAP) + 30;
    let contentBottom = 430;
    if (skills.length) contentBottom += sectionAdvance(skillRows);
    if (interests.length) contentBottom += sectionAdvance(intRows);
    if (looks.length) contentBottom += sectionAdvance(lookRows);

    const FOOTER_BLOCK = 30 + 62 + 70;   // 正文到联系方式的间距 + 联系方式盒 + 页脚
    const isEmpty = !skills.length && !interests.length && !looks.length;
    height = contentBottom + FOOTER_BLOCK;
    // 空卡要留够位置放中间那句提示，不然提示会和联系方式盒子叠在一起
    height = Math.max(isEmpty ? 720 : 760, Math.min(1700, height));

    canvas.width = W * SCALE;
    canvas.height = height * SCALE;
    canvas.style.aspectRatio = W + ' / ' + height;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.clearRect(0, 0, W, height);

    drawBackground(ctx, height, colors);

    // 头像 / logo：本地图，第一帧没加载完会先用兜底图形，加载完自动重画
    const args = { canvas: canvas, profile: profile, opts: opts };
    const avatarRec = profile.avatar
      ? getImage('av:' + profile.avatar, 'avatars/' + profile.avatar + '.png', args) : null;
    const logoRec = getImage('logo', 'img/logo.png', args);

    drawAvatar(ctx, W / 2, 186, 74, profile, colors, avatarRec);

    // 名字
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '800 46px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(profile.name || '还没有昵称', W / 2, 322);

    // 一句话介绍
    ctx.font = '400 23px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,.66)';
    const tag = profile.tagline || '（还没有写一句话介绍）';
    const tagLines = wrap(ctx, tag, W - PAD * 2 - 40).slice(0, 3);
    let ty = 362;
    for (const line of tagLines) {
      ctx.fillText(line, W / 2, ty);
      ty += 32;
    }

    // 正文分区
    let y = 430;
    const padX = 22, chipH = 46, chipGap = 12;
    const styleByLevel = (chip) => {
      const c = LEVEL_COLOR[chip.level] || LEVEL_COLOR.know;
      return { bg: c.bg, fg: c.fg, line: c.line, font: chipFont };
    };
    const stylePlain = () => ({
      bg: 'rgba(255,255,255,.07)', fg: 'rgba(226,232,240,.92)',
      line: 'rgba(255,255,255,.12)', font: chipFont
    });
    const styleLook = () => ({
      bg: 'rgba(168,85,247,.14)', fg: '#d8b4fe',
      line: 'rgba(216,180,254,.34)', font: chipFont
    });

    if (skills.length) {
      sectionTitle(ctx, '技能', PAD, y);
      y += 18;
      y = drawChips(ctx, skillRows, PAD, y, chipH, chipGap, styleByLevel);
      y += 30;
    }
    if (interests.length) {
      sectionTitle(ctx, '兴趣', PAD, y);
      y += 18;
      y = drawChips(ctx, intRows, PAD, y, chipH, chipGap, stylePlain);
      y += 30;
    }
    if (looks.length) {
      sectionTitle(ctx, '我在找这样的队友', PAD, y);
      y += 18;
      y = drawChips(ctx, lookRows, PAD, y, chipH, chipGap, styleLook);
      y += 30;
    }

    // 空状态：别让预览看起来像坏掉了，写一句提示在留白里
    if (isEmpty) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '400 21px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(148,163,184,.5)';
      ctx.fillText('在左边填昵称、技能和兴趣', W / 2, 470);
      ctx.fillText('这张卡会实时更新', W / 2, 502);
    }

    // 联系方式：贴着页脚放，但绝不越过正文底部
    const contactY = Math.max(contentBottom + 30, height - 132);
    ctx.fillStyle = 'rgba(255,255,255,.055)';
    roundRect(ctx, PAD, contactY, innerW, 62, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 21px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,.9)';
    ctx.fillText('找我聊', PAD + 22, contactY + 32);
    ctx.font = '600 24px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = profile.contact ? '#e2e8f0' : 'rgba(148,163,184,.5)';
    ctx.fillText(profile.contact || '（未填写联系方式）', PAD + 118, contactY + 32);

    // 页脚：logo + 产品名 + 活动名
    const footY = height - 40;
    let footX = PAD;
    if (logoRec.ready) {
      const size = 26;
      ctx.save();
      roundRect(ctx, footX, footY - size + 6, size, size, 7);
      ctx.clip();
      ctx.drawImage(logoRec.img, footX, footY - size + 6, size, size);
      ctx.restore();
      footX += size + 10;
    }
    ctx.font = '500 17px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,.55)';
    ctx.textAlign = 'left';
    ctx.fillText('Hackathon 组队雷达', footX, footY);
    ctx.textAlign = 'right';
    ctx.fillText(opts.event || profile.event || '黑客松现场', W - PAD, footY);

    return { width: W, height: height };
  }

  root.Card = { render: render, W: W };
})(typeof self !== 'undefined' ? self : this);
