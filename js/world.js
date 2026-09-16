/* ============================================================
 * 场景美术：云海仙台
 * 全部程序化生成（Canvas 贴图 + 着色器），零外部资源
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var T = global.THREE;
  var U = XS.U;
  var C = XS.C;

  var World = XS.World = {};
  var animated = [];   // 需要每帧更新的对象
  /* 带 uWarm（破晓进度）的材质统一登记，每帧一次性写入。
     为什么用一个数组而不是记住「天空材质」这一个：破晓会同时影响
     天空渐变、云海扫光的颜色、以及后面可能加的远景 ——
     登记制让「新加一个受破晓影响的材质」变成一行 push，而不是又改一处更新逻辑。 */
  var warmMats = [];
  var warmNow = 0;     // 当前破晓值（缓动后的，避免开关局时硬切）

  /* ------------------------------------------------------------
   * 可复现的场景随机源（走查用）
   *
   * 场景布局（山形、云的位置、灯笼、光柱）全部由随机数生成，
   * 于是**每次加载都不一样**。这本身没错 —— 玩家每次看到的世界略有不同。
   * 但它让「改一个参数、对比两张截图」彻底失效：
   * 画面上多出来的那点东西，到底是改动带来的，还是这一把随机到了别的山形？
   * 这一轮调氛围时就被它坑了：改完参数拍两张，山的位置全变了，根本没法比。
   *
   * 做法是**在场景构建期间临时替换 Math.random**，构建完立刻还原。
   * 为什么不给 world.js 换一套自己的随机函数：world.js 里同时用了
   * Math.random 和 U.rand，而 U.rand 内部也是 Math.random ——
   * 只在 world.js 里换，U.rand 那部分仍然随机，布局照样不可复现。
   * 为什么只包住构建期：**玩法随机性必须保持真随机** ——
   * 刷怪位置、暴击、掉落要的是一个分布，那是平衡测量赖以成立的前提。
   * 被固定的只有「这个世界长什么样」。
   * ------------------------------------------------------------ */
  function withSeededRandom(seed, fn) {
    if (!seed) return fn();
    var orig = Math.random;
    var s = (seed >>> 0) || 1;
    Math.random = function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
    try { return fn(); } finally { Math.random = orig; }
  }

  /* 每个构建单元用**各自派生**的种子，而不是共享一条随机序列。
     为什么必须这样：共享一条序列时，任何「跳过某个构建单元」的开关
     都会把后面的随机数整体错位 —— 于是 ?noatm=1（本意是关掉氛围层做对照）
     顺手把山形、云的位置、灯笼全改了，对照图根本没法比。
     **隔离开关不许扰动被测对象**，这是这一轮踩到的第二个同类坑
     （第一个是「测量开关必须单一职责」）。派生种子之后，
     关掉任何一层都只影响那一层。 */
  function hashKey(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  var sceneSeedNow = 0;
  function buildPart(key, fn) {
    if (!sceneSeedNow) return fn();
    return withSeededRandom((sceneSeedNow ^ hashKey(key)) >>> 0, fn);
  }

  /* ============================================================
   * Canvas 贴图工厂
   * ============================================================ */

  /* 柔和光斑（粒子 / 光晕通用） */
  function glowTexture(size, inner, outer) {
    size = size || 128;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0.0, inner || 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.42)');
    grd.addColorStop(1.0, outer || 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    var t = new T.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* 云絮 */
  function cloudTexture(size) {
    size = size || 512;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, size, size);
    for (var i = 0; i < 130; i++) {
      var x = Math.random() * size;
      var y = Math.random() * size;
      var r = U.rand(size * 0.03, size * 0.17);
      var a = U.rand(0.06, 0.30);
      var grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(214,244,255,' + a.toFixed(3) + ')');
      grd.addColorStop(0.5, 'rgba(150,215,240,' + (a * 0.45).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(90,170,210,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    /* 边缘淡出，避免贴图接缝 */
    g.globalCompositeOperation = 'destination-in';
    var edge = g.createRadialGradient(size / 2, size / 2, size * 0.12, size / 2, size / 2, size * 0.5);
    edge.addColorStop(0, 'rgba(255,255,255,1)');
    edge.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = edge;
    g.fillRect(0, 0, size, size);
    var t = new T.CanvasTexture(cv);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  /* 云海上的月光拉长光带 */
  function streakTexture(w, h) {
    w = w || 128; h = h || 512;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    for (var i = 0; i < 120; i++) {
      var t = Math.random();
      var y = t * h;
      var halfW = (0.06 + Math.random() * 0.30) * w * (0.35 + 0.65 * Math.sin(t * Math.PI));
      var a = (1 - t) * 0.20 * (0.4 + Math.random() * 0.6);
      var x = w / 2 + (Math.random() - 0.5) * w * 0.42;
      var grd = g.createLinearGradient(x - halfW, y, x + halfW, y);
      grd.addColorStop(0, 'rgba(200,238,255,0)');
      grd.addColorStop(0.5, 'rgba(220,245,255,' + a.toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(200,238,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - halfW, y, halfW * 2, Math.max(1, h / 220));
    }
    /* 纵向淡出 */
    g.globalCompositeOperation = 'destination-in';
    var vg = g.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0, 'rgba(255,255,255,1)');
    vg.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    vg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
    var t2 = new T.CanvasTexture(cv);
    t2.needsUpdate = true;
    return t2;
  }

  /* 明月 */
  function moonTexture(size) {
    size = size || 256;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    var c = size / 2;
    var grd = g.createRadialGradient(c, c, size * 0.10, c, c, size * 0.5);
    grd.addColorStop(0, 'rgba(255,252,236,1)');
    grd.addColorStop(0.55, 'rgba(238,246,255,0.92)');
    grd.addColorStop(0.86, 'rgba(190,225,245,0.35)');
    grd.addColorStop(1, 'rgba(150,200,235,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(c, c, size * 0.5, 0, Math.PI * 2); g.fill();
    /* 环形山暗斑 */
    g.globalCompositeOperation = 'source-atop';
    for (var i = 0; i < 22; i++) {
      var a = Math.random() * Math.PI * 2;
      var d = Math.sqrt(Math.random()) * size * 0.30;
      var x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
      var r = U.rand(size * 0.02, size * 0.075);
      var gg = g.createRadialGradient(x, y, 0, x, y, r);
      gg.addColorStop(0, 'rgba(150,180,205,0.30)');
      gg.addColorStop(1, 'rgba(150,180,205,0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    var t = new T.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* 八卦罗盘纹样 —— 仙台地面的核心视觉 */
  function baguaTexture(size) {
    size = size || 1024;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    var c = size / 2;
    var R = size / 2;              // 归一化单位

    g.clearRect(0, 0, size, size);
    g.lineCap = 'butt';

    function stroke(color, w, alpha) {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.globalAlpha = alpha === undefined ? 1 : alpha;
    }

    function ring(radius, w, color, alpha) {
      stroke(color, w, alpha);
      g.beginPath(); g.arc(c, c, radius * R, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    /* --- 外圈 --- */
    ring(0.985, R * 0.006, '#ffcf6b', 0.85);
    ring(0.955, R * 0.0025, '#4de8ff', 0.45);
    ring(0.912, R * 0.014, '#4de8ff', 0.95);
    ring(0.892, R * 0.004, '#ffcf6b', 0.60);

    /* --- 24 道刻度（对应二十四节气） --- */
    g.save();
    g.translate(c, c);
    for (var i = 0; i < 24; i++) {
      var a = i * Math.PI / 12;
      var long = (i % 3 === 0);
      stroke(long ? '#ffcf6b' : '#4de8ff', R * (long ? 0.005 : 0.0028), long ? 0.85 : 0.45);
      g.beginPath();
      g.moveTo(Math.cos(a) * 0.892 * R, Math.sin(a) * 0.892 * R);
      g.lineTo(Math.cos(a) * (long ? 0.842 : 0.866) * R, Math.sin(a) * (long ? 0.842 : 0.866) * R);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();

    ring(0.842, R * 0.0035, '#4de8ff', 0.55);

    /* --- 内圈刻度 64 道 --- */
    g.save();
    g.translate(c, c);
    for (var j = 0; j < 64; j++) {
      var b = j * Math.PI / 32;
      var big = (j % 8 === 0);
      stroke('#4de8ff', R * (big ? 0.004 : 0.0016), big ? 0.7 : 0.3);
      g.beginPath();
      g.moveTo(Math.cos(b) * 0.60 * R, Math.sin(b) * 0.60 * R);
      g.lineTo(Math.cos(b) * (big ? 0.552 : 0.578) * R, Math.sin(b) * (big ? 0.552 : 0.578) * R);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();

    /* --- 八卦：先天八卦，乾起于上，顺时针 --- */
    var TRI = [
      { n: '乾', b: [1, 1, 1] }, { n: '巽', b: [0, 1, 1] },
      { n: '坎', b: [0, 1, 0] }, { n: '艮', b: [0, 0, 1] },
      { n: '坤', b: [0, 0, 0] }, { n: '震', b: [1, 0, 0] },
      { n: '离', b: [1, 0, 1] }, { n: '兑', b: [1, 1, 0] }
    ];
    g.save();
    g.translate(c, c);
    var rBase = 0.640, rStep = 0.0345, halfLen = 0.072;
    for (var k = 0; k < 8; k++) {
      var ang = -Math.PI / 2 + k * Math.PI / 4;
      g.save();
      g.rotate(ang);
      /* 卦线：k=0 为最内（初爻） */
      for (var m = 0; m < 3; m++) {
        var rx = (rBase + m * rStep) * R;
        var solid = TRI[k].b[m] === 1;
        stroke('#8fe4fa', R * 0.0135, solid ? 0.62 : 0.62);
        if (solid) {
          g.beginPath();
          g.moveTo(rx, -halfLen * R); g.lineTo(rx, halfLen * R);
          g.stroke();
        } else {
          var gap = 0.020 * R;
          g.beginPath();
          g.moveTo(rx, -halfLen * R); g.lineTo(rx, -gap);
          g.stroke();
          g.beginPath();
          g.moveTo(rx, gap); g.lineTo(rx, halfLen * R);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      g.restore();
    }
    g.restore();

    ring(0.728, R * 0.0035, '#ffcf6b', 0.55);
    ring(0.512, R * 0.004, '#4de8ff', 0.55);

    /* --- 12 地支点 --- */
    g.save();
    g.translate(c, c);
    for (var q = 0; q < 12; q++) {
      var aq = q * Math.PI / 6 - Math.PI / 2;
      var dx = Math.cos(aq) * 0.462 * R, dy = Math.sin(aq) * 0.462 * R;
      g.fillStyle = (q % 3 === 0) ? '#ffcf6b' : '#4de8ff';
      g.globalAlpha = (q % 3 === 0) ? 0.9 : 0.5;
      g.beginPath(); g.arc(dx, dy, R * (q % 3 === 0 ? 0.010 : 0.0065), 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    g.restore();

    ring(0.404, R * 0.003, '#ffcf6b', 0.5);

    /* --- 太极 --- */
    g.save();
    g.translate(c, c);
    var R2 = 0.300 * R;
    stroke('#4de8ff', R * 0.006, 0.98);
    g.beginPath(); g.arc(0, 0, R2, 0, Math.PI * 2); g.stroke();

    /* S 曲线（两个半圆） */
    stroke('#4de8ff', R * 0.0055, 0.88);
    g.beginPath();
    g.arc(0, -R2 / 2, R2 / 2, Math.PI, 0, false);
    g.stroke();
    g.beginPath();
    g.arc(0, R2 / 2, R2 / 2, 0, Math.PI, false);
    g.stroke();

    /* 阴阳眼：用细圆环而不是实心点——实心点在叠加发光后会被 bloom 糊成光斑 */
    stroke('#eaf6ff', R * 0.0042, 0.72);
    g.beginPath(); g.arc(0, -R2 / 2, R2 * 0.135, 0, Math.PI * 2); g.stroke();
    stroke('#ffcf6b', R * 0.0042, 0.72);
    g.beginPath(); g.arc(0, R2 / 2, R2 * 0.135, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;

    /* 内圈细纹 */
    stroke('#ffcf6b', R * 0.0028, 0.5);
    g.beginPath(); g.arc(0, 0, R2 * 0.72, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
    g.restore();

    var t = new T.CanvasTexture(cv);
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }

  /* 仙台石面（底衬） */
  function stoneTexture(size) {
    size = size || 512;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    g.fillStyle = '#0a1a26';
    g.fillRect(0, 0, size, size);
    /* 石纹噪声 */
    for (var i = 0; i < 2600; i++) {
      var x = Math.random() * size, y = Math.random() * size;
      var a = U.rand(0.015, 0.075);
      g.fillStyle = Math.random() > 0.5
        ? 'rgba(120,190,225,' + a.toFixed(3) + ')'
        : 'rgba(0,0,0,' + a.toFixed(3) + ')';
      var s = U.rand(1, 5);
      g.fillRect(x, y, s, s);
    }
    /* 同心石缝 */
    g.strokeStyle = 'rgba(90,170,205,0.16)';
    g.lineWidth = 2;
    for (var r = 0.12; r < 1.0; r += 0.11) {
      g.beginPath(); g.arc(size / 2, size / 2, r * size * 0.5, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = 'rgba(90,170,205,0.10)';
    g.lineWidth = 2;
    for (var k = 0; k < 32; k++) {
      var a2 = k * Math.PI / 16;
      g.beginPath();
      g.moveTo(size / 2, size / 2);
      g.lineTo(size / 2 + Math.cos(a2) * size * 0.5, size / 2 + Math.sin(a2) * size * 0.5);
      g.stroke();
    }
    var t = new T.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* ============================================================
   * 天空
   * ============================================================ */
  function buildSky(scene) {
    var mat = new T.ShaderMaterial({
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new T.Color(0x02050c) },
        uMid: { value: new T.Color(0x061829) },
        uHorizon: { value: new T.Color(0x14455e) },
        uGlow: { value: new T.Color(0x4de8ff) },
        uTime: { value: 0 },
        /* 破晓进度 0→1。
           这既是一个氛围量，也是一个**不用 HUD 的进度提示**：
           八分钟一局，天光慢慢从冷夜转成暖金，玩家会先「感觉到」快结束了，
           再看计时器去确认。好的时长提示不需要多一行 UI。 */
        uWarm: { value: 0 }
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){',
        '  vDir = normalize(position);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uZenith, uMid, uHorizon, uGlow;',
        'uniform float uTime, uWarm;',
        'varying vec3 vDir;',
        'float hash(vec3 p){',
        '  p = fract(p * 0.3183099 + vec3(0.71,0.113,0.419));',
        '  p *= 17.0;',
        '  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));',
        '}',
        /* 绕任意轴旋转（罗德里格斯公式）。
           星空要**转**才是星空 —— 一张钉死的星图看起来就是一张背景贴图。
           绕一根倾斜的轴转，比绕 Y 轴转更像真实的周日运动：
           绕 Y 轴是「地球自转轴正对天顶」的理想情况，真实观星不是那样。 */
        'vec3 rotAxis(vec3 v, vec3 a, float ang){',
        '  return v * cos(ang) + cross(a, v) * sin(ang) + a * dot(a, v) * (1.0 - cos(ang));',
        '}',
        'void main(){',
        '  vec3 d = normalize(vDir);',
        '  float h = d.y;',
        // 星空整片缓慢旋转（含银河带 —— 它们是同一个天球）
        '  vec3 saxis = normalize(vec3(0.30, 1.0, 0.14));',
        '  vec3 sd = rotAxis(d, saxis, uTime * 0.0021);',
        // 破晓调色：冷夜 -> 暖金。数值刻意只走到 0.85，不让它彻底盖掉「夜战」的身份
        '  float w = uWarm;',
        /* 方位：破晓从**明月那一侧**透出来（画面左侧偏前）。
           为什么非要带方位、不能整片均匀变暖：
           均匀变色读起来是「天空换了个颜色」，不是「天要亮了」。
           破晓的说服力来自**一个方向比别处亮** —— 眼睛先看到那团光，
           才推断出「那边有太阳要出来了」。整片一起暖，眼睛没有落点。
           数值是照镜头反推的：明月在 (-104, 8, -206)，方位角即 (-0.45, -0.89)；
           方位只取 xz 分量，高度不参与 —— 因为破晓在**地平线**上，
           而不是在天顶某个高度。 */
        '  vec2 hz = d.xz;',
        '  float hl = length(hz);',
        '  float az = hl > 1e-4 ? (dot(hz / hl, vec2(-0.451, -0.893)) * 0.5 + 0.5) : 0.5;',
        '  float azlobe = pow(az, 2.4);',
        /* 破晓走**两段**插值，不是一段。
           病因：从青夜 (0.08,0.27,0.37) 直接线性插到暖金 (0.52,0.32,0.15)，
           R 一路升、B 一路降，两者在中点必然交叉 ——
           于是「天光走到一半」的那几分钟里，整片天空是一坨中性灰。
           而灰色读起来是雾霾，不是黎明。（成图上非常明显：
           03:00 的那张头图天空发灰，像阴天。）
           真实黎明是先经过一段饱和的靛紫暮色再转金的，所以：
           夜青 --(k1: 0~0.30)--> 靛紫暮色 --(k2: 0.30~0.85)--> 暖金。
           两段的区间是**按 w 的实际取值范围反推的**：w 最高只到 0.85
           （runProgress^1.5 * 0.85），所以 k2 的右端必须落在 0.85 上，
           否则「暖金」永远只走到一部分，局末的天光不够暖。
           灵光带同理，中点走玫红 —— 那正是「朝霞」。
           教训：**两个互补色之间不要直连**，中间必须给一个饱和的过渡色，
           否则中点一定是灰的。这条对任何「夜/昼」或「冷暖」过渡都成立。 */
        '  float k1 = smoothstep(0.0, 0.30, w * (0.30 + 0.70 * azlobe));',
        '  float k2 = smoothstep(0.30, 0.85, w * (0.30 + 0.70 * azlobe));',
        '  vec3 zen = mix(mix(uZenith,  vec3(0.075, 0.055, 0.150), k1), vec3(0.050, 0.042, 0.100), k2);',
        '  vec3 mid = mix(mix(uMid,     vec3(0.145, 0.085, 0.215), k1), vec3(0.220, 0.130, 0.170), k2);',
        /* 地平线是这一段里**唯一真正可见**的颜色。
           本作镜头俯角 32°、半 FOV 22°，画面顶边朝下 10°，
           于是屏幕里那片「天空」实际采样的是 h ∈ [-0.75, -0.07]（见 ?atmo 探针），
           smoothstep(-0.12, 0.20, h) 在这段里几乎是 0 ——
           也就是说 uMid / uZenith 根本不在画面里。
           第一版把暖色调在 uMid/uZenith 上，warm 都到 0.75 了天空还是冷的，
           原因就在这里：**调错了那一段渐变**。 */
        '  vec3 hor = mix(mix(uHorizon, vec3(0.180, 0.105, 0.290), k1), vec3(0.520, 0.320, 0.150), k2);',
        '  vec3 glw = mix(mix(uGlow,    vec3(0.780, 0.430, 0.520), k1), vec3(1.000, 0.680, 0.300), k2);',
        // 三段渐变：地平线 -> 中天 -> 天顶
        '  float t1 = smoothstep(-0.12, 0.20, h);',
        '  float t2 = smoothstep(0.16, 0.72, h);',
        '  vec3 col = mix(hor, mid, t1);',
        '  col = mix(col, zen, t2);',
        /* 地平线灵光带。破晓时同时**变亮 + 变宽**：
           只提亮会让它更像一条发光的线，加宽才像「光从地平线漫上来」。
           落点也按方位分：朝向破晓那一侧给满，背面只留 0.10 ——
           背面完全不给的话，转身会看到一条突兀的硬边。
           强度改过一次：第一版正面给到 0.96，配上暖色底色直接冲顶，
           整片天空糊成奶油白（warm=1 的对照图一眼可见）。
           这里的天花板不是「好不好看」而是**别把画面顶爆** ——
           底色 + 加色两条路径会相加，调其中一条时必须按两条之和来估。 */
        '  float band = exp(-abs(h + 0.02) * (9.0 - w * 3.5));',
        '  col += glw * band * (0.16 + w * (0.10 + 0.30 * azlobe));',
        /* 星点（仅天顶区域，闪烁）。用旋转后的 sd 采样，星星才会跟着天球走 */
        '  vec3 q = floor(sd * 240.0);',
        '  float s = hash(q);',
        '  float star = smoothstep(0.9955, 0.9995, s);',
        '  float tw = 0.62 + 0.38 * sin(uTime * 1.7 + s * 90.0);',
        /* 星星按破晓进度淡出。这一条是必须的：
           天都亮了还挂着一片星，比没有星空更假。 */
        /* 淡入的门限原本是 smoothstep(0.06, 0.55, h) —— 那是**按「天顶」写的**，
           而本作俯视机位下画面里的天空只到 h=-0.07（见 ?atmo 探针的 skyTopH）。
           结果就是「星空缓慢旋转」这个功能做了、也在转，但玩家一颗星都看不见。
           门限必须按**实际可见的高度**来定，不能按「天空应该长什么样」来定。 */
        '  col += vec3(0.78, 0.90, 1.0) * star * tw * smoothstep(-0.42, 0.10, h) * (1.0 - w * 0.82);',
        /* 银河般的淡带（跟着天球转）。中心同样下移到可见段，
           否则整条带子都挂在画面外 —— 和星星是同一个错误。 */
        '  float milky = exp(-pow((sd.y - 0.24) * 2.6, 2.0));',
        '  float mn = hash(floor(sd * 60.0));',
        '  col += vec3(0.16, 0.24, 0.42) * milky * (0.35 + mn * 0.65) * 0.35 * (1.0 - w * 0.6);',
        '  col *= 1.0 + w * 0.22;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    var sky = new T.Mesh(new T.SphereGeometry(190, 32, 24), mat);
    sky.frustumCulled = false;
    scene.add(sky);
    animated.push(function (dt, t) { mat.uniforms.uTime.value = t; });
    warmMats.push(mat);
    return sky;
  }

  /* ============================================================
   * 明月
   * ============================================================ */
function buildMoon(scene) {
    var grp = new T.Group();
    /* 明月挂在云海尽头的地平线附近（本作镜头俯视，月亮靠云海倒影来交代） */
    grp.position.set(-104, 8, -206);

    var moonTex = moonTexture(256);
    var disc = new T.Mesh(
      new T.PlaneGeometry(30, 30),
      new T.MeshBasicMaterial({
        map: moonTex, transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, fog: false, opacity: 0.9
      })
    );
    grp.add(disc);

    var halo = new T.Mesh(
      new T.PlaneGeometry(96, 96),
      new T.MeshBasicMaterial({
        map: glowTexture(128, 'rgba(160,215,255,0.50)', 'rgba(90,150,210,0)'),
        transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, fog: false, opacity: 0.7
      })
    );
    halo.position.z = -1;
    grp.add(halo);

    var halo2 = new T.Mesh(
      new T.PlaneGeometry(200, 200),
      new T.MeshBasicMaterial({
        map: glowTexture(128, 'rgba(80,150,220,0.26)', 'rgba(40,90,160,0)'),
        transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, fog: false, opacity: 0.55
      })
    );
    halo2.position.z = -2;
    grp.add(halo2);

    grp.lookAt(0, 14, 0);
    scene.add(grp);
    animated.push(function (dt, t) {
      halo.scale.setScalar(1 + Math.sin(t * 0.5) * 0.035);
      disc.material.opacity = 0.82 + Math.sin(t * 0.9) * 0.08;
    });
    return grp;
  }
  /* 体积光柱：上亮下淡、左右柔化，内部有细密的纵向明暗变化 */
  function shaftTexture(w, h) {
    w = w || 128; h = h || 512;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    /* 为什么要有内部的细柱：一根均匀的横向渐变条看起来是「一块玻璃」。
       几道宽度、亮度、位置都不同的细柱叠在一起，才读成「光穿过尘埃」。 */
    for (var i = 0; i < 9; i++) {
      var cx = w * (0.16 + Math.random() * 0.68);
      var hw = w * (0.030 + Math.random() * 0.13);
      var a = 0.10 + Math.random() * 0.26;
      var grd = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
      grd.addColorStop(0, 'rgba(190,225,255,0)');
      grd.addColorStop(0.5, 'rgba(228,244,255,' + a.toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(190,225,255,0)');
      g.fillStyle = grd;
      g.fillRect(cx - hw, 0, hw * 2, h);
    }
    /* 纵向：顶部最亮，往下渐隐 —— 光是从上方斜射下来的 */
    g.globalCompositeOperation = 'destination-in';
    var vg = g.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0, 'rgba(255,255,255,1)');
    vg.addColorStop(0.30, 'rgba(255,255,255,0.72)');
    vg.addColorStop(0.72, 'rgba(255,255,255,0.22)');
    vg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
    var t2 = new T.CanvasTexture(cv);
    t2.needsUpdate = true;
    return t2;
  }

  /* ============================================================
   * 体积光：月光穿过云层的斜射光柱
   *
   * 做法是**假的** —— 几片朝相机的加色平面，不是真的体积散射。
   * 为什么不做真的：真体积光要嘛上后处理（一张全屏 RT + 若干次模糊），
   * 要嘛 raymarching，两者在千元安卓上都不划算。而这场戏的机位是固定的，
   * 假光柱在这个机位下和真的看不出区别。
   * **先问「玩家看不看得出来」，再决定要不要为它付性能。**
   *
   * 三条硬约束：
   *  1) 必须放在仙台之外（z 很靠后）。光柱盖在战斗区上会把妖魔的剪影糊掉，
   *     而「看清妖魔」是这款游戏的立身之本 —— 氛围永远不许抢可读性。
   *  2) 每根光柱的宽度、亮度、相位都不同。等宽等亮的并排光柱读起来像栅栏。
   *  3) 单根亮度可以给得不低（0.18~0.40）。这一条是**改过一次的**：
   *     第一版按「加色会累加，所以单根要很淡」的直觉给了 0.05~0.12，
   *     结果九根叠成一片均匀的雾、又完全不像是光柱。
   *     用 ?rays=8 把单根开到夸张之后才看清：**糊是因为九根重叠，
   *     不是因为单根太亮** —— 拉开间距、减到五根之后，
   *     单根给到 0.3 反而每一根都清清楚楚，天空也没被洗白。
   *     教训：加色层出问题，先怀疑**重叠**，再怀疑亮度。
   * ============================================================ */
  function buildGodRays(scene) {
    var grp = new T.Group();
    var tex = shaftTexture(128, 512);
    /* 五根，不是九根 —— 这是量出来的。
       第一版放了九根、宽 18~52、单根 0.05~0.12，结果整片天空被洗成亮蓝灰，
       山脉从深蓝剪影变成灰白（用 ?noatm=1 对照确认的）。
       加色是**累加**的：单根看着都很淡，九根叠在同一片天空上就糊成均匀的雾，
       而「均匀的雾」既不像光柱、又把星星和远山全吃掉。
       根数少、间距大于宽度、单根压暗，才会读成「一根一根的光柱」。 */
    var N = 5;
    for (var i = 0; i < N; i++) {
      var m = new T.Mesh(
        new T.PlaneGeometry(U.rand(12, 30), U.rand(120, 190)),
        new T.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false,
          blending: T.AdditiveBlending, fog: false, side: T.DoubleSide,
          color: 0xcfe6ff, opacity: U.rand(0.18, 0.40) * World._rayMul
        })
      );
      /* 位置是照相机视锥反推的，不是随手填的：
         镜头俯角约 32°、竖直 FOV 44°，所以「画面顶部」对应的是**远处且低**的位置。
         一开始按直觉把光柱摆在 y=+20 附近，整排都在画面之外 ——
         俯视机位下，抬高反而会跑出屏幕。
         x 间距 45 大于最大宽度 30，保证不重叠。 */
      var x = -90 + i * 45 + U.rand(-8, 8);
      var z = U.rand(-140, -82);
      var y = U.rand(-46, -14);
      m.position.set(x, y, z);
      /* 各自歪一点 —— 一排角度完全一致的板子会露出「它们是板子」 */
      m.rotation.z = U.rand(-0.24, 0.24);
      m.rotation.y = U.rand(-0.18, 0.18);
      grp.add(m);
      (function (mm, baseOp, ph, baseY) {
        animated.push(function (dt, t) {
          /* 呼吸 + 极缓慢的上下浮动。
             光柱完全静止就露馅成贴图；动起来（哪怕只动一点点）就活了。 */
          mm.material.opacity = baseOp * (0.72 + 0.28 * Math.sin(t * 0.23 + ph));
          mm.position.y = baseY + Math.sin(t * 0.11 + ph * 1.7) * 2.6;
        });
      })(m, m.material.opacity, Math.random() * 6.28, y);
    }
    scene.add(grp);
    return grp;
  }

  /* ============================================================
   * 云海
   * ============================================================ */
function buildCloudSea(scene, noSweep) {
    var tex = cloudTexture(512);
    /* 层次越深越暗越淡，形成「云海」的体积感。
       不透明度是**量过之后调的**：第一版按「云要淡、别抢戏」给了 0.10~0.26，
       结果整片云海在成图上只剩一层看不见的灰雾 —— 因为云是半透明叠加，
       暗天空底上 0.26 的浅蓝约等于没有。
       量法：?cloud=N 把各层乘 N 看哪一档读得出「云」。
       结论是可见带那两层要 ~2 倍，深处的几层本来就藏在仙台后面、不用动 ——
       所以是逐层给值，不是整体乘一个系数（整体乘会把看不见的层一起提亮，
       白白增加画面里的雾感）。 */
    var layers = [
      { y: -5.0,  size: 250, op: 0.52, spd: 0.0052, tint: 0x7fc0e0, rep: 1.3 },
      { y: -11.0, size: 310, op: 0.40, spd: -0.0038, tint: 0x6cabd0, rep: 1.7 },
      { y: -18.5, size: 380, op: 0.28, spd: 0.0027, tint: 0x5a97bf, rep: 2.2 },
      { y: -27.5, size: 450, op: 0.20, spd: -0.0019, tint: 0x4a83ac, rep: 2.7 },
      { y: -39.0, size: 530, op: 0.15, spd: 0.0013, tint: 0x3d7099, rep: 3.3 },
      { y: -54.0, size: 620, op: 0.11, spd: 0.0009, tint: 0x325f86, rep: 4.0 }
    ];
    var group = new T.Group();
    var topTex = null;   // 顶层云的贴图，稍后给「扫光」复用
    layers.forEach(function (L, idx) {
      var t2 = tex.clone();
      t2.needsUpdate = true;
      t2.wrapS = t2.wrapT = T.RepeatWrapping;
      t2.repeat.set(L.rep, L.rep);
      t2.offset.set(Math.random(), Math.random());
      if (idx === 0) topTex = t2;
      var m = new T.Mesh(
        new T.PlaneGeometry(L.size, L.size),
        new T.MeshBasicMaterial({
          map: t2, transparent: true, opacity: L.op * World._cloudMul,
          depthWrite: false, side: T.DoubleSide, fog: true,
          color: L.tint
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = L.y;
      group.add(m);
      animated.push(function (dt) {
        t2.offset.x += L.spd * dt;
        t2.offset.y += L.spd * 0.42 * dt;
      });
    });

    /* ---- 云海高光扫过 ----
       一条缓慢横扫的亮带，**复用顶层云的贴图对象**，所以它和云面永远同相 ——
       亮带落在云上、云缝里就暗，看起来才像月光扫过云海，
       而不是「一张发光的贴图在云上平移」。
       这是复用同一个 Texture 实例的额外好处：UV 的 offset 是共享的，
       不需要每帧手动同步两个物体（手动同步一定会漂）。 */
    if (topTex && !noSweep) {
      var sweepMat = new T.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        blending: T.AdditiveBlending, side: T.DoubleSide,
        uniforms: {
          uMap: { value: topTex },
          uTime: { value: 0 },
          uWarm: { value: 0 },
          uSweep: { value: World._sweepMul }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){',
          '  vUv = uv;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform sampler2D uMap;',
          'uniform float uTime, uWarm, uSweep;',
          'varying vec2 vUv;',
          'void main(){',
          '  float a = texture2D(uMap, vUv).a;',
          /* 亮带沿对角线扫，斜着扫比横着扫更像光而不是扫描线。
             扫过的**范围是反推出来的**，不是随手填的：
             平面绕 X 转 -90° 之后，局部 v 映射到世界 z = (0.5 - v) * 250，
             而画面里能看到的那段云海在 z ∈ [-125, -57]，
             也就是 v ∈ [0.73, 1.0]。
             第一版的带心是 pos*0.55-0.18，pos∈[0,1) 时最多到 0.37 ——
             **永远进不了可见区**。于是「云海高光扫过」做完了、也在动，
             但玩家一次都看不到：用 ?sweep=12 放大十二倍仍然一片空白。
             教训和星空淡入门限完全一样：**几何参数必须按实际可见范围反推，
             不能按「这东西应该在哪」想当然。** */
          '  float pos = fract(uTime * 0.035);',
          '  vec2 c = vUv - vec2(pos * 1.4 - 0.20, pos * 0.30 + 0.72);',
          /* 亮带要窄、要淡。整片云海整体提亮读起来是「云变亮了」而不是「有光扫过」——
             扫光的说服力来自**对比**（亮的带 + 两侧保持原样），不是来自亮度。
             强度和宽度都是量出来的，而且**改过两次方向相反**：
             旧版 0.10 看着「太淡」，是因为 v 范围算错、亮带根本进不了画面；
             修好几何之后照原样给 0.30，用 ?sweep=0/1 严格 A/B 一量，
             云海带的平均像素差到了 79.8 —— 那不是一道光，是整条带被洗亮。
             现在收到 0.20 并把衰减系数从 60 提到 150（带更窄），
             让差异集中在一条带子上而不是铺满整片云海。 */
          '  float band = exp(-dot(c, c) * 150.0);',
          '  vec3 col = mix(vec3(0.62,0.80,1.0), vec3(1.0,0.80,0.52), uWarm);',
          '  gl_FragColor = vec4(col, a * band * 0.20 * uSweep);',
          '}'
        ].join('\n')
      });
      var sweep = new T.Mesh(new T.PlaneGeometry(250, 250), sweepMat);
      sweep.rotation.x = -Math.PI / 2;
      sweep.position.y = -4.6;   // 紧贴顶层云之上
      group.add(sweep);
      animated.push(function (dt, t) { sweepMat.uniforms.uTime.value = t; });
      warmMats.push(sweepMat);
    }

    /* ---- 月光在云海上的倒影 ---- */
    var refl = new T.Mesh(
      new T.PlaneGeometry(120, 120),
      new T.MeshBasicMaterial({
        map: glowTexture(128, 'rgba(186,228,255,0.70)', 'rgba(90,150,210,0)'),
        transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, opacity: 0.40, fog: false
      })
    );
    refl.rotation.x = -Math.PI / 2;
    refl.position.set(-62, -4.2, -104);
    group.add(refl);

    var reflCore = new T.Mesh(
      new T.PlaneGeometry(40, 40),
      new T.MeshBasicMaterial({
        map: glowTexture(128, 'rgba(255,255,255,0.95)', 'rgba(190,235,255,0)'),
        transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, opacity: 0.55, fog: false
      })
    );
    reflCore.rotation.x = -Math.PI / 2;
    reflCore.position.set(-62, -4.0, -104);
    group.add(reflCore);

    /* 拉长的月光带 */
    var streak = new T.Mesh(
      new T.PlaneGeometry(56, 220),
      new T.MeshBasicMaterial({
        map: streakTexture(128, 512), transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, opacity: 0.34, color: 0xbfe6ff, fog: false
      })
    );
    streak.rotation.x = -Math.PI / 2;
    streak.rotation.z = 0.30;
    streak.position.set(-38, -3.8, -62);
    group.add(streak);

    animated.push(function (dt, t) {
      refl.material.opacity = 0.34 + Math.sin(t * 0.42) * 0.07;
      reflCore.material.opacity = 0.48 + Math.sin(t * 0.66 + 1.1) * 0.10;
      streak.material.opacity = 0.28 + Math.sin(t * 0.55 + 0.6) * 0.07;
    });

    /* 仙台四周的云环，制造「浮于云海之上」 */
    var ringTex = cloudTexture(512);
    for (var i = 0; i < 16; i++) {
      var a = (i / 16) * Math.PI * 2 + Math.random() * 0.2;
      var rr = U.rand(40, 58);
      var puff = new T.Mesh(
        new T.PlaneGeometry(U.rand(34, 60), U.rand(26, 44)),
        new T.MeshBasicMaterial({
          map: ringTex, transparent: true, opacity: U.rand(0.16, 0.30),
          depthWrite: false, side: T.DoubleSide, color: 0x9ed2ec
        })
      );
      puff.position.set(Math.cos(a) * rr, U.rand(-6.0, -1.5), Math.sin(a) * rr);
      puff.rotation.x = -Math.PI / 2 + U.rand(-0.12, 0.12);
      puff.rotation.z = Math.random() * Math.PI;
      group.add(puff);
      (function (p, base, ph) {
        animated.push(function (dt, t) {
          p.position.y = base + Math.sin(t * 0.32 + ph) * 0.6;
          p.rotation.z += dt * 0.012;
        });
      })(puff, puff.position.y, Math.random() * 6.28);
    }

    scene.add(group);
    return group;
  }
  /* ============================================================
   * 仙台
   * ============================================================ */
  function buildPlatform(scene) {
    var group = new T.Group();
    var R = XS.ARENA.radius;

    /* 石面 */
    var stoneTex = stoneTexture(512);
    stoneTex.wrapS = stoneTex.wrapT = T.RepeatWrapping;
    stoneTex.repeat.set(3, 3);
    var base = new T.Mesh(
      new T.CircleGeometry(R, 96),
      new T.MeshStandardMaterial({
        map: stoneTex, color: 0x46545f,
        roughness: 0.92, metalness: 0.10
      })
    );
    base.rotation.x = -Math.PI / 2;
    base.receiveShadow = false;
    group.add(base);

    /* 八卦罗盘（叠加发光层） */
    var baguaTex = baguaTexture(1024);
    var compass = new T.Mesh(
      new T.CircleGeometry(R * 0.995, 96),
      new T.MeshBasicMaterial({
        map: baguaTex, transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, opacity: 0.28
      })
    );
    compass.rotation.x = -Math.PI / 2;
    compass.position.y = 0.012;
    group.add(compass);

    /* 缓慢反向旋转的内圈：营造法阵运转感 */
    var innerTex = baguaTexture(1024);
    var inner = new T.Mesh(
      new T.CircleGeometry(R * 0.52, 64),
      new T.MeshBasicMaterial({
        map: innerTex, transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, opacity: 0.13
      })
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.024;
    group.add(inner);

    animated.push(function (dt, t) {
      compass.rotation.z -= dt * 0.017;
      inner.rotation.z += dt * 0.031;
      compass.material.opacity = 0.25 + Math.sin(t * 1.1) * 0.05;
    });

    /* 台体侧壁 */
    var side = new T.Mesh(
      new T.CylinderGeometry(R, R * 0.90, 3.2, 96, 1, true),
      new T.MeshStandardMaterial({
        color: 0x0a1b28, roughness: 0.94, metalness: 0.08,
        side: T.DoubleSide
      })
    );
    side.position.y = -1.6;
    group.add(side);

    /* 底部岩体 */
    var under = new T.Mesh(
      new T.ConeGeometry(R * 0.90, 30, 12, 4),
      new T.MeshStandardMaterial({ color: 0x081420, roughness: 1.0, metalness: 0.0, flatShading: true })
    );
    under.rotation.x = Math.PI;
    under.position.y = -18.2;
    group.add(under);

    /* 边缘光环 */
    var rim = new T.Mesh(
      new T.TorusGeometry(R, 0.14, 8, 160),
      new T.MeshBasicMaterial({ color: C.jade, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.07;
    group.add(rim);

    var rim2 = new T.Mesh(
      new T.TorusGeometry(R + 0.55, 0.075, 6, 160),
      new T.MeshBasicMaterial({ color: C.gold, transparent: true, opacity: 0.78, blending: T.AdditiveBlending, depthWrite: false })
    );
    rim2.rotation.x = -Math.PI / 2;
    rim2.position.y = 0.04;
    group.add(rim2);

    animated.push(function (dt, t) {
      rim.material.opacity = 0.68 + Math.sin(t * 2.1) * 0.17;
      rim2.material.opacity = 0.64 + Math.sin(t * 1.4 + 1.6) * 0.14;
    });

    /* 八方玉柱 */
    var pillarGeo = new T.CylinderGeometry(0.42, 0.55, 2.6, 6);
    var pillarMat = new T.MeshStandardMaterial({
      color: 0x123040, roughness: 0.55, metalness: 0.35,
      emissive: new T.Color(C.jade), emissiveIntensity: 0.18
    });
    var orbGeo = new T.SphereGeometry(0.34, 12, 10);
    var orbMat = new T.MeshBasicMaterial({ color: C.jade, transparent: true, opacity: 0.92, blending: T.AdditiveBlending, depthWrite: false });
    var orbGlowGeo = new T.PlaneGeometry(3.2, 3.2);
    var orbGlowMat = new T.MeshBasicMaterial({
      map: glowTexture(128, 'rgba(120,235,255,0.85)', 'rgba(60,180,230,0)'),
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });

    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4 + Math.PI / 8;
      var px = Math.cos(a) * (R - 1.9);
      var pz = Math.sin(a) * (R - 1.9);
      var p = new T.Mesh(pillarGeo, pillarMat);
      p.position.set(px, 1.3, pz);
      group.add(p);

      var orb = new T.Mesh(orbGeo, orbMat.clone());
      orb.position.set(px, 3.05, pz);
      group.add(orb);

      var gl = new T.Mesh(orbGlowGeo, orbGlowMat);
      gl.position.set(px, 3.05, pz);
      gl.userData.billboard = true;
      group.add(gl);

      (function (o, g2, ph) {
        animated.push(function (dt, t) {
          o.position.y = 3.05 + Math.sin(t * 1.3 + ph) * 0.22;
          g2.position.y = o.position.y;
          o.material.opacity = 0.72 + Math.sin(t * 2.6 + ph) * 0.24;
        });
      })(orb, gl, i * 0.8);
    }

    scene.add(group);

    /* 悬浮碎石（环绕仙台） */
    var debrisGeo = new T.IcosahedronGeometry(0.6, 0);
    var debrisMat = new T.MeshStandardMaterial({
      color: 0x14303f, roughness: 0.9, metalness: 0.1, flatShading: true
    });
    for (var d = 0; d < 22; d++) {
      var da = Math.random() * Math.PI * 2;
      var dr = U.rand(R + 4, R + 16);
      var m2 = new T.Mesh(debrisGeo, debrisMat);
      m2.position.set(Math.cos(da) * dr, U.rand(-7, 5), Math.sin(da) * dr);
      m2.scale.set(U.rand(0.4, 1.7), U.rand(0.4, 1.4), U.rand(0.4, 1.7));
      m2.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      scene.add(m2);
      (function (mm, base, ph, orbit, rad) {
        animated.push(function (dt, t) {
          mm.position.y = base + Math.sin(t * 0.28 + ph) * 1.1;
          mm.rotation.x += dt * 0.14;
          mm.rotation.y += dt * 0.11;
          mm.position.x = Math.cos(orbit + t * 0.012) * rad;
          mm.position.z = Math.sin(orbit + t * 0.012) * rad;
        });
      })(m2, m2.position.y, Math.random() * 6.28, da, dr);
    }

    return group;
  }

  /* ============================================================
   * 远景仙山
   * ============================================================ */
function buildMountains(scene) {
    var group = new T.Group();
    /* 仙山浮于云海之下，只露峰顶；用雾做空气透视 */
    var mat = new T.MeshStandardMaterial({
      color: 0x1b3d55, roughness: 1.0, metalness: 0.0, flatShading: true,
      emissive: new T.Color(0x0b2130), emissiveIntensity: 0.85
    });
    var capMat = new T.MeshBasicMaterial({
      color: 0x8fe4ff, transparent: true, opacity: 0.30,
      blending: T.AdditiveBlending, depthWrite: false
    });

    for (var i = 0; i < 30; i++) {
      var a = (i / 30) * Math.PI * 2 + U.rand(-0.08, 0.08);
      var dist = U.rand(115, 215);
      var h = U.rand(34, 74);
      var rad = U.rand(10, 26);
      var seg = U.randInt(4, 7);
      var peakY = U.rand(-42, -20);           // 峰顶高度
      var baseY = peakY - h;

      var cone = new T.Mesh(new T.ConeGeometry(rad, h, seg, 1), mat);
      cone.position.set(Math.cos(a) * dist, baseY + h / 2, Math.sin(a) * dist);
      cone.rotation.y = Math.random() * 3;
      group.add(cone);

      /* 山巅灵光 */
      var cap = new T.Mesh(new T.ConeGeometry(rad * 0.32, h * 0.18, seg, 1), capMat);
      cap.position.set(cone.position.x, cone.position.y + h * 0.42, cone.position.z);
      cap.rotation.y = cone.rotation.y;
      group.add(cap);
      (function (cp, ph) {
        animated.push(function (dt, t) {
          cp.material.opacity = 0.20 + Math.sin(t * 0.8 + ph) * 0.12;
        });
      })(cap, i);
    }

    /* 悬浮仙宫（远景点缀） */
    for (var k = 0; k < 6; k++) {
      var ga = U.rand(0, Math.PI * 2);
      var gd = U.rand(95, 165);
      var gh = U.rand(7, 15);
      var gy = U.rand(-30, -16);
      var g = new T.Group();
      var body = new T.Mesh(
        new T.CylinderGeometry(4.4, 5.6, gh, 6),
        new T.MeshStandardMaterial({ color: 0x1a3a52, roughness: 1.0, flatShading: true, emissive: new T.Color(0x0a1f2e), emissiveIntensity: 0.7 })
      );
      body.position.y = gh / 2;
      g.add(body);
      var roof = new T.Mesh(
        new T.ConeGeometry(8.4, 4.0, 6),
        new T.MeshStandardMaterial({ color: 0x20465f, roughness: 1.0, flatShading: true })
      );
      roof.position.y = gh + 2.2;
      g.add(roof);
      var roofGlow = new T.Mesh(
        new T.ConeGeometry(8.6, 4.2, 6),
        new T.MeshBasicMaterial({ color: C.goldDeep, transparent: true, opacity: 0.10, blending: T.AdditiveBlending, depthWrite: false })
      );
      roofGlow.position.y = gh + 2.2;
      g.add(roofGlow);
      g.position.set(Math.cos(ga) * gd, gy, Math.sin(ga) * gd);
      g.scale.setScalar(U.rand(0.42, 0.80));
      group.add(g);
      (function (gg, base, ph) {
        animated.push(function (dt, t) {
          gg.position.y = base + Math.sin(t * 0.22 + ph) * 1.6;
        });
      })(g, gy, Math.random() * 6.28);
    }

    scene.add(group);
    return group;
  }
  /* ============================================================
   * 灵光粒子
   * ============================================================ */
  function buildSpiritLights(scene) {
    var N = 700;
    var pos = new Float32Array(N * 3);
    var col = new Float32Array(N * 3);
    var size = new Float32Array(N);
    var seed = new Float32Array(N);
    var cJade = new T.Color(C.jadeSoft);
    var cGold = new T.Color(C.gold);

    for (var i = 0; i < N; i++) {
      var a = Math.random() * Math.PI * 2;
      var r = Math.sqrt(Math.random()) * 70;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = U.rand(-14, 26);
      pos[i * 3 + 2] = Math.sin(a) * r;

      var g = Math.random();
      var c = g > 0.7 ? cGold : cJade;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      size[i] = U.rand(0.10, 0.42);
      seed[i] = Math.random() * 100;
    }

    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new T.BufferAttribute(seed, 1));

    var mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: T.AdditiveBlending,
      uniforms: {
        uTex: { value: glowTexture(64, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)') },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 }
      },
      vertexShader: [
        'attribute float aSize;',
        'attribute float aSeed;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main(){',
        '  vColor = color;',
        '  vec3 p = position;',
        '  float s = aSeed;',
        // 缓慢上浮 + 横向漂移，到顶后循环
        '  p.y = mod(p.y + uTime * (0.42 + fract(s) * 0.75) + 14.0, 42.0) - 14.0;',
        '  p.x += sin(uTime * 0.35 + s) * 1.6;',
        '  p.z += cos(uTime * 0.29 + s * 1.7) * 1.6;',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  float tw = 0.45 + 0.55 * sin(uTime * 1.6 + s * 3.1);',
        '  vAlpha = tw;',
        '  gl_PointSize = aSize * 220.0 * uPixelRatio / max(-mv.z, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uTex;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main(){',
        '  vec4 t = texture2D(uTex, gl_PointCoord);',
        '  gl_FragColor = vec4(vColor, 1.0) * t.a * vAlpha * 0.85;',
        '}'
      ].join('\n')
    });
    mat.vertexColors = true;

    var pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    animated.push(function (dt, t) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uPixelRatio.value = XS.Core.basePR * XS.Core.prScale;
    });
    return pts;
  }

  /* ============================================================
   * 环境光
   * ============================================================ */
  function buildLights(scene) {
    /* ------------------------------------------------------------
     * 三点布光
     *
     * 之前只有一盏冷色平行光，结果整个平台糊成一片蓝，
     * 物体之间没有明暗交界，看起来像贴图而不是「有体积的石头」。
     * 标准解法是三点：
     *   主光（冷月）定形 → 补光（暖金）托暗部 → 轮廓光勾边
     * 冷暖对比一出来，画面的「贵」感就立刻不一样。
     *
     * 注意：three.js 的漫反射 BRDF 里带一个 1/PI 归一化，
     * 所以 intensity=1 的白光打在纯白表面上只能得到 0.32 的亮度。
     * 早期版本按「1.0 就是满亮」来配光，结果整个场景欠曝三倍，
     * 妖魔直接糊成纯黑剪影。这里的数值都是乘过 ~3 的。
     *
     * ---- 后来又回调了一次（LIGHT_SCALE）----
     * 乘 3 之后是能看见了，但四盏灯叠加的总漫反射已经到了
     * 「Σintensity / π ≈ 2.8 × 材质色」，中调材质直接被推爆成白。
     * 之所以一直没发现，是因为实例染色那时有个缓冲区 bug
     * （见 entities.js 的 ensureInstanceColor），妖魔身体被乘成 0 渲染成黑，
     * 于是「黑底 + 亮角」看起来反而挺对 —— 其实是 bug 撑着的假象。
     * 把那个 bug 修掉之后，真实的材质亮度才暴露出来：全白。
     *
     * 现在用一个显式的曝光系数统一收，方便一眼看出整体亮度是多少。
     * 目标是「Σintensity / π ≈ 1.4」，中调材质落在 0.5 左右，
     * 妖魔读作「暗部厚重、亮部有光」，而不是一片白。
     * ------------------------------------------------------------ */
    var LS = 0.55;
    var amb = new T.HemisphereLight(0x4a7d9c, 0x0c1620, 2.05 * LS);
    scene.add(amb);

    /* 主光：冷月，从左后上方压下来 */
    var key = new T.DirectionalLight(0xbcd8f0, 2.75 * LS);
    key.position.set(-74, 33, -104);
    scene.add(key);

    /* 补光：暖金，从右前下方托起暗部 */
    var fill = new T.DirectionalLight(0xffc98f, 1.95 * LS);
    fill.position.set(70, 30, 60);
    scene.add(fill);

    /* 轮廓光：正后方，把角色与妖魔从背景里「切」出来 */
    var rim = new T.DirectionalLight(0x9fd0e0, 1.95 * LS);
    rim.position.set(0, 17, -92);
    scene.add(rim);

    /* 台面中央的暖色光源：让石面有一圈暖调，避免纯蓝 */
    var warm = new T.PointLight(0xffcf6b, 3.2 * LS, 80, 2.0);
    warm.position.set(0, 9, 0);
    scene.add(warm);

    var jade = new T.PointLight(0x4de8ff, 2.30 * LS, 70, 2.0);
    jade.position.set(0, 5, 0);
    scene.add(jade);

    animated.push(function (dt, t) {
      warm.intensity = (2.95 + Math.sin(t * 0.9) * 0.60) * LS;
      jade.intensity = (2.05 + Math.sin(t * 1.4 + 1.2) * 0.42) * LS;
    });
  }

  /* ============================================================
   * 氛围层：落樱 / 孔明灯 / 仙鹤
   *
   * 静态场景再精致，没有「动的东西」就还是像一张图。
   * 这三样东西成本极低（各 1~8 个 draw call），
   * 但能让整个画面从「场景」变成「世界」。
   * ============================================================ */

  /* 花瓣贴图：一枚带渐变的椭圆花瓣 */
  function petalTexture() {
    var S = 64;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(S * 0.42, S * 0.40, 1, S * 0.5, S * 0.5, S * 0.5);
    grad.addColorStop(0, 'rgba(255,232,244,0.90)');
    grad.addColorStop(0.42, 'rgba(252,176,212,0.66)');
    grad.addColorStop(1, 'rgba(232,126,176,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(S * 0.5, S * 0.5, S * 0.44, S * 0.28, Math.PI * 0.28, 0, Math.PI * 2);
    g.fill();
    var t = new T.CanvasTexture(c);
    return t;
  }

  /* 孔明灯贴图：暖色光晕 + 灯体剪影 */
  function lanternTexture() {
    var S = 96;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(S * 0.5, S * 0.5, 1, S * 0.5, S * 0.5, S * 0.5);
    grad.addColorStop(0, 'rgba(255,226,168,0.82)');
    grad.addColorStop(0.22, 'rgba(255,178,96,0.62)');
    grad.addColorStop(0.55, 'rgba(255,140,60,0.28)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    /* 灯体：上窄下宽的灯笼轮廓 */
    g.fillStyle = 'rgba(255,214,150,0.95)';
    g.beginPath();
    g.moveTo(S * 0.42, S * 0.34);
    g.lineTo(S * 0.58, S * 0.34);
    g.lineTo(S * 0.63, S * 0.58);
    g.lineTo(S * 0.37, S * 0.58);
    g.closePath();
    g.fill();
    return new T.CanvasTexture(c);
  }

  function buildPetals(scene) {
    var N = 150;
    var pos = new Float32Array(N * 3);
    var seed = new Float32Array(N * 3);
    var R = XS.ARENA.radius * 1.9;
    for (var i = 0; i < N; i++) {
      var a = Math.random() * Math.PI * 2;
      var r = Math.sqrt(Math.random()) * R;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.random() * 30 - 4;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i * 3] = Math.random();               // 下落速度
      seed[i * 3 + 1] = Math.random();           // 尺寸
      seed[i * 3 + 2] = Math.random();           // 相位
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new T.BufferAttribute(seed, 3));

    var mat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: petalTexture() },
        uScale: { value: 880.0 },
        uFog: { value: new T.Color(0x0a2436) }
      },
      vertexShader: [
        'attribute vec3 seed;',
        'uniform float uTime;',
        'uniform float uScale;',
        'varying float vFade;',
        'varying float vSpin;',
        'void main(){',
        '  float speed = 0.55 + seed.x * 1.15;',
        '  float y = mod(position.y - uTime * speed, 32.0) - 4.0;',
        '  float sway = sin(uTime * (0.42 + seed.y * 0.5) + seed.z * 6.283) * 1.9;',
        '  float sway2 = cos(uTime * 0.31 + seed.z * 6.283) * 1.5;',
        '  vec3 p = vec3(position.x + sway, y, position.z + sway2);',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        /* 花瓣真实世界直径 0.10~0.24，按透视投影换算成像素；
           夹紧上下限，避免贴近相机时炸成整屏光斑。 */
        '  float ps = (0.10 + seed.y * 0.14) * uScale / max(-mv.z, 1.0);',
        '  gl_PointSize = clamp(ps, 1.5, 34.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  vFade = smoothstep(-4.0, 3.0, y) * smoothstep(30.0, 20.0, y);',
        '  vSpin = seed.z;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uMap;',
        'varying float vFade;',
        'varying float vSpin;',
        'void main(){',
        '  vec4 t = texture2D(uMap, gl_PointCoord);',
        '  float a = t.a * vFade * 0.72;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(t.rgb * (0.78 + vSpin * 0.24), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });

    var pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    animated.push(function (dt, t) {
      mat.uniforms.uTime.value = t;
      var r = XS.Core.renderer, cam = XS.Core.camera;
      if (r && cam) {
        var h = r.domElement.height || 720;
        var f = cam.fov * Math.PI / 180;
        mat.uniforms.uScale.value = h / (2 * Math.tan(f * 0.5));
      }
    });
    return pts;
  }

  function buildLanterns(scene) {
    var N = 14;
    var geo = new T.PlaneGeometry(0.62, 0.62);
    var mat = new T.MeshBasicMaterial({
      map: lanternTexture(), transparent: true, depthWrite: false,
      blending: T.AdditiveBlending, fog: false, side: T.DoubleSide
    });
    var mesh = new T.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    var R = XS.ARENA.radius * 3.4;
    var items = [];
    for (var i = 0; i < N; i++) {
      var a = (i / N) * Math.PI * 2 + Math.random() * 0.5;
      var r = R * (0.6 + Math.random() * 0.8);
      items.push({
        x: Math.cos(a) * r, z: Math.sin(a) * r,
        y0: -3 - Math.random() * 8,
        spd: 0.30 + Math.random() * 0.48,
        ph: Math.random() * 6.28,
        sc: 0.44 + Math.random() * 0.36,
        a: a
      });
    }
    var arr = mesh.instanceMatrix.array;
    var cam = null;
    scene.add(mesh);

    animated.push(function (dt, t) {
      cam = cam || XS.Core.camera;
      for (var i = 0; i < N; i++) {
        var o = items[i];
        var y = mod(o.y0 + t * o.spd, 40) - 3;
        var sway = Math.sin(t * 0.33 + o.ph) * 1.6;
        var sx = o.x + sway, sz = o.z + Math.cos(t * 0.27 + o.ph) * 1.3;
        /* 公告板：让灯始终正对相机 */
        var dx = cam.position.x - sx, dz = cam.position.z - sz;
        var ang = Math.atan2(dx, dz);
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var off = i * 16;
        var s = o.sc;
        arr[off] = ca * s;      arr[off + 1] = 0;   arr[off + 2] = -sa * s;  arr[off + 3] = 0;
        arr[off + 4] = 0;       arr[off + 5] = s;   arr[off + 6] = 0;        arr[off + 7] = 0;
        arr[off + 8] = sa * s;  arr[off + 9] = 0;   arr[off + 10] = ca * s;  arr[off + 11] = 0;
        arr[off + 12] = sx;     arr[off + 13] = y;  arr[off + 14] = sz;      arr[off + 15] = 1;
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    return mesh;
  }

  function mod(v, m) { return v - Math.floor(v / m) * m; }

  /* 仙鹤：远处缓慢盘旋的编队，翅膀有扑动 */
  function buildCranes(scene) {
    var grp = new T.Group();
    var bodyMat = new T.MeshBasicMaterial({ color: 0xdff0ff, fog: false, transparent: true, opacity: 0.85 });
    var birds = [];
    var N = 4;
    for (var i = 0; i < N; i++) {
      var b = new T.Group();
      var body = new T.Mesh(new T.BoxGeometry(0.34, 0.14, 1.0), bodyMat);
      b.add(body);
      var wingGeo = new T.BoxGeometry(1.5, 0.05, 0.42);
      var wl = new T.Mesh(wingGeo, bodyMat);
      wl.position.set(-0.75, 0.03, 0);
      var wr = new T.Mesh(wingGeo, bodyMat);
      wr.position.set(0.75, 0.03, 0);
      b.add(wl); b.add(wr);
      b.userData.wl = wl; b.userData.wr = wr;
      grp.add(b);
      birds.push({
        g: b, ph: i * 1.7,
        r: 46 + i * 7, y: 22 + i * 2.5,
        spd: 0.055 - i * 0.006
      });
    }
    scene.add(grp);

    animated.push(function (dt, t) {
      for (var i = 0; i < birds.length; i++) {
        var o = birds[i];
        var a = o.ph + t * o.spd;
        o.g.position.set(Math.cos(a) * o.r, o.y + Math.sin(t * 0.3 + o.ph) * 1.2, Math.sin(a) * o.r);
        /* 机头朝向切线方向 */
        o.g.rotation.y = -a + Math.PI / 2;
        var flap = Math.sin(t * 5.2 + o.ph) * 0.55;
        o.g.userData.wl.rotation.z = flap;
        o.g.userData.wr.rotation.z = -flap;
      }
    });
    return grp;
  }

  function buildAtmosphere(scene) {
    buildPetals(scene);
    buildLanterns(scene);
    buildCranes(scene);
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  World.init = function (scene) {
    animated.length = 0;
    warmMats.length = 0;
    warmNow = 0;
    /* 走查用：?noatm=1 关掉全部「加色氛围层」（体积光 / 云海扫光）。
       为什么需要它：加色层是**累加**的，一层看着都很淡，
       叠起来却会把整片天空洗白 —— 而「洗白了」和「本来就是亮的」
       在成图上一模一样。关掉再拍一张，才知道锅该谁背。 */
    var noAtm = false;
    var sceneSeed = 0;
    /* 三个「乘法手柄」一律**先落默认值再让 URL 覆盖**，
       取用处直接读 World._xxxMul，不写 `x || 1`。
       为什么：?cloud=0 想表达「把云海关掉」，而 0 是假值 ——
       无论写成 `parseFloat(v) || 1` 还是取用时 `World._cloudMul || 1`，
       「关掉」都会被悄悄改写成「不变」。对照图拍出来一模一样，
       看着像「这一层根本不影响画面」，其实是开关没生效 ——
       比没有开关更坏，因为它给出的是一个**假的阴性结论**。 */
    World._rayMul = 1;
    World._sweepMul = 1;
    World._cloudMul = 1;
    World._warmForce = null;   // 未指定时走「按对局进度缓动」，见 World.update
    var mulOf = function (re, cur) {
      var m = re.exec(location.search);
      if (!m) return cur;
      var v = parseFloat(m[1]);
      return isFinite(v) ? Math.max(0, v) : cur;
    };
    try {
      noAtm = /[?&]noatm=1/.test(location.search);
      /* 走查用：?rays=6 把光柱整体调亮 6 倍（0 = 关掉光柱）。
         定位「这根光柱到底落在画面哪儿」时，把它开到夸张是最快的办法 ——
         0.03 的不透明度在缩略图里根本看不出来，
         分不清「位置不对」和「太淡了」。找到位置再收回到正常值。 */
      World._rayMul = mulOf(/[?&]rays=([\d.]+)/, 1);
      /* 走查用：?seed=N 固定场景布局，让两张截图可比。
         不加这个参数时场景每次加载都不一样（玩家看到的是「活的世界」）。 */
      var sm = /[?&]seed=(\d+)/.exec(location.search);
      if (sm) sceneSeed = parseInt(sm[1], 10) || 0;
      /* 走查用：?warm=N 直接把破晓值钉在 N（0~1）。
         为什么必须有这个手柄：破晓是**跟着 runT 走的**，而 runT 要靠打一局才涨 ——
         机器人还会死。第一次验「终局天色」时机器人 420s 阵亡、自动重开，
         截到的是第二局开局 45 秒（runProgress 0.093），
         于是「暖色没生效」这个结论**整个是假的**。
         美术状态要能被单独钉住，不能寄生在玩法状态上。 */
      var wm = /[?&]warm=([\d.]+)/.exec(location.search);
      if (wm) World._warmForce = Math.max(0, Math.min(1, parseFloat(wm[1]) || 0));
      /* 走查用：?sweep=10 把云海扫光整体调亮 10 倍（0 = 关掉扫光）。
         和 ?rays=N 同一个套路：0.10 强度的亮带在缩略图里看不出位置，
         先开到夸张找到它在画面哪儿，再收回正常值。
         「太淡了」和「位置不对」在成图上完全同形，必须先把位置钉死。 */
      World._sweepMul = mulOf(/[?&]sweep=([\d.]+)/, 1);
      /* 走查用：?cloud=N 把云海各层的不透明度整体乘 N（0 = 关掉云海）。
         为什么云海也需要这个手柄：云海是**半透明叠加**，单层 0.10~0.26 的
         透明度压在暗天空上几乎看不出颜色 —— 而「太淡了」和「没渲染」
         在成图上一模一样。仙台外圈那片 y=-5~-54 的云海实际占了画面上方
         约 28% 的面积，但第一版做出来只剩一层看不见的灰雾，
         连它带的「云海高光扫过」都无从谈起。先量出来，再定值。 */
      World._cloudMul = mulOf(/[?&]cloud=([\d.]+)/, 1);
    } catch (e) { noAtm = false; }
    World.sceneSeed = sceneSeed;
    sceneSeedNow = sceneSeed;

    buildPart('sky', function () { buildSky(scene); });
    buildPart('moon', function () { buildMoon(scene); });
    buildPart('cloud', function () { buildCloudSea(scene, noAtm); });
    if (!noAtm) buildPart('rays', function () { buildGodRays(scene); });
    buildPart('platform', function () { buildPlatform(scene); });
    buildPart('mountains', function () { buildMountains(scene); });
    buildPart('spirit', function () { buildSpiritLights(scene); });
    buildPart('atmo', function () { buildAtmosphere(scene); });
    buildLights(scene);

    /* 相机朝向的公告板元素统一处理 */
    World.billboards = [];
    scene.traverse(function (o) {
      if (o.userData && o.userData.billboard) World.billboards.push(o);
    });
    return World;
  };

  World.update = function (dt, t) {
    for (var i = 0; i < animated.length; i++) animated[i](dt, t);

    /* ---- 破晓进度 ----
     * 只在**对局中**取进度。为什么必须判状态：
     * runT 在结算后不会被清零，如果不判，「打完一局回到主菜单」时
     * 天空会一直停在破晓色 —— 主菜单看起来像另一个时段，很出戏。
     *
     * 缓动而不是直接赋值：进对局/回菜单时会有一个硬切，
     * 天空是最显眼的一整片颜色，硬切一眼就看得出来。
     * 用指数缓动（帧率无关）让它自己滑过去，就不需要任何过渡动画。 */
    var target = 0;
    if (World._warmForce != null) {
      /* 走查钉住：直接赋值，不缓动 —— 缓动是为了「进对局/回菜单」不硬切，
         走查要的是「这一帧就是这个值」。 */
      warmNow = World._warmForce;
    } else {
      if (XS.Game && XS.Game.state && XS.Game.state() === 'playing' && XS.Game.runProgress) {
        /* 破晓不是线性推进的，用 1.5 次幂压一下前半段。
           为什么：线性时跑到一半（240s）天光已经走完 87% 的变色，
           于是整局的中段就是一片紫 —— 而这款游戏的身份是「夜战」，
           破晓只该是**最后一段**的事。压过之后夜战守得更久，
           戏剧性集中到最后三分之一，也更像真实黎明（先慢后快）。
           曲线放在这里而不是 Game.runProgress 里：runProgress 是个中性的
           进度查询，别的调用方要的是线性值，只有「天光怎么变」是这里的决定。 */
        target = Math.pow(XS.Game.runProgress(), 1.5) * 0.85;
      }
      var k = 1 - Math.exp(-0.9 * dt);
      warmNow += (target - warmNow) * k;
    }
    for (var w = 0; w < warmMats.length; w++) warmMats[w].uniforms.uWarm.value = warmNow;

    var cam = XS.Core.camera;
    if (cam) {
      for (var b = 0; b < World.billboards.length; b++) {
        World.billboards[b].quaternion.copy(cam.quaternion);
      }
    }
  };

  /* 走查用：把「破晓」的当前数值吐出来。
     为什么氛围类改动必须有这个：氛围是**看不见数值**的那一类东西，
     而「暖色没生效」和「生效了但不在可见方向」在成图上完全同形。
     这一轮就栽在这里 —— uWarm 明明是 0.75，天空却还是冷的，
     因为可见的那片天空采样的根本不是我调的那一段渐变。 */
  World.debugAtmo = function () {
    var o = {
      warm: +warmNow.toFixed(3),
      warmMats: warmMats.length,
      rayMul: World._rayMul,
      sweepMul: World._sweepMul,
      cloudMul: World._cloudMul,
      seed: World.sceneSeed || 0
    };
    if (XS.Game && XS.Game.runProgress) o.runProgress = +XS.Game.runProgress().toFixed(3);
    var cam = XS.Core.camera;
    if (cam) {
      /* 画面上下缘实际采样到的天球高度。
         天球是半径 190 的球心在原点，所以「屏幕顶边看到的是 h 多少」
         必须解一次射线与球的交点 —— 这也是为什么凭直觉调渐变会调错：
         俯视机位下，画面里的天空全是 h<0 的那一小段。 */
      var dir = new T.Vector3();
      cam.getWorldDirection(dir);
      var hitH = function (pitchDeg) {
        var a = dir.y + Math.tan(pitchDeg * Math.PI / 180);
        var d = new T.Vector3(dir.x, a, dir.z).normalize();
        var o0 = cam.position;
        var b = 2 * o0.dot(d), c2 = o0.dot(o0) - 190 * 190;
        var disc = b * b - 4 * c2;
        if (disc < 0) return null;
        var tt = (-b + Math.sqrt(disc)) / 2;
        if (tt < 0) return null;
        return +((o0.y + d.y * tt) / 190).toFixed(3);
      };
      o.skyTopH = hitH(22);
      o.skyBotH = hitH(-22);
      o.skyMidH = hitH(0);
    }
    return o;
  };

})(window);
