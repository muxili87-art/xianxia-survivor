#!/bin/zsh
# 小游戏**交互回归**：把「玩家真的会点的地方」逐个点一遍，验状态迁移。
#
# 为什么需要它：
#   走查一直是「跑到某一屏 → 截图 → 看一眼」。那些截图证明了
#   **面板画得出来**，但一次都没证明**按下去有用** ——
#   机器人走的是 API 直调（XS.UI.pickCard / debugScreen），
#   而玩家的手指走的是 hit() 里注册的回调。两条路不同，
#   于是「按钮画得出来、按下去没反应」这类 bug 可以一路活到线上。
#   已经抓到过三个：结算页的复活按钮、小游戏上根本不存在的神行符、
#   以及升级三选一（走的是 S.cardPick 直调，和机器人的 pickCard 不是一条）。
#
# 用法: tools/verify-mg.sh [过滤词]
#   tools/verify-mg.sh            # 全跑
#   tools/verify-mg.sh ad         # 只跑广告点位
#   tools/verify-mg.sh ui         # 只跑 UI 交互
#
# 判读：⚠ 里带「没验到东西」的算 SKIP（机器人这一局没走到那一屏，
# 比如 ?mguntil=over 那一发没死）——**不算通过也不算失败**。
# 其余 ⚠ 与运行期异常都算 FAIL。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILTER="${1:-}"
PASS=0; FAIL=0; SKIP=0; RAN=0

case_run() {
  local name="$1" query="$2" budget="${3:-60000}"
  if [ -n "$FILTER" ] && [ "${name#$FILTER}" = "$name" ]; then return; fi
  RAN=$((RAN+1))
  local out hard soft
  out="$(tools/render-mg.sh "/tmp/mg-verify-$name.png" "$budget" "$query" 2>&1)"
  # 运行期异常（ReferenceError 之类）是最硬的一类失败：整个走查在
  # 渲染循环启动前就抛了，表现却是 frozen:false / tap:null，
  # 看着像「参数没生效」。必须单独抓。
  hard="$(printf '%s' "$out" | grep -E 'BUNDLE RUN FAILED|SIM ERRORS:' || true)"
  soft="$(printf '%s' "$out" | grep -E '  ⚠ ' || true)"
  local real
  real="$(printf '%s' "$soft" | grep -v '没验到东西' || true)"
  if [ -n "$hard" ] || [ -n "$real" ]; then
    echo "✗ $name    $query"
    [ -n "$hard" ] && printf '%s\n' "$hard" | sed 's/^/     /'
    [ -n "$real" ] && printf '%s\n' "$real" | sed 's/^/     /'
    FAIL=$((FAIL+1))
  elif [ -n "$soft" ]; then
    echo "○ $name    （这一局没走到目标状态，SKIP）"
    SKIP=$((SKIP+1))
  else
    echo "✓ $name"
    PASS=$((PASS+1))
  fi
}

# ---------- 广告点位：宿主能力 × 按钮是否存在 × 按下去有没有用 ----------
# 「无 API」那几条是**反向断言**：按钮清单里必须没有它。
case_run ad-revive-none "?mguntil=over&mgcap=600&mgskill=0&mgtap=复活" 90000
case_run ad-revive-ok   "?mguntil=over&mgcap=600&mgskill=0&mgad=ok&mgtap=复活" 90000
case_run ad-revive-skip "?mguntil=over&mgcap=600&mgad=skip&mgtap=复活" 90000
case_run ad-boost-none  "?mgplay=100&mgtap=神行符" 60000
case_run ad-boost-ok    "?mgplay=100&mgad=ok&mgtap=神行符" 60000
# 通关是概率事件，这一条经常 SKIP —— 补跑几次直到出现 ✓ 为止。
case_run ad-double-ok   "?mguntil=win&mgcap=600&mgmeta=max&mgad=ok&mgtap=翻倍" 90000

# ---------- UI 交互：每局都会点、但以前从来没被点过的那些 ----------
case_run ui-card1       "?mguntil=levelup&mgtap=升级卡1" 40000
case_run ui-card2       "?mguntil=levelup&mgtap=升级卡2" 40000
case_run ui-card3       "?mguntil=levelup&mgtap=升级卡3" 40000
case_run ui-pause       "?mgplay=30&mgtap=暂停" 40000
case_run ui-quality     "?mgplay=20&mgui=settings&mgtap=画质·低" 40000
case_run ui-a11y        "?mgplay=20&mgui=settings&mgtap=色盲辅助·开启" 40000
case_run ui-volume      "?mgplay=20&mgui=settings&mgtap=总音量" 40000

# ---------- 音频：这个子系统以前**一条验证都没有** ----------
# 34 个调用点全都在代码里写得整整齐齐，但从来没人确认过任何一个音
# 被调度出去。而且它藏着一个只在真机上才炸的 P0：
# `enabled` 从没声明过，严格模式下**读**就抛 ReferenceError ——
# 玩家第一次触摸会解锁音频（ready=true），随后第一次挥剑就崩。
# 两个走查各自因为**不同**的原因短路掉了这条路：
# Web 侧机器人从不点击，小游戏侧假 window 上没有 AudioContext。
# 所以这里必须**走触摸**（mgtouch）才能把 unlock 触发到。
case_run audio-host    "?mgplay=25&mgtouch=1" 40000
case_run audio-none    "?mgplay=25&mgtouch=1&mgaudio=none" 40000
case_run audio-volume  "?mgplay=20&mgui=settings&mgaudio=host&mgtouch=1&mgtap=总音量" 40000

# ---------- 局外成长：商店购买是本项目里唯一「花钱并写存档」的事务 ----------
# 走查一直是「?mgmeta=max 把档位拉满 + 把商店摆出来看一眼」，从没买过。
# expect=change / none 显式写在查询串里 —— 买得起该扣钱、买不起不该扣钱
# 是两条**相反**的断言，看结果反推不出来。
case_run meta-buy-ok    "?mgplay=20&mggrant=5000&mgui=meta&mgtap=淬体&mgtapExpect=change" 60000
case_run meta-buy-poor  "?mgplay=20&mgui=meta&mgtap=淬体&mgtapExpect=none" 60000

echo ""
echo "共 $RAN 条：通过 $PASS，失败 $FAIL，跳过 $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
