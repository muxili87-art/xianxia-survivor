/* ============================================================
 * Canvas 2D UI（小游戏后端）
 *
 * 为什么不是「给小游戏做一个 DOM 垫片」：
 * 小游戏里**不能叠两个画布** —— 只有第一次 createCanvas() 拿到的那块
 * 能上屏，其余全是离屏的。所以 HTML 弹窗那套在这里没有落点。
 *
 * 做法：UI 画在离屏 2D 画布上 → 作为 CanvasTexture 贴到一个全屏四边形
 * → 在**后处理链之后**单独渲染一遍。
 *
 * 「在后处理之后」是硬要求：如果 UI 四边形加进主场景，
 * 泛光（UnrealBloomPass）会把白色文字糊成一团光晕、
 * 分级调色（GradeShader）还会给 UI 染色。
 * 症状是「字看起来发虚、发蓝」，很容易被误判成字体或分辨率问题。
 *
 * 另一个硬要求是**脏标记**：整屏 2D 画布每帧重画 + 上传纹理，
 * 在千元机上是几毫秒的事。HUD 里真正每帧都在变的只有计时器和血条，
 * 所以只在状态变化或动画活跃时重画，稳态下这一层的开销接近零。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  if (!XS.MG) return;                 /* 非小游戏环境：用 js/ui.js 的 DOM 版 */
  var T = global.THREE;
  var U = XS.U;
  var C = XS.C;

  var UI = XS.UI || (XS.UI = {});

  /* ============================================================
   * 画布与叠加层
   * ============================================================ */
  var cv = null, ctx = null, tex = null;
  var oScene = null, oCam = null, quad = null;
  var W = 0, H = 0, DPR = 1, SC = 1;
  var dirty = true, redraws = 0, frames = 0, marks = 0, changedFrames = 0, markSeen = false;

  var MAX_UI_DPR = 2;   /* UI 纹理最大 2x：再高只是白白多传一倍像素 */

  function hex(n) {
    return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);
  }
  var PAL = {
    ink: hex(C.inkDeep), ink2: '#07161f', panel: '#0b1a26',
    jade: hex(C.jade), jadeSoft: hex(C.jadeSoft), gold: hex(C.gold),
    goldDeep: hex(C.goldDeep), blood: hex(C.blood), cinnabar: hex(C.cinnabar),
    purple: hex(C.purple), frost: hex(C.frost), ember: hex(C.ember),
    white: '#eaf6ff', dim: 'rgba(234,246,255,0.55)', line: 'rgba(120,200,255,0.20)'
  };

  function rgba(h, a) {
    var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* 标脏次数（marks）与「有变的帧数」（changedFrames）。
     这两个是判读重画率的**基准** —— 重画率本身没有绝对参考值，
     它取决于这一屏有多少东西在变：安静对局里唯一会变的只有 1 Hz 的
     计时器，重画率就是 1/60；激烈交战时血条和经验条每帧都在变，
     重画率接近 1。两者都是对的，都不是 bug。
     真正的判据是 redraws 要和 **changedFrames** 对上（不是 marks）：
     一帧里可能标脏多次（掉血 + 经验 + 击杀各一次），但它们只需要
     重画一次 —— 所以能跟 redraws 对上的量是「有变的帧数」。
       redraws < changedFrames → 漏画（画面停在旧值上，脏标记过度抑制）
       changedFrames = 0 却在重画 → 白画（每帧白传一次整屏纹理） */
  function markDirty() {
    dirty = true;
    marks++;
    if (!markSeen) { markSeen = true; changedFrames++; }
  }
  UI.markDirty = markDirty;

  /* 字号：SC 让「同一份 UI」在小屏手机和大屏手机上视觉比例一致，
     FS 是设置里的「大字号」系数（和 Web 版的 --fs 用同一个数）。 */
  function fs(px) {
    return Math.max(9, px * SC * (XS.Settings ? XS.Settings.fontScale() : 1));
  }
  function px(v) { return v * SC; }

  function layout() {
    W = global.innerWidth;
    H = global.innerHeight;
    SC = U.clamp(Math.min(W, H) / 390, 0.82, 1.25);
    DPR = U.clamp(global.devicePixelRatio || 1, 1, MAX_UI_DPR);
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    markDirty();
  }

  /* ============================================================
   * 绘图原语
   * ============================================================ */
  function rr(x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fillRR(x, y, w, h, r, style) { rr(x, y, w, h, r); ctx.fillStyle = style; ctx.fill(); }
  function strokeRR(x, y, w, h, r, style, lw) {
    rr(x, y, w, h, r); ctx.strokeStyle = style; ctx.lineWidth = lw || 1; ctx.stroke();
  }

  function text(str, x, y, size, color, align, weight) {
    ctx.font = (weight || 400) + ' ' + size.toFixed(1) + 'px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(str), x, y);
  }

  /* CJK 友好的折行：中文没有空格，按字符宽度累加断行 */
  function wrap(str, maxW, size, weight) {
    ctx.font = (weight || 400) + ' ' + size.toFixed(1) + 'px sans-serif';
    var out = [], cur = '';
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '\n') { out.push(cur); cur = ''; continue; }
      if (ctx.measureText(cur + ch).width > maxW && cur.length) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /* ============================================================
   * 命中测试
   *
   * 每帧重画时重建命中矩形 —— 不做增量维护。
   * 增量维护在「列表滚动 + 内容重渲染 + 弹层叠加」三者同时发生时
   * 极容易错位，而错位的表现是「按钮点不准」，
   * 这种 bug 靠肉眼几乎查不出来，但重建的代价只有几十次 push。
   * ============================================================ */
  var hits = [];
  var pressed = null;         /* 当前按住的可点区域 */

  function hit(x, y, w, h, fn, opt) {
    hits.push({ x: x, y: y, w: w, h: h, fn: fn, opt: opt || null });
  }
  function inside(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  function hitAt(x, y) {
    /* 后注册的在上层，倒着找 */
    for (var i = hits.length - 1; i >= 0; i--) if (inside(hits[i], x, y)) return hits[i];
    return null;
  }

  UI.pointerDown = function (x, y) {
    var h = hitAt(x, y);
    if (!h) return false;
    pressed = h;
    if (h.opt && h.opt.drag) {           /* 可滚动区域：记下起点 */
      pressed._y0 = y;
      pressed._scroll0 = S.scroll;
    }
    if (h.opt && h.opt.slider) h.opt.slider(x);
    markDirty();
    return true;
  };
  UI.pointerMove = function (x, y) {
    if (!pressed) return;
    if (pressed.opt && pressed.opt.drag) {
      var dy = y - pressed._y0;
      S.scroll = U.clamp(pressed._scroll0 - dy, 0, S.scrollMax);
      markDirty();
    } else if (pressed.opt && pressed.opt.slider) {
      pressed.opt.slider(x);
      markDirty();
    } else {
      /* 手指滑出按钮就取消按下态（避免「滑出去还是点了」） */
      if (!inside(pressed, x, y)) { pressed = null; markDirty(); }
    }
  };
  UI.pointerUp = function (x, y) {
    var p = pressed;
    pressed = null;
    markDirty();
    if (!p) return;
    if (p.opt && (p.opt.drag || p.opt.slider)) return;   /* 拖动只是滚动 / 调值，不触发点击 */
    if (inside(p, x, y) && p.fn) p.fn();
  };
  UI.pointerCancel = function () { pressed = null; markDirty(); };

  /* ============================================================
   * 状态
   * ============================================================ */
  var S = {
    hp: 1, hpText: '', xp: 0, lv: 1, timer: '08:00', kills: 0,
    wave: null, tip: null, announce: null, bossWarn: null,
    boss: null, skills: [], boostOn: false,
    screen: 'none',
    cards: null, cardLv: 1, cardSub: '', cardGoal: null,
    over: null, win: null,
    metaTab: 'shop', scroll: 0, scrollMax: 0,
    poorFlash: null,
    toasts: [],
    start: null
  };
  var timers = {};   /* 若干「N 秒后自动消失」的计时 */

  function setTemp(key, ms, clearFn) {
    if (timers[key]) { clearTimeout(timers[key]); timers[key] = null; }
    timers[key] = setTimeout(function () {
      timers[key] = null;
      clearFn();
      markDirty();
    }, ms);
  }

  /* ============================================================
   * UI 接口 —— 与 js/ui.js 一一对应
   * ============================================================ */
  UI.init = function () {
    cv = global.document.createElement('canvas');   /* 离屏（上屏那块已给渲染器） */
    ctx = cv.getContext('2d');
    layout();

    tex = new T.CanvasTexture(cv);
    tex.minFilter = T.LinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    /* 色彩管线：主渲染链用的是 LinearEncoding（见 core.js），
       UI 纹理也必须声明成同一套，否则会被二次 gamma 洗白 ——
       表现是「UI 整体发灰、白字不够白」。 */
    if (T.LinearEncoding !== undefined) tex.encoding = T.LinearEncoding;

    oScene = new T.Scene();
    /* near 不能是 0：正交相机 near=0 时位于 z=0 的四边形会正好贴在
       近裁剪面上，浮点误差会让它时有时无（表现是 UI 一闪一闪）。
       把相机拉到 z=2、近远面取 0.1~10，四边形稳稳落在中间。 */
    oCam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    oCam.position.z = 2;
    quad = new T.Mesh(
      new T.PlaneGeometry(2, 2),
      new T.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
        /* 和主场景的雾无关：UI 永远不该被雾影响 */
        fog: false
      })
    );
    quad.frustumCulled = false;
    oScene.add(quad);

    global.addEventListener('resize', layout);
    UI.hideAll();
    return UI;
  };

  /* ---------- HUD ---------- */
  UI.setHp = function (cur, max) {
    var r = max > 0 ? Math.max(0, cur / max) : 0;
    if (Math.abs(r - S.hp) < 0.002 && S.hpText === Math.max(0, Math.ceil(cur)) + ' / ' + Math.ceil(max)) return;
    S.hp = r;
    S.hpText = Math.max(0, Math.ceil(cur)) + ' / ' + Math.ceil(max);
    markDirty();
  };
  UI.setXp = function (cur, need, level) {
    var r = need > 0 ? Math.min(1, cur / need) : 0;
    if (Math.abs(r - S.xp) < 0.002 && S.lv === level) return;
    S.xp = r; S.lv = level;
    markDirty();
  };
  UI.setTimer = function (t, total) {
    var s = U.fmtTime(Math.max(0, total - t));
    if (s === S.timer) return;
    S.timer = s;
    markDirty();
  };
  UI.setKills = function (n) {
    if (n === S.kills) return;
    S.kills = n;
    markDirty();
  };

  /* 神行符入口的开关。**由游戏层喊**（game.js 的 setBoostUi），
     因为「什么时候该给这个offer」是玩法规则，不是 UI 的事。
     这个字段原来从来没人置真 —— 按钮的画法、命中区、回调
     （见 drawHud 里的 S.boostOn 分支）全都写好了，就是没人喊它，
     于是三个广告点位里，目标平台上一个都不生效。
     这正是「照着 Web 版重写一遍」的典型漏项：Web 版那半边是
     `boostBtn.classList.add('show')`，DOM 操作没有对应物，
     重写时它被整句丢掉了，而不是被换成了别的写法。 */
  UI.setBoost = function (on) {
    on = !!on;
    if (on === S.boostOn) return;
    S.boostOn = on;
    markDirty();
  };

  UI.setSkills = function (list) {
    /* 只比 id + level + evolved：比整个对象会每帧都判定为「变了」 */
    var a = S.skills, same = a.length === list.length;
    if (same) {
      for (var i = 0; i < list.length; i++) {
        if (a[i].id !== list[i].id || a[i].level !== list[i].level || !!a[i].evolved !== !!list[i].evolved) { same = false; break; }
      }
    }
    if (same) return;
    S.skills = list.slice();
    markDirty();
  };
  UI.resetSkills = function () {
    if (!S.skills.length) return;
    S.skills = [];
    markDirty();
  };

  /* ---------- Boss ---------- */
  UI.showBoss = function (name, hp, max) {
    S.boss = { name: name, pct: max > 0 ? U.clamp(hp / max, 0, 1) : 0 };
    markDirty();
  };
  UI.updateBoss = function (hp, max) {
    if (!S.boss) return;
    S.boss.pct = max > 0 ? U.clamp(hp / max, 0, 1) : 0;
    markDirty();
  };
  UI.hideBoss = function () {
    if (!S.boss) return;
    S.boss = null;
    markDirty();
  };

  /* ---------- 播报 ---------- */
  UI.announce = function (t, sub, color, ms) {
    S.announce = { t: t, sub: sub || '', color: color || PAL.jade };
    markDirty();
    setTemp('announce', ms || 1800, function () { S.announce = null; });
  };
  UI.bossWarning = function (t) {
    S.bossWarn = t;
    markDirty();
    setTemp('bossWarn', 2600, function () { S.bossWarn = null; });
  };
  UI.tip = function (t, ms) {
    S.tip = t;
    markDirty();
    setTemp('tip', ms || 4000, function () { S.tip = null; });
  };
  UI.waveHint = function (t) {
    S.wave = t;
    markDirty();
    setTemp('wave', 2000, function () { S.wave = null; });
  };

  /* ---------- 遮罩 ---------- */
  UI.hideAll = function () {
    S.screen = 'none';
    S.cards = null; S.over = null; S.win = null;
    pressed = null;
    markDirty();
  };
  UI.hideUpgrades = function () { if (S.screen === 'level') UI.hideAll(); };
  UI.hidePause = function () { if (S.screen === 'pause') UI.hideAll(); };
  UI.hideSettings = function () { if (S.screen === 'settings') UI.hideAll(); };
  UI.hideMeta = function () { if (S.screen === 'meta') UI.hideAll(); };

  UI.showStart = function (handlers) {
    S.screen = 'start';
    S.start = handlers || {};
    markDirty();
  };

  UI.showUpgrades = function (choices, level, onPick) {
    S.screen = 'level';
    S.cards = choices;
    S.cardLv = level;
    S.cardPick = onPick;
    S.cardGoal = (XS.Game && XS.Game.evoGoal) ? XS.Game.evoGoal() : null;
    pressed = null;
    markDirty();
  };

  /* 走查用：把当前三选一交出去，并允许按索引选牌。
     小游戏版没有 DOM，Web 版机器人那套 querySelector('.card.evo').click()
     在这里完全用不上 —— 但选牌**策略**必须原样重写一遍，
     不能省：进化卡优先这件事既决定「这局能不能成」，
     也决定自动化测试能不能覆盖到进化系统。 */
  UI.currentChoices = function () {
    return (S.screen === 'level' && S.cards) ? S.cards : null;
  };
  UI.pickCard = function (i) {
    if (S.screen !== 'level' || !S.cards) return false;
    var c = S.cards[i < 0 ? 0 : i];
    if (!c) return false;
    var fn = S.cardPick;
    /* 先摘掉回调再调用：选牌会同步把 state 推回 playing 并重开下一次
       升级流程，留着旧回调会让第二次选牌又走一遍旧的三选一。 */
    S.cardPick = null;
    S.screen = 'none';
    if (fn) fn(c);
    markDirty();
    return true;
  };

  UI.showOver = function (stats, handlers) {
    S.screen = 'over';
    S.over = { stats: stats, h: handlers };
    pressed = null;
    markDirty();
  };
  UI.showWin = function (stats, handlers) {
    S.screen = 'win';
    S.win = { stats: stats, h: handlers };
    pressed = null;
    markDirty();
  };
  UI.showPause = function (onResume, onQuit, onSettings) {
    S.screen = 'pause';
    S.pause = { resume: onResume, quit: onQuit, settings: onSettings };
    pressed = null;
    markDirty();
  };
  UI.showMeta = function (tab) {
    S.screen = 'meta';
    S.scroll = 0;
    UI.renderMetaTab(tab || 'shop');
  };
  UI.renderMetaTab = function (tab) {
    if (tab) S.metaTab = tab;
    S.scroll = 0;
    markDirty();
  };
  UI.refreshCoins = function () { markDirty(); };
  UI.flashPoor = function () {
    S.poorFlash = { t: 0 };
    markDirty();
  };

  UI.showSettings = function () {
    S.screen = 'settings';
    pressed = null;
    markDirty();
  };
  UI.initSettings = function () {
    XS.Settings.load();
    XS.Settings.apply();
    markDirty();
    return XS.Settings;
  };
  UI.syncSettingsUI = function () { markDirty(); };
  UI.onSettingsChanged = function () { markDirty(); };

  /* 结算时更新历史最佳（和 Web 版同一份逻辑） */
  UI.saveBest = function (rec) {
    var best = XS.Platform.load('best', null);
    if (!best || rec.dur > best.dur) {
      XS.Platform.save('best', { dur: rec.dur, level: rec.level, kills: rec.kills });
      return true;
    }
    return false;
  };

  /* ---------- 成就浮层 ---------- */
  UI.achievementToast = function (list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) S.toasts.push({ a: list[i], t: 0 });
    markDirty();
  };

  /* ---------- 伤害飘字 ---------- */
  var DMG_POOL = 26;
  var dmgs = [];
  var _v3 = new T.Vector3();

  UI.dmg = function (x, y, z, amount, kind) {
    if (XS.Settings && !XS.Settings.dmgNumbers) return;
    var n = null;
    for (var i = 0; i < dmgs.length; i++) if (!dmgs[i].busy) { n = dmgs[i]; break; }
    if (!n) {
      if (dmgs.length >= DMG_POOL) return;
      n = {}; dmgs.push(n);
    }
    n.busy = true;
    n.life = 0.72; n.maxLife = 0.72;
    n.x = x + U.rand(-0.3, 0.3);
    n.y = y;
    n.z = z + U.rand(-0.3, 0.3);
    n.text = kind === 'crit' ? (amount | 0) + '!' : String(amount | 0);
    n.kind = kind || '';
    markDirty();
  };

  UI.updateDamageNumbers = function (dt, camera) {
    var any = false;
    for (var i = 0; i < dmgs.length; i++) {
      var n = dmgs[i];
      if (!n.busy) continue;
      any = true;
      n.life -= dt;
      if (n.life <= 0) { n.busy = false; continue; }
      var t = 1 - n.life / n.maxLife;
      _v3.set(n.x, n.y + t * 1.6, n.z);
      _v3.project(camera);
      n.sx = (_v3.x * 0.5 + 0.5) * W;
      n.sy = (-_v3.y * 0.5 + 0.5) * H;
      n.t = t;
      n.behind = _v3.z > 1;
    }
    if (any) markDirty();
  };

  UI.clearDamageNumbers = function () {
    for (var i = 0; i < dmgs.length; i++) dmgs[i].busy = false;
    markDirty();
  };

  /* ============================================================
   * 绘制：HUD
   * ============================================================ */
  function safe() {
    var s = (XS.MG && XS.MG.safeArea) ? XS.MG.safeArea() : { top: 0, bottom: 0 };
    return { top: Math.max(s.top, px(8)), bottom: Math.max(s.bottom, px(8)) };
  }

  function drawHud() {
    var pad = px(14);
    var top = safe().top + px(4);

    /* ---- 气血 / 境界 ---- */
    var bw = Math.min(px(190), W * 0.46);
    var bh = px(13);
    var x0 = pad, y0 = top;

    fillRR(x0, y0, bw, bh, bh * 0.5, 'rgba(4,14,22,0.72)');
    var hpCol = S.hp < 0.3 ? PAL.blood : PAL.jade;
    if (S.hp > 0.001) {
      ctx.save();
      rr(x0, y0, bw, bh, bh * 0.5); ctx.clip();
      var g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
      g.addColorStop(0, hpCol); g.addColorStop(1, rgba(hpCol, 0.55));
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, bw * S.hp, bh);
      ctx.restore();
    }
    strokeRR(x0, y0, bw, bh, bh * 0.5, PAL.line, 1);
    text(S.hpText, x0 + bw * 0.5, y0 + bh * 0.5, fs(10.5), PAL.white, 'center', 600);

    var y1 = y0 + bh + px(5);
    var xh = px(8);
    fillRR(x0, y1, bw, xh, xh * 0.5, 'rgba(4,14,22,0.72)');
    if (S.xp > 0.001) {
      fillRR(x0, y1, Math.max(xh, bw * S.xp), xh, xh * 0.5, PAL.gold);
    }
    text('境界 ' + S.lv, x0 + bw + px(8), y1 + xh * 0.5, fs(10.5), PAL.gold, 'left', 600);

    /* ---- 计时 ---- */
    text(S.timer, W * 0.5, top + px(11), fs(21), PAL.white, 'center', 700);
    if (S.wave) {
      text(S.wave, W * 0.5, top + px(31), fs(11), PAL.goldSoft || PAL.gold, 'center', 600);
    }

    /* ---- 斩妖 / 暂停 ---- */
    var pr = px(30);
    var bx = W - pad - pr, by = top;
    text('斩妖 ' + S.kills, bx - px(9), by + pr * 0.5, fs(12), PAL.white, 'right', 600);
    fillRR(bx, by, pr, pr, px(9), 'rgba(10,26,38,0.8)');
    strokeRR(bx, by, pr, pr, px(9), PAL.line, 1);
    /* 两条竖杠 = 暂停 */
    ctx.fillStyle = PAL.jadeSoft;
    ctx.fillRect(bx + pr * 0.34, by + pr * 0.28, px(3), pr * 0.44);
    ctx.fillRect(bx + pr * 0.55, by + pr * 0.28, px(3), pr * 0.44);
    hit(bx - px(6), by - px(6), pr + px(12), pr + px(12),
      function () { XS.Game.pause(); }, { tag: '暂停' });

    /* ---- Boss 血条 ---- */
    if (S.boss) {
      var byy = top + px(44);
      var bwd = Math.min(px(300), W - pad * 2);
      var bxx = (W - bwd) * 0.5;
      text(S.boss.name, W * 0.5, byy - px(9), fs(12), PAL.cinnabar, 'center', 700);
      fillRR(bxx, byy, bwd, px(11), px(5), 'rgba(20,6,10,0.8)');
      if (S.boss.pct > 0.001) {
        var bg = ctx.createLinearGradient(bxx, 0, bxx + bwd, 0);
        bg.addColorStop(0, PAL.blood); bg.addColorStop(1, PAL.cinnabar);
        fillRR(bxx, byy, Math.max(px(4), bwd * S.boss.pct), px(11), px(5), bg);
      }
      strokeRR(bxx, byy, bwd, px(11), px(5), rgba(PAL.cinnabar, 0.5), 1);
    }

    /* ---- 技能栏 ---- */
    if (S.skills.length) {
      var ss = Math.min(px(38), (W - pad * 2 - px(6) * 6) / 6);
      var gap = px(6);
      var totalW = S.skills.length * ss + (S.skills.length - 1) * gap;
      var sx = (W - totalW) * 0.5;
      var sy = H - safe().bottom - ss - px(10);
      for (var i = 0; i < S.skills.length; i++) {
        var sk = S.skills[i];
        var col = XS.TAG_COLOR[sk.tag] || PAL.jade;
        var x = sx + i * (ss + gap);
        fillRR(x, sy, ss, ss, px(8), 'rgba(6,18,28,0.82)');
        strokeRR(x, sy, ss, ss, px(8), sk.evolved ? PAL.gold : rgba(col, 0.55), sk.evolved ? 2 : 1);
        text(sk.icon, x + ss * 0.5, sy + ss * 0.42, fs(16), col, 'center', 600);
        text('Lv' + sk.level, x + ss * 0.5, sy + ss * 0.78, fs(8.5), PAL.dim, 'center', 500);
        if (sk.evolved) text('★', x + ss - px(5), sy + px(7), fs(8), PAL.gold, 'center', 700);
      }
    }

    /* ---- 教学提示 ---- */
    if (S.tip) {
      var ty = H - safe().bottom - px(62);
      var tw = Math.min(W - pad * 2, px(430));
      var lines = wrap(S.tip, tw - px(24), fs(11));
      var th = lines.length * fs(15) + px(14);
      fillRR((W - tw) * 0.5, ty - th * 0.5, tw, th, px(9), 'rgba(4,14,22,0.82)');
      strokeRR((W - tw) * 0.5, ty - th * 0.5, tw, th, px(9), PAL.line, 1);
      for (var li = 0; li < lines.length; li++) {
        text(lines[li], W * 0.5, ty - th * 0.5 + px(7) + (li + 0.5) * fs(15), fs(11), PAL.jadeSoft, 'center', 500);
      }
    }

    /* ---- 神行符（广告点位） ---- */
    if (S.boostOn) {
      var aw = px(96), ah = px(34);
      var ax = W - pad - aw, ay = H - safe().bottom - px(56) - ah;
      fillRR(ax, ay, aw, ah, px(9), rgba(PAL.purple, 0.22));
      strokeRR(ax, ay, aw, ah, px(9), PAL.purple, 1);
      text('神行符', ax + aw * 0.5, ay + ah * 0.36, fs(12), PAL.white, 'center', 700);
      text('看广告', ax + aw * 0.5, ay + ah * 0.72, fs(9), PAL.purple, 'center', 500);
      /* tag 是给走查按文字找按钮用的。它**不是**可选的装饰：
         少了它，`?mgtap=神行符` 永远找不到这个按钮，而症状是
         `found: false` —— 和「按钮根本没画出来」长得一模一样。 */
      hit(ax, ay, aw, ah, function () { XS.Game.onBoostAd(); }, { tag: '神行符' });
    }

    /* ---- 摇杆 ---- */
    var st = XS.Input && XS.Input.stick;
    if (st && st.active) {
      var R = px(46);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(st.cx, st.cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = PAL.jadeSoft; ctx.lineWidth = px(2); ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(st.cx + st.dx, st.cy + st.dy, px(20), 0, Math.PI * 2);
      ctx.fillStyle = rgba(PAL.jade, 0.45); ctx.fill();
      ctx.strokeStyle = PAL.jade; ctx.lineWidth = px(1.5); ctx.stroke();
      ctx.restore();
    }

    /* ---- 伤害飘字 ---- */
    for (var d = 0; d < dmgs.length; d++) {
      var n = dmgs[d];
      if (!n.busy || n.behind) continue;
      var a = Math.min(1, (1 - n.t) * 2.4);
      var size = fs(15) * (1 + n.t * 0.35);
      ctx.globalAlpha = a;
      var col = n.kind === 'crit' ? PAL.gold : (n.kind === 'burn' ? PAL.ember : PAL.white);
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = 'rgba(3,8,15,0.85)';
      ctx.font = '700 ' + size.toFixed(1) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeText(n.text, n.sx, n.sy);
      ctx.fillStyle = col;
      ctx.fillText(n.text, n.sx, n.sy);
      ctx.globalAlpha = 1;
    }
  }

  /* ============================================================
   * 绘制：公共部件
   * ============================================================ */
  function scrim(alpha) {
    ctx.fillStyle = 'rgba(2,7,13,' + (alpha === undefined ? 0.72 : alpha) + ')';
    ctx.fillRect(0, 0, W, H);
  }

  function panel(x, y, w, h, r) {
    r = r || px(16);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = px(26);
    ctx.shadowOffsetY = px(8);
    fillRR(x, y, w, h, r, 'rgba(9,24,36,0.96)');
    ctx.restore();
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, 'rgba(30,80,110,0.30)');
    g.addColorStop(1, 'rgba(6,16,26,0.0)');
    fillRR(x, y, w, h, r, g);
    strokeRR(x, y, w, h, r, PAL.line, 1);
  }

  function button(label, x, y, w, h, style, fn, sub, tag) {
    var bg, bd, fg;
    if (style === 'primary') { bg = 'rgba(77,232,255,0.16)'; bd = PAL.jade; fg = PAL.white; }
    else if (style === 'gold') { bg = 'rgba(255,207,107,0.18)'; bd = PAL.gold; fg = PAL.white; }
    else if (style === 'danger') { bg = 'rgba(255,90,77,0.14)'; bd = PAL.cinnabar; fg = PAL.white; }
    else if (style === 'off') { bg = 'rgba(255,255,255,0.04)'; bd = 'rgba(160,200,230,0.25)'; fg = PAL.dim; }
    else { bg = 'rgba(255,255,255,0.05)'; bd = 'rgba(160,200,230,0.34)'; fg = PAL.jadeSoft; }
    var isP = pressed && pressed.fn === fn;
    fillRR(x, y, w, h, px(11), isP ? rgba(bd, 0.30) : bg);
    strokeRR(x, y, w, h, px(11), bd, style === 'primary' ? 1.6 : 1);
    text(label, x + w * 0.5, y + h * (sub ? 0.36 : 0.5), fs(14), fg, 'center', 700);
    if (sub) text(sub, x + w * 0.5, y + h * 0.72, fs(9.5), PAL.dim, 'center', 500);
    /* 带上 tag：走查要能按**文字**找到按钮再点它。
       没有 tag 的话，自动化只能靠硬编码坐标 —— 而坐标会随面板高度变，
       于是「点了复活」这件事迟早会变成「点在了面板空白处」。
       tag 默认取按钮上的文字；商店那种「按钮文字是价格」的地方
       要显式传 tag（价格会随等级变，脚本没法预先知道）。 */
    hit(x, y, w, h, fn, { tag: tag || label });
  }

  function segRow(label, x, y, w, opts, cur, onPick) {
    var lw = px(74);
    text(label, x, y + px(15), fs(11.5), PAL.dim, 'left', 500);
    var n = opts.length;
    var bx = x + lw, bw = w - lw;
    var bwid = (bw - px(4) * (n - 1)) / n;
    for (var i = 0; i < n; i++) {
      var o = opts[i];
      var on = String(o.v) === String(cur);
      var ox = bx + i * (bwid + px(4));
      fillRR(ox, y, bwid, px(30), px(8), on ? rgba(PAL.jade, 0.24) : 'rgba(255,255,255,0.04)');
      strokeRR(ox, y, bwid, px(30), px(8), on ? PAL.jade : 'rgba(160,200,230,0.22)', on ? 1.5 : 1);
      text(o.t, ox + bwid * 0.5, y + px(15), fs(11.5), on ? PAL.white : PAL.dim, 'center', on ? 700 : 500);
      (function (vv, tt) { hit(ox, y, bwid, px(30), function () { onPick(vv); },
        { tag: label + '·' + tt }); })(o.v, o.t);
    }
    return px(38);
  }

  function sliderRow(label, x, y, w, value, onChange) {
    var lw = px(74);
    text(label, x, y + px(15), fs(11.5), PAL.dim, 'left', 500);
    var bx = x + lw, bw = w - lw - px(34);
    var t = U.clamp(value, 0, 1);
    var trackY = y + px(13), th = px(5);
    fillRR(bx, trackY, bw, th, th * 0.5, 'rgba(255,255,255,0.10)');
    fillRR(bx, trackY, Math.max(th, bw * t), th, th * 0.5, PAL.jade);
    var kx = bx + bw * t;
    ctx.beginPath(); ctx.arc(kx, trackY + th * 0.5, px(9), 0, Math.PI * 2);
    ctx.fillStyle = PAL.white; ctx.fill();
    text(Math.round(t * 100), x + w, y + px(15), fs(11.5), PAL.jadeSoft, 'right', 600);
    /* 整条可拖。命中区左右各放宽一点，否则滑块在两端时手指很难压中。
       tag 让走查能按名字找到它 —— 顺带说明「点一下也能改值」：
       pointerDown 就会调 opt.slider(x)，所以单击等价于拖到那个位置。 */
    hit(bx - px(10), y, bw + px(20), px(30), null, {
      slider: function (mx) { onChange(U.clamp((mx - bx) / bw, 0, 1)); },
      tag: label
    });
    return px(38);
  }

  /* ============================================================
   * 绘制：各屏
   * ============================================================ */
  function drawStart() {
    scrim(0.78);
    var pw = Math.min(W - px(28), px(380));
    var cx = W * 0.5;

    /* 面板高度按**内容实际占高**算，而不是「给个固定 560 再让按钮贴底」。
       固定高度在短屏上会让内容顶到按钮，在长屏上中间留一大块空白 ——
       而留白那一版看起来像「渲染漏了一段」，每次走查都要重新确认一次。
       下面这些增量和绘制用的是同一批 fs()/px()，所以大字号模式下
       面板会跟着长高，不会把按钮挤出去。 */
    var adv = function (n) { return fs(n) * 1.62; };
    var sealH = px(38);
    var contentH = px(28)                 /* 上留白 */
      + sealH + px(16)
      + adv(30)                           /* 标题 */
      + adv(12) * 2 + px(8)               /* 两行副标 */
      + adv(11) + px(24)                  /* 历史最佳 */
      + px(24) + px(30)                   /* 灵石条 */
      + adv(11.5) * 3                     /* 三条说明 */
      + px(14);
    var btnH = px(46), ghostH = px(36);
    var btnBlock = px(12) + btnH + px(10) + ghostH + px(20) + adv(9.5);
    var avail = H - safe().top - safe().bottom - px(24);
    var ph = Math.min(avail, contentH + btnBlock);
    var px0 = (W - pw) * 0.5, py0 = (H - ph) * 0.5;
    panel(px0, py0, pw, ph);

    var y = py0 + px(28);

    /* 印章 */
    var seal = sealH;
    fillRR(cx - seal * 0.5, y, seal, seal, px(7), rgba(PAL.cinnabar, 0.18));
    strokeRR(cx - seal * 0.5, y, seal, seal, px(7), PAL.cinnabar, 1.5);
    text('仙', cx, y + seal * 0.53, fs(22), PAL.cinnabar, 'center', 700);
    y += seal + px(16);

    text('仙台问剑', cx, y + adv(30) * 0.42, fs(30), PAL.white, 'center', 700);
    y += adv(30);
    text('云海之上，剑修独守仙台。', cx, y + adv(12) * 0.45, fs(12), PAL.dim, 'center', 400);
    y += adv(12);
    text('妖魔自八方涌来，撑过八分钟即为渡劫。', cx, y + adv(12) * 0.45, fs(12), PAL.dim, 'center', 400);
    y += adv(12) + px(8);

    /* 历史最佳 */
    var best = XS.Platform.load('best', null);
    var bestStr = (best && best.dur)
      ? '历史最佳　存活 ' + U.fmtTime(best.dur) + '　境界 ' + best.level + '　斩妖 ' + best.kills
      : '尚无战绩，第一局就是记录';
    text(bestStr, cx, y + adv(11) * 0.45, fs(11), PAL.gold, 'center', 600);
    y += adv(11) + px(24);

    /* 灵石 / 成就 / 图鉴 */
    if (XS.Meta) {
      var line = '灵 ' + XS.Meta.data.coins + '　成就 ' + XS.Meta.achCount() + '/' + XS.ACHIEVEMENTS.length +
        '　图鉴 ' + XS.Meta.codexCount() + '/' + XS.Meta.codexTotal();
      var bw2 = Math.min(pw - px(40), px(330));
      fillRR(cx - bw2 * 0.5, y, bw2, px(24), px(8), 'rgba(255,255,255,0.05)');
      text(line, cx, y + px(12), fs(11), PAL.jadeSoft, 'center', 600);
      y += px(24) + px(6);
    }

    /* 三条说明 */
    var howto = ['拖动屏幕任意处走位', '飞剑与功法自动攻击，无需操作', '拾取灵气升级，三选一功法构筑流派'];
    for (var i = 0; i < howto.length; i++) {
      var lx = cx - Math.min(pw - px(40), px(300)) * 0.5;
      var ic = px(16);
      var cy = y + adv(11.5) * 0.45;
      fillRR(lx, cy - ic * 0.5, ic, ic, ic * 0.5, rgba(PAL.jade, 0.16));
      text(String(i + 1), lx + ic * 0.5, cy + px(0.5), fs(10), PAL.jade, 'center', 700);
      text(howto[i], lx + ic + px(9), cy, fs(11.5), PAL.jadeSoft, 'left', 400);
      y += adv(11.5);
    }

    /* 按钮区：紧跟在内容之后，不贴底 */
    y += px(12);
    button('入 局', cx - (pw - px(44)) * 0.5, y, pw - px(44), btnH, 'primary',
      function () { if (S.start && S.start.onStart) S.start.onStart(); });
    y += btnH + px(10);
    var halfW = (pw - px(44) - px(10)) * 0.5;
    button('山门 · 商店 / 图鉴', cx - (pw - px(44)) * 0.5, y, halfW, ghostH, 'ghost',
      function () { UI.showMeta('shop'); });
    button('数据面板', cx - (pw - px(44)) * 0.5 + halfW + px(10), y, halfW, ghostH, 'off',
      function () { if (S.start && S.start.onData) S.start.onData(); });
    y += ghostH + px(12);
    text('本地已记录 ' + XS.Telemetry.getRuns().length + ' 局 · 环境 ' + XS.Platform.env,
      cx, y, fs(9.5), 'rgba(234,246,255,0.32)', 'center', 400);
  }

  function drawLevel() {
    scrim(0.76);
    var pad = px(14);
    var cx = W * 0.5;
    var top = safe().top + px(26);

    text('境界突破 · ' + S.cardLv, cx, top, fs(24), PAL.gold, 'center', 700);
    var sub = '择一功法，继续斩妖';
    if (S.cards) {
      var hasEvo = false;
      for (var q = 0; q < S.cards.length; q++) if (S.cards[q].evo) hasEvo = true;
      if (hasEvo) sub = '功法已臻圆满，可择其进化';
      else if (S.cardGoal) {
        sub = '进化目标：' + S.cardGoal.name + '（' + S.cardGoal.baseName + ' ' +
          S.cardGoal.baseLv + '/' + S.cardGoal.baseMax + '　' + S.cardGoal.reqName + ' ' +
          S.cardGoal.reqLv + '/' + S.cardGoal.reqNeed + '）';
      }
    }
    var subLines = wrap(sub, W - pad * 2, fs(11));
    for (var sl = 0; sl < subLines.length; sl++) {
      text(subLines[sl], cx, top + px(26) + sl * fs(15), fs(11), PAL.jadeSoft, 'center', 500);
    }

    var list = S.cards || [];
    if (!list.length) return;
    var topY = top + px(34) + subLines.length * fs(15) + px(10);
    var availH = H - topY - safe().bottom - px(16);

    /* 卡片高度按内容算，不用固定值。
       固定 158px 时描述只有一行，卡片下半截全是空的 ——
       看起来像「内容没加载出来」。三张卡取最大值，保证一排等高。 */
    var needH = 0;
    for (var q2 = 0; q2 < list.length; q2++) {
      needH = Math.max(needH, cardHeight(list[q2], W - pad * 2, true));
    }
    var ch = U.clamp(needH, px(92), px(150));

    /* 竖屏：卡片竖排；横屏 / 宽屏：横排。
       手机竖屏横排三张卡会把描述挤成一列一列的字，完全没法读。 */
    var vertical = W < px(620);
    if (vertical) {
      var chv = Math.min(ch, (availH - px(10) * (list.length - 1)) / list.length);
      for (var i = 0; i < list.length; i++) {
        drawCard(list[i], pad, topY + i * (chv + px(10)), W - pad * 2, chv, true, i);
      }
    } else {
      var cw = Math.min(px(250), (W - pad * 2 - px(14) * (list.length - 1)) / list.length);
      var totW = list.length * cw + px(14) * (list.length - 1);
      var x0 = (W - totW) * 0.5;
      var ch2 = Math.min(availH, ch);
      for (var j = 0; j < list.length; j++) {
        drawCard(list[j], x0 + j * (cw + px(14)), topY, cw, ch2, false, j);
      }
    }
  }

  /* 一张卡实际需要多高。和 drawCard 里的排布必须一致 ——
     不一致的话要么留白，要么最后一行被裁掉（而裁掉是静默的）。 */
  function cardHeight(c, w, horizontal) {
    var pad = px(12);
    var ic = px(horizontal ? 30 : 34);
    var h = pad + ic + px(8);
    if (S.cardGoal && !c.evo && (c.id === S.cardGoal.from || c.id === S.cardGoal.reqId)) h += px(24);
    var desc = typeof c.desc === 'function' ? c.desc(0) : c.desc;
    var lines = Math.min(wrap(desc || '', w - pad * 2, fs(11)).length, 2);
    h += Math.max(1, lines) * fs(15) + px(10);
    h += px(14);   /* 页脚 */
    return h;
  }

  function drawCard(c, x, y, w, h, horizontal, idx) {
    var isEvo = !!c.evo;
    var col = XS.TAG_COLOR[c.tag] || PAL.jade;
    fillRR(x, y, w, h, px(14), 'rgba(8,22,34,0.96)');
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, rgba(col, 0.16));
    g.addColorStop(1, 'rgba(6,16,26,0)');
    fillRR(x, y, w, h, px(14), g);
    strokeRR(x, y, w, h, px(14), isEvo ? PAL.gold : rgba(col, 0.5), isEvo ? 2 : 1);
    if (isEvo) fillRR(x + px(2), y + px(2), w - px(4), px(3), px(2), PAL.gold);

    var pad = px(12);
    var ty = y + pad;

    /* 图标 + 名字 */
    var ic = px(horizontal ? 30 : 34);
    fillRR(x + pad, ty, ic, ic, px(9), rgba(col, 0.18));
    strokeRR(x + pad, ty, ic, ic, px(9), rgba(col, 0.5), 1);
    text(c.icon || '？', x + pad + ic * 0.5, ty + ic * 0.53, fs(horizontal ? 16 : 18), col, 'center', 700);

    var nx = x + pad + ic + px(10);
    var nw = w - pad * 2 - ic - px(10);
    text(c.name, nx, ty + px(11), fs(15), PAL.white, 'left', 700);
    var meta;
    if (isEvo) {
      var baseName = (XS.UPGRADE_MAP[c.evo.from] || {}).name || c.evo.from;
      meta = '功法进化　' + baseName + ' → ' + c.name;
    } else {
      meta = c.tag + '　Lv ' + (c.current > 0 ? c.current + ' → ' + (c.current + 1) : '新 · 1');
    }
    text(meta, nx, ty + px(27), fs(10.5), col, 'left', 500);

    var yy = ty + ic + px(8);

    /* 进化目标进度 */
    if (S.cardGoal && !isEvo && (c.id === S.cardGoal.from || c.id === S.cardGoal.reqId)) {
      var part = c.id === S.cardGoal.from
        ? S.cardGoal.baseLv + '/' + S.cardGoal.baseMax
        : S.cardGoal.reqLv + '/' + S.cardGoal.reqNeed;
      var tag = '→ ' + S.cardGoal.name + '　' + part;
      fillRR(x + pad, yy, Math.min(w - pad * 2, px(200)), px(18), px(6), rgba(PAL.gold, 0.16));
      text(tag, x + pad + px(7), yy + px(9.5), fs(10), PAL.gold, 'left', 600);
      yy += px(24);
    }

    /* 描述 */
    var desc = typeof c.desc === 'function' ? c.desc(0) : c.desc;
    var lines = wrap(desc || '', w - pad * 2, fs(11));
    var maxLines = Math.max(1, Math.floor((y + h - px(30) - yy) / fs(15)));
    for (var i = 0; i < Math.min(lines.length, maxLines); i++) {
      text(lines[i], x + pad, yy + i * fs(15) + fs(6), fs(11), PAL.jadeSoft, 'left', 400);
    }

    /* 页脚 */
    var foot = isEvo
      ? '功法进化　前置 ' + XS.evoReqText(c.evo)
      : (c.current > 0 ? '已习得 Lv' + c.current : '尚未习得') + '　上限 Lv' + c.max;
    text(foot, x + pad, y + h - px(12), fs(9.5), 'rgba(234,246,255,0.42)', 'left', 400);

    (function (choice, ii) {
      /* tag 按**序号**而不是功法名：名字是随机的，走查脚本没法预先知道。
         序号稳定，`?mgtap=升级卡1` 每次都能点到第一张。
         注意这里走的是 S.cardPick 直调，而机器人走的是 UI.pickCard(i)
         （那个版本会先摘回调、关面板）—— **两条不是同一条路**，
         所以手指这条必须单独验。 */
      hit(x, y, w, h, function () { if (S.cardPick) S.cardPick(choice); },
        { tag: '升级卡' + (ii + 1) });
    })(c, idx || 0);
  }

  function statRows(stats, x, y, w) {
    /* 同步模拟下 `fpsAvg` 量的是「模拟器跑得多快」（实测 3600 fps），
       不是玩家的帧率。两个宿主各写一遍这一行 —— 神行符那次就是
       只改了一边、另一边从来没出现过。所以这里和 js/ui.js 必须同改。
       判据用肯定式 `=== true`：字段缺失时维持原显示，不会吞掉真实帧率。 */
    var fpsTxt = stats.syncSim === true ? '—' : (stats.fpsAvg + ' fps');
    var rows = [
      ['存活时长', U.fmtTime(stats.dur)],
      ['修为境界', '境界 ' + stats.level],
      ['斩妖数', String(stats.kills)],
      ['造成伤害', String(stats.dmgDealt)],
      ['承受伤害', String(stats.dmgTaken)],
      ['平均帧率', fpsTxt]
    ];
    var rh = px(21);
    for (var i = 0; i < rows.length; i++) {
      var yy = y + i * rh;
      if (i % 2 === 0) fillRR(x, yy - rh * 0.5 + px(2), w, rh - px(4), px(5), 'rgba(255,255,255,0.035)');
      text(rows[i][0], x + px(8), yy, fs(11.5), PAL.dim, 'left', 400);
      text(rows[i][1], x + w - px(8), yy, fs(11.5), PAL.white, 'right', 600);
    }
    return rows.length * rh;
  }

  function drawResult(win) {
    scrim(0.8);
    var st = win ? S.win : S.over;
    if (!st) return;
    var stats = st.stats, h = st.h;
    var pw = Math.min(W - px(28), px(380));
    var ph = Math.min(H - safe().top - safe().bottom - px(30), px(560));
    var x0 = (W - pw) * 0.5, y0 = (H - ph) * 0.5;
    panel(x0, y0, pw, ph);
    var cx = W * 0.5;
    var y = y0 + px(30);

    text(win ? '渡 劫 功 成' : '道消身陨', cx, y, fs(26), win ? PAL.gold : PAL.cinnabar, 'center', 700);
    y += px(24);
    text(win ? '八分钟撑满，剑心已成' : '败因：' + (stats.causeText || '群妖围杀'),
      cx, y, fs(11), PAL.dim, 'center', 400);
    y += px(22);

    y += statRows(stats, x0 + px(20), y + px(8), pw - px(40)) + px(16);

    var bh = px(46);
    var bw = pw - px(40);
    var by = y0 + ph - px(20) - bh;
    /* 判据用**肯定式** `=== true`：字段缺失时**不画**（而不是画一个点不动的
       按钮）。这个洞真的发生过 —— `snapshot()` 少了一个 adOk 字段，
       否定式把 undefined 当成了「有能力」，界面照画不误。 */
    if (!win && stats.reviveLeft > 0 && stats.adOk === true) {
      button('看广告 · 原地复活', x0 + px(20), by, bw, bh, 'gold',
        h.onRevive, '剩余 ' + stats.reviveLeft + ' 次');
      by -= bh + px(9);
    }
    if (win && !stats.doubleUsed && stats.adOk === true) {
      button('看广告 · 灵石翻倍', x0 + px(20), by, bw, bh, 'gold', h.onDouble, '本局 1 次');
      by -= bh + px(9);
    }
    var hw = (bw - px(9)) * 0.5;
    button(win ? '再战一局' : '重开一局', x0 + px(20), by, hw, bh * 0.8, 'primary', h.onRestart);
    button('回 山 门', x0 + px(20) + hw + px(9), by, hw, bh * 0.8, 'ghost', h.onHome);
  }

  function drawPause() {
    scrim(0.74);
    var pw = Math.min(W - px(48), px(320));
    var ph = px(300);
    var x0 = (W - pw) * 0.5, y0 = (H - ph) * 0.5;
    panel(x0, y0, pw, ph);
    var cx = W * 0.5;
    var y = y0 + px(34);
    text('暂 停', cx, y, fs(24), PAL.white, 'center', 700);
    y += px(34);
    var bh = px(44), bw = pw - px(36);
    button('继续修行', x0 + px(18), y, bw, bh, 'primary', S.pause && S.pause.resume);
    y += bh + px(10);
    button('设 置', x0 + px(18), y, bw, bh, 'ghost', S.pause && S.pause.settings);
    y += bh + px(10);
    button('放弃本局', x0 + px(18), y, bw, bh, 'danger', S.pause && S.pause.quit);
  }

  function drawSettings() {
    scrim(0.82);
    var st = XS.Settings;
    var pw = Math.min(W - px(24), px(400));
    var ph = Math.min(H - safe().top - safe().bottom - px(24), px(600));
    var x0 = (W - pw) * 0.5, y0 = (H - ph) * 0.5;
    panel(x0, y0, pw, ph);
    var cx = W * 0.5;
    var ix = x0 + px(18), iw = pw - px(36);

    text('设 置', cx, y0 + px(28), fs(20), PAL.white, 'center', 700);
    var y = y0 + px(54);

    /* 音量 */
    text('音 量', ix, y, fs(11.5), PAL.jade, 'left', 700);
    y += px(18);
    y += sliderRow('总音量', ix, y, iw, st.master, function (v) { st.master = v; st.apply(); st.save(); });
    y += sliderRow('音效', ix, y, iw, st.sfx, function (v) { st.sfx = v; st.apply(); st.save(); });
    y += sliderRow('配乐', ix, y, iw, st.music, function (v) { st.music = v; st.apply(); st.save(); });
    y += px(6);

    /* 画面 */
    text('画 面', ix, y, fs(11.5), PAL.jade, 'left', 700);
    y += px(18);
    y += segRow('画质', ix, y, iw, [
      { v: 'auto', t: '自动' }, { v: 'high', t: '高' }, { v: 'mid', t: '中' }, { v: 'low', t: '低' }
    ], st.quality, function (v) { st.quality = v; st.apply(); st.save(); markDirty(); });
    y += segRow('屏幕震动', ix, y, iw, [
      { v: 1, t: '开' }, { v: 0, t: '关' }
    ], st.shake, function (v) { st.shake = v; st.apply(); st.save(); markDirty(); });
    y += segRow('伤害数字', ix, y, iw, [
      { v: 1, t: '开' }, { v: 0, t: '关' }
    ], st.dmgNumbers ? 1 : 0, function (v) { st.dmgNumbers = !!v; st.apply(); st.save(); markDirty(); });
    y += px(6);

    /* 无障碍 */
    text('无 障 碍', ix, y, fs(11.5), PAL.jade, 'left', 700);
    y += px(18);
    y += segRow('色盲辅助', ix, y, iw, [
      { v: 1, t: '开启' }, { v: 0, t: '关闭' }
    ], st.colorblind ? 1 : 0, function (v) { st.colorblind = !!v; st.apply(); st.save(); markDirty(); });
    y += segRow('大字号', ix, y, iw, [
      { v: 1, t: '开启' }, { v: 0, t: '关闭' }
    ], st.bigText ? 1 : 0, function (v) { st.bigText = !!v; st.apply(); st.save(); markDirty(); });

    var hint = wrap('低画质降低分辨率与粒子数以保帧率；色盲辅助为妖魔加描边、并用形状区分冰火与妖将魔尊。',
      iw, fs(10));
    for (var i = 0; i < hint.length; i++) {
      text(hint[i], ix, y + px(10) + i * fs(14), fs(10), 'rgba(234,246,255,0.40)', 'left', 400);
    }

    var bh = px(42);
    button('完 成', ix, y0 + ph - px(18) - bh, iw, bh, 'primary', function () {
      UI.hideSettings();
      if (XS.Game.state() === 'paused') XS.Game.backToPause();
    });
  }

  /* ---- 山门：三栏内容 ---- */
  function metaBodyHeight() { return 0; }

  function drawMeta() {
    scrim(0.84);
    var pw = Math.min(W - px(20), px(420));
    var ph = Math.min(H - safe().top - safe().bottom - px(18), px(640));
    var x0 = (W - pw) * 0.5, y0 = (H - ph) * 0.5;
    panel(x0, y0, pw, ph);
    var ix = x0 + px(16), iw = pw - px(32);

    /* 头 */
    text('山 门', ix, y0 + px(26), fs(19), PAL.white, 'left', 700);
    var coinW = px(84);
    fillRR(x0 + pw - px(16) - coinW, y0 + px(14), coinW, px(24), px(8), rgba(PAL.gold, 0.14));
    text('灵 ' + (XS.Meta ? XS.Meta.data.coins : 0), x0 + pw - px(16) - coinW * 0.5,
      y0 + px(26), fs(12), PAL.gold, 'center', 700);

    /* Tab + 关闭。
       关闭按钮**不能叠在 Tab 行上** —— Tab 占满整行宽度时，
       ✕ 会正好压在「图鉴」两个字上，看起来像 Tab 被截断了。 */
    var tabs = [['shop', '灵石商店'], ['ach', '成 就'], ['codex', '图 鉴']];
    var cs = px(30);
    var ty = y0 + px(48);
    var tabsW = iw - cs - px(8);
    var tw = (tabsW - px(6) * 2) / 3;
    for (var i = 0; i < tabs.length; i++) {
      var tx = ix + i * (tw + px(6));
      var on = S.metaTab === tabs[i][0];
      fillRR(tx, ty, tw, px(30), px(8), on ? rgba(PAL.jade, 0.20) : 'rgba(255,255,255,0.04)');
      strokeRR(tx, ty, tw, px(30), px(8), on ? PAL.jade : 'rgba(160,200,230,0.20)', on ? 1.5 : 1);
      text(tabs[i][1], tx + tw * 0.5, ty + px(15), fs(11.5), on ? PAL.white : PAL.dim, 'center', on ? 700 : 500);
      (function (id) { hit(tx, ty, tw, px(30), function () { UI.renderMetaTab(id); }); })(tabs[i][0]);
    }

    /* 关闭 */
    var cxx = ix + iw - cs;
    fillRR(cxx, ty, cs, px(30), px(8), 'rgba(255,255,255,0.05)');
    text('✕', cxx + cs * 0.5, ty + px(15), fs(13), PAL.dim, 'center', 600);
    hit(cxx, ty, cs, px(30), function () { UI.hideMeta(); });

    /* 内容区（可滚动） */
    var bodyY = y0 + px(94);
    var bodyH = y0 + ph - px(16) - bodyY;
    ctx.save();
    ctx.beginPath(); ctx.rect(ix, bodyY, iw, bodyH); ctx.clip();
    var contentH = 0;
    if (S.metaTab === 'ach') contentH = drawAch(ix, bodyY - S.scroll, iw);
    else if (S.metaTab === 'codex') contentH = drawCodex(ix, bodyY - S.scroll, iw);
    else contentH = drawShop(ix, bodyY - S.scroll, iw);
    ctx.restore();
    S.scrollMax = Math.max(0, contentH - bodyH);
    S.scroll = U.clamp(S.scroll, 0, S.scrollMax);
    if (S.scrollMax > 0) {
      var barH = Math.max(px(20), bodyH * (bodyH / contentH));
      var barY = bodyY + (bodyH - barH) * (S.scroll / S.scrollMax);
      fillRR(x0 + pw - px(7), barY, px(3), barH, px(1.5), rgba(PAL.jade, 0.35));
    }
    /* 拖动滚动：注册在最上层（在列表项命中之后注册 → 会盖住它们？）
       不行：后注册的在上层，会吃掉购买按钮的点击。
       所以滚动注册在**内容区空白**上——用先注册的方式（先注册 = 下层）。 */
    hits.unshift({ x: ix, y: bodyY, w: iw, h: bodyH, fn: null, opt: { drag: true } });
  }

  function drawShop(x, y, w) {
    var view = XS.Meta.shopView();
    var yy = y;
    for (var i = 0; i < view.length; i++) {
      var r = view[i];
      var col = XS.TAG_COLOR[r.def.tag] || PAL.jade;
      var rh = px(74);
      var isPoor = S.poorFlash && !r.maxed && !r.affordable;
      var ox = isPoor ? Math.sin(S.poorFlash.t * 42) * px(4) : 0;

      fillRR(x + ox, yy, w, rh, px(11), 'rgba(255,255,255,0.035)');
      strokeRR(x + ox, yy, w, rh, px(11), r.maxed ? rgba(PAL.gold, 0.4) : 'rgba(160,200,230,0.16)', 1);

      var ic = px(34);
      fillRR(x + ox + px(10), yy + px(10), ic, ic, px(9), rgba(col, 0.16));
      text(r.def.icon, x + ox + px(10) + ic * 0.5, yy + px(10) + ic * 0.53, fs(17), col, 'center', 700);

      var tx = x + ox + px(10) + ic + px(10);
      var tw = w - (tx - x) - px(80);
      text(r.def.name, tx, yy + px(18), fs(13), PAL.white, 'left', 700);
      text('Lv ' + r.lv + ' / ' + r.def.max, tx + tw, yy + px(18), fs(10.5), PAL.dim, 'right', 500);
      text(r.effect, tx, yy + px(35), fs(11), col, 'left', 600);
      var dl = wrap(r.def.detail, tw, fs(9.5));
      for (var d = 0; d < Math.min(dl.length, 2); d++) {
        text(dl[d], tx, yy + px(49) + d * fs(12), fs(9.5), 'rgba(234,246,255,0.45)', 'left', 400);
      }

      /* 等级点 */
      var dn = r.def.max, dw = px(7), dg = px(3);
      for (var k = 0; k < dn; k++) {
        fillRR(tx + k * (dw + dg), yy + rh - px(12), dw, px(4), px(2),
          k < r.lv ? PAL.jade : 'rgba(255,255,255,0.14)');
      }

      /* 购买按钮 */
      var bwd = px(64), bhg = px(30);
      var bxx = x + ox + w - px(10) - bwd, byy = yy + (rh - bhg) * 0.5;
      var bs = r.maxed ? 'off' : (r.affordable ? 'gold' : 'off');
      button(r.maxed ? '圆满' : String(r.cost), bxx, byy, bwd, bhg, bs,
        makeBuy(r), null, r.def.name);

      yy += rh + px(9);
    }
    yy += px(4);
    var note = wrap('灵石来自每局结算（斩妖 / 妖将 / 魔尊）。永久强化只抬高下限、不改对局规则 —— 功法的形态、波次、手感一局都不会变。',
      w, fs(10));
    for (var n = 0; n < note.length; n++) {
      text(note[n], x, yy + n * fs(14), fs(10), 'rgba(234,246,255,0.40)', 'left', 400);
    }
    return yy + note.length * fs(14) - y;
  }

  /* 购买回调必须**在注册命中区之前**建好。
     先注册一个空函数再回头替换 hits 里最后一项，会让「按下态高亮」
     用的是旧函数引用 —— 表现为按下去没有反馈，看起来像按钮坏了。 */
  function makeBuy(r) {
    return function () {
      var res = XS.Meta.buy(r.def.id);
      if (res.ok) {
        if (XS.Audio) XS.Audio.play('levelup', 0.8);
        UI.renderMetaTab('shop');
      } else if (res.reason === 'poor') {
        if (XS.Audio) XS.Audio.play('ui', 0.5);
        S.poorFlash = { t: 0 };
        markDirty();
      }
    };
  }

  function drawAch(x, y, w) {
    var d = XS.Meta.data;
    var yy = y + px(16);
    text('已达成 ' + XS.Meta.achCount() + ' / ' + XS.ACHIEVEMENTS.length, x, yy, fs(11), PAL.gold, 'left', 600);
    yy += px(18);
    var tiers = { bronze: '#c98a5a', silver: '#c8d6e0', gold: PAL.gold, purple: PAL.purple };
    for (var i = 0; i < XS.ACHIEVEMENTS.length; i++) {
      var a = XS.ACHIEVEMENTS[i];
      var on = !!d.ach[a.id];
      var col = tiers[a.tier] || PAL.jade;
      var rh = px(52);
      fillRR(x, yy, w, rh, px(10), on ? rgba(col, 0.10) : 'rgba(255,255,255,0.025)');
      strokeRR(x, yy, w, rh, px(10), on ? rgba(col, 0.5) : 'rgba(160,200,230,0.13)', 1);
      text(on ? a.icon : '？', x + px(26), yy + rh * 0.5, fs(19), on ? col : 'rgba(234,246,255,0.20)', 'center', 700);
      text(a.name, x + px(48), yy + px(19), fs(12.5), on ? PAL.white : PAL.dim, 'left', 700);
      var dl = wrap(a.desc, w - px(120), fs(10));
      text(dl[0] || '', x + px(48), yy + px(35), fs(10), 'rgba(234,246,255,0.45)', 'left', 400);
      text(on ? '已达成' : '未达成', x + w - px(10), yy + px(19), fs(9.5), on ? col : 'rgba(234,246,255,0.25)', 'right', 600);
      yy += rh + px(8);
    }
    return yy - y;
  }

  function drawCodex(x, y, w) {
    var seen = XS.Meta.data.seen;
    var yy = y + px(16);
    var two = w > px(330);
    var cw = two ? (w - px(8)) * 0.5 : w;

    function section(title, cur, total) {
      text(title + '　' + cur + ' / ' + total, x, yy, fs(11), PAL.gold, 'left', 700);
      yy += px(18);
    }
    function card(cx, cy, cwid, on, icon, name, stats, body) {
      var rh = px(78);
      fillRR(cx, cy, cwid, rh, px(10), on ? 'rgba(77,232,255,0.07)' : 'rgba(255,255,255,0.025)');
      strokeRR(cx, cy, cwid, rh, px(10), on ? rgba(PAL.jade, 0.36) : 'rgba(160,200,230,0.13)', 1);
      text(on ? icon : '？', cx + px(8), cy + px(20), fs(16), on ? PAL.jade : 'rgba(234,246,255,0.20)', 'left', 700);
      text(on ? name : '未解锁', cx + px(32), cy + px(20), fs(12), on ? PAL.white : PAL.dim, 'left', 700);
      if (on) {
        text(stats, cx + px(9), cy + px(38), fs(9.5), PAL.jadeSoft, 'left', 500);
        var bl = wrap(body, cwid - px(18), fs(9.5));
        for (var i = 0; i < Math.min(bl.length, 3); i++) {
          text(bl[i], cx + px(9), cy + px(53) + i * fs(11), fs(9.5), 'rgba(234,246,255,0.45)', 'left', 400);
        }
      } else {
        text('在仙台上遭遇 / 习得后解锁', cx + px(9), cy + px(38), fs(9.5), 'rgba(234,246,255,0.28)', 'left', 400);
      }
      return rh;
    }

    /* 妖魔 */
    var n = 0, i, eh = [];
    for (i = 0; i < XS.CODEX_ENEMY_ORDER.length; i++) {
      var eid = XS.CODEX_ENEMY_ORDER[i];
      var ed = XS.ENEMY[eid];
      var on = !!seen.enemy[eid];
      if (on) n++;
      eh.push([on, XS.CODEX_ENEMY_ICON[eid] || '妖', ed.name,
        '气血 ' + ed.hp + '　速度 ' + ed.speed.toFixed(2) + '　伤害 ' + ed.dmg,
        XS.CODEX_ENEMY_TEXT[eid] || '']);
    }
    section('妖 魔', n, XS.CODEX_ENEMY_ORDER.length);
    for (i = 0; i < eh.length; i++) {
      var col2 = two ? (i % 2) : 0;
      var row2 = two ? Math.floor(i / 2) : i;
      card(x + col2 * (cw + px(8)), yy + row2 * px(86), cw,
        eh[i][0], eh[i][1], eh[i][2], eh[i][3], eh[i][4]);
    }
    yy += Math.ceil(eh.length / (two ? 2 : 1)) * px(86) + px(6);

    /* 功法 */
    n = 0;
    var sh = [];
    for (i = 0; i < XS.UPGRADES.length; i++) {
      var sd = XS.UPGRADES[i];
      var on2 = !!seen.skill[sd.id];
      if (on2) n++;
      sh.push([on2, sd.icon, sd.name, sd.tag + '　上限 Lv' + sd.max, sd.desc(0)]);
    }
    section('功 法', n, XS.UPGRADES.length);
    for (i = 0; i < sh.length; i++) {
      var c3 = two ? (i % 2) : 0;
      var r3 = two ? Math.floor(i / 2) : i;
      card(x + c3 * (cw + px(8)), yy + r3 * px(86), cw, sh[i][0], sh[i][1], sh[i][2], sh[i][3], sh[i][4]);
    }
    yy += Math.ceil(sh.length / (two ? 2 : 1)) * px(86) + px(6);

    /* 进化 */
    n = 0;
    var vh = [];
    for (i = 0; i < XS.CODEX_EVO_ORDER.length; i++) {
      var from = XS.CODEX_EVO_ORDER[i];
      var ev = XS.EVOLUTION_BY_FROM[from];
      var base = XS.UPGRADE_MAP[from];
      if (!ev || !base) continue;
      var on3 = !!seen.evo[from];
      if (on3) n++;
      vh.push([on3, ev.icon, ev.name, base.name + ' → ' + ev.name + '　前置 ' + XS.evoReqText(ev), ev.desc]);
    }
    section('功 法 进 化', n, XS.CODEX_EVO_ORDER.length);
    for (i = 0; i < vh.length; i++) {
      var c4 = two ? (i % 2) : 0;
      var r4 = two ? Math.floor(i / 2) : i;
      card(x + c4 * (cw + px(8)), yy + r4 * px(86), cw, vh[i][0], vh[i][1], vh[i][2], vh[i][3], vh[i][4]);
    }
    yy += Math.ceil(vh.length / (two ? 2 : 1)) * px(86) + px(6);

    return yy - y;
  }

  /* ---- 成就浮层 ---- */
  function drawToasts(dt) {
    var y = safe().top + px(70);
    for (var i = S.toasts.length - 1; i >= 0; i--) {
      var t = S.toasts[i];
      t.t += dt;
      if (t.t > 3.2) { S.toasts.splice(i, 1); markDirty(); continue; }
      var a = t.t > 2.7 ? (3.2 - t.t) / 0.5 : Math.min(1, t.t / 0.25);
      var tiers = { bronze: '#c98a5a', silver: '#c8d6e0', gold: PAL.gold, purple: PAL.purple };
      var col = tiers[t.a.tier] || PAL.gold;
      var w = Math.min(W - px(28), px(320)), h = px(62);
      var x = (W - w) * 0.5;
      ctx.globalAlpha = a;
      fillRR(x, y, w, h, px(11), 'rgba(6,18,28,0.94)');
      strokeRR(x, y, w, h, px(11), col, 1.5);
      text(t.a.icon, x + px(30), y + h * 0.5, fs(22), col, 'center', 700);
      text('成 就 达 成', x + px(56), y + px(18), fs(9.5), col, 'left', 600);
      text(t.a.name, x + px(56), y + px(34), fs(13), PAL.white, 'left', 700);
      text(t.a.desc, x + px(56), y + px(49), fs(9.5), PAL.dim, 'left', 400);
      ctx.globalAlpha = 1;
      y += h + px(8);
      markDirty();
    }
  }

  /* ============================================================
   * 总绘制
   * ============================================================ */
  function draw(dt) {
    hits.length = 0;
    ctx.clearRect(0, 0, W, H);

    var playing = XS.Game && XS.Game.state() === 'playing';
    if (playing) drawHud();

    if (S.screen === 'start') drawStart();
    else if (S.screen === 'level') drawLevel();
    else if (S.screen === 'over') drawResult(false);
    else if (S.screen === 'win') drawResult(true);
    else if (S.screen === 'pause') drawPause();
    else if (S.screen === 'settings') drawSettings();
    else if (S.screen === 'meta') drawMeta();

    drawToasts(dt || 1 / 60);
    redraws++;
  }

  /* 每帧调用：脏了才重画 + 上传纹理，然后把 UI 叠在后处理结果之上 */
  UI.render = function (renderer, dt) {
    frames++;
    markSeen = false;   /* 新的一帧开始：重新统计「这一帧有没有变」 */
    if (dirty) { dirty = false; draw(dt); tex.needsUpdate = true; }
    var prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(oScene, oCam);
    renderer.autoClear = prevAuto;
  };

  UI.debugUI = function () {
    return {
      backend: 'canvas2d',
      uiCanvas: cv ? (cv.width + 'x' + cv.height) : null,
      logical: W + 'x' + H,
      dpr: DPR, scale: +SC.toFixed(3),
      fontScale: XS.Settings ? XS.Settings.fontScale() : 1,
      screen: S.screen,
      hits: hits.length,
      redraws: redraws, frames: frames, marks: marks, changedFrames: changedFrames,
      /* 重画率**单独看没有意义**，它取决于这一屏有多少东西在变：
         安静对局里只有 1 Hz 的计时器在变 → 约 1/60；激烈交战时血条和
         经验条每帧都在变 → ≈1。两者都是对的，都不是 bug。
         正确性判据是 changedFrames：redraws 追不上它才是「漏画」，
         changedFrames=0 却还在重画才是「白画」（每帧白传一次整屏纹理，
         低端机直接掉帧）。注意这两个计数只在「步进+渲染一起做」的
         探针里才可比 —— 同步走查时会连续步进很多帧才渲染一次。 */
      redrawRate: frames ? +(redraws / frames).toFixed(3) : 0,
      skills: S.skills.length,
      toasts: S.toasts.length,
      dmgAlive: dmgs.filter(function (d) { return d.busy; }).length,
      scroll: Math.round(S.scroll), scrollMax: Math.round(S.scrollMax)
    };
  };

  /* 走查用：直接把 UI 切到某一屏（截图脚本靠它出图，不用模拟点击） */
  UI.debugScreen = function (name) {
    if (name === 'none') UI.hideAll();
    else if (name === 'start') UI.showStart(S.start || {});
    else if (name === 'pause') UI.showPause(function () {}, function () {}, function () {});
    else if (name === 'settings') UI.showSettings();
    else if (name === 'meta') UI.showMeta('shop');
    else if (name === 'meta-ach') { S.screen = 'meta'; UI.renderMetaTab('ach'); }
    else if (name === 'meta-codex') { S.screen = 'meta'; UI.renderMetaTab('codex'); }
    markDirty();
    return S.screen;
  };

  /* 走查用：**这一帧画了哪些可点区域、都在哪**。
     两个用途：
     1) 按文字找按钮并点它 —— 复活流程要真的走一遍，而不是靠看截图猜；
     2) 反向断言 ——「没有广告 API 时不该出现复活按钮」这件事，
        只有在能列出按钮清单之后才验得了。
     注意 hits 在每帧 draw() 开头被清空，所以它反映的是**最后一帧**。 */
  UI.debugHits = function () {
    return hits.map(function (r) {
      return {
        tag: (r.opt && r.opt.tag) || null,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.w), h: Math.round(r.h),
        cx: Math.round(r.x + r.w * 0.5), cy: Math.round(r.y + r.h * 0.5)
      };
    });
  };

  /* 走查用：按文字（子串）点一个按钮。找到就点，返回那个区域；没有返回 null。 */
  UI.tapText = function (sub) {
    var list = UI.debugHits();
    for (var i = 0; i < list.length; i++) {
      if (list[i].tag && list[i].tag.indexOf(sub) >= 0) {
        var h = list[i];
        UI.pointerDown(h.cx, h.cy);
        UI.pointerUp(h.cx, h.cy);
        return h;
      }
    }
    return null;
  };

})(typeof window !== 'undefined' ? window : this);
