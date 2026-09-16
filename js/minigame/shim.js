/* ============================================================
 * 小游戏运行环境适配层（微信 wx / 抖音 tt）
 *
 * 为什么需要这一层：小游戏**没有 DOM**。而这个游戏里所有
 * 「浏览器专属」的东西其实只有四处：
 *
 *   1. 上屏画布（Three.js 要一个 canvas）
 *   2. 贴图用的离屏 2D 画布（程序化美术全靠它，共 13 处）
 *   3. window 上的尺寸 / rAF / performance
 *   4. 音频上下文（微信要显式 createWebAudioContext）
 *
 * 除此之外游戏逻辑一行都不碰 DOM。所以这里补一个**最小**的
 * document / window 垫片就够了 —— 不要去实现一个通用 DOM，
 * 那会把「小游戏版和 Web 版行为不一致」变成一类查不完的 bug。
 *
 * 这个文件只在检测到宿主（wx / tt）时才生效，
 * 在浏览器里被误加载也不会破坏 Web 版。
 * ============================================================ */
(function () {
  'use strict';

  var g = (typeof GameGlobal !== 'undefined') ? GameGlobal
        : (typeof globalThis !== 'undefined') ? globalThis : this;
  var host = g.wx || g.tt;
  if (!host || typeof host.createCanvas !== 'function') return;

  /* 每个游戏脚本都用 `})(window)` 收尾，所以 window 必须存在且等于全局 */
  g.window = g;
  var XS = g.XS || (g.XS = {});

  /* ------------------------------------------------------------
   * 系统信息与尺寸
   *
   * innerWidth / innerHeight 是 core.js 唯一的尺寸来源
   * （Core.init 与 Core.resize 都读它），所以这里必须把它做成
   * **可更新的全局**，而不是一次性常量 —— 折叠屏 / 旋屏 / 模拟器
   * 改窗口都会重新读一次。
   * ------------------------------------------------------------ */
  var sys = {};
  try { sys = host.getSystemInfoSync() || {}; } catch (e) {}

  var DPR = sys.pixelRatio || 1;
  if (DPR > 3) DPR = 3;   /* 4x 屏的小游戏设备极少，但一旦出现就是纯浪费 */

  function refreshSize() {
    var s = {};
    try { s = host.getSystemInfoSync() || {}; } catch (e) { s = sys; }
    sys = s;
    g.innerWidth = s.windowWidth || s.screenWidth || g.innerWidth || 375;
    g.innerHeight = s.windowHeight || s.screenHeight || g.innerHeight || 667;
    g.devicePixelRatio = s.pixelRatio || DPR;
    return { w: g.innerWidth, h: g.innerHeight };
  }
  refreshSize();

  /* 安全区（刘海 / 底部小白条）。HUD 要靠它避开被切掉的那一条。 */
  function readSafeArea() {
    var s = sys.safeArea;
    if (!s) return { top: 0, bottom: 0, left: 0, right: 0 };
    return {
      top: s.top || 0,
      bottom: (sys.screenHeight || 0) - (s.bottom || 0),
      left: s.left || 0,
      right: (sys.screenWidth || 0) - (s.right || 0)
    };
  }

  /* ------------------------------------------------------------
   * 事件：window 与 document 共用一张表
   * ------------------------------------------------------------ */
  var listeners = {};
  function on(type, fn) {
    (listeners[type] || (listeners[type] = [])).push(fn);
  }
  function off(type, fn) {
    var a = listeners[type];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(type, ev) {
    var a = listeners[type];
    if (!a) return;
    for (var i = 0; i < a.length; i++) {
      try { a[i](ev || {}); } catch (e) {
        /* 一个监听器炸掉不能让其余监听器和主循环一起停 */
        try { console.error('[xs] listener error on ' + type + ': ' + e.message); } catch (e2) {}
      }
    }
  }
  XS.__emit = emit;

  /* ------------------------------------------------------------
   * 画布
   *
   * **顺序是硬约束**：第一次 createCanvas() 拿到的是上屏画布
   * （小游戏里唯一能被显示的那一块），之后每次才是离屏画布。
   * 所以必须先把上屏的取走，再让 document.createElement('canvas')
   * 去取离屏的。
   *
   * 如果反过来（或某天有人把 createCanvas 挪到别处先调一次），
   * 贴图会画到上屏画布上 —— 症状是屏幕变成一张噪声贴图、
   * 而 3D 场景完全不见，看起来像「渲染器坏了」。
   * 下面这个 screenCanvasTaken 标志就是防止这件事的。
   * ------------------------------------------------------------ */
  var screenCanvas = null;
  var screenCanvasTaken = false;

  function takeScreenCanvas() {
    if (screenCanvasTaken) {
      /* 已经取过了。再调 createCanvas 只会拿到离屏的，所以返回同一个 ——
         绝不能返回新的，否则调用方会以为那是上屏画布。 */
      return screenCanvas;
    }
    screenCanvasTaken = true;
    screenCanvas = host.createCanvas();
    /* Three.js 会通过 setSize 接管 width/height，这里只补它需要的方法 */
    if (screenCanvas && typeof screenCanvas.addEventListener !== 'function') {
      screenCanvas.addEventListener = function () {};
      screenCanvas.removeEventListener = function () {};
    }
    if (screenCanvas && !screenCanvas.style) screenCanvas.style = {};
    return screenCanvas;
  }

  function makeOffscreen() {
    /* 已经取过上屏画布了吗？没有的话先取，避免离屏拿到上屏那一块。 */
    if (!screenCanvasTaken) takeScreenCanvas();
    var c = host.createCanvas();
    if (c && typeof c.addEventListener !== 'function') {
      c.addEventListener = function () {};
      c.removeEventListener = function () {};
    }
    if (c && !c.style) c.style = {};
    return c;
  }

  /* ------------------------------------------------------------
   * body / document 垫片
   *
   * 只有 classList 是真的会用的：Game.applyA11y 会 toggle('bigtext')。
   * 小游戏版的大字号由 Canvas UI 自己读 XS.Settings 决定字号，
   * 这个类只是个记录位，方便诊断里看见「设置确实传下去了」。
   * ------------------------------------------------------------ */
  function makeClassList(store) {
    function sync() { store.owner.className = store.set.join(' '); }
    return {
      add: function (c) { if (store.set.indexOf(c) < 0) { store.set.push(c); sync(); } },
      remove: function (c) {
        var i = store.set.indexOf(c);
        if (i >= 0) { store.set.splice(i, 1); sync(); }
      },
      contains: function (c) { return store.set.indexOf(c) >= 0; },
      toggle: function (c, force) {
        var has = store.set.indexOf(c) >= 0;
        var want = (force === undefined) ? !has : !!force;
        if (want && !has) { store.set.push(c); sync(); }
        else if (!want && has) { store.set.splice(store.set.indexOf(c), 1); sync(); }
        return want;
      },
      toString: function () { return store.set.join(' '); }
    };
  }

  var bodyStore = { set: [], owner: null };
  var body = { className: '', style: {}, dataset: {} };
  bodyStore.owner = body;
  body.classList = makeClassList(bodyStore);
  body.appendChild = function () {};
  body.removeChild = function () {};
  body.contains = function () { return false; };

  function stubNode(tag) {
    var st = { set: [], owner: null };
    var n = {
      tagName: String(tag || '').toUpperCase(),
      className: '', style: {}, dataset: {}, children: [],
      textContent: '', innerHTML: '',
      appendChild: function () {}, removeChild: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; },
      addEventListener: function () {}, removeEventListener: function () {}
    };
    st.owner = n;
    n.classList = makeClassList(st);
    return n;
  }

  var doc = {
    hidden: false,
    visibilityState: 'visible',
    body: body,
    documentElement: body,
    createElement: function (tag) {
      /* 只有 canvas 需要是真家伙 —— 程序化贴图全靠它 */
      if (String(tag).toLowerCase() === 'canvas') return makeOffscreen();
      return stubNode(tag);
    },
    createElementNS: function (ns, tag) { return doc.createElement(tag); },
    /* 唯一需要认得的是 'scene'：boot 用它取上屏画布。
       其余一律 null —— 游戏代码里对 DOM 的访问全部已经判空，
       而**返回一个假节点比返回 null 更坏**：假节点会让
       `if (el)` 通过，然后 classList 操作静默失效，
       最后表现成「按钮点了没反应」，查起来要绕一大圈。 */
    getElementById: function (id) { return id === 'scene' ? screenCanvas : null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: on,
    removeEventListener: off,
    createTextNode: function (t) { return stubNode('text'); }
  };
  g.document = doc;

  g.addEventListener = on;
  g.removeEventListener = off;
  g.navigator = g.navigator || { userAgent: 'minigame' };
  g.location = g.location || { search: '', href: '', protocol: 'file:', hash: '' };
  g.localStorage = undefined;

  /* ------------------------------------------------------------
   * performance / rAF
   *
   * dt 直接来自 performance.now()。用 Date.now() 兜底可以，
   * 但它会被系统对时往回拨 —— 那样一帧的 dt 会变成负数，
   * 指数平滑（U.approach）会把数值推到奇怪的地方。
   * 所以优先要宿主的高精度计时器。
   * ------------------------------------------------------------ */
  if (!g.performance || typeof g.performance.now !== 'function') {
    var perf = null;
    try { perf = host.getPerformance && host.getPerformance(); } catch (e) {}
    g.performance = (perf && typeof perf.now === 'function')
      ? { now: function () { return perf.now(); } }
      : { now: function () { return Date.now(); } };
  }

  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = function (fn) { return setTimeout(function () { fn(g.performance.now()); }, 16); };
    g.cancelAnimationFrame = function (id) { clearTimeout(id); };
  }

  /* ------------------------------------------------------------
   * 音频
   *
   * audio.js 用的是标准 WebAudio（new AudioContext()）。
   * 微信小游戏给的是**工厂** wx.createWebAudioContext()，
   * 不能直接 new。用一个返回对象的普通函数包一层：
   * JS 里构造函数返回对象时，new 的结果就是那个对象 ——
   * 于是 `new AudioContext()` 恰好得到宿主给的上下文。
   * ------------------------------------------------------------ */
  /* 宿主到底有没有给音频工厂。三种情况要能分开：
       host  —— 宿主给了，audio.js 走的是这条路（**真机上的唯一那条**）
       none  —— 宿主没给（老版本 / 环境不支持），audio.js 应当安静地降级
       没走到这个分支 —— 说明 g.AudioContext 已经存在（**浏览器**里就是这样） */
  var audioFactory = 'none';
  if (!g.AudioContext && !g.webkitAudioContext) {
    var mkAudio = host.createWebAudioContext || host.getAudioContext;
    if (typeof mkAudio === 'function') {
      var AC = function () { return mkAudio.call(host); };
      /* 标记挂在**构造函数**上，不挂在上下文对象上。
         真实宿主返回的对象长什么样我们不知道，但构造函数是我们包的 ——
         所以只有挂在构造函数上，audio.js 才能可靠地报出
         「这个上下文是宿主给的」而不是「浏览器原生 new 出来的」。 */
      AC.__xsHostAudio = true;
      g.AudioContext = AC;
      audioFactory = 'host';
    }
  } else {
    audioFactory = 'native';   // 只可能出现在浏览器里，小游戏宿主没有原生 AudioContext
  }

  /* ------------------------------------------------------------
   * 生命周期：后台挂起音频、回前台恢复；窗口尺寸变化重排
   * ------------------------------------------------------------ */
  if (host.onHide) {
    host.onHide(function () {
      doc.hidden = true;
      doc.visibilityState = 'hidden';
      emit('visibilitychange', {});
    });
  }
  if (host.onShow) {
    host.onShow(function () {
      doc.hidden = false;
      doc.visibilityState = 'visible';
      emit('visibilitychange', {});
    });
  }
  if (host.onWindowResize) {
    host.onWindowResize(function () {
      refreshSize();
      emit('resize', {});
    });
  }

  /* 暴露给 boot / 诊断用 */
  XS.MG = {
    host: host,
    /* 同样是 getter：refreshSize() 会整体替换 sys，
       按值存一份的话诊断里报的永远是启动那一刻的尺寸。 */
    get sys() { return sys; },
    /* 必须是 getter：上屏画布是**懒创建**的（boot 里才 takeScreenCanvas），
       按值存一份的话诊断里永远是 null —— 而「canvas 为 null」
       会被读成「画布没建起来」，把一个正常的时序问题当成致命错误。 */
    get screenCanvas() { return screenCanvas; },
    takeScreenCanvas: takeScreenCanvas,
    refreshSize: refreshSize,
    safeArea: readSafeArea,
    /* 音频上下文是从哪来的：'host' / 'none' / 'native'。
       诊断里必须报出来 —— 「音频从来没响过」这类问题，
       光看代码是看不出来的：调用点有 34 个，全都在。 */
    audioFactory: audioFactory,
    /* 宿主标识，打点里要区分「微信来的玩家」和「抖音来的玩家」 */
    platform: (g.wx && host === g.wx) ? 'wechat' : 'bytedance'
  };

  try { console.log('[xs] minigame env ready: ' + XS.MG.platform + ' ' + g.innerWidth + 'x' + g.innerHeight + ' @' + g.devicePixelRatio + 'x'); } catch (e) {}
})();
