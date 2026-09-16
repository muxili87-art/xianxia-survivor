/* ============================================================
 * 数据面板：读取本地对局数据并渲染
 * 数据源优先级：真实对局（localStorage） > 机器人试玩样本（data/seed-data.js）
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS;
  var $ = function (id) { return document.getElementById(id); };

  var UPGRADE_NAME = {};
  (XS.UPGRADES || []).forEach(function (u) { UPGRADE_NAME[u.id] = u.name; });

  var CAUSE_NAME = {
    boss: '魔尊碾压', elite: '妖将斩杀', swarm: '群妖围杀',
    quit: '主动退出', unknown: '未知'
  };

  var AD_NAME = {
    revive: '复活（死亡结算页）',
    doubleXp: '收益翻倍（结算页）',
    boost: '神行符（局内 HUD）'
  };

  /* ---------------- 取数 ---------------- */
  function loadRuns() {
    var real = [];
    try { real = XS.Telemetry.getRuns() || []; } catch (e) { real = []; }
    var seed = (global.__XS_SEED && global.__XS_SEED.runs) || [];
    if (real.length) {
      return { runs: real, source: 'real', seedCount: seed.length };
    }
    return { runs: seed, source: 'seed', seedCount: seed.length };
  }

  /* ---------------- 通用渲染 ---------------- */
  function kpi(label, value, unit, sub, accent) {
    var d = document.createElement('div');
    d.className = 'kpi';
    if (accent) d.style.setProperty('--accent', accent);
    d.innerHTML = '<div class="k">' + label + '</div>' +
      '<div class="v">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</div>' +
      (sub ? '<div class="s">' + sub + '</div>' : '');
    return d;
  }

  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* 柱状图 */
  function barChart(el, values, opts) {
    opts = opts || {};
    el.innerHTML = '';
    var max = Math.max.apply(null, values.concat([1]));
    var labels = opts.labels || [];
    for (var i = 0; i < values.length; i++) {
      var col = document.createElement('div');
      col.className = 'col';
      var bar = document.createElement('div');
      bar.className = 'bar' + (opts.hot && opts.hot(i) ? ' hot' : (opts.gold && opts.gold(i) ? ' gold' : ''));
      bar.style.height = (values[i] / max * 100) + '%';
      col.appendChild(bar);
      if (values[i] > 0) {
        var v = document.createElement('span');
        v.className = 'val';
        v.textContent = values[i];
        col.appendChild(v);
      }
      if (labels[i]) {
        var l = document.createElement('span');
        l.className = 'lab';
        l.textContent = labels[i];
        col.appendChild(l);
      }
      el.appendChild(col);
    }
    (opts.marks || []).forEach(function (m) {
      var mk = document.createElement('div');
      mk.className = 'bossMark';
      mk.style.left = ((m.idx + 0.5) / values.length * 100) + '%';
      mk.setAttribute('data-l', m.label);
      el.appendChild(mk);
    });
  }

  /* 漏斗 */
  function funnel(el, items) {
    el.innerHTML = '';
    var max = Math.max.apply(null, items.map(function (x) { return x.count; }).concat([1]));
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'fn';
      row.innerHTML = '<div class="fl">境界 ' + it.level + '</div>' +
        '<div class="ft"><div class="ff" style="width:' + (it.count / max * 100).toFixed(1) + '%"></div></div>' +
        '<div class="fv">' + it.rate + '%</div>';
      el.appendChild(row);
    });
  }

  /* 条形排行 */
  function bars(el, items, colorFn, labelFn) {
    el.innerHTML = '';
    if (!items.length) {
      el.innerHTML = '<div class="hint">暂无数据</div>';
      return;
    }
    var max = Math.max.apply(null, items.map(function (x) { return x.count; }).concat([1]));
    items.slice(0, 10).forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'br';
      var c = colorFn ? colorFn(it) : 'linear-gradient(90deg, rgba(77,232,255,0.9), rgba(77,232,255,0.35))';
      row.innerHTML = '<div class="bl">' + (labelFn ? labelFn(it) : it.id) + '</div>' +
        '<div class="bt"><div class="bf" style="width:' + (it.count / max * 100).toFixed(1) + '%;background:' + c + '"></div></div>' +
        '<div class="bv"><b>' + it.count + '</b> 次</div>';
      el.appendChild(row);
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render(data) {
    var runs = data.runs;
    if (!runs.length) {
      $('emptyState').hidden = false;
      $('dash').hidden = true;
      $('srcLine').textContent = '数据源：无';
      return;
    }
    $('emptyState').hidden = true;
    $('dash').hidden = false;

    var s = XS.Telemetry.summarize(runs);
    var isBot = data.source === 'seed' || runs.some(function (r) { return r.bot; });

    $('srcLine').innerHTML = '数据源：' +
      (data.source === 'real'
        ? '<b style="color:#4de8ff">本机真实对局 ' + runs.length + ' 局</b>'
        : '<b style="color:#a97bff">机器人试玩样本 ' + runs.length + ' 局</b>') +
      '　·　生成于 ' + new Date().toLocaleString('zh-CN') +
      (isBot ? '　·　<span class="tag bot">BOT</span> 用于演示面板能力，真实数据请直接在游戏里玩' : '');

    /* ---- KPI ---- */
    var k = $('kpis');
    k.innerHTML = '';
    k.appendChild(kpi('总局数', runs.length, ' 局', '样本量', '#4de8ff'));
    k.appendChild(kpi('通关率', s.winRate, '%', s.wins + ' 胜 / ' + s.deaths + ' 败', '#ffcf6b'));
    k.appendChild(kpi('平均单局时长', fmtDur(s.avgDur), '', '中位 ' + fmtDur(s.medianDur), '#4de8ff'));
    k.appendChild(kpi('平均境界', s.avgLevel, ' 重', '最高 ' + Math.max.apply(null, runs.map(function (r) { return r.level; })), '#a97bff'));
    k.appendChild(kpi('平均斩妖', s.avgKills, ' 只', '单局均值', '#ff5a4d'));
    k.appendChild(kpi('广告完成率', s.adCompletionRate, '%', '人均曝光 ' + s.avgAdImp + ' 次', '#ffcf6b'));
    k.appendChild(kpi('复活使用率', s.reviveRate, '%', '人均 ' + s.avgRevives + ' 次', '#7dffa8'));
    k.appendChild(kpi('Boss 击杀率', s.bossKillRate, '%', 'Boss 击杀 / 出场', '#a97bff'));
    k.appendChild(kpi('进化达成率', s.evolveRate || 0, '%',
      '人均 ' + (s.avgEvolves || 0) + ' 个进化', '#ffd76a'));
    var allSync = (s.totalRuns > 0) && (s.fpsAvg === 0);
    if (allSync) {
      k.appendChild(kpi('平均帧率', '—', '', '机器人试玩走同步模拟，不产生真实帧率', '#8fb3c7'));
    } else {
      k.appendChild(kpi('平均帧率', s.fpsAvg, ' fps', '最低 ' + s.fpsMin + ' fps', '#4de8ff'));
    }

    /* ---- 时长分布 ---- */
    var durLabels = [];
    for (var i = 0; i < s.durHistogram.length; i++) {
      durLabels.push(i === s.durHistogram.length - 1 ? '8:00+' : (i * 30) + 's');
    }
    $('durTotal').textContent = runs.length;
    barChart($('durChart'), s.durHistogram, {
      labels: durLabels,
      gold: function (idx) { return idx >= 15; }
    });
    $('durNote').textContent =
      '平均 ' + fmtDur(s.avgDur) + '　中位 ' + fmtDur(s.medianDur) +
      '　最长 ' + fmtDur(Math.max.apply(null, runs.map(function (r) { return r.dur; }))) +
      '　·　长尾越厚说明「再来一局」的动力越足；若大量集中在 1 分钟以内，说明开局太劝退。';

    /* ---- 失败时间点 ---- */
    barChart($('deathChart'), s.deathTimeHistogram, {
      labels: durLabels,
      hot: function () { return true; },
      marks: [
        { idx: 5, label: 'Boss1 150s' },
        { idx: 10, label: 'Boss2 300s' },
        { idx: 14, label: 'Boss3 420s' }
      ]
    });

    /* ---- 境界漏斗 ---- */
    funnel($('levelFunnel'), s.levelFunnel);

    /* ---- 败因 ---- */
    bars($('causeBars'), s.deathCause.map(function (c) {
      return { id: c.cause, count: c.count, rate: c.rate, label: CAUSE_NAME[c.cause] || c.cause };
    }), function () { return 'linear-gradient(90deg, rgba(255,90,77,0.9), rgba(255,90,77,0.3))'; },
      function (it) { return it.label; });

    /* ---- 功法偏好 ---- */
    var tagColor = XS.TAG_COLOR || {};
    bars($('upgradeBars'), s.upgradePref.map(function (u) {
      var def = XS.UPGRADE_MAP[u.id];
      return { id: u.id, count: u.count, rate: u.rate, name: UPGRADE_NAME[u.id] || u.id, tag: def ? def.tag : '' };
    }), function (it) {
      var c = tagColor[it.tag] || '#4de8ff';
      return 'linear-gradient(90deg, ' + c + 'ee, ' + c + '44)';
    }, function (it) { return it.name; });

    /* ---- 功法进化达成 ----
     * 这张图是「进化系统有没有被玩到」的唯一客观证据。
     * 全是空的就说明触发条件太苛刻 —— 那不是玩家的问题，是设计的问题。 */
    var evoBars = $('evolveBars');
    if (evoBars) {
      var evoList = (s.evolvePref || []).map(function (e) {
        var def = XS.EVOLUTION_BY_FROM ? XS.EVOLUTION_BY_FROM[e.from] : null;
        return {
          id: e.from, count: e.count, rate: e.rate,
          name: def ? def.name : e.from
        };
      });
      bars(evoBars, evoList, function () {
        return 'linear-gradient(90deg, rgba(255,215,106,0.92), rgba(255,196,64,0.30))';
      }, function (it) { return it.name; });
      var note = $('evolveNote');
      if (note) {
        note.textContent = evoList.length
          ? ('本样本中 ' + (s.evolveRate || 0) + '% 的对局至少达成一次进化，人均 ' +
             (s.avgEvolves || 0) + ' 个。达成率过高的进化说明前置太松，可以考虑加条件。')
          : '样本里还没有任何一局达成进化。检查：基础功法满级门槛是否过高、前置功法是否值得为它让步。';
      }
    }

    /* ---- 广告点位 ---- */
    var ad = $('adTable');    ad.innerHTML = '<thead><tr><th>点位</th><th>触发场景</th><th>曝光</th><th>完成</th><th>完成率</th><th>人均曝光</th></tr></thead><tbody>' +
      (s.adByPlacement.length ? s.adByPlacement.map(function (p) {
        return '<tr><td>' + (AD_NAME[p.id] || p.id) + '</td>' +
          '<td style="text-align:right;color:#8fb3c7">' +
          (p.id === 'revive' ? '死亡时' : p.id === 'doubleXp' ? '结算页' : '局内 90 秒后') + '</td>' +
          '<td class="num">' + p.imp + '</td>' +
          '<td class="num">' + p.done + '</td>' +
          '<td class="num" style="color:#ffcf6b">' + p.rate + '%</td>' +
          '<td class="num">' + (p.imp / runs.length).toFixed(2) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" style="color:#8fb3c7;text-align:center">暂无广告曝光</td></tr>') +
      '</tbody>';

    /* ---- 单局明细 ---- */
    var list = runs.slice(-30).reverse();
    var t = $('runsTable');
    t.innerHTML = '<thead><tr>' +
      '<th>#</th><th>结果</th><th>时长</th><th>境界</th><th>斩妖</th>' +
      '<th>造成伤害</th><th>承受伤害</th><th>复活</th><th>广告</th><th>帧率</th><th>败因</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r) {
        var cls = r.result === 'win' ? 'win' : (r.result === 'die' ? 'die' : 'quit');
        var txt = r.result === 'win' ? '通关' : (r.result === 'die' ? '阵亡' : '退出');
        return '<tr>' +
          '<td class="num">' + r.runIndex + '</td>' +
          '<td><span class="tag ' + cls + '">' + txt + '</span></td>' +
          '<td class="num">' + fmtDur(r.dur) + '</td>' +
          '<td class="num">' + r.level + '</td>' +
          '<td class="num">' + r.kills + '</td>' +
          '<td class="num">' + r.dmgDealt + '</td>' +
          '<td class="num">' + r.dmgTaken + '</td>' +
          '<td class="num">' + (r.revives || 0) + '</td>' +
          '<td class="num">' + (r.adImpressions || 0) + '/' + (r.adCompleted || 0) + '</td>' +
          '<td class="num">' + (r.syncSim ? '模拟' : (r.fpsAvg || '-')) + '</td>' +
          '<td style="text-align:right;color:#8fb3c7">' + (CAUSE_NAME[r.cause] || r.cause) + '</td>' +
          '</tr>';
      }).join('') + '</tbody>';
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function bindActions() {
    $('btnExport').onclick = function () {
      var payload = {
        exportedAt: new Date().toISOString(),
        session: XS.Telemetry.session,
        runs: XS.Telemetry.getRuns()
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'xiantai-telemetry-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    };

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.onchange = function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var obj = JSON.parse(fr.result);
          var runs = obj.runs || obj;
          if (!Array.isArray(runs)) throw new Error('格式不正确');
          XS.Platform.save('telemetry_runs_v1', runs);
          render({ runs: runs, source: 'real' });
        } catch (e) {
          alert('导入失败：' + e.message);
        }
      };
      fr.readAsText(f);
      file.value = '';
    };
    $('btnImport').onclick = function () { file.click(); };

    $('btnClear').onclick = function () {
      if (!confirm('确定清空本机记录的全部对局数据？此操作不可撤销。')) return;
      XS.Telemetry.clear();
      render(loadRuns());
    };
  }

  function init() {
    bindActions();
    render(loadRuns());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
