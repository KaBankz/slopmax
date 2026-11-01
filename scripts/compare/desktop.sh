#!/usr/bin/env bash
# One desktop app's memory and idle CPU under Xvfb (no GPU: Mesa's llvmpipe
# for GPUI, software compositing for Electron), against its own demo daemon
# with fake accounts. Every process of the app is summed (RSS and PSS from
# smaps_rollup); the daemon is the demo's, outside the app, and measured too.
#
#   desktop.sh rust|ts <repo> <app binary> <out-dir>
set -euo pipefail
kind=$1 repo=$2 app=$3 out=$4
work=$(mktemp -d "$out/work.XXXX")
display=:77 upstream_port=9230 demo_port=9231
pids=()
cleanup() {
  [ -n "${app_pid:-}" ] && kill -- "-$app_pid" 2>/dev/null || true
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

Xvfb $display -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
pids+=($!)
sleep 1

# The demo prints the exports an app needs, then serves until stopped.
if [ "$kind" = rust ]; then
  UPSTREAM_PORT=$upstream_port DEMO_PORT=$demo_port setsid "$repo/scripts/demo.sh" >"$work/demo.out" 2>&1 &
else
  (cd "$repo/ts" && UPSTREAM_PORT=$upstream_port DEMO_PORT=$demo_port exec setsid bun tools/bench/src/main.ts demo) \
    >"$work/demo.out" 2>&1 &
fi
demo_pid=$!
pids+=("$demo_pid")
for _ in $(seq 1200); do curl -fs -o /dev/null "http://127.0.0.1:$demo_port/healthz" && grep -q "SLOPMAX_HOME=" "$work/demo.out" && break; sleep 0.1; done
exports=$(grep -oE '(SLOPMAX_[A-Z_]+|CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_CONFIG_HOME)=[^ ]+' "$work/demo.out" | sort -u)
echo "$exports" >"$out/$kind-env.txt"
daemon=$(ss -ltnp | grep ":$demo_port " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)

# The app in a session of its own, so all of its processes can be found and stopped.
# shellcheck disable=SC2086
env -i PATH=/usr/bin:/bin HOME="$work/home" DISPLAY=$display $exports SLOPMAX_NO_SERVICE=1 \
  setsid "$app" >"$work/app.log" 2>&1 &
app_pid=$!
tree() { ps -e -o pid=,sid= | awk -v s="$app_pid" '$2 == s {print $1}'; }
sum() { # rss_kb pss_kb processes
  local rss=0 pss=0 n=0 p
  for p in $(tree); do
    [ -r "/proc/$p/smaps_rollup" ] || continue
    rss=$((rss + $(awk '$1 == "Rss:" {print $2}' "/proc/$p/smaps_rollup")))
    pss=$((pss + $(awk '$1 == "Pss:" {print $2}' "/proc/$p/smaps_rollup")))
    n=$((n + 1))
  done
  echo "rss_kb=$rss pss_kb=$pss processes=$n"
}
ticks() { local t=0 p; for p in $(tree); do t=$((t + $(awk '{print $14 + $15}' "/proc/$p/stat" 2>/dev/null || echo 0))); done; echo $t; }

start=$(date +%s%N)
viewable() { # a window named slopmax that is mapped (Electron creates its window hidden, then shows it)
  local id
  for id in $(xwininfo -display $display -root -tree 2>/dev/null | grep -iE '"slopmax' | awk '{print $1}'); do
    xwininfo -display $display -id "$id" 2>/dev/null | grep -q IsViewable && return 0
  done
  return 1
}
until viewable; do
  sleep 0.02
  [ $((($(date +%s%N) - start) / 1000000)) -gt 30000 ] && break
done
window_ms=$((($(date +%s%N) - start) / 1000000))
sleep 20
first=$(ticks)
sleep 10
cpu=$(awk -v t=$(($(ticks) - first)) 'BEGIN {printf "%.1f", t / 10}') # % of one CPU over 10 s
import -display $display -window root "$out/$kind-window.png"
{
  echo "$kind window_ms=$window_ms (first viewable window named slopmax)"
  echo "$kind app $(sum) idle_cpu_pct=$cpu"
  echo "$kind daemon pid=$daemon rss_kb=$(awk '$1 == "Rss:" {print $2}' /proc/$daemon/smaps_rollup) pss_kb=$(awk '$1 == "Pss:" {print $2}' /proc/$daemon/smaps_rollup)"
  ps -o pid=,rss=,args= -s "$app_pid" | cut -c1-150
} | tee "$out/$kind-desktop.txt"
