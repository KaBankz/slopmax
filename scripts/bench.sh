#!/usr/bin/env bash
# Measures what slopmax adds: latency, throughput, and memory, with the real
# proxy in front of a local mock provider (examples/bench.rs), then startup
# time and binary size.
#
#   mise run bench           # installs oha, jq, and hyperfine first
#   scripts/bench.sh [rig]   # with them on PATH; `rig` is a prebuilt bench
#                            # binary, for example one for another target
#
# Linux only: memory comes from /proc. The release build takes a few minutes
# the first time.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
upstream_port=${UPSTREAM_PORT:-9100}
proxy_port=${PROXY_PORT:-9101}
idle_port=${IDLE_PORT:-9102}
duration=${DURATION:-8s}
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  # The proxy saves its state as it stops.
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

cargo build --quiet --release --locked --manifest-path "$root/Cargo.toml" --bin slopmax --example bench
bench=${1:-$root/target/release/examples/bench}
slopmax=$root/target/release/slopmax

mkdir -p "$work/home"
"$bench" bodies "$work/bodies"
"$bench" upstream "127.0.0.1:$upstream_port" 2>/dev/null &
pids+=($!)
"$bench" proxy "127.0.0.1:$proxy_port" "http://127.0.0.1:$upstream_port" "$work/home" 2>"$work/proxy.log" &
proxy=$!
pids+=("$proxy")
until curl -fs -o /dev/null "http://127.0.0.1:$proxy_port/healthz"; do sleep 0.05; done
sleep 0.5
rss() { awk -v k="$1" '$1 == k":" {printf "%.1f MB", $2 / 1024}' "/proc/$proxy/status"; }
idle=$(rss VmRSS)

claude() {
  oha --no-tui --output-format json -m POST -H 'authorization: Bearer bench' \
    -H 'user-agent: claude-cli/2.1.287 (external, cli)' -H 'x-claude-code-session-id: bench' \
    -H 'content-type: application/json' "$@" "http://127.0.0.1:$proxy_port/v1/messages?beta=true"
}
codex() {
  oha --no-tui --output-format json -m POST -H 'authorization: Bearer bench' \
    -H 'content-type: application/json' -H 'session_id: bench' "$@" "http://127.0.0.1:$proxy_port/codex/responses"
}
row() {
  jq -r --arg name "$1" '"\($name)\t\(.summary.successRate * 100 | floor)% ok\t\(.summary.requestsPerSec | floor) req/s\tp50 \(.latencyPercentiles.p50 * 1e5 | floor / 100) ms\tp99 \(.latencyPercentiles.p99 * 1e5 | floor / 100) ms"'
}
echo "Requests through the proxy"
{
  claude -n 300 -c 1 -D "$work/bodies/claude-small.json" | row "claude small, one at a time"
  claude -z "$duration" -c 32 -D "$work/bodies/claude-small.json" | row "claude small, 32 at once"
  claude -n 200 -c 1 -D "$work/bodies/claude-large.json" | row "claude 300 KB, one at a time"
  claude -z "$duration" -c 32 -D "$work/bodies/claude-large.json" | row "claude 300 KB, 32 at once"
  codex -z "$duration" -c 32 -D "$work/bodies/codex-small.json" | row "codex small, 32 at once"
  codex -z "$duration" -c 32 -D "$work/bodies/codex-large.json" | row "codex 300 KB, 32 at once"
} | column -t -s $'\t'
echo "Memory: $idle idle, $(rss VmHWM) at peak, $(rss VmRSS) after"

# Startup, with a copy of the rig's accounts and nothing on the port. The
# config keeps the fake accounts away from the real providers.
mkdir -p "$work/cli"
cp -r "$work/home/accounts" "$work/cli/"
cat >"$work/cli/config.toml" <<'EOF'
api_key = "bench"
poll_mins = 0
refresh_tokens = false
redeem_expiring_credits = false
EOF
export SLOPMAX_HOME=$work/cli SLOPMAX_LISTEN=127.0.0.1:$idle_port
hyperfine -N --warmup 5 --runs 100 --export-json "$work/startup.json" \
  "$slopmax --version" "$slopmax status --json" >"$work/hyperfine.log" 2>&1 ||
  { cat "$work/hyperfine.log"; exit 1; }
echo "Startup"
{
  jq -r '.results[] | "\(.command | sub(".*/slopmax "; "slopmax "))\t\(.median * 1e5 | floor / 100) ms"' "$work/startup.json"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    start=$(date +%s%N)
    "$slopmax" serve 2>/dev/null &
    pid=$!
    until curl -fs -o /dev/null "http://127.0.0.1:$idle_port/healthz"; do :; done
    echo $((($(date +%s%N) - start) / 1000))
    kill "$pid"
    wait "$pid" 2>/dev/null || true
  done | sort -n | awk '{t[NR] = $1} END {printf "slopmax serve, until it answers\t%.2f ms\n", t[int((NR + 1) / 2)] / 1000}'
} | column -t -s $'\t'
echo "Binary: $(wc -c <"$slopmax" | tr -d ' ') bytes"
