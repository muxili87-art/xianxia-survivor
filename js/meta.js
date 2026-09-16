/* ============================================================
 * 局外成长：灵石商店 / 成就 / 图鉴
 *
 * 为什么要有这一层：
 * 单局内的成长（升级三选一 + 功法进化）只解决「这一局怎么打」。
 * 一局结束，一切都归零 —— 玩家第二次打开游戏的动机是零。
 * 一个能长期留住人的小游戏，必须有**跨局的账**：
 * 这一局死了，但我赚到了灵石，灵石能换成永久变强，
 * 而且我还差 3 个成就、图鉴里还有 5 个问号没点亮。
 *
 * 三条设计红线：
 *  1) 局外强化**只加下限、不改手感**。加气血、加伤害、加移速，
 *     绝不改攻击节奏、技能形态、波次表 —— 那些是玩家学到的「规则」，
 *     改规则会让人重新学一遍，而不是感觉变强。
 *  2) 数值必须**可预期**。每一级写死 +10 气血 / +2% 伤害，
 *     不用随机、不用「概率触发」，否则玩家算不清自己买了什么。
 *  3) 存档**只存事实**（买了哪几级、点亮了哪几个图鉴），
 *     派生数值一律现算。和功法 apply() 同样的理由：
 *     两处存同一个真相，迟早会不一致。
 *
 * 存档键：xs_meta（经 XS.Platform.save，Web 走 localStorage，
 * 微信/抖音走 setStorageSync，跨端不用改这里）。
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var P = XS.Platform;

  var SAVE_KEY = 'meta';
  var SAVE_VER = 2;

  /* ============================================================
   * 一、永久强化（灵石商店）
   *
   * cost(lv) 里的 lv 是「当前等级」（0 表示还没买过），
   * 所以第一级的价格就是 base，之后按 1.55 倍递增。
   *
   * ── 数值为什么这么小（两轮实测换来的）──
   * 初版是「+80 气血 / +16% 伤害 / +9% 移速 / +2 复活 / +20% 经验」，
   * 看起来只是「白送两级核心技能」。实测 16 局：
   *
   *   零强化（基线）                                      43.8%
   *   仅 淬体+剑意（+80 气血 / +16% 伤害）                68.8%
   *   仅 回魂+疾风+悟性（+2 复活 / +9% 移速 / +20% 经验）  93.8%
   *   全部拉满                                            100%（0 死亡）
   *
   * 收紧到 +60 气血 / +12% 伤害 / +4% 移速 / +12% 经验 / +1 复活 之后再测：
   *
   *   仅 回魂（只多一条命）                               68.8%
   *   全部拉满                                            100%
   *
   * **结论：「买一条命」单独就值 +25 个百分点。** 所以那条轨道被整个删掉了，
   * 换成不参与战斗的「灵韵」（拾取范围）。详见 Meta.reviveBonus 的注释。
   *
   * 底层原因还是那条阈值律：终局胜负是「能不能压住刷怪速度」的阶跃函数，
   * 一旦永久强化把玩家推过阈值，每一局都会通关 —— 成长系统反而把游戏玩没了。
   * 目标：满强化 ≈ 70~80%，有成长感，但还输得掉。
   * ============================================================ */
  /* 每种「效果类型」一个生成器。per（每级增量）是**唯一**数值来源 ——
     apply() 由它生成，商店文案也由它拼出来，两处不可能对不上。

     为什么要这么绕：初版是「applyStart 里手写一份系数 + 商店文案里再手写一份」，
     于是必然出现「商店写着 +1.5%、实际只给 1%」这种最难查的错 ——
     玩家一定会发现，而你要翻两个文件才找得到。 */
  var APPLY = {
    hp: function (per) { return function (p, lv) { p.maxHp += lv * per; p.hp = p.maxHp; }; },
    dmg: function (per) { return function (p, lv) { p.dmgMul *= 1 + lv * per / 100; }; },
    speed: function (per) { return function (p, lv) { p.speed *= 1 + lv * per / 100; }; },
    xp: function (per) { return function (p, lv) { p.xpGain *= 1 + lv * per / 100; }; },
    /* 下面两种不作用在伤害公式上：
       greed 只影响结算入账（见 Meta.coinMul），
       pickup 只改拾取范围。 */
    greed: function () { return function () {}; },
    pickup: function (per) { return function (p, lv) { p.pickupRadius *= 1 + lv * per / 100; }; }
  };

  function mk(cfg) {
    var gen = APPLY[cfg.kind];
    /* 拼错 kind 会让整张表在载入时炸掉 —— 这是好事，
       总好过悄悄给一个空 apply，让玩家买了强化却什么都没变。 */
    if (!gen) throw new Error('meta: unknown upgrade kind "' + cfg.kind + '"');
    cfg.apply = gen(cfg.per);
    return cfg;
  }

  XS.META_UPGRADES = [
    mk({
      id: 'hp', name: '淬体', icon: '体', max: 6, base: 680, tag: '生存',
      kind: 'hp', per: 10, unit: '',
      desc: '初始气血 +10',
      detail: '开局血量上限与当前血量同时提升。撑过前两波的关键。'
    }),
    mk({
      id: 'power', name: '剑意', icon: '意', max: 6, base: 780, tag: '输出',
      kind: 'dmg', per: 2, unit: '%',
      desc: '全局伤害 +2%',
      detail: '作用于所有伤害来源（飞剑、剑气、天雷、灼烧、罡气），乘算在最外层。'
    }),
    mk({
      id: 'speed', name: '疾风', icon: '风', max: 4, base: 590, tag: '身法',
      kind: 'speed', per: 1, unit: '%',
      desc: '初始移速 +1%',
      detail: '走位是这款游戏唯一的操作，移速是最诚实的强化 —— 所以给得最少。'
    }),
    mk({
      id: 'greed', name: '聚宝', icon: '宝', max: 5, base: 360, tag: '收益',
      kind: 'greed', per: 6, unit: '%',
      desc: '灵石获取 +6%',
      detail: '只影响结算入账，不影响对局内强度 —— 加速下一轮循环，不推高战斗力天花板。'
    }),
    mk({
      id: 'xp', name: '悟性', icon: '悟', max: 4, base: 530, tag: '成长',
      kind: 'xp', per: 3, unit: '%',
      desc: '经验获取 +3%',
      detail: '同一条经验曲线下能多升 1 级，等于多一次三选一。'
    }),
    mk({
      id: 'pickup', name: '灵韵', icon: '韵', max: 5, base: 620, tag: '便利',
      kind: 'pickup', per: 8, unit: '%',
      desc: '灵气拾取范围 +8%',
      detail: '少跑一半冤枉路。不直接加伤害，但让每一局的节奏舒服很多。'
    })
  ];

  XS.META_MAP = {};
  for (var mi = 0; mi < XS.META_UPGRADES.length; mi++) {
    XS.META_MAP[XS.META_UPGRADES[mi].id] = XS.META_UPGRADES[mi];
  }

  /* 升到「下一级」要花的灵石。lv 为当前等级；已满级返回 null。 */
  XS.metaCost = function (def, lv) {
    if (lv >= def.max) return null;
    return Math.round(def.base * Math.pow(1.55, lv) / 10) * 10;
  };

  /* ============================================================
   * 二、成就
   *
   * 每条成就的 check(c) 拿到一份对局上下文：
   *   c.rec      本局完整记录（含 evolves / bossKills / upgrades）
   *   c.p        提交完本局之后的存档（累计数据已更新）
   *   c.win      是否通关
   *   c.evolves  本局进化出的基础功法 id 数组
   *
   * 设计原则：成就必须**奖励玩家本来就想做的事**，
   * 而不是逼玩家做奇怪的事。所以这里全是「更狠一点」的目标
   * （境界更高、斩妖更多、进化更多），没有「不许点某个功法」这类
   * 反直觉的约束 —— 小游戏没有攻略社区，玩家读不懂的成就等于不存在。
   * ============================================================ */
  XS.ACHIEVEMENTS = [
    {
      id: 'first_run', name: '初入仙台', icon: '入', tier: 'bronze',
      desc: '完成第一局',
      check: function (c) { return c.p.stats.runs >= 1; }
    },
    {
      id: 'lv10', name: '剑气初成', icon: '剑', tier: 'bronze',
      desc: '单局境界达到 10',
      check: function (c) { return c.level >= 10; }
    },
    {
      id: 'evo1', name: '万法归宗', icon: '宗', tier: 'silver',
      desc: '首次完成功法进化',
      check: function (c) { return c.p.stats.evolves >= 1; }
    },
    {
      id: 'lv20', name: '剑意通玄', icon: '玄', tier: 'silver',
      desc: '单局境界达到 20',
      check: function (c) { return c.level >= 20; }
    },
    {
      id: 'win1', name: '渡劫成功', icon: '渡', tier: 'gold',
      desc: '首次撑过八分钟',
      check: function (c) { return c.p.stats.wins >= 1; }
    },
    {
      id: 'kills1k', name: '斩妖千数', icon: '千', tier: 'bronze',
      desc: '累计斩妖 1000',
      check: function (c) { return c.p.stats.kills >= 1000; }
    },
    {
      id: 'boss3', name: '三劫加身', icon: '劫', tier: 'silver',
      desc: '单局斩杀 3 只魔尊',
      check: function (c) { return (c.rec.bossKills || 0) >= 3; }
    },
    {
      id: 'evo3', name: '三花聚顶', icon: '花', tier: 'gold',
      desc: '单局完成 3 次功法进化',
      check: function (c) { return c.evolves.length >= 3; }
    },
    {
      id: 'icefire', name: '冰火同炉', icon: '炉', tier: 'gold',
      desc: '单局同时进化玄冰诀与烈焰符',
      check: function (c) {
        return c.evolves.indexOf('frost') >= 0 && c.evolves.indexOf('ember') >= 0;
      }
    },
    {
      id: 'lv30', name: '剑仙之姿', icon: '仙', tier: 'gold',
      desc: '单局境界达到 30',
      check: function (c) { return c.level >= 30; }
    },
    {
      id: 'run4k', name: '一剑破万法', icon: '破', tier: 'gold',
      desc: '单局斩妖 4000',
      check: function (c) { return c.kills >= 4000; }
    },
    {
      id: 'cleanwin', name: '一气呵成', icon: '成', tier: 'gold',
      desc: '不复活通关',
      check: function (c) { return c.win && (c.rec.revives || 0) === 0; }
    },
    {
      id: 'flawless', name: '无垢之身', icon: '垢', tier: 'purple',
      desc: '通关且本局承受伤害低于 400',
      check: function (c) { return c.win && c.rec.dmgTaken < 400; }
    },
    {
      id: 'kills10k', name: '万妖辟易', icon: '万', tier: 'purple',
      desc: '累计斩妖 10000',
      check: function (c) { return c.p.stats.kills >= 10000; }
    },
    {
      id: 'rich', name: '富甲一方', icon: '富', tier: 'silver',
      desc: '累计获得灵石 5000',
      check: function (c) { return c.p.stats.totalCoins >= 5000; }
    },
    {
      id: 'runs20', name: '道心坚定', icon: '定', tier: 'purple',
      desc: '累计完成 20 局',
      check: function (c) { return c.p.stats.runs >= 20; }
    }
  ];

  XS.ACH_MAP = {};
  for (var ai = 0; ai < XS.ACHIEVEMENTS.length; ai++) {
    XS.ACH_MAP[XS.ACHIEVEMENTS[ai].id] = XS.ACHIEVEMENTS[ai];
  }

  /* ============================================================
   * 三、图鉴
   *
   * 图鉴条目全部**从已有配置派生**，不另写一份数值 ——
   * 另写一份的下场是「图鉴写着小妖 13 血、实际打起来是 20 血」，
   * 而这种不一致玩家一定会发现，且一定会当成 bug。
   * 这里只额外补一句「玩家视角该知道什么」的说明文字。
   * ============================================================ */
  XS.CODEX_ENEMY_TEXT = {
    imp:    '最底层的小妖，数量最多。单体不足为惧，成群时会把你顶在原地。',
    flyer:  '浮空的飞魔，速度明显快于小妖，绕圈风筝时会先追上来。',
    brute:  '魔卒皮厚力沉，走得慢但撞上就是重伤。别在它正面停太久。',
    wraith: '怨灵忽隐忽现，速度介于小妖与飞魔之间，成群出现时最容易被包围。',
    caster: '妖巫不会贴身，它停在射程边缘放法术。不主动上前清掉，血会一直掉。',
    charger:'妖狼蓄力后直线冲锋。往后退只会被追上，横向闪避才是正解。',
    splitter:'裂魔倒下会裂成两只小裂魔。贴着脸清它，子体会直接糊在你身上 —— 清场要看位置。',
    splitling:'裂魔的残片，单体很弱。但它出生在母体倒下的地方，成群扑上来时最烦人。',
    guard:  '盾卫撑起护罩，削弱范围内其他妖魔受到的伤害。不先杀它，这一整片会一直打不动。',
    elite:  '妖将血量极高，是中期的主要死因。它出现时先清小怪，别被围在中间。',
    boss:   '魔尊招式有二：红环扩散的「裂地」要离开原地，蓝环收拢的「弹幕环」要横向闪避。'
  };

  XS.CODEX_ENEMY_ORDER = ['imp', 'flyer', 'brute', 'wraith', 'caster', 'charger',
                          'splitter', 'splitling', 'guard', 'elite', 'boss'];
  XS.CODEX_EVO_ORDER = ['sword', 'qi', 'thunder', 'frost', 'ember', 'aura'];
  /* 图鉴卡片上的单字图标。不能直接用名字首字 ——
     妖巫和妖狼都会变成「妖」，玩家分不清自己点亮了哪一个。
     小裂魔也不能用「小」：那是小妖的图标。 */
  XS.CODEX_ENEMY_ICON = {
    imp: '小', flyer: '飞', brute: '卒', wraith: '怨',
    caster: '巫', charger: '狼', splitter: '裂', splitling: '片',
    guard: '盾', elite: '将', boss: '尊'
  };

  /* ============================================================
   * 四、存档
   * ============================================================ */
  function defaultData() {
    return {
      ver: SAVE_VER,
      coins: 0,
      up: {},                 // { trackId: 等级 }
      ach: {},                // { achId: 解锁时间戳 }
      seen: { enemy: {}, skill: {}, evo: {} },
      stats: {
        runs: 0, wins: 0, kills: 0, evolves: 0,
        totalCoins: 0, bestDur: 0, bestLevel: 1, bestKills: 0
      }
    };
  }

  /* 老存档迁移：缺字段补齐、类型不对就丢掉。
     直接信任 localStorage 里的东西是最常见的崩法 ——
     玩家手动清过缓存、装过旧版本、或者上次写到一半被杀了进程。 */
  function normalize(raw) {
    var d = defaultData();
    if (!raw || typeof raw !== 'object') return d;
    if (typeof raw.coins === 'number' && isFinite(raw.coins) && raw.coins >= 0) {
      d.coins = Math.floor(raw.coins);
    }
    if (raw.up && typeof raw.up === 'object') {
      for (var i = 0; i < XS.META_UPGRADES.length; i++) {
        var def = XS.META_UPGRADES[i];
        var v = raw.up[def.id];
        if (typeof v === 'number' && v > 0) d.up[def.id] = Math.min(def.max, Math.floor(v));
      }
    }
    if (raw.ach && typeof raw.ach === 'object') {
      for (var k in raw.ach) if (raw.ach.hasOwnProperty(k)) d.ach[k] = raw.ach[k] || 1;
    }
    if (raw.seen && typeof raw.seen === 'object') {
      var groups = ['enemy', 'skill', 'evo'];
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        if (raw.seen[g] && typeof raw.seen[g] === 'object') {
          for (var gk in raw.seen[g]) if (raw.seen[g].hasOwnProperty(gk)) d.seen[g][gk] = 1;
        }
      }
    }
    if (raw.stats && typeof raw.stats === 'object') {
      var s = raw.stats;
      if (typeof s.runs === 'number') d.stats.runs = s.runs;
      if (typeof s.wins === 'number') d.stats.wins = s.wins;
      if (typeof s.kills === 'number') d.stats.kills = s.kills;
      if (typeof s.evolves === 'number') d.stats.evolves = s.evolves;
      if (typeof s.totalCoins === 'number') d.stats.totalCoins = s.totalCoins;
      if (typeof s.bestDur === 'number') d.stats.bestDur = s.bestDur;
      if (typeof s.bestLevel === 'number') d.stats.bestLevel = s.bestLevel;
      if (typeof s.bestKills === 'number') d.stats.bestKills = s.bestKills;
    }
    return d;
  }

  var Meta = XS.Meta = {
    /* 不写档。一次 16 局的平衡测试会把真实存档灌满灵石、
       顺带把成就全点亮，之后所有测量都不再可信。 */
    offline: false,

    /* 等级覆盖表：{ id: lv }，null 表示「照存档读」。
       用一个对象统一表达「零强化 / 满强化 / 只开某几条」三种测量场景。
       一开始这里是三个互相作用的布尔量（offline / blank / forceMax），
       结果是 ?metamax 测出来的复活次数永远是 2 —— 因为 offline 被顺手
       当成了「不应用强化」，reviveBonus() 里也判了它。
       一个变量背两种语义，是这个项目里最难发现的一类 bug：
       所有数字看起来都正常，只是不是你要测的那个数。 */
    override: null
  };

  Meta.data = normalize(P.load(SAVE_KEY, null));

  Meta.save = function () {
    if (Meta.offline) return;
    P.save(SAVE_KEY, Meta.data);
  };

  /* ---------- 测量开关 ---------- */
  /* 零强化：可复现的平衡基线。否则测出来的胜率取决于开发者自己买了多少级。 */
  Meta.setBlank = function () { Meta.override = {}; };

  /* 满强化：量「玩到后期」的天花板 —— 知道上限在哪，才知道它有没有把游戏玩坏。 */
  Meta.setMax = function () {
    var o = {};
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      o[XS.META_UPGRADES[i].id] = XS.META_UPGRADES[i].max;
    }
    Meta.override = o;
  };

  /* 只开指定的几条，如 "hp:8,power:8"。
     满强化把胜率顶到 100% 之后，必须能逐条定位是谁干的 ——
     难度是阈值型的，六条轨道一起测只能得到「都有关」。 */
  Meta.setSpec = function (spec) {
    var o = {};
    var pairs = String(spec).split(',');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split(':');
      var id = kv[0].replace(/[^a-z]/g, '');
      var lv = parseInt(kv[1], 10);
      if (!XS.META_MAP[id] || !(lv > 0)) continue;
      o[id] = Math.min(XS.META_MAP[id].max, lv);
    }
    Meta.override = o;
    return o;
  };

  /* 便捷读取。所有派生数值都必须走这里 ——
     任何地方直接读 Meta.data.up[id] 都会绕开 override，
     测出来的数就不再是你要测的那个数。 */
  Meta.lv = function (id) {
    if (Meta.override) return Meta.override[id] || 0;
    return Meta.data.up[id] || 0;
  };

  /* ---------- 永久强化：开局应用 ----------
     遍历而不是逐条手写：加一条新轨道只要在表里加一行，这里不用动，
     也不可能出现「表里有、开局忘了加」这种哑巴 bug。 */
  Meta.applyStart = function (p) {
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      var d = XS.META_UPGRADES[i];
      var lv = Meta.lv(d.id);
      if (lv > 0) d.apply(p, lv);
    }
    return p;
  };

  /* 注意：这两个函数**不能**再判断 Meta.offline。
     offline 的语义只有一个 —— 「不写档」。
     它和「用不用强化」是两件事：?farm 要的是「零强化 + 不写档」，
     ?metamax 要的是「满强化 + 不写档」。
     混在一起写会得到一个几乎不可能发现的 bug：
     满强化测量跑出来的复活次数永远是 2，而看起来一切正常。 */
  Meta.coinMul = function () { return 1 + Meta.lv('greed') * XS.META_MAP.greed.per / 100; };

  /* 复活加成。**这里现在恒为 0 —— 这是实测之后故意留空的。**
     曾经有一条「回魂：复活次数 +1」的轨道，16 局实测：
     只买这一条，通关率就从 43.8% 跳到 68.8%（+25 个百分点）。
     原因：复活会给满血 + 3 秒无敌 + 清空周身 16 米内的妖魔，
     本质是一个「重开一次这段」的按钮。把它做成商品，
     等于把难度选项明码标价 —— 买一条命就是买 25 个百分点的胜率，
     再叠两条战斗轨道必然顶到 100%。

     广告复活本身（XS.AD.revive.limit = 2）已经是容错阀，
     商店不该再卖第二个。函数保留着，将来若要重新加回来，
     只要在表里补一条 kind:'revive' 的轨道即可。 */
  Meta.reviveBonus = function () {
    var d = XS.META_MAP.revive;
    return d ? Meta.lv('revive') * d.per : 0;
  };

  /* 当前永久强化的文字摘要（开始界面用） */
  Meta.summary = function () {
    var out = [];
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      var d = XS.META_UPGRADES[i];
      var lv = Meta.lv(d.id);
      if (lv > 0) out.push(d.name + ' Lv' + lv);
    }
    return out;
  };

  /* ---------- 购买 ---------- */
  Meta.buy = function (id) {
    if (Meta.offline) return { ok: false, reason: 'offline' };
    var def = XS.META_MAP[id];
    if (!def) return { ok: false, reason: 'unknown' };
    var lv = Meta.lv(id);
    var cost = XS.metaCost(def, lv);
    if (cost === null) return { ok: false, reason: 'maxed' };
    if (Meta.data.coins < cost) return { ok: false, reason: 'poor', cost: cost };
    Meta.data.coins -= cost;
    Meta.data.up[id] = lv + 1;
    Meta.save();
    return { ok: true, lv: lv + 1, cost: cost };
  };

  /* ---------- 图鉴解锁 ----------
     这三个函数都在热路径上（每次刷怪都会调 seeEnemy），
     所以第一件事就是查表短路，未解锁才走后面的写入。 */
  Meta.seeEnemy = function (type) {
    if (Meta.data.seen.enemy[type]) return;
    Meta.data.seen.enemy[type] = 1;
    Meta.save();
  };

  Meta.seeSkill = function (id) {
    if (!id || Meta.data.seen.skill[id]) return;
    Meta.data.seen.skill[id] = 1;
    Meta.save();
  };

  Meta.seeEvo = function (from) {
    if (!from || Meta.data.seen.evo[from]) return;
    Meta.data.seen.evo[from] = 1;
    Meta.save();
  };

  /* ---------- 一局结束：入账 + 成就判定 ----------
     返回 { earned, newAch }。earned 是实际入账的灵石（已乘聚宝倍率）。
     result==='quit' 的对局不入账 —— 否则「开局立刻退出」会变成刷灵石的最优解。 */
  Meta.commitRun = function (rec) {
    var newAch = [];
    if (Meta.offline) return { earned: 0, newAch: newAch };

    var d = Meta.data;
    var raw = rec.soulCoins || 0;
    var earned = rec.result === 'quit' ? 0 : Math.round(raw * Meta.coinMul());

    d.coins += earned;
    d.stats.totalCoins += earned;
    d.stats.runs++;
    d.stats.kills += rec.kills || 0;
    d.stats.evolves += (rec.evolves || []).length;
    if (rec.result === 'win') d.stats.wins++;
    if ((rec.dur || 0) > d.stats.bestDur) d.stats.bestDur = rec.dur;
    if ((rec.level || 1) > d.stats.bestLevel) d.stats.bestLevel = rec.level;
    if ((rec.kills || 0) > d.stats.bestKills) d.stats.bestKills = rec.kills;

    var ctx = {
      rec: rec, p: d,
      win: rec.result === 'win',
      level: rec.level || 1,
      kills: rec.kills || 0,
      evolves: rec.evolves || []
    };
    for (var i = 0; i < XS.ACHIEVEMENTS.length; i++) {
      var a = XS.ACHIEVEMENTS[i];
      if (d.ach[a.id]) continue;
      var ok = false;
      try { ok = !!a.check(ctx); } catch (e) { ok = false; }
      if (ok) {
        d.ach[a.id] = Date.now();
        newAch.push(a);
      }
    }

    Meta.save();
    return { earned: earned, newAch: newAch };
  };

  Meta.achCount = function () {
    var n = 0;
    for (var i = 0; i < XS.ACHIEVEMENTS.length; i++) if (Meta.data.ach[XS.ACHIEVEMENTS[i].id]) n++;
    return n;
  };

  Meta.codexCount = function () {
    var d = Meta.data;
    var n = 0, k;
    for (k in d.seen.enemy) if (d.seen.enemy[k]) n++;
    for (k in d.seen.skill) if (d.seen.skill[k]) n++;
    for (k in d.seen.evo) if (d.seen.evo[k]) n++;
    return n;
  };

  Meta.codexTotal = function () {
    return XS.CODEX_ENEMY_ORDER.length + XS.UPGRADES.length + XS.CODEX_EVO_ORDER.length;
  };

  /* ---------- 调试：给灵石 / 一键满级 / 清档 ---------- */
  /* silent=true：只改内存不落盘。和 debugMaxAll / debugUnlockAch 同一套规矩 ——
     走查 / 截图脚本一律不许碰真实存档，否则跑一次作品集就永久改一次本机数据。 */
  Meta.debugGrant = function (n, silent) {
    Meta.data.coins += n;
    if (!silent) Meta.save();
    return Meta.data.coins;
  };

  Meta.debugMaxAll = function (silent) {
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      Meta.data.up[XS.META_UPGRADES[i].id] = XS.META_UPGRADES[i].max;
    }
    for (var j = 0; j < XS.CODEX_ENEMY_ORDER.length; j++) Meta.data.seen.enemy[XS.CODEX_ENEMY_ORDER[j]] = 1;
    for (var k = 0; k < XS.UPGRADES.length; k++) Meta.data.seen.skill[XS.UPGRADES[k].id] = 1;
    for (var m = 0; m < XS.CODEX_EVO_ORDER.length; m++) Meta.data.seen.evo[XS.CODEX_EVO_ORDER[m]] = 1;
    if (!silent) Meta.save();
    return Meta.data;
  };

  /* silent=true：只改内存不落盘。UI 走查（?metaunlock）必须走这条 ——
     否则每跑一次作品集截图脚本，本机的真实存档就被永久点亮一次，
     之后所有「从零开始」的手感验证都不再成立。 */
  Meta.debugUnlockAch = function (silent) {
    for (var i = 0; i < XS.ACHIEVEMENTS.length; i++) Meta.data.ach[XS.ACHIEVEMENTS[i].id] = Date.now();
    if (!silent) Meta.save();
    return Meta.achCount();
  };

  Meta.debugReset = function () {
    Meta.data = defaultData();
    P.save(SAVE_KEY, Meta.data);
    return Meta.data;
  };

  /* 部分点亮（走查 / 作品集截图用）。
     一张全亮的成就墙其实证明不了什么 —— 它和「写死的图」看不出区别；
     而玩家平时真正面对的，是**大半还没点亮**的那一版。
     所以留一个能造出「半亮」状态的口子：每类点亮前 n 条。
     和 debugMaxAll / debugUnlockAch 一样，只改内存，调用方负责置 offline。 */
  Meta.debugReveal = function (n) {
    var i;
    var aN = Math.min(n, XS.ACHIEVEMENTS.length);
    for (i = 0; i < aN; i++) Meta.data.ach[XS.ACHIEVEMENTS[i].id] = Date.now();

    var eN = Math.min(n, XS.CODEX_ENEMY_ORDER.length);
    for (i = 0; i < eN; i++) Meta.data.seen.enemy[XS.CODEX_ENEMY_ORDER[i]] = 1;

    var sN = Math.min(n, XS.UPGRADES.length);
    for (i = 0; i < sN; i++) Meta.data.seen.skill[XS.UPGRADES[i].id] = 1;

    var vN = Math.min(n, XS.CODEX_EVO_ORDER.length);
    for (i = 0; i < vN; i++) Meta.data.seen.evo[XS.CODEX_EVO_ORDER[i]] = 1;

    return { ach: Meta.achCount(), codex: Meta.codexCount() };
  };

  /* ---------- 商店视图数据（UI 只读） ---------- */
  Meta.shopView = function () {
    var out = [];
    for (var i = 0; i < XS.META_UPGRADES.length; i++) {
      var d = XS.META_UPGRADES[i];
      var lv = Meta.lv(d.id);
      var cost = XS.metaCost(d, lv);
      out.push({
        def: d, lv: lv, cost: cost,
        maxed: cost === null,
        affordable: cost !== null && Meta.data.coins >= cost,
        /* 文案里的「当前 +X」直接由 per 乘出来，和 apply() 同源，
           不可能出现「商店写 +2%、实际给 1%」。 */
        effect: lv > 0 ? d.desc + '（当前 +' + (lv * d.per) + d.unit + '）' : d.desc
      });
    }
    return out;
  };

})(window);
