/* ============================================================
 * UI 层：HUD / 升级面板 / 结算 / 飘字 / 播报
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var T = global.THREE;
  var U = XS.U;

  var UI = XS.UI = {};
  var $ = function (id) { return document.getElementById(id); };

  var el = {};

  /* ---------------- 伤害飘字池 ---------------- */
  var DMG_POOL = 26;
  var dmgNodes = [];
  var dmgActive = [];
  var _v3 = new T.Vector3();

  function makeDmgNode() {
    var d = document.createElement('div');
    d.className = 'dmgnum';
    d.style.display = 'none';
    el.dmgLayer.appendChild(d);
    return d;
  }

  UI.dmg = function (x, y, z, amount, kind) {
    /* 设置里关掉伤害数字后直接短路，省掉 DOM 投影与合成开销 */
    if (XS.Settings && !XS.Settings.dmgNumbers) return;
    var node = null, i;
    for (i = 0; i < dmgNodes.length; i++) {
      if (!dmgNodes[i].busy) { node = dmgNodes[i]; break; }
    }
    if (!node) {
      if (dmgNodes.length >= DMG_POOL) return;
      node = { dom: makeDmgNode(), busy: false };
      dmgNodes.push(node);
    }
    node.busy = true;
    node.life = 0.72;
    node.maxLife = 0.72;
    node.x = x + U.rand(-0.3, 0.3);
    node.y = y;
    node.z = z + U.rand(-0.3, 0.3);
    node.dom.textContent = kind === 'crit' ? (amount | 0) + '!' : (amount | 0);
    node.dom.className = 'dmgnum' + (kind ? ' ' + kind : '');
    node.dom.style.display = 'block';
    node.dom.style.opacity = '1';
  };

  UI.updateDamageNumbers = function (dt, camera) {
    var w = global.innerWidth, h = global.innerHeight;
    for (var i = 0; i < dmgNodes.length; i++) {
      var n = dmgNodes[i];
      if (!n.busy) continue;
      n.life -= dt;
      if (n.life <= 0) {
        n.busy = false;
        n.dom.style.display = 'none';
        continue;
      }
      var t = 1 - n.life / n.maxLife;
      _v3.set(n.x, n.y + t * 1.6, n.z);
      _v3.project(camera);
      if (_v3.z > 1) { n.dom.style.display = 'none'; continue; }
      var sx = (_v3.x * 0.5 + 0.5) * w;
      var sy = (-_v3.y * 0.5 + 0.5) * h;
      var sc = 1 + t * 0.35;
      n.dom.style.transform = 'translate(-50%,-50%) translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) scale(' + sc.toFixed(2) + ')';
      n.dom.style.opacity = String(Math.min(1, (1 - t) * 2.4));
    }
  };

  UI.clearDamageNumbers = function () {
    for (var i = 0; i < dmgNodes.length; i++) {
      dmgNodes[i].busy = false;
      dmgNodes[i].dom.style.display = 'none';
    }
  };

  /* ---------------- 初始化 ---------------- */
  UI.init = function () {
    el.hud = $('hud');
    el.hpFill = $('hpFill');
    el.hpText = $('hpText');
    el.xpFill = $('xpFill');
    el.lvText = $('lvText');
    el.timer = $('timer');
    el.killCount = $('killCount');
    el.skillBar = $('skillBar');
    el.bossBar = $('bossBar');
    el.bossFill = $('bossFill');
    el.bossName = $('bossName');
    el.announce = $('announce');
    el.dmgLayer = $('dmgLayer');
    el.startOverlay = $('startOverlay');
    el.levelOverlay = $('levelOverlay');
    el.cards = $('cards');
    el.overOverlay = $('overOverlay');
    el.winOverlay = $('winOverlay');
    el.pauseOverlay = $('pauseOverlay');
    el.settingsOverlay = $('settingsOverlay');
    el.bestText = $('bestText');
    el.waveHint = $('waveHint');
    el.tipLine = $('tipLine');
    el.bossWarning = $('bossWarning');
    el.reviveBtn = $('reviveBtn');
    el.reviveCount = $('reviveCount');
    el.metaOverlay = $('metaOverlay');
    el.metaBody = $('metaBody');
    el.metaCoins = $('metaCoins');
    el.startCoins = $('startCoins');
    el.achToast = $('achToast');

    /* 山门 Tab 与关闭按钮：只绑一次。
       内容区每次切换都重渲染，所以交互绑定放在 renderMetaTab 里。 */
    var tabs = el.metaOverlay.querySelectorAll('#metaTabs button');
    for (var i = 0; i < tabs.length; i++) {
      (function (b) {
        b.onclick = function () {
          if (XS.Audio) XS.Audio.play('ui', 0.6);
          UI.renderMetaTab(b.getAttribute('data-tab'));
        };
      })(tabs[i]);
    }
    $('metaClose').onclick = function () { UI.hideMeta(); };
    return UI;
  };

  /* ---------------- HUD ---------------- */
  UI.setHp = function (cur, max) {
    var r = Math.max(0, cur / max);
    el.hpFill.style.width = (r * 100).toFixed(1) + '%';
    el.hpFill.classList.toggle('low', r < 0.3);
    el.hpText.textContent = Math.max(0, Math.ceil(cur)) + ' / ' + Math.ceil(max);
  };

  UI.setXp = function (cur, need, level) {
    el.xpFill.style.width = Math.min(100, (cur / need) * 100).toFixed(1) + '%';
    el.lvText.textContent = '境界 ' + level;
  };

  UI.setTimer = function (t, total) {
    el.timer.textContent = U.fmtTime(Math.max(0, total - t));
  };

  UI.setKills = function (n) { el.killCount.textContent = n; };

  var skillEls = {};
  UI.setSkills = function (list) {
    /* list: [{id,name,icon,level,tag}] */
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      seen[s.id] = true;
      var node = skillEls[s.id];
      if (!node) {
        node = document.createElement('div');
        node.className = 'skill';
        node.innerHTML = '<span class="si"></span><span class="sl"></span>';
        el.skillBar.appendChild(node);
        skillEls[s.id] = node;
      }
      node.querySelector('.si').textContent = s.icon;
      node.querySelector('.sl').textContent = 'Lv' + s.level;
      node.style.borderColor = (XS.TAG_COLOR[s.tag] || '#4de8ff') + '66';
      node.style.color = XS.TAG_COLOR[s.tag] || '#4de8ff';
      /* 已进化的功法在技能栏里挂金边 + 星标：
         技能栏是玩家唯一能随时确认「我这局构筑走到哪一步」的地方，
         进化这种一次性大事必须留下永久痕迹。 */
      node.classList.toggle('ascended', !!s.evolved);
      node.classList.add('pop');
      setTimeout(function (nn) { return function () { nn.classList.remove('pop'); }; }(node), 260);
    }
    for (var id in skillEls) {
      if (!seen[id]) { el.skillBar.removeChild(skillEls[id]); delete skillEls[id]; }
    }
  };

  UI.resetSkills = function () {
    for (var id in skillEls) { if (el.skillBar.contains(skillEls[id])) el.skillBar.removeChild(skillEls[id]); }
    skillEls = {};
  };

  /* ---------------- Boss 血条 ---------------- */
  UI.showBoss = function (name, hp, max) {
    el.bossName.textContent = name;
    el.bossBar.classList.add('on');
    UI.updateBoss(hp, max);
  };
  UI.updateBoss = function (hp, max) {
    el.bossFill.style.width = Math.max(0, hp / max * 100).toFixed(1) + '%';
  };
  UI.hideBoss = function () { el.bossBar.classList.remove('on'); };

  /* ---------------- 播报 ---------------- */
  var annTimer = null;
  UI.announce = function (text, sub, color, ms) {
    el.announce.innerHTML = '<b style="color:' + (color || '#4de8ff') + '">' + text + '</b>' +
      (sub ? '<i>' + sub + '</i>' : '');
    el.announce.classList.add('on');
    if (annTimer) clearTimeout(annTimer);
    annTimer = setTimeout(function () { el.announce.classList.remove('on'); }, ms || 1800);
  };

  var warnTimer = null;
  UI.bossWarning = function (text) {
    el.bossWarning.textContent = text;
    el.bossWarning.classList.add('on');
    if (warnTimer) clearTimeout(warnTimer);
    warnTimer = setTimeout(function () { el.bossWarning.classList.remove('on'); }, 2600);
  };

  /* 教学提示：底部一行，只在对局中第一次遇到新机制时出现。
     小游戏没有教程关，第一次遇到「远程怪」或「冲锋怪」如果没人说，
     玩家只会觉得「莫名其妙掉血」。 */
  var tipTimer = null;
  UI.tip = function (text, ms) {
    if (!el.tipLine) return;
    el.tipLine.textContent = text;
    el.tipLine.classList.add('on');
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { el.tipLine.classList.remove('on'); }, ms || 4000);
  };

  UI.waveHint = function (text) {
    el.waveHint.textContent = text;
    el.waveHint.classList.add('on');
    setTimeout(function () { el.waveHint.classList.remove('on'); }, 2000);
  };

  /* ---------------- 遮罩显隐 ---------------- */
  UI.hideAll = function () {
    el.startOverlay.classList.remove('on');
    el.levelOverlay.classList.remove('on');
    el.overOverlay.classList.remove('on');
    el.winOverlay.classList.remove('on');
    el.pauseOverlay.classList.remove('on');
    el.metaOverlay.classList.remove('on');
  };

  UI.showStart = function (handlers) {
    UI.hideAll();
    el.startOverlay.classList.add('on');
    var best = XS.Platform.load('best', null);
    if (best && best.dur) {
      el.bestText.innerHTML = '历史最佳　存活 <b>' + U.fmtTime(best.dur) + '</b>　境界 <b>' + best.level +
        '</b>　斩妖 <b>' + best.kills + '</b>';
    } else {
      el.bestText.textContent = '尚无战绩，第一局就是记录';
    }
    /* 山门入口的摘要：灵石余额 + 已买的永久强化。
       没有这一行的话，「局外成长」对玩家是不存在的 ——
       他打完一局回到主界面，看到的还是和第一局一模一样的界面。 */
    if (el.startCoins) {
      var upSum = XS.Meta ? XS.Meta.summary() : [];
      el.startCoins.innerHTML =
        '<span class="cbCoin"><i>灵</i><b>' + XS.Meta.data.coins + '</b></span>' +
        '<span class="cbAch">成就 <b>' + XS.Meta.achCount() + '</b>/' + XS.ACHIEVEMENTS.length + '</span>' +
        '<span class="cbAch">图鉴 <b>' + XS.Meta.codexCount() + '</b>/' + XS.Meta.codexTotal() + '</span>' +
        (upSum.length ? '<span class="cbUp">' + upSum.join(' · ') + '</span>'
                      : '<span class="cbUp dim">尚无永久强化 —— 攒灵石去山门</span>');
    }
    var runs = XS.Telemetry.getRuns().length;
    $('startMeta').textContent = '本地已记录 ' + runs + ' 局对局数据 · 环境 ' + XS.Platform.env;
    $('startBtn').onclick = handlers.onStart;
    $('dataBtn').onclick = handlers.onData;
    $('metaBtn').onclick = function () { UI.showMeta('shop'); };
  };

  /* ============================================================
   * 山门：局外成长（灵石商店 / 成就 / 图鉴）
   *
   * 三块内容共用一个面板 + 一条 Tab，而不是三个独立弹窗。
   * 小游戏的「元界面」越少越好：玩家点「山门」时心里想的是
   * 「我要变强」，具体是买强化、看成就还是翻图鉴，
   * 应该由他当场决定，而不是在点按钮之前就决定。
   *
   * 整个 Tab 内容每次切换都**重新渲染**，不做局部更新 ——
   * 这里的数据量只有几十个节点，重渲染的成本远低于
   * 「某个状态忘了刷新」的调试成本。购买后直接整块重画。
   * ============================================================ */
  var metaTab = 'shop';

  function dotRow(lv, max) {
    var s = '';
    for (var i = 0; i < max; i++) s += '<i class="' + (i < lv ? 'on' : '') + '"></i>';
    return '<span class="lvDots">' + s + '</span>';
  }

  function renderShop() {
    var view = XS.Meta.shopView();
    var h = '';
    for (var i = 0; i < view.length; i++) {
      var r = view[i];
      var cls = 'buyBtn' + (r.maxed ? ' maxed' : (r.affordable ? '' : ' poor'));
      h += '<div class="shopRow" data-id="' + r.def.id + '">' +
        '<div class="sIcon" style="--c:' + (XS.TAG_COLOR[r.def.tag] || '#4de8ff') + '">' + r.def.icon + '</div>' +
        '<div class="sMain">' +
          '<div class="sTop"><span class="sName">' + r.def.name + '</span>' +
          '<span class="sLv">Lv ' + r.lv + ' / ' + r.def.max + '</span></div>' +
          '<div class="sDesc">' + r.effect + '</div>' +
          '<div class="sDetail">' + r.def.detail + '</div>' +
          dotRow(r.lv, r.def.max) +
        '</div>' +
        '<button class="' + cls + '">' + (r.maxed ? '圆满' : r.cost) + '</button>' +
        '</div>';
    }
    return '<div class="shopList">' + h + '</div>' +
      '<div class="metaNote">灵石来自每局结算（斩妖 / 妖将 / 魔尊）。' +
      '永久强化只抬高下限、不改对局规则 —— 功法的形态、波次、手感一局都不会变。</div>';
  }

  function renderAch() {
    var d = XS.Meta.data;
    var h = '';
    for (var i = 0; i < XS.ACHIEVEMENTS.length; i++) {
      var a = XS.ACHIEVEMENTS[i];
      var on = !!d.ach[a.id];
      h += '<div class="achCard tier-' + a.tier + (on ? ' on' : '') + '">' +
        '<div class="aTop">' +
          '<span class="aIcon">' + (on ? a.icon : '？') + '</span>' +
          '<span class="aName">' + a.name + '</span>' +
          '<span class="aState">' + (on ? '已达成' : '未达成') + '</span>' +
        '</div>' +
        '<div class="aDesc">' + a.desc + '</div>' +
        '</div>';
    }
    return '<div class="achHead">已达成 <b>' + XS.Meta.achCount() + '</b> / ' + XS.ACHIEVEMENTS.length +
      '<span class="achHint">成就奖励的是「玩得更狠」，不是「玩得更怪」</span></div>' +
      '<div class="achGrid">' + h + '</div>';
  }

  function cxCard(on, icon, name, body) {
    return '<div class="cxCard' + (on ? ' on' : '') + '">' +
      '<div class="cxTop"><span class="cxIcon">' + (on ? icon : '？') + '</span>' +
      '<span class="cxName">' + (on ? name : '未解锁') + '</span></div>' +
      (on ? body : '<div class="cxText dim">在仙台上遭遇 / 习得后解锁</div>') +
      '</div>';
  }

  function renderCodex() {
    var seen = XS.Meta.data.seen;
    var h = '', i, on, n;

    /* --- 妖魔 --- */
    var eh = ''; n = 0;
    for (i = 0; i < XS.CODEX_ENEMY_ORDER.length; i++) {
      var eid = XS.CODEX_ENEMY_ORDER[i];
      var ed = XS.ENEMY[eid];
      on = !!seen.enemy[eid];
      if (on) n++;
      eh += cxCard(on, XS.CODEX_ENEMY_ICON[eid] || '妖', ed.name,
        '<div class="cxStats">气血 ' + ed.hp + '　速度 ' + ed.speed.toFixed(2) + '　伤害 ' + ed.dmg + '</div>' +
        '<div class="cxText">' + (XS.CODEX_ENEMY_TEXT[eid] || '') + '</div>');
    }
    h += '<div class="cxLabel">妖 魔 <b>' + n + '</b> / ' + XS.CODEX_ENEMY_ORDER.length + '</div>' +
      '<div class="cxGrid wide">' + eh + '</div>';

    /* --- 功法 --- */
    var sh = ''; n = 0;
    for (i = 0; i < XS.UPGRADES.length; i++) {
      var sd = XS.UPGRADES[i];
      on = !!seen.skill[sd.id];
      if (on) n++;
      sh += cxCard(on, sd.icon, sd.name,
        '<div class="cxStats">' + sd.tag + '　上限 Lv' + sd.max + '</div>' +
        '<div class="cxText">' + sd.desc(0) + '</div>');
    }
    h += '<div class="cxLabel">功 法 <b>' + n + '</b> / ' + XS.UPGRADES.length + '</div>' +
      '<div class="cxGrid">' + sh + '</div>';

    /* --- 进化 --- */
    var vh = ''; n = 0;
    for (i = 0; i < XS.CODEX_EVO_ORDER.length; i++) {
      var from = XS.CODEX_EVO_ORDER[i];
      var ev = XS.EVOLUTION_BY_FROM[from];
      var base = XS.UPGRADE_MAP[from];
      if (!ev || !base) continue;
      on = !!seen.evo[from];
      if (on) n++;
      vh += cxCard(on, ev.icon, ev.name,
        '<div class="cxStats">' + base.name + ' → ' + ev.name + '　前置 ' + XS.evoReqText(ev) + '</div>' +
        '<div class="cxText">' + ev.desc + '</div>');
    }
    h += '<div class="cxLabel">功 法 进 化 <b>' + n + '</b> / ' + XS.CODEX_EVO_ORDER.length + '</div>' +
      '<div class="cxGrid wide">' + vh + '</div>';

    return h;
  }

  UI.renderMetaTab = function (tab) {
    metaTab = tab || metaTab;
    var tabs = el.metaOverlay.querySelectorAll('#metaTabs button');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === metaTab);
    }
    if (metaTab === 'ach') el.metaBody.innerHTML = renderAch();
    else if (metaTab === 'codex') el.metaBody.innerHTML = renderCodex();
    else el.metaBody.innerHTML = renderShop();
    /* 溢出才加底部渐隐（见 style.css 的 .metaBody.hasMore）——
       内容能放下时加，等于白白淡掉最后一行。 */
    el.metaBody.classList.toggle('hasMore',
      el.metaBody.scrollHeight > el.metaBody.clientHeight + 2);
    UI.refreshCoins();
    bindMetaBody();
  };

  UI.refreshCoins = function () {
    if (el.metaCoins) el.metaCoins.textContent = XS.Meta.data.coins;
  };

  function bindMetaBody() {
    var rows = el.metaBody.querySelectorAll('.shopRow');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var btn = row.querySelector('.buyBtn');
        if (!btn) return;
        btn.onclick = function () {
          var res = XS.Meta.buy(row.getAttribute('data-id'));
          if (res.ok) {
            if (XS.Audio) XS.Audio.play('levelup', 0.8);
            UI.renderMetaTab('shop');
          } else if (res.reason === 'poor') {
            if (XS.Audio) XS.Audio.play('ui', 0.5);
            UI.flashPoor(btn);
          }
        };
      })(rows[i]);
    }
  }

  /* 灵石不够时抖一下按钮。比弹一个「灵石不足」的提示更轻，
     也不会在连点几次时刷出一堆要关闭的弹窗。 */
  UI.flashPoor = function (btn) {
    btn.classList.remove('shake');
    /* 强制重排，否则连续点击时动画不会重播 */
    void btn.offsetWidth;
    btn.classList.add('shake');
    setTimeout(function () { btn.classList.remove('shake'); }, 420);
  };

  UI.showMeta = function (tab) {
    el.metaOverlay.classList.add('on');
    UI.renderMetaTab(tab || 'shop');
  };
  UI.hideMeta = function () { el.metaOverlay.classList.remove('on'); };

  /* ---------------- 成就解锁浮层 ----------------
     串行播放：一次通关可能同时解锁 3 个成就，
     三个浮层叠在一起会互相盖住，等于只显示了一个。 */
  var achQueue = [], achBusy = false;

  function pumpAch() {
    if (achBusy || !achQueue.length) return;
    achBusy = true;
    var a = achQueue.shift();
    var node = document.createElement('div');
    node.className = 'achToastItem tier-' + a.tier;
    node.innerHTML =
      '<div class="atIcon">' + a.icon + '</div>' +
      '<div class="atMain">' +
        '<div class="atLabel">成 就 达 成</div>' +
        '<div class="atName">' + a.name + '</div>' +
        '<div class="atDesc">' + a.desc + '</div>' +
      '</div>';
    el.achToast.appendChild(node);
    if (XS.Audio) XS.Audio.play('evolve', 0.85);
    setTimeout(function () { node.classList.add('out'); }, 2700);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
      achBusy = false;
      pumpAch();
    }, 3200);
  }

  UI.achievementToast = function (list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) achQueue.push(list[i]);
    pumpAch();
  };

  /* ---------------- 升级三选一 ---------------- */
  UI.showUpgrades = function (choices, level, onPick) {
    el.cards.innerHTML = '';
    var hasEvo = false;
    /* 当前正在追的进化目标。有了它，玩家在**做选择的那一刻**就能看见
       「这张牌是在推进我的目标」—— 否则进化条件对玩家是个隐藏规则，
       只有运气好凑齐的人才知道存在。 */
    var goal = (XS.Game && XS.Game.evoGoal) ? XS.Game.evoGoal() : null;
    for (var i = 0; i < choices.length; i++) {
      (function (c) {
        var card = document.createElement('div');
        var isEvo = !!c.evo;
        if (isEvo) hasEvo = true;
        card.className = 'card' + (isEvo ? ' evo' : '');
        /* data-id 让「自动试玩机器人」能按 id 精确选牌，
           而不是去匹配中文名 —— 后者一改文案就静默失效。 */
        card.dataset.id = c.id;
        var col = XS.TAG_COLOR[c.tag] || '#4de8ff';
        card.style.setProperty('--c', col);
        var nextLv = c.current + 1;
        var meta;
        if (isEvo) {
          /* 进化卡：不显示等级，改显示「由谁进化而来 + 前置」，
             让玩家一眼看出这是自己追了一整局的那张牌。 */
          var baseName = (XS.UPGRADE_MAP[c.evo.from] || {}).name || c.evo.from;
          meta = '功法进化　' + baseName + ' → ' + c.name;
        } else {
          meta = c.tag + '　Lv ' + (c.current > 0 ? c.current + ' → ' + nextLv : '新 · ' + nextLv);
        }
        var goalTag = '';
        if (goal && !isEvo && (c.id === goal.from || c.id === goal.reqId)) {
          var part = c.id === goal.from
            ? goal.baseLv + '/' + goal.baseMax
            : goal.reqLv + '/' + goal.reqNeed;
          goalTag = '<div class="goalTag">→ ' + goal.name + '　' + part + '</div>';
        }
        card.innerHTML =
          (isEvo ? '<div class="evoRibbon">进 化</div>' : '') +
          '<div class="cardTop">' +
          '  <div class="cIcon">' + c.icon + '</div>' +
          '  <div class="cMeta">' +
          '    <div class="cName">' + c.name + '</div>' +
          '    <div class="cTag" style="color:' + col + '">' + meta + '</div>' +
          '  </div>' +
          '</div>' +
          goalTag +
          '<div class="cDesc">' + c.desc + '</div>' +
          '<div class="cFoot">' +
          (isEvo
            ? '<span>功法进化</span><span>前置 ' + XS.evoReqText(c.evo) + '</span>'
            : '<span>' + (c.current > 0 ? '已习得 Lv' + c.current : '尚未习得') + '</span>' +
              '<span>上限 Lv' + c.max + '</span>') +
          '</div>';
        card.onclick = function () { onPick(c); };
        el.cards.appendChild(card);
      })(choices[i]);
    }
    $('levelTitle').textContent = '境界突破 · ' + level;
    if (hasEvo) {
      $('levelSub').textContent = '功法已臻圆满，可择其进化';
    } else if (goal) {
      $('levelSub').textContent = '进化目标：' + goal.name + '（' +
        goal.baseName + ' ' + goal.baseLv + '/' + goal.baseMax + '　' +
        goal.reqName + ' ' + goal.reqLv + '/' + goal.reqNeed + '）';
    } else {
      $('levelSub').textContent = '择一功法，继续斩妖';
    }
    el.levelOverlay.classList.add('on');
  };

  UI.hideUpgrades = function () { el.levelOverlay.classList.remove('on'); };

  /* ---------------- 结算 ---------------- */
  function statRows(stats) {
    /* 同步模拟下 `fpsAvg` 量的是「模拟器跑得多快」（实测 3600 fps），
       不是玩家的帧率。宁可显示「—」也不要把一个已知不可信的数字
       当成成绩摆出来 —— 看的人只会以为游戏坏了。
       判据用肯定式 `=== true`：字段缺失时按「不是同步模拟」处理，
       即维持原来的显示，不会把真实帧率吞掉。 */
    var fps = stats.syncSim === true ? '—' : (stats.fpsAvg + ' fps');
    return '' +
      '<div class="row"><span>存活时长</span><b>' + U.fmtTime(stats.dur) + '</b></div>' +
      '<div class="row"><span>修为境界</span><b>境界 ' + stats.level + '</b></div>' +
      '<div class="row"><span>斩妖数</span><b>' + stats.kills + '</b></div>' +
      '<div class="row"><span>造成伤害</span><b>' + stats.dmgDealt + '</b></div>' +
      '<div class="row"><span>承受伤害</span><b>' + stats.dmgTaken + '</b></div>' +
      '<div class="row"><span>平均帧率</span><b>' + fps + '</b></div>';
  }

  UI.showOver = function (stats, handlers) {
    el.overOverlay.classList.add('on');
    $('overStats').innerHTML = statRows(stats);
    $('overTitle').textContent = '道消身陨';
    $('overCause').textContent = '败因：' + (stats.causeText || '群妖围杀');

    /* 复活按钮要同时满足两件事：玩家还有次数，**且宿主真的能播广告**。
       判据用**肯定式** `=== true` 而不是 `!== false`：
       字段缺失 / 拼错 / 传错对象时，否定式会把它们当成「有能力」，
       于是一个点不动的按钮被静默画出来；肯定式则会**不画**，
       以「功能不见了」的形式立刻暴露 —— 这是两个方向里安全的那个。 */
    var canRevive = stats.reviveLeft > 0 && stats.adOk === true;
    el.reviveBtn.style.display = canRevive ? '' : 'none';
    el.reviveCount.textContent = canRevive ? ('剩余 ' + stats.reviveLeft + ' 次') : '';
    el.reviveBtn.onclick = handlers.onRevive;
    $('overRestart').onclick = handlers.onRestart;
    $('overHome').onclick = handlers.onHome;
  };

  UI.showWin = function (stats, handlers) {
    el.winOverlay.classList.add('on');
    $('winStats').innerHTML = statRows(stats);
    /* 同理：宿主播不了广告就不摆这个按钮（判据同样用肯定式） */
    var canDouble = !stats.doubleUsed && stats.adOk === true;
    $('winDouble').style.display = canDouble ? '' : 'none';
    $('winDouble').onclick = handlers.onDouble;
    $('winRestart').onclick = handlers.onRestart;
    $('winHome').onclick = handlers.onHome;
  };

  UI.showPause = function (onResume, onQuit, onSettings) {
    el.pauseOverlay.classList.add('on');
    $('pauseResume').onclick = onResume;
    $('pauseQuit').onclick = onQuit;
    $('pauseSettings').onclick = onSettings;
  };
  UI.hidePause = function () { el.pauseOverlay.classList.remove('on'); };

  /* ============================================================
   * 设置面板（DOM 后端）
   *
   * 设置对象本身在 js/settings.js —— 因为小游戏版要用 Canvas 面板
   * 驱动**同一份**设置。两个后端各写一份设置对象的话，
   * 「Web 上能开、小游戏上开了没用」只会在真机上被发现。
   * 这里只负责把这个对象接到 DOM 控件上。
   * ============================================================ */
  var Settings = XS.Settings;

  function markSeg(id, match) {
    var box = $(id);
    if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var key = b.getAttribute('data-q') || b.getAttribute('data-s') || b.getAttribute('data-d');
      btns[i].classList.toggle('on', String(key) === String(match));
    }
  }

  function bindSlider(inputId, labelId, key) {
    var inp = $(inputId), lab = $(labelId);
    if (!inp) return;
    inp.value = Math.round(Settings[key] * 100);
    if (lab) lab.textContent = inp.value;
    inp.oninput = function () {
      Settings[key] = inp.value / 100;
      if (lab) lab.textContent = inp.value;
      Settings.apply();
      Settings.save();
    };
  }

  function bindSeg(id, key, attr, coerce) {
    var box = $(id);
    if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () {
          Settings[key] = coerce(b.getAttribute(attr));
          markSeg(id, b.getAttribute(attr));
          Settings.apply();
          Settings.save();
          if (XS.Audio) XS.Audio.play('ui', 0.7);
        };
      })(btns[i]);
    }
  }

  UI.initSettings = function () {
    Settings.load();
    bindSlider('volMaster', 'volMasterV', 'master');
    bindSlider('volSfx', 'volSfxV', 'sfx');
    bindSlider('volMusic', 'volMusicV', 'music');
    bindSeg('qualitySeg', 'quality', 'data-q', function (v) { return v; });
    bindSeg('shakeSeg', 'shake', 'data-s', function (v) { return parseFloat(v); });
    bindSeg('dmgSeg', 'dmgNumbers', 'data-d', function (v) { return v === '1'; });
    bindSeg('cbSeg', 'colorblind', 'data-c', function (v) { return v === '1'; });
    bindSeg('bigSeg', 'bigText', 'data-b', function (v) { return v === '1'; });
    UI.syncSettingsUI();
    Settings.apply();
    return Settings;
  };

  UI.syncSettingsUI = function () {
    var m = $('volMaster'), sf = $('volSfx'), mu = $('volMusic');
    if (m) { m.value = Math.round(Settings.master * 100); $('volMasterV').textContent = m.value; }
    if (sf) { sf.value = Math.round(Settings.sfx * 100); $('volSfxV').textContent = sf.value; }
    if (mu) { mu.value = Math.round(Settings.music * 100); $('volMusicV').textContent = mu.value; }
    markSeg('qualitySeg', Settings.quality);
    markSeg('shakeSeg', Settings.shake);
    markSeg('dmgSeg', Settings.dmgNumbers ? 1 : 0);
    markSeg('cbSeg', Settings.colorblind ? 1 : 0);
    markSeg('bigSeg', Settings.bigText ? 1 : 0);
  };

  UI.showSettings = function () { el.settingsOverlay.classList.add('on'); UI.syncSettingsUI(); };
  UI.hideSettings = function () { el.settingsOverlay.classList.remove('on'); };

  /* 结算时更新历史最佳 */
  UI.saveBest = function (rec) {
    var best = XS.Platform.load('best', null);
    if (!best || rec.dur > best.dur) {
      XS.Platform.save('best', { dur: rec.dur, level: rec.level, kills: rec.kills });
      return true;
    }
    return false;
  };

})(window);
