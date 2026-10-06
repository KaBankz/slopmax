#!/usr/bin/env bash
# A throwaway slopmax for working on the desktop app or the dashboard: the
# bench rig's mock provider and proxy, four fake accounts with varied usage
# (one limited), and every config directory an app could touch (Claude
# Code's, Codex's, systemd's) pointed into the demo, so nothing reaches a
# real account or a real setting.
#
#   scripts/demo.sh            # prints what to export, runs until Ctrl-C
#
# Then, in another shell, export those and run an app or the CLI:
#   cargo run -p slopmax-desktop-gpui
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
demo=$(mktemp -d)
upstream=127.0.0.1:${UPSTREAM_PORT:-9200}
listen=127.0.0.1:${DEMO_PORT:-9201}
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$demo"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cargo build --quiet --locked --manifest-path "$root/Cargo.toml" -p slopmax --example bench
bench=$root/target/debug/examples/bench

mkdir -p "$demo"/home "$demo"/claude "$demo"/codex "$demo"/config
cat >"$demo"/home/config.toml <<EOF
api_key = "bench"
listen = "$listen"
poll_mins = 0
refresh_tokens = false
redeem_expiring_credits = false
EOF
up() { until curl -fs -o /dev/null "http://$listen/healthz"; do sleep 0.1; done; }

"$bench" upstream "$upstream" 2>/dev/null &
pids+=($!)
# A first run creates the accounts; then their saved state gets usage.
"$bench" proxy "$listen" "http://$upstream" "$demo"/home 2>/dev/null &
first=$!
up
kill "$first"
wait "$first" 2>/dev/null || true
python3 - "$demo"/home <<'EOF'
import json, os, sys, time

home = sys.argv[1]
ids = sorted(f[:-5] for f in os.listdir(f"{home}/accounts") if f.endswith(".json"))
now = time.time()
at = lambda secs: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + secs))


def windows(five, five_in, week, week_in):
    return [{"span": "5h", "used": five, "resets_at": at(five_in)},
            {"span": "7d", "used": week, "resets_at": at(week_in)}]


looks = {
    "claude": [windows(82, 7_500, 47, 259_200), windows(12, 14_400, 30, 432_000)],
    "codex": [windows(100, 4_800, 64, 172_800), windows(35, 10_800, 21, 518_400)],
}
served = {"requests": 120, "input_tokens": 900_000, "output_tokens": 80_000,
          "cache_read_tokens": 4_000_000, "cache_write_tokens": 200_000}
state = {"accounts": {}}
for provider, shapes in looks.items():
    for account, shape in zip([i for i in ids if i.startswith(provider)], shapes):
        entry = {"limits": {"windows": shape, "observed_at": at(0)}, "usage": served}
        if shape[0]["used"] >= 100:
            entry["blocked_until"] = shape[0]["resets_at"]
        if provider == "codex":
            entry["limits"]["reset_credits"] = 2
        state["accounts"][account] = entry
with open(f"{home}/state.json", "w") as f:
    json.dump(state, f, indent=2)
EOF
"$bench" proxy "$listen" "http://$upstream" "$demo"/home 2>"$demo"/proxy.log &
pids+=($!)
up

cat <<EOF
The demo proxy runs on $listen with four fake accounts. In another shell:

  export SLOPMAX_HOME=$demo/home SLOPMAX_LISTEN=$listen
  export CLAUDE_CONFIG_DIR=$demo/claude CODEX_HOME=$demo/codex XDG_CONFIG_HOME=$demo/config

Ctrl-C stops it and deletes the demo.
EOF
wait
