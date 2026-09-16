#!/usr/bin/env node
/* ============================================================
 * 小游戏打包：把 vendor + js 拼成 dist/minigame/game.js
 *
 * 为什么是「拼接」而不是引入 bundler：
 * 这个项目的所有源文件都是**普通脚本**（IIFE 挂到 window.XS 上），
 * 没有 import / export，所以模块图的唯一信息就是「加载顺序」。
 * 为它引一个打包器，换来的是几百 KB 的依赖树和一个需要联网的
 * 构建步骤 —— 而小游戏首包本来就卡在 4 MB 上。
 * 这里用一张显式的模块表代替依赖分析：顺序错了立刻能看出来，
 * 比让打包器去猜更可靠。
 *
 * 用法：
 *   node tools/build-minigame.mjs            构建
 *   node tools/build-minigame.mjs --quiet    只输出体积审计
 * ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const OUT = join(ROOT, 'dist', 'minigame');

const quiet = process.argv.includes('--quiet');

/* ------------------------------------------------------------
 * 模块表
 *
 * 每一行是 [路径, 为什么在这里]。
 * 「为什么」不是注释洁癖：小游戏版和 Web 版的差别**只在这张表里**
 * （少 ui.js / main.js / dashboard.js，多 minigame/*），
 * 把理由写在这里，将来对不上时能一眼看出是哪一边改了。
 * ------------------------------------------------------------ */
const MODULES = [
  ['js/minigame/shim.js',   '环境垫片：必须最先，后面的脚本都依赖 window/document'],
  ['vendor/three.min.js',   'Three.js r128（UMD）'],
  ['vendor/shaders/CopyShader.js', ''],
  ['vendor/shaders/LuminosityHighPassShader.js', ''],
  ['vendor/postprocessing/Pass.js', ''],
  ['vendor/postprocessing/ShaderPass.js', ''],
  ['vendor/postprocessing/MaskPass.js', ''],
  ['vendor/postprocessing/EffectComposer.js', ''],
  ['vendor/postprocessing/RenderPass.js', ''],
  ['vendor/postprocessing/UnrealBloomPass.js', ''],
  ['js/config.js',          '调色板 / 数值 / 波次 / 功法表'],
  ['js/core.js',            '渲染器与后处理（输入部分被 minigame/input.js 覆盖）'],
  ['js/platform.js',        '平台适配层'],
  ['js/settings.js',        '设置对象：Web 与 Canvas 两个 UI 后端共用'],
  ['js/meta.js',            '局外成长'],
  ['js/audio.js',           '程序化音频'],
  ['js/telemetry.js',       '打点'],
  ['js/entities.js',        '几何体（程序化贴图走 document.createElement("canvas")）'],
  ['js/world.js',           '场景'],
  ['js/minigame/ui2d.js',   'Canvas UI —— **替代 js/ui.js**'],
  ['js/game.js',            '主循环'],
  ['js/bot.js',             '走位机器人 —— Web 与小游戏**共用同一份**（走查用）'],
  ['js/minigame/input.js',  '触摸输入 —— 必须在 core.js 之后（覆盖 Input.bind）'],
  ['js/minigame/boot.js',   '启动入口 —— 替代 js/main.js']
];

/* Web 版有、小游戏版没有的东西。列出来是为了让「少了个文件」
   变成一次显式声明，而不是一次遗忘。 */
const EXCLUDED = [
  ['js/ui.js',        'DOM 面板 → 由 minigame/ui2d.js 替代'],
  ['js/main.js',      'Web 启动 + 调试设施（同步模拟 / 选牌机器人 / 诊断）'],
  ['js/dashboard.js', '数据面板，只服务于 data.html'],
  ['style.css',       'Canvas UI 不需要样式表'],
  ['index.html',      '小游戏没有 HTML 入口'],
  ['data.html',       '小游戏没有第二张页面'],
  ['docs/',           '作品集截图不参与打包']
];

const HEADER = `/* ============================================================
 * 《仙台问剑》微信 / 抖音小游戏包
 *
 * 这个文件由 tools/build-minigame.mjs 生成，**不要手改**。
 * 改代码请改 js/ 下的源文件，然后重新构建。
 * ============================================================ */
;(function () {
  var g = (typeof GameGlobal !== 'undefined') ? GameGlobal
        : (typeof globalThis !== 'undefined') ? globalThis : this;
  if (!g) return;
  /* Three.js 的 UMD 头会走 \`global = global || self\` 这条分支，
     小游戏里没有 self，得先给它一个。 */
  if (!g.self) g.self = g;
  if (!g.window) g.window = g;
  if (!g.global) g.global = g;
})();
`;

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error('模块缺失: ' + rel);
  return readFileSync(p, 'utf8');
}

/* 每个模块之间插一行分隔注释。诊断「某一行报错」时，
   没有这些标记就只能靠行号去猜是哪个文件。 */
function chunk(rel, code) {
  const n = code.split('\n').length;
  return `\n/* ===== ${rel} (${n} 行) ===== */\n` + code + '\n';
}

/* 不要 rmSync 整个输出目录 —— 只覆盖已知产物，并把**多出来的文件**报出来。
 *
 * 踩过的坑：原来这里递归删 dist/minigame，在一个会话里反复构建时
 * 会被沙箱的「批量删除守卫」拦下（阈值 50 项），构建直接抛错退出。
 * 而比「构建失败」更糟的是它引发的连锁反应：下游 render-mg.sh 看到
 * game.js 还在，就**静默使用了上一版的产物** —— 于是验证的是旧 bundle，
 * 拿到的是上一版的结果，而且一切看起来正常。
 * （实测：还原了一处符号错误后构建失败，验证仍报红，
 *   差点让我得出「还原无效」的反结论。）
 *
 * 少删文件 + 把意外文件报出来，比「删干净」安全得多：
 * dist/ 是要整体上传的，多一个文件就是多一份体积。 */
const OUT_FILES = ['game.js', 'game.json', 'project.config.json'];
mkdirSync(OUT, { recursive: true });
const stale = readdirSync(OUT).filter(f => !OUT_FILES.includes(f));

let bundle = HEADER;
const report = [];
for (const [rel, why] of MODULES) {
  const code = read(rel);
  bundle += chunk(rel, code);
  report.push({ rel, bytes: Buffer.byteLength(code), why });
}

const outFile = join(OUT, 'game.js');
writeFileSync(outFile, bundle);

/* ------------------------------------------------------------
 * 小游戏配置文件
 * ------------------------------------------------------------ */
const gameJson = {
  deviceOrientation: 'portrait',
  showStatusBar: false,
  /* 网络超时先给一个值：将来接排行榜 / 云存档时要靠它兜底，
     缺省值在不同基础库上不一致，显式写死更省事。 */
  networkTimeout: { request: 8000, connectSocket: 8000, uploadFile: 8000, downloadFile: 8000 },
  /* 分包留空：首包只有 ~1 MB，离 4 MB 上限还很远，
     现在分包只会把「加载路径」这个最简单的部分复杂化。 */
  subpackages: [],
  workers: ''
};
writeFileSync(join(OUT, 'game.json'), JSON.stringify(gameJson, null, 2) + '\n');

const projectConfig = {
  description: '仙台问剑 · 3D 修仙割肉（程序化美术，零素材）',
  appid: 'touristappid',
  projectname: 'xianxia-survivor',
  compileType: 'game',
  libVersion: '3.0.0',
  setting: {
    /* es6 → true 让开发者工具做一次 ES5 转译。
       源文件本身是 ES5 风格，但 Three.js 和部分语法糖还是交给工具更稳，
       真机上基础库版本差异比构建时间更值钱。 */
    es6: true,
    enhance: true,
    minified: false,
    postcss: false,
    urlCheck: false,
    autoAudits: false,
    /* 关闭「上传时压缩代码」：这个包要做体积审计，
       压缩会让审计数字和实际产物对不上。 */
    uglifyFileName: false
  },
  condition: {}
};
writeFileSync(join(OUT, 'project.config.json'), JSON.stringify(projectConfig, null, 2) + '\n');

/* ------------------------------------------------------------
 * 体积审计
 * ------------------------------------------------------------ */
const LIMITS = { wechat: 4 * 1024 * 1024, bytedance: 4 * 1024 * 1024 };
const totalBytes = Buffer.byteLength(bundle);
const totalKB = (totalBytes / 1024).toFixed(0);

function kb(n) { return (n / 1024).toFixed(1); }

if (!quiet) {
  console.log('小游戏包构建完成 → dist/minigame/');
  console.log('');
  console.log('模块'.padEnd(38) + '字节'.padStart(10));
  for (const r of report) {
    console.log(('  ' + r.rel).padEnd(38) + String(r.bytes).padStart(10));
  }
  console.log('');
  console.log('排除的模块（Web 专有）:');
  for (const [rel, why] of EXCLUDED) console.log('  - ' + rel.padEnd(20) + why);
  console.log('');
  console.log('game.js            ' + totalKB + ' KB');
  console.log('game.json          ' + kb(statSync(join(OUT, 'game.json')).size) + ' KB');
  console.log('project.config.json ' + kb(statSync(join(OUT, 'project.config.json')).size) + ' KB');
  console.log('');
  for (const [k, lim] of Object.entries(LIMITS)) {
    const pct = (totalBytes / lim * 100).toFixed(1);
    const name = k === 'wechat' ? '微信' : '抖音';
    console.log(`${name}首包上限 ${lim / 1024 / 1024} MB —— 占用 ${totalKB} KB (${pct}%)，余量 ${((lim - totalBytes) / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('');
  console.log('外部素材: 0 KB（全部程序化生成）');
  /* dist/ 是整体上传的：多出来的文件既是体积也是风险，报出来而不是悄悄留着 */
  if (stale.length) {
    console.log('');
    console.log('⚠ dist/minigame/ 里有 ' + stale.length + ' 个非产物文件（会被一起上传）:');
    for (const f of stale) console.log('    ' + f);
  }
} else {
  console.log(totalKB + ' KB → dist/minigame/game.js');
}
