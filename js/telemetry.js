/* ============================================================
 * 数据打点
 * 依赖：仅 XS.Platform（无 THREE 依赖，便于数据面板页单独加载）
 * ============================================================ */
(function (global) {
  'use strict';
  var XS = global.XS || (global.XS = {});
  var P = XS.Platform;

  var KEY = 'telemetry_runs_v1';
  var KEY_SESSION = 'telemetry_session_v1';
  var MAX_RUNS = 300;

  var Tele = XS.Telemetry = {};

  /* ---------- 对局列表内存缓存 ----------
   * 为什么必须缓存：Platform.load 每次都要 JSON.parse 整个数组。
   * 无人值守的批量跑局（?farm=K）会逐帧轮询对局数，
   * 若每帧都反序列化几百 KB，主线程会被直接锁死。
   * 因此这里只在首次读取时解析一次，之后全部走内存。 */
  var runsCache = null;
  function allRuns() {
    if (runsCache === null) {
      runsCache = P.load(KEY, []);
      if (!runsCache || !runsCache.length) runsCache = [];
    }
    return runsCache;
  }

  /* ---------- 会话 ---------- */
  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  var session = P.load('session', null);
  if (!session) {
    session = { id: makeId(), firstSeen: Date.now(), runs: 0, totalPlayMs: 0, days: [] };
  }
  var today = new Date().toISOString().slice(0, 10);
  if (session.days.indexOf(today) === -1) session.days.push(today);
  P.save('session', session);

  Tele.session = session;

  /* ---------- 当前对局 ---------- */
  var cur = null;

  Tele.startRun = function (meta) {
    cur = {
      id: makeId(),
      ts: Date.now(),
      runIndex: session.runs + 1,
      events: [],
      upgrades: {},
      adImpressions: 0,
      adCompleted: 0,
      adByPlacement: {},
      kills: 0,
      killsByType: {},
      dmgDealt: 0,
      dmgTaken: 0,
      hitCount: 0,
      nearDeath: 0,
      revives: 0,
      bossSpawns: 0,
      bossKills: 0,
      /* 本局进化了哪些功法。用来回答「进化系统到底有没有被玩到」——
         如果这个数组在所有对局里都是空的，说明触发条件定得太苛刻，
         那进化就只是个写了没用的系统。 */
      evolves: [],
      maxLevel: 1,
      xpCollected: 0,
      fpsSamples: [],
      milestones: {},
      cause: 'unknown',
      pos: { x: 0, z: 0 },
      seed: meta && meta.seed ? meta.seed : null
    };
    return cur;
  };

  Tele.isRunning = function () { return !!cur; };

  Tele.event = function (name, data) {
    if (!cur) return;
    if (cur.events.length > 400) return;   // 防爆
    cur.events.push({ n: name, t: +(data && data.t !== undefined ? data.t : 0).toFixed(2), d: data || {} });
  };

  /* 便捷打点 */
  Tele.upgradePick = function (t, id, level, offered) {
    if (!cur) return;
    cur.upgrades[id] = (cur.upgrades[id] || 0) + 1;
    Tele.event('upgrade_pick', { t: t, id: id, level: level, offered: offered });
  };

  Tele.evolve = function (t, id, from) {
    if (!cur) return;
    if (cur.evolves.indexOf(from) === -1) cur.evolves.push(from);
    Tele.event('evolve', { t: t, id: id, from: from });
  };

  Tele.kill = function (t, type, xp) {
    if (!cur) return;
    cur.kills++;
    cur.killsByType[type] = (cur.killsByType[type] || 0) + 1;
    if (cur.kills % 10 === 0) Tele.event('kill_milestone', { t: t, total: cur.kills });
  };

  Tele.damageDealt = function (amount) { if (cur) cur.dmgDealt += amount; };

  /* 境界 / 首领 / 其他整局统计（供漏斗与难度曲线分析） */
  Tele.levelUp = function (lv) {
    if (cur && lv > cur.maxLevel) cur.maxLevel = lv;
  };
  Tele.bossSpawn = function () { if (cur) cur.bossSpawns++; };
  Tele.bossKill = function () { if (cur) cur.bossKills++; };
  Tele.collectXp = function (amount) { if (cur) cur.xpCollected += amount; };
  Tele.setCause = function (c) { if (cur) cur.cause = c; };
  Tele.setPos = function (x, z) { if (cur) { cur.pos.x = x; cur.pos.z = z; } };
  Tele.nearDeath = function () { if (cur) cur.nearDeath++; };

  Tele.damageTaken = function (t, amount, source) {
    if (!cur) return;
    cur.dmgTaken += amount;
    cur.hitCount++;
    Tele.event('damage_taken', { t: t, amount: Math.round(amount), source: source });
  };

  Tele.milestone = function (t, kind) {
    if (!cur) return;
    if (cur.milestones[kind]) return;
    cur.milestones[kind] = t;
    Tele.event('milestone', { t: t, kind: kind });
  };

  Tele.adImpression = function (t, placement, trigger) {
    if (!cur) return;
    cur.adImpressions++;
    var k = placement.id;
    if (!cur.adByPlacement[k]) cur.adByPlacement[k] = { imp: 0, done: 0, trigger: trigger };
    cur.adByPlacement[k].imp++;
    Tele.event('ad_impression', { t: t, placement: k, trigger: trigger });
  };

  Tele.adResult = function (t, placement, completed) {
    if (!cur) return;
    var k = placement.id;
    if (completed) {
      cur.adCompleted++;
      if (cur.adByPlacement[k]) cur.adByPlacement[k].done++;
    }
    Tele.event('ad_result', { t: t, placement: k, completed: !!completed });
  };

  Tele.fps = function (avg, min) {
    if (cur) cur.fpsSamples.push([+avg.toFixed(2), +min.toFixed(2)]);
  };

  /* ---------- 结束对局 ---------- */
  Tele.endRun = function (result, extra) {
    if (!cur) return null;
    extra = extra || {};
    var dur = extra.duration || 0;

    var fpsAvg = 0, fpsMin = 999;
    if (cur.fpsSamples.length) {
      var s = 0;
      for (var i = 0; i < cur.fpsSamples.length; i++) {
        s += cur.fpsSamples[i][0];
        if (cur.fpsSamples[i][1] < fpsMin) fpsMin = cur.fpsSamples[i][1];
      }
      fpsAvg = s / cur.fpsSamples.length;
    }
    if (fpsMin === 999) fpsMin = 0;

    var rec = {
      id: cur.id,
      ts: cur.ts,
      day: new Date(cur.ts).toISOString().slice(0, 10),
      runIndex: cur.runIndex,
      dur: +dur.toFixed(1),
      result: result,                      // 'die' | 'win' | 'quit'
      level: cur.maxLevel,
      kills: cur.kills,
      killsByType: cur.killsByType,
      dmgDealt: Math.round(cur.dmgDealt),
      dmgTaken: Math.round(cur.dmgTaken),
      hitCount: cur.hitCount,
      revives: cur.revives,
      bossSpawns: cur.bossSpawns,
      bossKills: cur.bossKills,
      xpCollected: cur.xpCollected,
      upgrades: cur.upgrades,
      evolves: cur.evolves.slice(),
      adImpressions: cur.adImpressions,
      adCompleted: cur.adCompleted,
      adByPlacement: cur.adByPlacement,
      milestones: cur.milestones,
      cause: cur.cause,
      pos: { x: +cur.pos.x.toFixed(1), z: +cur.pos.z.toFixed(1) },
      fpsAvg: +fpsAvg.toFixed(1),
      fpsMin: fpsMin,
      syncSim: !!extra.syncSim,
      soulCoins: extra.soulCoins || 0,
      events: cur.events.slice(0, 120)
    };

    var runs = allRuns();
    runs.push(rec);
    if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
    P.save(KEY, runs);

    session.runs++;
    session.totalPlayMs += dur * 1000;
    P.save('session', session);

    cur = null;
    return rec;
  };

  /* ---------- 读取 ---------- */
  Tele.getRuns = function () { return allRuns(); };
  Tele.runCount = function () { return allRuns().length; };
  Tele.clear = function () { runsCache = []; P.save(KEY, []); };

  Tele.exportJSON = function () {
    return JSON.stringify({ session: session, runs: Tele.getRuns() }, null, 2);
  };

  /* ---------- 聚合统计（供数据面板） ---------- */
  Tele.summarize = function (runs) {
    runs = runs || Tele.getRuns();
    var n = runs.length;
    var out = {
      totalRuns: n,
      wins: 0, deaths: 0, quits: 0,
      winRate: 0,
      avgDur: 0, medianDur: 0,
      avgLevel: 0, avgKills: 0, avgDps: 0,
      avgAdImp: 0, avgAdDone: 0, adCompletionRate: 0,
      avgRevives: 0, reviveRate: 0,
      bossKillRate: 0,
      fpsAvg: 0, fpsMin: 999,
      durHistogram: [],
      deathTimeHistogram: [],
      levelFunnel: [],
      upgradePref: [],
      adByPlacement: [],
      deathCause: [],
      evolvePref: [],
      evolveRate: 0,
      avgEvolves: 0,
      days: {}
    };
    if (!n) return out;

    var durs = [], sDur = 0, sLv = 0, sKill = 0, sAdImp = 0, sAdDone = 0, sRev = 0;
    var sFps = 0, fpsN = 0, bossSpawn = 0, bossKill = 0;
    var evoCount = {}, evoRuns = 0, sEvo = 0;
    var deathBuckets = new Array(17).fill(0);   // 每 30 秒一桶，0-480+
    var durBuckets = new Array(17).fill(0);
    var upgCount = {};
    var adMap = {};
    var causeMap = {};
    var levelMarks = [1, 3, 5, 8, 10, 13, 16, 20, 25, 30];
    var levelReach = levelMarks.map(function () { return 0; });

    for (var i = 0; i < n; i++) {
      var r = runs[i];
      durs.push(r.dur);
      sDur += r.dur;
      sLv += r.level;
      sKill += r.kills;
      sAdImp += r.adImpressions || 0;
      sAdDone += r.adCompleted || 0;
      sRev += r.revives || 0;
      bossSpawn += r.bossSpawns || 0;
      bossKill += r.bossKills || 0;
      if (r.fpsAvg) { sFps += r.fpsAvg; fpsN++; }
      if (r.fpsMin && r.fpsMin < out.fpsMin) out.fpsMin = r.fpsMin;

      if (r.result === 'win') out.wins++;
      else if (r.result === 'die') out.deaths++;
      else out.quits++;

      var db = Math.min(16, Math.floor(r.dur / 30));
      durBuckets[db]++;
      if (r.result === 'die') deathBuckets[db]++;

      for (var k in r.upgrades) if (r.upgrades.hasOwnProperty(k)) {
        upgCount[k] = (upgCount[k] || 0) + r.upgrades[k];
      }
      for (var p in (r.adByPlacement || {})) if (r.adByPlacement.hasOwnProperty(p)) {
        if (!adMap[p]) adMap[p] = { imp: 0, done: 0 };
        adMap[p].imp += r.adByPlacement[p].imp;
        adMap[p].done += r.adByPlacement[p].done;
      }
      if (r.result === 'die') {
        var c = r.cause || 'unknown';
        causeMap[c] = (causeMap[c] || 0) + 1;
      }
      for (var m = 0; m < levelMarks.length; m++) {
        if (r.level >= levelMarks[m]) levelReach[m]++;
      }
      /* 进化覆盖率：有多少比例的对局真的进化出了东西。
         这个数如果接近 0，说明触发条件设计得没人能碰到。 */
      var evs = r.evolves || [];
      if (evs.length) evoRuns++;
      sEvo += evs.length;
      for (var ei = 0; ei < evs.length; ei++) evoCount[evs[ei]] = (evoCount[evs[ei]] || 0) + 1;
      out.days[r.day] = (out.days[r.day] || 0) + 1;
    }

    durs.sort(function (a, b) { return a - b; });
    out.avgDur = +(sDur / n).toFixed(1);
    out.medianDur = +durs[Math.floor(n / 2)].toFixed(1);
    out.avgLevel = +(sLv / n).toFixed(1);
    out.avgKills = +(sKill / n).toFixed(1);
    out.avgDps = out.avgDur > 0 ? +((runs.reduce(function (a, r) { return a + r.dmgDealt; }, 0)) / sDur).toFixed(1) : 0;
    out.avgAdImp = +(sAdImp / n).toFixed(2);
    out.avgAdDone = +(sAdDone / n).toFixed(2);
    out.adCompletionRate = sAdImp ? +(sAdDone / sAdImp * 100).toFixed(1) : 0;
    out.avgRevives = +(sRev / n).toFixed(2);
    out.reviveRate = +(runs.filter(function (r) { return (r.revives || 0) > 0; }).length / n * 100).toFixed(1);
    out.bossKillRate = bossSpawn ? +(bossKill / bossSpawn * 100).toFixed(1) : 0;
    out.fpsAvg = fpsN ? +(sFps / fpsN).toFixed(1) : 0;
    if (out.fpsMin === 999) out.fpsMin = 0;
    out.winRate = +(out.wins / n * 100).toFixed(1);
    out.durHistogram = durBuckets;
    out.deathTimeHistogram = deathBuckets;
    out.levelFunnel = levelMarks.map(function (lv, idx) {
      return { level: lv, count: levelReach[idx], rate: +(levelReach[idx] / n * 100).toFixed(1) };
    });
    out.upgradePref = Object.keys(upgCount).map(function (id) {
      return { id: id, count: upgCount[id], rate: +(upgCount[id] / n * 100).toFixed(1) };
    }).sort(function (a, b) { return b.count - a.count; });
    out.adByPlacement = Object.keys(adMap).map(function (k) {
      return { id: k, imp: adMap[k].imp, done: adMap[k].done, rate: adMap[k].imp ? +(adMap[k].done / adMap[k].imp * 100).toFixed(1) : 0 };
    }).sort(function (a, b) { return b.imp - a.imp; });
    out.deathCause = Object.keys(causeMap).map(function (k) {
      return { cause: k, count: causeMap[k], rate: +(causeMap[k] / Math.max(1, out.deaths) * 100).toFixed(1) };
    }).sort(function (a, b) { return b.count - a.count; });
    out.evolvePref = Object.keys(evoCount).map(function (k) {
      return { from: k, count: evoCount[k], rate: +(evoCount[k] / n * 100).toFixed(1) };
    }).sort(function (a, b) { return b.count - a.count; });
    out.evolveRate = +(evoRuns / n * 100).toFixed(1);
    out.avgEvolves = +(sEvo / n).toFixed(2);

    return out;
  };

})(window);
