#!/bin/zsh
# 重新生成 data/seed-data.js（数据面板的机器人样本兜底数据）
#
# 为什么要有这个脚本：这份文件是**自动生成**的，但以前是手敲一条
# render.sh 命令再手工剪贴出来的，于是它悄悄过期了很久 ——
# 面板上显示的还是旧版本的数值分布（旧的上限等级、旧的进化率），
# 而代码早就变了。凡是"自动生成但靠手工刷新"的产物都会烂掉，
# 所以把刷新动作本身做成脚本。
#
# 用法: tools/make-seed.sh [局数]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/Users/muxi/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
RUNS="${1:-12}"
TAG="seed$(date +%H%M%S)"
SHOT="/tmp/xs-$TAG.png"

cd "$ROOT"
# full=1 让诊断带上完整对局数组
"$NODE" tools/make-probe.mjs "probe-$TAG.html" >/dev/null

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage \
  --no-proxy-server --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --window-size=1280,800 --hide-scrollbars --disable-extensions \
  --virtual-time-budget=240000 \
  --screenshot="$SHOT" \
  --dump-dom "file://$ROOT/probe-$TAG.html?farm=$RUNS&full=1" > "/tmp/xs-dom-$TAG.html" 2>/dev/null

rm -f "$ROOT/probe-$TAG.html"

XS_DOM="/tmp/xs-dom-$TAG.html" "$NODE" -e '
const fs = require("fs");
const h = fs.readFileSync(process.env.XS_DOM, "utf8");
const m = h.match(/DIAG_JSON_START([\s\S]*?)DIAG_JSON_END/);
if (!m) { console.error("NO DIAG — 渲染失败，seed-data.js 未改动"); process.exit(1); }
const d = JSON.parse(m[1]);
const runs = d.runs || [];
if (!runs.length) { console.error("诊断里没有 runs（是否漏了 full=1？）"); process.exit(1); }
/* events 明细面板不用，剔掉能让文件小一大截 */
const slim = runs.map(function (r) { const c = Object.assign({}, r); delete c.events; return c; });
const header =
  "/* 自动生成，请勿手改。\n" +
  " * 生成命令：tools/make-seed.sh\n" +
  " * 来源：无头 Chrome 里机器人试玩 " + slim.length + " 局（?farm=" + slim.length + "&full=1）。\n" +
  " * 用途：数据面板在本机还没有真实对局时的兜底样本。\n" +
  " * 说明：已剔除 events 明细数组（面板不使用），只保留聚合字段。\n" +
  " */\n";
const body = "window.__XS_SEED = " + JSON.stringify({
  generatedAt: new Date().toISOString(),
  runs: slim
}) + ";\n";
fs.writeFileSync("data/seed-data.js", header + body);
const s = d.summary;
console.log("data/seed-data.js 已重写：" + slim.length + " 局, " +
            (header + body).length + " bytes");
console.log("  winRate " + s.winRate + "% | avgLv " + s.avgLevel +
            " | evolve " + s.evolveRate + "% | avgEvolves " + s.avgEvolves);
'
