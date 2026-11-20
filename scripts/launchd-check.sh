#!/bin/bash
# The login agent under this Mac's launchd, end to end: launchd holds the
# proxy's socket through a crash. A hard kill can interrupt the one probe
# already in flight. Handoff and takeover keep every probe alive.
# `slopmax proxy stop` unloads the agent and `slopmax proxy start` loads it.
#
# It installs and removes the user's own login agent (dev.slopmax), so it
# runs only on a CI runner: `mise run launchd`.
set -uo pipefail
if [ "${CI:-}" != true ]; then
  echo "launchd-check.sh replaces this user's slopmax login agent; it runs on CI only" >&2
  exit 2
fi
if [ -e ~/Library/LaunchAgents/dev.slopmax.plist ]; then
  echo "a slopmax login agent is already installed here" >&2
  exit 2
fi
B=$PWD/target/debug/slopmax
H=$(mktemp -d)
mkdir -p "$H/home"
export SLOPMAX_HOME=$H/home
printf 'listen = "127.0.0.1:7599"\ncheck_updates = false\n' > "$H/home/config.toml"
T=gui/$(id -u)/dev.slopmax
fail=0
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }
knock() { # knock <seconds> → "answered failed interrupted slow"
  local end=$((SECONDS+$1)) ok=0 bad=0 interrupted=0 slow=0 r status code elapsed
  while [ "$SECONDS" -lt "$end" ]; do
    status=0
    r=$(curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time 15 http://127.0.0.1:7599/healthz) || status=$?
    read -r code elapsed <<< "$r"
    if [ "$status" = 0 ] && [ "$code" = 200 ]; then
      ok=$((ok+1))
      awk -v elapsed="$elapsed" 'BEGIN{exit !(elapsed>0.3)}' && slow=$((slow+1))
    elif [ "$status" = 52 ] || [ "$status" = 56 ]; then
      # curl got an empty reply or lost the connection while receiving.
      interrupted=$((interrupted+1))
    else
      printf 'health probe failed (curl %s, HTTP %s)\n' "$status" "$code" >&2
      bad=$((bad+1))
    fi
  done
  echo "$ok $bad $interrupted $slow"
}
pid() { curl -s --max-time 5 http://127.0.0.1:7599/healthz | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'; }
jobpid() { launchctl print "$T" 2>/dev/null | awk '/^\tpid = /{print $3}'; }
serving() { pgrep -f "slopmax2? serve" | tr '\n' ' '; }

"$B" proxy install || { cat "$H/home/slopmax.log"; exit 1; }
cat ~/Library/LaunchAgents/dev.slopmax.plist
sleep 1
P=$(pid); echo "pid $P, launchd's $(jobpid)"
check "launchd runs the proxy" '[ -n "$P" ] && [ "$P" = "$(jobpid)" ]'
sudo lsof +fg -nP -iTCP:7599 -sTCP:LISTEN
check "launchd holds the socket" 'sudo lsof -nP -iTCP:7599 -sTCP:LISTEN | grep -q "^launchd"'

echo "== crash"
crashed=$P
knock 6 > "$H/k1" & sleep 1.5
check "killed the running proxy" 'kill -9 "$crashed"'
wait
read -r ok bad interrupted slow < "$H/k1"
echo "answered $ok failed $bad interrupted $interrupted slow $slow"
check "new connections work through a crash" '[ "$bad" = 0 ] && [ "$interrupted" -le 1 ] && [ "$ok" -gt 20 ]'
sleep 1; P=$(pid)
check "launchd started it again" '[ -n "$P" ] && [ "$P" != "$crashed" ] && [ "$P" = "$(jobpid)" ]'

echo "== handoff"
cp "$B" "$H/slopmax2"
# The owner's key, which `proxy install` added to the config.toml above.
KEY=$(sed -n 's/^api_key = "\([^"]*\)".*/\1/p' "$H/home/config.toml")
knock 12 > "$H/k2" & sleep 1.5
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"exe\":\"$H/slopmax2\"}" http://127.0.0.1:7599/slopmax/api/shutdown; echo
wait
read -r ok bad interrupted slow < "$H/k2"
echo "answered $ok failed $bad interrupted $interrupted slow $slow"
check "every probe survives the handoff and takeover" '[ "$bad" = 0 ] && [ "$interrupted" = 0 ] && [ "$ok" -gt 20 ]'
for i in $(seq 1 40); do N=$(pid); J=$(jobpid); [ -n "$N" ] && [ "$N" = "$J" ] && [ "$N" != "$P" ] && [ "$(serving | wc -w | tr -d ' ')" = 1 ] && break; sleep 0.5; done
echo "pid $N, launchd's $J, serving: $(serving)"
check "launchd's new process took over" '[ -n "$N" ] && [ "$N" = "$J" ] && [ "$N" != "$P" ]'
check "no other slopmax left running" '[ "$(serving | wc -w | tr -d " ")" = 1 ]'

echo "== stop"
"$B" proxy stop
sleep 1
check "stopped: nothing answers" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 3 http://127.0.0.1:7599/healthz)" = 000 ]'
check "stopped: the agent is unloaded" '! launchctl print "$T" >/dev/null 2>&1'
check "stopped: no slopmax runs" '[ -z "$(serving)" ]'

echo "== start"
"$B" proxy start || cat "$H/home/slopmax.log"
check "started under launchd" '[ -n "$(pid)" ] && [ "$(pid)" = "$(jobpid)" ]'

"$B" proxy uninstall
echo "== log"; cat "$H/home/slopmax.log"
exit $fail
