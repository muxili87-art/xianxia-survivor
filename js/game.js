/* ============================================================
 * 玩法核心：波次 / AI / 自动战斗 / 经验 / 功法 / 结算
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var T = global.THREE;
  var U = XS.U;
  var C = XS.C;
  var E = XS.Ent;
  var Tele = XS.Telemetry;
  var Platform = XS.Platform;
  var Sfx = XS.Audio;

  var Game = XS.Game = {};

  var TYPES = ['imp', 'flyer', 'brute', 'wraith', 'caster', 'charger',
               'splitter', 'splitling', 'guard', 'elite', 'boss'];
  /* 每种的上限。splitling 给得比它的母体高：它是**分裂产物**，
     不占波次名额，只在裂魔死的那一刻成对出现，所以它的上限必须
     单独留出余量，否则「裂魔刚好在 splitling 满员时死掉」
     会静默地少分裂一只 —— 玩家会看到一次不完整的分裂。 */
  var CAP = { imp: 170, flyer: 130, brute: 115, wraith: 145, caster: 70, charger: 70,
              splitter: 60, splitling: 120, guard: 45, elite: 30, boss: 4 };

  /* 飞剑上限：御剑术满级 9 把，进化「万剑归宗」后 14 把。
     池子必须按**上限**建，不能按基础上限 —— 否则进化后多出来的剑
     根本没有 mesh 可挂，表现上就是「进化了什么都没变」。 */
  var SWORD_MAX = 14;
  var QI_MAX = 72;         // 剑气池：进化后一次 9 道且贯穿全场，同时在飞的会更多

  var scene = null;
  var R = {};              // 每类妖魔的实例化渲染器
  var byType = {};         // 每类妖魔的数据数组
  var enemyTotal = 0;

  var player = null;
  var playerMesh = null;
  var swordTrail = null;   // 飞剑拖尾（实例化，1 个 draw call）
  var qiTrail = null;      // 剑气拖尾（实例化，1 个 draw call）
  var swordMeshes = [];
  var qiPool = [];
  var boltPool = [];       // 妖巫的术法弹
  var orbPool = [];
  var orbFree = [];
  var orbMesh = null;
  var fxPool = [];
  var guardAura = null;    // 盾卫护罩：贴地圆环，实例化（每只盾卫一个）

  /* 状态外壳：冰缓 / 灼烧各一层实例化壳。
     容量取全部妖魔上限的约一半 —— 同一时刻不可能半场怪都中状态，
     真要超了就截断，宁可少画几层壳也不能让 count 越界。
     ★ 两个状态是**两份几何体**（冰=晶体、火=火舌），不是一份换色。
     原因见 E.makeStatusShell 的注释：只靠颜色区分对色盲玩家等于没区分。 */
  var STATUS_CAP = 380;
  var shellFrost = null;
  var shellBurn = null;
  var _shellColor = new T.Color();
  var SHELL_FROST = new T.Color(0x6fc8ff);
  var SHELL_BURN = new T.Color(0xff7a24);

  /* ---------- 无障碍：高对比轮廓 ----------
   *
   * 做法是「反向外壳」（inverted hull）：把妖魔本体几何体
   * 原样再画一遍，稍微放大、只画背面。
   * 放大后的壳的背面会被本体的深度挡掉，只有在**轮廓外缘**
   * 那一圈才露出来 —— 于是得到一条贴着剪影的描边。
   *
   * 为什么不用「本体加个 rim 光」：rim 需要动材质着色器，
   * 而妖魔是按类型合并的实例化几何体，改材质要重建所有变体。
   * 反向外壳只是多一个 drawcall，几何体还能和本体共用（不占额外显存）。
   *
   * 材质上三个关键选择：
   * - fog: false。场景有 FogExp2(0.0126)，描边一旦吃雾，
   *   远处妖魔的描边就会褪成背景色 —— 而「远处的怪也要看得清」
   *   恰恰是这个功能存在的理由。
   * - **深墨色**而不是亮白色。这是量出来的结论，不是偏好：
   *   本作的妖魔被照到接近奶白（自发光 + 辉光层 + 分级调色都往亮推），
   *   亮色描边在亮体上几乎没有对比 —— 三种颜色（亮白 / 深墨 / 青）
   *   的剪影边缘能量分别是 10.92 / 10.76 / 10.59，对基线 9.84，
   *   提升幅度几乎一样（都在 +9%~+11%），也就是说**颜色不改变可读性**。
   *   既然可读性等价，就按美术语义选：青色是玩家自己的颜色
   *   （飞剑、剑气、冰域、台面符文都是青），给妖魔描青色会和
   *   「这是友方特效」撞语义；深墨色是赛璐璐勾线的经典做法，
   *   不占用任何阵营色，并且在破晓变亮之后依然成立。
   * - 宽度要够。0.07 米在 25 米外只有约 2.7 像素，而画面最后要过
   *   一道 UnrealBloomPass —— 泛光会把细线糊开，实测 0.07 在缩略图上
   *   「看起来还行」，放大后几乎不存在。0.12 米约 4~5 像素，能扛住泛光。
   *
   * ★ 描边的**宽度**不能按固定倍数缩放。
   *   第一版用统一的 1.055：小妖（外廓 0.42 米）描边只有 2 厘米，
   *   在 25 米外不到 1 个像素 —— 等于没画；而魔尊（2.1 米）却有 11 厘米。
   *   按倍数缩放意味着「越小的怪越看不清」，正好和需求相反。
   *   改成**按类型反推倍数**，让世界空间里的宽度恒定：
   *   小妖拿到 1.24 倍，魔尊只有 1.04 倍，屏幕上都是几个像素。
   */
  var OUTLINE_W = 0.12;      // 描边在世界空间里的目标宽度（米）
  var OUTLINE_SCALE = 1.055; // 兜底值（没有外廓信息时用）
  var OUTLINE_COLOR = 0x0a1520;
  var outlineMats = [];
  var markers = null;          // 稀有度标记（妖将 / 魔尊）
  var _camQuat = new T.Quaternion();
  var _camMat = new T.Matrix4();
  var _mkPos = new T.Vector3();
  var _mkScale = new T.Vector3();
  var _mkM = new T.Matrix4();

  var state = 'ready';
  var runT = 0;
  var waveIdx = 0;
  var tipsShown = {};      // 每种怪的教学提示只弹一次
  var bossIdx = 0;
  var spawnAcc = 0;
  var eliteAcc = 0;
  var levelQueue = 0;
  var levelChoices = null;
  var killCount = 0;
  var soulCoins = 0;
  var reviveLeft = 0;
  var doubleUsed = false;
  var boostOffered = false;
  var boostUsed = false;
  var hitstop = 0;
  /* 色差脉冲：暴击/受伤时让画面边缘的 RGB 分离一瞬间加剧，
     是一种很便宜的「冲击」信号，比单纯震屏更细腻。 */
  var abPulse = 0;
  var hpBeat = 0;
  /* 残血状态的上一次取值。用来把「进入残血」判成**边沿**而不是**电平** ——
     这是个每帧都跑的判断，按电平计会把一次濒死记成几百次。
     同时它也是 Tele.nearDeath 的唯一调用点（那个字段原来
     定义了字段、定义了累加函数，却既没人调用也没人读，见 lint-static 规则 B）。 */
  var nearDeathOn = false;
  var lastCause = 'unknown';
  var statDmgDealt = 0;
  var statDmgTaken = 0;
  var liveFpsAvg = 0;
  var _fpsAcc = 0, _fpsN = 0, _fpsWorst = 999;
  var runFinished = false;
  var runSeq = 0;          // 用于让延迟回调识别过期对局
  var syncSim = false;     // 同步模拟模式（无人值守跑局）：帧率数据不可信
  var orbCombo = 0;        // 连续拾取灵气珠数：用于让拾取音越来越高
  var orbComboT = 0;

  /* ============================================================
   * 空间网格（用于分离与碰撞查询）
   * ============================================================ */
  var CELL = 4;
  var GW = Math.ceil(XS.ARENA.radius * 2.6 / CELL) + 2;
  var gridCells = [];
  var gridStamp = new Int32Array(GW * GW);
  var frameId = 0;
  /* 四块独立 scratch，避免嵌套查询互相覆盖 */
  var scratchSep = [];
  var scratchHit = [];
  var scratchBlast = [];
  var scratchSpread = [];   // 业火蔓延专用：killEnemy 会在伤害结算中途被调用
  (function () {
    for (var i = 0; i < GW * GW; i++) gridCells.push([]);
  })();

  function cellOf(x, z) {
    var cx = Math.floor((x + GW * CELL / 2) / CELL);
    var cz = Math.floor((z + GW * CELL / 2) / CELL);
    if (cx < 0 || cz < 0 || cx >= GW || cz >= GW) return -1;
    return cz * GW + cx;
  }

  function gridReset() { frameId++; }

  function gridAdd(e) {
    var c = cellOf(e.x, e.z);
    if (c < 0) return;
    if (gridStamp[c] !== frameId) { gridStamp[c] = frameId; gridCells[c].length = 0; }
    gridCells[c].push(e);
  }

  function gridQuery(x, z, radius, out) {
    out.length = 0;
    var r = Math.ceil(radius / CELL);
    var cx = Math.floor((x + GW * CELL / 2) / CELL);
    var cz = Math.floor((z + GW * CELL / 2) / CELL);
    for (var j = cz - r; j <= cz + r; j++) {
      if (j < 0 || j >= GW) continue;
      for (var i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= GW) continue;
        var c = j * GW + i;
        if (gridStamp[c] !== frameId) continue;
        var arr = gridCells[c];
        for (var k = 0; k < arr.length; k++) out.push(arr[k]);
      }
    }
    return out;
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  Game.init = function (sc) {
    scene = sc;

    TYPES.forEach(function (tp) {
      var geo = E.enemyGeo(tp);
      /* 用 Phong 而不是 Lambert：Lambert 是逐顶点光照，在这种低模上
         几乎等于没有明暗，妖魔会糊成纯黑剪影。逐像素高光 + 一点自发光
         才能让「体积」和「材质」读出来。 */
      var bodyMat = new T.MeshPhongMaterial({
        vertexColors: true,
        shininess: 22,
        specular: new T.Color(0x2a3a46),
        emissive: new T.Color(0x101c26),
        emissiveIntensity: 1.0
      });
      /* 元素色自发光：妖魔的暗部透出各自属性的光（赤/紫/血/冰）。
         没有这一层，低模在夜景里就只是几块黑影。 */
      if (geo.tint !== undefined) {
        bodyMat.emissive = new T.Color(geo.tint).multiplyScalar(tp === 'boss' ? 0.30 : 0.20);
      }
      /* 逐类型的材质微调。
         为什么需要它：全场妖魔共用一份材质，但造型分「曲面」和「平面」两种。
         曲面（ico 球）法线处处不同，镜面高光只是身上一小块亮斑；
         平面（盾牌、巨刃）法线处处相同，又正好落在半程向量附近 ——
         pow(dot(N,H), shininess) 在**整个面**上约等于 1，
         于是整块平面被镜面光刷成冷白，明暗全没了。
         实测：盾卫（大盾）和妖将（巨刃）都糊成白/粉团，而同屏的小妖、
         魔卒颜色完全正常。改固有色救不了 —— 只能把高光收束（抬 shininess）
         并压暗（降 specular）。写成一张表而不是一串 if，
         是为了下一个「平面造型」的妖魔能直接加一行，而不是再叠一个分支。 */
      var MAT_TWEAK = {
        /* 首领是英雄单位：暖色高光 + 更强自发光，免得在一堆小妖里糊成黑影 */
        boss: { shininess: 36, specular: 0x6a4a20 },
        /* 举大盾 */
        guard: { shininess: 110, specular: 0x141c28 },
        /* 扛巨刃 */
        elite: { shininess: 88, specular: 0x1a1424 }
      };
      if (MAT_TWEAK[tp]) {
        bodyMat.shininess = MAT_TWEAK[tp].shininess;
        bodyMat.specular = new T.Color(MAT_TWEAK[tp].specular);
      }
      var glowMat = new T.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95,
        blending: T.AdditiveBlending, depthWrite: false
      });
      var body = new T.InstancedMesh(geo.body, bodyMat, CAP[tp]);
      var glow = new T.InstancedMesh(geo.glow, glowMat, CAP[tp]);
      body.instanceMatrix.setUsage(T.DynamicDrawUsage);
      glow.instanceMatrix.setUsage(T.DynamicDrawUsage);
      body.frustumCulled = false;
      glow.frustumCulled = false;
      /* 必须按容量预分配 instanceColor。
         见 E.ensureInstanceColor 的注释：setColorAt 是按 this.count 分配缓冲区的，
         而这里紧接着就要把 count 归零 —— 不预分配的话缓冲区长度会是 0，
         所有染色静默失效，妖魔渲染成纯黑。 */
      E.ensureInstanceColor(body, CAP[tp]);
      body.count = 0;
      glow.count = 0;
      scene.add(body);
      scene.add(glow);
      R[tp] = { body: body, glow: glow, geo: geo, cap: CAP[tp] };
      byType[tp] = [];
    });

    /* 无障碍轮廓：每种妖魔一份反向外壳（几何体与本体共用，不额外占显存）。
       全部共享**同一个材质实例** —— 它们颜色和参数完全一样，
       共享能让渲染器少切几次状态；改成每类一份只会白白多 9 次 uniform 上传。 */
    var outlineMat = new T.MeshBasicMaterial({
      color: OUTLINE_COLOR,
      side: T.BackSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false            /* 见模块顶部注释：描边吃雾就失去意义了 */
    });
    /* 走查用：?outline=<hex|dark|light|cyan> 直接换描边色；
       ?outlinew=<米> 直接换描边宽度。
       为什么要这两个开关：描边色和宽度**都不能靠眼睛在缩略图上挑**。
       妖魔在本作里被照到接近奶白（自发光 + 辉光层），而且整个画面
       最后还要过一道 UnrealBloomPass —— 泛光会把细线糊开。
       一条 2~3 像素的描边在泛光之后几乎不剩对比，
       但这一点在缩略图上完全看不出来（「看起来还行」）。
       所以给一个能在同一次会话里快速换参数的入口，让结论由测量给。 */
    var oc = /[?&]outline=([#0-9a-zA-Z]+)/.exec(location.search);
    if (oc) {
      var v = oc[1].toLowerCase();
      if (v === 'dark') outlineMat.color.setHex(0x0b1220);
      else if (v === 'light') outlineMat.color.setHex(0xdff2ff);
      else if (v === 'cyan') outlineMat.color.setHex(0x16e0ff);
      else outlineMat.color.setHex(parseInt(v.replace('#', ''), 16) || OUTLINE_COLOR);
    }
    var ow = parseFloat((/[?&]outlinew=([\d.]+)/.exec(location.search) || [])[1]);
    if (isFinite(ow) && ow > 0) OUTLINE_W = ow;
    outlineMats.push(outlineMat);
    TYPES.forEach(function (tp) {
      var o = new T.InstancedMesh(R[tp].geo.body, outlineMat, CAP[tp]);
      o.instanceMatrix.setUsage(T.DynamicDrawUsage);
      o.frustumCulled = false;
      o.count = 0;
      o.visible = false;    /* 由 applyA11y() 按设置打开 */
      /* 必须排在状态外壳**之后**画。
         外壳是加色混合，描边是普通混合 —— 加色之间可以随便换顺序
         （加法可交换），但普通混合盖在加色上会把那一圈颜色直接替换掉。
         要让描边读得出来，就得让它压在辉光上面。
         不显式指定的话，两者都是 transparent，排序按距离，
         而它们位置几乎重合 —— 顺序会随视角抖动，表现为描边忽明忽暗。 */
      o.renderOrder = 3;
      scene.add(o);
      R[tp].outline = o;
      /* 按外廓反推这一类的放大倍数，见 OUTLINE_W 的注释 */
      var refR = Math.max(R[tp].geo.radius, R[tp].geo.height * 0.5, 0.20);
      R[tp].outlineK = 1 + OUTLINE_W / refR;
    });
    outlineMats.push(outlineMat);

    /* 稀有度标记：妖将 1 个「∨」，魔尊 2 个叠起来。
       一个 InstancedMesh 装下两种 —— 容量按「每只妖将 1 个 +
       每只魔尊 2 个」算。用同一个几何体、靠实例数量区分，
       比再建一份几何体省一个 drawcall，而「一个还是两个」照样可数。 */
    markers = new T.InstancedMesh(
      E.markerGeo(),
      new T.MeshBasicMaterial({
        color: 0xffd98a, transparent: true, opacity: 0.92,
        depthWrite: false, depthTest: false, fog: false
      }),
      CAP.elite + CAP.boss * 2
    );
    markers.instanceMatrix.setUsage(T.DynamicDrawUsage);
    markers.frustumCulled = false;
    markers.count = 0;
    markers.visible = false;
    markers.renderOrder = 20;   /* depthTest 关了，靠 renderOrder 保证画在最上层 */
    scene.add(markers);

    /* 刃光拖尾：贴图与几何体都只建一次，之后靠实例矩阵驱动 */
    var trailTex = E.bladeTrailTexture();
    var trailGeo = E.makeTrailGeo();
    swordTrail = new T.InstancedMesh(
      trailGeo,
      new T.MeshBasicMaterial({
        map: trailTex, transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, color: C.jadeSoft, side: T.DoubleSide
      }),
      SWORD_MAX
    );
    swordTrail.instanceMatrix.setUsage(T.DynamicDrawUsage);
    swordTrail.frustumCulled = false;
    swordTrail.count = 0;
    scene.add(swordTrail);

    qiTrail = new T.InstancedMesh(
      trailGeo,
      new T.MeshBasicMaterial({
        map: trailTex, transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, color: C.jade, side: T.DoubleSide
      }),
      QI_MAX
    );
    qiTrail.instanceMatrix.setUsage(T.DynamicDrawUsage);
    qiTrail.frustumCulled = false;
    qiTrail.count = 0;
    scene.add(qiTrail);

    /* 灵气珠 */
    orbMesh = new T.InstancedMesh(
      E.makeOrbGeo(),
      new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false }),
      420
    );
    orbMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    orbMesh.frustumCulled = false;
    orbMesh.count = 0;
    scene.add(orbMesh);

    /* 剑气弹体池 */
    var qiGeo = E.makeQiGeo();
    var qiMat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false });
    for (var i = 0; i < QI_MAX; i++) {
      var m = new T.Mesh(qiGeo, qiMat);
      m.visible = false;
      scene.add(m);
      qiPool.push({ mesh: m, alive: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, dmg: 0, pierce: 0, hit: [], life: 0, sc: 1 });
    }

    /* 妖巫术法弹池 */
    boltPool.length = 0;
    for (var bi = 0; bi < 64; bi++) {
      var bm = E.makeBolt();
      bm.visible = false;
      scene.add(bm);
      boltPool.push({ mesh: bm, alive: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, dmg: 0, life: 0, cause: 'swarm' });
    }

    /* 盾卫护罩光环：每只盾卫一个实例，缩放到各自的 aura 半径。
       容量就是盾卫上限 —— 光环和盾卫是一一对应的，多建没有意义。
       用玄冰蓝而不是雷白：满屏特效里白色是最先糊掉的颜色，
       而这一圈的信息量是「这里有减伤」，它必须比特效更耐看。 */
    guardAura = new T.InstancedMesh(
      E.auraGeo(),
      new T.MeshBasicMaterial({
        color: C.frost, transparent: true, opacity: 0.26,
        blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
      }),
      CAP.guard
    );
    guardAura.instanceMatrix.setUsage(T.DynamicDrawUsage);
    guardAura.frustumCulled = false;
    guardAura.count = 0;
    scene.add(guardAura);

    /* 特效池 */
    var specs = [
      { kind: 'thunder', n: 6 }, { kind: 'blast', n: 14 },
      { kind: 'pulse', n: 6 }, { kind: 'death', n: 14 }, { kind: 'frost', n: 3 },
      { kind: 'levelup', n: 3 }, { kind: 'omen', n: 4 }, { kind: 'field', n: 12 },
      { kind: 'charge', n: 3 }
    ];
    specs.forEach(function (sp) {
      for (var k = 0; k < sp.n; k++) {
        var mesh = E.makeFx[sp.kind]();
        mesh.visible = false;
        scene.add(mesh);
        fxPool.push({ kind: sp.kind, mesh: mesh, alive: false, t: 0, dur: 1, x: 0, y: 0, z: 0, r: 1 });
      }
    });

    /* 状态外壳：两层实例化壳，覆盖所有「中了状态」的妖魔。
       冰 / 火各一份几何体（晶体 vs 火舌），形状本身就是信息。 */
    shellFrost = E.makeStatusShell(STATUS_CAP, 'frost');
    shellBurn = E.makeStatusShell(STATUS_CAP, 'burn');
    scene.add(shellFrost);
    scene.add(shellBurn);

    /* 玩家 */
    playerMesh = E.makePlayer();
    playerMesh.visible = false;
    scene.add(playerMesh);

    /* 飞剑（按上限建满，进化后才有 mesh 可挂） */
    for (var s = 0; s < SWORD_MAX; s++) {
      var sw = E.makeSword();
      sw.visible = false;
      scene.add(sw);
      swordMeshes.push(sw);
    }

    /* 粒子爆发 */
    initBurst();

    var boostBtn = document.getElementById('boostBtn');
    if (boostBtn) boostBtn.onclick = function () { Game.onBoostAd(); };

    return Game;
  };

  /* ============================================================
   * 玩家数据
   * ============================================================ */
  function newPlayer() {
    return {
      x: 0, z: 0, y: 0,
      hp: XS.PLAYER.maxHp, maxHp: XS.PLAYER.maxHp,
      speed: XS.PLAYER.speed,
      radius: XS.PLAYER.radius,
      pickupRadius: XS.PLAYER.pickupRadius,
      invuln: 0, regen: 0,
      critChance: XS.PLAYER.critChance,
      critMult: XS.PLAYER.critMult,
      xpGain: XS.PLAYER.xpGain,
      damageReduction: 0,
      /* 局外成长给的全局伤害倍率（乘在最外层，见 dealDamage）。
         独立成字段而不是去改各功法的 apply()：进化会触发全量重算，
         塞进 apply() 的倍率会在重算时被抹掉。 */
      dmgMul: 1,
      level: 1, xp: 0, xpNeed: XS.xpForLevel(1),
      /* evolved：{ [基础功法 id]: true }。只在这里记事实，
         具体数值一律由 config.js 里各功法的 apply() 按这个标记算出来 ——
         避免「进化加成」散落在游戏逻辑里，改一次数值要翻五个文件。 */
      evolved: {},
      sword: { count: 1, damage: 9, radius: 3.0, speed: 1.55, angle: 0, echo: 0 },
      qi: { enabled: false, count: 0, damage: 0, pierce: 1, interval: 1.15, timer: 0, scale: 1 },
      thunder: { enabled: false, count: 0, damage: 0, interval: 3.0, radius: 2.2, timer: 0 },
      frost: { enabled: false, radius: 3.4, slow: 0, dps: 0, amp: 0 },
      ember: { enabled: false, damage: 0, radius: 2, chance: 0, spread: 0 },
      aura: { enabled: false, radius: 2.3, dps: 0, interval: 0.72, timer: 0 },
      taken: {},
      boostT: 0,
      faceX: 0, faceZ: 1,
      moveX: 0, moveZ: 0,
      speedNow: 0,
      gaitT: 0,          // 步态相位：驱动摆臂与侧摆
      lean: 0            // 躯干前倾角
    };
  }

  /* ============================================================
   * 清空战场
   *
   * 只留这一个实现：`Game.start` 和 `Game.quitToMenu` 都需要它。
   * 原先只有 `Game.start` 做这件事，于是「中途退出到主菜单」会把
   * 整片战场冻在开始界面背后 —— 妖魔不再移动，但一直在画。
   * 实测（?play=120 之后调用 quitToMenu）：实例数 193 → 193，
   * 76 只妖魔仍在渲染，而玩家已经回到主菜单了。
   * 表现上就是「主菜单背后飘着一堆不会动的怪」，很像资源泄漏。
   *
   * 这类「清理逻辑只写在其中一个入口」的 bug 会一直存在，
   * 直到有第二个入口为止 —— 而第二个入口往往是在很久以后才加上的。
   * ============================================================ */
  function clearBattlefield() {
    for (var ti = 0; ti < TYPES.length; ti++) {
      var tp = TYPES[ti];
      byType[tp].length = 0;
      R[tp].body.count = 0;
      R[tp].glow.count = 0;
      if (R[tp].outline) R[tp].outline.count = 0;
    }
    enemyTotal = 0;
    /* 状态外壳与护罩光环是跟着妖魔走的：妖魔清了它们必须一起清，
       否则主菜单上会留下一圈圈没有主人的光环。 */
    if (shellFrost) shellFrost.count = 0;
    if (shellBurn) shellBurn.count = 0;
    if (markers) markers.count = 0;
    if (guardAura) guardAura.count = 0;
    qiPool.forEach(function (q) { q.alive = false; q.mesh.visible = false; });
    boltPool.forEach(function (b) { b.alive = false; b.mesh.visible = false; });
    orbPool.length = 0;
    orbFree.length = 0;
    orbMesh.count = 0;
  }

  /* ============================================================
   * 开局
   * ============================================================ */
  Game.start = function () {
    clearBattlefield();
    fxPool.forEach(function (f) { f.alive = false; f.mesh.visible = false; });

    player = newPlayer();
    /* 局外强化在**这里**应用，而不是写进 newPlayer()：
       newPlayer 是「白板玩家」的定义，调试探针（?build / ?evo）
       需要能拿到未加成的基准。加成的入口只留一个。 */
    if (XS.Meta) XS.Meta.applyStart(player);
    playerMesh.position.set(0, 0, 0);
    playerMesh.visible = true;
    XS.UI.resetSkills();
    XS.UI.clearDamageNumbers();
    XS.UI.hideBoss();
    XS.UI.hideAll();
    XS.UI.setSkills([]);

    runT = 0; waveIdx = 0; bossIdx = 0; spawnAcc = 0; eliteAcc = 0;
    tipsShown = {};
    levelQueue = 0; levelChoices = null;
    killCount = 0; soulCoins = 0;
    /* 复活次数 = 广告位上限 + 局外「回魂」等级。
       写成加法而不是覆盖，是为了让「买了回魂」这件事在结算界面上
       表现为「剩余 4 次」而不是「剩余 2 次」—— 玩家要看得见自己买的东西。 */
    reviveLeft = XS.AD.revive.limit + (XS.Meta ? XS.Meta.reviveBonus() : 0);
    doubleUsed = false; boostOffered = false; boostUsed = false;
    hitstop = 0; lastCause = 'unknown';
    statDmgDealt = 0; statDmgTaken = 0;
    nearDeathOn = false;
    liveFpsAvg = 0; _fpsAcc = 0; _fpsN = 0; _fpsWorst = 999;
    runFinished = false;
    runSeq++;

    setBoostUi(false);

    Tele.startRun({});
    Tele.event('run_start', { t: 0 });
    state = 'playing';

    XS.UI.announce('仙台问剑', '斩尽妖魔，撑过 ' + U.fmtTime(XS.RUN_TIME), C.jade, 2200);
    XS.UI.tip('拖动摇杆（或 WASD）走位 · 攻击全自动 · 升级时三选一', 5200);
    XS.UI.setHp(player.hp, player.maxHp);
    if (swordTrail) swordTrail.count = 0;
    if (qiTrail) qiTrail.count = 0;
    if (shellFrost) shellFrost.count = 0;
    if (shellBurn) shellBurn.count = 0;
    if (markers) markers.count = 0;
    /* 落雷延迟队列必须清空：上一局残留在队列里的雷，
       会在新局开场 0.16 秒后劈到刚出生的妖魔身上。 */
    pendingStrikes.length = 0;
    XS.UI.setXp(0, player.xpNeed, 1);
    XS.UI.setTimer(0, XS.RUN_TIME);
    XS.UI.setKills(0);
    refreshSkillBar();
  };

  Game.state = function () { return state; };
  /* 本局进度 0→1。给场景层用（天空随破晓变色）——
     不把 runT 直接暴露出去，是因为「进度」才是场景想知道的量，
     暴露 runT 会让 world.js 也要知道 RUN_TIME 是多少。 */
  Game.runProgress = function () { return Math.min(1, runT / XS.RUN_TIME); };
  Game.player = function () { return player; };

  /* 一局对局的**权威**读数：计时 / 击杀 / 灵石 / 累计伤害。
     这是「一局进行到哪儿了」唯一的数据来源。

     为什么必须由游戏层提供：Web 版的诊断原本是去读 DOM 文本
     （`document.getElementById('killCount').textContent`）。
     那有两个问题：
       1. DOM 文本只能证明「HUD 画对了」，不能证明数值对 ——
          而 HUD 本身也是从这些量渲染出来的，等于绕一圈自己证自己。
       2. 小游戏**没有 DOM**，同一项在那边只能写成常量占位。
          我当时的占位是 `kills: null` —— 一个长得像读数、其实是
          常量的字段。两个宿主一对比就会得出「小游戏的击杀统计坏了」，
          而实际上只是诊断没接。 */
  Game.debugRun = function () {
    return {
      t: +runT.toFixed(2), kills: killCount, coins: soulCoins,
      level: player ? player.level : 1,
      dmgDealt: Math.round(statDmgDealt), dmgTaken: Math.round(statDmgTaken),
      /* 广告点位的两个前提条件，分开报：
         reviveLeft 是玩家还剩几次，adOk 是宿主能不能兑现。 */
      reviveLeft: reviveLeft,
      /* 神行符剩余秒数。三个广告点位里唯一一个**局内**的，
         走查要验「按下去了真的生效」，就得有这个读数。 */
      boostT: +(player && player.boostT > 0 ? player.boostT : 0).toFixed(2),
      adOk: !!(XS.Platform && XS.Platform.canShowAd && XS.Platform.canShowAd())
    };
  };
  Game.debugOrbs = function () { return orbPool; };
  Game.debugBolts = function () { return boltPool; };

  /* 地面危险区：魔尊裂地的预警法阵 + 妖狼的蓄力。
     机器人要能「看见」这些，否则它只会在原地被秒，
     测出来的难度是假的（那是机器人瞎，不是游戏难）。 */
  Game.debugHazards = function () {
    var out = [];
    for (var i = 0; i < fxPool.length; i++) {
      var f = fxPool[i];
      if (f.alive && f.kind === 'omen') {
        out.push({ x: f.mesh.position.x, z: f.mesh.position.z, r: f.r });
      }
    }
    var ch = byType['charger'];
    if (ch) {
      for (var j = 0; j < ch.length; j++) {
        if (ch[j].windT > 0) out.push({ x: ch[j].x, z: ch[j].z, r: 4.6 });
      }
    }
    return out;
  };
  Game.debugEnemies = function () { return byType; };
  Game.debugTypes = TYPES;

  /* 特效探针：列出当前活着的特效种类、位置与半径。
     画面里冒出一坨说不清是什么的东西时，靠它一眼定位是谁画的，
     比反复截图猜快得多。 */
  Game.debugFx = function () {
    var out = [];
    for (var i = 0; i < fxPool.length; i++) {
      var f = fxPool[i];
      if (!f.alive) continue;
      out.push({
        k: f.kind,
        x: Math.round(f.mesh.position.x * 10) / 10,
        z: Math.round(f.mesh.position.z * 10) / 10,
        r: Math.round((f.r || 0) * 100) / 100,
        t: Math.round(f.t * 100) / 100
      });
    }
    return out;
  };
  Game.debugStatus = function () {
    var n = 0, burn = 0, frozen = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].dead) continue;
        n++;
        if (arr[i].burnT > 0) burn++;
        if (arr[i].slowT > 0) frozen++;
      }
    }
    var out = {
      enemies: n, burning: burn, frozen: frozen,
      shellFrost: shellFrost ? shellFrost.count : -1,
      shellBurn: shellBurn ? shellBurn.count : -1
    };
    /* 受击闪光统计：高攻速下如果绝大多数妖魔都长期停在 flash≈1，
       整片怪会被"焊"在白色上 —— 这时候闪光不再传达"被打到了"，
       只是把美术糊掉。这个数字就是判断有没有焊死的依据。 */
    var hot = 0, fmax = 0, fsum = 0, m = 0;
    for (var tj = 0; tj < TYPES.length; tj++) {
      var a2 = byType[TYPES[tj]];
      for (var j = 0; j < a2.length; j++) {
        if (a2[j].dead) continue;
        m++;
        var fv = a2[j].flash || 0;
        if (fv > 0.5) hot++;
        if (fv > fmax) fmax = fv;
        fsum += fv;
      }
    }
    out.flash = {
      hotPct: m ? Math.round(hot / m * 100) : 0,
      max: Math.round(fmax * 100) / 100,
      avg: m ? Math.round(fsum / m * 100) / 100 : 0
    };
    /* 外壳的实际渲染状态：排查「明明写了矩阵却看不见」时，
       直接看缓冲里到底有没有颜色、有没有进场景、可见性如何。 */
    if (shellFrost) {
      var ic = shellFrost.instanceColor;
      var rr = function (v) { return Math.round(v * 1000) / 1000; };
      out.shell = {
        visible: shellFrost.visible,
        inScene: !!shellFrost.parent,
        opacity: shellFrost.material.opacity,
        blendAdd: shellFrost.material.blending === T.AdditiveBlending,
        vc: shellFrost.material.vertexColors,
        geoCol: !!shellFrost.geometry.attributes.color,
        ic0: ic ? [rr(ic.array[0]), rr(ic.array[1]), rr(ic.array[2])] : null,
        geoVC: shellFrost.geometry.attributes.color
          ? [rr(shellFrost.geometry.attributes.color.array[0]), rr(shellFrost.geometry.attributes.color.array[1])] : null,
        m0: shellFrost.instanceMatrix.array ? [
          rr(shellFrost.instanceMatrix.array[0]),
          rr(shellFrost.instanceMatrix.array[5]),
          rr(shellFrost.instanceMatrix.array[12]),
          rr(shellFrost.instanceMatrix.array[13])] : null
      };
    }
    out.a11y = Game.debugA11y();
    return out;
  };

  /* ============================================================
   * 无障碍走查
   *
   * 这个探针要回答的不是「设置存下来了吗」，而是
   * **「设置真的改变了画面吗」**。一个只写进 localStorage
   * 却没接到渲染上的开关，看起来完全正常：面板会亮、刷新还在、
   * 代码里搜得到 —— 但屏幕上什么都没变。这类开关比没有更糟，
   * 因为它会让玩家以为自己已经开了。
   *
   * 所以这里报的是**渲染侧的事实**：
   *   outlineOn  —— 轮廓网格的 visible（不是 Settings.colorblind）
   *   outlineCount / markerCount —— 实际写了多少个实例
   *   frostGeoFaces / burnGeoFaces —— 两种外壳的三角形数是否真的不同
   * 最后一项是关键：如果哪天有人把两个状态又合回一份几何体，
   * 面数会重新相等，这个探针立刻就能看出来。
   * ============================================================ */
  Game.debugA11y = function () {
    var S = XS.Settings || {};
    var o = {
      colorblind: !!S.colorblind,
      bigText: !!S.bigText,
      outlineW: OUTLINE_W,
      outlineK: R.elite && R.elite.outlineK ? Math.round(R.elite.outlineK * 1000) / 1000 : 0,
      outlineKImp: R.imp && R.imp.outlineK ? Math.round(R.imp.outlineK * 1000) / 1000 : 0,
      outlineOn: false, outlineCount: 0,
      markerOn: false, markerCount: 0,
      frostGeoFaces: 0, burnGeoFaces: 0,
      htmlClass: ''
    };
    if (R.elite && R.elite.outline) o.outlineOn = R.elite.outline.visible;
    if (outlineMats.length) o.outlineColor = outlineMats[0].color.getHexString();
    /* 这里必须逐个判 R[tp]：init 失败时 R 是半成品，
       而**诊断恰恰是在「系统坏了」的时候被调用的** ——
       它自己抛异常，等于在最需要信息的时候把信息丢掉，
       而且现场会变成「诊断报错」而不是「启动失败」，
       把排查方向整个带偏。 */
    TYPES.forEach(function (tp) { if (R[tp] && R[tp].outline) o.outlineCount += R[tp].outline.count; });
    if (markers) { o.markerOn = markers.visible; o.markerCount = markers.count; }
    if (shellFrost && shellFrost.geometry.attributes.position) {
      o.frostGeoFaces = shellFrost.geometry.attributes.position.count / 3;
    }
    if (shellBurn && shellBurn.geometry.attributes.position) {
      o.burnGeoFaces = shellBurn.geometry.attributes.position.count / 3;
    }
    var b = document.body;
    if (b) o.htmlClass = (b.className || '') + '|' + (b.style.fontSize || '');
    return o;
  };
  Game.setMenuHandlers = function (h) { mainHandlers = h; };

  /* ---------- 调试钩子：进化系统 ----------
   * 进化是「满级 + 前置达标」才会出现的稀有分支，正常跑一局要 5 分钟
   * 才可能看到一张进化卡。设计走查时不可能每次都等那么久，
   * 所以给一个确定性入口：直接灌等级，然后强制弹一次升级面板。
   */
  Game.debugGrant = function (spec) {
    for (var id in spec) {
      var u = XS.UPGRADE_MAP[id];
      if (!u) continue;
      var lv = Math.min(u.max, spec[id]);
      player.taken[id] = lv;
      u.apply(player, lv, true);
    }
    refreshSkillBar();
    return player.taken;
  };
  Game.debugEvolve = function (from) {
    var ev = XS.EVOLUTION_BY_FROM[from];
    if (!ev) return null;
    player.evolved[from] = true;
    reapplyAll();
    refreshSkillBar();
    return Game.debugBuild();
  };
  Game.debugForceLevelUp = function () { levelQueue++; openLevelUp(); };
  /* 当前这一屏三选一的**权威数据**（null = 不在升级状态）。
     暴露它是为了让「选牌策略」只有一份：
     两个宿主（Web 的 DOM 面板 / 小游戏的 Canvas 面板）都读这里，
     再把 XS.Bot.pickCard() 的返回值交给各自的 UI 去点。
     以前 Web 版是去抓 DOM 文本（`已习得 Lv3`）来判等级的 ——
     那套字符串匹配和这里读 `current` 字段**选出来的构筑不一样**，
     于是同条件跑出来的平衡数据对不上，看起来像移植引入了难度差异。 */
  Game.currentChoices = function () { return levelChoices; };
  /* ---------- 在玩家身前一字排开刷出指定妖魔（UI 走查 / 作品集截图）----------
   * 为什么需要它：新妖魔的造型只能在**真实光照、真实相机**下判断 ——
   * 而靠 ?play=N 去撞一张「它正好在画面里、又没弹出升级面板」的图，
   * 每次都要试好几遍，而且下次改动后又得重试。把「刷出来」变成一个参数，
   * 走查才是可重复的（同一个思路：?status=1 强制挂状态、?evo= 直接给功法）。
   *
   * 位置放在玩家**身前**（相机在玩家 +z 侧、看向 -z），
   * 这样它们必然在画面里，而不是散在场地边缘看不见。
   * 顺手把 spawnT 拉满：截图要的是成品造型，不是出场动画的中间帧。
   */
  Game.debugSpawn = function (spec) {
    var parts = String(spec).split(',');
    var list = [], i, k;
    for (i = 0; i < parts.length; i++) {
      var kv = parts[i].split(':');
      if (!XS.ENEMY[kv[0]]) continue;
      var n = parseInt(kv[1] || '1', 10);
      for (k = 0; k < n; k++) list.push(kv[0]);
    }
    /* 折行排布，而不是一条直线排到底：
       一行 5 个、每个间距 2.8，一行就是 14 米 —— 再长就超出场地半径，
       妖怪会被边缘夹回原位，摆出来的阵型跟写的不一样。
       走查工具的坐标算错，比没有走查工具更糟：你会照着错的图改美术。 */
    var PER_ROW = 5, GAP = 2.8;
    var out = [];
    for (i = 0; i < list.length; i++) {
      var row = Math.floor(i / PER_ROW);
      var col = i % PER_ROW;
      var inRow = Math.min(PER_ROW, list.length - row * PER_ROW);
      var e = spawnEnemy(list[i], 1, {
        x: player.x + (col - (inRow - 1) / 2) * GAP,
        z: player.z - 5.2 - row * 3.0
      });
      if (e) { e.spawnT = e.spawnDur; out.push(list[i]); }
    }
    return out;
  };

  /* ============================================================
   * 无障碍演示场（?a11ydemo=1）
   *
   * 为什么需要一个**专用固定阵型**，而不是在实战里找两帧来对比：
   * 无障碍要证明的是「开了以后每一类妖魔都更清楚」。实战截图里
   * 妖怪的站位、朝向、状态、有没有被击杀全是随机的 ——
   * 开 / 关两张图会有几十处差异，你分不清哪一处是功能带来的，
   * 哪一处只是「这次刷的怪不一样」。
   * 摆一个固定阵型，两张图**只差一个开关**，差异才能唯一地归因到功能。
   * 这也是作品集里唯一说得清的做法：一张开/关并排图，
   * 比十张漂亮的实战图更有说服力 —— 后者证明不了任何事。
   *
   * 阵型（三排，玩家在原点时相机必然拍全）：
   *   第一排 5 只 · 全部冰缓
   *   第二排 5 只 · 全部灼烧      ← 两排并排，形状差异一眼可辨
   *   第三排 妖将×2 + 魔尊×2     ← 展示「∨」标记：1 个 vs 2 个
   *
   * 状态用**同一批类型**（前两排同一套 5 种怪），
   * 这样「冰壳和火壳长得不一样」不会被「怪本身就不一样」掩盖掉。
   * ============================================================ */
  Game.debugA11yDemo = function () {
    var out = [];

    /* status: 'frost' | 'burn' | null */
    function place(type, x, z, status) {
      var e = spawnEnemy(type, 1, { x: player.x + x, z: player.z + z });
      if (!e) return null;
      /* 把坐标**钉死**。
       *
       * spawnEnemy 的 at 分支并不是「放到这个坐标」，而是
       * 「在这个坐标附近随机散开」—— 它按 `radius + 0.25` 的半径
       * 随机取角度，是给裂魔分裂用的（子体不能完全重叠）。
       * 拿它当定点摆放用，两次跑出来的阵型就不一样：
       * 实测同一个 ?a11ydemo 两次，第一只怪的 x 差了 0.43。
       * 这直接毁掉 A/B：开/关两张图的差异里混进了「这次站得偏了一点」，
       * 而像素差分分不清哪些差异是功能带来的。
       * 走查工具一旦不确定，它给出的结论就不能用。 */
      e.x = player.x + x;
      e.z = player.z + z;
      /* wob 决定外壳呼吸与身体起伏的相位，也必须钉死 */
      e.wob = (x + z) * 0.37;
      e.auraPulse = e.wob;
      /* 直接拉到出场动画结束：截图要的是成品造型，不是材质化的中间帧 */
      e.spawnT = e.spawnDur;
      /* 冻住不动，否则几帧之后阵型就开始走样 */
      e.speed = 0;
      e.flash = 0; e.flashCd = 0;
      if (status === 'frost') { e.slowT = 9999; e.slow = 0.5; }
      else if (status === 'burn') {
        e.burnT = 9999; e.burnDps = 0;
        /* 跳伤节拍器往后推，免得第一帧就跳一次（虽然 0 伤害已经不闪了） */
        e.burnTick = 9999;
      }
      out.push(type + (status ? ':' + status : ''));
      return e;
    }

    /* 阵型用一张显式表，不用循环拼。
     *
     * 间距必须给得比直觉大。第一版照抄 debugSpawn 的间距（2.8 / 行距 3.0），
     * 十只怪挤在屏幕中间一小块里 —— 状态外壳是**加色**的，重叠之后互相叠加，
     * 整片糊成一个白团，轮廓和形状全都看不见。这不是外壳太亮
     * （每只怪身上的壳数量和透明度都没变），而是**取样太密**：
     * 加色层的信息量在重叠时被摧毁。拉开之后每只都有自己的暗底背景。
     *
     * 另一个关键设计：**每排都留出不挂状态的怪**。
     * 只摆满状态的怪，看的人无法回答「这个壳是本来就这样，还是新加的」——
     * 对照组必须出现在同一张图里、同样的光照下、同样的距离上。
     * 有了对照组，一张图同时回答三个问题：
     *   ① 描边有没有用（有状态 / 无状态都能看）
     *   ② 冰和火形状是否可辨（并排两种壳）
     *   ③ 妖将和魔尊的标记是否可数（1 个 ∨ vs 2 个 ∨）
     *
     * 状态取值：'frost' | 'burn' | null */
    var ROWS = [
      { z: -8.5,  x0: -12.6, gap: 8.4,
        items: [['imp', 'frost'], ['brute', null], ['guard', 'burn'], ['flyer', null]] },
      { z: -15.5, x0: -12.6, gap: 8.4,
        items: [['imp', 'burn'], ['brute', null], ['guard', 'frost'], ['flyer', null]] },
      /* 妖将 / 魔尊放最远一排：它们体量大，摆近了会把前面两排全挡住 */
      { z: -21.5, x0: -11.25, gap: 7.5,
        items: [['elite', 'frost'], ['elite', null], ['boss', 'burn'], ['boss', null]] }
    ];
    for (var r = 0; r < ROWS.length; r++) {
      var row = ROWS[r];
      for (var c = 0; c < row.items.length; c++) {
        place(row.items[c][0], row.x0 + c * row.gap, row.z, row.items[c][1]);
      }
    }
    return out;
  };

  /* 走查用：单独显示本体层或辉光层（?layer=body / ?layer=glow）。
   *
   * 为什么必须能分开看：「这只怪糊成一片白」是个**症状**，不是病因。
   * 病因至少有两种，而且改法完全相反 ——
   *   ① 本体被照爆（该压光照 / 压自发光），
   *   ② 辉光层叠得太多糊住了本体（该减辉光件数 / 降不透明度）。
   * 合图上看，两者都只是「一片白」。分层拍一张，答案立刻唯一。
   * 我这次就是先猜了 ②，结果探针显示顶点色、实例色、材质色全都正常，
   * 才不得不把层拆开 —— 这个开关就是那次弯路换来的。 */
  Game.debugLayer = function (mode) {
    var wantBody = mode === 'body', wantGlow = mode === 'glow';
    var n = 0;
    TYPES.forEach(function (tp) {
      if (!R[tp]) return;
      R[tp].body.visible = wantBody;
      R[tp].glow.visible = wantGlow;
      n++;
    });
    return n;
  };

  /* ---------- 给试玩机器人的建议 ----------
   * 机器人是**测量工具**，它要模拟的是「会玩的人」，不是「随机点牌的人」。
   *
   * 之前它的策略是「核心功法堆到 4 级，然后每样新功法点一级」——
   * 结果是 8 局里一次进化都没触发（evolve 0%），进化系统等于没被测到。
   * 但这不是进化系统的错，是这个策略根本不成立：没有任何一个玩家
   * 会在看到「万剑归宗 —— 需太上忘情 Lv3」之后，还是每样都点一级。
   *
   * 所以这里给一个「有目标的玩家」的决策：一旦在某个进化上起步了，
   * 就先把基础功法推到圆满，再把前置补够。没起步的进化一律不管 ——
   * 否则它会把每一条线都开一半，又变回「什么都点一点」。
   */
  Game.botAdvice = function () {
    for (var i = 0; i < XS.EVOLUTIONS.length; i++) {
      var ev = XS.EVOLUTIONS[i];
      if (player.evolved[ev.from]) continue;
      var baseLv = player.taken[ev.from] || 0;
      var reqLv = player.taken[ev.req.id] || 0;
      /* 只有「已经投进去了」的线才去追。
         门槛设在 3 级基础 / 2 级前置：这既对应真实玩家的心理
         （「我剑都点到 4 了，干脆点满看看能进化成什么」），
         也避免机器人在 1 级就为某条线锁死整局构筑。 */
      if (baseLv < 3 && reqLv < 2) continue;
      var baseMax = XS.UPGRADE_MAP[ev.from].max;
      if (baseLv < baseMax) return ev.from;               // 先推满基础
      if (reqLv < ev.req.lv) return ev.req.id;            // 再补前置
    }
    return null;
  };

  /* 玩家侧的目标提示：当前正在追的进化（HUD 用） */
  Game.evoGoal = function () {
    for (var i = 0; i < XS.EVOLUTIONS.length; i++) {
      var ev = XS.EVOLUTIONS[i];
      if (player.evolved[ev.from]) continue;
      var baseLv = player.taken[ev.from] || 0;
      var reqLv = player.taken[ev.req.id] || 0;
      if (baseLv === 0 && reqLv === 0) continue;
      return {
        from: ev.from, reqId: ev.req.id,
        name: ev.name,
        baseName: (XS.UPGRADE_MAP[ev.from] || {}).name || ev.from,
        baseLv: baseLv, baseMax: XS.UPGRADE_MAP[ev.from].max,
        reqName: (XS.UPGRADE_MAP[ev.req.id] || {}).name || ev.req.id,
        reqLv: reqLv, reqNeed: ev.req.lv
      };
    }
    return null;
  };
  /* 构筑快照：一眼看清这一局到底堆了什么、进化了没有 */
  Game.debugBuild = function () {
    return {
      level: player.level,
      taken: JSON.parse(JSON.stringify(player.taken)),
      evolved: JSON.parse(JSON.stringify(player.evolved)),
      swordCount: player.sword.count,
      swordDmg: Math.round(player.sword.damage * 10) / 10,
      qiCount: player.qi.count,
      qiPierce: player.qi.pierce,
      thunderCount: player.thunder.count,
      frostAmp: player.frost.amp,
      emberChance: Math.round(player.ember.chance * 100) / 100,
      emberSpread: player.ember.spread,
      auraDps: Math.round(player.aura.dps * 10) / 10,
      dmgReduction: Math.round(player.damageReduction * 1000) / 1000,
      choices: levelChoices ? levelChoices.map(function (c) { return c.id + (c.evo ? '(进化)' : ''); }) : []
    };
  };
  /* 局外成长快照：验证「永久强化真的进了这一局」。
     只看存档是不够的 —— 存档里有等级、但没进 player，是两回事。 */
  Game.debugMeta = function () {
    if (!XS.Meta) return null;
    /* 等级表从 XS.META_UPGRADES 现算，不手抄。
       手抄过一次的后果：删掉「回魂」、加了「灵韵」之后，
       诊断里还在报 revive、看不到 pickup —— 诊断本身开始说谎，
       而诊断是唯一用来判断「改动有没有生效」的东西，它一说谎就没救了。 */
    var lv = {};
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      var id = XS.META_UPGRADES[i].id;
      lv[id] = XS.Meta.lv(id);
    }
    return {
      offline: !!XS.Meta.offline,
      coins: XS.Meta.data.coins,
      up: JSON.parse(JSON.stringify(XS.Meta.data.up)),
      lv: lv,
      reviveLeft: reviveLeft,
      ach: XS.Meta.achCount(),
      codex: XS.Meta.codexCount(),
      codexTotal: XS.Meta.codexTotal(),
      applied: player ? {
        maxHp: player.maxHp, dmgMul: Math.round(player.dmgMul * 1000) / 1000,
        speed: Math.round(player.speed * 100) / 100,
        xpGain: Math.round(player.xpGain * 1000) / 1000,
        pickupRadius: Math.round(player.pickupRadius * 100) / 100
      } : null
    };
  };

  /* ============================================================
   * 刷怪
   * ============================================================ */
  /* at 用于「原地生成」——目前只有裂魔分裂走这条路：
     子体必须出现在母体倒下的位置，而不是从台沿的刷怪环重新走进来。 */
  function spawnEnemy(type, hpMul, at) {
    var def = XS.ENEMY[type];
    if (byType[type].length >= CAP[type]) return null;
    var diff = XS.diffAt(runT);

    var px = player ? player.x : 0, pz = player ? player.z : 0;
    var ang = Math.random() * Math.PI * 2;
    var R0 = XS.ARENA.spawnRadius;
    var ex = 0, ez = 0;
    if (at) {
      /* 分裂：在母体位置稍微散开，否则两只子体会完全重叠、
         被分离力推开之前先叠成一个 —— 看起来像只裂出了一只。 */
      var sa = Math.random() * Math.PI * 2;
      ex = at.x + Math.cos(sa) * (def.radius + 0.25);
      ez = at.z + Math.sin(sa) * (def.radius + 0.25);
    } else {
      for (var attempt = 0; attempt < 8; attempt++) {
        var tx = Math.cos(ang) * R0, tz = Math.sin(ang) * R0;
        if (Math.hypot(tx - px, tz - pz) > 13) break;
        ang = Math.random() * Math.PI * 2;
      }
      ex = Math.cos(ang) * R0;
      ez = Math.sin(ang) * R0;
    }

    var e = {
      type: type, def: def,
      x: ex, z: ez,
      y: 0,
      hp: def.hp * hpMul, maxHp: def.hp * hpMul,
      speed: def.speed * diff.spd * U.rand(0.9, 1.12),
      dmg: def.dmg * diff.dmg,
      radius: def.radius,
      mass: def.mass,
      xp: def.xp,
      flash: 0, slow: 0, slowT: 0,
      /* 受击闪光的冷却。高攻速下（5 把飞剑 + 剑气 + 罡气 + 冰域）
         同一只怪每秒会被打十来次，如果每次命中都无条件把 flash 拉满，
         整片怪就长期停在白色上 —— 闪光不再传达「被打到了」，
         只是把美术糊掉。加冷却后每只怪约 4Hz 闪一下，读作「挨打」。
         实测：不冷却时同屏 50% 的妖魔 flash > 0.5。 */
      flashCd: 0,
      /* 灼烧：烈焰符点燃后的持续伤害。burnT 归零即熄灭。
         burnTick 是跳伤节拍器 —— 每 0.4 秒跳一次，而不是每帧扣，
         否则飘字和音效会糊成一片噪音。 */
      burnT: 0, burnDps: 0, burnTick: 0, burnSfx: 0,
      swordCd: 0, auraCd: 0, frostCd: 0,
      spawnT: 0, wob: Math.random() * 6.28,
      /* 首领的出场过程拉长到 1.5 秒，配合地面法阵读作「降临」 */
      spawnDur: type === 'boss' ? 1.5 : (at ? 0.22 : 0.38),
      recoil: 0,                 // 受击回弹计时：驱动压扁形变
      /* 妖巫：施法前摇与冷却；妖狼：蓄力 / 冲刺 / 冷却 */
      fireCd: 0.8 + Math.random() * 1.6, castT: 0,
      windT: 0, dashT: 0, dashCd: 1.2 + Math.random() * 2.0, dashVX: 0, dashVZ: 0,
      /* 魔尊第二套招式「弹幕环」：与裂地共用同一套冷却计时，
         靠 barrageT 区分当前起手的是哪一招 */
      barrageT: 0,
      /* 上一招是不是弹幕环 —— 用来做「严格交替」，
         保证第二套招式不是随机出现，而是可以学会的节奏 */
      lastBarrage: false,
      /* 盾卫护罩的视觉脉冲（纯表现，不参与判定） */
      auraPulse: Math.random() * 6.28,
      /* 当前受到的护罩减伤，由 updateGuardAuras 每帧覆写。
         出生时先给 0，免得「刚裂出来的子体」在那一帧读到 undefined。 */
      auraCut: 0,
      isBoss: type === 'boss', isElite: type === 'elite',
      faceA: 0, dead: false
    };
    byType[type].push(e);
    enemyTotal++;
    /* 图鉴解锁：首次见到即点亮。热路径，Meta.seeEnemy 内部先查表短路。 */
    if (XS.Meta) XS.Meta.seeEnemy(type);
    return e;
  }

  function killEnemy(e, silent) {
    if (e.dead) return;
    var arr = byType[e.type];
    var idx = arr.indexOf(e);
    if (idx === -1) return;
    e.dead = true;
    arr[idx] = arr[arr.length - 1];
    arr.pop();
    enemyTotal--;
    /* 起手阶段被打死的话，地面的预警法阵要一起收掉，
       否则会在原地留下一圈永远转的红环。 */
    if (e.omenFx) { e.omenFx.alive = false; e.omenFx.mesh.visible = false; e.omenFx = null; }
    /* 蓄力环同理 —— 任何「挂在怪身上的持续特效」都必须在这里一起收，
       漏一个就会留下一个没有主人的光环（这套代码里已经踩过一次）。 */
    if (e.chargeFx) { e.chargeFx.alive = false; e.chargeFx.mesh.visible = false; e.chargeFx = null; }

    killCount++;
    Tele.kill(runT, e.type, e.xp);

    var drops = e.isBoss ? 26 : (e.isElite ? 9 : 1);
    for (var i = 0; i < drops; i++) {
      spawnOrb(e.x, e.z, Math.max(1, Math.round(e.xp / drops)));
    }

    if (!silent) {
      var fx = takeFx('death');
      if (fx) {
        fx.alive = true; fx.t = 0; fx.dur = e.isBoss ? 1.1 : 0.5;
        fx.x = e.x; fx.y = 0.4; fx.z = e.z;
        fx.r = e.radius * (e.isBoss ? 6 : 2.2);
        fx.mesh.visible = true;
        fx.mesh.position.set(e.x, 0.4, e.z);
      }
    }

    if (e.isBoss) {
      Tele.event('boss_kill', { t: runT, type: e.type });
      Tele.milestone(runT, 'boss_kill');
      Tele.bossKill();
      Sfx.play('bossDie', 1);
      XS.UI.hideBoss();
      XS.UI.announce('魔尊伏诛', '灵石 +300', C.gold, 2200);
      soulCoins += 300;
      hitstop = 0.42;               // 顿帧即慢动作：全场凝固一拍再爆开
      XS.Core.addShake(1.0);
      abPulse = 1;
      burstParticles(e.x, e.z, 26, C.gold);
      groundWave(e.x, e.z, 15, C.gold, 1.0);
    } else if (e.isElite) {
      XS.UI.announce('妖将已斩', '', C.purple, 1200);
      XS.Core.addShake(0.35);
      burstParticles(e.x, e.z, 10, C.purple);
      groundWave(e.x, e.z, 6.5, C.purple, 0.62);
      soulCoins += 20;
    } else {
      XS.Core.addShake(0.05);
      soulCoins += 1;
    }

    /* ---------------- 裂魔：倒下时分裂 ----------------
     * 给「击杀」本身加一层代价：贴着脸把它打死，子体会直接糊在你身上。
     * 这是这个敌人存在的全部理由 —— 它不靠血量或伤害制造难度，
     * 而是让「在哪里清场」第一次变成一个需要考虑的决定。
     *
     * 三条约束，缺一条这个机制就会失控：
     *  1) 子体不再分裂（def.noSplit）—— 否则是指数爆炸，一次清场刷出上百只；
     *  2) 走 spawnEnemy，因此天然受 CAP 限制 —— 不会因为分裂把同屏数顶穿；
     *  3) silent 时不分裂 —— 那是收尾清场，不是玩家打死的。
     * 血量倍率从 maxHp/def.hp 反推，而不是额外存一个字段：
     * 存的字段会在某条路径上忘记赋值，反推永远和本体一致。
     */
    if (!silent && e.def && e.def.splitInto && !e.def.noSplit) {
      var hm = e.maxHp / e.def.hp;
      var n = e.def.splitCount || 2;
      for (var ci = 0; ci < n; ci++) {
        spawnEnemy(e.def.splitInto, hm, { x: e.x, z: e.z });
      }
      /* 视觉上要「裂开」而不是「凭空多两只」 */
      burstParticles(e.x, e.z, 7, C.moss);
      groundWave(e.x, e.z, 2.6, C.moss, 0.42);
    }

    /* 焚天业火：被烧死的妖魔把火种溅到附近同类身上。
       只传「点燃」、不立刻结算伤害 —— 若在这里直接炸一次，
       死一只引爆一片、一片再引爆更大一片，会滚成不可控的雪崩，
       帧率也会跟着崩。传火种是可控的：它只是把 DOT 铺开。 */
    if (player.ember.spread && e.burnT > 0) {
      gridQuery(e.x, e.z, player.ember.radius, scratchSpread);
      var spread = 0;
      for (var si = 0; si < scratchSpread.length && spread < 3; si++) {
        var o = scratchSpread[si];
        if (o.dead || o === e || o.burnT > 0) continue;
        if (Math.hypot(o.x - e.x, o.z - e.z) > player.ember.radius) continue;
        ignite(o, e.burnDps, 2.4);
        spread++;
      }
    }
  }

  /* 地面冲击波：一圈贴地扩散的光环。
     大怪倒下如果只是「消失」，玩家是感觉不到分量的；
     一圈从脚下扫出去的环，才能把「这一下很重」传出来。 */
  function groundWave(x, z, radius, color, dur) {
    var fx = takeFx('pulse');
    if (!fx) return;
    var ring = fx.mesh.userData.refs.ring;
    if (ring) ring.material.color.set(color);
    fx.alive = true; fx.t = 0; fx.dur = dur || 0.6;
    fx.r = radius;
    fx.mesh.visible = true;
    fx.mesh.position.set(x, 0.07, z);
  }

  /* ============================================================
   * 灵气珠
   * ============================================================ */
  function spawnOrb(x, z, value) {
    var o;
    if (orbFree.length) { o = orbFree.pop(); }
    else if (orbPool.length < 420) { o = { alive: false }; orbPool.push(o); }
    else return;
    o.alive = true;
    o.x = x + U.rand(-0.5, 0.5);
    o.z = z + U.rand(-0.5, 0.5);
    o.y = U.rand(0.4, 1.2);
    o.vx = U.rand(-2, 2); o.vz = U.rand(-2, 2); o.vy = U.rand(2, 5);
    o.value = value;
    o.mag = false;
    o.life = 26;
  }

  function updateOrbs(dt) {
    /* 连击窗口：一段时间不捡就归零，音高回落 */
    if (orbComboT > 0) {
      orbComboT -= dt;
      if (orbComboT <= 0) orbCombo = 0;
    }
    var pr = player.pickupRadius;
    var pr2 = pr * pr;
    for (var i = 0; i < orbPool.length; i++) {
      var o = orbPool[i];
      if (!o.alive) continue;

      var dx = player.x - o.x, dz = player.z - o.z;
      var d2 = dx * dx + dz * dz;

      if (!o.mag && d2 < pr2) o.mag = true;
      if (o.mag) {
        var d = Math.sqrt(d2) || 0.001;
        var pull = 26 + (pr - d) * 8;
        o.vx += dx / d * pull * dt;
        o.vz += dz / d * pull * dt;
        o.vy += 8 * dt;
      } else {
        o.vx *= (1 - 3.2 * dt);
        o.vz *= (1 - 3.2 * dt);
        o.vy -= 22 * dt;
      }
      o.x += o.vx * dt; o.z += o.vz * dt; o.y += o.vy * dt;
      if (o.y < 0.35) { o.y = 0.35; o.vy = Math.abs(o.vy) * 0.35; if (o.vy < 0.4) o.vy = 0; }

      o.life -= dt;
      if (o.life <= 0) { o.alive = false; orbFree.push(o); continue; }

      if (d2 < 0.85 * 0.85) {
        o.alive = false;
        orbFree.push(o);
        gainXp(o.value);
        orbCombo = Math.min(orbCombo + 1, 16);
        orbComboT = 1.15;
        Sfx.play('orb', 0.9, orbCombo);
      }
    }
  }

  function writeOrbMatrices() {
    var arr = orbMesh.instanceMatrix.array;
    var n = 0;
    for (var i = 0; i < orbPool.length; i++) {
      var o = orbPool[i];
      if (!o.alive) continue;
      if (n >= 420) break;
      var off = n * 16;
      var sc = 1 + Math.sin(runT * 5 + i) * 0.14;
      arr[off] = sc; arr[off + 1] = 0; arr[off + 2] = 0; arr[off + 3] = 0;
      arr[off + 4] = 0; arr[off + 5] = sc * 1.25; arr[off + 6] = 0; arr[off + 7] = 0;
      arr[off + 8] = 0; arr[off + 9] = 0; arr[off + 10] = sc; arr[off + 11] = 0;
      arr[off + 12] = o.x; arr[off + 13] = o.y; arr[off + 14] = o.z; arr[off + 15] = 1;
      n++;
    }
    orbMesh.count = n;
    orbMesh.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
   * 经验与升级
   * ============================================================ */
  function gainXp(v) {
    var gain = v * player.xpGain;
    player.xp += gain;
    Tele.collectXp(gain);
    var guard = 0;
    while (player.xp >= player.xpNeed && guard++ < 12) {
      player.xp -= player.xpNeed;
      player.level++;
      player.xpNeed = XS.xpForLevel(player.level);
      levelQueue++;
      Tele.levelUp(player.level);
      /* 升级仪式感：脚下炸金环 + 冲天光柱 + 全屏金光 */
      var lfx = takeFx('levelup');
      if (lfx) {
        lfx.alive = true; lfx.t = 0; lfx.dur = 0.85;
        lfx.r = 1;
        lfx.mesh.visible = true;
        lfx.mesh.position.set(player.x, 0, player.z);
      }
      XS.Core.grade.uniforms.uHeal.value = Math.min(1.2, XS.Core.grade.uniforms.uHeal.value + 0.85);
    }
    if (levelQueue > 0 && state === 'playing') openLevelUp();
  }

  /* 三选一抽卡
   *
   * 进化卡**固定占第一格**，不参与权重抽卡。
   * 理由：进化是这一局的目标，如果它还要跟普通功法抢概率，
   * 玩家永远抽不到，「有目标感」就成了空话。
   * 进化是一次性的（拿到就不再出现），所以不会刷屏。 */
  function rollChoices() {
    var out = [];

    var evos = XS.availableEvolutions(player.taken, player.evolved);
    if (evos.length) {
      var ev = evos[Math.floor(Math.random() * evos.length)];
      out.push({
        id: ev.id, evo: ev, name: ev.name, icon: ev.icon, tag: '进化',
        max: 0, current: 0,
        desc: ev.desc + '（前置：' + XS.evoReqText(ev) + '）'
      });
    }

    var pool = [];
    for (var i = 0; i < XS.UPGRADES.length; i++) {
      var u = XS.UPGRADES[i];
      if ((player.taken[u.id] || 0) >= u.max) continue;
      pool.push(u);
    }
    var avail = pool.slice();
    while (out.length < 3 && avail.length) {
      var pick = U.pickWeighted(avail, function (u) {
        var cur = player.taken[u.id] || 0;
        return u.weight * (cur === 0 ? 1.35 : 1);
      });
      if (!pick) break;
      avail.splice(avail.indexOf(pick), 1);
      out.push(pick);
    }
    return out;
  }

  /* 进化后把所有已学功法重跑一遍
   *
   * 进化只改了一个布尔标记，真正的数值变化发生在各功法的 apply() 里，
   * 所以必须重算。re = true 让 apply 跳过「升级时回血」这类一次性副作用
   * —— 否则进化一次会白送一口血，而且以后每加一次技能都在送。 */
  function reapplyAll() {
    for (var i = 0; i < XS.UPGRADES.length; i++) {
      var u = XS.UPGRADES[i];
      var lv = player.taken[u.id] || 0;
      if (lv > 0) u.apply(player, lv, true);
    }
  }

  function openLevelUp() {
    levelQueue--;
    var choices = rollChoices();
    if (!choices.length) {
      player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.3);
      XS.UI.setHp(player.hp, player.maxHp);
      if (levelQueue > 0) openLevelUp();
      return;
    }
    state = 'levelup';
    Sfx.play('levelup', 1);
    levelChoices = choices.map(function (u) {
      return {
        id: u.id, evo: u.evo, name: u.name, icon: u.icon, tag: u.tag, max: u.max,
        current: u.current !== undefined ? u.current : (player.taken[u.id] || 0),
        desc: typeof u.desc === 'function' ? u.desc(player.taken[u.id] || 0) : u.desc
      };
    });
    Tele.event('level_up', {
      t: runT, level: player.level,
      offered: levelChoices.map(function (c) { return c.id; })
    });
    XS.UI.setXp(player.xp, player.xpNeed, player.level);
    XS.UI.showUpgrades(levelChoices, player.level, onPickUpgrade);
  }

  function onPickUpgrade(c) {
    /* ---- 进化卡 ---- */
    if (c.evo) {
      var ev = c.evo;
      player.evolved[ev.from] = true;
      reapplyAll();
      Tele.evolve(runT, ev.id, ev.from);
      if (XS.Meta) XS.Meta.seeEvo(ev.from);
      Sfx.play('levelup', 1);
      XS.Core.grade.uniforms.uHeal.value = 1.1;
      XS.Core.addShake(0.30);
      abPulse = 0.8;
      /* 进化是全局变强，脚下给一圈金色冲击波当「开窍」的仪式感 */
      groundWave(player.x, player.z, 9, C.gold, 0.9);
      burstParticles(player.x, player.z, 18, C.gold);
      XS.UI.hideUpgrades();
      refreshSkillBar();
      XS.UI.setHp(player.hp, player.maxHp);
      XS.UI.setXp(player.xp, player.xpNeed, player.level);
      XS.UI.announce('功法进化 · ' + ev.name, '威能大涨', C.gold, 2400);
      state = 'playing';
      if (levelQueue > 0) openLevelUp();
      return;
    }

    var def = XS.UPGRADE_MAP[c.id];
    if (!def) { XS.UI.hideUpgrades(); state = 'playing'; return; }
    var lv = (player.taken[c.id] || 0) + 1;
    player.taken[c.id] = lv;
    def.apply(player, lv);
    if (XS.Meta) XS.Meta.seeSkill(c.id);
    Tele.upgradePick(runT, c.id, lv, levelChoices ? levelChoices.map(function (x) { return x.id; }) : []);
    Sfx.play('ui', 0.8);
    XS.UI.hideUpgrades();
    refreshSkillBar();
    XS.UI.setHp(player.hp, player.maxHp);
    XS.UI.setXp(player.xp, player.xpNeed, player.level);
    var hint = XS.EVOLUTION_BY_FROM[c.id];
    /* 满级了就把「下一步能进化成什么」直接说出来 ——
       否则玩家不知道自己在追什么，构筑目标感就断在这里。 */
    if (hint && !player.evolved[c.id] && lv >= def.max) {
      XS.UI.announce('习得 ' + def.name + ' · 圆满', '可进化：' + hint.name + '（需 ' + XS.evoReqText(hint) + '）',
        C.gold, 2600);
    } else {
      XS.UI.announce('习得 ' + def.name, 'Lv ' + lv, XS.TAG_COLOR[def.tag] || C.jade, 1200);
    }
    XS.Core.grade.uniforms.uHeal.value = 0.9;
    state = 'playing';
    if (levelQueue > 0) openLevelUp();
  }

  function refreshSkillBar() {
    var list = [];
    for (var i = 0; i < XS.UPGRADES.length; i++) {
      var u = XS.UPGRADES[i];
      var lv = player.taken[u.id] || 0;
      if (lv > 0) {
        list.push({
          id: u.id, name: u.name, icon: u.icon, tag: u.tag, level: lv,
          evolved: !!player.evolved[u.id]
        });
      }
    }
    XS.UI.setSkills(list);
  }

  /* ============================================================
   * 伤害
   * ============================================================ */
  function dealDamage(e, amount, opt) {
    opt = opt || {};
    if (e.dead) return 0;
    /* 0 伤害不该产生任何受击反馈。
     *
     * 这不是理论问题：灼烧的跳伤节拍器（见 updateEnemies 里 burnTick 那段）
     * **每 0.4 秒无条件**调一次 dealDamage，即使 burnDps 是 0 也照调。
     * 于是「挂着灼烧但 dps 为 0」的妖魔会每 0.4 秒被拉满一次受击白闪，
     * 渲染成纯白 —— 看起来像美术被照爆了，实际是一个 0 伤害的假命中。
     * 走查里手工挂状态（?status / ?a11ydemo）会稳定复现它。 */
    if (!(amount > 0)) return 0;
    /* DOT 不暴击：否则灼烧/冰域的每一跳都在掷骰子，伤害曲线变成
       噪声，玩家也读不出「暴击堆了多少」。暴击只奖励主动命中。 */
    var crit = !opt.noCrit && Math.random() < player.critChance;
    var dmg = amount * (crit ? player.critMult : 1);
    /* 局外成长（灵石商店 · 剑意）：乘在最外层，对所有伤害来源一视同仁。
       放在暴击之后、易伤之前 —— 顺序不影响乘法结果，
       但读代码时「基础 → 暴击 → 全局 → 易伤」是最好解释的一条链。 */
    if (player.dmgMul && player.dmgMul !== 1) dmg *= player.dmgMul;
    /* 玄冰绝域：被冰封的妖魔易伤。放在暴击之后、扣血之前，
       这样「冻住 → 打」是一条真实的收益链，冰系才有堆的价值。 */
    if (player.frost.amp > 0 && e.slowT > 0) dmg *= 1 + player.frost.amp;
    /* 盾卫护罩：范围内其他妖魔减伤。数值每帧算好缓存在 auraCut 上，
       这里只读 —— 见 updateGuardAuras 的注释（这是把查询从热路径
       挪到帧路径的典型例子）。放在最后，因为它是对「最终伤害」的削减，
       而不是又一个增伤来源：读作「这一片被护住了」。 */
    if (e.auraCut > 0) dmg *= 1 - e.auraCut;
    e.hp -= dmg;
    /* 受击闪光带冷却，见 spawnEnemy 里 flashCd 的注释 */
    if (e.flashCd <= 0) { e.flash = 1; e.flashCd = 0.26; }
    /* 回弹量随伤害占比变化：小怪被轻击只是晃一下，
       重击（暴击 / 大招）才会明显压扁，打击感才有层次 */
    var frac = dmg / Math.max(e.maxHp, 1);
    e.recoil = Math.max(e.recoil, Math.min(0.30, 0.10 + frac * 0.9));
    statDmgDealt += dmg;
    Tele.damageDealt(dmg);
    /* DOT 静音：几十只怪同时灼烧时，每跳都出声就是一片噪音墙。
       只保留主动命中的打击音，DOT 靠视觉表达。 */
    if (!opt.noSfx) Sfx.play(crit ? 'crit' : 'hit', Math.min(1, 0.42 + dmg / 260));
    if (opt.showNumber !== false) {
      XS.UI.dmg(e.x, e.y + e.def.radius * 1.6 + 0.7, e.z, dmg, crit ? 'crit' : '');
    }
    if (player.ember.enabled && !opt.noEmber && Math.random() < player.ember.chance) {
      /* 烈焰符：命中后「点燃」，而不是立刻炸一下。
         原来的实现是瞬发 AOE，和功法描述里的「燃起业火」根本对不上，
         玩家也感觉不到自己叠了什么 —— 点燃之后，妖魔身上挂着一层
         火壳持续掉血，火系 build 才真正有了自己的「手感」。

         爆燃只在新点燃时放一次：一开始我让每次命中都炸，
         结果实测同一帧里躺着 10 个 blast 特效叠在一起，
         在玩家身上糊成一坨奶白色的大光球 —— 状态视觉全被盖掉了。
         而且「已经在烧的怪又被点燃」本来也不该有第二次反馈。 */
      var fresh = ignite(e, player.ember.damage * 0.62, 3.2);
      if (fresh) {
        blastAt(e.x, e.z, player.ember.radius * 0.62, player.ember.damage * 0.45, e,
          { fxScale: 0.52, dur: 0.30 });
      }
    }
    if (e.hp <= 0) killEnemy(e);
    return dmg;
  }

  /* 点燃。返回 true 表示这是「新点着的」——
     调用方靠它决定要不要放爆燃特效，避免同一只怪反复刷特效。
     灼烧强度取「已有与新的里更强的那一份」，而不是无条件覆盖：
     否则高等级烈焰符被低等级命中一次，DOT 反而变弱，很反直觉。 */
  function ignite(e, dps, dur) {
    if (e.dead) return false;
    var fresh = !(e.burnT > 0);
    if (dps >= (e.burnDps || 0)) e.burnDps = dps;
    e.burnT = Math.max(e.burnT || 0, dur);
    e.burnTick = Math.min(e.burnTick || 0, 0.12);
    return fresh;
  }

  /* 范围爆燃。
     opt.fxScale 让「视觉大小」和「伤害范围」解耦：烈焰符的伤害范围
     需要跟着功法等级长，但特效不该跟着一起长成一个盖住半屏的金球。 */
  function blastAt(x, z, radius, dmg, except, opt) {
    opt = opt || {};
    if (opt.sfx !== false) Sfx.play('ember', 0.5);
    var fx = takeFx('blast');
    if (fx) {
      fx.alive = true; fx.t = 0; fx.dur = opt.dur || 0.46;
      fx.x = x; fx.y = 0.5; fx.z = z;
      fx.r = radius * (opt.fxScale === undefined ? 1 : opt.fxScale);
      fx.mesh.visible = true;
      fx.mesh.position.set(x, 0.5, z);
    }
    gridQuery(x, z, radius, scratchBlast);
    for (var i = 0; i < scratchBlast.length; i++) {
      var e = scratchBlast[i];
      if (e === except || e.dead) continue;
      if (Math.hypot(e.x - x, e.z - z) > radius + e.radius) continue;
      dealDamage(e, dmg, { noEmber: true, showNumber: false });
    }
  }

  function damagePlayer(amount, source) {
    if (player.invuln > 0 || state !== 'playing') return;
    var dmg = amount * (1 - player.damageReduction);
    player.hp -= dmg;
    player.invuln = XS.PLAYER.invuln;
    statDmgTaken += dmg;
    Tele.damageTaken(runT, dmg, source);
    Sfx.play('hurt', 0.9);
    lastCause = source;
    XS.Core.grade.uniforms.uFlash.value = 0.85;
    /* 挨打必须「卡一下」——这是玩家判断「我被打了」最快的信号。
       震屏幅度随伤害量走，重击和蹭一下的体感要能分开。 */
    XS.Core.addShake(Math.min(0.9, 0.24 + dmg / Math.max(1, player.maxHp) * 1.6));
    hitstop = Math.max(hitstop, 0.085);
    abPulse = Math.min(1, abPulse + 0.7);
    Platform.vibrate(20);
    if (player.hp < player.maxHp * 0.25) Tele.milestone(runT, 'low_hp');
    XS.UI.setHp(player.hp, player.maxHp);
    if (player.hp <= 0) {
      player.hp = 0;
      state = 'over';
      Sfx.play('death', 1);
      Tele.setCause(source);
      Tele.setPos(player.x, player.z);
      showOverScreen();
    }
  }

  /* ============================================================
   * 特效池
   * ============================================================ */
  function takeFx(kind) {
    for (var i = 0; i < fxPool.length; i++) {
      if (!fxPool[i].alive && fxPool[i].kind === kind) return fxPool[i];
    }
    return null;
  }

  function updateFx(dt, t) {
    for (var i = 0; i < fxPool.length; i++) {
      var f = fxPool[i];
      if (!f.alive) continue;
      if (f.kind !== 'frost') f.t += dt;
      var k = Math.min(1, f.t / f.dur);
      if (f.kind !== 'frost' && f.kind !== 'omen' && k >= 1) {
        f.alive = false; f.mesh.visible = false; continue;
      }
      var refs = f.mesh.userData.refs || {};
      switch (f.kind) {
        case 'thunder':
          refs.col.scale.set(1 - k * 0.35, 1, 1 - k * 0.35);
          refs.col.material.opacity = (1 - k) * 0.9;
          refs.ring.scale.setScalar(0.35 + k * 1.5);
          refs.ring.material.opacity = (1 - k) * 0.85;
          break;
        case 'blast':
          refs.core.scale.setScalar(0.15 + k * f.r * 1.0);
          refs.core.material.opacity = (1 - k) * 0.85;
          refs.shell.scale.setScalar(0.2 + k * f.r * 1.30);
          refs.shell.material.opacity = (1 - k) * 0.30;
          refs.ring.scale.setScalar(0.3 + k * f.r * 1.1);
          refs.ring.material.opacity = (1 - k) * 0.8;
          break;
        case 'pulse':
          refs.ring.scale.setScalar(0.2 + k * f.r);
          refs.ring.material.opacity = (1 - k) * 0.7;
          break;
        case 'omen':
          /* 前摇：范围环从内向外长满，同时高频脉动催促玩家让开 */
          var ok = Math.min(1, f.t / f.dur);
          var op = 0.5 + 0.5 * Math.sin(t * 14);
          refs.ring.scale.setScalar(f.r * (0.34 + ok * 0.66));
          refs.ring.material.opacity = 0.55 + op * 0.45;
          refs.fill.scale.setScalar(f.r * (0.34 + ok * 0.66));
          refs.fill.material.opacity = 0.12 + ok * 0.22;
          break;
        case 'charge':
          /* 蓄力：环从外向内收拢，中心亮核同时胀大 —— 能量在往一处聚。
             收拢的过程本身就是倒计时：收到最小的一刻就是打出来的一刻。 */
          var ck = Math.min(1, f.t / f.dur);
          refs.ring.scale.setScalar(f.r * (1 - ck * 0.70));
          refs.ring.material.opacity = 0.30 + ck * 0.62;
          refs.core.scale.setScalar(0.30 + ck * 0.90);
          refs.core.material.opacity = 0.20 + ck * 0.68;
          break;
        case 'levelup':
          /* 光柱迅速拉高再淡出，金环向外炸开 */
          var lp = 1 - Math.pow(1 - k, 2.2);
          refs.beam.scale.set(1 + lp * 0.9, 0.35 + lp * 0.65, 1);
          refs.beam2.scale.copy(refs.beam.scale);
          refs.beam.material.opacity = (1 - k) * 0.9;
          refs.ring.scale.setScalar(0.35 + lp * 6.2);
          refs.ring.material.opacity = (1 - k) * (1 - k) * 0.95;
          break;
        case 'field':
          /* 电场：盘面整体快速闪烁（放电是断续的，不是稳定发光），
             外圈缓缓内收，读作「能量正在散去」。 */
          var fp = 1 - k;
          var flick = 0.62 + 0.38 * Math.sin(t * 31 + f.z * 1.7);
          refs.disc.scale.setScalar(f.r);
          refs.disc.material.opacity = fp * (0.55 + 0.45 * flick);
          refs.ring.scale.setScalar(f.r * (0.30 + k * 0.72));
          refs.ring.material.opacity = fp * 0.55 * flick;
          break;
        case 'frost':
          refs.ring.scale.setScalar(f.r);
          refs.ring.material.opacity = 0.13 + Math.sin(t * 2.6) * 0.05;
          break;
        case 'death':
          refs.core.scale.setScalar(0.3 + k * f.r * 0.5);
          refs.core.material.opacity = (1 - k) * 0.75;
          refs.core.rotation.y += dt * 3;
          refs.ring.scale.setScalar(0.3 + k * f.r);
          refs.ring.material.opacity = (1 - k) * 0.6;
          break;
      }
    }
  }

  /* ---------------- 死亡粒子 ---------------- */
  var burst = null;
  var burstGeo = null, burstMat = null;
  var BURST_N = 240;

  function initBurst() {
    var pos = new Float32Array(BURST_N * 3);
    var col = new Float32Array(BURST_N * 3);
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    var mat = new T.PointsMaterial({
      size: 0.42, vertexColors: true, transparent: true,
      blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    scene.add(pts);
    burstGeo = geo; burstMat = mat;
    burst = { pts: pts, vel: new Float32Array(BURST_N * 3), life: new Float32Array(BURST_N), active: false, t: 0 };
  }

  function burstParticles(x, z, count, color) {
    if (!burst) return;
    var pos = burstGeo.attributes.position.array;
    var col = burstGeo.attributes.color.array;
    var c = new T.Color(color);
    burst.active = true; burst.t = 0;
    var live = Math.min(BURST_N, count * 6);
    for (var i = 0; i < BURST_N; i++) {
      pos[i * 3] = x; pos[i * 3 + 1] = 0.8; pos[i * 3 + 2] = z;
      if (i < live) {
        var a = Math.random() * Math.PI * 2;
        var sp = U.rand(3, 13);
        burst.vel[i * 3] = Math.cos(a) * sp;
        burst.vel[i * 3 + 1] = U.rand(4, 12);
        burst.vel[i * 3 + 2] = Math.sin(a) * sp;
        burst.life[i] = 1;
      } else {
        burst.vel[i * 3] = 0; burst.vel[i * 3 + 1] = 0; burst.vel[i * 3 + 2] = 0;
        burst.life[i] = 0;
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    burstGeo.attributes.position.needsUpdate = true;
    burstGeo.attributes.color.needsUpdate = true;
    burst.pts.visible = true;
    burstMat.opacity = 1;
  }

  function updateBurst(dt) {
    if (!burst || !burst.active) return;
    burst.t += dt;
    var pos = burstGeo.attributes.position.array;
    for (var i = 0; i < BURST_N; i++) {
      if (burst.life[i] <= 0) continue;
      burst.life[i] -= dt * 1.6;
      burst.vel[i * 3 + 1] -= 26 * dt;
      pos[i * 3] += burst.vel[i * 3] * dt;
      pos[i * 3 + 1] += burst.vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += burst.vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.1) { pos[i * 3 + 1] = 0.1; burst.vel[i * 3 + 1] *= -0.3; }
    }
    burstGeo.attributes.position.needsUpdate = true;
    burstMat.opacity = Math.max(0, 1 - burst.t / 1.1);
    if (burst.t > 1.1) { burst.active = false; burst.pts.visible = false; }
  }

  /* ============================================================
   * 每帧主循环
   * ============================================================ */
  Game.update = function (dt, t) {
    XS.Core.grade.uniforms.uTime.value = t;
    var g = XS.Core.grade.uniforms;
    g.uFlash.value = U.approach(g.uFlash.value, 0, 6.5, dt);
    g.uHeal.value = U.approach(g.uHeal.value, 0, 5.0, dt);

    /* 残血心跳：暗角随心跳收缩、边缘泛红。
       血条数字是「理性信息」，心跳才是「生理压力」——
       后者才是让玩家真的紧张起来的东西。 */
    var hpFrac = player ? player.hp / player.maxHp : 1;
    var nearNow = state === 'playing' && hpFrac < 0.34;
    /* 只在**刚掉进**残血的那一刻记一次。按帧记的话这个指标
       会变成「残血持续了多少帧」，既看不懂也和难度无关。 */
    if (nearNow && !nearDeathOn) Tele.nearDeath();
    nearDeathOn = nearNow;
    if (nearNow) {
      var sev = 1 - hpFrac / 0.34;
      var beat = Math.pow(Math.max(0, Math.sin(t * 4.6)), 5);
      hpBeat = Math.max(hpBeat, beat * sev);
      g.uVignette.value = 0.78 + sev * 0.20 + beat * sev * 0.10;
      g.uFlash.value = Math.max(g.uFlash.value, beat * sev * 0.20);
      if (beat > 0.85 && sev > 0.35) Sfx.play('hurt', 0.16);
    } else {
      hpBeat = U.approach(hpBeat, 0, 4, dt);
      g.uVignette.value = 0.78 + hpBeat * 0.10;
    }

    /* 冲击色差：暴击 / 受击时画面边缘的 RGB 分离一瞬间加剧 */
    abPulse = U.approach(abPulse, 0, 7.5, dt);
    g.uAberration.value = 0.0016 + abPulse * 0.0060;

    if (state !== 'playing' && state !== 'levelup') {
      updateFx(dt, t);
      updateBurst(dt);
      worldIdle(dt);
      XS.UI.updateDamageNumbers(dt, XS.Core.camera);
      Sfx.setIntensity(0.06);
      return;
    }

    /* 音乐强度：由妖魔密度、首领在场、残血紧张感共同决定。
       这不是「背景音乐」，而是随战况呼吸的动态配乐。 */
    var dens = Math.min(1, enemyTotal / 70);
    Sfx.setIntensity(Math.min(1,
      dens * 0.72 +
      (byType.boss.length ? 0.34 : 0) +
      (player.hp < player.maxHp * 0.35 ? 0.18 : 0)
    ));

    /* 帧率采样（同步模拟模式下 dt 恒为 1/60，测出来的不是真帧率，跳过） */
    _fpsAcc += dt; _fpsN++;
    if (dt < _fpsWorst) _fpsWorst = dt;
    if (_fpsN >= 60) {
      liveFpsAvg = +(60 / (_fpsAcc / _fpsN)).toFixed(1);
      if (!syncSim) Tele.fps(liveFpsAvg, +(1 / Math.max(_fpsWorst, 0.0001)).toFixed(1));
      _fpsAcc = 0; _fpsN = 0; _fpsWorst = 999;
    }

    /* 顿帧 */
    if (hitstop > 0) {
      hitstop -= dt;
      dt *= 0.18;
    }

    runT += dt;

    updatePlayer(dt);
    updateWaves(dt);
    updateEnemies(dt);
    /* 护罩必须在「妖魔走完」之后、「伤害结算」之前算 ——
       它依赖本帧的最终位置，而伤害系统马上要读它的结果。 */
    updateGuardAuras();
    updateSwords(dt);
    updateBolts(dt);
    updateQi(dt);
    updateThunder(dt);
    flushStrikes();
    updateFields(dt);
    updateAuras(dt);
    updateOrbs(dt);
    writeOrbMatrices();
    writeEnemyMatrices();
    writeGuardAuraMatrices();
    updateFx(dt, t);
    updateBurst(dt);

    XS.UI.setTimer(runT, XS.RUN_TIME);
    XS.UI.setKills(killCount);
    XS.UI.updateDamageNumbers(dt, XS.Core.camera);

    if (!boostOffered && runT > 90 && XS.Platform.canShowAd && XS.Platform.canShowAd()) {
      boostOffered = true;
      setBoostUi(true);
    }
    if (player.boostT > 0) player.boostT -= dt;

    if (runT >= XS.RUN_TIME) onWin();
  };

  function worldIdle(dt) {
    if (!playerMesh || !playerMesh.visible) return;
    var refs = playerMesh.userData.refs;
    refs.ring.rotation.z += dt * 1.2;
    refs.ring2.rotation.z -= dt * 0.7;
  }

  /* ---------------- 玩家 ---------------- */
  var _dir = { x: 0, y: 0 };

  function updatePlayer(dt) {
    XS.Input.read(_dir);
    var sp = player.speed * (player.boostT > 0 ? 1.35 : 1);
    var tx = _dir.x * sp, tz = -_dir.y * sp;
    player.moveX = U.approach(player.moveX, tx, 16, dt);
    player.moveZ = U.approach(player.moveZ, tz, 16, dt);
    player.x += player.moveX * dt;
    player.z += player.moveZ * dt;

    var d = Math.hypot(player.x, player.z);
    var lim = XS.ARENA.playRadius;
    if (d > lim) { player.x = player.x / d * lim; player.z = player.z / d * lim; }

    var speedNow = Math.hypot(player.moveX, player.moveZ);
    player.speedNow = speedNow;
    if (speedNow > 0.35) {
      player.faceX = player.moveX / speedNow;
      player.faceZ = player.moveZ / speedNow;
    }

    if (player.invuln > 0) player.invuln -= dt;
    if (player.regen > 0) {
      player.hp = Math.min(player.maxHp, player.hp + player.regen * dt);
      XS.UI.setHp(player.hp, player.maxHp);
    }

    /* 重建网格 */
    gridReset();
    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      for (var i = 0; i < arr.length; i++) gridAdd(arr[i]);
    }

    playerMesh.position.x = player.x;
    playerMesh.position.z = player.z;
    var moving = speedNow > 0.4;
    var bob = moving ? Math.abs(Math.sin(runT * 12)) * 0.10 : Math.sin(runT * 2.2) * 0.035;
    playerMesh.position.y = bob;
    playerMesh.rotation.y = Math.atan2(player.faceX, player.faceZ);

    var refs = playerMesh.userData.refs;
    refs.ring.rotation.z += dt * 1.5;
    refs.ring2.rotation.z -= dt * 0.9;
    refs.shell.material.opacity = player.invuln > 0
      ? (0.18 + Math.sin(runT * 40) * 0.10)
      : U.approach(refs.shell.material.opacity, 0, 8, dt);

    /* ---------- 程序化动作 ----------
       没有骨骼、没有动画文件，全靠数学把角色「演活」。
       移动速度归一化后驱动步频，所以急停/加速时动作会自然跟着变。 */
    var mv = Math.min(1, speedNow / Math.max(1, player.speed));
    player.gaitT = (player.gaitT || 0) + dt * (moving ? 8.2 + 3.4 * mv : 0);
    var gait = player.gaitT;

    /* 摆臂：左右反相，幅度随速度增长；站立时改为极缓的呼吸摆 */
    var swing = moving ? Math.sin(gait) * (0.52 + 0.34 * mv) : Math.sin(runT * 1.5) * 0.06;
    refs.armL.rotation.x = swing;
    refs.armR.rotation.x = -swing;
    refs.armL.rotation.z = -0.10 - (moving ? Math.abs(swing) * 0.10 : 0);
    refs.armR.rotation.z = 0.10 + (moving ? Math.abs(swing) * 0.10 : 0);

    /* 躯干前倾 + 侧摆：冲刺时压低重心，读起来有重量 */
    player.lean = U.approach(player.lean || 0, moving ? 0.10 + 0.16 * mv : 0, 9, dt);
    playerMesh.rotation.x = player.lean;
    playerMesh.rotation.z = moving ? Math.sin(gait * 0.5) * 0.045 : 0;

    /* 下摆随速度向后飘，形成「御风」感 */
    refs.hem.rotation.x = -player.lean * 0.9;
    refs.hem.scale.set(1 + mv * 0.06, 1, 1 + mv * 0.14);
    /* 头略微反向补偿，让视线保持水平 */
    refs.head.rotation.x = -player.lean * 0.75;

    var cam = XS.Core.camera;
    cam.position.x = U.approach(cam.position.x, player.x * 0.85, XS.CAM.follow, dt);
    cam.position.z = U.approach(cam.position.z, player.z * 0.85 + XS.CAM.offset.z, XS.CAM.follow, dt);
    cam.position.y = U.approach(cam.position.y, XS.CAM.offset.y, XS.CAM.follow * 0.7, dt);
    var shake = XS.Core.getShake();
    if (shake > 0) {
      cam.position.x += U.rand(-1, 1) * shake * 0.55;
      cam.position.y += U.rand(-1, 1) * shake * 0.35;
      cam.position.z += U.rand(-1, 1) * shake * 0.55;
    }
    cam.lookAt(player.x * 0.9, XS.CAM.lookAtY, player.z * 0.9 + XS.CAM.lookAtZ);
    XS.Core.decayShake(dt);
  }

  /* ---------------- 波次 ---------------- */
  function updateWaves(dt) {
    while (waveIdx < XS.WAVES.length - 1 && runT >= XS.WAVES[waveIdx + 1].t) {
      waveIdx++;
      XS.UI.waveHint('第 ' + (waveIdx + 1) + ' 波 · ' + XS.ENEMY[XS.WAVES[waveIdx].w].name + '来袭');
      var wd = XS.ENEMY[XS.WAVES[waveIdx].w];
      if (wd && wd.tip && !tipsShown[XS.WAVES[waveIdx].w]) {
        tipsShown[XS.WAVES[waveIdx].w] = true;
        XS.UI.tip(wd.tip, 4600);
      }
    }
    var w = XS.WAVES[waveIdx];
    var wDiff = XS.diffAt(runT);
    var wCap = Math.round(w.cap * wDiff.cap);
    if (enemyTotal < wCap) {
      spawnAcc += dt * w.rate * wDiff.rate * (1 + runT / 220);
      var guard = 0;
      while (spawnAcc >= 1 && enemyTotal < wCap && guard++ < 26) {
        spawnAcc -= 1;
        spawnEnemy(w.w, w.hpMul);
      }
      if (spawnAcc > 6) spawnAcc = 6;
    }

    if (runT > XS.ELITE_FROM) {
      eliteAcc += dt;
      var eliteGap = Math.max(6, 16 - runT / 60);
      if (eliteAcc > eliteGap) {
        eliteAcc = 0;
        Sfx.play('elite', 0.7);
        spawnEnemy('elite', 1 + runT / 200);
      }
    }

    if (bossIdx < XS.BOSS_AT.length && runT >= XS.BOSS_AT[bossIdx].t) {
      var b = XS.BOSS_AT[bossIdx];
      bossIdx++;
      var boss = spawnEnemy('boss', b.hpMul);
      if (boss) {
        boss.hp = XS.ENEMY.boss.hp * b.hpMul;
        boss.maxHp = boss.hp;
        Tele.event('boss_spawn', { t: runT, idx: bossIdx });
        Tele.milestone(runT, 'boss_' + bossIdx);
        Tele.bossSpawn();
        Sfx.play('bossIn', 1);
        XS.UI.bossWarning('魔尊降临');
        XS.UI.showBoss('魔尊 · 第' + bossIdx + '重', boss.hp, boss.maxHp);
        XS.Core.addShake(0.8);
        burstParticles(boss.x, boss.z, 30, C.blood);
        /* 地面法阵：在首领真正成型之前先扫出两圈血环，
           给玩家 1.5 秒「往哪跑」的判断时间。没有预警的 Boss
           只是突然多了一坨血，有预警才叫「登场」。 */
        groundWave(boss.x, boss.z, 11, C.blood, 1.5);
        abPulse = 1;
      }
    }
  }

  /* ---------------- 妖魔 AI ---------------- */
  /* ---------------- 盾卫护罩：把范围查询从热路径挪到帧路径 ----------------
   *
   * 为什么不在 dealDamage 里现查：dealDamage 是全场最热的函数 ——
   * 同屏上百只妖魔、每只每秒被打十来次（5 把飞剑 + 剑气 + 罡气 + 冰域 + DOT），
   * 一帧里可能被调用几百次。在那里做范围查询，等于把
   * O(伤害次数 × 盾卫数) 的活儿塞进主循环。
   *
   * 每帧算一次的代价是 O(妖魔数 × 盾卫数)：190 × 5 ≈ 950 次距离比较，
   * 可以忽略。代价是「刚出生的怪这一帧没有 auraCut」——
   * 默认值 0（不减伤），是个良性的默认。
   *
   * 多个盾卫**不叠加**，取最大值。叠加会让「多刷两只盾卫」变成
   * 一道乘法墙：玩家会突然发现整片怪完全打不动，而屏幕上
   * 没有任何东西解释这件事。宁可让第二个盾卫是「浪费的」，
   * 也不要让玩家遇到一个看不懂的数值悬崖。
   */
  function updateGuardAuras() {
    var guards = byType.guard;
    var gn = guards.length;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        if (gn === 0 || e.type === 'guard') { e.auraCut = 0; continue; }
        var cut = 0;
        for (var g = 0; g < gn; g++) {
          var gu = guards[g];
          if (gu.dead) continue;
          var R = gu.def.aura;
          if (Math.hypot(gu.x - e.x, gu.z - e.z) <= R && gu.def.auraCut > cut) {
            cut = gu.def.auraCut;
          }
        }
        e.auraCut = cut;
      }
    }
  }

  function updateEnemies(dt) {
    var p = player;

    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      /* 倒序遍历：dealDamage 可能触发 swap-remove */
      for (var i = arr.length - 1; i >= 0; i--) {
        var e = arr[i];
        if (!e || e.dead) continue;

        if (e.spawnT < (e.spawnDur || 0.38)) e.spawnT += dt;

        var slowMul = 1;
        if (e.slowT > 0) { e.slowT -= dt; slowMul = 1 - e.slow; }

        var dx = p.x - e.x, dz = p.z - e.z;
        var d = Math.hypot(dx, dz) || 0.001;
        var sp = e.speed * slowMul;
        e.x += dx / d * sp * dt;
        e.z += dz / d * sp * dt;
        e.faceA = Math.atan2(dx, dz);

        /* ---------------- 首领技能 ----------------
         * 第一套「裂地」：每 3.6~5.2 秒起手一次，原地定身 1.1 秒，
         *   地面画出危险范围，然后炸开。血越少起手越快、范围越大 ——
         *   用一个招式就把「狂暴阶段」讲清楚了。
         *
         * 第二套「弹幕环」：血量掉到 65% 以下解锁，之后与裂地**交替**。
         *   为什么需要第二套：裂地只惩罚「站得太近」，所以「离它远点慢慢打」
         *   是一个能通到底的答案 —— 首领战会退化成耐力赛。
         *   弹幕环是向四周射出一整环术法弹，远程并不安全，
         *   于是「距离」这个单一答案被作废，玩家必须开始横向走位。
         *
         *   交替而不是随机：交替是可预期的，玩家能学会「下一招该往哪躲」，
         *   并在起手阶段就提前走位；随机只会让两招都变成噪音。
         */
        if (e.isBoss) {
          if (e.slamT > 0) {
            e.x -= dx / d * sp * dt;
            e.z -= dz / d * sp * dt;
            e.slamT -= dt;
            if (e.slamT <= 0) {
              var sr = e.slamR || 5.6;
              if (e.omenFx) { e.omenFx.alive = false; e.omenFx.mesh.visible = false; e.omenFx = null; }
              groundWave(e.x, e.z, sr * 1.15, C.blood, 0.62);
              burstParticles(e.x, e.z, 22, C.cinnabar);
              XS.Core.addShake(0.72);
              Sfx.play('thunder', 0.95);
              abPulse = Math.min(1, abPulse + 0.8);
              var pd = Math.hypot(p.x - e.x, p.z - e.z);
              if (pd < sr + p.radius) {
                /* 伤害倍率压到 0.9：这是「招式」不是「秒杀」。
                   实测 1.7 倍时后期一下 90+ 点，满血也直接带走，
                   死因统计里 86% 都变成魔尊 —— 那不叫难，叫不讲理。 */
                damagePlayer(e.dmg * 0.9, 'boss');
                if (state !== 'playing') return;
              }
              if (pd > 0.001) {
                p.x += (p.x - e.x) / pd * 2.8;
                p.z += (p.z - e.z) / pd * 2.8;
              }
            }
          } else if (e.barrageT > 0) {
            e.x -= dx / d * sp * dt;
            e.z -= dz / d * sp * dt;
            e.barrageT -= dt;
            if (e.barrageT <= 0) {
              var BN = 14;
              /* 基准角对准玩家：14 发里必有一发正对他。
                 全环均匀撒出去的话，玩家有可能「运气好」站在缝里，
                 那就变成抽奖而不是走位 —— 把一发钉死在他身上，
                 横向闪避就从「可选」变成「必须」。 */
              var base = Math.atan2(dx, dz);
              for (var bi = 0; bi < BN; bi++) {
                fireBolt(e, base + bi / BN * Math.PI * 2);
              }
              if (e.chargeFx) { e.chargeFx.alive = false; e.chargeFx.mesh.visible = false; e.chargeFx = null; }
              groundWave(e.x, e.z, 3.4, C.frost, 0.45);
              XS.Core.addShake(0.34);
              Sfx.play('elite', 0.75);
              abPulse = Math.min(1, abPulse + 0.5);
            }
          } else {
            e.atkCd = (e.atkCd === undefined ? 3.0 : e.atkCd) - dt;
            if (e.atkCd <= 0) {
              var enraged = e.hp < e.maxHp * 0.5;
              e.atkCd = enraged ? 4.0 : 5.8;
              /* 65% 解锁，之后严格交替 */
              var useBarrage = e.hp < e.maxHp * 0.65 && !e.lastBarrage;
              e.lastBarrage = useBarrage;
              if (useBarrage) {
                e.barrageT = 0.85;
                var cfx = takeFx('charge');
                if (cfx) {
                  cfx.alive = true; cfx.t = 0; cfx.dur = 0.85; cfx.r = 7.0;
                  cfx.mesh.visible = true;
                  cfx.mesh.position.set(e.x, 0.08, e.z);
                  e.chargeFx = cfx;
                }
              } else {
                e.slamT = 1.1;
                e.slamR = enraged ? 6.4 : 5.2;
                var ofx = takeFx('omen');
                if (ofx) {
                  ofx.alive = true; ofx.t = 0; ofx.dur = 1.1; ofx.r = e.slamR;
                  ofx.mesh.visible = true;
                  ofx.mesh.position.set(e.x, 0.08, e.z);
                  e.omenFx = ofx;
                }
              }
              Sfx.play('bossIn', 0.5);
            }
          }
        }

        /* ---------------- 妖巫：保持射程，蓄力放法术 ----------------
         * 它不贴脸，而是停在 9.5 米外绕着你打。
         * 这类敌人的作用是打破「一直往后退就安全」的惯性 ——
         * 玩家必须主动上前清掉它，否则会被慢慢磨死。 */
        if (e.type === 'caster') {
          var want = 9.5;
          if (d < want - 1.3) {
            e.x -= dx / d * sp * dt * 0.95;
            e.z -= dz / d * sp * dt * 0.95;
          } else if (d < want + 1.3) {
            /* 侧向绕行，别站桩挨打 */
            var side = (e.wob > Math.PI) ? 1 : -1;
            var ta = Math.atan2(dx, dz) + Math.PI * 0.5 * side;
            e.x += Math.sin(ta) * sp * dt * 0.55;
            e.z += Math.cos(ta) * sp * dt * 0.55;
          }
          if (e.castT > 0) {
            e.castT -= dt;
            if (e.castT <= 0) {
              fireBolt(e);
              e.fireCd = 3.1 + Math.random() * 1.3;
            }
          } else if (e.fireCd > 0) {
            e.fireCd -= dt;
            if (e.fireCd <= 0 && d < 17) e.castT = 0.55;
          }
        }

        /* ---------------- 妖狼：蓄力 → 直线突进 ----------------
         * 蓄力 0.72 秒（原地后仰 + 身前亮起），然后锁定方向冲出去。
         * 冲刺方向在蓄力结束的一刻锁死，所以「横向闪」能躲开，
         * 「继续往后退」会被追上 —— 这一条就教会了玩家侧移。 */
        if (e.type === 'charger') {
          if (e.dashT > 0) {
            e.x -= dx / d * sp * dt;
            e.z -= dz / d * sp * dt;
            e.dashT -= dt;
            e.x += e.dashVX * dt;
            e.z += e.dashVZ * dt;
            if (e.dashT <= 0) e.dashCd = 2.6 + Math.random() * 1.2;
          } else if (e.windT > 0) {
            e.x -= dx / d * sp * dt;
            e.z -= dz / d * sp * dt;
            e.windT -= dt;
            if (e.windT <= 0) {
              e.dashVX = dx / d * e.speed * 3.6;
              e.dashVZ = dz / d * e.speed * 3.6;
              e.dashT = 0.55;
              Sfx.play('elite', 0.3);
            }
          } else {
            e.dashCd -= dt;
            if (e.dashCd <= 0 && d < 13 && d > 3.2) { e.windT = 0.72; e.dashCd = 99; }
          }
        }

        if (!e.isBoss) {
          gridQuery(e.x, e.z, e.radius * 2.2, scratchSep);
          var px = 0, pz = 0, n = 0;
          for (var k = 0; k < scratchSep.length; k++) {
            var o = scratchSep[k];
            if (o === e || o.dead) continue;
            var ox = e.x - o.x, oz = e.z - o.z;
            var od = Math.hypot(ox, oz);
            var minD = e.radius + o.radius;
            if (od < minD && od > 0.0001) {
              var push = (minD - od) / minD;
              var w2 = o.mass / (e.mass + o.mass);
              px += ox / od * push * w2;
              pz += oz / od * push * w2;
              n++;
            }
          }
          if (n) {
            var sepK = (e.type === 'charger' && e.dashT > 0) ? 0.25 : 1.6;
            e.x += px * sp * dt * sepK;
            e.z += pz * sp * dt * sepK;
          }
        }

        var dd = Math.hypot(e.x, e.z);
        var elim = XS.ARENA.radius + 3;
        if (dd > elim) { e.x = e.x / dd * elim; e.z = e.z / dd * elim; }

        var hitD = e.radius + p.radius;
        if (d < hitD && p.invuln <= 0) {
          /* 被冲锋撞到要「飞出去」，和普通蹭血区分开 */
          var isDash = (e.type === 'charger' && e.dashT > 0);
          damagePlayer(e.dmg * (isDash ? 1.5 : 1), e.isBoss ? 'boss' : (e.isElite ? 'elite' : 'swarm'));
          if (state !== 'playing') return;
          var kb = isDash ? 2.4 : 0.5;
          p.x -= dx / d * kb;
          p.z -= dz / d * kb;
          if (isDash) {
            e.dashT = 0;
            e.dashCd = 2.6;
            XS.Core.addShake(0.45);
            abPulse = Math.min(1, abPulse + 0.5);
          }
        }

        if (e.flash > 0) e.flash = U.approach(e.flash, 0, 14, dt);
        if (e.flashCd > 0) e.flashCd -= dt;
        if (e.recoil > 0) e.recoil = U.approach(e.recoil, 0, 11, dt);

        /* 灼烧跳伤：0.4 秒一跳，飘字合并显示。
           每帧扣血会让飘字刷屏，反而看不出自己叠了多少伤害。 */
        if (e.burnT > 0) {
          e.burnT -= dt;
          e.burnTick -= dt;
          if (e.burnTick <= 0) {
            e.burnTick = 0.4;
            dealDamage(e, e.burnDps * 0.4, { showNumber: false, noEmber: true, noCrit: true, noSfx: true });
            if (e.dead) continue;
          }
          if (e.burnT <= 0) { e.burnT = 0; e.burnDps = 0; }
        }

        if (p.frost.enabled) {
          var fd = Math.hypot(e.x - p.x, e.z - p.z);
          if (fd < p.frost.radius) {
            e.slowT = 0.25;
            e.slow = p.frost.slow;
            e.frostCd -= dt;
            if (e.frostCd <= 0) {
              e.frostCd = 0.5;
              Sfx.play('frost', 0.4);
              dealDamage(e, p.frost.dps * 0.5, { showNumber: false, noEmber: true, noCrit: true, noSfx: true });
            }
          }
        }

        if (!e.dead && p.aura.enabled) {
          var ad = Math.hypot(e.x - p.x, e.z - p.z);
          if (ad < p.aura.radius + e.radius) {
            e.auraCd -= dt;
            if (e.auraCd <= 0) {
              e.auraCd = 0.45;
              dealDamage(e, p.aura.dps * 0.45, { showNumber: false, noEmber: true, noCrit: true, noSfx: true });
            }
          }
        }
      }
    }

    var bl = byType.boss;
    if (bl.length) XS.UI.updateBoss(bl[0].hp, bl[0].maxHp);
  }

  /* ---------------- 飞剑 ----------------
   * 判定方式：以玩家为圆心、沿飞剑当前角度向外扫出一条扇形刃风。
   * 这样贴脸的妖魔同样会被斩到（若只判定剑身附近，怪冲到脚下就再也吃不到伤害）。
   */
  var SWEEP_HALF_ANGLE = 0.76;   // 单把剑的扇形半角（弧度）

  function angDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d < 0 ? -d : d;
  }

  /* 飞剑拖尾矩阵
   *
   * 剑在半径 R 的圆上以角速度 w 运动，切向就是它的「运动方向」。
   * 拖尾从剑身后方铺开，长度随攻速提升而拉长 ——
   * 这样「攻速变快」不只是数字变化，而是看得见的。
   *
   * 局部 +X 对齐切向、+Z 对齐法向，直接按列主序写入：
   *   col0 = 切向 × 长度，col1 = 竖直，col2 = 法向 × 宽度
   */
  function writeSwordTrails(sw, n, boost) {
    if (!swordTrail) return;
    var arr = swordTrail.instanceMatrix.array;
    var len = (1.35 + sw.radius * 0.40) * (boost || 1);
    var wid = 0.30 + sw.radius * 0.052;
    for (var i = 0; i < n; i++) {
      var a = sw.angle + i * Math.PI * 2 / n;
      var sinA = Math.sin(a), cosA = Math.cos(a);
      /* 剑当前位置 */
      var px = player.x + cosA * sw.radius;
      var pz = player.z + sinA * sw.radius;
      /* 拖尾挂在剑身后方 */
      var cx = px - (-sinA) * len * 0.5;
      var cz = pz - (cosA) * len * 0.5;
      var off = i * 16;
      arr[off] = -sinA * len;  arr[off + 1] = 0; arr[off + 2] = cosA * len;   arr[off + 3] = 0;
      arr[off + 4] = 0;        arr[off + 5] = 1; arr[off + 6] = 0;            arr[off + 7] = 0;
      arr[off + 8] = -cosA * wid; arr[off + 9] = 0; arr[off + 10] = -sinA * wid; arr[off + 11] = 0;
      arr[off + 12] = cx;      arr[off + 13] = 0.98; arr[off + 14] = cz;      arr[off + 15] = 1;
    }
    swordTrail.count = n;
    swordTrail.instanceMatrix.needsUpdate = true;
  }

  function updateSwords(dt) {
    var sw = player.sword;
    var boost = player.boostT > 0 ? 1.3 : 1;
    sw.angle += dt * sw.speed * boost;
    var n = Math.min(SWORD_MAX, sw.count);
    /* 进化「万剑归宗」后剑身整体放大 —— 进化必须在**一眼可见**的层面
       体现出来，只涨数字玩家是感觉不到的。 */
    var scl = player.evolved.sword ? 1.35 : 1;
    var i;

    for (i = 0; i < swordMeshes.length; i++) {
      var m = swordMeshes[i];
      if (i >= n) { m.visible = false; continue; }
      m.visible = true;
      var a = sw.angle + i * Math.PI * 2 / n;
      m.position.set(
        player.x + Math.cos(a) * sw.radius,
        1.05 + Math.sin(runT * 4 + i) * 0.12,
        player.z + Math.sin(a) * sw.radius
      );
      m.rotation.y = -a + Math.PI / 2;
      m.rotation.z = Math.sin(runT * 6 + i) * 0.12;
      m.scale.setScalar(scl);
    }

    writeSwordTrails(sw, n, boost);

    var reach = sw.radius + 1.0;
    gridQuery(player.x, player.z, reach + 1.6, scratchHit);
    for (var k = 0; k < scratchHit.length; k++) {
      var e = scratchHit[k];
      if (e.dead) continue;
      var ex = e.x - player.x, ez = e.z - player.z;
      var dist = Math.hypot(ex, ez);
      if (dist > reach + e.radius) continue;
      e.swordCd -= dt;
      if (e.swordCd > 0) continue;
      var eAng = Math.atan2(ez, ex);
      for (var s = 0; s < n; s++) {
        var aa = sw.angle + s * Math.PI * 2 / n;
        if (angDiff(eAng, aa) < SWEEP_HALF_ANGLE) {
          e.swordCd = 0.34;
          Sfx.play('sword', 0.55);
          dealDamage(e, sw.damage);
          /* 万剑归宗：回旋补斩。同一帧内再补一刀半伤，
             读作「剑锋掠过之后又绕回来补了一下」。 */
          if (sw.echo > 0 && !e.dead && Math.random() < sw.echo) {
            dealDamage(e, sw.damage * 0.5);
          }
          /* 轻击退：把贴脸的怪推开一点，形成呼吸感 */
          if (!e.dead && !e.isBoss && dist > 0.01) {
            var kb = 1.5 / e.mass;
            e.x += ex / dist * kb;
            e.z += ez / dist * kb;
          }
          break;
        }
      }
    }
  }

  /* ---------------- 剑气 ---------------- */
  /* ---------------- 妖巫：术法弹 ---------------- */
  /* dirA 省略时朝玩家发射（妖巫）；给了角度就是固定方向（魔尊弹幕环）。
     一个函数管两种用法，而不是复制一份 —— 复制出来的那份迟早会漏掉
     某次改动（比如「给飞弹加上伤害来源」），于是同一个东西有两种行为。 */
  function fireBolt(e, dirA) {
    var b = null;
    for (var i = 0; i < boltPool.length; i++) if (!boltPool[i].alive) { b = boltPool[i]; break; }
    if (!b) return;
    var vx, vz, dmg;
    if (dirA === undefined) {
      var dx = player.x - e.x, dz = player.z - e.z;
      var d = Math.hypot(dx, dz) || 1;
      vx = dx / d * 8.8; vz = dz / d * 8.8;
      dmg = e.dmg * 0.62;
    } else {
      /* 弹幕环的弹速刻意低于妖巫（7.2 vs 8.8）：
         14 发同时朝你飞来，如果每发都和单发一样快，
         那就不是「走位题」而是「运气题」了。 */
      vx = Math.sin(dirA) * 7.2; vz = Math.cos(dirA) * 7.2;
      dmg = e.dmg * 0.50;
    }
    b.alive = true;
    b.x = e.x; b.y = e.isBoss ? 2.30 : 1.15; b.z = e.z;
    b.vx = vx; b.vz = vz;
    b.dmg = dmg;
    b.life = 3.2;
    /* 伤害来源必须跟着飞弹走：魔尊的弹幕如果记成 swarm，
       死因统计会把「被首领招式打死」算成「被小妖蹭死」，
       而那份统计正是用来判断「难度卡在哪一环」的。 */
    b.cause = e.isBoss ? 'boss' : 'swarm';
    b.mesh.visible = true;
    b.mesh.position.set(b.x, b.y, b.z);
    Sfx.play('qi', 0.34);
  }

  function killBolt(b) { b.alive = false; b.mesh.visible = false; }

  function updateBolts(dt) {
    var cam = XS.Core.camera;
    var lim = XS.ARENA.radius + 4;
    for (var i = 0; i < boltPool.length; i++) {
      var b = boltPool[i];
      if (!b.alive) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.mesh.position.set(b.x, b.y, b.z);
      b.mesh.rotation.y += dt * 6;
      b.mesh.userData.refs.halo.quaternion.copy(cam.quaternion);

      var dx = player.x - b.x, dz = player.z - b.z;
      if (Math.hypot(dx, dz) < player.radius + 0.34 && player.invuln <= 0) {
        killBolt(b);
        damagePlayer(b.dmg, b.cause || 'swarm');
        if (state !== 'playing') return;
        continue;
      }
      if (b.life <= 0 || Math.hypot(b.x, b.z) > lim) killBolt(b);
    }
  }

  function updateQi(dt) {
    var q = player.qi;
    if (q.enabled) {
      q.timer -= dt * (player.boostT > 0 ? 1.4 : 1);
      if (q.timer <= 0) { q.timer = q.interval; fireQi(); }
    }
    var tn = 0;
    for (var i = 0; i < qiPool.length; i++) {
      var b = qiPool[i];
      if (!b.alive) continue;
      b.life -= dt;
      if (b.life <= 0) { b.alive = false; b.mesh.visible = false; continue; }
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.mesh.position.set(b.x, 0.95, b.z);
      b.mesh.rotation.y = Math.atan2(b.vx, b.vz);
      b.mesh.scale.setScalar(b.sc || 1);

      /* 剑气拖尾：方向即飞行方向。拖尾比本体长得多，
         所以即便剑气本体只有一小段，看上去也像一道疾飞的剑光。
         注意这里只能写一次 —— 之前用追加式改文件时把整段贴了两遍，
         结果同一道剑气占掉两个拖尾槽位，一半的槽位全是重影。 */
      if (qiTrail && tn < QI_MAX) {
        var spd = Math.hypot(b.vx, b.vz) || 1;
        var ux = b.vx / spd, uz = b.vz / spd;
        var sc = b.sc || 1;
        var tl = 2.7 * sc, tw = 0.24 * sc;
        var toff = tn * 16;
        var ta = qiTrail.instanceMatrix.array;
        ta[toff] = ux * tl;        ta[toff + 1] = 0;  ta[toff + 2] = uz * tl;      ta[toff + 3] = 0;
        ta[toff + 4] = 0;          ta[toff + 5] = 1;  ta[toff + 6] = 0;            ta[toff + 7] = 0;
        ta[toff + 8] = -uz * tw;   ta[toff + 9] = 0;  ta[toff + 10] = ux * tw;     ta[toff + 11] = 0;
        ta[toff + 12] = b.x - ux * tl * 0.5;
        ta[toff + 13] = 0.95;
        ta[toff + 14] = b.z - uz * tl * 0.5;
        ta[toff + 15] = 1;
        tn++;
      }

      gridQuery(b.x, b.z, 1.4, scratchHit);
      for (var k = 0; k < scratchHit.length; k++) {
        var e = scratchHit[k];
        if (e.dead) continue;
        if (b.hit.indexOf(e) !== -1) continue;
        if (Math.hypot(e.x - b.x, e.z - b.z) > 0.9 * (b.sc || 1) + e.radius) continue;
        b.hit.push(e);
        dealDamage(e, b.dmg);
        b.pierce--;
        if (b.pierce <= 0) { b.alive = false; b.mesh.visible = false; break; }
      }
      if (b.alive && Math.hypot(b.x, b.z) > XS.ARENA.radius + 6) {
        b.alive = false; b.mesh.visible = false;
      }
    }
    if (qiTrail) {
      qiTrail.count = tn;
      qiTrail.instanceMatrix.needsUpdate = true;
    }
  }

  var _near = [];

  function nearestEnemies(count, out) {
    out.length = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      for (var i = 0; i < arr.length; i++) if (!arr[i].dead) out.push(arr[i]);
    }
    out.sort(function (a, b) {
      var da = (a.x - player.x) * (a.x - player.x) + (a.z - player.z) * (a.z - player.z);
      var db = (b.x - player.x) * (b.x - player.x) + (b.z - player.z) * (b.z - player.z);
      return da - db;
    });
    if (out.length > count) out.length = count;
    return out;
  }

  function fireQi() {
    var q = player.qi;
    nearestEnemies(Math.max(1, Math.ceil(q.count / 2)), _near);
    if (!_near.length) return;
    Sfx.play('qi', 0.65);
    for (var i = 0; i < q.count; i++) {
      var tgt = _near[i % _near.length];
      var b = null;
      for (var k = 0; k < qiPool.length; k++) if (!qiPool[k].alive) { b = qiPool[k]; break; }
      if (!b) return;
      var ang = Math.atan2(tgt.x - player.x, tgt.z - player.z) + U.rand(-0.12, 0.12);
      b.alive = true;
      b.x = player.x; b.z = player.z;
      b.vx = Math.sin(ang) * 26;
      b.vz = Math.cos(ang) * 26;
      b.dmg = q.damage;
      b.pierce = q.pierce;
      b.sc = q.scale || 1;
      b.hit.length = 0;
      b.life = 2.2;
      b.mesh.visible = true;
      b.mesh.position.set(b.x, 0.95, b.z);
    }
  }

  /* ---------------- 天雷 ---------------- */
  var _all = [];

  function updateThunder(dt) {
    var th = player.thunder;
    if (!th.enabled) return;
    th.timer -= dt;
    if (th.timer > 0) return;
    th.timer = th.interval;

    _all.length = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var arr = byType[TYPES[ti]];
      for (var i = 0; i < arr.length; i++) if (!arr[i].dead) _all.push(arr[i]);
    }
    if (!_all.length) return;

    var mySeq = runSeq;
    for (var c = 0; c < th.count; c++) {
      var tgt = _all[Math.floor(Math.random() * _all.length)];
      var fx = takeFx('thunder');
      var x = tgt.x, z = tgt.z, radius = th.radius, dmg = th.damage;
      if (fx) {
        fx.alive = true; fx.t = 0; fx.dur = 0.55;
        fx.mesh.visible = true;
        fx.mesh.position.set(x, 0, z);
      }
      /* 0.16 秒后落雷（用帧计数延迟，避免依赖 setTimeout） */
      pendingStrikes.push({ at: runT + 0.16, x: x, z: z, r: radius, dmg: dmg, seq: mySeq });
    }
  }

  var pendingStrikes = [];

  function flushStrikes() {
    for (var i = pendingStrikes.length - 1; i >= 0; i--) {
      var s = pendingStrikes[i];
      if (s.seq !== runSeq) { pendingStrikes.splice(i, 1); continue; }
      if (runT >= s.at) {
        pendingStrikes.splice(i, 1);
        blastAt(s.x, s.z, s.r, s.dmg, null);
        spawnField(s.x, s.z, s.r * 1.15, s.dmg * 0.09);
        Sfx.play('thunder', 0.85);
        XS.Core.addShake(0.14);
      }
    }
  }

  /* 雷电场：落雷后在地上留下一片持续放电的区域。
   * 时长刻意压到 2 秒 —— 比这长的话，满级天雷会在地上铺出一片
   * 永久雷区，玩家就不需要走位了，那是平衡事故不是爽点。 */
  function spawnField(x, z, radius, tickDmg) {
    var fx = takeFx('field');
    if (!fx) return;
    fx.alive = true; fx.t = 0; fx.dur = 2.0;
    fx.x = x; fx.y = 0.07; fx.z = z; fx.r = radius;
    fx.tick = 0.18;         // 落地即跳一次，读作「雷还没散」
    fx.dmg = tickDmg;
    fx.mesh.visible = true;
    fx.mesh.position.set(x, 0, z);
    fx.mesh.rotation.y = Math.random() * 6.28;
  }

  /* 电场跳伤：每 0.4 秒对范围内妖魔结算一次 */
  function updateFields(dt) {
    for (var i = 0; i < fxPool.length; i++) {
      var f = fxPool[i];
      if (!f.alive || f.kind !== 'field') continue;
      f.tick -= dt;
      if (f.tick > 0) continue;
      f.tick = 0.4;
      gridQuery(f.x, f.z, f.r, scratchBlast);
      for (var k = 0; k < scratchBlast.length; k++) {
        var e = scratchBlast[k];
        if (e.dead) continue;
        if (Math.hypot(e.x - f.x, e.z - f.z) > f.r + e.radius) continue;
        dealDamage(e, f.dmg, { showNumber: false, noEmber: true, noCrit: true, noSfx: true });
      }
    }
  }

  /* ---------------- 罡气脉冲 / 冰域视觉 ---------------- */
  function updateAuras(dt) {
    if (player.aura.enabled) {
      player.aura.timer -= dt;
      if (player.aura.timer <= 0) {
        player.aura.timer = player.aura.interval;
        Sfx.play('aura', 0.6);
        var fx = takeFx('pulse');
        if (fx) {
          /* 必须把颜色拨回金色：groundWave 会复用同一个 pulse 池并改
             ring 的材质颜色（妖将死紫、魔尊死金），而材质是池内共享的，
             不拨回来的话护体罡气会一直用上一次死亡特效的颜色。 */
          var aring = fx.mesh.userData.refs.ring;
          if (aring) aring.material.color.set(C.gold);
          fx.alive = true; fx.t = 0; fx.dur = 0.45;
          fx.mesh.visible = true;
          fx.mesh.position.set(player.x, 0.06, player.z);
          fx.r = player.aura.radius;
        }
      }
    }
    var f = takeFx('frost');
    if (player.frost.enabled) {
      if (f) {
        f.alive = true; f.dur = 9999; f.t = 0;
        f.mesh.visible = true;
        f.mesh.position.set(player.x, 0.05, player.z);
        f.r = player.frost.radius;
      }
    } else if (f && f.alive) {
      f.alive = false; f.mesh.visible = false;
    }
  }

  /* ---------------- 实例矩阵写入 ---------------- */
  var _matColor = new T.Color();
  var _white = new T.Color(1, 1, 1);

  /* 盾卫护罩光环的实例矩阵。几何已经摊平，所以这里只有缩放 + 平移。
     光环轻微呼吸（±2%），否则它就是一张贴纸 ——
     静止的圆圈读作「场景装饰」，会呼吸的圆圈才读作「某个东西撑起来的」。 */
  function writeGuardAuraMatrices() {
    if (!guardAura) return;
    var guards = byType.guard;
    var arr = guardAura.instanceMatrix.array;
    var m = 0;
    for (var i = 0; i < guards.length && m < CAP.guard; i++) {
      var gu = guards[i];
      if (gu.dead) continue;
      var s = gu.def.aura * (1 + Math.sin(runT * 2.4 + gu.auraPulse) * 0.022);
      var off = m * 16;
      arr[off] = s;        arr[off + 1] = 0;  arr[off + 2] = 0;       arr[off + 3] = 0;
      arr[off + 4] = 0;    arr[off + 5] = 1;  arr[off + 6] = 0;       arr[off + 7] = 0;
      arr[off + 8] = 0;    arr[off + 9] = 0;  arr[off + 10] = s;      arr[off + 11] = 0;
      arr[off + 12] = gu.x; arr[off + 13] = 0.06; arr[off + 14] = gu.z; arr[off + 15] = 1;
      m++;
    }
    guardAura.count = m;
    guardAura.instanceMatrix.needsUpdate = true;
  }

  function writeEnemyMatrices() {
    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var arr = byType[type];
      var r = R[type];
      var bodyArr = r.body.instanceMatrix.array;
      var glowArr = r.glow.instanceMatrix.array;
      /* 轮廓层只在本体的矩阵上乘一个缩放，所以直接就地派生，
         不需要再算一遍旋转 / 前倾 / 受击压扁 —— 那些逻辑一旦有第二份
         拷贝，就一定会有一天两份不同步（改了一处忘了另一处）。 */
      var outOn = !!r.outline && r.outline.visible;
      var outlineArr = outOn ? r.outline.instanceMatrix.array : null;
      var ok = r.outlineK || OUTLINE_SCALE;
      var n = arr.length;

      for (var i = 0; i < n; i++) {
        var e = arr[i];
        var off = i * 16;

        /* 出场：带回弹的弹出曲线。线性放大看起来像「渐显」，
           而 ease-out + 过冲才读得出「妖魔从地缝里钻出来」。 */
        var g = Math.min(1, e.spawnT / (e.spawnDur || 0.38));
        var pop = 1 - Math.pow(1 - g, 3);
        var over = g < 1 ? 1 + Math.sin(g * Math.PI) * 0.20 : 1;
        var sc = (0.22 + 0.78 * pop) * over;

        /* 受击压扁：沿垂直方向压、水平方向撑，是最易读的「打到了」信号 */
        var rec = e.recoil > 0 ? Math.min(1, e.recoil / 0.30) : 0;
        var sx = 1 + rec * 0.30, sy = 1 - rec * 0.24, sz = 1 + rec * 0.30;

        /* 冰缓：高频小幅抖动，读作「被冻住挣不开」 */
        var jit = e.slowT > 0 ? Math.sin(runT * 52 + e.wob) * 0.022 : 0;

        var bob = e.def.float
          ? Math.sin(runT * 3.2 + e.wob) * 0.22
          : Math.abs(Math.sin(runT * 7 + e.wob)) * 0.06;
        var y = bob + (e.def.float || 0) * 0.5;

        var s = sc * (1 + e.flash * 0.16);
        var ca = Math.cos(e.faceA || 0), sa = Math.sin(e.faceA || 0);

        /* 前倾：速度越快身体越往前压，冲过来的感觉立刻不一样 */
        var lean = Math.min(0.30, (e.speed || 0) * 0.042) + rec * 0.12;

        /* 矩阵 = 绕 Y 旋转 × 非等比缩放 × 前倾剪切（列主序直接写入） */
        bodyArr[off]      = ca * s * sx;
        bodyArr[off + 1]  = 0;
        bodyArr[off + 2]  = -sa * s * sx;
        bodyArr[off + 3]  = 0;
        bodyArr[off + 4]  = sa * s * lean;
        bodyArr[off + 5]  = s * sy * (1 + jit);
        bodyArr[off + 6]  = ca * s * lean;
        bodyArr[off + 7]  = 0;
        bodyArr[off + 8]  = sa * s * sz;
        bodyArr[off + 9]  = 0;
        bodyArr[off + 10] = ca * s * sz;
        bodyArr[off + 11] = 0;
        bodyArr[off + 12] = e.x;
        bodyArr[off + 13] = y;
        bodyArr[off + 14] = e.z;
        bodyArr[off + 15] = 1;

        for (var q = 0; q < 16; q++) glowArr[off + q] = bodyArr[off + q];

        /* 反向外壳：只把 3×3 部分乘上 OUTLINE_SCALE（等价于 M × S(k)），
           平移列原样保留。几何体的原点在脚底，所以放大是「从地面往上长」，
           不会把描边压到地面以下。 */
        if (outlineArr) {
          outlineArr[off]      = bodyArr[off] * ok;
          outlineArr[off + 1]  = bodyArr[off + 1] * ok;
          outlineArr[off + 2]  = bodyArr[off + 2] * ok;
          outlineArr[off + 3]  = 0;
          outlineArr[off + 4]  = bodyArr[off + 4] * ok;
          outlineArr[off + 5]  = bodyArr[off + 5] * ok;
          outlineArr[off + 6]  = bodyArr[off + 6] * ok;
          outlineArr[off + 7]  = 0;
          outlineArr[off + 8]  = bodyArr[off + 8] * ok;
          outlineArr[off + 9]  = bodyArr[off + 9] * ok;
          outlineArr[off + 10] = bodyArr[off + 10] * ok;
          outlineArr[off + 11] = 0;
          outlineArr[off + 12] = bodyArr[off + 12];
          outlineArr[off + 13] = bodyArr[off + 13];
          outlineArr[off + 14] = bodyArr[off + 14];
          outlineArr[off + 15] = 1;
        }

        if (e.flash > 0.02) {
          /* 受击白闪：只抬亮到「看得出来被打了」就够。
             全通道 2 倍以上会把妖魔刷成纯白，一整片 AOE 下去
             满屏都是白色多面体，反而看不出打了什么。 */
          var f = e.flash;
          _matColor.setRGB(1 + 0.55 * f, 1 + 0.34 * f, 1 + 0.30 * f);
        } else if (e.burnT > 0) {
          /* 灼烧：整体透红。优先级高于冰缓 —— 同时中两种状态时，
             「正在持续掉血」比「走得慢」更需要被看见。 */
          _matColor.setRGB(1.20, 0.78, 0.62);
        } else if (e.slowT > 0) {
          /* 被冰冻的妖魔整体偏青，一眼能看出哪些已经被控住 */
          _matColor.setRGB(0.72, 1.06, 1.22);
        } else {
          _matColor.copy(_white);
        }
        r.body.setColorAt(i, _matColor);
      }

      r.body.count = n;
      r.glow.count = n;
      r.body.instanceMatrix.needsUpdate = true;
      r.glow.instanceMatrix.needsUpdate = true;
      if (r.outline && outOn) {
        r.outline.count = n;
        r.outline.instanceMatrix.needsUpdate = true;
      }
      if (r.body.instanceColor && n > 0) r.body.instanceColor.needsUpdate = true;
    }

    writeMarkers();
    writeStatusShell();
  }

  /* 状态外壳写入
   *
   * 遍历全部妖魔，给「中状态」的那些套一层壳。壳比妖魔本体
   * 略大、随时间轻微呼吸，这样即使隔着半屏、即使妖魔被挤在一起，
   * 也能一眼数出「我这套 build 控住了几只」。
   *
   * ★ 冰与火分别写进**两个** InstancedMesh，几何体不同（晶体 / 火舌）。
   *   同一只怪同时中两种状态时只画灼烧那层 —— 沿用旧优先级：
   *   「正在持续掉血」比「走得慢」更需要被看见。
   *
   * 尺寸必须按**几何体的实际外廓**（R[type].geo.radius / height）算，
   * 不能按 def.radius（那是碰撞半径）。踩过的坑：一开始用碰撞半径乘 1.45，
   * 结果壳整个套在妖魔**体内** —— 加色混合不写深度，但深度测试照样生效，
   * 埋在身体里的壳被挡住，只在身侧漏出几个小色块，看着像贴了几个斑点。
   *
   * 另外 ico 的内切半径只有外接半径的约 0.8 倍，所以倍数要给得比直觉大。
   *
   * 用 e.wob 当相位而不是全局 runT：每只怪的呼吸节奏错开，
   * 一整片壳同频闪会读成「屏幕在闪」，错开才读成「一群活的怪」。
   */
  function writeStatusShell() {
    if (!shellFrost || !shellBurn) return;
    var fArr = shellFrost.instanceMatrix.array;
    var bArr = shellBurn.instanceMatrix.array;
    var nf = 0, nb = 0;
    for (var ti = 0; ti < TYPES.length; ti++) {
      var type = TYPES[ti];
      var list = byType[type];
      if (!list.length) continue;
      var g0 = R[type].geo;
      var baseR = g0.radius * 1.55 + 0.28;
      var baseH = g0.height * 0.62 + 0.16;
      var baseY = g0.height * 0.44;
      var fl = XS.ENEMY[type].float || 0;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.dead) continue;
        var burning = e.burnT > 0;
        var frozen = e.slowT > 0;
        if (!burning && !frozen) continue;

        var arr, idx;
        if (burning) {
          if (nb >= STATUS_CAP) continue;
          arr = bArr; idx = nb;
        } else {
          if (nf >= STATUS_CAP) continue;
          arr = fArr; idx = nf;
        }
        var off = idx * 16;
        /* 出场动画期间不套壳：妖魔还在从地里钻出来，
           壳先出现会穿帮。 */
        var g = Math.min(1, e.spawnT / (e.spawnDur || 0.38));
        var grow = 1 - Math.pow(1 - g, 3);
        var breathe = 1 + Math.sin(runT * 4.2 + e.wob) * 0.045;
        var rr = baseR * grow * breathe;
        var hy = baseH * grow * breathe;

        arr[off] = rr;      arr[off + 1] = 0;        arr[off + 2] = 0;       arr[off + 3] = 0;
        arr[off + 4] = 0;   arr[off + 5] = hy;       arr[off + 6] = 0;       arr[off + 7] = 0;
        arr[off + 8] = 0;   arr[off + 9] = 0;        arr[off + 10] = rr;     arr[off + 11] = 0;
        arr[off + 12] = e.x;
        /* 竖直中心抬到妖魔腰腹：贴地套壳会有一半埋进地面 */
        arr[off + 13] = baseY + fl * 0.5;
        arr[off + 14] = e.z;
        arr[off + 15] = 1;

        if (burning) {
          /* 灼烧的壳更亮、更暖；冰壳则冷而含蓄 */
          _shellColor.copy(SHELL_BURN).multiplyScalar(0.85 + 0.30 * Math.sin(runT * 9 + e.wob));
          shellBurn.setColorAt(nb, _shellColor);
          nb++;
        } else {
          _shellColor.copy(SHELL_FROST).multiplyScalar(0.78);
          shellFrost.setColorAt(nf, _shellColor);
          nf++;
        }
      }
    }
    shellFrost.count = nf;
    shellBurn.count = nb;
    shellFrost.instanceMatrix.needsUpdate = true;
    shellBurn.instanceMatrix.needsUpdate = true;
    if (shellFrost.instanceColor && nf > 0) shellFrost.instanceColor.needsUpdate = true;
    if (shellBurn.instanceColor && nb > 0) shellBurn.instanceColor.needsUpdate = true;
  }

  /* 稀有度标记写入（仅无障碍模式）
   *
   * 标记是**朝向相机**的平面片。这里的相机是个特例：
   * 它始终以固定的俯角跟着玩家（offset 固定、lookAt 目标相对相机固定），
   * 所以朝向每帧只有极小的偏航变化 —— 但仍然要每帧从相机的世界矩阵
   * 取一次旋转，不能烘死。烘死的话玩家跑到场地边缘时，
   * 标记会明显侧过去（相机为了跟人转了几度），看起来像贴纸翘边。
   *
   * 妖将画 1 个「∨」，魔尊画 2 个叠起来 —— 「一个还是两个」可数，
   * 不依赖颜色也不依赖体积估计。 */
  function writeMarkers() {
    if (!markers) return;
    if (!markers.visible) { markers.count = 0; return; }
    var cam = XS.Core.camera;
    if (!cam) { markers.count = 0; return; }
    /* 相机的位置/朝向是在 updatePlayer 里写的，而 matrixWorld 要等渲染
       才刷新 —— 直接读会拿到**上一帧**的朝向。虽然偏差极小，
       但这里的正确性不该依赖「偏差足够小」，强制刷一次最省心。 */
    cam.updateMatrixWorld(true);
    /* 从相机世界矩阵里只取旋转（列主序的 3×3 部分），丢掉平移和缩放 */
    _camMat.copy(cam.matrixWorld);
    _camMat.setPosition(0, 0, 0);
    _camQuat.setFromRotationMatrix(_camMat);

    var arr = markers.instanceMatrix.array;
    var n = 0;
    for (var li = 0; li < 2; li++) {
      var type = li === 0 ? 'elite' : 'boss';
      var list = byType[type];
      if (!list.length) continue;
      var g0 = R[type].geo;
      var stacks = type === 'boss' ? 2 : 1;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.dead) continue;
        /* 出场动画期间不显示：妖魔还没站稳，先挂个标记很奇怪 */
        var g = Math.min(1, e.spawnT / (e.spawnDur || 0.38));
        if (g < 1) continue;
        var topY = (g0.height + (XS.ENEMY[type].float || 0) * 0.5) * 1.05 + 0.42;
        var bob = Math.sin(runT * 2.6 + e.wob) * 0.07;
        var sc = type === 'boss' ? 1.5 : 1.0;
        for (var s = 0; s < stacks; s++) {
          if (n >= markers.instanceMatrix.count) break;
          _mkPos.set(e.x, topY + s * 0.34 + bob, e.z);
          _mkScale.set(sc, sc, sc);
          _mkM.compose(_mkPos, _camQuat, _mkScale);
          _mkM.toArray(arr, n * 16);
          n++;
        }
      }
    }
    markers.count = n;
    markers.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
   * 无障碍开关的**渲染侧**落地
   *
   * 设置面板里那两个开关调用的就是这里。分开写的原因：
   * 设置存的是「意图」，这里落的是「画面」——
   * 只要这两件事分开，就一定会有「开关存下来了但画面没变」的 bug，
   * 而那种 bug 从面板上看是看不出来的（开关亮着、刷新还在）。
   * 所以 applyA11y 只做渲染侧的事，且可以被 debugA11y() 直接验证。
   * ============================================================ */
  Game.applyA11y = function () {
    var S = XS.Settings || {};
    var cb = !!S.colorblind;
    TYPES.forEach(function (tp) {
      if (R[tp] && R[tp].outline) R[tp].outline.visible = cb;
    });
    if (markers) markers.visible = cb;
    if (document.body) {
      document.body.classList.toggle('bigtext', !!S.bigText);
    }
    return cb;
  };


  /* ============================================================
   * 结算
   * ============================================================ */
  function snapshot() {
    return {
      dur: runT,
      level: player ? player.level : 1,
      kills: killCount,
      dmgDealt: Math.round(statDmgDealt),
      dmgTaken: Math.round(statDmgTaken),
      fpsAvg: liveFpsAvg,
      reviveLeft: reviveLeft,
      doubleUsed: doubleUsed,
      soulCoins: soulCoins,
      /* 入账灵石（已乘聚宝倍率）。结算界面显示的是**入账值**而不是
         soulCoins 原值 —— 玩家买了「聚宝」就该在结算上看到它生效，
         否则那笔消费永远没有兑现的瞬间。 */
      coins: Math.round(soulCoins * (XS.Meta ? XS.Meta.coinMul() : 1)),
      /* 广告点位要不要摆出来，取决于**宿主能力**而不是玩家次数。
         两个条件分开报，界面层才能各自判断：
         reviveLeft 是「还剩几次」，adOk 是「这次机会能不能兑现」。 */
      adOk: !!(XS.Platform && XS.Platform.canShowAd && XS.Platform.canShowAd()),
      /* 这一局是不是**同步模拟**（无人值守跑局）。同步模拟下主循环不按
         真实时间推进，`fpsAvg` 量到的是「模拟器跑得多快」——
         实测能到 3600 fps。它**不是**玩家的帧率，所以结算面板不该把它
         当成一个成绩展示：作品集截图里那个「平均帧率 3600 fps」，
         看的人只会以为是 bug。界面层拿到这个字段后显示「—」。
         判据要能区分「不知道」和「不是同步」：这里恒为布尔。 */
      syncSim: syncSim,
      causeText: causeText(lastCause)
    };
  }

  function finishRun(result) {
    var base = snapshot();
    if (runFinished) return base;
    runFinished = true;
    var rec = Tele.endRun(result, { duration: runT, soulCoins: soulCoins, syncSim: syncSim });
    if (!rec) return base;
    XS.UI.saveBest(rec);
    /* 局外结算：灵石入账 + 成就判定。
       放在 finishRun 而不是死亡瞬间，是因为「复活」会让本局继续 ——
       在死亡时结算就等于「死一次领一次」，复活反而变成了亏。
       finishRun 由 runFinished 保证只跑一次，所以不会重复入账。 */
    if (XS.Meta && !XS.Meta.offline) {
      var res = XS.Meta.commitRun(rec);
      if (res.earned > 0) {
        XS.UI.announce('灵石入账', '+' + res.earned, C.gold, 1600);
      }
      if (res.newAch.length) XS.UI.achievementToast(res.newAch);
    }
    return {
      dur: rec.dur, level: rec.level, kills: rec.kills,
      dmgDealt: rec.dmgDealt, dmgTaken: rec.dmgTaken, fpsAvg: rec.fpsAvg,
      /* 结算面板那份 = 实时快照 + 这一局的最终记录。
         两边**必须**从同一个 snapshot() 取值 —— 这里原来把字段列表
         手抄了一遍，于是我给 snapshot() 加 `adOk` 时只加到了其中一份上，
         而界面读的是**另一份**：`stats.adOk` 是 undefined，
         `stats.adOk !== false` 判成真，宿主没有广告能力也照样把
         「看广告复活」画了出来。诊断里 `run.adOk` 明明写着 false，
         两份读数互相矛盾 —— 那正是「同一件事写了两遍」的味道。 */
      reviveLeft: base.reviveLeft, doubleUsed: base.doubleUsed,
      soulCoins: base.soulCoins, adOk: base.adOk,
      /* syncSim 也走 base，理由同上 —— 手抄字段列表就会漏。 */
      syncSim: base.syncSim,
      causeText: causeText(rec.cause)
    };
  }

  /* 神行符入口的开关。
     Web 版是一个 HTML 按钮（class `show`），小游戏版是画在 HUD 上的
     一个区域（ui2d 的 S.boostOn）。两边各自实现，但**开关必须由
     游戏层喊** —— 原来只有 Web 那半边被喊到了：小游戏版的按钮画法、
     命中区、回调全都写好了，却因为没人置 S.boostOn 而一次都没出现过。
     结果是三个广告点位里，**目标平台上一个都不生效**。 */
  function setBoostUi(on) {
    var bb = document.getElementById('boostBtn');
    if (bb) { if (on) bb.classList.add('show'); else bb.classList.remove('show'); }
    if (XS.UI.setBoost) XS.UI.setBoost(on);
  }

  function causeText(c) {
    if (c === 'boss') return '魔尊碾压';
    if (c === 'elite') return '妖将斩杀';
    if (c === 'swarm') return '群妖围杀';
    if (c === 'quit') return '主动退出';
    return '道消身陨';
  }

  function showOverScreen() {
    XS.UI.showOver(snapshot(), {
      onRevive: onReviveAd,
      onRestart: function () { finishRun('die'); Game.start(); },
      onHome: function () { finishRun('die'); Game.quitToMenu(); }
    });
  }

  function onWin() {
    Sfx.play('evolve', 1);
    state = 'win';
    soulCoins += 500;
    XS.UI.hideBoss();
    showWinScreen();
    XS.UI.announce('渡劫成功', '灵石 +500', C.gold, 2600);
  }

  function showWinScreen() {
    XS.UI.showWin(snapshot(), {
      onDouble: onDoubleAd,
      onRestart: function () { finishRun('win'); Game.start(); },
      onHome: function () { finishRun('win'); Game.quitToMenu(); }
    });
  }

  /* ---------------- 广告点位 ---------------- */
  function onReviveAd() {
    var placement = XS.AD.revive;
    Tele.adImpression(runT, placement, 'death');
    Platform.showAd(placement, function (res) {
      Tele.adResult(runT, placement, res.completed);
      if (!res.completed) {
        /* 说清楚为什么。原来无论什么原因都报「广告未看完」——
           宿主没有广告 API 时，玩家没看完的不是广告。 */
        XS.UI.announce('无法复活',
          (XS.Platform.adFailText ? XS.Platform.adFailText(res) : '广告未看完'), C.cinnabar, 1600);
        return;
      }
      reviveLeft--;
      Tele.revive();
      Tele.event('revive', { t: runT, left: reviveLeft });
      player.hp = player.maxHp;
      player.invuln = 3.0;
      XS.UI.setHp(player.hp, player.maxHp);
      XS.UI.hideAll();
      var cleared = 0;
      for (var ti = 0; ti < TYPES.length; ti++) {
        var arr = byType[TYPES[ti]];
        for (var i = arr.length - 1; i >= 0; i--) {
          var e = arr[i];
          if (e.isBoss || e.dead) continue;
          if (Math.hypot(e.x - player.x, e.z - player.z) < 16) {
            killEnemy(e, true);
            cleared++;
          }
        }
      }
      burstParticles(player.x, player.z, 24, C.jade);
      XS.Core.grade.uniforms.uHeal.value = 1.0;
      XS.UI.announce('元神归位', '清除周身妖魔 ' + cleared, C.jade, 1800);
      state = 'playing';
    });
  }

  function onDoubleAd() {
    var placement = XS.AD.doubleXp;
    Tele.adImpression(runT, placement, 'result');
    Platform.showAd(placement, function (res) {
      Tele.adResult(runT, placement, res.completed);
      if (!res.completed) {
        /* 这里原来是一句**静默 return** —— 点了没反应、按钮也不消失，
           玩家只会以为自己没点中，然后一直点。 */
        XS.UI.announce('灵石未能翻倍',
          (XS.Platform.adFailText ? XS.Platform.adFailText(res) : '广告未看完'), C.cinnabar, 1600);
        return;
      }
      soulCoins *= 2;
      doubleUsed = true;
      XS.UI.announce('灵石翻倍', '共 ' + soulCoins + ' 灵石', C.gold, 1600);
      if (state === 'win') showWinScreen();
    });
  }

  Game.onBoostAd = function () {
    if (boostUsed) return;
    var placement = XS.AD.boost;
    Tele.adImpression(runT, placement, 'hud');
    Platform.showAd(placement, function (res) {
      Tele.adResult(runT, placement, res.completed);
      if (!res.completed) {
        /* 同「灵石翻倍」：静默 return 会让 HUD 上的按钮变成一个死键。 */
        XS.UI.announce('神行符未激活',
          (XS.Platform.adFailText ? XS.Platform.adFailText(res) : '广告未看完'), C.cinnabar, 1600);
        return;
      }
      boostUsed = true;
      player.boostT = 30;
      setBoostUi(false);
      XS.UI.announce('神行符', '30 秒内身法与攻速提升', C.purple, 1600);
    });
  };

  /* ---------------- 暂停 / 退出 ---------------- */
  var mainHandlers = null;

  Game.pause = function () {
    if (state !== 'playing') return;
    state = 'paused';
    XS.UI.showPause(
      function () { XS.UI.hidePause(); state = 'playing'; },
      function () { XS.UI.hidePause(); finishRun('quit'); Game.quitToMenu(); },
      function () {
        /* 设置面板：暂停态保持不变，关掉设置后回到暂停菜单 */
        XS.UI.hidePause();
        XS.UI.showSettings();
      }
    );
  };

  /* 设置关闭后回到暂停菜单 */
  Game.backToPause = function () {
    XS.UI.hideSettings();
    if (state === 'paused') XS.UI.showPause(
      function () { XS.UI.hidePause(); state = 'playing'; },
      function () { XS.UI.hidePause(); finishRun('quit'); Game.quitToMenu(); },
      function () { XS.UI.hidePause(); XS.UI.showSettings(); }
    );
  };

  /* 同步模拟模式开关：开启后不记录帧率（dt 恒定，测不到真帧率） */
  Game.setSyncMode = function (v) { syncSim = !!v; };

  /* 丢弃当前对局（不写入打点）—— 无人值守批量跑局收尾用 */
  Game.discardRun = function () {
    if (state === 'playing' || state === 'levelup' || state === 'paused') runFinished = true;
    Game.quitToMenu();
  };

  Game.quitToMenu = function () {
    if (state === 'playing' || state === 'levelup' || state === 'paused') finishRun('quit');
    state = 'ready';
    if (playerMesh) playerMesh.visible = false;
    pendingStrikes.length = 0;
    /* 回主菜单必须清场，否则整片战场会冻在开始界面背后（见 clearBattlefield） */
    clearBattlefield();
    XS.UI.hideAll();
    XS.UI.hideBoss();
    XS.UI.showStart(mainHandlers);
  };

})(window);
