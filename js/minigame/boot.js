/* ============================================================
 * 小游戏启动入口
 *
 * 和 Web 版的 js/main.js 是**两条独立的启动路径**，不是同一份代码加分支。
 *
 * 为什么分开：main.js 里 800 行有 600 行是调试设施 —— 同步模拟、
 * 机器人试玩、17 个走查开关、诊断 JSON 输出。这些在小游戏里
 * 一条都用不上（没有 URL、没有 DOM、没有第二张页面），
 * 却要吃掉首包体积、还会在真机上引入额外分支。
 *
 * 这里保留的只有三件事：
 *   1. 按正确顺序初始化各模块
 *   2. 音频解锁（小游戏必须由用户手势触发）
 *   3. 走查模式 —— 用**启动参数**驱动（小游戏没有 URL，
 *      但 wx.getLaunchOptionsSync().query 就是它的等价物，
 *      而且分享卡片带参数走的也是这条路，所以它顺带验证了参数链路）
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || {};
  if (!XS.MG) return;
  var host = XS.MG.host;

  /* ---------- 启动参数 ---------- */
  var Q = {};
  try { Q = (host.getLaunchOptionsSync && host.getLaunchOptionsSync().query) || {}; } catch (e) {}
  function has(k) { return Object.prototype.hasOwnProperty.call(Q, k); }
  function qv(k) { return has(k) ? Q[k] : null; }

  var booted = false, bootError = null;
  /* 失败面板画出来了没。null = 没走到失败路径。
     加它是因为：不加的话，「画了一张能看的错误页」和
     「画了一张被拉伸到只剩几个字的图」在诊断里完全一样（都是 state:'ready'），
     只能靠人去看截图 —— 而这段代码本来就是因为「没人看过」才坏掉的。 */
  var bootErrDrawn = null;
  var tGlobal = 0, last = 0;
  var frozen = false, frozenDrawn = 0;
  var FROZEN_FRAMES = 24;
  var uiShot = null;         /* 走查：把 UI 钉在某一屏 */
  var shots = 0;
  var botOn = false;         /* 走查机器人：默认关，真机上玩家自己走 */

  function now() { return XS.Platform.now(); }

  /* ------------------------------------------------------------
   * 启动失败时的兜底显示
   *
   * 小游戏没有 loading 遮罩可以写错误信息，黑屏 + 一行 console
   * 是排查成本最高的一种失败。这里试一下上屏画布还能不能拿 2D
   * 上下文（WebGL 初始化失败时通常还能），能就把错误画出来。
   *
   * 画什么：原来是把 `msg`（含整段堆栈）逐行刷上去 —— 和 Web 侧
   * 那个「一屏红字」是同一个毛病。玩家看不懂堆栈，也没法照着做。
   * 现在按「结论 → 办法 → 细节」排，堆栈压到最后、字号最小。
   * 小游戏这条路上 WebGL 由**宿主**提供，所以建不出来几乎只有三种原因：
   * 设备/系统太旧、同时开着太多小程序、宿主版本太老 —— 对应的办法也写在这儿。
   * ------------------------------------------------------------ */
  function drawBootError(msg) {
    bootErrDrawn = false;
    try {
      var c = XS.MG.screenCanvas;
      if (!c) return;
      /* 自己把画布定到屏幕尺寸 —— **不能指望它已经是对的**。
       *
       * 这是加 ?mgfail=1 做注入验证时才发现的：Core.init 里
       * **先创建渲染器、再 resize**，所以渲染器一失败，画布就停在
       * 宿主给的默认尺寸上（浏览器默认是 300x150）。
       * 而画布会被拉伸到全屏显示 —— 于是下面这段文字被放大十几倍，
       * 一屏只剩几个字，其余全被裁掉。
       * 也就是说：「启动失败该给玩家看什么」这个问题，
       * 本身又变成了一次失败。而这段代码在这之前**从来没有被渲染过**。
       *
       * 尺寸算法与 Core.resize 保持一致：逻辑尺寸 × min(dpr, 2)。
       * 取 min(...,2) 是因为 3x 屏按 3 倍画会让这张一次性错误页
       * 白占三倍显存，而它只是几行字。 */
      var pr = Math.min(global.devicePixelRatio || 1, 2);
      var sw = global.innerWidth || 0, sh = global.innerHeight || 0;
      if (sw > 0 && sh > 0) {
        var wantW = Math.round(sw * pr), wantH = Math.round(sh * pr);
        if (c.width !== wantW || c.height !== wantH) { c.width = wantW; c.height = wantH; }
      }
      var g2 = c.getContext('2d');
      if (!g2) return;
      var W = c.width, H = c.height;
      g2.setTransform(1, 0, 0, 1, 0, 0);
      g2.fillStyle = '#03080f';
      g2.fillRect(0, 0, W, H);

      var PAD = Math.round(W * 0.06);
      var MAXW = W - PAD * 2;
      var y = Math.round(H * 0.10);

      function wrap(text, font, maxw) {
        g2.font = font;
        var out = [], cur = '';
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          if (ch === '\n') { out.push(cur); cur = ''; continue; }
          if (g2.measureText(cur + ch).width > maxw && cur) { out.push(cur); cur = ch; }
          else cur += ch;
        }
        if (cur) out.push(cur);
        return out;
      }
      function para(text, font, color, lh, gap) {
        g2.fillStyle = color; g2.font = font;
        var ls = wrap(text, font, MAXW);
        for (var i = 0; i < ls.length; i++) { g2.fillText(ls[i], PAD, y); y += lh; }
        y += (gap || 0);
      }
      /* 截断必须留痕。裸 slice 出来的值看起来就像「值本来就是这样」——
         比如渲染器那一行会显示成 `ANGLE (Google, Vulkan 1.3.0 (Swift`，
         括号都不闭合，玩家/客服没法判断是被截了还是真长这样。
         一个会误导人的诊断字段，比没有这个字段更糟。 */
      function clip(s, n) {
        s = String(s);
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
      }

      var isGL = /webgl|context/i.test(String(msg));
      var probe = null;
      try { probe = (XS.Core && XS.Core.probeGL) ? XS.Core.probeGL() : null; } catch (e) {}
      var hasAny = probe && (probe.webgl2 || probe.webgl1);

      var F_TITLE = 'bold ' + Math.round(W * 0.052) + 'px sans-serif';
      var F_LEAD = Math.round(W * 0.034) + 'px sans-serif';
      var F_STEP = Math.round(W * 0.034) + 'px sans-serif';
      var F_SMALL = Math.round(W * 0.028) + 'px sans-serif';
      var F_TINY = Math.round(W * 0.024) + 'px monospace';

      if (isGL) {
        para('3D 画面起不来', F_TITLE, '#ffcf6b', Math.round(W * 0.075), Math.round(W * 0.03));
        para('这个游戏需要设备的 3D 绘图能力（WebGL），刚才没能建出来。'
          + (hasAny ? '探测显示这台设备是支持的，多半是同时开着太多小程序，'
                    + '或者上一次的 3D 上下文还没释放。'
                    : '探测显示当前环境拿不到 WebGL。'),
          F_LEAD, '#8fb3c7', Math.round(W * 0.055), Math.round(W * 0.045));

        g2.fillStyle = '#4de8ff'; g2.font = F_STEP;
        g2.fillText('按顺序试这几步：', PAD, y); y += Math.round(W * 0.06);
        var steps = [
          '1. 退出小程序重新进一次 —— 多数情况这一步就好了',
          '2. 关掉其他正在运行的小程序 / 小游戏，再重进',
          '3. 把微信（或抖音）更新到最新版本',
          '4. 换一台设备打开'
        ];
        for (var s = 0; s < steps.length; s++) {
          para(steps[s], F_STEP, '#eaf6ff', Math.round(W * 0.052), Math.round(W * 0.028));
        }
        y += Math.round(W * 0.02);
        g2.fillStyle = '#8fb3c7'; g2.font = F_SMALL;
        g2.fillText('这台设备上的探测结果', PAD, y); y += Math.round(W * 0.048);
        var rows = [
          ['WebGL 2', probe ? (probe.webgl2 ? '可用' : '不可用') : '探测失败'],
          ['WebGL 1', probe ? (probe.webgl1 ? '可用' : '不可用') : '探测失败']
        ];
        if (probe && probe.renderer) rows.push(['渲染器', String(probe.renderer)]);
        for (var r = 0; r < rows.length; r++) {
          g2.fillStyle = '#8fb3c7'; g2.font = F_SMALL;
          g2.fillText(rows[r][0], PAD, y);
          g2.fillStyle = '#eaf6ff';
          g2.fillText(clip(rows[r][1], 34), PAD + Math.round(W * 0.24), y);
          y += Math.round(W * 0.044);
        }
      } else {
        para('启动时出错了', F_TITLE, '#ffcf6b', Math.round(W * 0.075), Math.round(W * 0.03));
        para(String(msg).split('\n')[0], F_LEAD, '#8fb3c7', Math.round(W * 0.055), 0);
      }

      /* 技术细节放最后、字号最小、颜色最暗。
         它是给要反馈问题的人复制的，不该抢普通玩家的注意力。 */
      y += Math.round(W * 0.04);
      g2.fillStyle = '#5b7386'; g2.font = F_SMALL;
      g2.fillText('技术细节（反馈问题时截这张图）', PAD, y);
      y += Math.round(W * 0.044);
      g2.fillStyle = '#ff8f85'; g2.font = F_TINY;
      var lines = String(msg).split('\n');
      var room = Math.floor((H - y - PAD) / Math.round(W * 0.036));
      for (var i = 0; i < Math.min(lines.length, Math.max(0, room)); i++) {
        g2.fillText(clip(lines[i], 46), PAD, y);
        y += Math.round(W * 0.036);
      }
      bootErrDrawn = true;
    } catch (e) {}
  }

  /* ------------------------------------------------------------
   * 同步步进（走查用）
   *
   * 和 Web 版的 stepOnce 是同一件事：**不经过 rAF** 直接把
   * update 推 N 步。小游戏里 rAF 由宿主驱动，在模拟器/自动化环境
   * 里不可控，所以出图必须靠同步步进。
   *
   * 机器人走位（botOn）默认关：真机上玩家自己走。
   * 只在走查模式（`?mgplay=` / `?mguntil=`）下打开。
   * （这里原来还写着 `mgbot` —— 那个开关**从来不存在**，
   * botOn 只有上面那两处会置真。文档里列了一个不存在的参数，
   * 和 `?mgmeta=blank` 那次是同一类毛病：写的和做的不一致。）
   * ------------------------------------------------------------ */
  function stepOnce(dt) {
    if (botOn) {
      /* 触摸模式下走**宿主触摸回调**那条路，而不是直接写 Input.vec ——
         否则 js/minigame/input.js 永远不会被执行（见下面 touchDrive）。 */
      if (T.on) touchDrive(dt); else XS.Bot.input(dt);
    }
    tGlobal += dt;
    XS.World.update(dt, tGlobal);
    XS.Game.update(dt, tGlobal);
  }

  /* ------------------------------------------------------------
   * 触摸驱动（?mgtouch=1）
   *
   * 为什么需要：走查机器人是**直接写 `XS.Input.vec`** 的（js/bot.js），
   * 它绕过了整条触摸层 —— 于是 js/minigame/input.js 里的死区、归一化、
   * UI 优先、多指识别从来没执行过。代码在、看着能用、实际一次没跑过。
   * （这条正是「真机走查清单」里写的「触摸移动最容易从来没被走到过」。）
   *
   * 做法：把机器人「想要的方向」**反解**成摇杆位移，再从宿主的触摸回调
   * 发出去，让 input.js 真的算一遍，然后核对两个量：
   *   1. `vecCos`  —— input.js 从触摸算出的 vec 是否等于意图
   *                   （测死区 / 归一化 / 符号映射）
   *   2. `moveCos` —— 人物实际走的方向是否与意图同向
   *                   （测「输入真的接到了移动上」）
   * 两者都是余弦相似度，都该接近 1；映射写错时会明显掉下来甚至变负。
   *
   * 注入点 `global.__TOUCH__` 只有模拟器提供，真机上是 undefined ——
   * 所以这个模式在真机上自动不可用，不会影响线上行为。
   * ------------------------------------------------------------ */
  var T = {
    on: false, id: 71, down: false, ox: 0, oy: 0, frames: 0,
    cosSum: 0, cosN: 0, moveCosSum: 0, moveN: 0,
    sx: 0, sy: 0, lastIx: 0, lastIy: 0
  };

  /* 反解 input.js 的 setVec：
       setVec: n = len/maxR; k = min(1,(n-0.12)/0.55); vec = (dx/len)*k
     要得到模长为 kk 的意图，就得让 k = kk，即 n = 0.12 + 0.55*kk，
     于是 len = n*maxR、dx = (ux/kk)*len、dy = -(uy/kk)*len
     （屏幕 y 向下 = 世界 -z，所以 dy 取负）。 */
  function stickFor(ux, uy) {
    var kk = Math.hypot(ux, uy);
    if (kk < 1e-4) return { dx: 0, dy: 0 };
    var k = Math.min(0.999, kk);
    var len = (0.12 + 0.55 * k) * XS.Input._maxR;
    return { dx: ux / kk * len, dy: -uy / kk * len };
  }

  function touchDrive(dt) {
    var touch = global.__TOUCH__;
    if (!touch) return;
    XS.Bot.input(dt);                      /* 得到意图（它顺手写了 vec，我们只取方向） */
    var ix = XS.Input.vec.x, iy = XS.Input.vec.y;
    var il = Math.hypot(ix, iy);

    if (!T.down) {
      T.down = true;
      /* 起点选左下角：战斗 HUD 的命中区在右上（暂停）和上部（广告），
         摇杆起点若落进命中区会被「UI 优先」吃掉，人物就永远不动 ——
         那正是真机上会出现的症状。uiEats 会被报出来，>0 就是这个信号。 */
      T.ox = XS.MG.sys.windowWidth * 0.22;
      T.oy = XS.MG.sys.windowHeight * 0.74;
      touch.down(T.id, T.ox, T.oy);
    }
    var s = stickFor(ix, iy);
    touch.move(T.id, T.ox + s.dx, T.oy + s.dy);

    /* 1) vec 一致性 */
    var vx = XS.Input.vec.x, vy = XS.Input.vec.y;
    var vl = Math.hypot(vx, vy);
    if (il > 0.08 && vl > 0.08) {
      T.cosSum += (ix * vx + iy * vy) / (il * vl);
      T.cosN++;
    }
    /* 2) 位移一致性：世界方向 = (vec.x, -vec.y)。
       不能拿**瞬时**意图和位移比 —— player.moveX/moveZ 是经过
       `U.approach(..., 16, dt)` 平滑的，有约 60ms 滞后，而机器人每 ~0.05s
       就可能换方向（手抖 + 躲怪）。拿瞬时意图比会得到 0.69 这种
       「看着像 bug、其实是滞后」的数（我第一版就是这么写的）。
       所以这里用**同一个时间常数**把意图也平滑一遍，再和速度比。 */
    var k = 1 - Math.exp(-16 * dt);
    T.sx += (ix - T.sx) * k;
    T.sy += (iy - T.sy) * k;
    T.lastIx = ix; T.lastIy = iy;
    var p = XS.Game.player();
    if (p) {
      var mvl = Math.hypot(p.moveX, p.moveZ);
      var sl = Math.hypot(T.sx, T.sy);
      if (mvl > 1e-3 && sl > 0.08) {
        T.moveCosSum += (p.moveX * T.sx + p.moveZ * (-T.sy)) / (mvl * sl);
        T.moveN++;
      }
    }
    T.frames++;
  }

  /* 抬指再按一次：既走到 onEnd，又让冻结帧上留着摇杆（截图要它）。
     所以正常读数里 starts 是 2、ends 是 1。
     重按时用**最后一次意图**去摆摇杆，而不是读刚被清零的 Input.vec ——
     否则冻结帧上的摇杆永远停在圆心，看起来像「输入没生效」。 */
  function touchSettle() {
    var touch = global.__TOUCH__;
    if (!T.on || !touch || !T.down) return;
    touch.up(T.id, T.ox, T.oy);
    touch.down(T.id, T.ox, T.oy);
    var s = stickFor(T.lastIx || 0, T.lastIy || 0);
    touch.move(T.id, T.ox + s.dx, T.oy + s.dy);
  }

  function touchReport() {
    var i = (XS.Input.debugInput && XS.Input.debugInput()) || {};
    return {
      on: T.on, frames: T.frames,
      starts: i.starts, moves: i.moves, ends: i.ends, uiEats: i.uiEats,
      vecCos: T.cosN ? +(T.cosSum / T.cosN).toFixed(3) : null,
      moveCos: T.moveN ? +(T.moveCosSum / T.moveN).toFixed(3) : null,
      samples: [T.cosN, T.moveN],
      stick: i.stick, vec: i.vec
    };
  }

  /* ------------------------------------------------------------
   * 走查：按**按钮文字**点一下（?mgtap=复活）
   *
   * 为什么要专门做这件事：结算屏上的「看广告复活」是一条**完整的
   * 状态迁移**（广告回调 → 扣次数 → 满血 → 清场 → 回到 playing），
   * 而走查一直只跑到 `state === 'over'` 就截图 —— 也就是说这条链路
   * 从头到尾**一次都没被执行过**。截图里那个按钮画得好好的，
   * 「按钮画得出来」和「按下去有用」是两件事。
   *
   * 点的时候**走触摸层**（宿主 onTouchStart → UI 优先 → pointerDown），
   * 不走 XS.UI.pointerDown 直调。差别在于前者顺带验证了
   * 「UI 吃掉这一下、摇杆不吃」这条规则 —— 玩家点按钮时人物不该跑。
   * ------------------------------------------------------------ */
  var adTap = null;
  /* `?mguntil=` 的结果：目标状态 / 实际状态 / 为什么停 / 有没有走到。
     见 runUntil 里的注释 —— 「被截断」必须能自证。 */
  var untilInfo = null;

  /* 设置项的当前值。点一下设置面板之后要能看出**真的变了** ——
     只报「按钮在不在」的话，命中区没注册也会算通过。 */
  function snapSettings() {
    var s = XS.Settings;
    if (!s) return null;
    return {
      quality: s.quality, colorblind: !!s.colorblind, bigText: !!s.bigText,
      shake: s.shake, dmgNumbers: !!s.dmgNumbers,
      master: +s.master.toFixed(2), sfx: +s.sfx.toFixed(2), music: +s.music.toFixed(2)
    };
  }

  /* 局外成长（灵石 / 永久强化）的快照。
     商店购买是本项目里唯一一条**花钱并写存档**的事务 ——
     而走查一直是「?mgmeta=max 把档位拉满 + 把商店摆出来看一眼」，
     从没买过任何东西。所以要有读数才验得了。 */
  function snapMeta() {
    if (!XS.Meta || !XS.Meta.data) return null;
    return {
      coins: XS.Meta.data.coins,
      up: JSON.parse(JSON.stringify(XS.Meta.data.up))
    };
  }

  function adDrive() {
    var sub = qv('mgtap');
    if (!sub) return;
    var list = (XS.UI.debugHits && XS.UI.debugHits()) || [];
    var tags = [], found = null;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].tag) continue;
      tags.push(list[i].tag);
      if (!found && list[i].tag.indexOf(sub) >= 0) found = list[i];
    }
    var p = XS.Game.player();
    var r0 = XS.Game.debugRun ? XS.Game.debugRun() : null;
    var u0 = (XS.UI.debugUI && XS.UI.debugUI()) || {};
    adTap = {
      want: sub, found: !!found, tags: tags,
      stateBefore: XS.Game.state(),
      screenBefore: u0.screen || null,
      skillsBefore: u0.skills,
      hpBefore: p ? Math.round(p.hp) : null,
      maxHp: p ? Math.round(p.maxHp) : null,
      reviveBefore: r0 ? r0.reviveLeft : null,
      boostBefore: r0 ? r0.boostT : null,
      coinsBefore: r0 ? r0.coins : null,
      settingsBefore: snapSettings(),
      metaBefore: snapMeta(),
      /* 这一发**期望**什么：change（该变）/ none（该不变）。
         写进查询串而不是让脚本从结果反推 —— 「买不起时不该扣钱」和
         「买得起时该扣钱」是两条**相反**的断言，看结果猜不出该是哪条。 */
      expect: qv('mgtapExpect')
    };
    if (!found) {
      adTap.stateAfter = adTap.stateBefore;
      return;
    }
    var touch = global.__TOUCH__;
    if (touch) {
      touch.down(T.id + 3, found.cx, found.cy);
      touch.up(T.id + 3, found.cx, found.cy);
      adTap.via = 'touch';
    } else {
      XS.UI.pointerDown(found.cx, found.cy);
      XS.UI.pointerUp(found.cx, found.cy);
      adTap.via = 'pointer';
    }
    var p2 = XS.Game.player();
    var r1 = XS.Game.debugRun ? XS.Game.debugRun() : null;
    adTap.stateAfter = XS.Game.state();
    adTap.hpAfter = p2 ? Math.round(p2.hp) : null;
    adTap.reviveAfter = r1 ? r1.reviveLeft : null;
    adTap.boostAfter = r1 ? r1.boostT : null;
    adTap.coinsAfter = r1 ? r1.coins : null;
    var u1 = (XS.UI.debugUI && XS.UI.debugUI()) || {};
    adTap.screenAfter = u1.screen || null;
    adTap.skillsAfter = u1.skills;
    adTap.settingsAfter = snapSettings();
    adTap.settingsChanged = !!adTap.settingsBefore && !!adTap.settingsAfter &&
      JSON.stringify(adTap.settingsBefore) !== JSON.stringify(adTap.settingsAfter);
    adTap.metaAfter = snapMeta();
    adTap.metaChanged = !!adTap.metaBefore && !!adTap.metaAfter &&
      JSON.stringify(adTap.metaBefore) !== JSON.stringify(adTap.metaAfter);
    if (adTap.metaBefore && adTap.metaAfter) {
      adTap.coinsSpent = adTap.metaBefore.coins - adTap.metaAfter.coins;
      adTap.upBought = 0;
      for (var k in adTap.metaAfter.up) {
        if (!adTap.metaBefore.up || adTap.metaBefore.up[k] !== adTap.metaAfter.up[k]) adTap.upBought++;
      }
    }
    /* 复活成功的判据是**状态回到 playing**，不是「没报错」。
       只报「点了按钮没崩」的话，点了没反应也会算通过。 */
    adTap.revived = adTap.stateBefore === 'over' && adTap.stateAfter === 'playing';
    adTap.hpRefilled = adTap.hpAfter != null && adTap.hpAfter === adTap.maxHp;
    adTap.consumed = (adTap.reviveBefore != null && adTap.reviveAfter != null)
      ? adTap.reviveBefore - adTap.reviveAfter : null;
    adTap.boostOn = !!(adTap.boostAfter > 0);
  }

  /* ------------------------------------------------------------
   * 走查用：选牌机器人
   *
   * 策略本体在 **js/bot.js 的 XS.Bot.pickCard()**，两个宿主共用。
   * 这里只负责「把下标交给 Canvas UI 去点」。
   *
   * 一开始我在这里照着 Web 版重写了一遍，并注释说「策略和 Web 版一致」——
   * 那句话是错的。Web 版当时是抓 DOM 文本（`已习得 Lv3` / `尚未习得`）
   * 来判等级的，字符串匹配的细节和这里读 `current` 字段不同，
   * 于是两边选出来的构筑不一样：同条件 300 秒，Web 版剩 111 血、
   * 小游戏版剩 22 血。看起来像移植引入了难度差异，
   * 其实只是两个机器人做了不同的选择。
   * ------------------------------------------------------------ */
  function botPick() {
    var i = XS.Bot.pickCard(XS.Game.currentChoices());
    if (i < 0) return false;
    return XS.UI.pickCard(i);
  }

  /* ------------------------------------------------------------
   * 推进一步：升级就选牌，对局就步进。
   *
   * 为什么必须抽出来共用：`?mgplay=N`（跑 N 秒）和
   * `?mguntil=X`（跑到状态 X）必须是同一条逻辑。
   * 分开写的时候 mgplay 不选牌 —— 于是升级面板一弹出来就永远停在那儿，
   * 「战斗截图」拍到的其实是升级三选一。这个 bug 很难看出来：
   * 截图里确实有战场，只是被面板盖住了中间一大块。
   * ------------------------------------------------------------ */
  function advance(dt) {
    var st = XS.Game.state();
    if (st === 'levelup') { botPick(); return; }
    if (st === 'playing') stepOnce(dt);
  }

  /* 一路步进到某个状态（levelup / over / win）。
     用途：这三屏的数据只能由**真实对局**产生 —— 编一份假 stats
     去调 showOver() 只能证明「面板画得出来」，
     证明不了「游戏真的会走到这一步、并且把数据传对了」。 */
  function runUntil(target, capSeconds) {
    if (XS.Game.state() !== 'playing') { XS.UI.hideAll(); XS.Game.start(); }
    var maxSteps = Math.round((capSeconds || 900) * 60);
    var steps = 0;
    var why = 'cap';      // 默认按「被上限砍断」算，走到了才改成 reached
    while (steps < maxSteps) {
      var st = XS.Game.state();
      if (st === target) { why = 'reached'; break; }
      /* 落到 levelup / playing 之外（over / win）也算「走完了」——
         目标本来就是 over / win 的那些用例走的是这一支。 */
      if (st !== 'levelup' && st !== 'playing') { why = 'settled'; break; }
      advance(1 / 60);
      steps++;
    }
    /* 返回值以前没人接 —— 于是「到了」和「被砍断」在诊断里长得一样。
       现在把它记下来，让诊断自己说清楚这一发有没有走到。 */
    untilInfo = {
      target: target, state: XS.Game.state(), steps: steps,
      capSteps: maxSteps, why: why, reached: XS.Game.state() === target
    };
    return untilInfo;
  }

  function boot() {
    if (booted) return;
    booted = true;

    try {
      var canvas = XS.MG.takeScreenCanvas();
      /* 故障注入：把「启动失败」这条路**真的走一遍**。
       *
       * 没有这个开关的时候，drawBootError 那段代码从来没有被渲染过 ——
       * 写好了、打包了、看着没问题，但「字会不会排到屏幕外」
       * 「中文换行对不对」「探测表会不会压住技术细节」一次都没人看过。
       * 而它正是玩家在真机上唯一会看到的东西（Web 侧那次失败就是这么来的）。
       *
       * 位置是刻意的：必须在 takeScreenCanvas() **之后**、
       * Core.init() **之前**。因为 drawBootError 要往 screenCanvas 上画，
       * 提前抛的话它连画布都拿不到，会静默什么都不画 ——
       * 于是「注入的故障」和「真的故障」表现得不一样，这个开关就白加了。
       * 真实失败正是发生在 Core.init 里，顺序一致。
       *
       * 思路和 ?mgaudio=none 一样：把「宿主给不了」变成可复现的输入，
       * 而不是等真机上碰运气。 */
      if (has('mgfail')) throw new Error('Error creating WebGL context.');
      XS.Core.init(canvas);
      XS.UI.init();
      XS.World.init(XS.Core.scene);
      XS.Game.init(XS.Core.scene, XS.Core.camera);
      XS.Input.bind();
    } catch (err) {
      bootError = (err && err.message ? err.message : String(err)) +
        '\n' + (err && err.stack ? err.stack : '');
      try { console.error('[xs] BOOT FAILED: ' + bootError); } catch (e) {}
      drawBootError(bootError);
      return;
    }

    var menu = {
      onStart: function () { XS.UI.hideAll(); XS.Game.start(); },
      /* 小游戏没有第二张页面：数据面板是 Web 版专有的走查工具。
         真机上的数据走 telemetry + 平台后台，所以这里什么都不做 ——
         留一个空实现比留一个会抛错的 open() 好。 */
      onData: function () {}
    };
    XS.Game.setMenuHandlers(menu);
    XS.UI.initSettings();
    XS.UI.showStart(menu);

    /* ---------- 局外成长的走查档位 ----------
     *
     * Web 版这些开关在 main.js 里（?metamax / ?nometa / ?grant / ?reveal）。
     * 小游戏没有 URL，等价物是启动参数，所以在这里重接一遍。
     * 接口本身（Meta.setMax / setBlank / debugGrant / debugReveal）
     * 在 meta.js 里，小游戏包也带着，不需要重写。
     *
     * 凡是「走查 / 截图」性质的档位都置 Meta.offline = true ——
     * 走查和批量跑局**永远不碰玩家的真实存档**。 */
    if (has('mgmeta')) {
      var mv = qv('mgmeta');
      if (mv === 'max') { XS.Meta.setMax(); XS.Meta.offline = true; }
      /* blank 也必须置 offline。原来只置了 max —— 于是 `?mgmeta=blank`
         那一发会**真的往存档里写**（commitRun 判的就是 offline）。
         走查不该动玩家存档，这是硬规矩；而且 README 里写的就是
         「两个档位都自动置 offline」，代码得和它对上。 */
      else if (mv === 'blank') { XS.Meta.setBlank(); XS.Meta.offline = true; }
    }
    if (has('mggrant')) XS.Meta.debugGrant(parseInt(qv('mggrant'), 10) || 0, true);
    if (has('mgreveal')) XS.Meta.debugReveal(parseInt(qv('mgreveal'), 10) || 0);

    /* ---------- 音频解锁 ---------- */
    /* 小游戏的音频必须由用户手势解锁，且只有一次机会窗口。
       这里绑一次就摘掉，避免每次触摸都调一次 unlock。 */
    var unlocked = false;
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      try { XS.Audio.unlock(); XS.Audio.startMusic(); } catch (e) {}
    }
    if (host.onTouchStart) host.onTouchStart(unlock);
    if (host.onShow) host.onShow(unlock);

    /* ---------- 走查模式 ---------- */
    /* 走查一律是**固定 dt 的同步步进**（下面 stepOnce(1/60) 那条路），
       主循环不按真实时间推进，所以帧率读数没有意义：
       固定 1/60 步进会让 `60 / (dt)` 恒等于 **3600**。
       必须在这里告诉游戏层，否则结算面板会把 3600 fps 当成一个
       成绩展示出来 —— 作品集截图里就是这么一张，看的人只会以为游戏坏了。

       Web 侧的 `?play` / `?farm` 早就调了 setSyncMode(true)，
       小游戏侧一直漏着 —— 又是「同一件事两个宿主各写一遍，
       只写对了其中一边」。 */
    if (has('mgplay') || has('mguntil')) XS.Game.setSyncMode(true);

    if (has('mguntil')) {
      /* 跑到指定状态为止（levelup / over / win），全程走真实对局。
         机器人必须开：不开的话玩家 22 秒就被围死，结算屏拍得到、
         「通关」永远拍不到 —— 而且更糟的是触摸输入那条路根本没被走到。 */
      botOn = true;
      if (qv('mgskill') !== null) XS.Bot.skillSet(parseFloat(qv('mgskill')));
      if (has('mgtouch')) T.on = true;
      runUntil(qv('mguntil'), parseFloat(qv('mgcap') || '900'));
      uiShot = qv('mgui');
      if (uiShot) XS.UI.debugScreen(uiShot);
      touchSettle();
      XS.Core.renderer.info.reset();
      XS.Core.composer.render();
      XS.UI.render(XS.Core.renderer, 1 / 60);
      /* 先画一帧（可点区域清单是画的时候登记的），再按文字点按钮。
         点完再画一帧，否则冻结帧拍到的还是点之前那张 ——
         于是「复活成功」的截图看起来和「复活前」一模一样。 */
      adDrive();
      if (adTap && adTap.found) {
        XS.Core.renderer.info.reset();
        XS.Core.composer.render();
        XS.UI.render(XS.Core.renderer, 1 / 60);
      }
      frozen = true;
      frozenDrawn = 0;
      last = now();
      requestAnimationFrame(frame);
      return;
    }

    if (has('mgplay')) {
      var secs = parseFloat(qv('mgplay')) || 0;
      if (XS.Game.state() !== 'playing') { XS.UI.hideAll(); XS.Game.start(); }
      if (qv('mgseed') !== null) { /* 场景种子由 world 自己读，这里只占位 */ }
      botOn = true;
      if (qv('mgskill') !== null) XS.Bot.skillSet(parseFloat(qv('mgskill')));
      if (has('mgtouch')) T.on = true;
      /* 全程 advance（升级自动选牌），否则一升级就卡在面板上 */
      for (var i = 0; i < secs * 60; i++) advance(1 / 60);
      /* 收尾：如果最后一步正好撞上升级，把它选掉。
         否则 ?mgplay=N 会随机地停在升级面板上 ——
         而「拍战斗截图」最怕的就是这个：图里有战场，只是中间被面板盖住。
         选掉之后，?mgplay=N 保证停在一个可渲染的对局帧（或阵亡）。 */
      if (XS.Game.state() === 'levelup') botPick();
      /* 冻结前测一次**带步进**的边际重画率 —— 这一帧之后逻辑不再推进，
         所以必须在这里测，晚了就测不到了。 */
      liveProbe = XS.MG.probeRedraw(30, true);
      uiShot = qv('mgui');
      if (uiShot) XS.UI.debugScreen(uiShot);
      touchSettle();
      /* 先出一帧把实例矩阵、UI 纹理都写出来，再冻结 ——
         不这么做的话，冻结帧拍到的是「还没画过的 UI」。 */
      XS.Core.renderer.info.reset();
      XS.Core.composer.render();
      XS.UI.render(XS.Core.renderer, 1 / 60);
      /* 局内点位（神行符）只能在 mgplay 这条路上点：
         它要求 runT > 90，而 mguntil 那几条常常活不到 90 秒。 */
      adDrive();
      if (adTap && adTap.found) {
        XS.Core.renderer.info.reset();
        XS.Core.composer.render();
        XS.UI.render(XS.Core.renderer, 1 / 60);
      }
      frozen = true;
      frozenDrawn = 0;
      last = now();
      requestAnimationFrame(frame);
      return;
    }

    if (has('mgui')) {
      uiShot = qv('mgui');
      XS.UI.debugScreen(uiShot);
    }

    /* 质量档位可以由启动参数锁死（低端机走查用） */
    if (has('mgquality')) {
      XS.Settings.quality = qv('mgquality');
      XS.Settings.apply();
    }
    if (has('mgcb')) {
      XS.Settings.colorblind = qv('mgcb') !== '0';
      XS.Settings.bigText = qv('mgbig') === '1';
      XS.Settings.apply();
    }

    last = now();
    requestAnimationFrame(frame);
  }

  function frame() {
    requestAnimationFrame(frame);
    var n = now();
    var dt = Math.min((n - last) / 1000, 1 / 25);
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    last = n;

    if (frozen) {
      /* 冻结出图：只重画、不推进逻辑，保证自动化截图拿到的是
         同步步进结束时那一帧，而不是「再过几帧之后」的另一帧。 */
      if (frozenDrawn < FROZEN_FRAMES) {
        frozenDrawn++;
        XS.Core.renderer.info.reset();
        XS.Core.composer.render();
        XS.UI.render(XS.Core.renderer, 1 / 60);
      }
      return;
    }

    XS.World.update(dt, tGlobal);
    XS.Game.update(dt, tGlobal);
    XS.Core.adaptQuality(dt);
    XS.Core.renderer.info.reset();
    XS.Core.composer.render();
    XS.UI.render(XS.Core.renderer, dt);
    tGlobal += dt;
  }

  /* ------------------------------------------------------------
   * 诊断：小游戏里没有 DOM 可以写，所以暴露成函数，
   * 由模拟器 / 自动化外壳去取。真机上它也就是个普通对象。
   *
   * **每个字段各自兜底**，不要用一个 try 把整段包起来。
   *
   * 为什么：这些 debug* 访问器里有好几个在「系统还没就绪」时会抛
   * （`debugBuild()` 在还没开局时读 `player.level` 就抛）。
   * 用一个 try 包整段的话，第一个抛出来的会把**后面所有字段全丢掉** ——
   * 症状是诊断里只剩 state/t，`ui` / `drawCalls` / `sceneChildren`
   * 全都不见了，看起来像「UI 根本没初始化」。
   * 而诊断恰恰是在「系统坏了」的时候被调用的，它必须比被测对象更结实。
   *
   * 兜底之后：坏掉的那一项变成 `<key>Err`，其余照常输出。
   * ------------------------------------------------------------ */
  function safe(o, k, fn) {
    try {
      var v = fn();
      if (v !== undefined) o[k] = v;
    } catch (e) {
      o[k + 'Err'] = e.message;
    }
  }

  XS.MG.diag = function () {
    var out = {
      errors: [],
      bootError: bootError,
      env: XS.Platform.env,
      platform: XS.MG.platform,
      screen: XS.MG.sys.windowWidth + 'x' + XS.MG.sys.windowHeight,
      dpr: global.devicePixelRatio,
      threeRev: global.THREE ? global.THREE.REVISION : null,
      /* 最终是哪一组参数把渲染器建起来的。
         正常是 'webgl2+highperf'；报出别的值说明这台设备降级了 ——
         降级能跑通，但性能和特性都可能有差异，
         「画面和别人不一样」这类反馈有它就不用猜。 */
      glAttempt: (XS.Core && XS.Core.glAttempt) || null,
      /* 失败面板到底画出来了没。
         没有这一项时，「启动失败」在诊断里只表现为 state:'ready' ——
         而「画了一张能看的错误页」和「画了一张被拉伸到只剩几个字的图」
         在诊断里长得一模一样，只能靠人去看截图。
         null = 根本没走到失败路径（正常启动）。 */
      bootErrDrawn: bootErrDrawn,
      state: XS.Game.state(),
      t: +tGlobal.toFixed(2),
      frozen: frozen,
      query: Q
    };
    safe(out, 'canvas', function () {
      var c = XS.MG.screenCanvas;
      return c ? (c.width + 'x' + c.height) : null;
    });
    safe(out, 'player', function () {
      var p = XS.Game.player();
      if (!p) return null;
      return {
        level: p.level, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp),
        x: +p.x.toFixed(1), z: +p.z.toFixed(1)
      };
    });
    /* 一局进行到哪儿了：计时 / 击杀 / 灵石。
       这里原本写的是 `kills: null` —— 一个**长得像读数、其实是常量**
       的占位。Web 侧同一项报得出数字，于是「小游戏击杀统计坏了」
       看起来像结论，其实只是诊断没接。数字只有一个来源：
       js/game.js 的 Game.debugRun()，Web 与小游戏共用。 */
    safe(out, 'run', function () { return XS.Game.debugRun && XS.Game.debugRun(); });
    safe(out, 'a11y', function () { return XS.Game.debugA11y && XS.Game.debugA11y(); });
    safe(out, 'status', function () { return XS.Game.debugStatus && XS.Game.debugStatus(); });
    /* build / meta 用来和 Web 版**逐项对比**。
       只报「活了多少秒」是不够的：活多久是结果，
       build（功法、伤害、减伤）才是能定位差异的那个中间量。 */
    safe(out, 'build', function () { return XS.Game.debugBuild && XS.Game.debugBuild(); });
    safe(out, 'meta', function () { return XS.Game.debugMeta && XS.Game.debugMeta(); });
    safe(out, 'bot', function () { return XS.Bot && XS.Bot.debug && XS.Bot.debug(); });
    safe(out, 'ui', function () { return XS.UI.debugUI && XS.UI.debugUI(); });
    /* 触摸层有没有真的被走到、映射对不对。
       走查机器人默认直接写 Input.vec，绕过了整条触摸层 ——
       这个字段是唯一能证明「触摸输入被验证过」的东西。
       vecCos / moveCos 应当接近 1；starts=0 说明这次根本没走触摸路径。 */
    safe(out, 'touch', function () { return touchReport(); });
    /* 广告点位：宿主有没有能力、这次按了哪个按钮、按完状态变成什么。
       `capable` 和 `tap.found` 要一起看 ——
       capable=false 时 found 必须是 false（不摆出点不动的按钮），
       capable=true 时 found 必须是 true 且 tap.revived 必须是 true。 */
    safe(out, 'ad', function () {
      return {
        capable: !!(XS.Platform.canShowAd && XS.Platform.canShowAd()),
        mode: qv('mgad'),
        tap: adTap
      };
    });
    /* 音频。这是这个子系统**第一次**有读数 ——
       以前它一条验证都没有：34 个调用点写得整整齐齐，
       但从来没人确认过任何一个音真的被调度出去。
       `via` 回答「上下文是从哪来的」（小游戏上必须是 'host'，
       走浏览器原生那条就等于真机那条路没被验到）；
       `played` 回答「有没有真的响」；`lastUnknown` 只要有值就一定是 bug。 */
    safe(out, 'audio', function () {
      var a = XS.Audio && XS.Audio.debugInfo ? XS.Audio.debugInfo() : null;
      if (!a) return null;
      /* 把宿主工厂的供给情况拼进来：'host' 是宿主给了，
         'none' 是宿主没给，'native' 只可能出现在浏览器里。 */
      a.factory = (XS.MG && XS.MG.audioFactory) || null;
      /* 模拟器侧的图统计（节点建了几个 / start 了几次 / connect 了几次）。
         浏览器里没有这个对象，就是 null。 */
      a.graph = global.__AUDIO_REC__ || null;
      return a;
    });
    /* `?mguntil=` 到底走到了没有。
       以前这里只有 state —— 「到了目标状态」和「撞上 mgcap 上限被砍断」
       都是同一个读数，得靠读的人自己去比。这和平衡测量那边
       （`?farm` 的 240s 兜底）是同一个毛病：**被截断的样本
       和完整的样本长得一样**。所以把 reached / steps 一起报出来。 */
    safe(out, 'until', function () { return untilInfo; });
    /* 设置项当前值。走查里设置面板一直是「摆出来看一眼」，
       从来没人点过它 —— 点不动的话（比如命中区没注册）在手机上
       就是「设置改不了」，而截图完全正常。有读数才验得了。 */
    safe(out, 'settings', function () {
      var s = XS.Settings;
      return {
        quality: s.quality, colorblind: !!s.colorblind, bigText: !!s.bigText,
        shake: s.shake, dmgNumbers: !!s.dmgNumbers,
        master: +s.master.toFixed(2), sfx: +s.sfx.toFixed(2), music: +s.music.toFixed(2)
      };
    });
    out.botOn = botOn;
    safe(out, 'sceneChildren', function () { return XS.Core.scene.children.length; });
    safe(out, 'drawCalls', function () { return XS.Core.renderer.info.render.calls; });
    safe(out, 'triangles', function () { return XS.Core.renderer.info.render.triangles; });
    safe(out, 'prScale', function () { return XS.Core.prScale; });
    /* 放在最后：探针本身会连画 30 帧，会改掉 renderer.info。
       先取 drawCalls/triangles 再探，顺序不能反。 */
    safe(out, 'redrawProbe', function () { return XS.MG.probeRedraw(30); });
    out.redrawProbeLive = liveProbe;
    return out;
  };

  /* ------------------------------------------------------------
   * 脏标记探针：**同步**测「该重画的有没有重画、不该重画的有没有白画」。
   *
   * 为什么不能靠数帧来测：走查是无头跑的，而 --virtual-time-budget
   * 根本不推进 rAF（实测：只挂了 rAF 的那一发诊断永远不出现在 DOM 里）。
   * 所以「跑够 20 帧再看 redrawRate」这条路是死的 —— 代码在、
   * 看着能用、实际永远拿不到数据。这里改成同步连画 N 帧来测边际重画率。
   *
   * 判读：**不要拿重画率本身当判据。**
   * 我一开始把参考值写成「对局中应该接近 1」，理由是「计时器每帧都在变」——
   * 那句话是错的：setTimer 比的是格式化后的 mm:ss 字符串，一秒才变一次。
   * 于是安静对局（满血、没击杀）下唯一会变的只有计时器，重画率 1/60 ≈ 0.017
   * 才是**正确**读数，而它看起来像「UI 不刷新」。
   *
   * 真正的判据是「有变的帧数」changedFrames：
   *   redraws 追不上 changedFrames → 漏画（画面停在旧值上）
   *   changedFrames = 0 却还在重画 → 白画（每帧白传一次整屏纹理，低端机掉帧）
   * 为什么不是和 marks（标脏次数）比：一帧里可能标脏多次（掉血 + 经验 +
   * 击杀各一次），但它们只需要重画一次 —— 我第一版就是拿 marks 比的，
   * 结果在完全正常的对局里报出 `stale: true`（26 次标脏 / 23 次重画）。
   * ------------------------------------------------------------ */
  XS.MG.probeRedraw = function (n, withStep) {
    n = n || 30;
    var before = XS.UI.debugUI();
    for (var i = 0; i < n; i++) {
      /* withStep=true 复刻真实帧循环（逻辑 + 渲染都走一遍）；
         false 则只渲染。两者都要测，因为两种失败方向相反：
         空转测「有没有白画」，带步进测「有没有漏画」。 */
      if (withStep) stepOnce(1 / 60);
      XS.Core.composer.render();
      XS.UI.render(XS.Core.renderer, 1 / 60);
    }
    var after = XS.UI.debugUI();
    var df = after.frames - before.frames;
    var dr = after.redraws - before.redraws;
    var dm = after.marks - before.marks;
    var dc = after.changedFrames - before.changedFrames;
    return {
      frames: df, marks: dm, changed: dc, redraws: dr,
      rate: df ? +(dr / df).toFixed(3) : null,
      /* 允许 redraws = changed + 1：进入探针时可能挂着一次未处理的标脏 */
      stale: dr < dc,
      wasted: dc === 0 && dr > 1
    };
  };
  /* 对局态的边际重画率：由 mgplay / mguntil 路径在冻结前填。
     放在冻结前而不是 diag 里，是因为 diag 再步进会改掉待截图的那一帧。 */
  var liveProbe = null;

  /* 自动化外壳可以用它继续推进模拟 */
  XS.MG.step = function (seconds) {
    for (var i = 0; i < seconds * 60; i++) stepOnce(1 / 60);
    XS.UI.render(XS.Core.renderer, 1 / 60);
  };
  XS.MG.ui = function (name) { return XS.UI.debugScreen(name); };
  XS.MG.tap = function (x, y) {
    XS.UI.pointerDown(x, y);
    XS.UI.pointerUp(x, y);
    return true;
  };

  boot();

})(typeof window !== 'undefined' ? window : this);
