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

/* ---------- 规则 B 想过，没做 ----------
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
console.log('静态检查通过：没有发现未声明的赋值。');
