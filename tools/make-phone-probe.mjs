/* 生成「手机视口」探针页：把游戏放进一个 390x844 的 iframe 里跑，
 * 量每个 HUD 盒子的矩形，并检查它们有没有互相压住。
 *
 * 为什么必须用 iframe，而不是给 Chrome 传 --window-size=390,844：
 *   headless Chrome 的窗口有**最小宽度（约 500）**，传 390 会被静默抬到 500。
 *   于是「在 iPhone 视口上验过」实际上是「在 500x757 上验过」——
 *   而 500/757 ≈ 0.66 的宽高比离 iPhone 的 0.46 差得很远，
 *   HUD 布局的结论根本不能外推。
 *   iframe 里的 window.innerWidth/innerHeight 就是 iframe 的尺寸，不受这个限制。
 *
 * 为什么探针页必须从 HTTP 打开（不能 file://）：
 *   Chrome 把 file:// 当成 opaque origin，跨 file:// 的
 *   `iframe.contentDocument` 是 null，量不到任何东西。
 *
 * 用法: node tools/make-phone-probe.mjs <outPath> [宽] [高] [查询串]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(ROOT, 'probe-phone.html');
const W = process.argv[3] || '390';
const H = process.argv[4] || '844';
const QUERY = process.argv[5] || '?diag=1&play=8&gesture=1';

const html = `<!doctype html>
<meta charset="utf-8">
<title>手机视口验证</title>
<body style="margin:0;background:#111;font:12px/1.5 monospace;color:#cfe">
<iframe id="f" src="index.html${QUERY}"
        style="width:${W}px;height:${H}px;border:0;display:block;float:left"></iframe>
<pre id="phone_out" style="float:left;width:700px;white-space:pre-wrap">PENDING</pre>
<script>
var f = document.getElementById('f');
var out = document.getElementById('phone_out');
var t0 = Date.now();
var VW = ${W}, VH = ${H};

/* 要量的 HUD 元素。分两组做「互相压住」的检查 ——
   容器（#hud / #touchZone / #dmgLayer）天然覆盖全屏，
   把它们放进来会天天误报，所以只查**同一排里的兄弟**。 */
var TOP = ['topLeft', 'topCenter', 'topRight'];
var BOTTOM = ['skillBar', 'boostBtn', 'tipLine'];
var ALL = ['hud', 'topLeft', 'topCenter', 'topRight', 'bossBar', 'skillBar',
           'tipLine', 'boostBtn', 'stick', 'touchZone', 'dmgLayer'];

function rect(el) { return el.getBoundingClientRect(); }

/* 「看不见」的三种写法都要认。
   只判 display/visibility 会漏掉 opacity:0 —— 摇杆闲置时就是
   position 停在左上角、opacity:0，只判前两者会把它报成「溢出视口」，
   而那是个假警报。（这个假警报真出现过一次。） */
function hidden(win, el) {
  var cs = win.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  if (parseFloat(cs.opacity) === 0) return true;
  if (el.offsetParent === null && cs.position !== 'fixed') return true;
  return false;
}

function overlap(a, b) {
  var x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  var y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return Math.round(x) * Math.round(y) > 0 ? { w: Math.round(x), h: Math.round(y) } : null;
}

function report(win, doc) {
  var lines = [], bad = [], warn = [];
  lines.push('视口 ' + win.innerWidth + ' x ' + win.innerHeight + '  dpr=' + win.devicePixelRatio);
  lines.push('');
  lines.push('--- 各盒子（left,top 宽x高）---');
  var R = {};
  for (var i = 0; i < ALL.length; i++) {
    var el = doc.getElementById(ALL[i]);
    if (!el) { lines.push('  ' + ALL[i] + ': (不存在)'); continue; }
    var r = rect(el), hid = hidden(win, el);
    R[ALL[i]] = hid ? null : r;
    lines.push('  ' + ALL[i] + ': ' + Math.round(r.left) + ',' + Math.round(r.top)
      + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
      + (hid ? '  [不可见]' : ''));
    if (!hid && (r.right > win.innerWidth + 0.5 || r.bottom > win.innerHeight + 0.5
        || r.left < -0.5 || r.top < -0.5)) bad.push(ALL[i]);
  }

  lines.push('');
  lines.push('--- 同一排里互相压住的元素 ---');
  var groups = [['顶部', TOP], ['底部', BOTTOM]];
  for (var g = 0; g < groups.length; g++) {
    var nm = groups[g][0], ids = groups[g][1];
    for (var a = 0; a < ids.length; a++) {
      for (var b = a + 1; b < ids.length; b++) {
        if (!R[ids[a]] || !R[ids[b]]) continue;
        var ov = overlap(R[ids[a]], R[ids[b]]);
        if (ov) warn.push(nm + ': ' + ids[a] + ' 压住 ' + ids[b]
          + '（重叠 ' + ov.w + 'x' + ov.h + 'px）');
      }
    }
  }
  lines.push(warn.length ? warn.map(function (s) { return '  ⚠ ' + s; }).join('\\n') : '  (无)');

  lines.push('');
  lines.push('--- 溢出视口 ---');
  lines.push(bad.length ? '  ⚠ ' + bad.join(', ') : '  (无)');

  return { text: lines.join('\\n'), bad: bad, warn: warn };
}

function tick() {
  var win, doc;
  try { win = f.contentWindow; doc = f.contentDocument; }
  catch (e) { out.textContent = 'IFRAME ACCESS ERROR: ' + e; return; }
  if (!doc) { out.textContent = 'IFRAME contentDocument 为 null（是不是用 file:// 打开的？）'; return; }

  var pre = doc.getElementById('__diag_out');
  if (pre && pre.textContent) {
    var rep = report(win, doc);
    var tail = ['', '--- 游戏诊断 ---', pre.textContent];
    out.textContent = rep.text + tail.join('\\n');
    out.setAttribute('data-verdict', (rep.bad.length || rep.warn.length) ? 'ISSUES' : 'OK');
    return;
  }
  if (Date.now() - t0 > 90000) {
    var ld = doc.getElementById('loading');
    out.textContent = 'TIMEOUT\\nloading=' + (ld ? ld.className + ' | ' + ld.innerText : '?');
    out.setAttribute('data-verdict', 'TIMEOUT');
    return;
  }
  setTimeout(tick, 300);
}
setTimeout(tick, 300);
</script>
</body>
`;
writeFileSync(out, html);
console.log(out + ' written, bytes=' + html.length);
