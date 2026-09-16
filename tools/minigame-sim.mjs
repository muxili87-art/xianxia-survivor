#!/usr/bin/env node
/* ============================================================
 * 生成小游戏模拟器页面 sim.html
 *
 * 为什么需要一个模拟器：
 * 「打包产物能跑」这件事，只有让**打包产物本身**跑起来才算证明。
 * 在源文件上跑 Web 版不算 —— 那样验证的是另一份代码。
 *
 * 做法：在一个浏览器页面里造一个假的 wx 宿主，把
 * dist/minigame/game.js **原文**加载进来执行。关键是执行方式：
 * 不能直接用 <script> 标签，那样它拿到的是真 window / 真 document，
 * 「没有 DOM」这个最要命的约束就没被验证到。
 *
 * 所以用 `new Function(..., src)` 把 bundle 包起来，
 * 并把 window / document / self / globalThis / location / performance
 * 全部作为**形参**传进去 —— 于是 bundle 里所有裸引用都被影子变量接住，
 * 真 DOM 一眼都看不到。
 *
 * 用同步 XHR 读 bundle（file:// 下需要 --allow-file-access-from-files）：
 * 异步 fetch 会让「加载完成」和「虚拟时间预算用尽」产生竞态，
 * 而截图脚本恰恰是在预算用尽时取图的。
 *
 * 用法：node tools/minigame-sim.mjs
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const BUNDLE = 'dist/minigame/game.js';
try {
  readFileSync(join(ROOT, BUNDLE));
} catch (e) {
  console.error('找不到 ' + BUNDLE + '，先跑：node tools/build-minigame.mjs');
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>小游戏模拟器 · 仙台问剑</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #scene { display: block; position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="scene"></canvas>
<script>
/* ============================================================
 * 假 wx 宿主
 * ============================================================ */
window.__SIM__ = (function () {
  'use strict';
  var screen = document.getElementById('scene');
  var screenTaken = false;

  /* 尺寸**每次调用现算**，不要在脚本解析时读一次就存起来。
     踩过的坑：--window-size 是在首帧之后才生效的，解析时读到的
     是 500x773，而截图实际是 430x860 —— 于是 UI 按 500 宽排版、
     被压进 430 宽的画布，右侧的「斩妖 N」直接被切掉。
     看起来像 UI 布局写错了，其实是**尺寸来源错了**。
     真宿主上同理：宿主可能在任何时候改窗口尺寸，尺寸必须现问现取。 */
  function liveSys() {
    var w = window.innerWidth, h = window.innerHeight;
    return {
      windowWidth: w,
      windowHeight: h,
      screenWidth: w,
      screenHeight: h,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      /* 刘海屏安全区：模拟器给 0，真机上由宿主返回 */
      safeArea: { top: 0, bottom: h, left: 0, right: w }
    };
  }

  var h = { start: [], move: [], end: [], cancel: [], show: [], hide: [], resize: [] };
  function fire(list, ev) { for (var i = 0; i < list.length; i++) list[i](ev); }

  /* 宿主存储后端：**内存 Map，不用 localStorage**。
     踩过的坑：file:// 下 Chrome 会禁用 localStorage，于是
     wx.setStorageSync 静默失败 —— 存储自检两边都是 false，
     看起来像「游戏的存档写不进去」，其实是模拟器自己没后端。
     真机（微信/抖音）的存储本来就是宿主提供的，用内存 Map
     更接近真实语义，而且和页面来源无关。 */
  var storeMap = {};

  /* 启动参数：小游戏没有 URL，等价物是 wx.getLaunchOptionsSync().query。
     这里从浏览器 URL 的 query 转过去 —— 于是走查脚本的写法
     （?mgplay=20）和 Web 版保持一致，但走的**是小游戏自己的那条链路**，
     顺带把「分享卡片带参数进来」这条路也验证了。 */
  var QUERY = (function () {
    var q = {}, s = location.search.replace(/^\\?/, '');
    if (!s) return q;
    s.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      q[decodeURIComponent(k)] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
    });
    return q;
  })();

  /* ---------- 激励视频桩（?mgad=ok|skip|fail） ----------
   *
   * 默认**不提供**广告 API：降级路径（宿主没有广告能力）必须能被走查覆盖，
   * 它最容易悄悄变成「广告没播也发奖励」。
   *
   * 但只覆盖降级路径有个代价：广告回调之后那条状态迁移
   * （复活：扣次数 → 满血 → 清场 → 回到 playing）**从来没被执行过**。
   * 于是加了这一组参数，三种结果都能摆出来：
   *   ok   —— 看完，该发奖励
   *   skip —— 用户中途关掉，**不该**发奖励
   *   fail —— 拉取失败，游戏侧走 .catch 分支
   *
   * 桩是**同步**的（手写 thenable 而不是 Promise）：
   * 走查是同步循环，微任务在调用栈清空前不会跑 ——
   * 返回真 Promise 的话 ad.load().then(...) 永远不执行，
   * 复活流程会停在 load 上，而且看起来像「回调没触发」。
   */
  var AD_MODE = QUERY.mgad || null;

  function makeAdStub() {
    var ad = {
      _close: null, shown: false,
      onClose: function (f) { ad._close = f; },
      offClose: function () { ad._close = null; },
      load: function () {
        return { then: function (f) {
          if (AD_MODE === 'fail') {
            return { catch: function (g) { g(new Error('stub ad load fail')); } };
          }
          try { f(); } catch (e) {}
          return { catch: function () {} };
        } };
      },
      show: function () {
        ad.shown = true;
        if (ad._close) ad._close({ isEnded: AD_MODE === 'ok' });
        return { catch: function () {} };
      }
    };
    return ad;
  }

  /* ------------------------------------------------------------
   * 音频：?mgaudio=host|none
   *
   * host（默认）—— 提供 wx.createWebAudioContext，走真机那条路
   * none       —— 不提供，验「宿主没给音频」的降级路径
   *
   * 返回的是**真的** AudioContext，不是手写桩。
   * 手写一个假 WebAudio 会让「游戏建的图对不对」退化成
   * 「我的桩写得对不对」—— 那是查不完的。这里只把 audio.js
   * 实际用到的那几个工厂方法包一层计数，语义仍是原生的。
   *
   * 为什么要计数：isReady() 只说明上下文建起来了，
   * 不说明任何一个音被调度过。「图建出来了 / 节点 start 了 /
   * 连进总线了」才是同步可读的硬证据 —— 无头环境里没有第二发
   * 异步观测的机会（--virtual-time-budget 不推进 rAF，见文件末尾）。
   *
   * 注意：这一段整体在**模板字符串里**（它是要写进 sim.html 的页面脚本），
   * 所以注释里**不能出现反引号** —— 一个反引号就会把模板字符串截断，
   * 报出来的是「Unexpected identifier」这种指不到真正原因的错误。
   * ------------------------------------------------------------ */
  var AUDIO_MODE = QUERY.mgaudio || 'host';
  window.__AUDIO_REC__ = { oscillators: 0, buffers: 0, gains: 0, filters: 0, convolvers: 0,
                           starts: 0, connects: 0, ctxCount: 0, pcmBuffers: 0 };

  function makeAudioFactory() {
    var Real = window.__RealAudioContext;
    if (!Real) throw new Error('sim: 没有可用的 AudioContext 可包装');
    var c = new Real();
    var rec = window.__AUDIO_REC__;
    rec.ctxCount++;
    function wrapNode(n) {
      if (!n || n.__xsWrapped) return n;
      n.__xsWrapped = true;
      var cn = n.connect;
      n.connect = function (t) { rec.connects++; return cn.apply(n, arguments); };
      if (typeof n.start === 'function') {
        var st = n.start;
        n.start = function () { rec.starts++; return st.apply(n, arguments); };
      }
      return n;
    }
    var kinds = { createGain: 'gains', createOscillator: 'oscillators',
                  createBufferSource: 'buffers', createBiquadFilter: 'filters',
                  createConvolver: 'convolvers' };
    Object.keys(kinds).forEach(function (k) {
      var orig = c[k];
      if (typeof orig !== 'function') return;
      var key = kinds[k];
      c[k] = function () { rec[key]++; return wrapNode(orig.apply(c, arguments)); };
    });
    /* createBuffer 返回的是 PCM 缓冲不是节点，单独计。
       混响脉冲与噪声底都靠它 —— 计数为 0 说明 init() 没走完。 */
    if (typeof c.createBuffer === 'function') {
      var cb = c.createBuffer;
      c.createBuffer = function () { rec.pcmBuffers++; return cb.apply(c, arguments); };
    }
    return c;
  }

  var wx = {
    createCanvas: function () {
      /* 第一次 = 上屏画布，之后 = 离屏。和真宿主的契约完全一致 ——
         如果模拟器在这里放水，真机上才会暴露的画布顺序 bug 就漏掉了。 */
      if (!screenTaken) { screenTaken = true; return screen; }
      return document.createElement('canvas');
    },
    getSystemInfoSync: function () { return liveSys(); },
    getLaunchOptionsSync: function () { return { query: QUERY, scene: 1001 }; },
    setStorageSync: function (k, v) { storeMap[k] = v; },
    /* 键不存在时返回**空字符串**（不是 null/undefined）—— 这是微信的真实行为，
       而它恰恰是存储读取最容易写错的一处：只判 null 会把「没存过」
       当成「存了一个空字符串」，后面 JSON.parse('') 直接抛。 */
    getStorageSync: function (k) {
      return Object.prototype.hasOwnProperty.call(storeMap, k) ? storeMap[k] : '';
    },
    removeStorageSync: function (k) { delete storeMap[k]; },
    onTouchStart: function (f) { h.start.push(f); },
    onTouchMove: function (f) { h.move.push(f); },
    onTouchEnd: function (f) { h.end.push(f); },
    onTouchCancel: function (f) { h.cancel.push(f); },
    onShow: function (f) { h.show.push(f); },
    onHide: function (f) { h.hide.push(f); },
    onWindowResize: function (f) { h.resize.push(f); },
    getPerformance: function () { return { now: function () { return performance.now(); } }; },
    vibrateShort: function () {},
    shareAppMessage: function () {},
    /* 故意**不**默认提供 createRewardedVideoAd：
       走查要覆盖「宿主没有广告 API」这条降级路径 ——
       它最容易悄悄变成「广告没播也发奖励」。
       加了 ?mgad= 才给桩，用来验证广告回调之后那条链路。 */
    createRewardedVideoAd: AD_MODE ? makeAdStub : undefined,
    /* 音频工厂。默认给（?mgaudio=none 才拿掉，用来验降级）。
       返回**真的** AudioContext 而不是手写桩 —— 手写桩会让
       「图建得对不对」变成「我的桩写得对不对」，那是一条查不完的路。
       只把 audio.js 用到的那几个工厂方法包一层计数，
       于是「有没有真的建出节点、有没有 start、有没有 connect」
       变成可读的数，而 WebAudio 语义仍是原生的。 */
    createWebAudioContext: AUDIO_MODE === 'none' ? undefined : makeAudioFactory
  };
  window.wx = wx;

  /* ---------- 为什么不需要「屏蔽原生 AudioContext」 ----------
   *
   * 我一开始在这里写过一段「把真 window.AudioContext 拿掉，
   * 逼 audio.js 走宿主工厂」的代码，理由是「模拟器跑在真浏览器里，
   * 原生 AudioContext 一直在，shim 的 if (!g.AudioContext) 守卫
   * 永远为假」。
   *
   * **那个理由是把 harness 的模型记错了。**
   * bundle 是用 new Function('window', ...) 跑起来的，
   * window / globalThis / GameGlobal 全是**形参**，传进去的是下面那个
   * 假 window（Proxy）。shim 里 var g = GameGlobal 于是 g 就是假 window，
   * 而假 window 上**本来就没有** AudioContext —— 守卫一开始就是真的。
   *
   * 所以「音频这条路从没被走到」的真因只有一个：
   * 假宿主没提供 createWebAudioContext（上面补上了）。
   * 多写的那段屏蔽代码不但没用，还会误导后来的人以为
   * 真 window 会漏进 bundle —— 那正好是这个 harness 要防的事，
   * 而且它防住了。**先读清 harness，再改 harness。 */
  /* 包装工厂要用真的构造函数建上下文，存一份备用。 */
  window.__RealAudioContext = window.AudioContext || window.webkitAudioContext;

  /* ---------- 存储回路自检 ----------
   *
   * 在宿主存储里先埋一个哨兵，等 bundle 起来之后走 XS.Platform.load
   * 读回来。此时内存 memStore 是空的 —— 所以「读得到」只可能来自
   * 宿主存储。
   *
   * 为什么必须单独测这一项：storage.get 曾经**只有 web 分支**，
   * 小游戏下永远只读内存、从不读 wx.getStorageSync。同一局内
   * 完全看不出来（memStore 还在），玩家一关掉再打开，
   * 灵石 / 成就 / 图鉴全部归零。
   * 单会话走查发现不了它，只有「宿主里明明有、读回来却没有」
   * 这个对照能暴露。破绽是不对称：set 有微信分支、get 没有。
   */
  /* 键名**必须**用 'xs_' + KEY 拼出来，不能手写整串。
     踩过的坑：埋哨兵时手写成 'xs__storeprobe__'（末尾两个下划线），
     而 Platform.load('_storeprobe_') 实际读的是 'xs__storeprobe_' ——
     读 A 键、写 B 键，于是自检两边都是 false，
     看起来像「游戏的存档读不回来」，其实是探针自己写错了。
     凡是「前缀由别人加」的键，都要让代码去拼，不要靠眼睛数下划线。 */
  var P_KEY = '_storeprobe_';
  var P_KEY_S = '_storeprobe_s_';
  var P_KEY_W = '_storeprobe_w_';
  var SEED_VAL = { __seed__: true, n: 42 };
  /* 第二种返回约定：抖音 / 部分基础库的 getStorageSync 返回**字符串**。
     也埋一个，确保 readHost 的 JSON.parse 分支被覆盖到 ——
     只测微信那一种的话，换个平台就会「存档写进去了、读出来是空」。 */
  try { wx.setStorageSync('xs_' + P_KEY, SEED_VAL); } catch (e) {}
  try { wx.setStorageSync('xs_' + P_KEY_S, JSON.stringify({ __seed_s__: true })); } catch (e) {}

  function storeProbe(f) {
    var out = {};
    /* 先报「宿主里到底有什么」—— 键名写错时，这一项能一眼看出来 */
    out.rawSeed = wx.getStorageSync('xs_' + P_KEY);
    out.rawWrite = wx.getStorageSync('xs_' + P_KEY_W);
    try {
      var got = f.XS.Platform.load(P_KEY, null);
      out.hostRead = !!(got && got.__seed__ === true && got.n === 42);
      out.got = got;
    } catch (e) { out.readErr = e.message; }
    try {
      var gs = f.XS.Platform.load(P_KEY_S, null);
      out.hostReadStr = !!(gs && gs.__seed_s__ === true);
    } catch (e) { out.readStrErr = e.message; }
    try {
      /* 对照组：写方向本来就有微信分支，作为「宿主 API 确实通」的证明。
         如果写也是 false，那说明是模拟器的 wx 有问题，不是游戏的问题。 */
      f.XS.Platform.save(P_KEY_W, { w: 7 });
      var w = wx.getStorageSync('xs_' + P_KEY_W);
      out.hostWrite = !!(w && w.w === 7);
    } catch (e) { out.writeErr = e.message; }
    return out;
  }

  /* ---------- 触摸：鼠标与真实触摸都转成小游戏事件 ---------- */
  var idSeq = 1, mouseId = null;
  function mk(id, x, y) {
    var t = { identifier: id, clientX: x, clientY: y, pageX: x, pageY: y };
    return { touches: [t], changedTouches: [t] };
  }
  function down(id, x, y) { fire(h.start, mk(id, x, y)); }
  function move(id, x, y) { fire(h.move, mk(id, x, y)); }
  function up(id, x, y) { fire(h.end, mk(id, x, y)); }

  screen.addEventListener('mousedown', function (e) {
    mouseId = idSeq++; down(mouseId, e.clientX, e.clientY); e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (mouseId !== null) move(mouseId, e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', function (e) {
    if (mouseId !== null) { up(mouseId, e.clientX, e.clientY); mouseId = null; }
  });
  screen.addEventListener('touchstart', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      down(t.identifier, t.clientX, t.clientY);
    }
    e.preventDefault();
  }, { passive: false });
  screen.addEventListener('touchmove', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      move(t.identifier, t.clientX, t.clientY);
    }
    e.preventDefault();
  }, { passive: false });
  screen.addEventListener('touchend', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      up(t.identifier, t.clientX, t.clientY);
    }
  });

  /* 真窗口尺寸变化 → 通知小游戏（等价于真宿主的 onWindowResize） */
  window.addEventListener('resize', function () { fire(h.resize, {}); });

  return {
    h: h, sys: liveSys, screen: screen, wx: wx, query: QUERY, fire: fire,
    storeProbe: storeProbe,
    /* 触摸注入。走查机器人默认是直接写 XS.Input.vec 的，那**绕过了
       整个触摸层** —— js/minigame/input.js 里的死区 / 归一化 / UI 优先 /
       多指识别于是从来没执行过。把这三个函数暴露出去，
       才能让走查真的从宿主触摸回调那条路走一遍。 */
    touchDown: down, touchMove: move, touchUp: up
  };
})();
</script>

<script>
/* ============================================================
 * 外壳：在影子作用域里执行打包产物，然后输出诊断
 * ============================================================ */
window.__MG_ERRORS__ = [];
function mgErr(msg) {
  window.__MG_ERRORS__.push(msg);
  /* 立刻写进 DOM：如果 bundle 在加载阶段就炸了，
     诊断块可能永远不会被写出来，那时**错误本身就是唯一的产出**。
     只在最后统一输出的话，这种情况会表现为「什么都没有」。 */
  try {
    var p = document.getElementById('__mg_err') || (function () {
      var e = document.createElement('pre');
      e.id = '__mg_err'; e.style.display = 'none';
      document.body.appendChild(e);
      return e;
    })();
    p.textContent += 'MG' + 'ERR: ' + msg + '\\n';
  } catch (e) {}
}
window.addEventListener('error', function (e) {
  mgErr('ERROR: ' + (e.message || 'Script error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', function (e) {
  mgErr('REJECT: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
});

(function () {
  'use strict';
  var SIM = window.__SIM__;
  var errors = window.__MG_ERRORS__;

  /* ---- 读 bundle（同步，避免和虚拟时间预算竞态） ---- */
  var src;
  try {
    var x = new XMLHttpRequest();
    x.open('GET', '${BUNDLE}', false);
    x.send(null);
    if (x.status !== 0 && x.status !== 200) throw new Error('HTTP ' + x.status);
    src = x.responseText;
  } catch (e) {
    mgErr('BUNDLE LOAD FAILED: ' + e.message);
    dump(null, 'fail');
    return;
  }

  /* ---- 假全局 ----
   *
   * 用 Proxy 把写入**镜像**到真 window 上。
   *
   * 为什么必须镜像：vendor 里的后处理脚本是「examples/js」那种非模块版本，
   * 它们用的是**裸 THREE**（THREE.CopyShader = …、
   * class ShaderPass extends THREE.Pass）。
   * 裸标识符的解析链是「函数作用域 → 全局对象」——它**看不到**我们传进来的形参，
   * 只会去真 window 上找。所以 three.min.js 把命名空间写进 fake.THREE 之后，
   * 那些脚本读到的还是 undefined。
   *
   * 镜像之后两边指向同一个对象，模拟器就和真机行为一致了。
   * （真机上 bundle 就是普通脚本，globalThis === window，本来就没有这个分歧。）
   */
  var fakeRef = null;
  var MIRROR_SKIP = {
    document: 1, window: 1, self: 1, globalThis: 1, location: 1,
    top: 1, parent: 1, frames: 1,
    innerWidth: 1, innerHeight: 1, devicePixelRatio: 1
  };
  var base = {
    innerWidth: SIM.sys().windowWidth,
    innerHeight: SIM.sys().windowHeight,
    devicePixelRatio: SIM.sys().pixelRatio,
    wx: SIM.wx,
    navigator: { userAgent: 'minigame-sim' },
    location: { search: location.search, href: 'sim://game', protocol: 'file:', hash: '' },
    performance: { now: function () { return performance.now(); } },
    requestAnimationFrame: function (cb) { return window.requestAnimationFrame(cb); },
    cancelAnimationFrame: function (id) { return window.cancelAnimationFrame(id); },
    /* 走查专用注入点。放进 base（而不是真 window）是因为假 window 是
       只带 set 陷阱的 Proxy，读会落到 base —— 写在真 window 上，
       bundle 里读 window.__TOUCH__ 会是 undefined。
       真机上这个键不存在，所以 boot.js 的触摸驱动模式在真机自动不可用。 */
    __TOUCH__: { down: SIM.touchDown, move: SIM.touchMove, up: SIM.touchUp }
  };
  base.self = base;
  base.window = base;
  base.globalThis = base;

  var fake = new Proxy(base, {
    set: function (t, k, v) {
      t[k] = v;
      if (!MIRROR_SKIP[k]) { try { window[k] = v; } catch (e) {} }
      return true;
    }
  });
  fakeRef = fake;

  /* 音频记录器必须挂在**假 window** 上。
     bundle 里的 window / globalThis / GameGlobal 全是形参，
     传进去的都是这个 Proxy —— 真 window 上挂什么它都看不到。
     踩过：先挂在真 window 上，探针里 graph 永远是 null，
     看着像「图统计没写对」，其实是**挂错了对象**。 */
  base.__AUDIO_REC__ = window.__AUDIO_REC__;

  /* document 必须走**代理**，不能按值传。
     按值传的话拿到的是「调用那一刻的 fake.document」，而那一刻
     环境垫片还没跑、它是 undefined —— 于是 bundle 里所有裸 document
     全部报 "Cannot read properties of undefined"。
     这个坑很有欺骗性：报错点在 world.js 的贴图函数上，
     看起来像贴图代码写错了。 */
  var docProxy = new Proxy({}, {
    get: function (t, k) { var d = fakeRef && fakeRef.document; return d ? d[k] : undefined; },
    has: function (t, k) { var d = fakeRef && fakeRef.document; return !!d && (k in d); }
  });

  var fn;
  try {
    fn = new Function(
      'window', 'document', 'self', 'globalThis', 'GameGlobal',
      'wx', 'tt', 'requestAnimationFrame', 'cancelAnimationFrame',
      'performance', 'location', 'navigator', 'localStorage', 'console',
      src + '\\n//# sourceURL=minigame-bundle.js'
    );
  } catch (e) {
    mgErr('BUNDLE COMPILE FAILED: ' + e.message);
    dump(null, 'fail');
    return;
  }

  try {
    /* 注意 this 也要绑到 fake：Three.js 的 UMD 头会读 this */
    fn.apply(fake, [
      fake, docProxy, fake, fake, fake,
      fake.wx, undefined, fake.requestAnimationFrame, fake.cancelAnimationFrame,
      fake.performance, fake.location, fake.navigator, undefined, console
    ]);
  } catch (e) {
    mgErr('BUNDLE RUN FAILED: ' + e.message + ' | ' + (e.stack || ''));
  }

  /* ---- 诊断输出 ----
   *
   * **同步**写，且只写这一发。
   *
   * 为什么必须同步：--dump-dom 抓取的时机和 rAF 回调**不对齐**，
   * 而 --virtual-time-budget 在本机的无头 Chrome 里压根不推进 rAF。
   * 只挂在 rAF 上写，会出现「页面明明跑起来了、dump 里却什么都没有」——
   * 看起来像 bundle 没执行，其实是那一发永远不会发生。
   * 而 main.js 的诊断之所以一直有效，正是因为它是在启动流程里
   * **同步**写进 DOM 的。
   *
   * 需要「跑一会儿再测」的指标（比如 UI 的边际重画率），不要靠 rAF，
   * 要做成同步的：见 boot.js 的 XS.MG.probeRedraw()。
   */
  var t0 = performance.now();

  function dump(f, phase) {
    var out = {
      errors: errors.slice(),
      loaded: !!f,
      phase: phase,
      /* 恒为 0，不是没跑起来：见上面的注释，rAF 在这里不推进。 */
      rafFrames: 0,
      /* 真窗口 vs 游戏读到的尺寸：两者不一致就是「排版按 A 宽、截图按 B 宽」，
         症状是右侧内容被切掉，很容易被误判成 UI 布局写错。 */
      winSize: window.innerWidth + 'x' + window.innerHeight,
      docSize: document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight,
      screenSize: screen.width + 'x' + screen.height,
      dpr: window.devicePixelRatio,
      wallMs: Math.round(performance.now() - t0)
    };
    try {
      if (f && f.XS && f.XS.MG && f.XS.MG.diag) out.diag = f.XS.MG.diag();
    } catch (e) {
      out.diagError = e.message + ' | ' + (e.stack || '');
    }
    /* storeProbe 定义在第一段脚本里（假宿主那一段），
       两段 <script> 是各自独立的作用域，所以要走 __SIM__ 拿。 */
    if (f && f.XS && f.XS.Platform && SIM && SIM.storeProbe) out.store = SIM.storeProbe(f);
    var pre = document.getElementById('__mg_diag');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = '__mg_diag';
      pre.style.display = 'none';
      document.body.appendChild(pre);
    }
    /* 标记必须**拼出来**，不能写成字面量：
       --dump-dom 会把 <script> 的源码一起 dump 出来，
       源码里的字面量会先被正则命中，解析出来的就是
       "' + JSON.stringify(out) + '" 这种东西。
       （Web 版的 main.js 里 DIAG_JSON_START 是同一个坑。） */
    pre.textContent = 'MGDIAG' + '_START' + JSON.stringify(out) + 'MGDIAG' + '_END';
  }

  /* 同步第一发，也是**唯一**一发：bundle 的 boot 是同步的，这里已经有状态了。
   *
   * 这里曾经还有一发挂在 rAF 上的「20 帧后再 dump 一次」，用来读
   * redrawRate。它是个陷阱：--virtual-time-budget 在本机的无头 Chrome 里
   * **根本不推进 rAF**（实测：DOM 里只有 phase:"sync"，rafframes 永远不涨）。
   * 也就是说那一发代码在、看着能用、永远不执行 —— 而「第二发观测不存在的
   * 观测」比「没有观测」更糟，因为它会被当成已经有数据了。
   *
   * 需要第二发观测的东西，必须做成**同步**的：见 boot.js 的
   * XS.MG.probeRedraw()（连画 N 帧测边际重画率），它跟着这一发一起出。 */
  dump(fake, 'sync');
})();
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, 'sim.html'), html);
console.log('sim.html 已生成（引用 ' + BUNDLE + '）');
