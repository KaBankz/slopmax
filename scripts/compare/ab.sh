#!/usr/bin/env bash
# One Rust proxy against another, for the gate each phase of
# ARCHITECTURE-NEXT.md must pass: two bench rigs (`cargo build --release
# --example bench` at two commits) behind one mock, the same oha loads
# interleaved round by round, CPU per request from /proc, memory and
# threads idle and after. Pinning as in compare.sh: the proxies share cores
# 0-1 (CPUs 0,1,4,5), the mock gets core 2, oha core 3.
#
#   ab.sh <rig a> <rig b> <out-dir> [rounds] [seconds]
#
# Each rig's environment passes through SLOPMAX_WORKERS (unset: one thread).
set -euo pipefail
a=$1 b=$2 out=$3 rounds=${4:-3} seconds=${5:-8}
mkdir -p "$out"
work=$(mktemp -d "$out/work.XXXX")
mock_port=9220 a_port=9221 b_port=9222
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work"/{a,b}
"$a" bodies "$work/bodies"
taskset -c 2,6 "$a" upstream "127.0.0.1:$mock_port" 2>/dev/null &
pids+=($!)
start() { # name rig port
  taskset -c "${PROXY_CPUS:-0,1,4,5}" env -i PATH=/usr/bin:/bin HOME="$work/$1" ${SLOPMAX_WORKERS:+SLOPMAX_WORKERS=$SLOPMAX_WORKERS} \
    "$2" proxy "127.0.0.1:$3" "http://127.0.0.1:$mock_port" "$work/$1/home" 2>"$work/$1.log" &
  pids+=($!)
}
start a "$a" $a_port
a_pid=$!
start b "$b" $b_port
b_pid=$!
for port in $a_port $b_port; do
  until curl -fs -o /dev/null "http://127.0.0.1:$port/healthz"; do sleep 0.05; done
done

mem() { # rss_kb hwm_kb pss_kb threads
  printf '%s %s %s %s\n' "$(awk '$1 == "VmRSS:" {print $2}' "/proc/$1/status")" \
    "$(awk '$1 == "VmHWM:" {print $2}' "/proc/$1/status")" \
    "$(awk '$1 == "Pss:" {print $2}' "/proc/$1/smaps_rollup")" \
    "$(awk '$1 == "Threads:" {print $2}' "/proc/$1/status")"
}
cpu() { awk '{print $14 + $15}' "/proc/$1/stat"; } # clock ticks, every thread
switches() { cat /proc/"$1"/task/*/status | awk '$1 == "voluntary_ctxt_switches:" {n += $2} END {print n}'; }

# Idle: settle, then count wake-ups (voluntary context switches over every
# thread) for 30 s.
sleep 5
a0=$(switches $a_pid) b0=$(switches $b_pid)
sleep 30
{
  echo "rss_kb hwm_kb pss_kb threads wakeups_per_s"
  echo "idle a $(mem $a_pid) $(awk -v n=$(($(switches $a_pid) - a0)) 'BEGIN {printf "%.2f", n / 30}')"
  echo "idle b $(mem $b_pid) $(awk -v n=$(($(switches $b_pid) - b0)) 'BEGIN {printf "%.2f", n / 30}')"
} >"$out/memory.txt"

loads=(
  "claude-small-c1 claude claude-small 1 -n2000"
  "claude-small-c32 claude claude-small 32 -z${seconds}s"
  "claude-large-c1 claude claude-large 1 -n300"
  "claude-large-c32 claude claude-large 32 -z${seconds}s"
  "codex-small-c32 codex codex-small 32 -z${seconds}s"
  "codex-large-c32 codex codex-large 32 -z${seconds}s"
)
path_of() { case $1 in claude) echo /v1/messages?beta=true ;; codex) echo /codex/responses ;; esac; }
port_of() { case $1 in a) echo $a_port ;; b) echo $b_port ;; esac; }
pid_of() { case $1 in a) echo $a_pid ;; b) echo $b_pid ;; esac; }

echo -e "round\tload\ttarget\tok\treq_s\tp50_ms\tp99_ms\tcpu_us_per_req" >"$out/loads.tsv"
for round in $(seq "$rounds"); do
  for spec in "${loads[@]}"; do
    read -r name agent body conc amount <<<"$spec"
    [[ -n "${ONLY:-}" && ! "$name" =~ $ONLY ]] && continue
    for target in a b; do
      pid=$(pid_of $target)
      before=$(cpu "$pid")
      headers=(-H 'authorization: Bearer bench' -H 'content-type: application/json')
      if [ "$agent" = claude ]; then
        headers+=(-H 'user-agent: claude-cli/2.1.287 (external, cli)' -H 'x-claude-code-session-id: bench')
      else headers+=(-H 'session_id: bench'); fi
      json=$(taskset -c 3,7 oha --no-tui --output-format json -m POST "${headers[@]}" -c "$conc" "$amount" \
        -D "$work/bodies/$body.json" "http://127.0.0.1:$(port_of $target)$(path_of $agent)")
      after=$(cpu "$pid")
      total=$(jq '[.statusCodeDistribution[]] | add' <<<"$json")
      cpu_per=$(awk -v t=$((after - before)) -v n="$total" 'BEGIN {printf "%.0f", t * 1e6 / 100 / n}')
      jq -r --arg r "$round" --arg n "$name" --arg t "$target" --arg c "$cpu_per" \
        '[$r, $n, $t, (.summary.successRate * 100 | floor), (.summary.requestsPerSec | floor),
          (.latencyPercentiles.p50 * 1e5 | floor / 100), (.latencyPercentiles.p99 * 1e5 | floor / 100), $c] | @tsv' \
        <<<"$json" >>"$out/loads.tsv"
      tail -1 "$out/loads.tsv"
    done
  done
done
{
  echo "after a $(mem $a_pid)"
  echo "after b $(mem $b_pid)"
} >>"$out/memory.txt"
cat "$out/memory.txt"
