/* ============================================================
 * 启动与主循环
 *
 * 调试参数（用于无人值守验证 / 截图 / 造数据）：
 *   ?autostart=1     自动开局
 *   ?autopilot=1     真实运行时自动操作（自动走位 + 自动选功法）
 *   ?play=N          同步模拟 N 秒（机器人操作），停在游戏中并渲染一帧
 *   ?farm=K          机器人完整跑 K 局（用于生成打点数据）
 *   ?adok=1          广告必定完成（模拟环境）
 *   ?noauto=1        不自动点开始
 *   ?settings=1      直接打开设置面板（UI 走查）
 *   ?tip=1           常驻教学提示条（UI 走查；?tip=文案 可自定义）
 *   ?mat=1           打印材质/灯光探针（诊断「画面全黑」这类问题）
 *   ?evo=<id>        灌满指定功法并弹出进化面板（UI 走查）
 *                    取值：sword / qi / thunder / ember / frost / aura
 *   ?takeevo=1       配合 ?evo= 使用：直接完成进化，不弹面板
 *                    （用于检查技能栏的「已进化」标记）
 *   ?build=1         诊断里附带构筑快照（功法等级 / 进化 / 实际数值）
 *   ?meta=1          直接打开山门面板（UI 走查）；?meta=codex 指定 Tab
 *                    取值：shop / ach / codex
 *   ?nometa=1        假装一件永久强化都没买（可复现的平衡基线）
 *   ?metamax=1       假装永久强化全部拉满（量「玩到后期」的天花板）
 *   ?metaset=hp:8,power:8  只开指定的几条永久强化（逐条定位平衡影响）
 *   ?grant=N         给 N 灵石（调试商店购买流程）
 *   ?metaunlock=1    点亮全部成就与图鉴（UI 走查）
 *   ?reveal=N        每类只点亮前 N 条成就 / 图鉴（造「半亮」状态截图用）
 *   ?spawn=a:3,b:2   把指定妖魔直接刷在玩家身前（配合 ?preroll=N 出图）
 *   ?zoom=0.45       相机拉近（美术走查：妖魔占满画面才看得出问题）
 *
 * 注：?farm / ?metamax / ?metaset / ?metaunlock / ?reveal 都会把会话标成
 * 「不写档」（Meta.offline），?grant 跟着它走 —— 走查和批量跑局永远不碰真实存档。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS;

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function has(name) {
    return new RegExp('[?&]' + name + '(?:=1|&|$)').test(global.location.search);
  }

  var tGlobal = 0;
  var last = 0;
  var farmTrace = [];
  var farmLastState = null;
  /* 批量跑局的**停因**。没有它的话，一个被墙上时间砍断的样本
     和一个正常跑完的样本在诊断里长得一模一样（都只是 totalRuns: N），
     读的人只能靠「N 比预期小」去猜 —— 猜错方向就会去调虚拟时间预算。 */
  var farmStop = null;      // 'done' | 'wall'
  var farmGuard = 0;        // 实际推进的步数
  var farmGuardMax = 0;     // 步数上限
  var farmWallMs = 0;       // 实际用掉的墙上时间
  var botPaused = false;   // ?nobot=1：冻结机器人的自动点击（UI 走查用）
  var autopilot = has('autopilot');
  var booted = false;
  var bootError = null;
  var frozen = false;   // 模拟模式下只出帧、不推进逻辑

  /* ============================================================
   * 机器人操作（与真人共用同一套输入）
   *
   * **走位大脑在 js/bot.js**，不在这里。
   * 原因：小游戏版走查也要同一个机器人，而 main.js 是 Web 专有的、
   * 不进小游戏包。两边都只写 XS.Input.vec —— 和真人手指写同一个字段，
   * 所以「机器人能跑」和「玩家能跑」验证的是同一条代码路径。
   *
   * 选牌策略不在这里（那是 UI 层的事，两个宿主的点法不同），
   * 见 botHandleState() 与 minigame/boot.js 的 botPick()。
   * ============================================================ */
  var Bot = XS.Bot;

  var botBoostTried = false;
  var botDoubleTried = false;

  function botHandleState() {
    var st = XS.Game.state();
    if (st === 'levelup') {
      /* 策略本体在 XS.Bot.pickCard()（js/bot.js），两个宿主共用。
         这里只负责「把下标对应的 DOM 卡片点掉」。
         以前这里是自己抓 DOM 文本（`已习得 Lv3` / `尚未习得`）判等级的，
         和小游戏版读 `current` 字段选出来的构筑不一样 ——
         同条件跑出来的平衡数据因此对不上。 */
      var cards = XS.Game.currentChoices();
      var pick = XS.Bot.pickCard(cards);
      if (pick < 0) return;
      var els = document.querySelectorAll('#cards .card');
      if (els[pick]) els[pick].click();
      return;
    }
    if (st === 'over') {
      var rv = document.getElementById('reviveBtn');
      if (rv && rv.style.display !== 'none') { rv.click(); return; }
      var rs = document.getElementById('overRestart');
      if (rs) { botBoostTried = false; botDoubleTried = false; rs.click(); }
      return;
    }
    if (st === 'win') {
      /* 模拟真人：结算页先看一眼「灵石翻倍」的激励视频，再重开 */
      if (!botDoubleTried) {
        botDoubleTried = true;
        var wd = document.getElementById('winDouble');
        if (wd && wd.style.display !== 'none') { wd.click(); return; }
      }
      var wr = document.getElementById('winRestart');
      if (wr) { botBoostTried = false; botDoubleTried = false; wr.click(); }
      return;
    }
    if (st === 'playing') {
      /* 模拟真人：HUD 上出现「看广告得神行符」时点一次 */
      if (!botBoostTried) {
        var bb = document.getElementById('boostBtn');
        if (bb && bb.className.indexOf('show') !== -1) {
          botBoostTried = true;
          bb.click();
        }
      }
    }
  }

  /* 调试机位：?topcam=1 俯视全场，?cam=x,y,z 指定机位 */
  function applyDebugCam() {
    if (!has('topcam') && !qs('cam')) return;
    var cam = XS.Core.camera;
    if (has('topcam')) {
      cam.fov = 46;
      cam.position.set(0, 86, 0.01);
      cam.lookAt(0, 0, 0);
    } else {
      var v = qs('cam').split(',').map(Number);
      if (v.length >= 6) {
        cam.fov = v.length >= 7 ? v[6] : 46;
        cam.position.set(v[0], v[1], v[2]);
        cam.lookAt(v[3], v[4], v[5]);
      }
    }
    cam.updateProjectionMatrix();
  }

  function stepOnce(dt) {
    Bot.input(dt);
    tGlobal += dt;
    XS.World.update(dt, tGlobal);
    XS.Game.update(dt, tGlobal);
    /* ?nobot=1 时不做任何自动点击。
       走查「升级面板长什么样」时必须关掉机器人 ——
       否则它会在下一帧把进化卡点掉，面板一闪就没了，截图永远拍不到。 */
    if (!botPaused) botHandleState();
  }

  /* ============================================================
   * 诊断输出
   * ============================================================ */
  /* 状态视觉走查：一半妖魔冰缓、一半灼烧，用来验证状态外壳是否
     真的画得出来。数值给大是为了扛住随后两帧的衰减。 */
  function applyStatusProbe() {
    var byT = XS.Game.debugEnemies && XS.Game.debugEnemies();
    if (!byT) return;
    var k = 0;
    for (var tp in byT) {
      var arr = byT[tp];
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        if (e.dead) continue;
        if (k % 2 === 0) { e.slowT = 60; e.slow = 0.5; }
        else { e.burnT = 60; e.burnDps = 1; }
        k++;
      }
    }
  }

  function emitDiag() {
    var out = {
      errors: (global.__diag && global.__diag.errors) || [],
      bootError: bootError,
      threeRev: global.THREE ? THREE.REVISION : null,
      state: XS.Game.state(),
      botSkill: +Bot.skill().toFixed(2),
      /* 这一发有没有模拟过用户手势（?gesture=1）。
         音频解锁挂在 pointerdown 上，而机器人用的是 .click() ——
         不派发手势的话音频永远不会解锁，这时「一个音都没出去」
         是**预期行为**而不是故障。判据要靠它分流，
         否则每次 ?play 都会误报一次。 */
      gesture: has('gesture'),
      search: global.location.search
    };
    try {
      var c = document.querySelector('canvas');
      var gl = null;
      try { gl = c && (c.getContext('webgl2') || c.getContext('webgl')); } catch (e) {}
      out.canvas = c ? (c.width + 'x' + c.height) : null;
      /* 窗口尺寸，用来核对画布有没有真的挂在屏幕上。
         判据是「画布后备存储 ≥ 窗口尺寸」（不是相等）——
         retina 下后备存储是 CSS 尺寸 × pixelRatio，相等会误报。 */
      out.inner = global.innerWidth + 'x' + global.innerHeight;
      out.gl = gl ? gl.getParameter(gl.VERSION) : null;
      /* 最终是哪一组参数把渲染器建起来的。
         正常环境是 'webgl2+highperf'；一旦报出别的值，
         说明这台机器上发生了降级 —— 这是**环境问题**，
         不是游戏问题，但值得记下来：降级能跑通，
         却往往伴随着性能或特性差异（比如 WebGL1 没有
         instancing 的某些扩展，颜色管线也不一样）。
         没有这一项的话，「画面比别人的暗/慢」只能靠猜。 */
      out.glAttempt = XS.Core.glAttempt || null;

      var p = XS.Game.player();
      if (p) {
        out.player = {
          level: p.level, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp),
          x: +p.x.toFixed(1), z: +p.z.toFixed(1),
          taken: p.taken,
          swordCount: p.sword.count,
          qi: p.qi.enabled, thunder: p.thunder.enabled, frost: p.frost.enabled,
          aura: p.aura.enabled, ember: p.ember.enabled
        };
        if (XS.Game.debugStatus) out.status = XS.Game.debugStatus();
        if (XS.Game.debugFx) out.fx = XS.Game.debugFx();
      }
      /* 计时 / 击杀来自**游戏层**（Game.debugRun），不再抓 DOM 文本。
         抓 DOM 有两个问题：
           1. HUD 文本本身就是这些量渲染出来的，等于绕一圈自己证自己；
           2. 小游戏没有 DOM —— 那边同一项只能写常量占位，
              两个宿主一对比就会得出「小游戏统计坏了」这种假结论。
         HUD 有没有把数字画对，用截图看；数值对不对，看这里。
         两边共用同一个访问器，字段名也就自然一致了。 */
      out.run = XS.Game.debugRun ? XS.Game.debugRun() : null;
      /* 氛围走查：破晓进度 + 画面上下缘实际采样到的天球高度。
         没有这个，「天空还是冷的」到底是没生效还是没拍到，分不出来。 */
      if (XS.World.debugAtmo) out.atmo = XS.World.debugAtmo();
      /* 无障碍走查：必须放在这里（而不是只在 debugStatus 里），
         因为设置面板截图时**没有 player**，走不到那一段 ——
         而「面板打开了但开关没接上」正是最需要被看见的情况。 */
      if (XS.Game.debugA11y) out.a11y = XS.Game.debugA11y();
      out.skills = document.querySelectorAll('#skillBar .skill').length;
      out.overlayOn = ['startOverlay', 'levelOverlay', 'overOverlay', 'winOverlay', 'pauseOverlay', 'metaOverlay']
        .filter(function (id) {
          var e = document.getElementById(id);
          return e && e.className.indexOf('on') !== -1;
        });
      out.sceneChildren = XS.Core.scene ? XS.Core.scene.children.length : 0;
      out.drawCalls = XS.Core.renderer ? XS.Core.renderer.info.render.calls : 0;
      out.triangles = XS.Core.renderer ? XS.Core.renderer.info.render.triangles : 0;
      out.prScale = XS.Core.prScale;

      if (has('mat')) {
        var probe = [], lights = [], lightsN = 0;
        var fx = function (v) { return (typeof v === 'number' && isFinite(v)) ? +v.toFixed(3) : String(v); };
        var rgb = function (o) { return o ? [fx(o.r), fx(o.g), fx(o.b)] : null; };
        XS.Core.scene.traverse(function (o) {
          if (o.isLight) { lightsN++; lights.push(o.type + ':' + o.intensity); }
          if (o.isInstancedMesh && o.material && o.material.type === 'MeshPhongMaterial') {
            var g = o.geometry, ca = g.attributes.color, na = g.attributes.normal;
            var pa = g.attributes.position;
            /* 只读 col0 是不够的。
               盾卫那次「本体一片白」就是栽在这里：col0 是正常深板岩色，
               于是探针报「颜色没问题」，可实际渲染是纯白 ——
               病因在**后面的顶点**上，只采第 0 个样本永远看不见。
               所以这里给出整条属性的极值 + 分段采样，让「部分顶点错」
               和「整体错」在数据上就是两件不同的事。 */
            var colStats = null;
            if (ca) {
              var a = ca.array, mn = Infinity, mx = -Infinity, nan = 0;
              for (var ai = 0; ai < a.length; ai++) {
                var av = a[ai];
                if (!isFinite(av)) { nan++; continue; }
                if (av < mn) mn = av;
                if (av > mx) mx = av;
              }
              var vn = a.length / 3;
              var sample = [];
              for (var si = 0; si < 5; si++) {
                var vi = Math.min(vn - 1, Math.floor(vn * si / 4));
                sample.push([fx(a[vi * 3]), fx(a[vi * 3 + 1]), fx(a[vi * 3 + 2])]);
              }
              colStats = { min: fx(mn), max: fx(mx), nan: nan, verts: vn, sample: sample };
            }
            /* 法线统计。
               「整只怪一片白、而且每个面一样白」是**没有明暗**的症状，
               而法线全零正是「没有明暗」最直接的成因（逐面光照全部归零，
               只剩半球光的常量项）。所以必须能看到「有多少个法线是零」——
               只看 nor0 一个样本，会漏掉「前几个有、后面全没有」的情况。 */
            var norStats = null;
            if (na) {
              var nn = na.array, nz = 0, nnan = 0, lenMin = Infinity, lenMax = -Infinity;
              for (var ni = 0; ni + 2 < nn.length; ni += 3) {
                var nx = nn[ni], ny = nn[ni + 1], nzz = nn[ni + 2];
                if (!isFinite(nx) || !isFinite(ny) || !isFinite(nzz)) { nnan++; continue; }
                var ln = Math.sqrt(nx * nx + ny * ny + nzz * nzz);
                if (ln < 1e-6) nz++;
                if (ln < lenMin) lenMin = ln;
                if (ln > lenMax) lenMax = ln;
              }
              norStats = { zero: nz, nan: nnan, lenMin: fx(lenMin), lenMax: fx(lenMax),
                           verts: nn.length / 3 };
            }
            probe.push({
              count: o.count, cap: o.instanceMatrix.count,
              vc: o.material.vertexColors,
              hasColorAttr: !!ca, hasNormalAttr: !!na,
              posLen: pa ? pa.array.length : 0,
              colLen: ca ? ca.array.length : 0,
              /* 长度对不上 = 属性错位，比颜色值本身更致命 */
              colAlign: (ca && pa) ? (ca.array.length === pa.array.length) : null,
              col0: ca ? [fx(ca.array[0]), fx(ca.array[1]), fx(ca.array[2])] : null,
              colStats: colStats,
              norStats: norStats,
              nor0: na ? [fx(na.array[0]), fx(na.array[1]), fx(na.array[2])] : null,
              instCol0: o.instanceColor ? [fx(o.instanceColor.array[0]), fx(o.instanceColor.array[1]), fx(o.instanceColor.array[2])] : null,
              matCol: rgb(o.material.color),
              emissive: rgb(o.material.emissive),
              emissiveIntensity: o.material.emissiveIntensity
            });
          }
        });
        out.matProbe = probe;
        out.lightCount = lightsN;
        out.lights = lights;
        out.outputEncoding = XS.Core.renderer.outputEncoding;
        out.toneMapping = XS.Core.renderer.toneMapping;
      }

      var runs = XS.Telemetry.getRuns();
      out.runCount = runs.length;
      if (runs.length) {
        out.lastRun = runs[runs.length - 1];
      }
      out.summary = XS.Telemetry.summarize();
      /* 音频。两个宿主各报一份，字段含义完全一致 ——
         这个子系统以前一条读数都没有，「音频没响」这类问题
         光读代码是看不出来的（34 个调用点全都在）。 */
      if (XS.Audio && XS.Audio.debugInfo) out.audio = XS.Audio.debugInfo();
      /* 批量跑局的自述：要了多少局、跑出多少局、**为什么停**。
         把 want/got/stop 三个一起报，读者一眼就能判断这份样本能不能引用 ——
         而不是去比「35 和 48 差多少」再猜原因。 */
      if (farmStop) {
        out.farm = {
          want: parseInt(qs('farm') || '0', 10),
          got: runs.length,
          stop: farmStop,
          wallMs: farmWallMs,
          steps: farmGuard,
          stepLimit: farmGuardMax
        };
      }
      if (has('full')) out.runs = runs;
      out.session = XS.Telemetry.session;
      if (farmTrace.length) out.farmTrace = farmTrace;
      /* 构筑快照：?build=1 时输出，用来确认「进化到底有没有落到数值上」 */
      if (qs('build') !== null || qs('evo') !== null) out.build = XS.Game.debugBuild();
      /* 局外成长快照：存档里买了什么 + 实际进了 player 什么 */
      if (qs('build') !== null || qs('evo') !== null || has('meta') || has('metamax')) {
        out.meta = XS.Game.debugMeta();
        var mo = document.getElementById('metaOverlay');
        out.metaCls = mo ? mo.className : null;
      }
    } catch (e) {
      out.diagError = e.message + ' | ' + e.stack;
    }
    var pre = document.createElement('pre');
    pre.id = '__diag_out';
    pre.style.display = 'none';
    pre.textContent = 'DIAG' + '_JSON_START' + JSON.stringify(out) + 'DIAG' + '_JSON_END';
    document.body.appendChild(pre);
  }

  /* 启动失败时的界面。
     原来这里直接把 `err.stack` 贴进 #loading —— 用户看到的是一屏
     "Error creating WebGL context. at new ws (three.min.js:6:337663)"，
     既不知道发生了什么，也不知道能做什么。

     WebGL 建不出来这件事**几乎总是环境问题，不是代码问题**，
     而且绝大多数情况用户自己能解决。所以这里按「先给结论、
     再给办法、最后才给技术细节」的顺序排：
       1. 一句话说清是什么坏了；
       2. 探测结果（浏览器到底给不给 WebGL、什么显卡）——
          没有这一项就分不清「浏览器不支持」和「驱动/加速被关」；
       3. 可操作的几步；
       4. 技术细节收在最后，给要报 bug 的人复制。

     探测用的是**一次性 canvas**，所以走到这里真画布还是干净的 ——
     用户刷新一下、关掉几个标签页就有机会直接成功。 */
  function showBootFailure(err) {
    var ld = document.getElementById('loading');
    if (!ld) return;
    var msg = (err && err.message) ? err.message : String(err);
    var isGL = /webgl|context/i.test(msg);

    var probe = null;
    try { probe = (XS.Core && XS.Core.probeGL) ? XS.Core.probeGL() : null; } catch (e) {}

    var html = '';
    if (isGL) {
      var hasAny = probe && (probe.webgl2 || probe.webgl1);
      html += '<div class="bootfail">';
      html += '<h2>显卡加速没打开，游戏起不来</h2>';
      html += '<p class="lead">这个游戏需要浏览器的 WebGL（3D 绘图）能力，'
            + '刚才没能建出来。' + (hasAny
              ? '不过探测显示<strong>你的浏览器是支持 WebGL 的</strong> —— '
                + '多半是标签页开太多、或者上一次的 3D 上下文还没释放。'
              : '探测显示<strong>当前浏览器拿不到 WebGL</strong>。') + '</p>';

      html += '<div class="steps"><b>按顺序试这几步，多数情况第 1 步就好了：</b><ol>';
      html += '<li><b>刷新这个页面</b>（⌘R / Ctrl+R）—— 上下文释放后常常一次就成</li>';
      html += '<li><b>关掉其他开着 3D / 视频 / 地图的标签页</b>'
            + '<span>浏览器同时只允许约 16 个 WebGL 上下文，用完就再也建不出来了</span></li>';
      html += '<li><b>确认硬件加速是开着的</b>'
            + '<span>Chrome：设置 → 系统 → 「使用硬件加速模式」；'
            + '开着的话把它关掉再打开一次，然后重启浏览器</span></li>';
      html += '<li><b>换个浏览器</b>（Chrome / Edge / Safari 都行）'
            + '<span>或者用别的设备打开</span></li>';
      html += '</ol></div>';

      html += '<div class="probe"><b>这台机器上的探测结果</b><table>';
      html += '<tr><td>WebGL 2</td><td>' + (probe ? (probe.webgl2 ? '可用' : '不可用') : '探测失败') + '</td></tr>';
      html += '<tr><td>WebGL 1</td><td>' + (probe ? (probe.webgl1 ? '可用' : '不可用') : '探测失败') + '</td></tr>';
      if (probe && probe.renderer) {
        html += '<tr><td>渲染器</td><td>' + esc(probe.renderer) + '</td></tr>';
      }
      if (probe && probe.vendor) {
        html += '<tr><td>厂商</td><td>' + esc(probe.vendor) + '</td></tr>';
      }
      if (probe && probe.error) {
        html += '<tr><td>探测异常</td><td>' + esc(probe.error) + '</td></tr>';
      }
      html += '</table></div>';
      html += '<p class="hint">这个游戏是<b>离线单文件</b>交付的：'
            + '双击 index.html 就能玩，不需要服务器、不需要联网。'
            + '所以上面这些都不是「装什么依赖」的问题，纯粹是浏览器的 3D 能力。</p>';
      /* 一键复制诊断。
         为什么需要：这张面板里的信息（探测结果 + UA + 错误）就是定位问题
         需要的**全部**输入，但让用户「把这一屏截图发我」会丢信息、
         也不方便。给一个按钮，复制出来是一段可以直接粘进聊天窗口的文本。 */
      html += '<button id="bootCopy" class="copyBtn">复制诊断信息</button>';
      html += '</div>';
    } else {
      html += '<div class="bootfail"><h2>启动时出错了</h2>'
            + '<p class="lead">' + esc(msg) + '</p></div>';
    }

    html += '<details class="tech"><summary>技术细节（反馈问题时把这段贴出来）</summary>'
          + '<pre>' + esc(bootError) + '</pre></details>';

    ld.innerHTML = html;
    ld.classList.add('failed');

    var btn = document.getElementById('bootCopy');
    if (btn) {
      btn.onclick = function () {
        var txt = bootDiagText(probe, msg);
        var done = function (ok) {
          btn.textContent = ok ? '已复制 ✓ 直接粘给我就行' : '复制失败，请手动选中下方文字';
          setTimeout(function () { btn.textContent = '复制诊断信息'; }, 2600);
        };
        try {
          if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function () { done(true); },
              function () { done(false); });
          } else {
            /* file:// 下 navigator.clipboard 常常不可用（非安全上下文），
               退回到 textarea + execCommand 这条老路。 */
            var ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            done(ok);
          }
        } catch (e) { done(false); }
      };
    }
  }

  /* 失败诊断的纯文本版本 —— 给「复制诊断信息」按钮用。
     刻意用 `键: 值` 的朴素格式：它要能直接粘进聊天窗口，
     不需要对方装任何工具去读。 */
  function bootDiagText(probe, msg) {
    var L = [];
    L.push('【仙台问剑 · 启动失败诊断】');
    L.push('错误: ' + msg);
    L.push('降级链: webgl2+highperf → webgl2 → webgl1 → bare（每级换一张全新画布）');
    L.push('');
    L.push('WebGL 2: ' + (probe ? (probe.webgl2 ? '可用' : '不可用') : '探测失败'));
    L.push('WebGL 1: ' + (probe ? (probe.webgl1 ? '可用' : '不可用') : '探测失败'));
    if (probe && probe.renderer) L.push('渲染器: ' + probe.renderer);
    if (probe && probe.vendor) L.push('厂商: ' + probe.vendor);
    if (probe && probe.error) L.push('探测异常: ' + probe.error);
    L.push('');
    L.push('UA: ' + (global.navigator ? navigator.userAgent : '?'));
    L.push('平台: ' + (global.navigator ? (navigator.platform || '?') : '?'));
    L.push('窗口: ' + global.innerWidth + 'x' + global.innerHeight
      + ' @dpr' + (global.devicePixelRatio || 1));
    L.push('硬件并发: ' + (global.navigator ? navigator.hardwareConcurrency : '?'));
    L.push('协议: ' + global.location.protocol);
    return L.join('\n');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }


  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    if (booted) return;
    booted = true;

    try {
      var canvas = document.getElementById('scene');
      XS.Core.init(canvas);
      XS.UI.init();
      XS.World.init(XS.Core.scene);
      XS.Game.init(XS.Core.scene, XS.Core.camera);
      XS.Input.bind();
    } catch (err) {
      bootError = (err && err.message ? err.message : String(err)) + '\n' + (err && err.stack ? err.stack : '');
      try { if (global.__diag) global.__diag.errors.push('BOOT: ' + bootError); } catch (e) {}
      showBootFailure(err);
      emitDiag();
      return;
    }

    XS.Game.setMenuHandlers({
      onStart: function () { XS.UI.hideAll(); XS.Game.start(); },
      onData: function () { global.open('data.html', '_blank'); }
    });
    document.getElementById('pauseBtn').onclick = function () { XS.Game.pause(); };
    /* 设置面板：初始化（读取本地配置并立即生效）+ 关闭按钮 */
    XS.UI.initSettings();
    document.getElementById('settingsClose').onclick = function () {
      XS.UI.hideSettings();
      if (XS.Game.state() === 'paused') XS.Game.backToPause();
    };
    XS.UI.showStart({
      onStart: function () { XS.UI.hideAll(); XS.Game.start(); },
      onData: function () { global.open('data.html', '_blank'); }
    });
    global.addEventListener('resize', function () { XS.Core.resize(); });

    /* ---------- 音频：首次交互解锁 + 全局 UI 音 ---------- */
    var unlockOnce = function () {
      XS.Audio.unlock();
      XS.Audio.startMusic();
      global.document.removeEventListener('pointerdown', unlockOnce);
      global.document.removeEventListener('keydown', unlockOnce);
      global.document.removeEventListener('touchstart', unlockOnce);
    };
    global.document.addEventListener('pointerdown', unlockOnce, false);
    global.document.addEventListener('keydown', unlockOnce, false);
    global.document.addEventListener('touchstart', unlockOnce, false);
    /* 所有按钮统一带上点击音，省去逐个绑定 */
    global.document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('button')) XS.Audio.play('ui', 0.7);
    }, false);

    if (has('adok')) XS.Platform.adSuccessRate = 1;
    if (has('nobot')) botPaused = true;

    var ld = document.getElementById('loading');

    /* ---------- 无障碍开关（设计走查用） ----------
     * ?a11y=cb,big  —— 开色盲辅助 / 大字号；?a11y=none 强制全关
     *
     * 两条硬要求，缺一条这个开关就没有走查价值：
     *
     * ① 必须走**和玩家点开关完全相同的那条路径**
     *    （写 XS.Settings → Settings.apply() → Game.applyA11y()）。
     *    如果走查自己另开一条「直接改渲染状态」的捷径，那走查通过
     *    只能证明渲染写对了，证明不了**开关接上了** ——
     *    而「开关没接上」恰恰是这类功能最容易出的问题：
     *    面板会亮、刷新还在、代码里搜得到，屏幕上什么都不变。
     *
     * ② 必须在**任何 stepOnce 之前**执行。
     *    轮廓网格的实例矩阵是在每帧的 writeEnemyMatrices 里写的，
     *    而它只在 `outline.visible` 为真时才写。若开关晚于摆妖怪的
     *    ?a11ydemo / ?spawn，那些实例矩阵就永远是空的 ——
     *    渲染出来是「开了开关但什么都没有」，而这会被误读成
     *    「功能没实现」。这个坑我第一次就踩了。
     */
    var a11y = qs('a11y');
    if (a11y !== null) {
      var aParts = a11y.split(',');
      for (var ai = 0; ai < aParts.length; ai++) {
        var pk = aParts[ai].trim();
        if (pk === 'cb' || pk === 'colorblind') XS.Settings.colorblind = true;
        else if (pk === 'big' || pk === 'bigtext') XS.Settings.bigText = true;
        else if (pk === 'none' || pk === 'off' || pk === '0') {
          XS.Settings.colorblind = false; XS.Settings.bigText = false;
        }
      }
      XS.Settings.apply();
    }

    /* 设计走查用：藏掉 HUD（?nohud=1）。
       拍「场景 / 美术 / 开-关对比图」时 HUD 会挡住画面下缘；
       更要紧的是对比图要求两张图的**其余部分完全一致** ——
       带 HUD 的话计时器数字、伤害飘字都会不一样，
       看的人会把注意力分到那些无关差异上，反而看不出功能本身的差别。
       放在这里（而不是后面 UI 初始化附近）是因为 ?a11ydemo 会提前 return。 */
    if (has('nohud')) {
      var hudEl = document.getElementById('hud');
      if (hudEl) hudEl.style.display = 'none';
    }

    /* ---------- 同步模拟模式 ---------- */
    var play = parseInt(qs('play') || '0', 10);
    var farm = parseInt(qs('farm') || '0', 10);

    /* ---------- 局外成长：测量开关 ----------
       必须在任何 Game.start() 之前定好 —— 顺序反了的话，
       第一局已经带着永久强化跑完了，基线就不干净了。

       两个开关各管一件事，不许互相兼职：
         offline  —— 本次会话不写档（唯一语义）
         override —— { id: lv } 等级表；null 表示照存档读
       凡是「走查 / 截图」性质的开关（metaunlock / reveal）都顺带置 offline，
       否则每跑一次作品集脚本，本机的真实存档就被永久改写一次。 */
    if (has('nometa')) XS.Meta.setBlank();
    if (has('metamax')) { XS.Meta.setMax(); XS.Meta.offline = true; }
    var metaset = qs('metaset');
    if (metaset) { XS.Meta.setSpec(metaset); XS.Meta.offline = true; }
    /* 批量跑局一律「不写档」；没指定 override 的话默认零强化（可复现基线） */
    if (farm > 0) {
      XS.Meta.offline = true;
      if (!XS.Meta.override) XS.Meta.setBlank();
    }
    if (has('metaunlock')) {
      XS.Meta.offline = true;
      XS.Meta.debugMaxAll(true);
      XS.Meta.debugUnlockAch(true);
    }
    /* 部分点亮：每类前 N 条。全亮的成就墙证明不了「发现」机制存在，
       作品集里要能看见玩家平时真正面对的那个状态 —— 大半还是暗格。 */
    var reveal = parseInt(qs('reveal') || '0', 10);
    if (reveal > 0) {
      XS.Meta.offline = true;
      XS.Meta.debugReveal(reveal);
    }
    var grant = parseInt(qs('grant') || '0', 10);
    if (grant > 0) XS.Meta.debugGrant(grant, XS.Meta.offline);

    if (farm > 0) {
      XS.Platform.autoAd = true;
      XS.Platform.adSuccessRate = 0.82;   // 模拟 82% 广告完成率
      XS.Game.setSyncMode(true);          // 同步模拟：不记录不可信的帧率
      if (ld) ld.style.display = 'none';
      XS.UI.hideAll();
      /* 同步循环的墙上时间上限。
         默认 240s，`?farmwall=<秒>` 可以放宽 —— 跑 48 局的平衡测量
         需要 300s 以上，而**这个上限原来是写死的**。
         上一次复测只跑出 35/40 局，README 把它归因成「虚拟时间预算不够」，
         其实更可能是撞在这里：`--virtual-time-budget` 调多大都没用，
         因为截断发生在循环内部。归因错了，方向就会一直错。
         另外它当时是**静默** break 的：诊断里只有 totalRuns: 35，
         没有任何一处说「没跑完」。一个被截断的样本看起来和一个
         完整的样本一模一样 —— 所以下面把停因一起报出来。 */
      var farmWallSec = parseInt(qs('farmwall') || '0', 10);
      if (!(farmWallSec > 0)) farmWallSec = 240;
      var wallCapMs = farmWallSec * 1000;
      try {
        var step = 1 / 60;
        var guard = 0;
        /* 单局上限 = 局时长 + 60s 余量；再乘局数，外加 2 局冗余 */
        var maxGuard = 60 * (XS.RUN_TIME + 60) * (farm + 2);
        var wallStart = XS.Platform.now();
        /* 按技能档位轮流跑：0.22(新手) → 0.94(高手)，才能得到真实的时长分布 */
        var seenRuns = 0;
        Bot.skillSet(0.22);
        XS.Game.start();
        while (XS.Telemetry.runCount() < farm && guard++ < maxGuard) {
          var rc = XS.Telemetry.runCount();
          if (rc !== seenRuns) {
            seenRuns = rc;
            Bot.skillSet(0.22 + 0.72 * (seenRuns / Math.max(1, farm - 1)));
          }
          /* 状态轨迹：排查「对局为什么不结束」时极其有用 */
          var stNow = XS.Game.state();
          if (stNow !== farmLastState) {
            if (farmTrace.length < 80) {
              farmTrace.push({
                f: guard, st: stNow, runs: rc,
                t: (document.getElementById('timer') || {}).textContent
              });
            }
            farmLastState = stNow;
          }
          stepOnce(step);
          /* 兜底：同步循环最多占用 farmWallSec 秒墙上时间，避免无头环境挂死。
             撞上时必须**记下来**（下面 farmStop 那一项），否则诊断里
             只会看到一个偏小的局数，读的人无从判断它是「跑完了」还是「被砍了」。 */
          if ((guard & 1023) === 0 && XS.Platform.now() - wallStart > wallCapMs) {
            farmStop = 'wall';
            break;
          }
        }
        if (!farmStop) farmStop = 'done';
        farmGuard = guard;
        farmGuardMax = maxGuard;
        farmWallMs = Math.round(XS.Platform.now() - wallStart);
        XS.Game.discardRun();
        XS.Core.renderer.info.reset();
        XS.Core.composer.render();
      } catch (e) {
        bootError = 'FARM: ' + e.message + '\n' + e.stack;
      }
      emitDiag();
      frozen = true;
      applyDebugCam();
      last = XS.Platform.now();
      requestAnimationFrame(frame);
      return;
    }

    if (play > 0) {
      XS.Platform.autoAd = true;
      XS.Platform.adSuccessRate = 1;
      XS.Game.setSyncMode(true);
      if (ld) ld.style.display = 'none';
      XS.UI.hideAll();
      /* `?gesture=1`：模拟一次真实的用户手势。
         为什么需要：音频解锁挂在 pointerdown / keydown / touchstart 上，
         而机器人用的是 `.click()` —— 它派发的是 click 事件，
         **不会**触发这几个监听器。于是 Web 侧从头到尾没解锁过音频，
         `ready` 恒为 false，所有播放请求都按 noCtx 正确丢弃 ——
         结果是这个子系统的 Web 一半**从来没有被验证过**，
         而诊断里那句「有 N 次请求但一个音都没出去」还会天天误报。

         这和触摸层那个坑是同一族（见「走查走的是捷径」）：
         机器人绕过了真实输入路径，被绕过的那一层就等于没测。 */
      if (has('gesture')) {
        try {
          global.document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        } catch (e) {}
      }
      try {
        var step2 = 1 / 60;
        var n = Math.floor(play / step2);
        if (qs('skill')) Bot.skillSet(parseFloat(qs('skill')));
        XS.Game.start();
        for (var i = 0; i < n; i++) stepOnce(step2);
        /* 设计走查：强制给场上妖魔挂状态，再推进两帧把实例矩阵写出来。
           冰缓/灼烧都是「打起来才会出现」的稀有分支，靠随机截图
           几乎不可能同时抓到两种，所以给一个确定的入口。 */
        if (has('status')) { applyStatusProbe(); for (var sp = 0; sp < 2; sp++) stepOnce(step2); }
        /* 设计走查：直接把功法灌到「可进化」状态并弹面板。
           ?evo=sword / qi / thunder / ember / frost / aura 指定分支；
           ?evo=1 默认取御剑术。 */
        if (qs('evo') !== null) {
          var evoKey = qs('evo');
          if (!evoKey || evoKey === '1') evoKey = 'sword';
          /* full = 已满足条件（会弹金色进化卡）
             part = 追到一半（卡上会出现「→ 目标 3/8」的进度标签） */
          var EVO_SEED = {
            sword:   { full: { sword: 6, crit: 2 },    part: { sword: 4, crit: 1 } },
            qi:      { full: { qi: 5, pickup: 2 },     part: { qi: 3, pickup: 1 } },
            thunder: { full: { thunder: 5, frost: 2 }, part: { thunder: 3, frost: 1 } },
            ember:   { full: { ember: 4, aura: 2 },    part: { ember: 2, aura: 1 } },
            frost:   { full: { frost: 4, speed: 2 },   part: { frost: 2, speed: 1 } },
            aura:    { full: { aura: 5, hp: 3 },       part: { aura: 3, hp: 2 } }
          };
          var seedPair = EVO_SEED[evoKey] || EVO_SEED.sword;
          XS.Game.debugGrant(qs('part') !== null ? seedPair.part : seedPair.full);
          if (qs('takeevo') !== null) {
            /* 连「已经进化完」的状态也一起走查：灌满 -> 进化 -> 继续跑 */
            XS.Game.debugEvolve(evoKey);
            for (var sg = 0; sg < 3; sg++) stepOnce(step2);
          } else {
            /* 面板要停住给人看，必须同时冻结机器人的自动点击 */
            botPaused = true;
            XS.Game.debugForceLevelUp();
          }
        }
        for (var f = 0; f < 3; f++) { XS.Core.renderer.info.reset(); XS.Core.composer.render(); }
      } catch (e2) {
        bootError = 'PLAY: ' + e2.message + '\n' + e2.stack;
      }
      /* 先定机位，再出诊断。
         顺序反了会让诊断描述的**不是**即将渲染的那一帧：
         切到 ?cam= 之后相机朝向变了，而 atmo 探针里的 skyTopH/skyBotH
         是照相机方向算的，报出来的却是跟随相机的那一组值 ——
         图和数对不上，比没有数更坏。 */
      applyDebugCam();
      emitDiag();
      frozen = true;
      last = XS.Platform.now();
      requestAnimationFrame(frame);
      return;
    }

    /* ---------- 正常运行 ---------- */
    /* 走查用：把相机拉近。新妖魔的造型只能在「占满画面」时才判断得了 ——
       默认机位下妖魔只占几十个像素，任何细节问题都看不出来，
       等于没验。形如 ?zoom=0.45（越小越近）。 */
    var zoom = parseFloat(qs('zoom') || '0');
    if (zoom > 0) {
      XS.CAM.offset.y *= zoom;
      XS.CAM.offset.z *= zoom;
    }
    var preroll = parseInt(qs('preroll') || '0', 10);
    if (preroll > 0) {
      XS.UI.hideAll();
      XS.Game.start();
      var st3 = 1 / 60;
      for (var k = 0; k < preroll * 60; k++) stepOnce(st3);
      /* 走查机位在 preroll 路径下也要生效。
         原来只有 ?farm / ?play 两条分支调 applyDebugCam，
         于是 ?preroll=1&cam=… 会**静默地用默认机位出图** ——
         截图看着正常，只是不是你要的那个角度，很难发现。 */
      applyDebugCam();
      for (var f2 = 0; f2 < 3; f2++) { XS.Core.renderer.info.reset(); XS.Core.composer.render(); }
    }

    /* 走查用：把指定妖魔直接刷在玩家身前。
       形如 ?spawn=splitter:4,guard:2,imp:6 —— 配合 ?preroll=N 出图。
       放在 preroll 之后：先跑几秒让场地/相机就位，再摆妖怪。 */
    var spawnSpec = qs('spawn');
    if (spawnSpec) {
      if (XS.Game.state() !== 'playing') { XS.UI.hideAll(); XS.Game.start(); }
      XS.Game.debugSpawn(spawnSpec);
      /* 走查用：?settle=N 摆完妖怪后再推进 N 秒才出图。
         为什么需要：debugSpawn 里每只怪都带 `spawnT = spawnDur`，
         也就是**停在「材质化」动画的第一帧**。只渲三帧就截图的话，
         拍到的是它们正在生成的样子 —— 一片加色白光，
         而不是它们长什么样。
         这个坑很隐蔽：造型本身没错，只是**拍错了时机**；
         而「一片白」正好和「本体被照爆」同形，于是很容易去改美术。
         摆队列（妖魔谱）不需要这个参数 —— 那类图要的就是整齐的站位；
         拍「满屏混战」才需要，让它们先各自就位再拍。 */
      var settle = parseFloat(qs('settle') || '0') || 0;
      if (settle > 0) {
        var st4 = 1 / 60;
        for (var sq = 0; sq < Math.round(settle * 60); sq++) stepOnce(st4);
      }
      for (var f3 = 0; f3 < 3; f3++) { XS.Core.renderer.info.reset(); XS.Core.composer.render(); }
    }

    /* 走查用：无障碍演示场（?a11ydemo=1）。
       固定阵型 + 固定状态 + 固定机位，开/关两张图只差一个开关。
       最后**必须冻结**：?spawn 那条路是靠「继续跑帧循环」把新怪画出来的，
       但演示场要求阵型一动不动、怪也不能被玩家打死 ——
       跑满 40 秒虚拟时间之后，拍到的是「打完了的战场」而不是阵型。
       所以先 stepOnce 一帧把实例矩阵写出来，再冻结出图。 */
    if (has('a11ydemo')) {
      if (XS.Game.state() !== 'playing') { XS.UI.hideAll(); XS.Game.start(); }
      /* 加载遮罩要自己关掉：这一段在 `ld.style.display='none'` 之前就 return 了，
         不关的话截到的是「正在凝聚仙台…」——而它看起来像一张正常的页面，
         只是没有游戏内容，很容易被当成「场景没渲染出来」去查渲染。 */
      if (ld) ld.style.display = 'none';
      botPaused = true;
      XS.Game.debugA11yDemo();
      stepOnce(1 / 60);
      applyDebugCam();
      emitDiag();
      frozen = true;
      last = XS.Platform.now();
      requestAnimationFrame(frame);
      return;
    }

    /* 走查用：分层显示妖魔（?layer=body / ?layer=glow）。
       「这只怪一片白」这种判断，只靠看合图是查不出病因的：
       本体层和辉光层叠在一起时，你分不清是本体被照爆了，
       还是辉光加得太多糊住了本体。分开拍一张，答案立刻唯一。
       注意必须在 spawn 之后调用 —— 层是在建实例网格时挂上去的。 */
    var layer = qs('layer');
    if (layer) {
      XS.Game.debugLayer(layer);
      for (var f4 = 0; f4 < 3; f4++) { XS.Core.renderer.info.reset(); XS.Core.composer.render(); }
    }

    /* 走查用：关掉泛光（?bloom=0）。
       泛光会把「中等亮度的中性色」洗成白色，而且**抹掉明暗**
       ——因为它是在已经很亮的像素上再叠一层同色。于是「这只怪造型糊了」
       和「这只怪被泛光洗了」在成图上一模一样，但改法完全不同：
       前者改几何，后者改固有色（往饱和里调）或者调泛光阈值。
       关掉泛光再拍一张，就能把这两件事分开。 */
    if (qs('bloom') === '0' && XS.Core.bloom) {
      XS.Core.bloom.enabled = false;
      for (var f5 = 0; f5 < 3; f5++) { XS.Core.renderer.info.reset(); XS.Core.composer.render(); }
    }

    if (has('autostart') || autopilot) {
      XS.UI.hideAll();
      if (XS.Game.state() !== 'playing') XS.Game.start();
    }

    if (ld) ld.style.display = 'none';
    /* 设计走查用：直接打开设置面板 */
    if (has('settings')) XS.UI.showSettings();
    /* 设计走查用：直接打开山门面板（?meta=ach / ?meta=codex 指定 Tab）。
       用 qs 而不是 has —— has 只认 =1，?meta=codex 会被它判成 false。 */
    if (qs('meta') !== null) XS.UI.showMeta(qs('meta') === '' || qs('meta') === '1' ? 'shop' : qs('meta'));
    /* 设计走查用：成就浮层只活 3 秒，随机截图几乎不可能抓到，
       给一个确定入口验证排版与串行播放。 */
    if (has('achdemo')) {
      XS.UI.achievementToast([XS.ACH_MAP.win1, XS.ACH_MAP.icefire, XS.ACH_MAP.kills10k]);
    }
    /* 设计走查用：常驻教学提示条。
       提示条默认只活 4~5 秒，截图几乎不可能恰好落在窗口内，
       所以给它一个「焊死」的入口来验证排版与样式。 */
    var tipQ = qs('tip');
    if (tipQ) {
      XS.UI.tip(tipQ === '1' ? '妖狼蓄力后会直线冲锋 —— 横向闪避，别往后退' : tipQ, 3600000);
    }
    if (has('diag')) emitDiag();

    last = XS.Platform.now();
    requestAnimationFrame(frame);
  }

  /* 冻结模式下的出帧预算。
     冻结循环原本会一直渲染到 --virtual-time-budget 耗尽，也就是 ~960 帧；
     在 SwiftShader 上每帧几百毫秒，一次截图能跑十几分钟，
     还容易撞上 GPU 资源错误（CreateSharedImage 失败）。
     实际上只需要少量几帧把内容画进缓冲，之后就空转即可。 */
  var FROZEN_FRAMES = 24;
  var frozenDrawn = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;

    if (frozen) {
      /* 模拟模式：画面冻结，只持续出帧，保证 headless 截图能拿到 WebGL 内容。
         出够 FROZEN_FRAMES 帧就停手 —— 缓冲里已经有内容了，再画是白烧时间。 */
      if (frozenDrawn < FROZEN_FRAMES) {
        frozenDrawn++;
        XS.Core.renderer.info.reset();
        XS.Core.composer.render();
      }
      return;
    }

    if (autopilot) {
      Bot.input(dt);
      botHandleState();
    }

    tGlobal += dt;
    XS.World.update(dt, tGlobal);
    XS.Game.update(dt, tGlobal);
    XS.Core.adaptQuality(dt);
    XS.Core.renderer.info.reset();
    XS.Core.composer.render();
  }

  global.__XS_DEBUG = {
    state: function () { return XS.Game.state(); },
    player: function () { return XS.Game.player(); },
    runs: function () { return XS.Telemetry.getRuns(); },
    summary: function () { return XS.Telemetry.summarize(); },
    bootError: function () { return bootError; },
    step: function (seconds) { var s = 1 / 60; for (var i = 0; i < seconds * 60; i++) stepOnce(s); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
