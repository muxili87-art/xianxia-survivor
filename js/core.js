/* ============================================================
 * 引擎层：渲染器 / 后处理 / 摄像机 / 输入
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var T = global.THREE;

  var Core = XS.Core = {};

  /* ---------------- 通用工具 ---------------- */
  var U = XS.U = {
    /* 帧率无关的指数逼近 */
    approach: function (cur, target, rate, dt) {
      return cur + (target - cur) * (1 - Math.exp(-rate * dt));
    },
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    randInt: function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
    pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },
    /* 圆形场地内随机点 */
    randInCircle: function (radius, out) {
      var a = Math.random() * Math.PI * 2;
      var r = Math.sqrt(Math.random()) * radius;
      out = out || {};
      out.x = Math.cos(a) * r;
      out.z = Math.sin(a) * r;
      return out;
    },
    /* 按权重抽取 */
    pickWeighted: function (list, weightFn) {
      var total = 0, i;
      for (i = 0; i < list.length; i++) total += weightFn(list[i]);
      if (total <= 0) return null;
      var r = Math.random() * total;
      for (i = 0; i < list.length; i++) {
        r -= weightFn(list[i]);
        if (r <= 0) return list[i];
      }
      return list[list.length - 1];
    },
    fmtTime: function (s) {
      s = Math.max(0, Math.floor(s));
      var m = Math.floor(s / 60);
      var ss = s % 60;
      return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    }
  };

  /* ---------------- 后处理：国风调色 ---------------- */
  var GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uAberration: { value: 0.0016 },
      uVignette: { value: 0.78 },
      uFlash: { value: 0.0 },       // 受击红闪
      uFlashColor: { value: new T.Color(1.0, 0.20, 0.22) },
      uHeal: { value: 0.0 },        // 升级金光
      uSaturation: { value: 1.04 },
      uTime: { value: 0.0 }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float uAberration, uVignette, uFlash, uHeal, uSaturation, uTime;',
      'uniform vec3 uFlashColor;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 uv = vUv;',
      '  vec2 d = uv - 0.5;',
      '  float r2 = dot(d,d);',
      // 径向色差
      '  float ab = uAberration * (1.0 + r2 * 5.0);',
      '  vec3 col;',
      '  col.r = texture2D(tDiffuse, uv + d * ab).r;',
      '  col.g = texture2D(tDiffuse, uv).g;',
      '  col.b = texture2D(tDiffuse, uv - d * ab).b;',
      // 青金分离调色：暗部偏青，亮部偏金
      '  float lum = dot(col, vec3(0.2126,0.7152,0.0722));',
      '  vec3 shadowTint = vec3(0.84, 0.98, 1.10);',
      '  vec3 highTint   = vec3(1.17, 1.02, 0.79);',
      '  vec3 tint = mix(shadowTint, highTint, smoothstep(0.12, 0.72, lum));',
      '  col *= tint;',
      // 饱和度
      '  col = mix(vec3(lum), col, uSaturation);',
      // 暗角
      '  float vig = smoothstep(0.92, 0.18, r2 * uVignette * 2.2);',
      '  col *= mix(0.42, 1.0, vig);',
      // 受击红闪
      '  col = mix(col, uFlashColor * (0.35 + lum), uFlash);',
      // 升级金光
      '  col += vec3(1.0, 0.82, 0.42) * uHeal * (0.25 + 0.75 * (1.0 - r2 * 2.0));',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  };

  /* ---------------- 初始化 ---------------- */

  /* WebGL 能力探测。
     **必须用一张一次性的 canvas**，绝不能用 #scene ——
     一旦在真画布上试过 getContext，那张画布就被钉在这个上下文类型上，
     后续再想换一种就没机会了（一个 canvas 只能有一种上下文）。
     探测失败本身也不能让真画布陪葬。

     为什么值得单独做这一步：`new WebGLRenderer` 失败时抛的是
     "Error creating WebGL context."，这句话对用户毫无信息量 ——
     他不知道是浏览器关了硬件加速、显卡驱动挂了，还是标签页开太多。
     探一遍就能把「环境到底给不给 WebGL」变成一个可读的事实。 */
  Core.probeGL = function () {
    var r = { webgl2: false, webgl1: false, renderer: null, vendor: null, error: null };
    var cv;
    try { cv = document.createElement('canvas'); } catch (e) { r.error = String(e); return r; }
    var gl = null;
    try { gl = cv.getContext('webgl2'); if (gl) r.webgl2 = true; } catch (e) {}
    if (!gl) {
      try { gl = cv.getContext('webgl'); if (gl) r.webgl1 = true; } catch (e) {}
    }
    if (!gl) {
      try { gl = cv.getContext('experimental-webgl'); if (gl) r.webgl1 = true; } catch (e) {}
    }
    if (gl) {
      try {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        r.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        r.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      } catch (e) {}
      /* 探完就主动丢掉，别占着浏览器那 16 个上下文名额之一。
         这一步很容易漏：探测本身也是一次真实的上下文创建。 */
      try { var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) {}
    }
    return r;
  };

  /* 依次尝试若干组参数建渲染器。
     为什么要试多组：three.js 只会在**全部**尝试都失败时才抛，
     而它自己那两跳（带属性 / 不带属性）用的是同一组 contextNames。
     真机上确实存在「webgl2 建不出来但 webgl1 可以」的驱动，
     以及「high-performance 被拒但默认可以」的省电模式 ——
     多试一组就能救回来，而不是直接把用户挡在门外。

     写法上有一条硬要求：**`canvas` 必须是基准参数，不能被某一组覆盖掉。**
     这里踩过一次：第一版把每一组写成完整的 opts 字面量，
     结果 `canvas: canvas` 只在 forceWebGL1 那一支里写了 ——
     于是前两组走的是 three.js **自己新建**的离屏画布（默认 300×150），
     游戏正常跑、`state: playing`、没有任何报错，就是**画不到屏幕上**。
     现在改成「基准 + 差异覆盖」，`canvas` 只写一次，加新组也漏不掉。 */
  /* 用一张**全新的**画布替换掉旧的（保持 id / class / 其它属性不变）。
     为什么降级重试必须换画布：
     一个 canvas 一旦 `getContext('webgl2', 属性)` **创建失败**，
     它就被钉在这个上下文类型上 —— 之后再在同一张画布上试
     `getContext('webgl2')`（不带属性）或 `getContext('webgl')` 都返回 null。
     three.js 自己那两跳用的就是同一张画布，所以它那句
     「Error creating WebGL context.」（而不是 "...with your selected attributes."）
     恰恰说明**不带属性的重试也失败了** —— 这时再在同一张画布上换参数毫无意义。
     换一张干净的画布，才谈得上「重试」。
     小游戏侧拿不到第二张上屏画布（只有第一次 createCanvas() 是上屏的），
     这时原样返回，退化成「同一张画布再试一次」。 */
  Core._freshCanvas = function (old) {
    if (!old || !old.parentNode || !global.document || !global.document.createElement) return old;
    var c;
    try { c = global.document.createElement('canvas'); } catch (e) { return old; }
    try {
      for (var i = 0; i < old.attributes.length; i++) {
        var at = old.attributes[i];
        if (at.name === 'id' || at.name === 'class') continue;
        c.setAttribute(at.name, at.value);
      }
      if (old.id) c.id = old.id;
      if (old.className) c.className = old.className;
      old.parentNode.replaceChild(c, old);
    } catch (e) { return old; }
    return c;
  };

  Core.createRenderer = function (canvas) {
    var BASE = { antialias: false, alpha: false, stencil: false };
    /* 每组只写**差异**。canvas 在循环里逐次给出（见下面的换画布），加新组也漏不掉。 */
    var attempts = [
      { name: 'webgl2+highperf', diff: { powerPreference: 'high-performance' } },
      { name: 'webgl2',          diff: {} },
      { name: 'webgl1',          diff: {}, forceGL1: true },
      /* 最后一组：连 alpha/stencil/antialias 都不传，把属性这一层变量彻底去掉。 */
      { name: 'bare',            diff: {}, bare: true }
    ];
    var lastErr = null, cur = canvas;
    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      /* 第一组用原画布；之后每组都换一张干净的 —— 见 _freshCanvas 的注释。 */
      if (i > 0) cur = Core._freshCanvas(cur);
      var o = { canvas: cur };
      if (!a.bare) { for (var k in BASE) o[k] = BASE[k]; }
      for (var k2 in a.diff) o[k2] = a.diff[k2];
      try {
        /* forceGL1：逼 three.js 走 webgl1 那条路（见下面的 shim）。 */
        var renderer = a.forceGL1
          ? Core._forceGL1(function () { return new T.WebGLRenderer(o); })
          : new T.WebGLRenderer(o);
        renderer.__attempt = a.name;
        Core.canvas = cur;              // 后面 resize / 诊断都要用最终那张
        return renderer;
      } catch (e) { lastErr = e; }
    }
    var err = new Error(lastErr ? lastErr.message : '无法创建 WebGL 上下文');
    err.__attempts = attempts.length;
    throw err;
  };

  /* 临时把 canvas.getContext 包一层，屏蔽 'webgl2'，
     逼 three.js r128 走 webgl1 那条路。
     只在构造那一次生效，构造完立刻还原 —— 不能常驻，
     否则后面所有 getContext('webgl2') 都会莫名其妙拿到 null。 */
  Core._forceGL1 = function (fn) {
    var proto = global.HTMLCanvasElement && global.HTMLCanvasElement.prototype;
    if (!proto || !proto.getContext) return fn();
    var orig = proto.getContext;
    proto.getContext = function (name) {
      if (name === 'webgl2') return null;
      return orig.apply(this, arguments);
    };
    try { return fn(); } finally { proto.getContext = orig; }
  };

  Core.init = function (canvas) {
    var renderer = Core.createRenderer(canvas);
    Core.glAttempt = renderer.__attempt;
    renderer.setClearColor(XS.C.inkDeep, 1);
    /* r128：hex 视为线性值，输出保持线性避免二次 gamma 洗白 */
    renderer.outputEncoding = T.LinearEncoding;
    renderer.toneMapping = T.NoToneMapping;
    /* 手动重置渲染统计，这样能统计整帧（含全部后处理 pass）的开销 */
    renderer.info.autoReset = false;

    var basePR = Math.min(global.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(basePR);
    renderer.setSize(global.innerWidth, global.innerHeight, false);

    var scene = new T.Scene();
    scene.fog = new T.FogExp2(0x0a2436, 0.0126);

    var camera = new T.PerspectiveCamera(
      XS.CAM.fov, global.innerWidth / global.innerHeight, 0.5, 400
    );
    camera.position.set(XS.CAM.offset.x, XS.CAM.offset.y, XS.CAM.offset.z);
    camera.lookAt(0, 0, 0);

    /* 后处理链 */
    var composer = new T.EffectComposer(renderer);
    composer.setPixelRatio(basePR);
    composer.setSize(global.innerWidth, global.innerHeight);
    composer.addPass(new T.RenderPass(scene, camera));

    var bloom = new T.UnrealBloomPass(
      new T.Vector2(global.innerWidth, global.innerHeight),
      0.46,   // strength
      0.66,   // radius
      0.62    // threshold
    );
    composer.addPass(bloom);

    var grade = new T.ShaderPass(GradeShader);
    grade.renderToScreen = true;
    composer.addPass(grade);

    Core.renderer = renderer;
    Core.scene = scene;
    Core.camera = camera;
    Core.composer = composer;
    Core.bloom = bloom;
    Core.grade = grade;
    Core.basePR = basePR;
    Core.prScale = 1.0;

    /* ---------------- 画质档位 ----------------
       三档预设 + 自动。每一项都真实生效：
       分辨率上限、泛光强度、粒子数量、后期效果开关。
       低端机（千元安卓 / 老 iPhone）靠这一档才跑得动。 */
    Core.PRESETS = {
      high: { label: '高', prCap: 1.00, bloom: true, bloomStrength: 0.46, particles: 1.00 },
      mid:  { label: '中', prCap: 0.82, bloom: true, bloomStrength: 0.36, particles: 0.62 },
      low:  { label: '低', prCap: 0.66, bloom: false, bloomStrength: 0.00, particles: 0.30 }
    };
    Core.q = { prCap: 1.00, bloom: true, particles: 1.00, label: '自动' };

    Core.applyQuality = function (name) {
      Core.quality = name;
      var preset = Core.PRESETS[name];
      if (preset) {
        Core.q = {
          prCap: preset.prCap, bloom: preset.bloom,
          particles: preset.particles, label: preset.label
        };
        bloom.enabled = preset.bloom;
        bloom.strength = preset.bloomStrength;
      } else {
        /* 自动：不锁分辨率上限，泛光全开 */
        Core.q = { prCap: 1.00, bloom: true, particles: 1.00, label: '自动' };
        bloom.enabled = true;
        bloom.strength = 0.46;
      }
      Core.prScale = Math.min(Core.prScale, Core.q.prCap);
      var pr = Core.basePR * Core.prScale;
      renderer.setPixelRatio(pr);
      composer.setPixelRatio(pr);
      return Core.q;
    };

    /* ---------------- 自适应分辨率 ---------------- */
    var frameAcc = 0, frameN = 0, lastAdjust = 0, now = 0;
    Core.adaptQuality = function (dt) {
      frameAcc += dt; frameN++;
      now += dt;
      if (frameN >= 40) {
        var avg = frameAcc / frameN;
        frameAcc = 0; frameN = 0;
        if (now - lastAdjust > 1.2) {
          var next = Core.prScale;
          var lo = 0.58, hi = Core.q.prCap;
          if (avg > 0.0225 && Core.prScale > lo) next = Core.prScale - 0.07;
          else if (avg < 0.0152 && Core.prScale < hi) next = Core.prScale + 0.05;
          if (next !== Core.prScale) {
            Core.prScale = U.clamp(next, lo, hi);
            var pr = Core.basePR * Core.prScale;
            renderer.setPixelRatio(pr);
            composer.setPixelRatio(pr);
            lastAdjust = now;
          }
        }
      }
    };

    /* ---------------- 屏幕震动 ---------------- */
    var shake = 0;
    Core.shakeScale = 1;
    Core.addShake = function (v) { shake = Math.min(1.6, shake + v * Core.shakeScale); };
    Core.getShake = function () { return shake; };
    Core.decayShake = function (dt) {
      shake = U.approach(shake, 0, XS.CAM.shakeDecay, dt);
      if (shake < 0.0006) shake = 0;
    };

    /* ---------------- 尺寸 ---------------- */
    Core.resize = function () {
      var w = global.innerWidth, h = global.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.setSize(w, h);
      Core.basePR = Math.min(global.devicePixelRatio || 1, 2);
      var pr = Core.basePR * Core.prScale;
      renderer.setPixelRatio(pr);
      composer.setPixelRatio(pr);
    };
    global.addEventListener('resize', Core.resize);

    return Core;
  };

  /* ---------------- 输入 ---------------- */
  var Input = XS.Input = {
    vec: { x: 0, y: 0 },     // 归一化方向（y 正向为「上」= 屏幕前）
    active: false,
    keys: {},
    _stickId: null,
    _cx: 0, _cy: 0,
    _maxR: 54
  };

  Input.bind = function () {
    var stick = document.getElementById('stick');
    var knob = document.getElementById('stickKnob');
    var zone = document.getElementById('touchZone');
    if (!stick || !knob || !zone) return;

    function setKnob(dx, dy) {
      knob.style.transform = 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px)';
    }

    function start(cx, cy) {
      Input.active = true;
      Input._cx = cx; Input._cy = cy;
      stick.classList.add('on');
      stick.style.left = cx + 'px';
      stick.style.top = cy + 'px';
      setKnob(0, 0);
      Input.vec.x = 0; Input.vec.y = 0;
    }

    function move(cx, cy) {
      var dx = cx - Input._cx;
      var dy = cy - Input._cy;
      var len = Math.hypot(dx, dy);
      var maxR = Input._maxR;
      if (len > maxR) { dx = dx / len * maxR; dy = dy / len * maxR; len = maxR; }
      setKnob(dx, dy);
      var n = len / maxR;
      if (n < 0.12) { Input.vec.x = 0; Input.vec.y = 0; return; }
      var k = Math.min(1, (n - 0.12) / 0.55);
      var il = 1 / (Math.hypot(dx, dy) || 1);
      Input.vec.x = dx * il * k;
      Input.vec.y = -dy * il * k;   // 屏幕向下 = 世界 -z
    }

    function end() {
      Input.active = false;
      Input._stickId = null;
      stick.classList.remove('on');
      setKnob(0, 0);
      Input.vec.x = 0; Input.vec.y = 0;
    }

    zone.addEventListener('touchstart', function (e) {
      if (Input._stickId !== null) return;
      var t = e.changedTouches[0];
      Input._stickId = t.identifier;
      start(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });

    global.addEventListener('touchmove', function (e) {
      if (Input._stickId === null) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === Input._stickId) { move(t.clientX, t.clientY); e.preventDefault(); return; }
      }
    }, { passive: false });

    global.addEventListener('touchend', function (e) {
      if (Input._stickId === null) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === Input._stickId) { end(); return; }
      }
    }, { passive: false });
    global.addEventListener('touchcancel', function () { if (Input._stickId !== null) end(); });

    /* 鼠标（桌面调试） */
    var mouseDown = false;
    zone.addEventListener('mousedown', function (e) {
      mouseDown = true; start(e.clientX, e.clientY); e.preventDefault();
    });
    global.addEventListener('mousemove', function (e) { if (mouseDown) move(e.clientX, e.clientY); });
    global.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; end(); } });

    /* 键盘 */
    global.addEventListener('keydown', function (e) {
      Input.keys[e.key.toLowerCase()] = true;
      if (e.key === ' ') e.preventDefault();
    });
    global.addEventListener('keyup', function (e) { Input.keys[e.key.toLowerCase()] = false; });
  };

  /* 每帧计算最终输入方向（摇杆优先，键盘兜底） */
  Input.read = function (out) {
    var x = Input.vec.x, y = Input.vec.y;
    var k = Input.keys;
    var kx = (k['d'] || k['arrowright'] ? 1 : 0) - (k['a'] || k['arrowleft'] ? 1 : 0);
    var ky = (k['w'] || k['arrowup'] ? 1 : 0) - (k['s'] || k['arrowdown'] ? 1 : 0);
    if (kx || ky) {
      var l = Math.hypot(kx, ky);
      x = kx / l; y = ky / l;
    }
    var len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    out.x = x; out.y = y;
    return out;
  };

})(window);
