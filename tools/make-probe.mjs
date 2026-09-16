/* 由 index.html 生成 probe.html：
 * 只在 <head> 注入错误收集器（不用定时器，避免虚拟时间下不触发）。
 * 真正的诊断 JSON 由 js/main.js 在启动流程末尾同步写出。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const head = `<script>
window.__diag = { errors: [], t0: Date.now() };
window.addEventListener('error', function (e) {
  var msg = e.message || 'Script error';
  window.__diag.errors.push('ERROR: ' + msg + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + ':' + (e.colno || 0));
}, true);
window.addEventListener('unhandledrejection', function (e) {
  window.__diag.errors.push('REJECT: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
});
(function () {
  var ce = console.error, cw = console.warn;
  console.error = function () {
    window.__diag.errors.push('CONSOLE_ERROR: ' + Array.prototype.join.call(arguments, ' '));
    ce.apply(console, arguments);
  };
  console.warn = function () {
    window.__diag.errors.push('CONSOLE_WARN: ' + Array.prototype.join.call(arguments, ' '));
    cw.apply(console, arguments);
  };
})();
</script>
`;

let html = readFileSync(join(root, process.argv[3] || 'index.html'), 'utf8');
html = html.replace('</head>', head + '</head>');
/* 输出文件名可由参数指定（render.sh 会按截图名生成唯一名字）。
   不指定时仍然写 probe.html，保持手工调用的习惯不变。
   为什么需要：并行跑两个渲染时，共用一个 probe.html 会出现
   「一边在读、一边在重写」的竞态。 */
const out = process.argv[2] || 'probe.html';
const outPath = out.startsWith('/') ? out : join(root, out);
writeFileSync(outPath, html);
console.log(outPath + ' written, bytes=' + html.length);
