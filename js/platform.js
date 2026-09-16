/* ============================================================
 * 平台适配层
 * Web 环境用 DOM/localStorage 实现；微信/抖音小游戏环境可整体替换
 * 上层业务只调用 XS.Platform.*，不直接触碰平台 API
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});

  /* ---------- 运行环境探测 ---------- */
  function detectEnv() {
    try {
      if (typeof global.wx !== 'undefined' && global.wx.getSystemInfoSync) return 'wechat';
    } catch (e) {}
    try {
      if (typeof global.tt !== 'undefined' && global.tt.getSystemInfoSync) return 'bytedance';
    } catch (e) {}
    return 'web';
  }

  var env = detectEnv();

  /* ---------- 存储 ---------- */
  var memStore = {};

  /* 小游戏宿主的存储读法有两个坑，都必须在这里吃掉：
   *
   * 1. **返回值类型不统一**。微信的 getStorageSync 返回写入时的原值
   *    （可以是对象），抖音 / 部分基础库返回字符串。两种都吃，
   *    否则会出现「写进去了、读出来是空」。
   * 2. **键不存在时微信返回空字符串**，不是 null / undefined。
   *    只判 null 会把「没存过」当成「存了一个空字符串」，
   *    后面 JSON.parse('') 直接抛。
   */
  function readHost(key) {
    var raw;
    if (env === 'wechat' && global.wx && global.wx.getStorageSync) {
      raw = global.wx.getStorageSync(key);
    } else if (env === 'bytedance' && global.tt && global.tt.getStorageSync) {
      raw = global.tt.getStorageSync(key);
    } else {
      return undefined;
    }
    if (raw === '' || raw === null || raw === undefined) return undefined;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return undefined; }
    }
    return raw;
  }

  function writeHost(key, val) {
    if (env === 'wechat' && global.wx && global.wx.setStorageSync) global.wx.setStorageSync(key, val);
    else if (env === 'bytedance' && global.tt && global.tt.setStorageSync) global.tt.setStorageSync(key, val);
  }

  function dropHost(key) {
    if (env === 'wechat' && global.wx && global.wx.removeStorageSync) global.wx.removeStorageSync(key);
    else if (env === 'bytedance' && global.tt && global.tt.removeStorageSync) global.tt.removeStorageSync(key);
  }

  var storage = {
    get: function (key, def) {
      /* 顺序：**宿主存储优先，内存兜底**。
       *
       * 这里原本只有 web 分支 —— 小游戏下永远只读内存，从来不读
       * wx.getStorageSync。单局内看不出来（memStore 还在），
       * 但玩家关掉再打开，灵石 / 成就 / 图鉴全部归零。
       * 而这个游戏「再来一局」的理由全靠局外成长。
       *
       * 这类 bug 的破绽是**不对称**：set 有微信分支、get 没有。
       * 单会话走查永远发现不了它，只能靠读代码看出来。 */
      try {
        if (env === 'web') {
          var v = global.localStorage.getItem(key);
          if (v !== null) return JSON.parse(v);
        } else {
          var hv = readHost(key);
          if (hv !== undefined) return hv;
        }
      } catch (e) {}
      return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : def;
    },
    set: function (key, val) {
      memStore[key] = val;
      try {
        if (env === 'web') global.localStorage.setItem(key, JSON.stringify(val));
        else writeHost(key, val);
      } catch (e) {}
      return val;
    },
    remove: function (key) {
      /* 删也必须删宿主那份。只删内存的话，下次启动 readHost
         会把旧存档读回来 —— 「清除存档」看起来点了没反应。 */
      delete memStore[key];
      try {
        if (env === 'web') global.localStorage.removeItem(key);
        else dropHost(key);
      } catch (e) {}
    },
    /* 存储是否真实可用（file:// 下部分浏览器会禁用） */
    available: (function () {
      try {
        if (env !== 'web') return true;
        global.localStorage.setItem('__xs_probe__', '1');
        global.localStorage.removeItem('__xs_probe__');
        return true;
      } catch (e) { return false; }
    })()
  };

  /* ---------- 广告（激励视频） ---------- */
  var adBusy = false;

  function webAdOverlay(placement, onDone) {
    var el = document.getElementById('adOverlay');
    if (!el) { onDone({ completed: true }); return; }
    var secEl = document.getElementById('adSec');
    var nameEl = document.getElementById('adName');
    var tipEl = document.getElementById('adTip');
    var skipBtn = document.getElementById('adSkip');

    nameEl.textContent = placement.name || placement.id;
    el.classList.add('on');

    var left = 5.0;
    var cancelled = false;
    skipBtn.classList.remove('ready');
    skipBtn.textContent = '广告播放中…';

    var timer = setInterval(function () {
      left -= 0.1;
      if (left <= 0) {
        clearInterval(timer);
        skipBtn.textContent = '领取奖励';
        skipBtn.classList.add('ready');
      }
      secEl.textContent = Math.max(0, left).toFixed(1);
    }, 100);

    function finish(ok) {
      if (cancelled) return;
      cancelled = true;
      clearInterval(timer);
      el.classList.remove('on');
      skipBtn.removeEventListener('click', onSkip);
      onDone({ completed: ok });
    }
    function onSkip() { if (left <= 0) finish(true); }
    skipBtn.addEventListener('click', onSkip);
    tipEl.textContent = '（Web 演示环境：用 5 秒模拟激励视频，小游戏环境将调用真实 SDK）';
  }

  var Platform = XS.Platform = {
    env: env,
    isMiniGame: env === 'wechat' || env === 'bytedance',
    storage: storage,

    /* 无人值守模式：广告直接返回结果（默认关闭，仅验证脚本使用） */
    autoAd: false,
    adSuccessRate: 1,

    now: function () {
      return (global.performance && global.performance.now)
        ? global.performance.now() : Date.now();
    },

    /* 显示激励视频广告；cb({completed}) */
    showAd: function (placement, cb) {
      /* 无人值守验证模式：不做任何 DOM 演出，直接返回结果。
         同步模拟循环里 setInterval 永远不会触发，若走真实演出路径，
         广告回调永不返回，adBusy 会被永久占住导致复活流程死锁。 */
      if (Platform.autoAd) {
        cb({ completed: Math.random() < Platform.adSuccessRate, simulated: true });
        return;
      }
      if (adBusy) { cb({ completed: false, reason: 'busy' }); return; }
      adBusy = true;
      var done = function (r) { adBusy = false; cb(r); };

      if (env === 'wechat' && global.wx.createRewardedVideoAd) {
        try {
          var ad = global.wx.createRewardedVideoAd({ adUnitId: placement.unitId || '' });
          var onClose = function (res) {
            ad.offClose(onClose);
            done({ completed: !res || res.isEnded !== false });
          };
          ad.onClose(onClose);
          ad.load().then(function () { return ad.show(); }).catch(function () { done({ completed: false, reason: 'load_fail' }); });
        } catch (e) { done({ completed: false, reason: 'error' }); }
        return;
      }
      if (env === 'bytedance' && global.tt.createRewardedVideoAd) {
        try {
          var ad2 = global.tt.createRewardedVideoAd({ adUnitId: placement.unitId || '' });
          ad2.onClose(function (res) { done({ completed: !res || res.isEnded !== false }); });
          ad2.load().then(function () { return ad2.show(); }).catch(function () { done({ completed: false, reason: 'load_fail' }); });
        } catch (e) { done({ completed: false, reason: 'error' }); }
        return;
      }
      /* 小游戏环境下**绝不能**落到 Web 演示层。
         Web 演示层在没有 #adOverlay 时会直接回 {completed:true} ——
         在浏览器里那只是个没人看的兜底，在小游戏里就是
         「宿主不支持激励视频 → 玩家白拿奖励」。
         这类洞不会报错、不会崩溃，只会在结算数据里表现为
         「广告完成率异常高」，很难被发现。 */
      if (Platform.isMiniGame) {
        done({ completed: false, reason: 'no_ad_api' });
        return;
      }
      webAdOverlay(placement, done);
    },

    /* 宿主**能不能**真的播激励视频。
     *
     * 为什么需要单独问一句：死亡界面的「看广告复活」原来只看
     * `reviveLeft > 0` —— 也就是只看玩家的次数，不看宿主的能力。
     * 于是在没有广告 API 的宿主上（小游戏模拟器、还没开通流量主的包、
     * 某些抖音版本），玩家看到的是一个**点不动的按钮**：点一次弹
     * 「广告未看完」，再点还是这一句。比「没有复活」更糟的是它看起来有。
     *
     * 判据用「API 在不在」，不用「上一次成没成功」：
     * 广告拉取失败是**偶发**的（load_fail），而 API 不存在是**结构性**的。
     * 前者该让玩家重试，后者不该把按钮摆出来。
     */
    canShowAd: function () {
      if (Platform.autoAd) return true;          /* 无人值守：桩，算有能力 */
      if (env === 'wechat') return !!(global.wx && global.wx.createRewardedVideoAd);
      if (env === 'bytedance') return !!(global.tt && global.tt.createRewardedVideoAd);
      return !Platform.isMiniGame;               /* Web 演示层有 #adOverlay 兜底 */
    },

    /* 广告没给奖励时，得说清楚**为什么**。
     * 原来所有失败都报「广告未看完」——可宿主根本没有广告 API 时，
     * 玩家没看完的不是广告，是我们在骗他。 */
    adFailText: function (res) {
      var r = res && res.reason;
      if (r === 'busy') return '广告正在加载，稍后再试';
      if (r === 'no_ad_api') return '当前环境不支持激励视频';
      if (r === 'load_fail') return '广告拉取失败，稍后再试';
      if (r === 'error') return '广告异常，稍后再试';
      return '广告未看完';
    },

    vibrate: function (ms) {
      try {
        if (env === 'wechat' && global.wx.vibrateShort) { global.wx.vibrateShort({ type: 'light' }); return; }
        if (env === 'bytedance' && global.tt.vibrateShort) { global.tt.vibrateShort(); return; }
        if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(ms || 18);
      } catch (e) {}
    },

    /* 分享（用于「晒战绩」） */
    share: function (payload) {
      try {
        if (env === 'wechat' && global.wx.shareAppMessage) {
          global.wx.shareAppMessage({ title: payload.title, imageUrl: payload.imageUrl || '' });
          return true;
        }
        if (env === 'bytedance' && global.tt.shareAppMessage) {
          global.tt.shareAppMessage({ title: payload.title });
          return true;
        }
        if (global.navigator && global.navigator.clipboard) {
          global.navigator.clipboard.writeText(payload.title);
          return true;
        }
      } catch (e) {}
      return false;
    },

    /* 屏幕安全区（小游戏刘海屏适配） */
    safeArea: { top: 0, bottom: 0, left: 0, right: 0 },

    /* 保存本地数据 */
    save: function (key, val) { return storage.set('xs_' + key, val); },
    load: function (key, def) { return storage.get('xs_' + key, def); }
  };

  /* 小游戏环境读取安全区 */
  try {
    if (env === 'wechat' && global.wx.getSystemInfoSync) {
      var si = global.wx.getSystemInfoSync();
      if (si.safeArea) {
        Platform.safeArea = {
          top: si.safeArea.top || 0,
          bottom: (si.screenHeight || 0) - (si.safeArea.bottom || 0),
          left: si.safeArea.left || 0,
          right: (si.screenWidth || 0) - (si.safeArea.right || 0)
        };
      }
    }
  } catch (e) {}

})(window);
