#!/usr/bin/env node
/* ============================================================
 * 两条静态检查。都是「只在运行到那一刻才炸」的那类问题的第一道网。
 *
 * 规则 A：赋值给一个从没声明过的名字。
 *   这一整类 bug 在 'use strict' 下**读**就会抛 ReferenceError，
 *   但**只在那一行真的执行到时才抛**。于是它表现得像
 *   「某个功能偶尔把游戏弄崩」，而不是「有个变量没声明」。
 *
 *   真实案例（js/audio.js 的 enabled）：
 *     Audio.unlock() 成功 → ready = true
 *     → 下一个 Sfx.play() 走到 if (!ready || !enabled)
 *     → 抛 ReferenceError → 从 updateSwords 冒到主循环
 *     → **游戏在玩家第一次触摸之后第一次挥剑时就断掉**。
 *   而两个走查都抓不到：Web 侧机器人从不点击（unlock 没被调用），
 *   小游戏侧那个假 window 上没有 AudioContext（init 直接失败）。
 *   两条路各自因为**不同**的原因短路掉了。
 *
 *   `node --check` 只查语法，查不出这个；运行期只有走到才报。
 *
 * （曾计划再加一条「模板字符串里的杂散反引号」规则，最后**没做** ——
 *   理由见文件末尾，那是一个「检查本身会喊狼来了」的例子。）
 *
 * 用法: node tools/lint-static.mjs [目录，默认 js]
 * 退出码: 0 = 干净，1 = 有可疑项（需人工确认，可能有误报）
 *
 * 注意规则 A 是**启发式**的：它不认识作用域链，也可能漏掉
 * 「声明在一个文件、赋值在另一个文件」的情况。
 * 它的价值在于把「23 个候选」缩到「人工看几个」，而不是替代判断。
 * ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境/标准库里本来就有的名字，不算「未声明」 */
const ALLOW = new Set([
  'XS', 'window', 'document', 'global', 'module', 'exports', 'THREE', 'console',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'Promise', 'Set', 'Map', 'WeakMap', 'NaN', 'Infinity', 'undefined',
  'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'location', 'navigator', 'screen', 'self', 'GameGlobal', 'globalThis',
  'wx', 'tt', '__SIM__', '__AUDIO_REC__'
]);

/* 注释与字符串必须先去掉：否则注释里的一句 `foo = 1` 会被当成代码，
   反过来字符串里的内容也会。模板串直接压成空串，宁可漏报不可误报。 */
function strip(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function declared(s) {
  const d = new Set();
  let m;
  /* 声明语句要整段取到分号：`var a = 1, b = 2;` 里 b 也得算上。
     第一版写成 [^;=\n]+ 就停在了第一个等号，于是 b 被误报成未声明 ——
     扫描器自己犯了这个项目反复在犯的「同一件事只处理了一半」。 */
  const rv = /\b(?:var|let|const)\s+([^;]+)/g;
  while ((m = rv.exec(s))) {
    m[1].split(',').forEach(p => {
      const n = p.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) d.add(n[1]);
    });
  }
  const rf = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = rf.exec(s))) d.add(m[1]);
  /* 形参 */
  const rp = /\(([^)]*)\)\s*\{/g;
  while ((m = rp.exec(s))) {
    m[1].split(',').forEach(p => {
      const n = p.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) d.add(n[1]);
    });
  }
  return d;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(vendor|dist|docs|data|node_modules)$/.test(e.name)) walk(p, out);
    } else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const target = join(ROOT, process.argv[2] || 'js');
let bad = 0;

/* ---------- 规则 A：未声明的赋值 ---------- */
for (const f of walk(target)) {
  const s = strip(readFileSync(f, 'utf8'));
  const d = declared(s);
  const hits = [];
  const re = /(^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = m[2];
    if (!ALLOW.has(n) && !d.has(n)) hits.push(n);
  }
  const uniq = [...new Set(hits)];
  if (uniq.length) {
    console.log('[未声明] ' + f.replace(ROOT + '/', '') + '  → ' + uniq.join(', '));
    bad += uniq.length;
  }
}

/* ---------- 规则 B：计数字段「只写一次、从不累加」 ----------
 *
 * 真实案例（js/telemetry.js 的 revives）：
 *   字段在 startRun 的对象字面量里初始化成 0，
 *   然后被 4 处读（其中一处是成就判定），
 *   **全项目没有任何一处给它加过 1**。
 *
 * 后果比「少个统计」重得多：
 *   - 成就「一气呵成 · 不复活通关」判的是
 *     `c.win && (c.rec.revives || 0) === 0` —— 恒真。
 *     复活两次再通关照样拿「不复活通关」。
 *     **不是解锁不了，是白送**；白送没人会报 bug。
 *   - 数据面板「复活使用率」永远 0%。
 *
 * 为什么单独立一条：这类 bug 的破绽是**读写不对称** ——
 * 写只有出生那一次，读到处都是。而「读」看起来完全正常，
 * 代码评审时眼睛会跟着读的路径走，永远走不到「谁写它」。
 * 它产出的还是一个**像样的值**（0），不是 undefined、不是 NaN。
 *
 * 判据分两级，缺一不可：
 *   ① 有没有**累加代码**（`cur.n++` / `+=` / `=`）；
 *   ② 如果有，那些累加代码**在不在一个从没被调用过的函数里**。
 *
 * 第 ② 级是写完第 ① 级做反向对照时才补上的：
 *   把调用点注释掉，规则**一声不吭** —— 因为 `Tele.revive` 的
 *   **函数体**里有 `cur.revives++`，第 ① 级把它当成了「有人加」。
 *   而「有代码能加」和「真的加了」是两件事。
 *   （这正是本项目反复栽的那个坑：检查本身是安慰剂。）
 *
 * 范围刻意收窄到 js/telemetry.js 的 `cur` 记录 ——
 * 那个对象的每一个数字字段按定义都是「本局累加量」，
 * 所以「初始化后从未被累加」在那里一定是 bug。
 * 不做全项目的通用版本：配置表里 `hp: 0` 这类常量本来就只读，
 * 通用版会天天误报，而**爱误报的检查比没有检查更糟**（见文件末尾）。
 */
{
  const telePath = join(ROOT, 'js/telemetry.js');
  let tele = '';
  try { tele = strip(readFileSync(telePath, 'utf8')); } catch (e) { tele = ''; }

  const block = tele.match(/cur\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (block) {
    const zeros = [];
    const re = /^\s*([A-Za-z_$][\w$]*)\s*:\s*0\s*,?\s*$/gm;
    let m;
    while ((m = re.exec(block[1]))) zeros.push(m[1]);

    /* 把 telemetry.js 按 `Tele.X = function` 切成一个个函数体 */
    const marks = [];
    const rf = /Tele\.([A-Za-z_$][\w$]*)\s*=\s*function/g;
    while ((m = rf.exec(tele))) marks.push({ name: m[1], at: m.index });
    const bodies = marks.map((mk, i) => ({
      name: mk.name,
      body: tele.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : tele.length)
    }));

    /* 除 telemetry.js 之外的调用现场 */
    let callers = '';
    for (const f of walk(join(ROOT, 'js'))) {
      if (f === telePath) continue;
      callers += strip(readFileSync(f, 'utf8')) + '\n';
    }

    const incOf = n => new RegExp('cur\\.' + n + '\\s*(?:\\+\\+|--|\\+=|-=|=)(?!=)');
    const dead = [];
    for (const n of zeros) {
      const inc = incOf(n);
      /* ① 全项目（含 telemetry.js）有没有累加代码 */
      const setterNames = bodies.filter(b => inc.test(b.body)).map(b => b.name);
      const directOutside = inc.test(callers);
      if (!setterNames.length && !directOutside) {
        dead.push(n + '（从未被累加）');
        continue;
      }
      /* ② 累加只写在 setter 里 —— 那就必须有别处在调这个 setter */
      if (!directOutside && setterNames.length) {
        const called = setterNames.some(sn =>
          new RegExp('Tele\\.' + sn + '\\s*\\(').test(callers) ||
          new RegExp('Telemetry\\.' + sn + '\\s*\\(').test(callers));
        if (!called) {
          dead.push(n + '（只有 ' + setterNames.map(s => 'Tele.' + s + '()').join('/')
            + ' 会加它，而这个函数从来没有被调用过）');
        }
      }
    }
    if (dead.length) {
      console.log('[计数未累加] js/telemetry.js 的对局记录字段恒为初始值：');
      dead.forEach(d => console.log('  - ' + d));
      console.log('  这些字段一定是有人在读（否则不会存在），读它的人拿到的是恒定的 0。');
      console.log('  成就判定里出现这种字段 = 成就恒真或恒假，而两者都不会有人报 bug。');
      bad += dead.length;
    }
  }
}

/* ---------- 规则 C 想过，没做 ----------
 *
 * 本来还想加一条「模板字符串里的杂散反引号」检查，因为
 * tools/minigame-sim.mjs 是用模板拼 HTML 页面的，注释里一个反引号
 * 就会把模板截断，报出来的是指不到真正原因的错误（一个会话踩了三次）。
 *
 * **写出来之后发现它在喊狼来了**：它会把 build-minigame.mjs 里
 * 合法的多模板、甚至它自己的源码都报成可疑 —— 因为「偶数个反引号」
 * 既可能是「一对模板」，也可能是「两对」，纯文本层面分不开。
 *
 * 一个爱误报的检查比没有检查更糟：人看两次假警报之后就再也不看它了。
 * 而这个坑**本身是响的**（node 直接拒绝执行，构建会失败），
 * 只是错误信息指错地方。所以正确的做法是把「为什么会指错」写进
 * minigame-sim.mjs 的注释里，而不是造一个会误报的规则。
 * 同理见 verify-mg.sh 的 SKIP 分级：**报得准**比报得多重要。 */

if (bad) {
  console.log('\n合计 ' + bad + ' 处可疑（启发式扫描，可能有误报）。');
  console.log('确认是误报就在 ALLOW 里补上，是真漏声明就补 var ——');
  console.log('漏声明在严格模式下会抛 ReferenceError，而且只在那一行执行到时才抛。');
  process.exit(1);
}
console.log('静态检查通过：没有发现未声明的赋值，也没有发现只写一次的计数字段。');
