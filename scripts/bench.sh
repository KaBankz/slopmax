#!/usr/bin/env bash
# Measures what slopmax adds to a request: latency, throughput, and memory,
# with the real proxy in front of a local mock provider (examples/bench.rs).
#
#   scripts/bench.sh [bench binary]
#
# Linux only (memory comes from /proc). Needs oha (https://github.com/hatoo/oha),
# jq, and python3. Builds the rig unless a binary is given, for example one
# built for another target.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
upstream_port=${UPSTREAM_PORT:-9100}
proxy_port=${PROXY_PORT:-9101}
duration=${DURATION:-8s}
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

if [[ $# -gt 0 ]]; then
  bench=$1
else
  cargo build --quiet --release --example bench --manifest-path "$root/Cargo.toml"
  bench=$root/target/release/examples/bench
fi

mkdir -p "$work/home"
"$bench" upstream "127.0.0.1:$upstream_port" 2>/dev/null &
pids+=($!)
"$bench" proxy "127.0.0.1:$proxy_port" "http://127.0.0.1:$upstream_port" "$work/home" 2>"$work/proxy.log" &
proxy=$!
pids+=("$proxy")
until curl -fs -o /dev/null "http://127.0.0.1:$proxy_port/healthz"; do sleep 0.05; done
sleep 0.5
rss() { awk -v k="$1" '$1 == k":" {printf "%.1f MB", $2 / 1024}' "/proc/$proxy/status"; }
echo "idle RSS $(rss VmRSS)"

# Request bodies: a first turn, and a long conversation of about 300 KB.
python3 - "$work" <<'EOF'
import json, random, sys
out = sys.argv[1]
random.seed(7)
words = "the quick brown fox jumps over lazy dog file path function return value error test build".split()
def text(n): return " ".join(random.choice(words) for _ in range(n))
def dump(name, value): open(f"{out}/{name}.json", "w").write(json.dumps(value, separators=(",", ":")))
user_id = json.dumps({"device_id": "d" * 64, "account_uuid": "", "session_id": "bench"})
tools = [{"name": f"Tool{i}", "description": text(120), "input_schema": {"type": "object", "properties": {f"p{j}": {"type": "string", "description": text(15)} for j in range(6)}}} for i in range(25)]
turns = []
for i in range(60):
    turns.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": text(500)}]})
    turns.append({"role": "assistant", "content": [{"type": "thinking", "thinking": text(60), "signature": "S" * 400}, {"type": "tool_use", "id": f"t{i + 1}", "name": "Tool3", "input": {"p0": text(40)}}]})
turns.append({"role": "user", "content": "continue"})
def claude(messages, tools): return {"model": "claude-opus-5-5", "max_tokens": 32000, "stream": True, "thinking": {"type": "adaptive"}, "metadata": {"user_id": user_id}, "system": [{"type": "text", "text": "You are Claude Code. " + text(2500)}], "tools": tools, "messages": messages}
dump("claude-small", claude([{"role": "user", "content": "hi"}], []))
dump("claude-large", claude(turns, tools))
items = []
for i in range(60):
    items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text(200)}]})
    items.append({"type": "reasoning", "summary": [], "encrypted_content": "E" * 600})
    items.append({"type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["bash", "-lc", text(30)]}), "call_id": f"c{i}"})
    items.append({"type": "function_call_output", "call_id": f"c{i}", "output": text(500)})
def codex(items): return {"model": "gpt-6-sol", "instructions": "You are Codex. " + text(1500), "input": items, "tools": [], "store": False, "stream": True, "prompt_cache_key": "bench"}
dump("codex-small", codex([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]))
dump("codex-large", codex(items))
EOF

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
{
  claude -n 300 -c 1 -D "$work/claude-small.json" | row "claude small, one at a time"
  claude -z "$duration" -c 32 -D "$work/claude-small.json" | row "claude small, 32 at once"
  claude -n 200 -c 1 -D "$work/claude-large.json" | row "claude 300 KB, one at a time"
  claude -z "$duration" -c 32 -D "$work/claude-large.json" | row "claude 300 KB, 32 at once"
  codex -z "$duration" -c 32 -D "$work/codex-small.json" | row "codex small, 32 at once"
  codex -z "$duration" -c 32 -D "$work/codex-large.json" | row "codex 300 KB, 32 at once"
} | column -t -s $'\t'
echo "peak RSS $(rss VmHWM), now $(rss VmRSS)"
