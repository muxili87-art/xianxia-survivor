/* ============================================================
 * 程序化音频系统（零音频资源）
 *
 * 为什么不用音频文件：
 *   1) 微信/抖音小游戏首包上限 4MB，音频是最容易吃掉预算的东西；
 *   2) 合成音可以跟随玩法实时变化 —— 连击越高音越亮、
 *      战况越激烈鼓点越密，这是固定音频文件做不到的。
 *
 * 结构：
 *   master ─┬─ sfxBus ──(干声 + 混响送出)
 *           └─ musicBus
 *
 * 所有对外方法在音频上下文不可用时都是安全空操作，
 * 因此无头验证环境（没有声卡）不会因为音频而报错。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var P = XS.Platform;

  var Audio = XS.Audio = {};

  /* ---------- 状态 ---------- */
  var ctx = null;
  var master = null, sfxBus = null, musicBus = null;
  var reverb = null, reverbSend = null;
  var noiseBuf = null;
  var ready = false;
  var unlockTried = false;
  var initError = null;   // 建上下文失败的原因，诊断里要报
  /* 音频总开关。
     **这一行原来是漏的** —— `enabled` 从来没声明过，而本文件是
     `'use strict'`，于是**读**它就会抛 ReferenceError。
     后果不是「音效开关失灵」，而是：
       Audio.unlock() 成功（真机上玩家第一次触摸就会成功）
       → ready = true
       → 下一个 Sfx.play() 走到 `if (!ready || !enabled)`
       → 抛 ReferenceError → 从 updateSwords 一路冒到主循环
       → **游戏在第一次挥剑时就断掉**。
     为什么两个走查都没抓到：Web 侧机器人从不点击，unlock 没被调用；
     小游戏侧那个假 window 上没有 AudioContext，init 直接失败。
     两条路各自因为**不同**的原因短路掉了，于是这个 bug 一路活到了真机。
     这也解释了为什么它偏偏出在唯一一个没有验证入口的子系统里。 */
  var enabled = true;
  /* 音效实际播出去的次数。**这是「音频到底有没有响」的唯一硬证据** ——
     isReady() 只说明上下文建起来了，不说明任何一个音被调度过。
     以前整个音频子系统一条验证都没有：调用点 34 个、全都写在代码里，
     但从来没人确认过它们真的执行到。 */
  var playedCount = 0;
  var lastPlayed = null;
  /* 播放请求的漏斗。calls 是分母，played 是真正调度出去的，
     dropped 按原因分开 —— 见 Audio.play 里的注释。 */
  var calls = 0;
  var dropped = { noCtx: 0, unknown: 0, throttle: 0, error: 0 };
  var lastUnknown = null;
  var lastError = null;

  var vol = { master: 0.85, sfx: 0.78, music: 0.40 };
  var saved = P.load('audio', null);
  if (saved && typeof saved === 'object') {
    if (typeof saved.master === 'number') vol.master = saved.master;
    if (typeof saved.sfx === 'number') vol.sfx = saved.sfx;
    if (typeof saved.music === 'number') vol.music = saved.music;
  }

  /* ---------- 节流：同一音效短时间内的最大触发次数 ---------- */
  var gate = {};
  function allow(name, minGap) {
    var t = ctx.currentTime;
    if (gate[name] && t - gate[name] < minGap) return false;
    gate[name] = t;
    return true;
  }

  /* ---------- 基础构件 ---------- */

  /* 生成一段白噪声（全系统共用，避免重复分配） */
  function makeNoise(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* 用噪声 + 指数衰减造一个混响脉冲响应，省掉音频文件 */
  function makeReverb(seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /* ADSR 包络：a/d 秒，峰值 peak */
  function env(g, t0, a, d, peak) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  /* 单音：波形 + 频率滑音 */
  function tone(o) {
    var t0 = o.t || ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), t0 + (o.sweep || o.dur));
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    env(g, t0, o.a === undefined ? 0.004 : o.a, o.dur, o.gain === undefined ? 0.3 : o.gain);
    var node = osc;
    if (o.filter) {
      var f = ctx.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.cut0 || 1200, t0);
      if (o.cut1) f.frequency.exponentialRampToValueAtTime(Math.max(o.cut1, 40), t0 + o.dur);
      f.Q.value = o.q || 1;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(o.bus || sfxBus);
    if (o.send) { var sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(reverbSend); }
    osc.start(t0);
    osc.stop(t0 + o.dur + (o.a || 0.004) + 0.05);
    return osc;
  }

  /* 噪声层：滤波扫频 */
  function hiss(o) {
    var t0 = o.t || ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.cut0 || 2000, t0);
    if (o.cut1) f.frequency.exponentialRampToValueAtTime(Math.max(o.cut1, 40), t0 + o.dur);
    f.Q.value = o.q === undefined ? 1.2 : o.q;
    var g = ctx.createGain();
    env(g, t0, o.a === undefined ? 0.003 : o.a, o.dur, o.gain === undefined ? 0.2 : o.gain);
    src.connect(f); f.connect(g); g.connect(o.bus || sfxBus);
    if (o.send) { var sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(reverbSend); }
    src.start(t0);
    src.stop(t0 + o.dur + (o.a || 0.003) + 0.05);
    return src;
  }

  /* ---------- 初始化 ---------- */

  /* 这个上下文是**从哪来的**。
     'host'   = 宿主工厂（微信 wx.createWebAudioContext / 抖音 tt.getAudioContext）
                —— 小游戏上**只有这一条路**
     'native' = 浏览器原生 new AudioContext()
     null     = 拿不到上下文，音频整体关闭

     为什么必须报出来：这两条路各自都得被走到过才算验证过。
     浏览器里 g 就是真 window、原生 AudioContext 一直在，
     于是 shim 里那个「包装宿主工厂」的分支会被 if (!g.AudioContext) 挡掉，
     **永远不执行** —— 和触摸层被机器人绕过是同一类问题：
     代码在、看着能用、实际没跑过。 */
  var via = null;

  function init() {
    if (ready) return true;
    var AC = global.AudioContext || global.webkitAudioContext;
    /* 「还没有 AudioContext」和「建过一次但建失败了」是**两件事**。
       前者可能过一会儿就有了（宿主注入 / 用户手势之后才允许），必须允许再试；
       后者才是真的没戏。原来两种情况共用一个 unlockTried 闩，
       于是「第一次解锁时环境还没准备好」就等于**这一局永久静音** ——
       而静音是没有报错的，只会表现成「这游戏怎么没声音」。 */
    if (!AC) { via = null; return false; }
    if (unlockTried) return false;
    unlockTried = true;
    try {
      ctx = new AC();
      /* 判据挂在**构造函数**上（shim 包的），不是上下文对象上 ——
         真实宿主返回的对象里有什么字段我们并不知道。 */
      via = AC.__xsHostAudio ? 'host' : 'native';

      master = ctx.createGain();
      master.gain.value = vol.master;
      master.connect(ctx.destination);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = vol.sfx;
      sfxBus.connect(master);

      musicBus = ctx.createGain();
      musicBus.gain.value = vol.music;
      musicBus.connect(master);

      reverb = ctx.createConvolver();
      reverb.buffer = makeReverb(2.1, 2.6);
      reverbSend = ctx.createGain();
      reverbSend.gain.value = 0.5;
      var revOut = ctx.createGain();
      revOut.gain.value = 0.55;
      reverbSend.connect(reverb);
      reverb.connect(revOut);
      revOut.connect(master);

      noiseBuf = makeNoise(2.0);

      ready = true;
      return true;
    } catch (e) {
      ctx = null;
      ready = false;
      via = null;
      initError = String(e && e.message || e);
      return false;
    }
  }

  /* 首次用户交互时解锁（移动端浏览器强制要求） */
  Audio.unlock = function () {
    if (!init()) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
    Audio.unlock = function () {};
  };

  /* 页面失焦时自动静音，回来再恢复 —— 避免切后台还在响 */
  if (global.document) {
    global.document.addEventListener('visibilitychange', function () {
      if (!ready) return;
      try {
        if (global.document.hidden) ctx.suspend(); else ctx.resume();
      } catch (e) {}
    }, false);
  }

  /* ---------- 音量 ---------- */
  Audio.setVolume = function (group, v) {
    v = Math.max(0, Math.min(1, v));
    if (vol[group] === undefined) return;
    vol[group] = v;
    if (ready) {
      try {
        if (group === 'master') master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
        if (group === 'sfx') sfxBus.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
        if (group === 'music') musicBus.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
      } catch (e) {}
    }
    P.save('audio', vol);
  };
  Audio.getVolume = function (group) { return vol[group]; };
  Audio.isReady = function () { return ready; };

  /* ============================================================
   * 音效库
   * 命名对应玩法事件，参数都做过听感调试
   * ============================================================ */
  var SFX = {
    /* 飞剑挥砍：金属风声 + 高频泛音 */
    sword: function (v) {
      var t = ctx.currentTime;
      hiss({ t: t, filter: 'bandpass', cut0: 900, cut1: 4200, q: 0.9, dur: 0.13, gain: 0.16 * v, send: 0.16 });
      tone({ t: t, type: 'triangle', f0: 2100, f1: 900, dur: 0.10, gain: 0.055 * v, send: 0.2 });
    },
    /* 命中：闷响 + 短噪声 */
    hit: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'square', f0: 320, f1: 110, dur: 0.075, gain: 0.10 * v });
      hiss({ t: t, filter: 'lowpass', cut0: 2600, cut1: 700, q: 0.7, dur: 0.07, gain: 0.10 * v });
    },
    /* 暴击：更亮更脆 */
    crit: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'triangle', f0: 1500, f1: 2400, dur: 0.09, gain: 0.11 * v, send: 0.3 });
      tone({ t: t, type: 'square', f0: 420, f1: 140, dur: 0.10, gain: 0.09 * v });
      hiss({ t: t, filter: 'highpass', cut0: 3000, cut1: 6000, q: 0.6, dur: 0.10, gain: 0.09 * v });
    },
    /* 天雷：炸裂 + 低频轰鸣 */
    thunder: function (v) {
      var t = ctx.currentTime;
      hiss({ t: t, filter: 'bandpass', cut0: 5200, cut1: 400, q: 0.5, dur: 0.34, gain: 0.24 * v, send: 0.42 });
      tone({ t: t, type: 'sawtooth', f0: 150, f1: 42, dur: 0.42, gain: 0.16 * v });
      tone({ t: t + 0.012, type: 'sine', f0: 78, f1: 34, dur: 0.5, gain: 0.2 * v });
    },
    /* 冰霜：高音簇 + 结晶碎响 */
    frost: function (v) {
      var t = ctx.currentTime;
      for (var i = 0; i < 3; i++) {
        tone({ t: t + i * 0.018, type: 'sine', f0: 2600 + i * 620, f1: 1800 + i * 300, dur: 0.22, gain: 0.05 * v, send: 0.5 });
      }
      hiss({ t: t, filter: 'highpass', cut0: 4200, cut1: 7000, q: 0.5, dur: 0.24, gain: 0.07 * v, send: 0.4 });
    },
    /* 烈焰：低频噪声下扫 */
    ember: function (v) {
      var t = ctx.currentTime;
      hiss({ t: t, filter: 'lowpass', cut0: 1800, cut1: 220, q: 0.8, dur: 0.42, gain: 0.16 * v, send: 0.3 });
      tone({ t: t, type: 'sawtooth', f0: 220, f1: 70, dur: 0.36, gain: 0.09 * v });
    },
    /* 剑气发射 */
    qi: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'sawtooth', f0: 520, f1: 1500, dur: 0.11, gain: 0.055 * v, filter: 'lowpass', cut0: 2600, cut1: 1400 });
      hiss({ t: t, filter: 'bandpass', cut0: 1600, cut1: 3400, q: 1.4, dur: 0.10, gain: 0.05 * v, send: 0.3 });
    },
    /* 护体罡气脉冲 */
    aura: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'sine', f0: 160, f1: 320, dur: 0.34, gain: 0.09 * v, send: 0.5 });
      tone({ t: t, type: 'triangle', f0: 480, f1: 960, dur: 0.28, gain: 0.035 * v, send: 0.5 });
    },
    /* 拾取灵气：音高随连击上升（combo 由外部传入） */
    orb: function (v, combo) {
      var n = Math.min(combo || 0, 12);
      var f = 780 * Math.pow(1.0595, n * 2);
      tone({ t: ctx.currentTime, type: 'sine', f0: f, f1: f * 1.5, dur: 0.10, gain: 0.055 * v, send: 0.34 });
    },
    /* 升级：五声音阶上行琶音，钟感 */
    levelup: function (v) {
      var t = ctx.currentTime;
      var notes = [587.33, 698.46, 880.00, 1174.66];
      for (var i = 0; i < notes.length; i++) {
        tone({ t: t + i * 0.075, type: 'triangle', f0: notes[i], dur: 0.9, a: 0.008, gain: 0.075 * v, send: 0.62 });
        tone({ t: t + i * 0.075, type: 'sine', f0: notes[i] * 2, dur: 0.5, a: 0.006, gain: 0.028 * v, send: 0.5 });
      }
    },
    /* 功法进化：更厚的大三和弦 + 长混响 */
    evolve: function (v) {
      var t = ctx.currentTime;
      var ch = [293.66, 440.00, 587.33, 880.00, 1174.66];
      for (var i = 0; i < ch.length; i++) {
        tone({ t: t + i * 0.05, type: 'triangle', f0: ch[i], dur: 2.2, a: 0.02, gain: 0.06 * v, send: 0.85 });
      }
      hiss({ t: t, filter: 'highpass', cut0: 3000, cut1: 9000, q: 0.5, dur: 1.4, gain: 0.05 * v, send: 0.7 });
      tone({ t: t, type: 'sine', f0: 73.42, dur: 2.4, a: 0.03, gain: 0.13 * v });
    },
    /* 受伤 */
    hurt: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'square', f0: 180, f1: 62, dur: 0.20, gain: 0.14 * v, filter: 'lowpass', cut0: 1400, cut1: 400 });
      hiss({ t: t, filter: 'lowpass', cut0: 1200, cut1: 300, q: 0.7, dur: 0.16, gain: 0.12 * v });
    },
    /* 死亡 */
    death: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'sawtooth', f0: 320, f1: 48, dur: 1.3, gain: 0.16 * v, filter: 'lowpass', cut0: 1800, cut1: 180, send: 0.6 });
      hiss({ t: t, filter: 'lowpass', cut0: 2400, cut1: 200, q: 0.6, dur: 1.2, gain: 0.13 * v, send: 0.5 });
    },
    /* 首领降临：低音铜管感 + 地鸣 */
    bossIn: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'sawtooth', f0: 55, f1: 41, dur: 2.4, a: 0.10, gain: 0.20 * v, filter: 'lowpass', cut0: 700, cut1: 260, send: 0.4 });
      tone({ t: t, type: 'square', f0: 82.41, dur: 2.2, a: 0.14, gain: 0.09 * v, filter: 'lowpass', cut0: 500, cut1: 200 });
      hiss({ t: t, filter: 'lowpass', cut0: 600, cut1: 120, q: 0.6, dur: 2.6, a: 0.2, gain: 0.14 * v, send: 0.5 });
    },
    /* 首领死亡：冲击 + 上扫 */
    bossDie: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'sine', f0: 120, f1: 28, dur: 1.8, gain: 0.26 * v });
      hiss({ t: t, filter: 'bandpass', cut0: 300, cut1: 6000, q: 0.4, dur: 1.6, gain: 0.18 * v, send: 0.7 });
      tone({ t: t + 0.05, type: 'triangle', f0: 220, f1: 1760, dur: 1.4, gain: 0.06 * v, send: 0.9 });
    },
    /* UI 点击 */
    ui: function (v) {
      tone({ t: ctx.currentTime, type: 'sine', f0: 880, f1: 1320, dur: 0.06, gain: 0.05 * v, send: 0.2 });
    },
    /* 妖将出场 */
    elite: function (v) {
      var t = ctx.currentTime;
      tone({ t: t, type: 'square', f0: 110, f1: 74, dur: 0.8, a: 0.03, gain: 0.12 * v, filter: 'lowpass', cut0: 900, cut1: 300 });
      hiss({ t: t, filter: 'bandpass', cut0: 900, cut1: 2600, q: 0.8, dur: 0.6, gain: 0.08 * v, send: 0.4 });
    }
  };

  /* 统一入口：sfx('hit', 0.9) */
  Audio.play = function (name, volScale, arg) {
    /* 这里要计数，而且要把**被吞掉的原因**分开记。
       「调用点有 34 个」证明不了任何事 —— 得证明它们真的执行到了，
       以及没执行到的时候是为什么。三种吞掉的方式语义完全不同：
         noCtx    —— 上下文不可用（真机上=宿主没给音频，应当降级而不是崩）
         unknown  —— 名字拼错了（**只可能是代码写错**，最该报的一种）
         throttle —— 高频节流（正常，是设计） */
    calls++;
    if (!ready || !enabled) { dropped.noCtx++; return; }
    var fn = SFX[name];
    if (!fn) { dropped.unknown++; lastUnknown = name; return; }
    /* 高频音效节流，避免 100 只怪同帧触发把音频线程打死 */
    var gap = name === 'hit' ? 0.035 : (name === 'orb' ? 0.05 : (name === 'sword' ? 0.07 : 0.0));
    if (gap > 0 && !allow(name, gap)) { dropped.throttle++; return; }
    try {
      fn(volScale === undefined ? 1 : volScale, arg);
      playedCount++;
      lastPlayed = name;
    } catch (e) { dropped.error++; lastError = String(e && e.message || e); }
  };

  /* 音频子系统的全部可观测状态。
     **这是这个子系统第一次有验证入口。** 在此之前它一条读数都没有：
     34 个调用点、写得好好的，但从来没人确认过任何一个音真的被调度过。
     报的都是「渲染器看到的事实」，不是设置里写的值 ——
     buses 那三项是**直接从 AudioParam 读回来的**，
     所以它能回答「我拖了音量条，声音总线真的跟着变了吗」。 */
  Audio.debugInfo = function () {
    return {
      ready: ready,
      enabled: enabled,
      /* 'host' = 宿主工厂（小游戏唯一那条路）；'native' = 浏览器原生；
         null = 拿不到上下文 */
      via: via,
      initError: initError,
      musicOn: music.on,
      calls: calls,
      played: playedCount,
      dropped: {
        noCtx: dropped.noCtx, unknown: dropped.unknown,
        throttle: dropped.throttle, error: dropped.error
      },
      /* 拼错的音效名会被单独揪出来：这个字段只要有值就一定是 bug。 */
      lastUnknown: lastUnknown,
      lastError: lastError,
      lastPlayed: lastPlayed,
      /* 三条总线的**实际增益**（读的是 AudioParam，不是设置里的数） */
      buses: ready ? {
        master: +master.gain.value.toFixed(3),
        sfx: +sfxBus.gain.value.toFixed(3),
        music: +musicBus.gain.value.toFixed(3)
      } : null,
      /* 而这一项是**请求值**（最后一次 setVolume 传进来的）。
         为什么要和上面分开报：音量是走 setTargetAtTime 渐变的，
         无头环境里上下文是 suspended、currentTime 不推进，
         于是 AudioParam 永远停在初始值 —— 只读 AudioParam 的话
         「拖了音量条到底有没有传到总线上」这件事根本验不了。
         两个一起报：requested 证明**传到了**，buses 证明**当前实际值**。 */
      requested: {
        master: +vol.master.toFixed(3),
        sfx: +vol.sfx.toFixed(3),
        music: +vol.music.toFixed(3)
      },
      ctxState: ready ? ctx.state : null,
      sampleRate: ready ? ctx.sampleRate : null
    };
  };

  Audio.setEnabled = function (v) { enabled = !!v; if (ready && !v) Audio.stopMusic(); };
  Audio.isEnabled = function () { return enabled; };

  /* ============================================================
   * 环境音乐
   * 五声音阶 pad + 随战况增强的节奏层
   * ============================================================ */
  var music = {
    on: false,
    step: 0,
    nextT: 0,
    timer: null,
    intensity: 0,
    targetIntensity: 0,
    drone: [],
    padVoices: [],
    stepDur: 0.30
  };

  /* 五声音阶（D 羽调式）—— 仙侠气质的核心 */
  var PENTA = [146.83, 174.61, 196.00, 220.00, 261.63, 293.66, 349.23, 392.00];
  /* 每 16 步换一次上方和声，营造缓慢推进的段落感 */
  var PROG = [
    [293.66, 440.00, 587.33],
    [261.63, 392.00, 523.25],
    [349.23, 523.25, 698.46],
    [329.63, 493.88, 659.25]
  ];

  function startDrone() {
    var t = ctx.currentTime;
    var spec = [
      { f: 73.42, g: 0.055, type: 'sine' },
      { f: 110.00, g: 0.030, type: 'sine' },
      { f: 146.83, g: 0.020, type: 'triangle' }
    ];
    for (var i = 0; i < spec.length; i++) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = spec[i].type;
      o.frequency.value = spec[i].f;
      o.detune.value = (i - 1) * 5;
      g.gain.value = 0;
      g.gain.setTargetAtTime(spec[i].g, t, 2.5);
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.6;
      o.connect(f); f.connect(g); g.connect(musicBus);
      /* 混响送出，让 pad 有空间感 */
      var sg = ctx.createGain(); sg.gain.value = 0.4;
      g.connect(sg); sg.connect(reverbSend);
      o.start(t);
      music.drone.push(o);
    }
  }

  function stopDrone() {
    var t = ctx.currentTime;
    for (var i = 0; i < music.drone.length; i++) {
      try {
        music.drone[i].stop(t + 1.2);
      } catch (e) {}
    }
    music.drone.length = 0;
  }

  /* 上方 pad：每 16 步换和弦，音色柔和，长包络 */
  function padChord(chord, t) {
    for (var i = 0; i < chord.length; i++) {
      tone({
        t: t, type: 'triangle', f0: chord[i], dur: 4.6, a: 1.4,
        gain: 0.030, bus: musicBus, send: 0.8,
        filter: 'lowpass', cut0: 1800, cut1: 1100, q: 0.5
      });
    }
  }

  /* 高频铃音：随机点缀，稀疏才有「空灵感」 */
  function bell(t) {
    var f = PENTA[Math.floor(Math.random() * PENTA.length)] * 4;
    tone({ t: t, type: 'sine', f0: f, dur: 2.6, a: 0.01, gain: 0.022, bus: musicBus, send: 1.0 });
  }

  /* 鼓点：低频冲击 + 噪声尾巴，强度越高越明显 */
  function drum(t, strong) {
    tone({ t: t, type: 'sine', f0: 110, f1: 44, dur: 0.20, gain: (strong ? 0.20 : 0.11) * music.intensity, bus: musicBus });
    hiss({ t: t, filter: 'bandpass', cut0: 1400, cut1: 380, q: 0.8, dur: 0.10, gain: 0.05 * music.intensity, bus: musicBus, send: 0.3 });
  }

  /* 沙锤：高强度时的 8 分音符律动 */
  function shaker(t) {
    hiss({ t: t, filter: 'highpass', cut0: 5200, cut1: 8200, q: 0.5, dur: 0.055, gain: 0.030 * music.intensity, bus: musicBus, send: 0.25 });
  }

  function playStep(step, t) {
    var bar = Math.floor(step / 16) % PROG.length;
    if (step % 16 === 0) padChord(PROG[bar], t);
    if (Math.random() < 0.10) bell(t);
    var I = music.intensity;
    if (I > 0.12) {
      if (step % 8 === 0) drum(t, true);
      else if (step % 4 === 0) drum(t, false);
    }
    if (I > 0.5 && step % 2 === 1) shaker(t);
  }

  function scheduler() {
    if (!music.on || !ready) return;
    try {
      var look = ctx.currentTime + 0.20;
      var guard = 0;
      while (music.nextT < look && guard++ < 32) {
        playStep(music.step, music.nextT);
        music.nextT += music.stepDur;
        music.step++;
      }
      /* 强度平滑跟随，避免战况突变时音乐跳变 */
      music.intensity += (music.targetIntensity - music.intensity) * 0.06;
    } catch (e) {}
  }

  Audio.startMusic = function () {
    if (!ready || !enabled || music.on) return;
    music.on = true;
    music.step = 0;
    music.nextT = ctx.currentTime + 0.1;
    music.intensity = 0;
    music.targetIntensity = 0;
    startDrone();
    if (!music.timer) music.timer = global.setInterval(scheduler, 60);
  };

  Audio.stopMusic = function () {
    if (!music.on) return;
    music.on = false;
    if (music.timer) { global.clearInterval(music.timer); music.timer = null; }
    stopDrone();
  };

  /* 战况强度 0~1：外部按敌人数 / 首领在场 / 残血推入 */
  Audio.setIntensity = function (v) {
    music.targetIntensity = Math.max(0, Math.min(1, v));
  };

  Audio.musicOn = function () { return music.on; };

})(window);
