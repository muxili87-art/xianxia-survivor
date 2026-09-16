/* ============================================================
 * 小游戏触摸输入
 *
 * core.js 里的 Input.bind() 是 DOM 版（摇杆是三个 div）。
 * 小游戏没有 DOM，所以这里**整体替换** XS.Input.bind。
 *
 * 为什么用替换而不是给 core.js 加分支：
 * 输入是「平台差异最大、逻辑最小」的一块。让它各自完整实现一遍，
 * 比在一份代码里塞两套分支更好读，也更好验证 ——
 * 两边都只要保证同一个契约：写对 XS.Input.vec / Input.active。
 *
 * 一条硬约束：**UI 优先于摇杆**。
 * 玩家点「入局」按钮的那一下如果同时被当成摇杆起点，
 * 会出现「按了开始键，人物同时朝那个方向跑了一段」。
 * 所以 touchstart 先问 UI 要不要吃掉这个点。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  if (!XS.MG) return;              /* 非小游戏环境：保留 core.js 的 DOM 版 */
  var host = XS.MG.host;

  var Input = XS.Input;

  /* 摇杆的可视状态。ui2d 每帧读它画圆环；
     它和 Input.vec 是两件事 —— 前者是「手指在哪」，后者是「人物往哪走」
     （中间隔着死区与归一化）。混成一个的话，死区内的手指位置
     会被画到摇杆边缘上，看起来像输入坏了。 */
  Input.stick = { active: false, cx: 0, cy: 0, dx: 0, dy: 0, id: null };

  /* 计数：这条路径**有没有真的被走到**。
     为什么需要它：走查机器人是直接写 XS.Input.vec 的（js/bot.js），
     它绕过了整个触摸层 —— 于是下面 onStart / onMove / onEnd 里的
     死区、归一化、UI 优先、多指识别从来没执行过。
     代码在、看着能用、实际一次都没跑过，正是最难发现的一类问题。
     有了计数就能问一句：这次走查里 starts 是不是 0？
     是 0 就说明「触摸输入已验证」这句话根本不成立。 */
  var counts = { starts: 0, moves: 0, ends: 0, uiEats: 0, cancels: 0 };

  Input.debugInput = function () {
    return {
      starts: counts.starts, moves: counts.moves, ends: counts.ends,
      uiEats: counts.uiEats, cancels: counts.cancels,
      active: !!Input.active,
      stick: !!Input.stick.active,
      vec: [+Input.vec.x.toFixed(3), +Input.vec.y.toFixed(3)],
      stickD: [+Input.stick.dx.toFixed(1), +Input.stick.dy.toFixed(1)]
    };
  };

  Input.bind = function () {
    var stick = Input.stick;
    var maxR = Input._maxR;

    function setVec(dx, dy) {
      var len = Math.hypot(dx, dy);
      var n = len / maxR;
      if (n < 0.12) { Input.vec.x = 0; Input.vec.y = 0; return; }
      var k = Math.min(1, (n - 0.12) / 0.55);
      var il = 1 / (len || 1);
      Input.vec.x = dx * il * k;
      Input.vec.y = -dy * il * k;   /* 屏幕向下 = 世界 -z */
    }

    function start(id, cx, cy) {
      Input.active = true;
      Input._cx = cx; Input._cy = cy;
      Input._stickId = id;
      stick.active = true; stick.id = id;
      stick.cx = cx; stick.cy = cy; stick.dx = 0; stick.dy = 0;
      Input.vec.x = 0; Input.vec.y = 0;
    }

    function move(cx, cy) {
      var dx = cx - Input._cx, dy = cy - Input._cy;
      var len = Math.hypot(dx, dy);
      if (len > maxR) { dx = dx / len * maxR; dy = dy / len * maxR; }
      stick.dx = dx; stick.dy = dy;
      setVec(dx, dy);
    }

    function end() {
      Input.active = false;
      Input._stickId = null;
      stick.active = false; stick.id = null;
      stick.dx = 0; stick.dy = 0;
      Input.vec.x = 0; Input.vec.y = 0;
    }

    /* UI 正在按住的那根手指。null 表示没有。 */
    var uiId = null;

    function uiWants(x, y) {
      return !!(XS.UI && XS.UI.pointerDown && XS.UI.pointerDown(x, y));
    }

    function onStart(e) {
      counts.starts++;
      var list = e.changedTouches || e.touches || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var x = t.clientX, y = t.clientY;
        if (uiId === null && uiWants(x, y)) { uiId = t.identifier; counts.uiEats++; continue; }
        if (Input._stickId === null) start(t.identifier, x, y);
      }
    }

    function onMove(e) {
      counts.moves++;
      var list = e.changedTouches || e.touches || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (uiId !== null && t.identifier === uiId) {
          if (XS.UI.pointerMove) XS.UI.pointerMove(t.clientX, t.clientY);
          continue;
        }
        if (t.identifier === Input._stickId) move(t.clientX, t.clientY);
      }
    }

    function onEnd(e) {
      counts.ends++;
      var list = e.changedTouches || e.touches || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (uiId !== null && t.identifier === uiId) {
          uiId = null;
          if (XS.UI.pointerUp) XS.UI.pointerUp(t.clientX, t.clientY);
          continue;
        }
        if (t.identifier === Input._stickId) end();
      }
    }

    if (host.onTouchStart) host.onTouchStart(onStart);
    if (host.onTouchMove) host.onTouchMove(onMove);
    if (host.onTouchEnd) host.onTouchEnd(onEnd);
    if (host.onTouchCancel) {
      host.onTouchCancel(function () {
        counts.cancels++;
        uiId = null;
        if (XS.UI && XS.UI.pointerCancel) XS.UI.pointerCancel();
        if (Input._stickId !== null) end();
      });
    }

    return Input;
  };

})(typeof window !== 'undefined' ? window : this);
