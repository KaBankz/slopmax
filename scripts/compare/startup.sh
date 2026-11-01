#!/usr/bin/env bash
# The CLIs as they ship: size (raw and xz), `--version` and `status --json`
# (hyperfine, 100 runs), `serve` until /healthz answers (20 runs), and the
# real daemon's memory after 10 s idle. Each CLI gets a home with the rig's
# four fake accounts and nothing on its port.
#
#   startup.sh <repo> <bin-dir> <out-dir>
set -euo pipefail
repo=$1 bin=$2 out=$3
rust_cli=$repo/target/release/slopmax rust_rig=$repo/target/release/examples/bench
work=$(mktemp -d "$out/work.XXXX")
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
idle_port=9220 seed_port=9222
hf=$(command -v hyperfine)

{
  echo -e "binary\tbytes\txz_bytes"
  for b in "rust:$rust_cli" "ts-aot:$bin/slopmax-aot" "ts-fallback:$bin/slopmax-fallback"; do
    name=${b%%:*} file=${b#*:}
    echo -e "$name\t$(wc -c <"$file")\t$(xz -9e -T1 -c "$file" | wc -c)"
  done
} >"$out/size.tsv"
cat "$out/size.tsv"

sandbox() {
  local home=$1
  exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$home" SLOPMAX_HOME="$home/.slopmax" \
    CLAUDE_CONFIG_DIR="$home/.claude" CODEX_HOME="$home/.codex" XDG_CONFIG_HOME="$home/.config" \
    SLOPMAX_NO_SERVICE=1 SLOPMAX_CLIPROXYAPI_PORT=9 SLOPMAX_LISTEN="127.0.0.1:$idle_port" NO_COLOR=1 \
    HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 "${@:2}"
}
seed() { # let a rig write its home once, then stop it
  local pid=$1 port=$2
  for _ in $(seq 200); do curl -fs -o /dev/null "http://127.0.0.1:$port/healthz" && break; sleep 0.05; done
  kill "$pid"; wait "$pid" 2>/dev/null || true
}

# Rust: the rig's accounts and bench.sh's config, which keeps the fakes away from the providers.
mkdir -p "$work/rust/.slopmax"
env -i PATH=/usr/bin:/bin HOME="$work/rust" "$rust_rig" proxy "127.0.0.1:$seed_port" "http://127.0.0.1:9" \
  "$work/rust-seed" 2>/dev/null &
seed $! $seed_port
cp -r "$work/rust-seed/accounts" "$work/rust/.slopmax/"
cat >"$work/rust/.slopmax/config.toml" <<'TOML'
api_key = "bench"
poll_mins = 0
refresh_tokens = false
redeem_expiring_credits = false
TOML
# TypeScript: the rig's own home (its four accounts, no refreshing or polling).
mkdir -p "$work/ts"
(sandbox "$work/ts-seed-env" "$bin/rig" "127.0.0.1:$seed_port" "http://127.0.0.1:9" "$work/ts/.slopmax") >/dev/null 2>&1 &
seed $! $seed_port

echo -e "cli\tcommand\tmedian_ms\tmean_ms\tstddev_ms" >"$out/startup.tsv"
for c in "rust:$rust_cli" "ts-aot:$bin/slopmax-aot" "ts-fallback:$bin/slopmax-fallback"; do
  name=${c%%:*} cli=${c#*:} home=$work/${name%%-*}
  echo -e "$name\taccounts in status\t$( (sandbox "$home" "$cli" status --json) | jq '.accounts | length')\t\t" >>"$out/startup.tsv"
  (sandbox "$home" "$hf" -N --warmup 5 --runs 100 --export-json "$work/$name.json" \
    "$cli --version" "$cli status --json") >"$work/$name.hyperfine" 2>&1 || { cat "$work/$name.hyperfine"; exit 1; }
  jq -r --arg n "$name" '.results[] | [$n, (.command | sub(".*/[a-z-]+ "; "")), (.median * 1e5 | floor / 100),
    (.mean * 1e5 | floor / 100), (.stddev * 1e5 | floor / 100)] | @tsv' "$work/$name.json" >>"$out/startup.tsv"
  for _ in $(seq 20); do
    start=$(date +%s%N)
    (sandbox "$home" "$cli" serve) >/dev/null 2>&1 &
    pid=$!
    until curl -fs -o /dev/null "http://127.0.0.1:$idle_port/healthz"; do :; done
    echo $((($(date +%s%N) - start) / 1000))
    kill "$pid"; wait "$pid" 2>/dev/null || true
  done | sort -n | awk -v n="$name" '{t[NR] = $1} END {printf "%s\tserve until /healthz\t%.2f\t\t\n", n, t[int((NR + 1) / 2)] / 1000}' >>"$out/startup.tsv"
  # The shipped daemon, left alone: its memory once it settles.
  (sandbox "$home" "$cli" serve) >/dev/null 2>&1 &
  pid=$!
  pids+=("$pid")
  until curl -fs -o /dev/null "http://127.0.0.1:$idle_port/healthz"; do sleep 0.05; done
  curl -fs -o /dev/null "http://127.0.0.1:$idle_port/" || true
  sleep 10
  echo -e "$name\tserve idle\trss_kb=$(awk '$1 == "VmRSS:" {print $2}' /proc/$pid/status)\tpss_kb=$(awk '$1 == "Pss:" {print $2}' /proc/$pid/smaps_rollup)\tthreads=$(awk '$1 == "Threads:" {print $2}' /proc/$pid/status)" >>"$out/startup.tsv"
  kill "$pid"; wait "$pid" 2>/dev/null || true
done
column -t -s $'\t' "$out/startup.tsv"
