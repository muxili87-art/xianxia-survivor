/* ============================================================
 * 《仙台问剑》配置与数值表
 * 所有可调数值集中在此，方便策划手感调优
 * ============================================================ */
(function (global) {
  'use strict';

  var XS = global.XS || (global.XS = {});

  /* ---------- 色板：国风仙侠 ---------- */
  XS.C = {
    ink: 0x061018,        // 墨底
    inkDeep: 0x03080f,
    jade: 0x4de8ff,       // 灵青
    jadeSoft: 0x9ff0ff,
    gold: 0xffcf6b,       // 仙金
    goldDeep: 0xffa63a,
    cinnabar: 0xff5a4d,   // 朱砂（敌）
    blood: 0xff2d3f,
    purple: 0xa97bff,     // 紫气
    frost: 0x8fd4ff,      // 玄冰
    ember: 0xff8a3d,      // 烈焰
    white: 0xeaf6ff,
    thunder: 0xd8e8ff,
    /* 玄铁。盾卫专用。
       为什么不用现成的 thunder：thunder 是给「闪电 / 能量」这类**光效**
       用的近白色（r85 g91 b100，基本就是白的）。而元素色还有一个用途 ——
       本体材质会拿它当自发光（emissive = tint × 0.20）。近白色当自发光，
       等于给深色本体平铺一层**中性**提亮：色相没变、亮度翻倍、饱和度被稀释，
       最后读出来就是「一只纯白的怪」。实测就是这样 —— 盾卫整个糊成白剪影，
       而用朱砂的魔卒、用腐毒的裂魔都正常，因为它们的自发光是有色相的。
       教训：tint 是**染色**用的，不是**发光**用的，必须饱和。 */
    steel: 0x5fb0ff,
    /* 腐毒。给「裂魔 / 小裂魔」这一族专用的发光色。
       为什么值得新开一个颜色：小裂魔必须一眼被读成「刚才那只裂魔掉下来的」，
       而颜色是全场最快的识别通道 —— 靠造型去认，玩家得先看清才反应得过来。
       一个族一个色，亲子关系就不用靠说明文字。 */
    moss: 0xa8e05f
  };

  /* ---------- 场地 ---------- */
  XS.ARENA = {
    radius: 25.5,         // 仙台半径（略大于可活动范围，刷怪点正好落在台沿）
    playRadius: 22.6,     // 玩家可活动半径
    spawnRadius: 23.2,    // 刷怪环半径（在场地边缘）
    spawnMargin: 3.5      // 怪出生点在场地外一点
  };

  /* ---------- 摄像机 ---------- */
  XS.CAM = {
    fov: 44,
    offset: { x: 0, y: 14.8, z: 17.2 },
    lookAtY: 2.6,
    lookAtZ: -2.4,
    follow: 4.6,          // 指数平滑速率
    shakeDecay: 7.5
  };

  /* ---------- 玩家 ---------- */
  XS.PLAYER = {
    speed: 7.4,
    maxHp: 100,
    radius: 0.52,
    pickupRadius: 2.7,
    invuln: 0.42,
    regen: 0,             // 每秒回血，由功法提供
    critChance: 0.05,
    critMult: 1.8,
    xpGain: 1             // 经验获取倍率
  };

  /* ---------- 单局时长（秒） ---------- */
  XS.RUN_TIME = 480;      // 8 分钟

  /* ---------- 敌人图鉴 ---------- */
  XS.ENEMY = {
    imp:    { name: '小妖',   hp: 13,   speed: 3.05, dmg: 6,  xp: 1,  radius: 0.44, mass: 1.0,  tier: 1 },
    flyer:  { name: '飞魔',   hp: 24,   speed: 4.30, dmg: 9,  xp: 2,  radius: 0.52, mass: 0.8,  tier: 2, float: 1.5 },
    brute:  { name: '魔卒',   hp: 52,   speed: 2.05, dmg: 15, xp: 3,  radius: 0.78, mass: 2.2,  tier: 3 },
    wraith: { name: '怨灵',   hp: 34,   speed: 3.70, dmg: 11, xp: 3,  radius: 0.55, mass: 0.9,  tier: 3, float: 0.9 },
    /* 远程：停在射程外放法术。逼玩家主动清场，不能只靠绕圈。 */
    caster: { name: '妖巫',   hp: 30,   speed: 2.60, dmg: 13, xp: 4,  radius: 0.58, mass: 1.0,  tier: 3, float: 0.8,
              tip: '妖巫会远程施法 —— 主动上前清掉它' },
    /* 冲锋：蓄力后直线突进。走位不能只靠「一直退」，得会横向闪。 */
    charger:{ name: '妖狼',   hp: 46,   speed: 2.35, dmg: 14, xp: 4,  radius: 0.66, mass: 1.7,  tier: 3,
              tip: '妖狼蓄力后会直线冲锋 —— 横向闪避，别往后退' },
    /* 分裂：死亡时裂成两只小裂魔。给「击杀」本身加了一层代价 ——
       贴着脸清场，子体会直接糊在你身上。教的是「清场要看位置」。 */
    splitter:{ name: '裂魔',   hp: 70,   speed: 2.15, dmg: 15, xp: 4,  radius: 0.74, mass: 1.9,  tier: 3,
              splitInto: 'splitling', splitCount: 2,
              tip: '裂魔倒下会分裂成两只 —— 别贴着脸清它' },
    /* 子体：只从裂魔里生出来，不占波次表。自己不再分裂（否则会指数爆炸）。 */
    splitling:{ name: '小裂魔', hp: 22,   speed: 3.35, dmg: 9,  xp: 1,  radius: 0.40, mass: 0.6,  tier: 2,
              noSplit: true, summoned: true },
    /* 辅助：撑起护罩，削弱范围内其他妖魔受到的伤害。
       它自己不吃这层减免 —— 否则它就只是「又一坨血厚的怪」，
       而不是一个「要先杀谁」的问题。 */
    guard:  { name: '盾卫',   hp: 95,   speed: 1.95, dmg: 11, xp: 6,  radius: 0.70, mass: 2.1,  tier: 3,
              aura: 5.5, auraCut: 0.30,
              tip: '盾卫的护罩会削弱你的伤害 —— 先杀它' },
    elite:  { name: '妖将',   hp: 250,  speed: 2.55, dmg: 13, xp: 28, radius: 1.12, mass: 6.0,  tier: 4 },
    boss:   { name: '魔尊',   hp: 2400, speed: 2.30, dmg: 27, xp: 220, radius: 2.10, mass: 16.0, tier: 5 }
  };

  /* ---------- 刷怪节奏表 ----------
   * t 秒起，每秒刷出 count 只 w 类型；hpMul 为全局血量成长
   *
   * 这张表是**顺序**的，不是叠加的：每条只负责「从这一刻起换成刷谁」。
   * 所以往中间插一条新敌人，等于把后面那一段的构成换掉，
   * 而不是在原有压力上再加一层 —— 这也是加新怪时唯一不用重调
   * 整条难度曲线就能保持同屏压力的办法（cap 曲线和总时长都没动）。
   */
  XS.WAVES = [
    { t: 0,   w: 'imp',      rate: 1.4, cap: 26,  hpMul: 1.00 },
    { t: 35,  w: 'imp',      rate: 2.8, cap: 42,  hpMul: 1.15 },
    { t: 70,  w: 'flyer',    rate: 2.0, cap: 56,  hpMul: 1.30 },
    { t: 105, w: 'imp',      rate: 5.2, cap: 70,  hpMul: 1.50 },
    /* 从第 125 秒起混入远程，玩家开始需要「主动上前」而不是一味后退 */
    { t: 125, w: 'caster',   rate: 1.1, cap: 78,  hpMul: 1.62 },
    { t: 142, w: 'brute',    rate: 2.0, cap: 84,  hpMul: 1.75 },
    /* 第 165 秒起混入冲锋，走位开始需要横向闪避 */
    { t: 165, w: 'charger',  rate: 1.3, cap: 92,  hpMul: 1.90 },
    /* 第 180 秒起混入分裂，击杀位置开始有代价 */
    { t: 180, w: 'splitter', rate: 1.5, cap: 96,  hpMul: 2.00 },
    { t: 196, w: 'wraith',   rate: 3.0, cap: 100, hpMul: 2.10 },
    { t: 218, w: 'brute',    rate: 3.4, cap: 106, hpMul: 2.35 },
    { t: 238, w: 'caster',   rate: 1.7, cap: 110, hpMul: 2.52 },
    /* 第 252 秒起混入护罩，玩家需要开始考虑「先杀谁」 */
    { t: 252, w: 'guard',    rate: 1.1, cap: 114, hpMul: 2.62 },
    { t: 268, w: 'flyer',    rate: 4.8, cap: 118, hpMul: 2.82 },
    { t: 290, w: 'charger',  rate: 2.1, cap: 122, hpMul: 3.10 },
    { t: 308, w: 'splitter', rate: 2.0, cap: 126, hpMul: 3.22 },
    { t: 326, w: 'wraith',   rate: 5.6, cap: 132, hpMul: 3.42 },
    { t: 346, w: 'brute',    rate: 5.8, cap: 142, hpMul: 3.62 },
    { t: 366, w: 'caster',   rate: 2.5, cap: 154, hpMul: 3.88 },
    { t: 382, w: 'guard',    rate: 1.4, cap: 160, hpMul: 4.00 },
    /* 终局三波加压（2026-09-13）。
       依据：48 局天花板组（?farm=48&metamax=1）通关率 87.5%，
       超出 README 定的「满强化 ≈ 70~80%」目标带；
       而死亡时间直方图显示死亡集中在 390~430 秒 —— 正好落在这三波上，
       所以只动这三波，不动整条曲线（改一个量、测一次，是这个项目的老规矩）。
       加压幅度约 +19%（elite 1.6→1.9、charger 2.8→3.4、wraith 9.5→11.5）。
       为什么敢一次动三行：它们同属「最后 90 秒」，是同一件事的三个分量，
       分开测只会把同一个改动拆成三次噪声。 */
    { t: 398, w: 'elite',    rate: 1.9, cap: 170, hpMul: 4.20 },
    { t: 414, w: 'charger',  rate: 3.4, cap: 178, hpMul: 4.35 },
    { t: 432, w: 'wraith',   rate: 11.5, cap: 205, hpMul: 4.60 }
  ];

  /* ------------------------------------------------------------
   * 全局难度曲线
   *
   * 为什么不能只靠波次表的 hpMul：
   * 玩家的输出是指数成长的（功法叠加 + 暴击 + 多飞剑），
   * 单纯堆血量只会让后期变成「打不死」而不是「打不过」。
   * 真正制造压迫感的是三件事：
   *   1) 移动速度 —— 让无限风筝逐渐失效；
   *   2) 接触伤害 —— 让「穿过妖群」付出真实代价；
   *   3) 刷新密度 —— 让玩家被围住，而不是被追上。
   * 这三项都随对局时间线性爬升，8 分钟时达到上限。
   * ------------------------------------------------------------ */
  XS.DIFF = {
    spdStart: 1.00, spdEnd: 1.75,   // 妖魔移动速度倍率
    dmgStart: 1.00, dmgEnd: 2.20,   // 接触伤害倍率
    rateStart: 1.00, rateEnd: 1.55, // 刷新速率倍率
    capStart: 1.00, capEnd: 1.32    // 同屏上限倍率
  };

  XS.diffAt = function (t) {
    var k = Math.max(0, Math.min(1, t / XS.RUN_TIME));
    var D = XS.DIFF;
    return {
      spd: D.spdStart + (D.spdEnd - D.spdStart) * k,
      dmg: D.dmgStart + (D.dmgEnd - D.dmgStart) * k,
      rate: D.rateStart + (D.rateEnd - D.rateStart) * k,
      cap: D.capStart + (D.capEnd - D.capStart) * k,
      k: k
    };
  };

  /* Boss 出场时间点 */
  XS.BOSS_AT = [
    { t: 150, hpMul: 1.0 },
    { t: 300, hpMul: 1.9 },
    { t: 420, hpMul: 3.0 }
  ];

  /* 精英混入：从第 90 秒起，每隔一段时间掺一只 */
  XS.ELITE_FROM = 90;

  /* ---------- 经验曲线 ----------
   * 早期平缓（前 30 秒就能升 3~4 级，给足正反馈），后期放缓。
   *
   * 这条曲线决定「构筑」能不能成立。原来用 2.1*lv^2 的陡度，
   * 满场只到 20 级 —— 20 次三选一摊到 10 个功法上，每个都只有 2 级，
   * 结果玩家整局都在「什么都点了一点，但什么都不强」，
   * 后期自然被妖将推平（实测 0% 通关率，死因清一色是妖将）。
   *
   * 改成 0.95*lv^2 之后，8 分钟能到 28~32 级，
   * 足够把 2~3 个核心功法点满，DPS 曲线才跟得上怪的血量曲线。 */
  XS.xpForLevel = function (lv) {
    return Math.floor(5 + lv * 5 + lv * lv * 1.12);
  };

  /* ---------- 功法（升级池） ----------
   * max 为最高等级；apply(p, lv, re) 在升到 lv 级时调用（lv 从 1 开始）
   *   p  —— player 对象
   *   lv —— 目标等级
   *   re —— true 表示这是「重算」（进化后把所有已学功法重跑一遍），
   *         此时必须只写绝对值、不能有一次性副作用（回血之类）
   *
   * apply 必须写成**绝对赋值**而不是叠加：进化会触发一次全量重算，
   * 叠加式的写法会在重算时翻倍。
   *
   * 每个战斗功法都读 p.evolved[自己的 id]，进化后同一套公式给出强化值，
   * 这样「基础成长曲线」和「进化」共用一个真相来源，不会两处走样。
   *
   * 数值一律用「进度 k = lv / max」表达，而不是逐级硬编码 ——
   * 改上限等级时只要 k 的口径不变，曲线形状就自动保持。
   *
   * ── 上限等级为什么是 4~6 ──
   * 一局只给约 24 次三选一。原本御剑术满级 8 级 + 进化前置 3 级 = 11 次，
   * 占掉半套 build，实测 16 局只有 12.5% 的玩家能达成进化 ——
   * 也就是 87.5% 的人整局都看不到自己追的目标。压缩到 6 级后达成率进入健康区间。
   *
   * 注意：压缩上限**不等于**曲线不变。满级值保持不变时，中间每一级都会变强
   * （前段被抬升），实测直接把胜率从 19% 顶到 87%。所以这里把满级值
   * 统一下调了约 10% 作为补偿 —— 玩家失去了原来最高 2 级的成长空间，
   * 换来的是省下的点数可以投到别的功法上，以及够得着的进化。
   */
  XS.UPGRADES = [
    {
      id: 'sword', name: '御剑术', icon: '剑', max: 6, weight: 10,
      tag: '核心',
      desc: function (lv) {
        if (lv === 0) return '凝气化剑，环绕身周斩敌。';
        return '飞剑 +1，伤害提升。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.sword;
        var k = lv / 6;
        p.sword.count = ev
          ? Math.min(14, Math.round(8 + 3 * k))     // 满级 8 → 进化 11
          : Math.min(9, Math.round(1 + 7 * k));     // 满级 8 把
        p.sword.damage = (9 + 31 * k) * (ev ? 1.25 : 1);   // 满级 40 → 50
        p.sword.radius = 3.0 + 1.55 * k + (ev ? 0.45 : 0);
        p.sword.speed = (1.55 + 0.62 * k) * (ev ? 1.10 : 1);
        p.sword.echo = ev ? 0.22 : 0;    // 回旋补斩概率（见 updateSwords）
      }
    },
    {
      id: 'qi', name: '剑气纵横', icon: '气', max: 5, weight: 8,
      tag: '远程',
      desc: function (lv) {
        if (lv === 0) return '吐纳成剑气，自动射向最近之敌。';
        return '剑气数量与穿透提升。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.qi;
        var k = lv / 5;
        p.qi.enabled = true;
        p.qi.count = Math.round(5.4 * k) + (ev ? 2 : 0);        // 满级 5 → 进化 7
        p.qi.damage = (7 + 19 * k) * (ev ? 1.30 : 1);           // 满级 26 → 33.8
        /* 进化后贯穿无上限：剑气会一路穿场，读起来才像「剑破虚空」 */
        p.qi.pierce = ev ? 999 : 1 + Math.round(2.7 * k);       // 满级 4
        p.qi.interval = Math.max(0.42, 1.15 - 0.53 * k) * (ev ? 0.88 : 1);
        p.qi.scale = ev ? 1.45 : 1;
      }
    },
    {
      id: 'thunder', name: '天雷诀', icon: '雷', max: 5, weight: 7,
      tag: '范围',
      desc: function (lv) {
        if (lv === 0) return '引落天雷劈击妖魔，原地残留雷电场。';
        return '落雷数量与威力提升。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.thunder;
        var k = lv / 5;
        p.thunder.enabled = true;
        p.thunder.count = Math.round(5.4 * k) + (ev ? 2 : 0);   // 满级 5 → 进化 7
        p.thunder.damage = (26 + 78 * k) * (ev ? 1.35 : 1);     // 满级 104 → 140.4
        p.thunder.interval = Math.max(1.1, 3.0 - 1.42 * k) * (ev ? 0.92 : 1);
        p.thunder.radius = (2.2 + 0.95 * k) * (ev ? 1.4 : 1);   // 满级 3.15 → 4.41
      }
    },
    {
      id: 'frost', name: '玄冰诀', icon: '冰', max: 4, weight: 6,
      tag: '控制',
      desc: function (lv) {
        if (lv === 0) return '寒气外放，近身之敌迟滞受创。';
        return '冰域范围与减速加深。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.frost;
        var k = lv / 4;
        p.frost.enabled = true;
        p.frost.radius = (3.4 + 3.8 * k) * (ev ? 1.3 : 1);      // 满级 7.2
        p.frost.slow = Math.min(ev ? 0.70 : 0.60, 0.22 + 0.36 * k + (ev ? 0.08 : 0));
        /* DOT 不吃暴击（见 game.js dealDamage 的 noCrit 注释），
           所以基础值要相应补回来，否则堆暴击的流派会顺带废掉冰域。 */
        p.frost.dps = (6 + 26 * k) * (ev ? 1.3 : 1);            // 满级 32 → 41.6
        /* 冰冻易伤：被冰封的妖魔受到的所有伤害提高。
           这是「控制」从「拖时间」变成「真输出」的关键一步 ——
           没有易伤的话，冰系永远只是辅助，堆它的人没有回报。 */
        p.frost.amp = ev ? 0.15 : 0;
      }
    },
    {
      id: 'ember', name: '烈焰符', icon: '炎', max: 4, weight: 6,
      tag: '状态',
      desc: function (lv) {
        if (lv === 0) return '符箓焚天，命中后燃起业火，持续灼烧。';
        return '灼烧伤害与点燃概率提升。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.ember;
        var k = lv / 4;
        p.ember.enabled = true;
        p.ember.damage = (12 + 35 * k) * (ev ? 1.4 : 1);        // 满级 47 → 65.8
        p.ember.radius = (2.0 + 1.5 * k) * (ev ? 1.25 : 1);     // 满级 3.5 → 4.375
        /* 进化后必定点燃 —— 「焚天」就该是走到哪烧到哪，不该还掷骰子 */
        p.ember.chance = ev ? 1 : Math.min(0.70, 0.30 + 0.40 * k);
        /* 业火蔓延：被点燃的妖魔死亡时把火传给附近同类（见 game.js killEnemy） */
        p.ember.spread = ev ? 1 : 0;
      }
    },
    {
      id: 'aura', name: '护体罡气', icon: '罡', max: 5, weight: 7,
      tag: '生存',
      desc: function (lv) {
        if (lv === 0) return '真气护体，近身者自伤。';
        return '罡气伤害与范围提升，并获得减伤。';
      },
      apply: function (p, lv) {
        var ev = !!p.evolved.aura;
        var k = lv / 5;
        p.aura.enabled = true;
        p.aura.radius = (2.3 + 1.8 * k) * (ev ? 1.3 : 1);       // 满级 4.1
        /* 同上：DOT 不吃暴击，基础值补回来 */
        p.aura.dps = (7 + 37 * k) * (ev ? 1.4 : 1);             // 满级 44 → 61.6
        p.damageReduction = Math.min(ev ? 0.52 : 0.40, 0.060 * lv + (ev ? 0.10 : 0));
      }
    },
    {
      id: 'hp', name: '混元一气', icon: '元', max: 6, weight: 8,
      tag: '生存',
      desc: function (lv) {
        if (lv === 0) return '固本培元，气血上限提升并缓缓自愈。';
        return '气血上限与回复提升。';
      },
      apply: function (p, lv) {
        var bonus = lv * 22;
        p.maxHp = XS.PLAYER.maxHp + bonus;
        p.hp = Math.min(p.maxHp, p.hp + 22);
        p.regen = lv * 0.55;
      }
    },
    {
      id: 'speed', name: '缩地成寸', icon: '行', max: 5, weight: 7,
      tag: '身法',
      desc: function (lv) {
        if (lv === 0) return '踏罡步斗，身法迅捷。';
        return '移动速度提升。';
      },
      apply: function (p, lv) {
        p.speed = XS.PLAYER.speed * (1 + lv * 0.085);
      }
    },
    {
      id: 'pickup', name: '聚灵阵', icon: '灵', max: 4, weight: 6,
      tag: '成长',
      desc: function (lv) {
        if (lv === 0) return '布下聚灵之阵，灵气自投罗网。';
        return '拾取范围与经验获取提升。';
      },
      apply: function (p, lv) {
        p.pickupRadius = XS.PLAYER.pickupRadius * (1 + lv * 0.42);
        p.xpGain = 1 + lv * 0.14;
      }
    },
    {
      id: 'crit', name: '太上忘情', icon: '悟', max: 5, weight: 6,
      tag: '输出',
      desc: function (lv) {
        if (lv === 0) return '心无挂碍，出手必中要害。';
        return '暴击率与暴击伤害提升。';
      },
      apply: function (p, lv) {
        p.critChance = XS.PLAYER.critChance + lv * 0.055;
        p.critMult = XS.PLAYER.critMult + lv * 0.28;
      }
    }
  ];

  XS.UPGRADE_MAP = {};
  for (var i = 0; i < XS.UPGRADES.length; i++) {
    XS.UPGRADE_MAP[XS.UPGRADES[i].id] = XS.UPGRADES[i];
  }

  /* ------------------------------------------------------------
   * 功法进化（合成）
   *
   * 为什么必须有这一层：
   * 只有「+1 级」的升级池，玩家每一局做的事情都是同质的 ——
   * 见到御剑术就点御剑术，见到剑气就点剑气。这叫数值堆叠，
   * 不叫构筑。玩家在 3 分钟之后就没有任何**目标**了。
   *
   * 进化给的是目标：一进对局就能看到「万剑归宗 —— 需太上忘情 Lv3」，
   * 于是「这局我要不要为了它去点一个平时不会点的暴击」变成了真决策。
   *
   * 触发条件：基础功法点满 + 前置功法达到指定等级。
   * 满足后，下一次升级的三选一里**必定**出现一张金色进化卡。
   * 进化不消耗等级上限，只改 p.evolved[from]，然后全量重算一遍数值。
   * ------------------------------------------------------------ */
  XS.EVOLUTIONS = [
    {
      id: 'sword_asc', from: 'sword', name: '万剑归宗', icon: '宗',
      req: { id: 'crit', lv: 2 },
      desc: '飞剑成阵：剑数 9 → 14，威力大涨，命中后有几率回旋补斩。'
    },
    {
      id: 'qi_asc', from: 'qi', name: '剑破虚空', icon: '虚',
      req: { id: 'pickup', lv: 2 },
      desc: '剑气凝实：数量 +3，贯穿不再有上限，出手更快。'
    },
    {
      id: 'thunder_asc', from: 'thunder', name: '九天雷罚', icon: '罚',
      req: { id: 'frost', lv: 2 },
      desc: '雷罚加身：落雷 +2，范围与威力大增，残留雷电场同步扩张。'
    },
    {
      id: 'ember_asc', from: 'ember', name: '焚天业火', icon: '焚',
      req: { id: 'aura', lv: 2 },
      desc: '业火不熄：必定点燃，灼烧剧增，且会蔓延给附近的妖魔。'
    },
    {
      id: 'frost_asc', from: 'frost', name: '玄冰绝域', icon: '绝',
      req: { id: 'speed', lv: 2 },
      desc: '冰封千里：冰域扩张、减速加深，被冰封者受到的伤害提高 25%。'
    },
    {
      id: 'aura_asc', from: 'aura', name: '太清罡煞', icon: '煞',
      req: { id: 'hp', lv: 3 },
      desc: '罡煞护体：罡气威力与范围提升，减伤上限提高到 56%。'
    }
  ];

  XS.EVOLUTION_BY_FROM = {};
  for (var ei = 0; ei < XS.EVOLUTIONS.length; ei++) {
    XS.EVOLUTION_BY_FROM[XS.EVOLUTIONS[ei].from] = XS.EVOLUTIONS[ei];
  }

  /* 已满足条件、但还没拿到的进化（升级面板用） */
  XS.availableEvolutions = function (taken, evolved) {
    var out = [];
    for (var i = 0; i < XS.EVOLUTIONS.length; i++) {
      var ev = XS.EVOLUTIONS[i];
      if (evolved[ev.from]) continue;
      var base = XS.UPGRADE_MAP[ev.from];
      if (!base) continue;
      if ((taken[ev.from] || 0) < base.max) continue;
      if ((taken[ev.req.id] || 0) < ev.req.lv) continue;
      out.push(ev);
    }
    return out;
  };

  /* 进化卡上的前置文案，如「太上忘情 Lv3」 */
  XS.evoReqText = function (ev) {
    var u = XS.UPGRADE_MAP[ev.req.id];
    return (u ? u.name : ev.req.id) + ' Lv' + ev.req.lv;
  };

  /* ---------- 广告点位（IAA） ---------- */
  XS.AD = {
    revive:   { id: 'revive',   name: '看广告复活',   limit: 2, desc: '原地复生，并清空周身妖魔' },
    doubleXp: { id: 'doubleXp', name: '双倍收益',     limit: 1, desc: '本局灵石收益 ×2' },
    boost:    { id: 'boost',    name: '神行符',       limit: 1, desc: '30 秒内移速与攻速提升' }
  };

  /* ---------- 品质色（用于升级卡） ---------- */
  XS.TAG_COLOR = {
    '核心': '#ffcf6b',
    '远程': '#4de8ff',
    '范围': '#ff8a3d',
    '控制': '#8fd4ff',
    '状态': '#ff9a45',
    '生存': '#7dffa8',
    '身法': '#a97bff',
    '成长': '#ffe07a',
    '输出': '#ff5a4d',
    '进化': '#ffd76a',
    '便利': '#8fd4ff'
  };

})(window);
