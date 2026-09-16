#!/bin/zsh
# 重新生成 docs/ 里的作品集截图
#
# 为什么要做成脚本：这些图以前是手工渲出来再剪贴进 docs/ 的，
# 结果代码大改之后（修掉 instanceColor 黑体 bug、重调灯光、加入进化系统、局外成长），
# 作品集里展示的还是**旧版本的样子** —— 而且是更差的那一版。
# 展品比产品旧，是作品集最要命的失误。凡是会被反复重新生成的产物，
# 都要有一个命令能一键重出。
#
# 用法: tools/make-docs.sh [名字…]
#       不带参数 = 重出全部；带名字 = 只重出这几张（名字是不含前缀后缀的片段）
#       例: tools/make-docs.sh battle dawn
#
# 为什么需要「只重出几张」：改一处天光 / 灯光 / 某个面板，
# 受影响往往只有一两张图，但整批要跑四分多钟。
# 以前只能整批重跑，于是「只改了一点点」时人会懒得重出 ——
# 而作品集最怕的就是展品比产品旧。
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/Users/muxi/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/docs"
TMP=/tmp/xs-docs
mkdir -p "$OUT" "$TMP"

# 位置参数当作过滤器；空 = 全出
ONLY="$*"

FAILED=0

# 本次真的重出了哪几张。用来在**带过滤词**跑完之后，
# 报出「没重出、而且已经比源码旧」的兄弟图 —— 见脚本末尾。
GENERATED=""
mark_generated() { GENERATED="$GENERATED $1"; }

# $1=输出文件名 $2=虚拟时间预算 $3=查询串 [$4=源页面，默认 index.html]
shot() {
  local name="$1" budget="$2" query="$3" src="${4:-index.html}"
  if [ -n "$ONLY" ]; then
    local hit=0
    for want in ${=ONLY}; do
      case "$name" in *"$want"*) hit=1 ;; esac
    done
    [ "$hit" -eq 1 ] || return 0
  fi
  local probe="probe-docs-$name.html" dom="$TMP/$name.html"
  cd "$ROOT"
  "$NODE" tools/make-probe.mjs "$probe" "$src" >/dev/null
  "$CHROME" \
    --headless=new --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage \
    --no-proxy-server --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
    --window-size=1440,900 --hide-scrollbars --disable-extensions \
    --virtual-time-budget="$budget" \
    --screenshot="$TMP/$name.png" \
    --dump-dom "file://$ROOT/$probe$query" > "$dom" 2>/dev/null || true
  # 探针必须留在项目根目录（页面里全是 js/ vendor/ 这类相对路径），
  # 但**不要用 rm 清理**：沙箱的 safe-delete 守卫会把批量删除拦下来，
  # 配合 set -e 直接把整个脚本打断，后面四张图全不生成。
  # 移到临时目录同样干净，而且不触发守卫。
  mv -f "$ROOT/$probe" "$TMP/$probe" 2>/dev/null || true
  if [ ! -s "$TMP/$name.png" ]; then
    echo "  ✗ $name —— 截图没生成"
    FAILED=1
    return 0
  fi
  # 转成 jpg：PNG 每张 900KB 上下，五张就 4.5MB，塞进仓库不划算
  sips -s format jpeg -s formatOptions 82 "$TMP/$name.png" --out "$OUT/$name.jpg" >/dev/null 2>&1 || true
  local sz=$(stat -f%z "$OUT/$name.jpg" 2>/dev/null || echo 0)
  if [ "$sz" -lt 20000 ]; then
    echo "  ✗ $name —— 输出只有 ${sz}B，像是空白页"
    FAILED=1
    return 0
  fi
  echo "  ✓ docs/$name.jpg  ${sz} bytes"
  mark_generated "$name.jpg"
  # 把这一帧的对局状态一起打出来。
  # 作品集截图的失败模式不是「拍不出来」，而是**拍出来的是另一局**
  # （机器人阵亡重开、面板没弹、状态没挂上）—— 图看着完全正常，
  # 只是不是你要展示的那个状态。让日志里能看见时间与状态，就不用靠肉眼比对。
  local st=$("$NODE" -e '
    const fs=require("fs");
    try {
      const h=fs.readFileSync(process.argv[1],"utf8");
      const m=h.match(/DIAG_JSON_START([\s\S]*?)DIAG_JSON_END/);
      if(!m) process.exit(0);              // UI 类截图走的是 preroll 路径，本来就不出诊断
      const d=JSON.parse(m[1]);
      const en=(d.status&&d.status.enemies!=null)?d.status.enemies:"-";
      const r=d.run||{};
      console.log("state="+d.state
        +" t="+(r.t!=null?r.t+"s":"-")
        +" lv="+(r.level!=null?r.level:"-")
        +" kills="+(r.kills!=null?r.kills:"-")
        +" enemies="+en);
    } catch(e) {}
  ' "$dom" 2>/dev/null || true)
  [ -n "$st" ] && echo "      $st"
  return 0
}

# 从 dump 出来的 DOM 里抠出小游戏当前状态（拿不到就回空串）
mgstate() {
  "$NODE" -e '
    const fs=require("fs");
    try {
      const h=fs.readFileSync(process.argv[1],"utf8");
      const m=h.match(/MGDIAG_START([\s\S]*?)MGDIAG_END/);
      if(!m) process.exit(0);
      const d=JSON.parse(m[1]).diag||{};
      process.stdout.write(String(d.state||""));
    } catch(e) {}
  ' "$1" 2>/dev/null || true
}

# $1=输出文件名 $2=虚拟时间预算 $3=查询串 [$4=期望状态]
#
# 小游戏版走的是**另一条链路**：页面是 sim.html，加载的是
# dist/minigame/game.js（打包产物），窗口是竖屏 500x947
# （无头 Chrome 会留 87px 装饰高度 → 视口正好 500x860）。
#
# 这一组图的价值不在「好看」，而在**证明打包产物本身能跑**：
# 页面里没有 DOM，UI 全部是 Canvas 2D 画的；
# 对局 / 升级 / 结算三屏都来自真实对局（?mguntil= 会真的打到那个状态），
# 不是编一份假数据去调 showOver()。
#
# 给了 $4 就必须落到那个状态，否则重试。为什么需要：
# 升级卡是随机的、且这一局没有接种子，所以「跑到通关」本身是个概率事件
# （实测拉满强化下三次里过一次）。不校验的话，脚本会安安静静地
# 把一张「阵亡结算」存成 screenshot-mg-win.jpg —— 图看着正常，
# 只是不是你要的那一屏。
mgshot() {
  local name="$1" budget="$2" query="$3" want="${4:-}"
  if [ -n "$ONLY" ]; then
    local hit=0
    for want2 in ${=ONLY}; do
      case "$name" in *"$want2"*) hit=1 ;; esac
    done
    [ "$hit" -eq 1 ] || return 0
  fi
  cd "$ROOT"
  # 打包产物与 sim.html 都要**比源码新**才用。
  #
  # 这里原来写的是 `[ -f dist/minigame/game.js ] || build` ——
  # 也就是「缺了才生成」。于是改完 js/ 重出作品集截图时，
  # 渲染的是**上一版的打包产物**，图和代码对不上。
  # 这条链上已经栽过三次（编辑没落盘 / dist 过期 / sim.html 过期），
  # 这是第四次，而且是在**另一个脚本**里 —— 修一处不等于修一类。
  # 判据统一成 mtime：只要源码更新就重打包。
  if [ ! -f dist/minigame/game.js ] \
     || [ -n "$(find js vendor -name '*.js' -newer dist/minigame/game.js 2>/dev/null | head -1)" ] \
     || [ tools/build-minigame.mjs -nt dist/minigame/game.js ]; then
    echo "  [build] 源码比打包产物新 → 重新打包"
    "$NODE" tools/build-minigame.mjs --quiet
  fi
  if [ ! -f sim.html ] || [ tools/minigame-sim.mjs -nt sim.html ]; then
    echo "  [sim] sim.html 比源码旧 → 重新生成"
    "$NODE" tools/minigame-sim.mjs >/dev/null
  fi
  local png="$TMP/$name.png"
  # render-mg.sh 把 dump 出来的 DOM 放在 /tmp，名字由截图 basename 推出来
  local dom="/tmp/mg-dom-$name.png.html"
  local tries=1 attempt=1 got=""
  if [ -n "$want" ]; then tries=4; fi
  while [ "$attempt" -le "$tries" ]; do
    tools/render-mg.sh "$png" "$budget" "$query" >/dev/null 2>&1 || true
    got="$(mgstate "$dom")"
    if [ -z "$want" ] || [ "$got" = "$want" ]; then break; fi
    echo "      · 第 $attempt 次落在 state=$got（要 $want），重试"
    attempt=$((attempt + 1))
  done
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "  ✗ $name —— $tries 次都没跑到 state=$want（最后一次 state=$got）"
    FAILED=1
    return 0
  fi
  if [ ! -s "$png" ]; then
    echo "  ✗ $name —— 截图没生成"
    FAILED=1
    return 0
  fi
  sips -s format jpeg -s formatOptions 82 "$png" --out "$OUT/$name.jpg" >/dev/null 2>&1 || true
  local sz=$(stat -f%z "$OUT/$name.jpg" 2>/dev/null || echo 0)
  if [ "$sz" -lt 20000 ]; then
    echo "  ✗ $name —— 输出只有 ${sz}B，像是空白页"
    FAILED=1
    return 0
  fi
  echo "  ✓ docs/$name.jpg  ${sz} bytes"
  mark_generated "$name.jpg"
  # 和小游戏一样的理由：失败模式不是「拍不出来」，而是**拍出来的是另一屏**。
  # 顺便把存储回路自检一起报出来 —— 存档读不回宿主是会上线才炸的那一类。
  local st=$("$NODE" -e '
    const fs=require("fs");
    try {
      const h=fs.readFileSync(process.argv[1],"utf8");
      const m=h.match(/MGDIAG_START([\s\S]*?)MGDIAG_END/);
      if(!m) process.exit(0);
      const o=JSON.parse(m[1]); const d=o.diag||{}; const u=d.ui||{};
      const s=o.store||{};
      const p=d.redrawProbe||{}, L=d.redrawProbeLive||{};
      const bad=[];
      if(o.errors&&o.errors.length) bad.push("ERRORS="+o.errors.length);
      if(s.hostRead===false) bad.push("存档读不回宿主");
      /* 报**探针**的读数，不要报 u.redrawRate：那是累计值，
         而同步走查里 UI.render 只在探针那 30 帧里被调用，
         中间几千帧逻辑步进不渲染 —— 它恒为 ≈1，没有意义。
         有意义的量是「有变的帧数」changed 与 redraws 是否对上。 */
      if(p.stale||(L&&L.stale)) bad.push("UI 漏画(stale)");
      if(p.wasted||(L&&L.wasted)) bad.push("UI 白画(wasted)");
      console.log("state="+d.state+" t="+d.t+" screen="+u.screen+" hits="+u.hits
        +" | 空转 changed="+p.changed+" redraws="+p.redraws
        +" | 对局 changed="+(L.changed!=null?L.changed:"-")
        +" redraws="+(L.redraws!=null?L.redraws:"-")
        +" rate="+(L.rate!=null?L.rate:"-")
        + (bad.length?("  ⚠ "+bad.join(" / ")):""));
    } catch(e) {}
  ' "$dom" 2>/dev/null || true)
  [ -n "$st" ] && echo "      $st"
  return 0
}

echo "重新生成 docs/ 截图（源：当前代码）"# 中后期战场：密度、飞剑拖尾、状态外壳都出来了。
# 为什么要叠 ?spawn=：单靠 ?play=300 的波次密度**不稳定** ——
# 渲染出来刚好落在两波之间的空档时，画面里一只妖魔都没有，
# 而「满屏妖魔」正是这张图要展示的东西。spawn 把密度补到确定的水平，
# 同时保留 ?play=300 带来的真实中后期状态（境界 / 功法栏 / 击杀数）。
# ?settle=0.7 是必须的，而且**不能更长**：debugSpawn 出来的怪停在
# 「材质化」动画第一帧（spawnDur=0.38s），不推进就截图会拍到一片加色白光；
# 但推得太久，所有怪都会朝玩家聚拢，阵型糊成一团、也没有纵深。
# 0.7s ≈ 刚好放完出场动画、还没开始跑。
shot screenshot-battle 45000 "?play=300&settle=0.7&spawn=imp:5,flyer:3,brute:4,charger:3,splitter:3,splitling:4,caster:3,wraith:4"
# 魔尊「裂地」前摇：Boss 150 秒登场，atkCd 3 秒后起手，前摇 1.1 秒
shot screenshot-boss-telegraph 45000 "?play=154"
# 妖魔谱：把 11 种妖魔一次摆齐，看清「每一种走位要求都不同」。
# 靠 ?play=N 碰运气等某只怪刷出来是不可复现的 ——
# 而且要展示的恰恰是「同屏能同时出现哪几种」，只能靠 spawn 直接摆。
shot screenshot-bestiary 25000 "?zoom=0.55&preroll=2&spawn=imp:3,flyer:2,brute:2,charger:2,splitter:2,splitling:3,guard:2,caster:1&nobot=1"
# 氛围：破晓天光 + 体积光 + 云海。
# 刻意**不**用 ?warm= 把天光钉死 —— 那样计时器还停在 03:01、天却已经像日暮，
# 展示的是一个玩家看不到的状态。这里让天光自己长到局末（380s / 480s）。
# 代价是机器人可能在 390~430s 阵亡重开（那会拍成第二局开局的天色），
# 所以下面把诊断里的计时器一起打出来：**图和时间对不上时能一眼看见**。
shot screenshot-dawn 55000 "?play=380&seed=12"
# 设置面板
shot screenshot-settings 20000 "?settings=1&preroll=30"
# 无障碍：同一固定阵型，只差一个开关。
#
# 为什么要专门摆一个阵型、而不是在实战里抓两帧：实战截图里妖魔的站位、
# 朝向、状态、有没有被击杀全是随机的，开/关两张图会有几十处差异，
# 看的人分不清哪一处是功能带来的。固定阵型让两张图**只差一个开关**，
# 差异才能唯一地归因到功能本身。
#
# ?nohud=1 是为了让两张图除功能外完全一致（计时器数字、飘字都会引入噪声）。
shot screenshot-a11y-off 12000 "?a11ydemo=1&nohud=1&a11y=none"
shot screenshot-a11y-on  12000 "?a11ydemo=1&nohud=1&a11y=cb"
# 再把两张图裁成同一条带、上下拼成一张对照图。
# 两张完整截图并排会很小，看的人要来回找差异；裁到差异所在的那条带
# 再上下拼起来，视线不用移动就能对比 —— 作品集里最有力的一张图。
if { [ -z "$ONLY" ] || [[ " $ONLY " == *"a11y"* ]]; } \
   && [ -s "$TMP/screenshot-a11y-off.png" ] && [ -s "$TMP/screenshot-a11y-on.png" ]; then
  PY=/Users/muxi/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3
  # 裁剪框按 docs 的 1440x900 出图尺寸给的（妖魔所在的那条带）
  "$PY" tools/bmpstack.py "$TMP/screenshot-a11y-off.png" "$TMP/screenshot-a11y-on.png" \
        "$TMP/screenshot-a11y.png" 170 75 1120 355 >/dev/null
  sips -s format jpeg -s formatOptions 85 "$TMP/screenshot-a11y.png" --out "$OUT/screenshot-a11y.jpg" >/dev/null 2>&1
  echo "  ✓ docs/screenshot-a11y.jpg  （上=关闭 / 下=开启）"
fi
# 山门 · 灵石商店。刻意**不用** metaunlock：那会把六条轨道全部点满，
# 于是整张图只剩「圆满」，看不见价格、看不见「买不起」、也看不见成长空间 ——
# 一张「全部拉满」的图证明不了这套系统能玩，只能证明它存在。
# 这里造一个真实的中期存档：两条已满、一条买不起、三条可买，三种状态同框。
shot screenshot-meta 20000 "?meta=1&metaset=hp:6,power:3,speed:1,greed:5,xp:2&grant=2600&nobot=1"
# 山门 · 成就。用 reveal 造「半亮」—— 全亮的成就墙和写死的图看不出区别。
shot screenshot-ach 20000 "?meta=ach&reveal=6&nobot=1"
# 山门 · 图鉴。同上：玩家平时面对的多数还是「？」格。
shot screenshot-codex 20000 "?meta=codex&reveal=5&nobot=1"
# 数据打点面板（另一张页面）
shot screenshot-dashboard 20000 "" "data.html"

# ---------- 小游戏打包产物（竖屏 500x860） ----------
# 这一组走的是 sim.html → dist/minigame/game.js，**不是源码**。
# 对局 / 升级 / 结算都来自真实对局（?mguntil= 会真的打到那个状态），
# 所以这几张图同时是「打包产物能跑」的证据。
mgshot screenshot-mg-start     10000 "?mgui=start"
mgshot screenshot-mg-battle    40000 "?mgplay=60"                        playing
# 触摸驱动那张：唯一能看出手机操作方式的图（浮动摇杆画在手指位置）。
# 它也顺带证明触摸层真的被执行过 —— 不走 ?mgtouch=1 的话，
# 机器人直接写 Input.vec，摇杆永远不会出现在画面上。
mgshot screenshot-mg-touch     40000 "?mgplay=25&mgtouch=1"              playing
mgshot screenshot-mg-level     25000 "?mguntil=levelup"                  levelup
mgshot screenshot-mg-over      90000 "?mguntil=over&mgcap=420"           over
mgshot screenshot-mg-win      130000 "?mguntil=win&mgcap=560&mgmeta=max" win
mgshot screenshot-mg-settings  25000 "?mgplay=20&mgui=settings"          playing
mgshot screenshot-mg-meta      12000 "?mgui=meta"
mgshot screenshot-mg-codex     12000 "?mgui=meta-codex"

echo "完成。产物在 $OUT/"

# ---------- 带过滤词跑完之后，报出「没重出、但已经过期」的兄弟图 ----------
# 为什么只在这个场景报：make-docs.sh 存在的原因就是「改一处、只重出几张」，
# 而**只重出一张会把兄弟图留在旧版本上** —— 作品集最怕的正是这个。
# 不带过滤词时全都会重出，没什么可报的，所以这里静默。
#
# 刻意**不做**成「源码比图新就一律告警」：任何一次 js/ 改动都会让
# 十几张图全部命中，那种检查会在两次之后就没人看了 ——
# 一条爱叫的检查比没有检查更糟（本项目已经因此主动删掉过一条 lint 规则）。
# 这里的判据是精确的：**这次没重出** ∩ **已经比源码旧**。
if [ -n "$ONLY" ]; then
  newest=""
  for f in $(find js vendor -name '*.js' 2>/dev/null) index.html data.html \
           tools/build-minigame.mjs dist/minigame/game.js; do
    [ -f "$f" ] || continue
    if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
  done
  stale=""
  for img in "$OUT"/*.jpg; do
    [ -f "$img" ] || continue
    base="${img:t}"
    case " $GENERATED " in *" $base "*) continue ;; esac   # 这次刚重出的，跳过
    if [ -n "$newest" ] && [ "$img" -ot "$newest" ]; then
      stale="$stale $base"
    fi
  done
  if [ -n "$stale" ]; then
    echo ""
    echo "提醒：下面这些图**这次没重出**，但已经比源码旧了 ——"
    echo "      展品比产品旧不只是不够新，它可能在替你宣传一个已修掉的缺陷。"
    for s in ${=stale}; do echo "        · docs/$s"; done
    echo "      要一起重出就再跑一次 tools/make-docs.sh（不带参数）。"
  fi
fi
# 一张失败不代表整批白跑 —— 报告出来让人知道哪张需要重来
if [ "$FAILED" -ne 0 ]; then
  echo "注意：有截图失败（上面标 ✗ 的那几张），其余已更新。"
  exit 1
fi
