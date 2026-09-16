#!/bin/zsh
# 小游戏打包产物的无头验证：截图 + 诊断 JSON
#
# 和 tools/render.sh 的区别：
#   1. 页面是 sim.html（假 wx 宿主 + 影子作用域执行 bundle）
#   2. 多一个 --allow-file-access-from-files：模拟器用同步 XHR 读
#      dist/minigame/game.js，file:// 下没有这个标志会被 CORS 拦掉，
#      症状是「bundle 没加载」，看起来像打包坏了
#
# 用法: tools/render-mg.sh [输出截图] [虚拟时间预算ms] [查询串]
# 示例: tools/render-mg.sh /tmp/mg.png 15000 "?mgplay=20"
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/Users/muxi/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
SHOT="${1:-/tmp/mg-shot.png}"
BUDGET="${2:-15000}"
QUERY="${3:-?mgplay=10}"
# 无头 Chrome 会给窗口留 87px 的「浏览器装饰」高度：
# --window-size=500,947 时页面视口正好是 500x860（实测确认）。
# 不补这 87px 的话，视口比截图小，UI 按视口宽排版、
# 截图按窗口宽取图，右侧内容会被切掉 —— 看起来像布局写错了。
W="${MGW:-500}"
H="${MGH:-947}"

cd "$ROOT"
# sim.html 也要**比源码新**才用。原来只写「缺了才生成」——
# 于是改了模拟器之后（比如加 ?mgad= 的广告桩）跑出来的还是旧页面，
# 而它看起来完全正常：只是新参数**不生效**。
# 实测踩过：加完广告桩跑三种广告结果，三次都报 capable:false，
# 差一点得出「桩没写对」的反结论 —— 真相是页面没重新生成。
if [ -f sim.html ] && [ tools/minigame-sim.mjs -nt sim.html ]; then
  echo "[sim] sim.html 比源码旧 → 重新生成"
  "$NODE" tools/minigame-sim.mjs || exit 1
fi
[ -f sim.html ] || "$NODE" tools/minigame-sim.mjs || exit 1
# 产物比源码旧就重建。**这一步必须有**：
# 原来只写「缺了才构建」，于是构建失败（或忘记构建）时下游会**静默使用
# 上一版产物** —— 你验证的是旧 bundle，拿到的是上一版的结果，
# 而且一切看起来都正常。实测踩过：还原一处符号错误后构建被拦，
# 验证仍报红，差点让我得出「还原无效」的反结论。
if [ -f dist/minigame/game.js ] && \
   [ -n "$(find js vendor -type f -name '*.js' -newer dist/minigame/game.js -print -quit 2>/dev/null)" ]; then
  echo "[build] 产物比源码旧 → 重建"
  "$NODE" tools/build-minigame.mjs --quiet || exit 1
fi
[ -f dist/minigame/game.js ] || "$NODE" tools/build-minigame.mjs --quiet || exit 1

TAG="$(basename "$SHOT")"
TAG="${TAG//[^A-Za-z0-9._-]/_}"
DOM="/tmp/mg-dom-$TAG.html"
LOG="/tmp/mg-chrome-$TAG.log"
rm -f "$SHOT" "$DOM"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage \
  --no-proxy-server --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --allow-file-access-from-files \
  --window-size="$W,$H" --hide-scrollbars --disable-extensions \
  --virtual-time-budget="$BUDGET" \
  --screenshot="$SHOT" \
  --dump-dom "file://$ROOT/sim.html$QUERY" > "$DOM" 2>"$LOG"

echo "[shot] $(stat -f%z "$SHOT" 2>/dev/null || echo MISSING) bytes -> $SHOT"
echo "--- MG DIAG ---"
MG_DOM="$DOM" "$NODE" -e '
const fs = require("fs");
let h = "";
try { h = fs.readFileSync(process.env.MG_DOM, "utf8"); } catch (e) { console.log("NO DOM FILE"); process.exit(0); }
const m = h.match(/MGDIAG_START([\s\S]*?)MGDIAG_END/);
const errs = [...h.matchAll(/MGERR: ([^\n]*)/g)].map(x => x[1]);
if (errs.length) console.log("SIM ERRORS:", errs.slice(0, 8).join(" || "));
if (!m) { console.log("NO MG DIAG FOUND"); process.exit(0); }
let o;
try { o = JSON.parse(m[1]); } catch (e) { console.log("MG DIAG PARSE FAIL:", e.message); process.exit(0); }
if (!o.loaded) { console.log("BUNDLE DID NOT LOAD"); }
if (o.store) console.log("store:", JSON.stringify(o.store));
if (o.errors && o.errors.length) console.log("SIM ERRORS:", JSON.stringify(o.errors));
const d = o.diag;
if (!d) { console.log("NO DIAG OBJECT", o.diagError || ""); process.exit(0); }
console.log("env:", d.env, "| platform:", d.platform, "| screen:", d.screen, "| dpr:", d.dpr);
console.log("canvas:", d.canvas, "| three:", d.threeRev, "| state:", d.state, "| t:", d.t, "| frozen:", d.frozen);
/* 画布尺寸必须等于 **屏幕 × 像素比 × 渲染缩放**。
   这一条是补出来的：改渲染器构造参数时**漏掉了 `canvas`**，
   于是 three.js 自己新建了一张离屏画布（浏览器默认 300×150），
   游戏照常跑、`state: playing`、零报错 —— 就是**画不到屏幕上**。
   当时那句冒烟只 grep 了 `state:`，所以整条回归溜了过去。

   判据的第一版写成 `canvas === screen`，结果 `ui-quality` 那一条
   立刻误报 —— 它点的就是「画质·低」，**画布本来就该变小**
   （500x860 → 330x567）。这正是四之五十一那个坑的第二次：
   **断言的前置条件必须来自「这一发实际做了什么」，不是「一般情况是什么样」。**
   所以要把 `prScale`（自适应渲染缩放）算进去。 */
if (d.canvas && d.screen) {
  const sw = parseInt(String(d.screen).split("x")[0], 10);
  const sh = parseInt(String(d.screen).split("x")[1], 10);
  /* basePR 是 min(devicePixelRatio, 2)，不是原始 dpr —— 别直接用 dpr。 */
  const pr = Math.min(d.dpr || 1, 2) * (d.prScale || 1);
  const ew = Math.round(sw * pr), eh = Math.round(sh * pr);
  const aw = parseInt(String(d.canvas).split("x")[0], 10);
  const ah = parseInt(String(d.canvas).split("x")[1], 10);
  if (Math.abs(aw - ew) > 2 || Math.abs(ah - eh) > 2) {
    console.log("  ⚠ 画布 " + d.canvas + " 与预期 " + ew + "x" + eh
      + "（屏幕 " + d.screen + " × 像素比 " + pr.toFixed(3)
      + "）不一致 —— 渲染器可能没挂在真画布上（默认尺寸是 300x150）");
  }
}
console.log("scene:", d.sceneChildren, "children | drawCalls:", d.drawCalls, "| tris:", d.triangles, "| prScale:", d.prScale);
if (d.bootError) console.log("BOOT ERROR:", d.bootError.split("\n").slice(0,3).join(" / "));
/* 失败面板到底画出来了没。
   判据不能只看 `bootError` 有值 —— 那只说明「进过 catch」。
   这段代码坏过一次：Core.init 里先建渲染器再 resize，渲染器一失败
   画布就停在 300x150，被拉伸到全屏后文字放大十几倍、只剩几个字。
   而当时诊断里 `bootError` 有值、`state:'ready'`，看起来完全正常 ——
   只能靠人去看截图，而人没看。所以现在把「画出来了没」单独报一项。
   bootErrDrawn: null = 没走到失败路径（正常启动）。 */
if (d.bootErrDrawn !== undefined && d.bootErrDrawn !== null) {
  console.log("bootErrDrawn:", d.bootErrDrawn);
  if (d.bootErrDrawn !== true) {
    console.log("  ⚠ 进了启动失败分支，但失败面板没画出来 —— 玩家看到的会是一片黑");
  }
}
if (d.diagError) console.log("DIAG ERROR:", d.diagError);
if (d.player) console.log("player:", JSON.stringify(d.player));
/* 一局进行到哪儿了。这一项**必须**由游戏层提供：
   小游戏没有 DOM，原先这里是 `kills: null` 的常量占位，
   看起来像「击杀统计坏了」，其实只是诊断没接。 */
if (d.run) console.log("run:", JSON.stringify(d.run));
if (d.build) console.log("build:", JSON.stringify(d.build));
if (d.meta) console.log("meta:", JSON.stringify({lv:d.meta.lv, offline:d.meta.offline}));
if (d.bot) console.log("bot:", JSON.stringify(d.bot), "| botOn:", d.botOn);
if (d.ui) console.log("ui:", JSON.stringify(d.ui));
/* 触摸层证据。机器人默认直接写 Input.vec，绕过触摸层 ——
   所以 starts=0 就等于「触摸输入从没被执行过」。
   vecCos / moveCos 接近 1 才说明映射方向是对的。 */
if (d.touch) {
  const t = d.touch;
  const warn = [];
  /* ?mgtap 会故意去点一个 UI 按钮，那一下**应该**被 UI 吃掉 ——
     所以「uiEats > 0」只在没做点击驱动时才算异常。 */
  const tapRan = !!(d.ad && d.ad.tap && d.ad.tap.found);
  if (t.on && !t.starts) warn.push("触摸层未被执行");
  if (t.on && t.vecCos != null && t.vecCos < 0.95) warn.push("vec 方向不一致");
  if (t.on && t.moveCos != null && t.moveCos < 0.9) warn.push("位移方向不一致");
  if (t.uiEats > 0 && !tapRan) warn.push("摇杆起点被 UI 吃掉 " + t.uiEats + " 次");
  console.log("touch:", JSON.stringify(t), warn.length ? ("  ⚠ " + warn.join(" / ")) : "");
}
/* 广告点位。这里要**两个方向都验**，缺一个都能放过 bug：
   1) capable=false（宿主没有广告 API）→ 绝不能摆出复活按钮。
      只验「点了没崩」的话，一个点不动的死按钮会算通过 ——
      而这正是原来的样子：按钮在、点下去只弹一句「广告未看完」。
   2) capable=true → 按钮必须在，且按下去状态真的回到 playing。
      只验「按钮画出来了」的话，回调没接上也会算通过。
   3) mode=skip（用户中途关掉）→ **不能**发奖励。
      这条最像废话，但它恰好是「白送奖励」那类洞的判据。 */
if (d.ad) {
  const a = d.ad, t = a.tap;
  const warn = [];
  const isRevive = t && t.found && t.want.indexOf("复活") >= 0;
  const isDouble = t && t.found && t.want.indexOf("翻倍") >= 0;
  const isBoost = t && t.found && t.want.indexOf("神行符") >= 0;
  const wantRevive = t && t.want.indexOf("复活") >= 0;
  const wantDouble = t && t.want.indexOf("翻倍") >= 0;
  const wantBoost = t && t.want.indexOf("神行符") >= 0;
  const wantCard = t && t.want.indexOf("升级卡") >= 0;
  /* 「没走到那一屏」必须报出来。
     一个什么都没验到的测试比一个失败的测试更危险：
     它会以「无警告」的形式记进结论。实测踩过：?mguntil=over 那一发
     机器人活到了 419 秒（没死），于是按钮清单是空的，
     看起来像「正确地没摆出复活按钮」。 */
  if (wantRevive && t.stateBefore !== "over") {
    warn.push("没走到死亡界面（state=" + t.stateBefore + "），这一发没验到东西");
  }
  if (wantDouble && t.stateBefore !== "win") {
    warn.push("没走到通关界面（state=" + t.stateBefore + "），这一发没验到东西");
  }
  if (wantBoost && t.stateBefore !== "playing") {
    warn.push("没在局内（state=" + t.stateBefore + "），这一发没验到东西");
  }
  /* 升级三选一：玩家每 20 秒就要点一次的地方。
     走查机器人是直调 XS.UI.pickCard(i)（那个版本会先摘回调、关面板），
     而手指点的是 drawCard 里注册的 S.cardPick 直调 —— **不是同一条路**。
     所以这里单独验：点完必须回到 playing，且面板收起。 */
  if (wantCard && t.stateBefore !== "levelup") {
    warn.push("没停在升级三选一（state=" + t.stateBefore + "），这一发没验到东西");
  }
  if (wantCard && t.stateBefore === "levelup" && t.stateAfter !== "playing") {
    warn.push("点了升级卡但状态没回到 playing（" + t.stateBefore + "→" + t.stateAfter + "）");
  }
  if (wantCard && t.stateAfter === "playing" && t.screenAfter !== "none") {
    warn.push("点了升级卡但面板没收起（screen=" + t.screenAfter + "）");
  }
  /* 点击的期望值：change（该变）/ none（该不变）。
     写进查询串而不是让脚本从结果反推 —— 「买不起时不该扣钱」和
     「买得起时该扣钱」是两条相反的断言，看结果猜不出该是哪条。

     **两种期望都必须先要求 `found`。** 否则「按钮没找到」会同时满足
     `expect=none`（什么都没变）—— 一个没点到的测试变成一次假通过。
     这条踩过：商店按钮的 tag 是价格（"680"），脚本按名字找必然找不到，
     而 `expect=none` 那一发就这么「通过」了。 */
  if (t && t.expect && !t.found) {
    warn.push("期望「" + t.expect + "」但根本没找到按钮「" + t.want + "」，这一发没验到东西");
  } else if (t && t.expect) {
    if (t.expect === "change" && !t.metaChanged && !t.settingsChanged) {
      warn.push("期望「有变化」但什么都没变（meta=" + JSON.stringify(t.metaBefore) + "）");
    }
    if (t.expect === "none" && (t.metaChanged || t.settingsChanged)) {
      warn.push("期望「无变化」但状态变了（meta=" + JSON.stringify(t.metaAfter) + "）");
    }
  }
  /* 商店购买：扣钱和升级必须成对出现。
     只扣钱不升级、或只升级不扣钱，都是灾难性的。 */
  if (t && t.screenBefore === "meta" && typeof t.coinsSpent === "number") {
    if (t.coinsSpent > 0 && t.upBought !== 1) {
      warn.push("扣了 " + t.coinsSpent + " 灵石，却有 " + t.upBought + " 项强化变化");
    }
    if (t.coinsSpent < 0) warn.push("灵石变成了负数（花了 " + t.coinsSpent + "）");
  }
  /* 暂停按钮与设置项：都是「每局都会用到、但走查从来没点过」的交互。
     设置项的判据是**值真的变了**，不是「按钮存在」。 */
  if (t && t.want === "暂停") {
    if (t.stateBefore !== "playing") warn.push("没在局内（state=" + t.stateBefore + "），这一发没验到东西");
    else if (t.stateAfter !== "paused") warn.push("点了暂停但状态没变成 paused（" + t.stateAfter + "）");
  }
  if (t && t.want.indexOf("·") > 0) {
    if (!t.settingsChanged) {
      warn.push("点了设置项「" + t.want + "」但设置值没变（" +
        JSON.stringify(t.settingsBefore) + "）");
    }
  }
  const onRightScreen = (wantRevive && t.stateBefore === "over") ||
                        (wantDouble && t.stateBefore === "win") ||
                        (wantBoost && t.stateBefore === "playing");
  if (onRightScreen && !a.capable && t.found) warn.push("宿主无广告能力却摆了广告按钮");
  if (onRightScreen && a.capable && !t.found) warn.push("宿主有广告能力却没摆出「" + t.want + "」按钮");
  if (isRevive && a.mode !== "skip") {
    if (!t.revived) warn.push("按了复活但状态没回到 playing（" + t.stateBefore + "→" + t.stateAfter + "）");
    if (t.consumed !== 1) warn.push("复活次数没有正好扣 1（" + t.reviveBefore + "→" + t.reviveAfter + "）");
    if (!t.hpRefilled) warn.push("复活后血量未满（" + t.hpAfter + "/" + t.maxHp + "）");
  }
  if (isRevive && a.mode === "skip") {
    if (t.stateAfter !== "over") warn.push("广告没看完却复活了");
    if (t.consumed !== 0) warn.push("广告没看完却扣了次数");
  }
  if (isDouble && a.mode !== "skip" && t.coinsAfter !== t.coinsBefore * 2) {
    warn.push("按了翻倍但灵石没翻倍（" + t.coinsBefore + "→" + t.coinsAfter + "）");
  }
  if (isBoost && a.mode !== "skip" && !t.boostOn) {
    warn.push("按了神行符但 boostT 还是 " + t.boostAfter);
  }
  console.log("ad:", JSON.stringify(a), warn.length ? ("  ⚠ " + warn.join(" / ")) : "");
  if (t) console.log("ad.tags:", JSON.stringify(t.tags));
}
/* `?mguntil=` 自己报有没有走到。
   以前只有 state 一个读数，「到了目标」和「撞上 mgcap 被砍断」
   长得一模一样 —— 读的人得自己去比 steps 和 cap。同族问题见
   `?farm` 的墙上时间兜底：**被截断的样本必须能自证**。 */
if (d.until) {
  const u = d.until;
  const w = [];
  if (!u.reached) {
    w.push("?mguntil=" + u.target + " 没走到（实际 " + u.state + "，why=" + u.why
      + "，steps " + u.steps + "/" + u.capSteps + "），这一发没验到东西");
  }
  console.log("until:", JSON.stringify(u), w.length ? ("  ⚠ " + w.join(" / ")) : "");
}
/* 音频。以前这个子系统**零验证**：34 个调用点全都在代码里，
   但从来没人确认过任何一个音被调度出去。
   这一块能问出三类问题，每一类都曾经真的发生过（在别的项目里）：
     1. 上下文是从哪来的 —— 小游戏上必须是 'host'。
        走浏览器原生那条，等于真机那条路一次都没验到。
     2. 请求出去了没有 —— played/calls 的漏斗，以及 lastUnknown。
     3. 设置有没有落到总线上 —— buses 读的是 AudioParam，不是设置里的数。 */
/* safe() 把抛出来的异常记在 <key>Err 上。不报出来的话，
   表现是「这一项整个不见了」—— 和「这一项是 null」长得一模一样。 */
if (d.audioErr) console.log("audioErr:", d.audioErr);
if (d.audio) {
  const a = d.audio, w = [];
  const g = a.graph || {};
  /* 这一发有没有**全程**触摸（?mgtouch=1）。判据要靠它分流 ——
     见下面那段注释：音频上下文是懒解锁的，没触摸就不该建。 */
  const touchedPlay = !!(d.touch && d.touch.on === true);
  console.log("audio:", "factory", a.factory, "| ready", a.ready, "| via", a.via,
              "| musicOn", a.musicOn, "| played", a.played + "/" + a.calls,
              "| dropped", JSON.stringify(a.dropped),
              "| 全程触摸", touchedPlay);
  if (a.buses) console.log("  buses:", JSON.stringify(a.buses), "| ctx", a.ctxState, "@" + a.sampleRate);
  /* 必须打印 requested：它是音量那条断言的**唯一证据**。
     不打印的话，断言在 requested 缺失时会静默跳过，而 verdict 照样是 ok ——
     一次「什么都没验到」被记成了「验过了」。同族问题见 `?mguntil` 的
     reached 字段：**没验到东西必须自己说出来**。 */
  if (a.requested) console.log("  requested:", JSON.stringify(a.requested));
  if (a.graph) console.log("  graph:", JSON.stringify(a.graph));
  if (a.lastUnknown) w.push("调用了不存在的音效名「" + a.lastUnknown + "」");
  if (a.initError) w.push("音频上下文建不起来：" + a.initError);
  /* 播放请求抛异常：任何一条用例里都算 bug，和宿主给不给音频无关。 */
  if (a.dropped.error > 0) w.push(a.dropped.error + " 次播放请求抛了异常（lastError: " + a.lastError + "）");
  /* 不变量：调度出去过音，上下文就一定得是就绪的。 */
  if (a.played > 0 && !a.ready) w.push("调度了 " + a.played + " 个音，但上下文报的是未就绪");

  /* 这里曾经写错过一次，值得记下来：
     原来的判据是「factory 是 host ⇒ 上下文必须建起来」，跑全套时
     18 条里 10 条报了 ⚠ —— 而且全是跟音频无关的用例（广告、升级卡、暂停）。
     那不是产品坏了，是判据错了：**音频上下文是懒解锁的**，
     要等第一次用户手势才会建。没人摸屏幕的用例本来就不该建上下文，
     这时 played=0、请求全记 noCtx 是**正确行为**，不是故障。
     （ui-pause 那一发：跑 20 秒期间 ready=false、72 次请求全 noCtx；
      最后点「暂停」才 unlock → ready=true。数据完全正常。）

     所以判据必须先分清「这一发有没有真的全程触摸」：
       touch.on === true  ⇔  ?mgtouch=1，触摸从第 0 帧就压着
     只有这种情况才谈得上「上下文该建起来、音该响」。
     其余用例一律只做**与时机无关**的断言（异常、拼错的音效名、不变量）。 */
  if (a.factory === "host" && touchedPlay) {
    /* 全程走触摸 → 解锁必然发生过 → 上下文必须真的建起来、音必须真的响。 */
    if (!a.ready) w.push("全程走触摸、宿主也给了工厂，但上下文没建起来");
    else if (a.via !== "host") w.push("走的是 " + a.via + " 而不是宿主工厂");
    if (a.ready && a.played === 0) w.push("上下文就绪但一个音都没调度出去");
    if (a.graph && g.starts === 0) w.push("建了上下文但没有任何节点 start()");
    if (a.graph && g.connects === 0) w.push("建了上下文但没有任何节点 connect()");
  }
  if (a.factory === "host" && !touchedPlay) {
    /* 没全程触摸 → 上下文停在未解锁是预期的。唯一还能查的是：
       请求确实发生过（calls>0），且没有一条被算成 error/unknown。
       这条能抓到「音频调用点整段没被执行」这类退化。 */
    if (a.calls === 0) w.push("整局一个播放请求都没有 —— 音频调用点可能没被执行到");
  }
  if (a.factory === "none") {
    /* 宿主没给音频 → 必须安静降级，而且游戏不能崩。
       这一条不看触摸时机：没有工厂就永远建不起上下文。 */
    if (a.ready) w.push("宿主没给音频工厂，上下文却建起来了");
    if (a.played > 0) w.push("宿主没给音频工厂，却有 " + a.played + " 个音被调度出去");
    if (a.dropped.noCtx === 0 && a.calls > 0)
      w.push("宿主没给音频，却没有一次播放请求被记成 noCtx");
  }
  /* 音量条有没有真的落到总线上。
     「设置值变了」和「总线跟着变了」是两件事 —— 中间那一跳
     （Settings.apply → Audio.setVolume → 三条 GainNode）完全可以断。
     断了的症状是「音量条能拖，但声音没变化」，肉眼看不出来。

     证据从点击探针自己身上取：settingsAfter 和 requested 是同一发里的
     before/after 两端，链是闭合的。不要去别处取一个「当前设置」——
     那是两个不同时刻的读数拼起来的。

     还有一个更基本的问题：**断言跑没跑过，得看得见**。
     原来这一块只打印 verdict，ok 一个词同时代表
     「比对过且相等」和「条件没满足、整段跳过了」。
     下面那行 audio.volume 无条件打印，把两端数值摆出来。 */
  const t2 = d.ad && d.ad.tap;
  let volChecked = false;   // 音量条那条断言**到底跑没跑**，别让 ok 一词两义
  if (t2 && t2.found) {
    const isVol = t2.want === "总音量";
    let line;
    if (!isVol) {
      line = "（这一发点的是「" + t2.want + "」，不是音量条，本条不适用）";
    } else if (!a.requested) {
      line = "debugInfo() 没报 requested —— 没验到东西";
      w.push("点了音量条，但 debugInfo() 没报 requested —— 这一条没验到东西");
    } else if (!t2.settingsAfter) {
      line = "点击探针没带 settingsAfter —— 没验到东西";
      w.push("点击探针没带 settingsAfter —— 这一条没验到东西");
    } else {
      const want = t2.settingsAfter.master;
      volChecked = true;
      line = "滑条=" + want + " 总线=" + a.requested.master;
      if (Math.abs(a.requested.master - want) > 0.001) {
        line += "  ⚠ 对不上";
        w.push("音量条拖到 " + want + "，但音频总线收到的是 " + a.requested.master);
      } else {
        line += " ✓";
      }
    }
    console.log("  audio.volume:", line);
  }
  /* verdict 自报**这一发验到了什么**，不只是一个 ok。
     「比对过且相等」和「条件没满足、整段跳过」必须长得不一样 ——
     否则一个什么都没验到的用例会以通过的形式记进结论。 */
  if (w.length) {
    console.log("audio.verdict:", "  ⚠ " + w.join(" / "));
  } else {
    const parts = [];
    if (a.factory === "none") {
      parts.push("宿主无音频：已验安静降级（请求全记 noCtx、零异常）");
    } else if (touchedPlay) {
      parts.push("全程触摸：已验上下文来源与真实调度");
    } else {
      parts.push("未全程触摸：只验了与时机无关项（异常/音效名/不变量）");
    }
    parts.push(volChecked ? "音量条已比对" : "未触及音量条");
    console.log("audio.verdict:", "ok（" + parts.join("；") + "）");
  }
}
if (d.redrawProbe) console.log("redraw idle:", JSON.stringify(d.redrawProbe), "| live:", JSON.stringify(d.redrawProbeLive));
if (d.a11y) console.log("a11y:", JSON.stringify(d.a11y));
if (d.status) console.log("status:", JSON.stringify(d.status));
/* 设置项当前值。走查一直在算它（boot.js 的 out.settings），
   渲染脚本却从来没打印过 —— 于是「设置面板摆出来了」
   这一屏唯一的独立读数被丢掉了，只剩点击探针里的 before/after。 */
if (d.settings) console.log("settings:", JSON.stringify(d.settings));
console.log("query:", JSON.stringify(d.query));
'
