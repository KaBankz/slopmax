#!/usr/bin/env bash
# Rust vs TypeScript slopmax, one harness for both: the same mock provider
# (the Rust rig's, so the mock costs the same for each), the same bodies, the
# same oha loads, interleaved round by round. This host has 4 physical cores
# (CPUs n and n+4 are siblings): the proxies get cores 0-1 (CPUs 0,1,4,5), the mock core 2 (2,6) and oha core 3 (3,7).
# Each proxy's CPU time per request comes from /proc.
#
#   compare.sh <repo> <bin-dir> <out-dir> [rounds] [seconds]
set -euo pipefail
repo=$1 bin=$2 out=$3 rounds=${4:-3} seconds=${5:-8}
rust_rig=$repo/target/release/examples/bench
ts_rig=$bin/rig
ts_raw=$bin/raw
work=$(mktemp -d "$out/work.XXXX")
mock_port=9210 rust_port=9211 ts_port=9212 raw_port=9213
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

sandbox() { # the environment every process under test sees
  local home=$1
  exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$home" SLOPMAX_HOME="$home/.slopmax" \
    CLAUDE_CONFIG_DIR="$home/.claude" CODEX_HOME="$home/.codex" XDG_CONFIG_HOME="$home/.config" \
    SLOPMAX_NO_SERVICE=1 SLOPMAX_CLIPROXYAPI_PORT=9 NO_COLOR=1 "${@:2}"
}

mkdir -p "$work"/{rust,ts,raw}
"$rust_rig" bodies "$work/bodies"
taskset -c 2,6 "$rust_rig" upstream "127.0.0.1:$mock_port" 2>/dev/null &
pids+=($!)
taskset -c "${PROXY_CPUS:-0,1,4,5}" env -i PATH=/usr/bin:/bin HOME="$work/rust" "$rust_rig" proxy "127.0.0.1:$rust_port" \
  "http://127.0.0.1:$mock_port" "$work/rust/home" 2>"$work/rust.log" &
rust_pid=$!
pids+=("$rust_pid")
sandbox "$work/ts" taskset -c "${PROXY_CPUS:-0,1,4,5}" "$ts_rig" "127.0.0.1:$ts_port" "http://127.0.0.1:$mock_port" "$work/ts/home" \
  >"$work/ts.log" 2>&1 &
ts_pid=$!
pids+=("$ts_pid")
sandbox "$work/raw" taskset -c "${PROXY_CPUS:-0,1,4,5}" "$ts_raw" "127.0.0.1:$raw_port" "http://127.0.0.1:$mock_port" \
  >"$work/raw.log" 2>&1 &
pids+=($!)
for port in $rust_port $ts_port $raw_port; do
  until curl -fs -o /dev/null "http://127.0.0.1:$port/healthz"; do sleep 0.05; done
done

mem() { # rss hwm pss, in KB
  local pid=$1
  printf '%s %s %s\n' "$(awk '$1 == "VmRSS:" {print $2}' "/proc/$pid/status")" \
    "$(awk '$1 == "VmHWM:" {print $2}' "/proc/$pid/status")" \
    "$(awk '$1 == "Pss:" {print $2}' "/proc/$pid/smaps_rollup")"
}
cpu() { awk '{print $14 + $15}' "/proc/$1/stat"; } # clock ticks, every thread

sleep 10
echo "idle rust $(mem $rust_pid)" >"$out/memory.txt"
echo "idle ts $(mem $ts_pid)" >>"$out/memory.txt"

# name agent body concurrency amount
loads=(
  "claude-small-c1 claude claude-small 1 -n2000"
  "claude-small-c32 claude claude-small 32 -z${seconds}s"
  "claude-large-c1 claude claude-large 1 -n300"
  "claude-large-c32 claude claude-large 32 -z${seconds}s"
  "codex-small-c32 codex codex-small 32 -z${seconds}s"
  "codex-large-c32 codex codex-large 32 -z${seconds}s"
)
path_of() { # target agent
  case "$1:$2" in
    mock:claude) echo /v1/messages?beta=true ;; mock:codex) echo /codex/responses ;;
    rust:claude) echo /v1/messages?beta=true ;; rust:codex) echo /codex/responses ;;
    *:claude) echo /claude/v1/messages?beta=true ;; *:codex) echo /codex/responses ;;
  esac
}
port_of() { case $1 in mock) echo $mock_port ;; rust) echo $rust_port ;; ts) echo $ts_port ;; raw) echo $raw_port ;; esac; }
pid_of() { case $1 in rust) echo $rust_pid ;; ts) echo $ts_pid ;; *) echo "" ;; esac; }

echo -e "round\tload\ttarget\tok\treq_s\tp50_ms\tp99_ms\tcpu_us_per_req" >"$out/loads.tsv"
for round in $(seq "$rounds"); do
  for spec in "${loads[@]}"; do
    read -r name agent body conc amount <<<"$spec"
    [[ -n "${ONLY:-}" && ! "$name" =~ $ONLY ]] && continue
    for target in ${TARGETS:-rust ts raw mock}; do
      pid=$(pid_of $target)
      [ -n "$pid" ] && before=$(cpu "$pid")
      headers=(-H 'authorization: Bearer bench' -H 'content-type: application/json')
      if [ "$agent" = claude ]; then
        headers+=(-H 'user-agent: claude-cli/2.1.287 (external, cli)' -H 'x-claude-code-session-id: bench')
      else headers+=(-H 'session_id: bench'); fi
      json=$(taskset -c 3,7 oha --no-tui --output-format json -m POST "${headers[@]}" -c "$conc" "$amount" \
        -D "$work/bodies/$body.json" "http://127.0.0.1:$(port_of $target)$(path_of $target $agent)")
      cpu_per=""
      if [ -n "$pid" ]; then
        after=$(cpu "$pid")
        total=$(jq '[.statusCodeDistribution[]] | add' <<<"$json")
        cpu_per=$(awk -v t=$((after - before)) -v n="$total" 'BEGIN {printf "%.0f", t * 1e6 / 100 / n}')
      fi
      jq -r --arg r "$round" --arg n "$name" --arg t "$target" --arg c "$cpu_per" \
        '[$r, $n, $t, (.summary.successRate * 100 | floor), (.summary.requestsPerSec | floor),
          (.latencyPercentiles.p50 * 1e5 | floor / 100), (.latencyPercentiles.p99 * 1e5 | floor / 100), $c] | @tsv' \
        <<<"$json" >>"$out/loads.tsv"
      tail -1 "$out/loads.tsv"
    done
  done
done
echo "after rust $(mem $rust_pid)" >>"$out/memory.txt"
echo "after ts $(mem $ts_pid)" >>"$out/memory.txt"
cat "$out/memory.txt"
