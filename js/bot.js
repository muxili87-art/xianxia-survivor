/* ============================================================================
 * bot.js —— 机器人走位大脑
 *
 * 这个文件存在的唯一理由：**走位策略必须只有一份**。
 *
 * 它原本长在 main.js 里。而 main.js 是 Web 专有的（启动流程 + 调试设施），
 * 不进小游戏包。于是小游戏版走查时玩家一动不动 —— 22 秒就被围死，
 * 结算屏能拍到、「通关」永远拍不到。更糟的是：
 *   走查机器人不动 = **触摸输入那条路根本没被验证过**。
 * 而触摸输入恰恰是「移植到小游戏要改的四件事」之一。
 * 一个不会动的机器人会让走查看起来全绿，实际上漏掉了整条链路。
 *
 * 所以走位大脑被抽到这里，由两个宿主共用：
 *   - main.js（Web）：rAF 循环 / ?autopilot
 *   - minigame/boot.js：同步步进 / ?mgplay、?mguntil
 * 两边都只写 XS.Input.vec —— 和真人手指写的是同一个字段。
 * 这样「机器人能跑」和「玩家能跑」验证的是同一条代码路径。
 *
 * 注意：**选牌策略不在这里**（那是 UI 层的事，两个宿主的点法不同），
 * 但两边的策略必须等价 —— 见 minigame/boot.js 的 botPick() 注释。
 * ========================================================================= */
(function () {
  var XS = window.XS = window.XS || {};

  var Bot = XS.Bot = {};

  /* ------------------------------------------------------------
   * 技能档位
   * botSkill 0~1：0 = 新手（反应慢、手抖、贪灵气珠）
   *              1 = 高手（反应快、贴边风筝、残血优先保命）
   *
   * 为什么要这个：完美风筝的机器人 8 分钟零伤通关，得到的
   * 数据全是「100% 通关」，对留存/难度曲线分析毫无价值。
   * 只有按技能档位跑，才能拿到真实的时长分布与流失时间点。
   * ------------------------------------------------------------ */
  var skill = 1.0;
  var react = 0;              // 反应计时：到点才刷新一次决策
  var vxHeld = 0, vzHeld = 0; // 当前持有的决策向量（手指还没跟上）
  var noise = 0;
  var threats = [];
  var angle = 0;              // 无威胁时的游走角

  Bot.skillSet = function (v) {
    skill = Math.max(0, Math.min(1, v));
    react = 0; vxHeld = 0; vzHeld = 0;
  };
  Bot.skill = function () { return skill; };

  /* ------------------------------------------------------------
   * 选牌策略：**只有这一份**，两个宿主共用。
   *
   * 为什么必须共用：它决定「能不能走到进化」，也决定跑出来的平衡
   * 数据是不是同一套。之前两个宿主各写一份 —— Web 版去抓 DOM 文本
   * （`已习得 Lv3` / `尚未习得`），小游戏版读卡片字段 —— 两边的
   * 字符串匹配细节不同，选出来的构筑就不一样：
   * 同条件跑 300 秒，Web 版剩 111 血、小游戏版剩 22 血。
   * 那看起来像「移植引入了难度差异」，其实只是两个机器人
   * 做了不同的选择。走位大脑抽出来的时候已经踩过一次同样的坑。
   *
   * 返回下标（-1 = 没有可选的），由宿主交给自己的 UI 去点。
   * ------------------------------------------------------------ */
  Bot.pickCard = function (cards) {
    if (!cards || !cards.length) return -1;
    var i, c;
    /* 1) 进化卡永远优先 —— 这既是「会玩的人」的真实选择，
          也是测量进化系统收益的必要条件（否则永远测不到它）。 */
    for (i = 0; i < cards.length; i++) if (cards[i].evo) return i;
    /* 2) 有正在追的进化目标时，优先补它的两块拼图（见 Game.botAdvice） */
    var adv = XS.Game.botAdvice ? XS.Game.botAdvice() : null;
    if (adv) for (i = 0; i < cards.length; i++) if (cards[i].id === adv) return i;
    /* 3) 先把核心功法堆到 4 级 */
    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      if ((c.id === 'sword' || c.id === 'qi') && (c.current || 0) < 4) return i;
    }
    /* 4) 再补新功法 */
    for (i = 0; i < cards.length; i++) if (!((cards[i].current || 0) > 0)) return i;
    /* 5) 兜底：第一张 */
    return 0;
  };

  /* 走查用：把内部状态摊开，方便判断「机器人是不是根本没在动」。
     这个字段是被动出来的 —— 上一版没有它，于是「机器人站着不动」
     只能靠人眼盯着截图猜。 */
  Bot.debug = function () {
    return {
      skill: +skill.toFixed(2),
      held: [+vxHeld.toFixed(3), +vzHeld.toFixed(3)],
      react: +react.toFixed(3),
      threats: threats.length,
      angle: +angle.toFixed(2)
    };
  };

  Bot.input = function (dt) {
    var p = XS.Game.player();
    if (!p) return;

    noise += dt * (2.6 + 3.6 * (1 - skill));

    /* 反应延迟：技能越低，决策刷新越慢 —— 真人手指跟不上 */
    react -= dt;
    if (react > 0) {
      XS.Input.vec.x = vxHeld;
      XS.Input.vec.y = -vzHeld;
      XS.Input.active = true;
      return;
    }
    react = 0.22 - 0.17 * skill;

    /* 1) 躲开贴身的妖魔
       关键：机器人不能开「全场透视」。
       真人玩家的注意力是有限的 —— 被 100 只怪围住时，
       眼睛只会盯住最近的几只，剩下的从背后贴上来。
       所以这里限制「同时纳入考量的威胁数量」，且随技能提升。 */
    var reactR = 2.3 + 1.5 * skill;
    var maxThreats = Math.round(3 + 9 * skill);
    var rx = 0, rz = 0;
    var byType = XS.Game.debugEnemies();
    if (byType) {
      var TYPES = XS.Game.debugTypes;
      threats.length = 0;
      for (var ti = 0; ti < TYPES.length; ti++) {
        var arr = byType[TYPES[ti]];
        for (var i = 0; i < arr.length; i++) {
          var e = arr[i];
          var dx = p.x - e.x, dz = p.z - e.z;
          var d2 = dx * dx + dz * dz;
          var danger = e.radius + reactR;
          if (d2 < danger * danger) {
            threats.push({ e: e, d: Math.sqrt(d2) || 0.01, dx: dx, dz: dz, danger: danger });
          }
        }
      }
      if (threats.length > 1) threats.sort(function (a, b) { return a.d - b.d; });
      var lim2 = Math.min(threats.length, maxThreats);
      for (var q = 0; q < lim2; q++) {
        var th = threats[q];
        var w = (th.danger - th.d) / th.danger * (th.e.isBoss ? 2.2 : 1);
        rx += th.dx / th.d * w;
        rz += th.dz / th.d * w;
      }
    }

    /* 1b) 躲开正在飞过来的术法弹。
       真人看得见弹道，所以机器人也必须看得见 ——
       否则「加了远程怪之后变难了」这个结论是假的，
       真相只是「机器人瞎」。 */
    var bolts = XS.Game.debugBolts && XS.Game.debugBolts();
    if (bolts) {
      for (var bi = 0; bi < bolts.length; bi++) {
        var bl = bolts[bi];
        if (!bl.alive) continue;
        var bdx = p.x - bl.x, bdz = p.z - bl.z;
        var bd = Math.sqrt(bdx * bdx + bdz * bdz) || 0.01;
        if (bd > 7.5) continue;
        /* 只躲「正在靠近」的弹：位置差与速度同向即为逼近 */
        if (bdx * bl.vx + bdz * bl.vz <= 0) continue;
        var bw = (7.5 - bd) / 7.5 * (1.4 + 1.4 * skill);
        rx += bdx / bd * bw;
        rz += bdz / bd * bw;
      }
    }

    /* 1c) 躲开地面预警（魔尊裂地 / 妖狼蓄力） */
    var hazards = XS.Game.debugHazards && XS.Game.debugHazards();
    if (hazards) {
      for (var hi = 0; hi < hazards.length; hi++) {
        var hz = hazards[hi];
        var hdx = p.x - hz.x, hdz = p.z - hz.z;
        var hd = Math.sqrt(hdx * hdx + hdz * hdz);
        if (hd > hz.r + 2.6) continue;
        if (hd < 0.05) { hdx = 1; hdz = 0; hd = 1; }
        var hw = (hz.r + 2.6 - hd) / (hz.r + 2.6) * (2.0 + 2.0 * skill);
        rx += hdx / hd * hw;
        rz += hdz / hd * hw;
      }
    }

    /* 残血恐慌：技能越高越会果断脱战 */
    var hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    if (hpFrac < 0.4) {
      var panic = (0.4 - hpFrac) / 0.4 * (0.8 + 1.8 * skill);
      rx += rx * panic;
      rz += rz * panic;
    }

    /* 2) 捡最近的灵气珠（新手更贪，高手会权衡） */
    var orbs = XS.Game.debugOrbs();
    var ax = 0, az = 0;
    var best = null, bd = 1e9;
    if (orbs) {
      for (var j = 0; j < orbs.length; j++) {
        var o = orbs[j];
        if (!o.alive) continue;
        var dd = (o.x - p.x) * (o.x - p.x) + (o.z - p.z) * (o.z - p.z);
        if (dd < bd) { bd = dd; best = o; }
      }
    }
    var greed = 0.62 + 0.42 * (1 - skill);
    if (best && bd > 1.2) {
      var ox = best.x - p.x, oz = best.z - p.z;
      var ol = Math.hypot(ox, oz) || 1;
      ax = ox / ol * greed;
      az = oz / ol * greed;
    }

    /* 3) 场地边缘回拉（新手会撞边） */
    var cd = Math.hypot(p.x, p.z);
    var lim = XS.ARENA.playRadius;
    if (cd > lim * (0.72 + 0.16 * skill)) {
      ax -= p.x / cd * 1.6;
      az -= p.z / cd * 1.6;
    }

    var evade = 1.35 + 0.85 * skill;
    var vx = ax + rx * evade;
    var vz = az + rz * evade;

    /* 手抖：技能越低方向越飘 */
    var noiseAmp = (1 - skill) * 0.5;
    if (noiseAmp > 0.001) {
      vx += Math.cos(noise) * noiseAmp;
      vz += Math.sin(noise * 0.87) * noiseAmp;
    }

    var vl = Math.hypot(vx, vz);
    if (vl < 0.001) {
      angle += dt * 0.6;
      vx = Math.cos(angle); vz = Math.sin(angle);
      vl = 1;
    }
    var k = Math.min(1, vl);
    vxHeld = vx / vl * k;
    vzHeld = vz / vl * k;
    XS.Input.vec.x = vxHeld;
    XS.Input.vec.y = -vzHeld;
    XS.Input.active = true;
  };

})(window);
