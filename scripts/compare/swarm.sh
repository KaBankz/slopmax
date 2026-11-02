#!/usr/bin/env bash
# Many agents at once through each target: the mock alone, `bench raw` (the
# floor), and the proxy with each runtime in WORKERS. Each session streams
# answers back to back, paced like a model, with a real-size request body.
#
#   swarm.sh <bench rig> <out-dir> [sessions] [seconds] [body] [pace-ms]
#
# WORKERS="1 auto" by default (SLOPMAX_WORKERS values; 1 is one thread).
# Pinning: proxies on cores 0-1 (CPUs 0,1,4,5), mock on core 2, agents on 3.
set -euo pipefail
rig=$1 out=$2 sessions=${3:-300} seconds=${4:-20} body=${5:-claude-large} pace=${6:-20}
mkdir -p "$out"
work=$(mktemp -d "$out/work.XXXX")
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
"$rig" bodies "$work/bodies"
ulimit -n 65536 2>/dev/null || true
taskset -c 2,6 "$rig" upstream 127.0.0.1:9230 2>/dev/null &
pids+=($!)
up() { until curl -fs -o /dev/null "http://127.0.0.1:$1/healthz" 2>/dev/null || curl -s -o /dev/null "http://127.0.0.1:$1/"; do sleep 0.05; done; }
cpu() { awk '{print $14 + $15}' "/proc/$1/stat"; }
up 9230
swarm() { # name url pid
  local before=0 after=0
  [ -n "$3" ] && before=$(cpu "$3")
  echo "== $1" | tee -a "$out/swarm.txt"
  taskset -c 3,7 "$rig" swarm "$2" "$sessions" "$seconds" "$work/bodies/$body.json" "$pace" | tee -a "$out/swarm.txt"
  if [ -n "$3" ]; then
    after=$(cpu "$3")
    echo "proxy cpu ${1}: $(awk -v t=$((after - before)) -v s="$seconds" 'BEGIN {printf "%.0f%% of one CPU", t / s}') rss $(awk '$1 == "VmHWM:" {print $2}' /proc/$3/status) kB peak" | tee -a "$out/swarm.txt"
  fi
}
swarm mock http://127.0.0.1:9230 ""
taskset -c "${PROXY_CPUS:-0,1,4,5}" "$rig" raw 127.0.0.1:9231 http://127.0.0.1:9230 &
pid=$!; pids+=($pid); up 9231
swarm raw http://127.0.0.1:9231 $pid
kill $pid
port=9232
for workers in ${WORKERS:-1 auto}; do
  mkdir -p "$work/p$port"
  taskset -c "${PROXY_CPUS:-0,1,4,5}" env -i PATH=/usr/bin:/bin HOME="$work/p$port" SLOPMAX_WORKERS="$workers" \
    "$rig" proxy "127.0.0.1:$port" http://127.0.0.1:9230 "$work/p$port/home" 2>"$work/p$port.log" &
  pid=$!; pids+=($pid); up $port
  swarm "proxy workers=$workers" "http://127.0.0.1:$port" $pid
  kill $pid
  port=$((port + 1))
done
