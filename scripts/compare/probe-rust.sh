#!/usr/bin/env bash
# Where the Rust proxy's time goes one request at a time: syscall counts and its log.
set -euo pipefail
R=$1; W=$(mktemp -d); pids=()
trap 'for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; rm -rf "$W"' EXIT
"$R" bodies "$W/b"
"$R" upstream 127.0.0.1:9210 2>/dev/null & pids+=($!)
env -i PATH=/usr/bin:/bin HOME="$W" "$R" proxy 127.0.0.1:9211 http://127.0.0.1:9210 "$W/home" 2>"$W/log" & P=$!; pids+=($P)
for _ in $(seq 100); do curl -fs -o /dev/null 127.0.0.1:9211/healthz && break; sleep 0.05; done
sleep 1
H=(-H 'authorization: Bearer bench' -H 'content-type: application/json' -H 'user-agent: claude-cli/2.1.287 (external, cli)' -H 'x-claude-code-session-id: bench')
timeout -s INT 5 strace -c -f -p "$P" -o "$W/strace.txt" & S=$!
sleep 0.5
oha --no-tui -m POST "${H[@]}" -c 1 -n 1000 -D "$W/b/claude-small.json" "http://127.0.0.1:9211/v1/messages?beta=true" | grep -E "Requests/sec|50.00%"
wait $S || true
head -20 "$W/strace.txt"; echo "log lines: $(wc -l <"$W/log")"; tail -2 "$W/log"; find "$W/home" -maxdepth 2 | head
