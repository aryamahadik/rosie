#!/bin/bash
# Prints the watchdog's state: whether launchd has the job loaded, the lead lock, the current shift, the pause
# and stop files, and the last 5 lines of the watchdog log (factory spec section 10). Reads only, changes
# nothing, prints no keys. Overrides, as in the other scripts: ROSIE_CODE_DIR, ROSIE_OPS_DIR.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CODE_DIR=${ROSIE_CODE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}
OPS_DIR=${ROSIE_OPS_DIR:-$CODE_DIR/ops}
LABEL=com.rosfield.rosie-watchdog
DOMAIN="gui/$(id -u)"
LOCK="$OPS_DIR/LEAD.lock"
PAUSED="$OPS_DIR/PAUSED_UNTIL"
WD_DIR="$OPS_DIR/watchdog"
SHIFTS_DIR="$OPS_DIR/shifts"

RE_EPOCH='^[0-9]{9,11}$'
RE_ISO='^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(:([0-9]{2}))?(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'

trim() { printf '%s' "$1" | LC_ALL=C tr -d '\r' | LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# The pid in a pid file; empty, and silent, when the file is gone.
read_pid_file() { { LC_ALL=C tr -d ' \t\r\n' <"$1"; } 2>/dev/null || true; }

# Same reader as in rosie-watchdog.sh: an ISO 8601 time with a zone, or a bare epoch.
epoch_from_iso() {
  local s=$1 day hh mm ss zone e off
  if [[ $s =~ $RE_EPOCH ]]; then
    echo "$s"
    return 0
  fi
  if ! [[ $s =~ $RE_ISO ]]; then return 1; fi
  day=${BASH_REMATCH[1]} hh=${BASH_REMATCH[2]} mm=${BASH_REMATCH[3]} ss=${BASH_REMATCH[5]:-00} zone=${BASH_REMATCH[7]}
  e=$(date -u -j -f '%Y-%m-%d %H:%M:%S' "$day $hh:$mm:$ss" +%s 2>/dev/null) || return 1
  if [ "$zone" != Z ]; then
    off=$((10#${zone:1:2} * 3600 + 10#${zone: -2} * 60))
    if [ "${zone:0:1}" = + ]; then e=$((e - off)); else e=$((e + off)); fi
  fi
  echo "$e"
}

alive() {
  local st
  case ${1:-} in '' | *[!0-9]*) return 1 ;; esac
  if ! kill -0 "$1" 2>/dev/null; then return 1; fi
  st=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  case $st in Z*) return 1 ;; esac
  return 0
}

lock_field() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$LOCK" | tr -d ' \t\r' | sed -n 1p; }

now=$(date -u +%s)
echo "Rosie watchdog status at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if info=$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null); then
  echo "Job: loaded as $DOMAIN/$LABEL"
  printf '%s\n' "$info" | awk '/^\t(state|runs|last exit code|pid) = / && !seen[$1]++ { sub(/^\t/, "  "); print }'
else
  echo "Job: not loaded (install with infra/watchdog/install.sh)"
fi
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  echo "Plist: ~/Library/LaunchAgents/$LABEL.plist"
else
  echo "Plist: not in ~/Library/LaunchAgents"
fi

if [ -f "$LOCK" ]; then
  pid=$(lock_field pid)
  started=$(lock_field started)
  heartbeat=$(lock_field heartbeat)
  if alive "$pid"; then state="alive"; else state="not running"; fi
  age=""
  if hb=$(epoch_from_iso "$heartbeat"); then age=" ($(((now - hb) / 60)) min ago; stale at 30)"; fi
  echo "Lead lock: pid ${pid:-?} ($state), started ${started:-?}, heartbeat ${heartbeat:-?}$age"
else
  echo "Lead lock: none"
fi

if [ -f "$SHIFTS_DIR/current.pid" ]; then
  cpid=$(read_pid_file "$SHIFTS_DIR/current.pid")
  if alive "$cpid"; then state="running"; else state="not running"; fi
  echo "Current shift: pid ${cpid:-?} ($state)"
else
  echo "Current shift: none recorded"
fi
latest=$(ls -t "$SHIFTS_DIR"/*.jsonl 2>/dev/null | sed -n 1p || true)
if [ -n "$latest" ]; then echo "Latest shift output: ${latest#"$CODE_DIR"/}"; fi

if [ -f "$PAUSED" ]; then
  raw=""
  IFS= read -r raw <"$PAUSED" || true
  raw=$(trim "$raw")
  if [ -z "$raw" ]; then
    echo "PAUSED_UNTIL: empty (no pause)"
  elif end=$(epoch_from_iso "$raw"); then
    if [ "$end" -gt "$now" ]; then
      echo "PAUSED_UNTIL: $raw (paused, $(((end - now + 59) / 60)) min left)"
    else
      echo "PAUSED_UNTIL: $raw (passed; the next shift clears it)"
    fi
  else
    echo "PAUSED_UNTIL: '${raw:0:40}' (unreadable: no shift starts until it is fixed or deleted)"
  fi
else
  echo "PAUSED_UNTIL: none"
fi

if [ -f "$WD_DIR/STOPPED" ]; then
  echo "STOPPED: yes, no shift starts until ops/watchdog/STOPPED is deleted"
  sed 's/^/  /' "$WD_DIR/STOPPED"
else
  echo "STOPPED: no"
fi
if [ -f "$WD_DIR/ALERT.md" ]; then echo "Alerts: see ops/watchdog/ALERT.md"; fi
if [ -f "$WD_DIR/crashes.log" ]; then
  n=$(awk -v since=$((now - 7200)) '
    $3 == "stop" { n = 0; next }
    $3 == "crash" { split($2, a, "="); if (a[1] == "epoch" && a[2] + 0 >= since) n++ }
    END { print n + 0 }' "$WD_DIR/crashes.log")
  echo "Crashes in the last 2 hours (since the last stop): $n of 3"
fi

echo "Last 5 lines of ops/watchdog/watchdog.log:"
if [ -f "$WD_DIR/watchdog.log" ]; then tail -n 5 "$WD_DIR/watchdog.log" | sed 's/^/  /'; else echo "  (none yet)"; fi
if [ -f "$SHIFTS_DIR/shifts.log" ]; then
  echo "Last 3 lines of ops/shifts/shifts.log:"
  tail -n 3 "$SHIFTS_DIR/shifts.log" | sed 's/^/  /'
fi
