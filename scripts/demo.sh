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


# A weekly limit on one model, as Claude reports for Fable.
def fable(used, resets_in):
    return [{"span": "7d", "model": "Fable", "used": used, "resets_at": at(resets_in)}]


looks = {
    "claude": [windows(82, 7_500, 47, 259_200) + fable(64, 259_200),
               windows(12, 14_400, 30, 432_000) + fable(18, 432_000)],
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

# Thirty days of requests in the ledger, for the app's charts: busier on
# weekdays and in working hours, mostly cached, growing over the month,
# with the odd failure.
import random

random.seed(7)
models = {"claude": [("claude-opus-5-5", 7), ("claude-sonnet-5-5", 2), ("claude-fable-5-1", 1)],
          "codex": [("gpt-6-sol", 1)]}
ledger = {}
clock = time.localtime(now)
midnight = now - (clock.tm_hour * 3_600 + clock.tm_min * 60 + clock.tm_sec)
for back in range(29, -1, -1):
    day = midnight - back * 86_400
    weekday = time.localtime(day + 43_200).tm_wday < 5
    for account in ids:
        provider = "claude" if account.startswith("claude") else "codex"
        busy = (70 if weekday else 25) * (0.6 + 0.4 * (30 - back) / 30) * random.uniform(0.6, 1.4)
        for _ in range(int(busy)):
            at = day + random.randrange(8, 24) * 3_600 + random.randrange(3_600)
            if at > now:
                continue
            names, weights = zip(*models[provider])
            ok = random.random() < 0.97
            entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at)), "account": account,
                     "provider": provider, "model": random.choices(names, weights)[0],
                     "status": 200 if ok else random.choice([429, 500]),
                     "ms": random.randint(1_500, 45_000)}
            if ok:
                entry |= {"input": random.randint(20, 900), "output": random.randint(150, 2_500),
                          "cache_read": random.randint(20_000, 180_000),
                          "cache_write": random.randint(0, 12_000),
                          "first_byte_ms": random.randint(350, 1_400) + (300 if provider == "codex" else 0)}
            ledger.setdefault(time.strftime("%Y-%m", time.gmtime(at)), []).append((at, entry))
os.makedirs(f"{home}/usage", exist_ok=True)
for month, entries in ledger.items():
    with open(f"{home}/usage/{month}.jsonl", "w") as f:
        for _, entry in sorted(entries, key=lambda e: e[0]):
            f.write(json.dumps(entry) + "\n")
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
