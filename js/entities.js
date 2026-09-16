/* ============================================================
 * 几何工厂：玩家 / 妖魔 / 飞剑 / 剑气 / 灵气 / 特效
 * 敌人使用「合并几何 + 实例化」策略，每种妖魔只占 2 个 drawcall
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var T = global.THREE;
  var C = XS.C;

  var E = XS.Ent = {};

  /* 柔和光斑贴图（与 world.js 中的实现保持一致） */
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

  /* 竖向光柱贴图：左右两侧渐隐、自下而上渐隐。
     用径向光斑当光柱，俯视时会被压成一个白色椭圆糊在身上；
     竖向渐变才能读成「一道光」。 */
  function beamTexture() {
    var W = 32, H = 128;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    var img = g.createImageData(W, H);
    for (var y = 0; y < H; y++) {
      /* 0 在顶部：越往上越淡 */
      var v = 1 - y / (H - 1);
      var vy = Math.pow(v, 1.55);
      for (var x = 0; x < W; x++) {
        var u = (x + 0.5) / W * 2 - 1;
        var vx = Math.pow(Math.max(0, 1 - Math.abs(u)), 2.1);
        var a = Math.min(1, vx * vy * 1.15);
        var i = (y * W + x) * 4;
        img.data[i] = 196; img.data[i + 1] = 238; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    var t = new T.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* 雷电场贴图：径向衰减 × 角度噪声。
   * 单纯的径向光斑铺在地上只是一个亮圆，读不出「电」；
   * 叠上几层不同频率的正弦角度噪声，才会出现放射状的电弧分叉。
   * 全部用 createImageData 逐像素算，零外部资源。 */
  function fieldTexture() {
    var S = 128;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var g = cv.getContext('2d');
    var img = g.createImageData(S, S);
    var cx = S / 2, cy = S / 2;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy;
        var r = Math.sqrt(dx * dx + dy * dy);
        var a = Math.atan2(dy, dx);
        var fall = Math.max(0, 1 - r);
        fall *= fall;
        /* 三层角度噪声叠加：低频决定分叉数量，高频决定电弧的毛刺 */
        var n = 0.5 + 0.5 * Math.sin(a * 7.0 + Math.sin(a * 3.0) * 2.1)
                          * Math.sin(a * 11.0 - 1.3)
                          * Math.sin(a * 23.0 + 0.7);
        n = Math.pow(Math.max(0, n), 1.5);
        var v = fall * (0.30 + 0.70 * n);
        var i = (y * S + x) * 4;
        img.data[i]     = Math.min(255, 150 * v + 30 * fall);
        img.data[i + 1] = Math.min(255, 235 * v + 40 * fall);
        img.data[i + 2] = Math.min(255, 255 * v + 55 * fall);
        img.data[i + 3] = Math.min(255, v * 255 * 1.5);
      }
    }
    g.putImageData(img, 0, 0);
    var t = new T.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  /* ============================================================
   * 预分配 instanceColor —— 这个坑非常隐蔽，务必看注释
   *
   * r128 的 setColorAt 是这样分配缓冲区的（minified 原文）：
   *
   *   setColorAt(t,e){
   *     null===this.instanceColor &&
   *       (this.instanceColor = new InstancedBufferAttribute(
   *          new Float32Array(3 * this.count), 3)),
   *     e.toArray(this.instanceColor.array, 3*t)
   *   }
   *
   * 注意它用的是 **this.count**，不是 instanceMatrix.count。
   * 而初始化时大家都会习惯性地先写 `mesh.count = 0`，
   * 于是第一次 setColorAt 就把缓冲区建成**长度 0** ——
   * 之后所有 setColorAt 都是越界写（TypedArray 越界写静默丢弃），
   * instanceColor 全是 0，着色器里 `vColor *= instanceColor` 把颜色乘成 0，
   * 整批实例渲染成纯黑。
   *
   * 更阴的是「上一帧的 count」这种情形：如果 setColorAt 在 `count = n`
   * 之前调用，缓冲区就是按上一帧的数量建的。数量一涨，
   * 新刷出来的那些（下标更大的）实例永远分不到颜色 —— 表现为
   * 「新刷的怪是黑的，早刷出来的正常」，极难往这个方向想。
   *
   * 所以：一律按**容量**预分配，并用白色填充。
   * 没被显式染色的实例应该是「正常颜色」而不是「黑色」。
   * ============================================================ */
  E.ensureInstanceColor = function (mesh, cap) {
    if (!mesh.instanceColor) {
      var arr = new Float32Array(cap * 3);
      for (var i = 0; i < arr.length; i++) arr[i] = 1;
      mesh.instanceColor = new T.InstancedBufferAttribute(arr, 3);
    }
    return mesh.instanceColor;
  };

  /* ============================================================
   * 状态外壳：给「中状态」的妖魔套一层发光晶体壳
   *
   * 为什么单独做一层：状态如果只靠改变妖魔自身颜色来表达
   * （比如冰缓只是偏青），在密集的割草画面里几乎看不出来 ——
   * 玩家没法一眼判断「我这一套 build 到底控住了谁」。
   * 套一层外壳，形状变了，隔着半屏也认得出。
   *
   * ★ 为什么冰与火要**两种形状**，而不是同一个壳换个颜色：
   *   旧实现里两个状态共用同一个二十面体，只有 instanceColor 不同。
   *   对色觉正常的玩家够用；但红绿色盲在男性里约占 8%，对他们来说
   *   那是「同一个形状的两种灰」—— 冰缓和灼烧根本读不出区别。
   *   而这两个状态在玩法上完全不同（一个减速、一个持续掉血），
   *   分不清就等于 build 的反馈断了一半：玩家不知道自己这套
   *   「冰+雷」到底有没有把怪控住，还是只是在烧。
   *   改成「冰 = 棱角晶体 / 火 = 向上火舌」之后，不依赖色相也能分开。
   *   顺带对所有玩家都更好认 —— 无障碍改对了是所有人都受益，
   *   这也是为什么它值得做两种几何体、多花一个 drawcall。
   *
   * 实现要点：
   * - 非索引几何体，连续 3 个顶点即一个面，给每个面一个亮度，
   *   配合 vertexColors 才看得出「切面」（纯 basic 材质是平的）；
   * - 再靠 instanceColor 上色（冰=青、炎=橙）。颜色在这里是**加成**，
   *   不是唯一的信息通道 —— 形状才是。
   * ============================================================ */

  /* 确定性伪随机（xorshift32）。
   *
   * 这个几何体的「每个面一个亮度」以前是用 Math.random() 取的。
   * 问题不在好不好看，而在于它**偷吃了全局随机序列**：
   * 项目里 ?seed=N 的可复现性依赖「谁在什么时候调了几次 Math.random」，
   * 一个几何体在初始化时吃掉几十个随机数，就会把后面所有
   * 依赖随机的东西（山体、光柱、云层）全部错位。
   * 表现是「加了一个跟场景无关的几何体，截图里的山变了」——
   * 极难往这个方向想。所以凡是「只是想要点随机感」的地方，
   * 一律用自己的一条确定性序列，不碰 Math.random。 */
  var _shadeSeed = 0x9e3779b9;
  function shadeSeq() {
    _shadeSeed ^= _shadeSeed << 13; _shadeSeed >>>= 0;
    _shadeSeed ^= _shadeSeed >>> 17;
    _shadeSeed ^= _shadeSeed << 5;  _shadeSeed >>>= 0;
    return _shadeSeed / 4294967296;
  }

  /* 给非索引几何体的每个三角面一个亮度，写进顶点色。
     亮度跨度要拉大（0.30~1.00）：跨度小的时候各面亮度接近，
     叠出来是一个「平的」色块，看不出切面；拉大之后才有棱。 */
  function faceShade(geo) {
    var pos = geo.attributes.position;
    var col = new Float32Array(pos.count * 3);
    for (var f = 0; f + 2 < pos.count; f += 3) {
      var b = 0.30 + shadeSeq() * 0.70;
      for (var k = 0; k < 3; k++) {
        col[(f + k) * 3] = b;
        col[(f + k) * 3 + 1] = b;
        col[(f + k) * 3 + 2] = b;
      }
    }
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    return geo;
  }

  /* 冰缓：二十面体。20 个面棱角分明，读作一颗冰晶。 */
  function frostShellGeo() {
    return faceShade(new T.IcosahedronGeometry(1.0, 0));
  }

  /* 灼烧：一圈向上窜的火舌 + 中间一根更高的。
   *
   * 几何取「锥体」而不是「球」：锥体在俯视机位下投影成一个尖角，
   * 侧视是一条竖线 —— 两个视角都跟二十面体（一颗圆滚滚的晶体）
   * 明显不同。这正是不靠颜色也能分辨的前提：**轮廓必须不同**。
   *
   * 倾斜量用 rx = tilt*dz、rz = -tilt*dx 推出来：
   * 锥体的局部 +Y 要朝径向外侧倒，绕 Z 转 -θ 使 +Y 偏向 +X，
   * 绕 X 转 +φ 使 +Y 偏向 +Z，所以按 (dx,dz) 分量分配即可。
   * 六个火舌的高度按 i%3 错开，读起来才像「在烧」而不是一圈栅栏。 */
  function flameShellGeo() {
    var items = [];
    var N = 6, R = 0.62, tilt = 0.34;
    for (var i = 0; i < N; i++) {
      var a = i / N * Math.PI * 2 + 0.25;
      var dx = Math.cos(a), dz = Math.sin(a);
      var h = 1.35 + (i % 3) * 0.30;
      items.push(part(
        G.cone(0.20, h, 4), 0xffffff,
        dx * R, -0.85 + h * 0.5, dz * R,
        tilt * dz, 0, -tilt * dx
      ));
    }
    items.push(part(G.cone(0.24, 1.95, 4), 0xffffff, 0, -0.85 + 1.95 * 0.5, 0));
    return faceShade(mergeGeos(items));
  }

  /* kind: 'frost'（默认）| 'burn' */
  E.makeStatusShell = function (cap, kind) {
    var geo = kind === 'burn' ? flameShellGeo() : frostShellGeo();
    var mat = new T.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      /* 0.45 是量出来的：凸壳上一条视线穿过前后两层，
         加色混合后约 0.6，套在深色妖魔身上刚好「看得清但不糊」。
         0.26 太暗（几乎看不见），0.5 以上开始把里面的妖魔吃掉。
         火舌是细长的锥体，一条视线会穿过更多层，所以稍微压一点。 */
      opacity: kind === 'burn' ? 0.40 : 0.45,
      blending: T.AdditiveBlending,
      depthWrite: false
    });
    var m = new T.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(T.DynamicDrawUsage);
    m.frustumCulled = false;
    E.ensureInstanceColor(m, cap);
    m.count = 0;
    return m;
  };

  /* ============================================================
   * 稀有度标记：妖将 / 魔尊头顶的「∨」形指示
   *
   * 为什么需要：妖将和魔尊在玩法上是「先打谁」的答案，
   * 但它们目前只靠**体积**和血条来区分 —— 在一屏几十只妖魔里，
   * 体积是个很弱的线索（远处的妖将和近处的小怪一样大）。
   * 色盲玩家尤其吃亏：他们本来就更容易在密集画面里丢失目标。
   *
   * 形状编码：妖将 = 1 个「∨」，魔尊 = 2 个「∨」叠起来。
   * 「一个还是两个」是**可数的**，不需要分辨颜色，也不需要
   * 估计大小 —— 这是比颜色和尺寸都更硬的信息通道。
   *
   * 几何建在局部 XY 平面（面朝 +Z），朝向由实例矩阵负责，
   * 这里只负责形状。两块斜板拼成一个「∨」，顶点朝下。 */
  E.markerGeo = function () {
    var items = [];
    var len = 0.50, th = 0.085, dep = 0.03, ang = 0.62;
    var hx = Math.cos(ang) * len * 0.5, hy = Math.sin(ang) * len * 0.5;
    items.push(part(G.box(len, th, dep), 0xffffff, -hx, hy, 0, 0, 0, ang));
    items.push(part(G.box(len, th, dep), 0xffffff, hx, hy, 0, 0, 0, -ang));
    return mergeGeos(items);
  };

  E.fieldTexture = fieldTexture;

  /* ============================================================
   * 几何合并（非索引化后拼接，避免额外依赖）
   * items: [{ geo, matrix, color }]
   * ============================================================ */
  function mergeGeos(items) {
    var pos = [], nor = [], col = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
      g.applyMatrix4(it.matrix);
      var p = g.attributes.position.array;
      var n = g.attributes.normal ? g.attributes.normal.array : null;
      var i;
      for (i = 0; i < p.length; i++) pos.push(p[i]);
      if (n) { for (i = 0; i < n.length; i++) nor.push(n[i]); }
      else { for (i = 0; i < p.length; i++) nor.push(0); }
      var c = new T.Color(it.color);
      var vcount = p.length / 3;
      for (i = 0; i < vcount; i++) col.push(c.r, c.g, c.b);
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  var _m = new T.Matrix4();
  var _q = new T.Quaternion();
  var _e = new T.Euler();
  var _v = new T.Vector3();
  var _s = new T.Vector3(1, 1, 1);

  function part(geo, color, px, py, pz, rx, ry, rz, sx, sy, sz) {
    _e.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_e);
    _v.set(px || 0, py || 0, pz || 0);
    _s.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    _m.compose(_v, _q, _s);
    return { geo: geo, matrix: _m.clone(), color: color };
  }

  E.mergeGeos = mergeGeos;
  E.part = part;

  /* 复用的基础几何 */
  var G = {
    ico: function (r, d) { return new T.IcosahedronGeometry(r, d || 0); },
    sph: function (r, w, h) { return new T.SphereGeometry(r, w || 10, h || 8); },
    cone: function (r, h, s) { return new T.ConeGeometry(r, h, s || 6); },
    cyl: function (rt, rb, h, s) { return new T.CylinderGeometry(rt, rb, h, s || 8); },
    box: function (w, h, d) { return new T.BoxGeometry(w, h, d); },
    oct: function (r) { return new T.OctahedronGeometry(r, 0); },
    torus: function (r, t, rs, ts) { return new T.TorusGeometry(r, t, rs || 6, ts || 16); },
    plane: function (w, h) { return new T.PlaneGeometry(w, h); }
  };
  E.G = G;

  /* ============================================================
   * 护罩光环：盾卫的保护范围
   *
   * 为什么必须画出来：一个「范围内的妖魔减伤 30%」如果看不见，
   * 玩家只会觉得「这一片怎么突然打不动了」，而不会想到「先杀那只盾卫」。
   * **看不见的范围等于没有机制** —— 玩家学不到任何东西，只会觉得莫名其妙。
   * 所以机制和它的可视化必须一起做，不能「先上机制，美术后面补」。
   *
   * 返回的是几何体而不是 Mesh：它要走 InstancedMesh，
   * 每只盾卫一个实例，靠实例矩阵缩放成各自的 aura 半径。
   * ============================================================ */
  E.auraGeo = function () {
    /* 环带做窄（0.94~1.0）。护罩半径 5.5 米，如果环带按 0.86 起算，
       画出来是一条 0.77 米宽的白色粗带 —— 在暗场里它比妖魔还抢眼，
       玩家第一眼看到的是「地上有个亮圈」而不是「哪只在护着它们」。 */
    var g = new T.RingGeometry(0.94, 1.0, 56);
    /* 直接在几何上摊平到地面，实例矩阵就只剩「缩放 + 平移」。
       把朝向烘进几何、把位置留给矩阵，是实例化渲染里最省事的分工。 */
    g.rotateX(-Math.PI / 2);
    return g;
  };

  /* ============================================================
   * 妖魔几何：返回 { body, glow, radius, height }
   * ============================================================ */
  E.enemyGeo = function (type) {
    var b = [], g = [];
    var bodyCol, glowCol, radius = 0.5, height = 1.0;

    switch (type) {
      /* ---- 小妖：矮小、双角、赤目 ---- */
      case 'imp':
        radius = 0.44; height = 1.0;
        bodyCol = 0x654455; glowCol = C.cinnabar;
        b.push(part(G.ico(0.40), bodyCol, 0, 0.44, 0, 0, 0, 0, 1.0, 1.18, 0.92));
        b.push(part(G.cone(0.09, 0.34, 4), 0x7e5663, 0.17, 0.80, -0.03, 0.30, 0, -0.42));
        b.push(part(G.cone(0.09, 0.34, 4), 0x7e5663, -0.17, 0.80, -0.03, 0.30, 0, 0.42));
        b.push(part(G.box(0.30, 0.11, 0.11), 0x76505d, 0.30, 0.44, 0.06, 0, 0, -0.55));
        b.push(part(G.box(0.30, 0.11, 0.11), 0x76505d, -0.30, 0.44, 0.06, 0, 0, 0.55));
        g.push(part(G.sph(0.072, 8, 6), glowCol, 0.135, 0.50, 0.34));
        g.push(part(G.sph(0.072, 8, 6), glowCol, -0.135, 0.50, 0.34));
        g.push(part(G.oct(0.075), glowCol, 0, 0.30, 0.32));
        break;

      /* ---- 飞魔：蝠翼，悬浮 ---- */
      case 'flyer':
        radius = 0.52; height = 1.5;
        bodyCol = 0x564473; glowCol = C.purple;
        b.push(part(G.sph(0.32, 10, 8), bodyCol, 0, 0.30, 0, 0, 0, 0, 1.0, 0.85, 1.25));
        b.push(part(G.cone(0.08, 0.26, 4), 0x6b568b, 0.12, 0.52, -0.04, 0.34, 0, -0.30));
        b.push(part(G.cone(0.08, 0.26, 4), 0x6b568b, -0.12, 0.52, -0.04, 0.34, 0, 0.30));
        /* 蝠翼 */
        b.push(part(G.box(0.86, 0.035, 0.40), 0x655084, 0.60, 0.34, -0.04, 0, 0.22, -0.24));
        b.push(part(G.box(0.86, 0.035, 0.40), 0x655084, -0.60, 0.34, -0.04, 0, -0.22, 0.24));
        g.push(part(G.sph(0.062, 8, 6), glowCol, 0.11, 0.33, 0.29));
        g.push(part(G.sph(0.062, 8, 6), glowCol, -0.11, 0.33, 0.29));
        g.push(part(G.box(0.80, 0.02, 0.06), glowCol, 0.60, 0.34, 0.14, 0, 0.22, -0.24));
        g.push(part(G.box(0.80, 0.02, 0.06), glowCol, -0.60, 0.34, 0.14, 0, -0.22, 0.24));
        break;

      /* ---- 魔卒：魁梧重甲 ---- */
      case 'brute':
        radius = 0.78; height = 1.6;
        bodyCol = 0x5d4d55; glowCol = C.blood;
        b.push(part(G.ico(0.66, 0), bodyCol, 0, 0.74, 0, 0, 0, 0, 1.0, 1.22, 0.88));
        b.push(part(G.ico(0.30, 0), 0x6b5b5e, 0.62, 1.14, 0));
        b.push(part(G.ico(0.30, 0), 0x6b5b5e, -0.62, 1.14, 0));
        b.push(part(G.cone(0.13, 0.46, 5), 0x7e6369, 0.30, 1.50, -0.06, 0.26, 0, -0.34));
        b.push(part(G.cone(0.13, 0.46, 5), 0x7e6369, -0.30, 1.50, -0.06, 0.26, 0, 0.34));
        b.push(part(G.box(0.24, 0.78, 0.24), 0x6b5b5e, 0.72, 0.56, 0.04, 0, 0, -0.10));
        b.push(part(G.box(0.24, 0.78, 0.24), 0x6b5b5e, -0.72, 0.56, 0.04, 0, 0, 0.10));
        g.push(part(G.sph(0.095, 8, 6), glowCol, 0.19, 0.82, 0.50));
        g.push(part(G.sph(0.095, 8, 6), glowCol, -0.19, 0.82, 0.50));
        g.push(part(G.oct(0.14), C.ember, 0, 0.62, 0.52));
        break;

      /* ---- 怨灵：飘忽鬼影 ---- */
      case 'wraith':
        radius = 0.55; height = 1.5;
        /* 本体色改过一次：原来是 0x445e73 / 0x4c6a7e ——
           全 roster 里最亮、最不饱和的两个。它们正好落在
           「中性中亮色」那个陷阱里：分级调色里 lum 过了 0.12 的膝点之后
           会被 highTint (1.17,1.02,0.79) 往暖里推，色相被洗掉。
           平时看着只是「有点灰」，破晓的暖调一压就整只变成奶白色 ——
           远看是一片白色锥体，跟别的妖魔完全分不开。
           和盾卫 / 妖将同一个机制，处理方式也一样：**压暗 + 提饱和**。 */
        bodyCol = 0x2b4661; glowCol = C.frost;
        b.push(part(G.cone(0.50, 1.20, 8), bodyCol, 0, 0.62, 0, Math.PI, 0, 0));
        b.push(part(G.cone(0.34, 0.46, 8), 0x35526e, 0, 1.20, 0));
        b.push(part(G.sph(0.24, 10, 8), 0x35526e, 0, 1.02, 0.02));
        b.push(part(G.box(0.12, 0.52, 0.12), 0x35526e, 0.34, 0.72, 0.06, 0, 0, -0.30));
        b.push(part(G.box(0.12, 0.52, 0.12), 0x35526e, -0.34, 0.72, 0.06, 0, 0, 0.30));
        g.push(part(G.sph(0.070, 8, 6), glowCol, 0.10, 1.04, 0.22));
        g.push(part(G.sph(0.070, 8, 6), glowCol, -0.10, 1.04, 0.22));
        g.push(part(G.torus(0.26, 0.022, 5, 14), glowCol, 0, 0.34, 0, Math.PI / 2, 0, 0));
        break;

      /* ---- 妖巫：远程，法杖 + 飘浮 ---- */
      case 'caster':
        radius = 0.58; height = 1.6;
        bodyCol = 0x5a4a72; glowCol = C.purple;
        /* 下摆：倒锥，飘在半空 */
        b.push(part(G.cone(0.44, 1.05, 7), bodyCol, 0, 0.72, 0, Math.PI, 0, 0));
        b.push(part(G.sph(0.25, 10, 8), 0x6b5a84, 0, 1.10, 0.02));
        /* 尖顶兜帽 */
        b.push(part(G.cone(0.27, 0.62, 6), 0x7d6a96, 0, 1.30, -0.02, 0.16, 0, 0));
        /* 法杖：斜握，杖头一颗大珠 */
        b.push(part(G.box(0.075, 1.75, 0.075), 0x8d7a4a, 0.52, 1.00, 0.16, 0.10, 0, -0.16));
        b.push(part(G.torus(0.20, 0.035, 5, 14), 0x8d7a4a, 0.66, 1.82, 0.14));
        /* 双臂 */
        b.push(part(G.box(0.13, 0.48, 0.13), 0x6b5a84, 0.40, 0.92, 0.10, 0, 0, -0.42));
        b.push(part(G.box(0.13, 0.48, 0.13), 0x6b5a84, -0.40, 0.92, 0.10, 0, 0, 0.42));
        g.push(part(G.sph(0.075, 8, 6), glowCol, 0.13, 1.13, 0.24));
        g.push(part(G.sph(0.075, 8, 6), glowCol, -0.13, 1.13, 0.24));
        /* 杖头珠：放法术时最显眼的东西 */
        g.push(part(G.oct(0.17), glowCol, 0.66, 1.82, 0.14));
        g.push(part(G.torus(0.34, 0.022, 5, 16), glowCol, 0, 0.30, 0, Math.PI / 2, 0, 0));
        break;

      /* ---- 妖狼：冲锋，低伏四足 ---- */
      case 'charger':
        radius = 0.66; height = 1.2;
        bodyCol = 0x6b4a3e; glowCol = C.cinnabar;
        /* 躯干：压扁拉长，贴地 */
        b.push(part(G.ico(0.46, 0), bodyCol, 0, 0.62, 0, 0, 0, 0, 1.0, 0.82, 1.55));
        /* 前冲的头：往前探 */
        b.push(part(G.ico(0.30, 0), 0x7d5a48, 0, 0.60, 0.62, 0, 0, 0, 1.0, 0.92, 1.1));
        /* 双角朝前 */
        b.push(part(G.cone(0.085, 0.52, 5), 0x8d6a52, 0.18, 0.86, 0.72, -1.05, 0, -0.16));
        b.push(part(G.cone(0.085, 0.52, 5), 0x8d6a52, -0.18, 0.86, 0.72, -1.05, 0, 0.16));
        /* 背脊倒刺 */
        b.push(part(G.cone(0.11, 0.44, 4), 0x8d6a52, 0, 0.94, 0.18, -0.30, 0, 0));
        b.push(part(G.cone(0.10, 0.38, 4), 0x8d6a52, 0, 0.90, -0.16, -0.42, 0, 0));
        b.push(part(G.cone(0.09, 0.32, 4), 0x8d6a52, 0, 0.84, -0.46, -0.54, 0, 0));
        /* 四条腿 */
        b.push(part(G.box(0.13, 0.50, 0.13), 0x5f4238, 0.26, 0.26, 0.34));
        b.push(part(G.box(0.13, 0.50, 0.13), 0x5f4238, -0.26, 0.26, 0.34));
        b.push(part(G.box(0.14, 0.46, 0.14), 0x5f4238, 0.26, 0.24, -0.34));
        b.push(part(G.box(0.14, 0.46, 0.14), 0x5f4238, -0.26, 0.24, -0.34));
        /* 尾 */
        b.push(part(G.cone(0.10, 0.66, 4), 0x7d5a48, 0, 0.72, -0.78, -1.30, 0, 0));
        g.push(part(G.sph(0.080, 8, 6), glowCol, 0.14, 0.66, 0.80));
        g.push(part(G.sph(0.080, 8, 6), glowCol, -0.14, 0.66, 0.80));
        g.push(part(G.oct(0.13), C.ember, 0, 0.56, 0.86));
        break;

      /* ---- 裂魔：一坨快撑不住的不规则肉块，皮下透出内丹 ---- */
      case 'splitter':
        radius = 0.74; height = 1.5;
        bodyCol = 0x4a5340; glowCol = C.moss;
        /* 主体刻意做得不对称 —— 对称的造型读作「一种生物」，
           歪斜的造型读作「快散架了」。玩家要能预感到它会裂。 */
        b.push(part(G.ico(0.60, 1), bodyCol, 0, 0.62, 0, 0.30, 0.50, 0.20, 1.05, 1.00, 0.95));
        b.push(part(G.ico(0.34, 0), 0x55603f, 0.44, 0.46, 0.10, 0.50, 0.20, 0));
        b.push(part(G.ico(0.30, 0), 0x55603f, -0.40, 0.52, -0.12, 0.10, 0.60, 0.30));
        b.push(part(G.ico(0.26, 0), 0x5c6845, 0.06, 1.06, -0.04, 0.20, 0.30, 0.40));
        /* 表面裂纹：几条暗色凹槽，暗示随时会裂开 */
        b.push(part(G.box(0.05, 0.70, 0.06), 0x333a2c, 0.20, 0.66, 0.46, 0, 0, -0.34));
        b.push(part(G.box(0.05, 0.56, 0.06), 0x333a2c, -0.28, 0.60, 0.34, 0.20, 0.50, 0.42));
        /* 透出来的内丹 —— 就是它倒下后要裂出来的那几只 */
        g.push(part(G.sph(0.115, 8, 6), glowCol, 0.22, 0.70, 0.44));
        g.push(part(G.sph(0.105, 8, 6), glowCol, -0.30, 0.58, 0.36));
        g.push(part(G.sph(0.095, 8, 6), glowCol, 0.02, 1.10, 0.10));
        g.push(part(G.sph(0.075, 8, 6), glowCol, 0.46, 0.44, 0.24));
        g.push(part(G.torus(0.36, 0.020, 5, 16), glowCol, 0, 0.24, 0, Math.PI / 2, 0, 0));
        break;

      /* ---- 小裂魔：本体的一块残片。同色、更小、内丹只有一颗 ---- */
      case 'splitling':
        radius = 0.40; height = 0.85;
        bodyCol = 0x4a5340; glowCol = C.moss;
        b.push(part(G.ico(0.34, 0), bodyCol, 0, 0.36, 0, 0.20, 0.40, 0.10, 1.00, 0.94, 0.96));
        b.push(part(G.ico(0.18, 0), 0x55603f, 0.22, 0.26, 0.06, 0, 0.50, 0));
        b.push(part(G.ico(0.16, 0), 0x5c6845, -0.18, 0.30, -0.06, 0.30, 0, 0.40));
        g.push(part(G.sph(0.062, 8, 6), glowCol, 0.10, 0.42, 0.26));
        g.push(part(G.oct(0.085), glowCol, -0.06, 0.34, 0.28));
        g.push(part(G.torus(0.20, 0.016, 5, 14), glowCol, 0, 0.16, 0, Math.PI / 2, 0, 0));
        break;

      /* ---- 盾卫：举着一面比自己还高的巨盾，护罩的「源」要看得见 ---- */
      case 'guard':
        radius = 0.70; height = 1.9;
        /* 用 steel（玄铁）而不是 thunder。thunder 是近白色，
           当本体自发光会把深板岩甲洗成纯白剪影 —— 见 config.js 里的注释。 */
        bodyCol = 0x33496b; glowCol = C.steel;
        /* 固有色刻意选**饱和且偏暗**的冷钢色。
           这一条是踩出来的：原来用 0x3f4a58（中性板岩灰），
           亮度刚好跨过泛光阈值，泛光在它上面又叠了一层同色 ——
           结果明暗被整个抹平，整只怪糊成一片纯白，连盾牌和盔缨都分不出来。
           同屏的小妖（朱砂）、裂魔（腐毒）都没事，因为它们的固有色是饱和的：
           泛光叠上去只会更艳，不会变白。
           所以在这个带泛光的场景里，**大块的中性色是禁用项**。
           往蓝里压、往暗里压，泛光就只会在边缘勾一圈冷光，而不是糊一脸白。 */
        b.push(part(G.ico(0.50, 0), bodyCol, 0, 0.82, 0, 0, 0, 0, 1.00, 1.15, 0.85));
        b.push(part(G.ico(0.26, 0), 0x3d5578, 0, 1.42, 0.02));
        /* 头盔 + 缨 */
        b.push(part(G.cone(0.22, 0.40, 6), 0x4a6690, 0, 1.66, -0.02));
        b.push(part(G.box(0.10, 0.40, 0.10), 0x5c7caa, 0, 1.94, -0.10, 0.30, 0, 0));
        b.push(part(G.box(0.17, 0.60, 0.17), 0x25344d, 0.22, 0.30, 0));
        b.push(part(G.box(0.17, 0.60, 0.17), 0x25344d, -0.22, 0.30, 0));
        /* 巨盾：立在身前（局部 +z 朝向玩家），是它最显眼的轮廓。
           注意尺寸顺序 —— 塔盾是「宽 × 高 × 薄」，所以薄的那一维必须在 z。
           原来写成 (0.14, 1.45, 1.05)，等于把盾**侧过来**举着：
           从相机看过去只剩一条 0.14 宽的竖条，既不像盾、也浪费了最大的一块面。

           盾面做成**两块斜板拼成的浅 V**，而不是一整块平板 —— 这是踩出来的：
           全场妖魔共用一份 Phong 材质（specular=0x2a3a46 / shininess=22）。
           球体（ico）法线处处不同，镜面高光只是身上一小块亮斑；
           而一整块正对相机的平板，法线处处相同、又正好落在半程向量附近，
           pow(dot(N,H),22) 在**整块盾面**上约等于 1 ——
           于是整面盾被镜面光刷成 (0.6,0.8,1.0) 的冷白，明暗全没了。
           实测：盾卫糊成一块白板，而同屏的小妖、魔卒颜色完全正常，
           因为它们的曲面把高光收成了一个点。
           拆成两块斜板之后法线分了两个方向，只有一块能吃到高光，
           另一块保留固有色 —— 明暗回来了，盾的厚度也读出来了。 */
        b.push(part(G.box(0.54, 1.45, 0.13), 0x2c4060, -0.27, 0.92, 0.50, 0, 0.20, 0));
        b.push(part(G.box(0.54, 1.45, 0.13), 0x2c4060, 0.27, 0.92, 0.50, 0, -0.20, 0));
        b.push(part(G.box(1.20, 0.20, 0.20), 0x3a5478, 0, 1.62, 0.52));
        b.push(part(G.box(1.20, 0.20, 0.20), 0x3a5478, 0, 0.24, 0.52));
        /* 盾面徽记 + 双目 + 脚下环 */
        g.push(part(G.torus(0.28, 0.032, 5, 20), glowCol, 0, 0.92, 0.58));
        g.push(part(G.oct(0.13), glowCol, 0, 0.92, 0.58));
        g.push(part(G.sph(0.070, 8, 6), glowCol, 0.11, 1.44, 0.24));
        g.push(part(G.sph(0.070, 8, 6), glowCol, -0.11, 1.44, 0.24));
        g.push(part(G.torus(0.44, 0.025, 5, 18), glowCol, 0, 0.10, 0, Math.PI / 2, 0, 0));
        break;

      /* ---- 妖将：精英，冠冕 + 巨刃 ---- */
      case 'elite':
        radius = 1.12; height = 2.3;
        /* 固有色整体往深紫里压。
           原来用 0x59485e（中性灰紫）+ 0x8d7e9c 的巨刃，亮度落在 0.6 附近，
           刚好越过调色 pass 的 0.72 拐点 —— 那一段会把高亮推向暖色
           (1.17, 1.02, 0.79)，于是整只妖将从「深紫甲胄」变成一团粉白。
           和盾卫是同一个病根：**在这个场景里，中高亮度的中性色会被后处理洗掉色相**。
           往深里压、往饱和里调，色相才留得住。 */
        bodyCol = 0x3d2f52; glowCol = C.purple;
        b.push(part(G.ico(0.92, 0), bodyCol, 0, 1.02, 0, 0, 0, 0, 1.0, 1.25, 0.9));
        b.push(part(G.ico(0.42, 0), 0x4c3a66, 0.86, 1.62, 0));
        b.push(part(G.ico(0.42, 0), 0x4c3a66, -0.86, 1.62, 0));
        /* 冠冕四刺 */
        b.push(part(G.cone(0.11, 0.62, 5), 0x5a4478, 0.30, 2.28, -0.06, 0.22, 0, -0.30));
        b.push(part(G.cone(0.11, 0.62, 5), 0x5a4478, -0.30, 2.28, -0.06, 0.22, 0, 0.30));
        b.push(part(G.cone(0.11, 0.74, 5), 0x5a4478, 0, 2.36, -0.10, 0.16, 0, 0));
        b.push(part(G.cone(0.09, 0.44, 5), 0x5a4478, 0.55, 2.14, -0.10, 0.30, 0, -0.55));
        b.push(part(G.cone(0.09, 0.44, 5), 0x5a4478, -0.55, 2.14, -0.10, 0.30, 0, 0.55));
        /* 巨刃 */
        b.push(part(G.box(0.10, 1.90, 0.26), 0x554370, 1.10, 1.30, 0.10, 0, 0, -0.22));
        b.push(part(G.box(0.16, 0.28, 0.44), 0x4c3a66, 1.14, 2.24, 0.10, 0, 0, -0.22));
        g.push(part(G.sph(0.13, 8, 6), glowCol, 0.27, 1.14, 0.72));
        g.push(part(G.sph(0.13, 8, 6), glowCol, -0.27, 1.14, 0.72));
        g.push(part(G.oct(0.20), C.gold, 0, 0.86, 0.74));
        g.push(part(G.box(0.05, 1.84, 0.30), glowCol, 1.10, 1.30, 0.10, 0, 0, -0.22));
        break;

      /* ---- 魔尊：Boss ---- */
      case 'boss':
        radius = 2.10; height = 4.4;
        bodyCol = 0x55384c; glowCol = C.blood;
        b.push(part(G.ico(1.72, 1), bodyCol, 0, 2.00, 0, 0, 0, 0, 1.0, 1.30, 0.92));
        b.push(part(G.ico(0.78, 0), 0x6b445e, 1.60, 3.00, 0));
        b.push(part(G.ico(0.78, 0), 0x6b445e, -1.60, 3.00, 0));
        /* 六角魔冠 */
        b.push(part(G.cone(0.20, 1.50, 5), 0x7e445e, 0.66, 4.30, -0.10, 0.20, 0, -0.38));
        b.push(part(G.cone(0.20, 1.50, 5), 0x7e445e, -0.66, 4.30, -0.10, 0.20, 0, 0.38));
        b.push(part(G.cone(0.24, 1.95, 5), 0x7e445e, 0, 4.50, -0.16, 0.14, 0, 0));
        b.push(part(G.cone(0.16, 1.00, 5), 0x7e445e, 1.15, 3.95, -0.14, 0.28, 0, -0.62));
        b.push(part(G.cone(0.16, 1.00, 5), 0x7e445e, -1.15, 3.95, -0.14, 0.28, 0, 0.62));
        /* 双臂 */
        b.push(part(G.box(0.46, 1.70, 0.46), 0x654455, 1.85, 1.60, 0.10, 0, 0, -0.14));
        b.push(part(G.box(0.46, 1.70, 0.46), 0x654455, -1.85, 1.60, 0.10, 0, 0, 0.14));
        /* 背刺 */
        b.push(part(G.cone(0.16, 1.40, 4), 0x6b445e, 0, 2.60, -1.20, -0.80, 0, 0));
        g.push(part(G.sph(0.20, 8, 6), glowCol, 0.46, 2.10, 1.36));
        g.push(part(G.sph(0.20, 8, 6), glowCol, -0.46, 2.10, 1.36));
        g.push(part(G.oct(0.46), C.gold, 0, 1.60, 1.44));
        g.push(part(G.torus(0.62, 0.05, 5, 20), C.ember, 0, 1.60, 1.42));
        break;
    }

    return {
      body: mergeGeos(b),
      glow: mergeGeos(g),
      radius: radius,
      height: height,
      /* 元素色：本体材质会拿它做一点自发光，
         这样妖魔在暗部里不会变成纯黑剪影，而是「体内透着邪气」。 */
      tint: glowCol
    };
  };

  /* ============================================================
   * 玩家：剑修
   * ============================================================ */
  E.makePlayer = function () {
    var grp = new T.Group();
    var robeMat = new T.MeshStandardMaterial({
      color: 0xe8f4ff, roughness: 0.62, metalness: 0.10,
      emissive: new T.Color(C.jade), emissiveIntensity: 0.10
    });
    var darkMat = new T.MeshStandardMaterial({
      color: 0x143244, roughness: 0.55, metalness: 0.25,
      emissive: new T.Color(C.jade), emissiveIntensity: 0.14
    });
    var goldMat = new T.MeshStandardMaterial({
      color: 0xffcf6b, roughness: 0.32, metalness: 0.75,
      emissive: new T.Color(C.gold), emissiveIntensity: 0.35
    });

    /* 道袍 */
    var robe = new T.Mesh(G.cyl(0.17, 0.55, 1.18, 12), robeMat);
    robe.position.y = 0.60;
    grp.add(robe);

    /* 下摆飘带 */
    var hem = new T.Mesh(G.cyl(0.55, 0.72, 0.26, 12, 1), darkMat);
    hem.position.y = 0.05;
    grp.add(hem);

    /* 腰封 */
    var belt = new T.Mesh(G.torus(0.30, 0.055, 6, 18), goldMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.92;
    grp.add(belt);

    /* 护肩 */
    var sh = new T.Mesh(G.cone(0.60, 0.52, 10, 1), darkMat);
    sh.position.y = 1.16;
    grp.add(sh);

    /* 双臂（宽袖）
       挂在肩部枢轴上，跑动时前后摆动 —— 这是「角色活着」最廉价
       也最有效的一个细节：没有摆臂，再好的模型看起来都像在滑行。 */
    function makeArm(side) {
      var pivot = new T.Group();
      pivot.position.set(0.30 * side, 1.10, 0);
      var sleeve = new T.Mesh(G.cyl(0.085, 0.205, 0.60, 8), robeMat);
      sleeve.position.y = -0.30;
      pivot.add(sleeve);
      var cuff = new T.Mesh(G.torus(0.19, 0.035, 6, 14), goldMat);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = -0.585;
      pivot.add(cuff);
      var hand = new T.Mesh(G.sph(0.072, 10, 8), robeMat);
      hand.position.y = -0.645;
      pivot.add(hand);
      grp.add(pivot);
      return pivot;
    }
    var armL = makeArm(1), armR = makeArm(-1);

    /* 头 */
    var head = new T.Mesh(G.sph(0.215, 14, 12), robeMat);
    head.position.y = 1.50;
    grp.add(head);

    /* 发 */
    var hairMat = new T.MeshStandardMaterial({ color: 0x0d1a24, roughness: 0.75, metalness: 0.1 });
    var hair = new T.Mesh(G.sph(0.225, 12, 10), hairMat);
    hair.position.set(0, 1.56, -0.03);
    hair.scale.set(1.0, 0.92, 1.02);
    grp.add(hair);

    var bun = new T.Mesh(G.sph(0.105, 10, 8), hairMat);
    bun.position.set(0, 1.78, -0.10);
    grp.add(bun);

    var pin = new T.Mesh(G.cyl(0.018, 0.018, 0.42, 6), goldMat);
    pin.position.set(0, 1.80, -0.10);
    pin.rotation.z = Math.PI / 2;
    grp.add(pin);

    /* 身后灵剑（装饰） */
    var backSword = new T.Mesh(G.box(0.055, 1.35, 0.10), new T.MeshStandardMaterial({
      color: 0xbfe9ff, roughness: 0.25, metalness: 0.85,
      emissive: new T.Color(C.jade), emissiveIntensity: 0.45
    }));
    backSword.position.set(-0.26, 1.20, -0.34);
    backSword.rotation.set(0.30, 0, 0.42);
    grp.add(backSword);

    /* 脚下灵光阵 */
    var ringMat = new T.MeshBasicMaterial({
      map: XS.World ? null : null, color: C.jade,
      transparent: true, opacity: 0.55,
      blending: T.AdditiveBlending, depthWrite: false
    });
    var ring = new T.Mesh(new T.RingGeometry(0.62, 0.92, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    grp.add(ring);

    var ring2 = new T.Mesh(new T.RingGeometry(1.05, 1.16, 32), ringMat.clone());
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = 0.02;
    ring2.material.opacity = 0.30;
    grp.add(ring2);

    /* 受击护盾壳 */
    var shell = new T.Mesh(G.sph(1.05, 16, 12), new T.MeshBasicMaterial({
      color: C.jadeSoft, transparent: true, opacity: 0.0,
      blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide
    }));
    shell.position.y = 0.85;
    grp.add(shell);

    /* 天光柱：两片交叉的公告板光柱，乱战中一眼定位自己。
       注意别做太大太亮 —— 加色混合的柔光贴图一旦超过角色身高，
       近景就会糊成一颗白球，反而看不见自己站在哪。 */
    var beamMat = new T.MeshBasicMaterial({
      map: beamTexture(),
      transparent: true, opacity: 0.55,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false
    });
    var beamA = new T.Mesh(new T.PlaneGeometry(0.92, 3.0), beamMat);
    beamA.position.y = 1.5;
    grp.add(beamA);
    var beamB = new T.Mesh(new T.PlaneGeometry(0.92, 3.0), beamMat.clone());
    beamB.position.y = 1.5;
    beamB.rotation.y = Math.PI / 2;
    grp.add(beamB);

    grp.scale.setScalar(1.16);
    grp.userData.refs = {
      robe: robe, hair: hair, ring: ring, ring2: ring2,
      shell: shell, backSword: backSword, head: head,
      beamA: beamA, beamB: beamB,
      armL: armL, armR: armR, hem: hem, belt: belt, shoulder: sh
    };
    return grp;
  };

  /* ============================================================
   * 妖巫的术法弹
   *
   * 用独立的小网格而不是实例化：同屏最多几十颗，
   * 但每颗都要单独做公告板朝向，实例化反而更麻烦。
   * ============================================================ */
  E.makeBolt = function () {
    var grp = new T.Group();
    var core = new T.Mesh(G.oct(0.20), new T.MeshBasicMaterial({
      color: C.purple, transparent: true, opacity: 0.95,
      blending: T.AdditiveBlending, depthWrite: false
    }));
    grp.add(core);
    var halo = new T.Mesh(new T.PlaneGeometry(1.45, 1.45), new T.MeshBasicMaterial({
      map: glowTexture(64, 'rgba(206,168,255,0.85)', 'rgba(140,80,255,0)'),
      transparent: true, opacity: 0.7,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false
    }));
    grp.add(halo);
    grp.userData.refs = { core: core, halo: halo };
    return grp;
  };

  /* ============================================================
   * 拖尾贴图与几何体
   *
   * 刃光拖尾是「速度感」的来源。没有它，飞剑看起来像被摆在
   * 一个圆环上平移；有了它，才像在「挥」。
   * 用一张横向渐变的贴图 + 一个躺平的四边形即可，
   * 全部实例化后只占 1 个 draw call。
   * ============================================================ */
  E.bladeTrailTexture = function () {
    var W = 128, H = 32;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    /* 纵向：中间亮、上下淡（做出刃的厚度） */
    var vg = g.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, 'rgba(255,255,255,0)');
    vg.addColorStop(0.5, 'rgba(255,255,255,1)');
    vg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    /* 横向：尾端透明 → 头部炽白 */
    g.globalCompositeOperation = 'destination-in';
    var hg = g.createLinearGradient(0, 0, W, 0);
    hg.addColorStop(0, 'rgba(255,255,255,0)');
    hg.addColorStop(0.55, 'rgba(255,255,255,0.42)');
    hg.addColorStop(0.88, 'rgba(255,255,255,0.92)');
    hg.addColorStop(1, 'rgba(255,255,255,0.35)');
    g.fillStyle = hg;
    g.fillRect(0, 0, W, H);
    return new T.CanvasTexture(c);
  };

  /* 躺平在 XZ 平面的四边形：局部 +X = 长度方向，局部 +Z = 宽度方向 */
  E.makeTrailGeo = function () {
    var g = new T.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  };

  /* ============================================================
   * 飞剑
   * ============================================================ */
  E.makeSword = function () {
    var grp = new T.Group();
    var blade = new T.Mesh(G.box(0.075, 0.075, 1.05), new T.MeshStandardMaterial({
      color: 0xd8f2ff, roughness: 0.20, metalness: 0.92,
      emissive: new T.Color(C.jade), emissiveIntensity: 0.85
    }));
    blade.position.z = 0.30;
    grp.add(blade);

    var tip = new T.Mesh(G.cone(0.062, 0.34, 4), new T.MeshBasicMaterial({
      color: C.jadeSoft, transparent: true, opacity: 0.9,
      blending: T.AdditiveBlending, depthWrite: false
    }));
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.98;
    grp.add(tip);

    var guard = new T.Mesh(G.box(0.26, 0.05, 0.07), new T.MeshStandardMaterial({
      color: 0xffcf6b, roughness: 0.3, metalness: 0.8,
      emissive: new T.Color(C.gold), emissiveIntensity: 0.4
    }));
    guard.position.z = -0.24;
    grp.add(guard);

    var hilt = new T.Mesh(G.cyl(0.035, 0.035, 0.30, 6), new T.MeshStandardMaterial({
      color: 0x143244, roughness: 0.7
    }));
    hilt.rotation.x = Math.PI / 2;
    hilt.position.z = -0.42;
    grp.add(hilt);

    /* 剑光 */
    var trail = new T.Mesh(G.plane(0.30, 1.9), new T.MeshBasicMaterial({
      color: C.jade, transparent: true, opacity: 0.30,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
    }));
    trail.rotation.x = -Math.PI / 2;
    trail.position.z = 0.32;
    grp.add(trail);

    return grp;
  };

  /* ============================================================
   * 剑气（远程弹体）
   * ============================================================ */
  E.makeQiGeo = function () {
    return mergeGeos([
      part(G.oct(0.20), C.jade, 0, 0, 0, 0, 0, 0, 0.55, 0.55, 2.6),
      part(G.oct(0.13), 0xffffff, 0, 0, 0, 0, 0, 0, 0.42, 0.42, 2.1)
    ]);
  };

  /* ============================================================
   * 灵气珠
   * ============================================================ */
  E.makeOrbGeo = function () {
    return mergeGeos([
      part(G.oct(0.17), C.jadeSoft, 0, 0, 0, 0, 0, 0, 1.0, 1.35, 1.0),
      part(G.oct(0.10), 0xffffff, 0, 0, 0)
    ]);
  };

  /* ============================================================
   * 特效几何
   * ============================================================ */
  E.makeFx = {
    /* 落雷：柱 + 地面圈 */
    thunder: function () {
      var grp = new T.Group();
      var col = new T.Mesh(
        G.cyl(0.34, 0.62, 22, 8, 1),
        new T.MeshBasicMaterial({
          color: C.thunder, transparent: true, opacity: 0.85,
          blending: T.AdditiveBlending, depthWrite: false
        })
      );
      col.position.y = 11;
      grp.add(col);
      var ring = new T.Mesh(new T.RingGeometry(0.6, 2.4, 32), new T.MeshBasicMaterial({
        color: C.thunder, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      grp.add(ring);
      grp.userData.refs = { col: col, ring: ring };
      return grp;
    },
    /* 爆燃 */
    blast: function () {
      var grp = new T.Group();
      var core = new T.Mesh(G.sph(1, 14, 10), new T.MeshBasicMaterial({
        color: C.ember, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false
      }));
      grp.add(core);
      /* 外层用柔光实体球（BackSide + 加色），而不是线框球：
         线框球一眼就看出是「几何体」，读不出爆炸的能量感。 */
      var shell = new T.Mesh(G.sph(1, 16, 12), new T.MeshBasicMaterial({
        color: C.gold, transparent: true, opacity: 0.26,
        blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide
      }));
      grp.add(shell);
      var ring = new T.Mesh(new T.RingGeometry(0.7, 1.0, 32), new T.MeshBasicMaterial({
        color: C.gold, transparent: true, opacity: 0.85,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      grp.add(ring);
      grp.userData.refs = { core: core, shell: shell, ring: ring };
      return grp;
    },
    /* 冰环 */
    /* 预警法阵：贴地的一圈红环 + 半透明填充，持续脉动。
       首领放大招之前先用它把「危险范围」画在地上 ——
       玩家躲得开，这一下才叫「招式」；躲不开，那只是掉血。 */
    omen: function () {
      var grp = new T.Group();
      var fill = new T.Mesh(new T.CircleGeometry(1, 48), new T.MeshBasicMaterial({
        color: C.cinnabar, transparent: true, opacity: 0.16,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = -0.006;
      grp.add(fill);
      var ring = new T.Mesh(new T.RingGeometry(0.84, 1.0, 56), new T.MeshBasicMaterial({
        color: C.cinnabar, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      grp.add(ring);
      grp.userData.refs = { ring: ring, fill: fill };
      return grp;
    },

    /* 升级光柱：脚下金环炸开 + 一道冲天光柱。
       升级是玩家唯一「被奖励」的瞬间，必须给足仪式感。 */
    levelup: function () {
      var grp = new T.Group();
      var beamMat = new T.MeshBasicMaterial({
        map: beamTexture(), color: C.gold, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false
      });
      var beam = new T.Mesh(new T.PlaneGeometry(1.5, 7.2), beamMat);
      beam.position.y = 3.6;
      grp.add(beam);
      var beam2 = new T.Mesh(new T.PlaneGeometry(1.5, 7.2), beamMat);
      beam2.position.y = 3.6;
      beam2.rotation.y = Math.PI / 2;
      grp.add(beam2);
      var ring = new T.Mesh(new T.RingGeometry(0.72, 1.0, 44), new T.MeshBasicMaterial({
        color: C.gold, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      grp.add(ring);
      grp.userData.refs = { beam: beam, beam2: beam2, ring: ring };
      return grp;
    },

    frost: function () {
      var grp = new T.Group();
      var ring = new T.Mesh(new T.RingGeometry(0.86, 1.0, 48), new T.MeshBasicMaterial({
        color: C.frost, transparent: true, opacity: 0.8,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      grp.add(ring);
      grp.userData.refs = { ring: ring };
      return grp;
    },
    /* 雷电场残留：落雷之后地上留一片「还在放电」的区域。
       没有它，天雷就只是「每隔几秒闪一下」；有了它，天雷才
       占住一块地，玩家才会开始考虑「把怪往电场里引」。 */
    field: function () {
      var grp = new T.Group();
      var disc = new T.Mesh(
        new T.PlaneGeometry(2, 2),
        new T.MeshBasicMaterial({
          map: fieldTexture(), color: C.thunder, transparent: true, opacity: 0.85,
          blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
        })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.07;
      grp.add(disc);
      var ring = new T.Mesh(new T.RingGeometry(0.90, 1.0, 44), new T.MeshBasicMaterial({
        color: C.jadeSoft, transparent: true, opacity: 0.6,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.09;
      grp.add(ring);
      grp.userData.refs = { disc: disc, ring: ring };
      return grp;
    },

    /* 蓄力（魔尊第二套招式「弹幕环」的前摇）。
       刻意做成**收缩**：环从外向内收拢，中心亮核同时胀大。
       和裂地的「扩散环」在动势上完全相反 —— 两套招式如果都用扩散环，
       玩家就只能靠颜色去分辨，而颜色在满屏特效里是最先被淹没的信息。
       动势相反则不需要解释：往外长＝这一圈要炸开，往里收＝要从中心射出来。 */
    charge: function () {
      var grp = new T.Group();
      var ring = new T.Mesh(new T.RingGeometry(0.86, 1.0, 48), new T.MeshBasicMaterial({
        color: C.frost, transparent: true, opacity: 0.9,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07;
      grp.add(ring);
      var core = new T.Mesh(G.sph(1, 14, 10), new T.MeshBasicMaterial({
        color: C.thunder, transparent: true, opacity: 0.55,
        blending: T.AdditiveBlending, depthWrite: false
      }));
      core.position.y = 2.0;
      grp.add(core);
      grp.userData.refs = { ring: ring, core: core };
      return grp;
    },

    /* 罡气脉冲 */
    pulse: function () {
      var grp = new T.Group();
      var ring = new T.Mesh(new T.RingGeometry(0.88, 1.0, 48), new T.MeshBasicMaterial({
        color: C.gold, transparent: true, opacity: 0.7,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      grp.add(ring);
      grp.userData.refs = { ring: ring };
      return grp;
    },
    /* 死亡消散 */
    death: function () {
      var grp = new T.Group();
      var core = new T.Mesh(G.ico(1, 1), new T.MeshBasicMaterial({
        color: C.cinnabar, transparent: true, opacity: 0.45,
        blending: T.AdditiveBlending, depthWrite: false
      }));
      grp.add(core);
      var ring = new T.Mesh(new T.RingGeometry(0.7, 1.0, 24), new T.MeshBasicMaterial({
        color: C.cinnabar, transparent: true, opacity: 0.7,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      grp.add(ring);
      grp.userData.refs = { core: core, ring: ring };
      return grp;
    }
  };

})(window);
