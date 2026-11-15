#!/bin/bash
set -uo pipefail
B=$PWD/target/debug/slopmax
H=$RUNNER_TEMP/sm; mkdir -p "$H/home"; export SLOPMAX_HOME=$H/home
printf 'listen = "127.0.0.1:7599"\ncheck_updates = false\n' > "$H/home/config.toml"
socks() { echo "-- $1"; sudo lsof +fg -nP -iTCP:7599 -sTCP:LISTEN; }
"$B" service install
sleep 1; socks "installed"
P=$(curl -s http://127.0.0.1:7599/healthz | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
kill -9 $P; sleep 0.05; socks "50ms after kill -9"; sleep 2; socks "2s after kill -9"
cp "$B" "$H/slopmax2"
KEY=$("$B" daemon-info --json | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d "{\"exe\":\"$H/slopmax2\"}" http://127.0.0.1:7599/slopmax/api/shutdown; echo
socks "right after handoff"; sleep 0.3; socks "0.3s"; sleep 0.3; socks "0.6s"; sleep 0.5; socks "1.1s"; sleep 3; socks "4s"; echo "knock: $(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 5 http://127.0.0.1:7599/healthz)"
ps -axo pid,ppid,pgid,stat,command | grep -E "slopmax[2]? serve" | grep -v grep
"$B" service uninstall; sleep 1; socks "uninstalled"
pkill -f "slopmax2 serve"; cat "$H/home/slopmax.log"
