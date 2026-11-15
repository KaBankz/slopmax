#!/bin/bash
# Exercises the launchd agent end to end: the socket launchd keeps, a crash,
# a handoff (and launchd's process taking over after it), stop and start.
set -uo pipefail
B=$PWD/target/debug/slopmax
H=$RUNNER_TEMP/sm
mkdir -p "$H/home"
export SLOPMAX_HOME=$H/home
printf 'listen = "127.0.0.1:7599"\ncheck_updates = false\n' > "$H/home/config.toml"
T=gui/$(id -u)/dev.slopmax
fail=0
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }
knock() { # knock <seconds> → "answered failed slow"
  local end=$((SECONDS+$1)) ok=0 bad=0 slow=0 r
  while [ $SECONDS -lt $end ]; do
    r=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 15 http://127.0.0.1:7599/healthz)
    set -- $1 $r
    if [ "$2" = 200 ]; then ok=$((ok+1)); awk "BEGIN{exit !($3>0.3)}" && slow=$((slow+1)); else bad=$((bad+1)); fi
  done
  echo "$ok $bad $slow"
}
pid() { curl -s --max-time 5 http://127.0.0.1:7599/healthz | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'; }
jobpid() { launchctl print "$T" 2>/dev/null | awk '/^\tpid = /{print $3}'; }
serving() { pgrep -f "slopmax serve" | tr '\n' ' '; }

"$B" service install || { cat "$H/home/slopmax.log"; exit 1; }
cat ~/Library/LaunchAgents/dev.slopmax.plist
sleep 1
P=$(pid); echo "pid $P, launchd's $(jobpid)"
check "launchd runs the proxy" '[ -n "$P" ] && [ "$P" = "$(jobpid)" ]'
lsof -nP -iTCP:7599 -sTCP:LISTEN
check "launchd holds the socket" 'lsof -nP -iTCP:7599 -sTCP:LISTEN | grep -q "^launchd"'

echo "== crash"
knock 6 > "$H/k1" & sleep 1.5; kill -9 "$P"; wait
read ok bad slow < "$H/k1"; echo "answered $ok failed $bad slow $slow"
check "nothing refused through a crash" '[ "$bad" = 0 ] && [ "$ok" -gt 20 ]'
sleep 1; P=$(pid)
check "launchd started it again" '[ -n "$P" ] && [ "$P" = "$(jobpid)" ]'

echo "== handoff"
cp "$B" "$H/slopmax2"
KEY=$("$B" daemon-info --json | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
knock 12 > "$H/k2" & sleep 1.5
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"exe\":\"$H/slopmax2\"}" http://127.0.0.1:7599/slopmax/api/shutdown; echo
wait
read ok bad slow < "$H/k2"; echo "answered $ok failed $bad slow $slow"
check "nothing refused through the handoff and the takeover" '[ "$bad" = 0 ] && [ "$ok" -gt 20 ]'
for i in $(seq 1 40); do N=$(pid); J=$(jobpid); [ -n "$N" ] && [ "$N" = "$J" ] && [ "$N" != "$P" ] && [ "$(serving | wc -w | tr -d ' ')" = 1 ] && break; sleep 0.5; done
echo "pid $N, launchd's $J, serving: $(serving)"
check "launchd's new process took over" '[ -n "$N" ] && [ "$N" = "$J" ] && [ "$N" != "$P" ]'
check "no other slopmax left running" '[ "$(serving | wc -w | tr -d " ")" = 1 ]'

echo "== stop"
"$B" stop
sleep 1
check "stopped: nothing answers" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 3 http://127.0.0.1:7599/healthz)" = 000 ]'
check "stopped: the agent is unloaded" '! launchctl print "$T" >/dev/null 2>&1'
check "stopped: no slopmax runs" '[ -z "$(serving)" ]'

echo "== start"
"$B" start || cat "$H/home/slopmax.log"
check "started under launchd" '[ -n "$(pid)" ] && [ "$(pid)" = "$(jobpid)" ]'

"$B" service uninstall
echo "== log"; cat "$H/home/slopmax.log"
exit $fail
