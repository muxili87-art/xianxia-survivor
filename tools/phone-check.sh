#!/bin/zsh
# 手机视口检查：在真正的窄视口里量 HUD 布局。
#
# 用法: tools/phone-check.sh [宽] [高] [查询串]
# 示例: tools/phone-check.sh                 # 390x844（iPhone 12/13/14）
#       tools/phone-check.sh 320 568         # iPhone SE
#       tools/phone-check.sh 430 932 "?diag=1&play=90"
#
# 为什么不用 tools/render.sh 的 XS_SIZE：
#   headless Chrome 的窗口有**最小宽度（约 500）**，传 390 会被静默抬到 500。
#   这个脚本改用 iframe 造窄视口，并把实际 innerWidth/innerHeight 打进输出对照。
#
# 为什么必须走 HTTP：Chrome 把 file:// 当 opaque origin，
#   跨 file:// 的 iframe.contentDocument 是 null，量不到任何东西。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/Users/muxi/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
PY=/Users/muxi/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3
W="${1:-390}"
H="${2:-844}"
QUERY="${3:-?diag=1&play=8&gesture=1}"
PORT="${XS_PHONE_PORT:-8795}"

PROBE="probe-phone.html"
DOM="/tmp/xs-phone-dom.html"
LOG="/tmp/xs-phone-chrome.log"

cd "$ROOT"
"$NODE" tools/make-phone-probe.mjs "$ROOT/$PROBE" "$W" "$H" "$QUERY" || exit 1

# 静态文件服务器：探针只需要能读到 iframe 的 DOM，不需要回传接口，
# 所以直接用 python 自带的就够了，不用另写一个 server.py。
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

# 等端口起来。不加这一步的话，第一次跑必 404。
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/$PROBE" && break
  sleep 0.4
done

rm -f "$DOM"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage \
  --no-proxy-server --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --window-size=1200,900 --hide-scrollbars --disable-extensions \
  --virtual-time-budget=25000 \
  --dump-dom "http://127.0.0.1:$PORT/$PROBE" > "$DOM" 2>"$LOG"

# 探针只能放在项目根目录（iframe 要能相对路径找到 index.html），
# 但**不要用 rm 清理**：沙箱的 safe-delete 守卫会拦批量删除、
# 并掐断整个脚本（见 README「沙箱环境的三个致命坑」）。
mv -f "$ROOT/$PROBE" "/tmp/$PROBE" 2>/dev/null || true
kill $SRV 2>/dev/null

XS_DOM="$DOM" XS_WANT="${W}x${H}" "$NODE" -e '
const fs = require("fs");
let h = "";
try { h = fs.readFileSync(process.env.XS_DOM, "utf8"); } catch (e) {
  console.log("NO DOM FILE — Chrome 没产出，看 /tmp/xs-phone-chrome.log");
  process.exit(2);
}
const m = h.match(/<pre id="phone_out"[^>]*data-verdict="([^"]*)"[^>]*>([\s\S]*?)<\/pre>/)
       || h.match(/<pre id="phone_out"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) { console.log("NO PHONE REPORT — DOM 长度 " + h.length); process.exit(2); }
const verdict = m.length === 3 ? m[1] : "?";
const body = m.length === 3 ? m[2] : m[1];
const dec = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&quot;/g, String.fromCharCode(34)).replace(/&amp;/g, "&");
const txt = dec(body);

/* 请求尺寸与实际尺寸必须对得上。
   这是「传进去的参数要有读回来的值与之对照」那条规矩的落地 ——
   少了它，一次被静默抬宽的运行会被当成该尺寸的验证。 */
const first = txt.split("\n")[0] || "";
const got = first.match(/(\d+)\s*x\s*(\d+)/);
if (got && process.env.XS_WANT) {
  const [w, hh] = process.env.XS_WANT.split("x").map(Number);
  if (+got[1] !== w || +got[2] !== hh)
    console.log("  ⚠ 实际视口 " + got[1] + "x" + got[2] + " ≠ 请求的 " + process.env.XS_WANT);
}
console.log(txt);
console.log("");
if (verdict === "OK") console.log("phone.verdict: ok（无溢出、同一排内无重叠）");
else if (verdict === "ISSUES") console.log("phone.verdict: 有问题（见上面的 ⚠ 行）");
else console.log("phone.verdict: " + verdict);
process.exit(verdict === "OK" ? 0 : 1);
'
