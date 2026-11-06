#!/bin/bash
# Rosie watchdog: factory spec section 10, build prompt 5.8 and 7.13.
# launchd runs it every 15 minutes (com.rosfield.rosie-watchdog.plist). Each run:
#   1. goes to the code folder, makes sure ops/watchdog/ exists, writes one line to ops/watchdog/watchdog.log;
#   2. exits if ops/PAUSED_UNTIL holds a future time (a past one is left for the next shift to clear);
#   3. exits if ops/LEAD.lock names a live lead whose heartbeat is under 30 minutes old (one lead); otherwise
#      ends that process, records a crash in ops/watchdog/crashes.log and removes the stale lock;
#   4. after 3 crashes in 2 hours starts nothing, writes ops/watchdog/STOPPED and alerts (placeholder, Q-49);
#   5. else starts a shift in the background with shift.sh.
# It never reads keys and logs no secrets. Bash 3.2 (macOS /bin/bash).
# Overrides, for the self-test: ROSIE_CODE_DIR, ROSIE_OPS_DIR, ROSIE_HANDOVER_DIR, ROSIE_CLAUDE_BIN.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CODE_DIR=${ROSIE_CODE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}
OPS_DIR=${ROSIE_OPS_DIR:-$CODE_DIR/ops}
HANDOVER_DIR=${ROSIE_HANDOVER_DIR:-/Users/aryamahadik/Downloads/Rosfield_Main/Rosfield Main Handover}
CLAUDE_BIN=${ROSIE_CLAUDE_BIN:-claude}
PROMPT_FILE="$HANDOVER_DIR/3 Build Plan Prompt for Claude.md"

WD_DIR="$OPS_DIR/watchdog"
SHIFTS_DIR="$OPS_DIR/shifts"
LOCK="$OPS_DIR/LEAD.lock"
PAUSED="$OPS_DIR/PAUSED_UNTIL"
CURRENT_PID="$SHIFTS_DIR/current.pid"
CRASHES="$WD_DIR/crashes.log"
STOPPED="$WD_DIR/STOPPED"
ALERT="$WD_DIR/ALERT.md"
LOG="$WD_DIR/watchdog.log"
RUN_LOCK="$WD_DIR/.run.lock"

STALE_AFTER=1800  # seconds: a heartbeat this old is stale (5.8: 30 minutes)
CRASH_WINDOW=7200 # seconds: 2 hours
CRASH_LIMIT=3

RE_NUM='^[0-9]+$'
RE_EPOCH='^[0-9]{9,11}$'
RE_ISO='^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(:([0-9]{2}))?(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'

NOTES=""
OWN_RUN_LOCK=0
KILLED_PID=""
LOCK_PID=""
LOCK_HEARTBEAT=""

# ---- logging: notes gather during the run; one line is written at exit -------------------------------------
note() { NOTES="${NOTES:+$NOTES; }$*"; }

finish() {
  local rc=$1 line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) ${NOTES:-nothing to do}"
  if [ "$rc" -ne 0 ]; then line="$line (exit $rc)"; fi
  if [ -d "$WD_DIR" ]; then
    printf '%s\n' "$line" >>"$LOG" || true
  else
    printf '%s\n' "$line" >&2
  fi
  if [ -t 1 ]; then printf '%s\n' "$line"; fi
  if [ "$OWN_RUN_LOCK" -eq 1 ]; then rmdir "$RUN_LOCK" 2>/dev/null || true; fi
}
trap 'finish $?' EXIT

die() {
  note "error: $*"
  echo "rosie-watchdog: $*" >&2
  exit 1
}

# ---- time --------------------------------------------------------------------------------------------------
now_epoch() { date -u +%s; }
iso_from_epoch() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }

# Epoch seconds of an ISO 8601 time with a zone (2026-11-05T20:15:00Z, ...T15:15:00-05:00, fractions allowed)
# or of a bare epoch. Fails on anything else.
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

mtime() { stat -f %m "$1" 2>/dev/null; }

trim() { printf '%s' "$1" | LC_ALL=C tr -d '\r' | LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# The pid in a pid file; empty, and silent, when the file is gone.
read_pid_file() { { LC_ALL=C tr -d ' \t\r\n' <"$1"; } 2>/dev/null || true; }

# ---- processes ---------------------------------------------------------------------------------------------
valid_pid() { [[ ${1:-} =~ $RE_NUM ]] && [ "$1" -gt 1 ]; }

# A running process (a zombie counts as gone).
is_alive() {
  local st
  if ! valid_pid "${1:-}"; then return 1; fi
  if ! kill -0 "$1" 2>/dev/null; then return 1; fi
  st=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  case $st in Z*) return 1 ;; esac
  return 0
}

# Alive and its command line names claude, so a pid reused by another program is never killed.
is_claude() {
  local cmd
  if ! is_alive "${1:-}"; then return 1; fi
  cmd=$(ps -o command= -p "$1" 2>/dev/null) || return 1
  case $cmd in *[Cc][Ll][Aa][Uu][Dd][Ee]*) return 0 ;; esac
  return 1
}

# TERM, up to 10 s to exit, then KILL. Fails if the process is still there.
end_process() {
  local pid=$1 i=0
  kill -TERM "$pid" 2>/dev/null || return 0
  while [ "$i" -lt 20 ]; do
    if ! is_alive "$pid"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  i=0
  while [ "$i" -lt 10 ]; do
    if ! is_alive "$pid"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# ---- state files -------------------------------------------------------------------------------------------
take_run_lock() {
  local m
  if mkdir "$RUN_LOCK" 2>/dev/null; then
    OWN_RUN_LOCK=1
    return 0
  fi
  m=$(mtime "$RUN_LOCK" || true)
  if [ -z "$m" ] || [ $(($(now_epoch) - m)) -gt 600 ]; then
    rmdir "$RUN_LOCK" 2>/dev/null || true # left by a run that was killed
    if mkdir "$RUN_LOCK" 2>/dev/null; then
      OWN_RUN_LOCK=1
      return 0
    fi
  fi
  note "another watchdog run is active; exit"
  exit 0
}

# True when no shift may start now. A past time is left in place for the next shift to clear.
paused_now() {
  local raw="" end now
  if [ ! -f "$PAUSED" ]; then return 1; fi
  IFS= read -r raw <"$PAUSED" || true
  raw=$(trim "$raw")
  if [ -z "$raw" ]; then
    note "ops/PAUSED_UNTIL is empty (no pause)"
    return 1
  fi
  if ! end=$(epoch_from_iso "$raw"); then
    note "ops/PAUSED_UNTIL is unreadable ('${raw:0:40}'): starting nothing until it holds an ISO 8601 UTC time or is deleted"
    return 0
  fi
  now=$(now_epoch)
  if [ "$end" -gt "$now" ]; then
    note "paused until $(iso_from_epoch "$end") ($(((end - now + 59) / 60)) min left); exit"
    return 0
  fi
  note "PAUSED_UNTIL $(iso_from_epoch "$end") has passed (left for the next shift to clear)"
  return 1
}

# LEAD.lock lines: pid=<n>, started=<ISO>, heartbeat=<ISO>.
read_lock() {
  local key val
  LOCK_PID="" LOCK_HEARTBEAT=""
  if [ ! -f "$LOCK" ]; then return 0; fi
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key=$(trim "$key")
    val=$(trim "$val")
    case $key in
      pid) LOCK_PID=${val:0:20} ;;
      heartbeat) LOCK_HEARTBEAT=${val:0:40} ;;
    esac
  done <"$LOCK"
  return 0
}

# crashes.log lines: <ISO> epoch=<n> crash pid=<n> <reason>, and <ISO> epoch=<n> stop crashes=<n> when it stopped.
record_crash() {
  local t
  t=$(now_epoch)
  printf '%s epoch=%s crash pid=%s %s\n' "$(iso_from_epoch "$t")" "$t" "$1" "$2" >>"$CRASHES"
}

# Crashes in the last 2 hours. Crashes before a stop do not count again once STOPPED is deleted.
recent_crashes() {
  if [ ! -f "$CRASHES" ]; then
    echo 0
    return 0
  fi
  awk -v since=$(($(now_epoch) - CRASH_WINDOW)) '
    $3 == "stop" { n = 0; next }
    $3 == "crash" { split($2, a, "="); if (a[1] == "epoch" && a[2] + 0 >= since) n++ }
    END { print n + 0 }' "$CRASHES"
}

# Placeholder until the night-shift channel is decided (Q-49): it appends the alert to ops/watchdog/ALERT.md.
alert() {
  {
    if [ ! -s "$ALERT" ]; then
      printf '# Rosie watchdog alerts\n\nFor Jay and the CTO. This file stands in for the night-shift channel until Q-49 is decided.\n'
    fi
    printf '\n## %s: %s\n\n%s\n\nLast lines of ops/watchdog/crashes.log:\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
    tail -n 5 "$CRASHES" 2>/dev/null | sed 's/^/    /' || true
  } >>"$ALERT"
}

stop_watchdog() {
  local n=$1 t
  t=$(now_epoch)
  {
    echo "stopped=$(iso_from_epoch "$t")"
    echo "reason=$n shifts in the last 2 hours ended without deleting ops/LEAD.lock (crashes); the watchdog starts no more shifts"
    echo "resume=read ops/watchdog/crashes.log and the shift outputs in ops/shifts/, fix the cause, then delete this file"
  } >"$STOPPED"
  printf '%s epoch=%s stop crashes=%s\n' "$(iso_from_epoch "$t")" "$t" "$n" >>"$CRASHES"
  alert "watchdog stopped after $n crashes in 2 hours" \
    "No shift starts until a person reads ops/watchdog/crashes.log and the shift outputs in ops/shifts/, fixes the cause and deletes ops/watchdog/STOPPED."
  note "$n crashes in 2 hours: wrote ops/watchdog/STOPPED and ops/watchdog/ALERT.md; starting nothing"
}

# ---- step 3: one lead ----------------------------------------------------------------------------------------
handle_lock() {
  local now hb age src reason m
  read_lock
  if ! valid_pid "$LOCK_PID" || ! epoch_from_iso "$LOCK_HEARTBEAT" >/dev/null; then
    sleep 2 # the lead may be rewriting the lock: read it once more
    read_lock
  fi
  if [ ! -f "$LOCK" ]; then
    note "LEAD.lock was deleted while being read (the shift ended)"
    return 0
  fi
  now=$(now_epoch)
  if hb=$(epoch_from_iso "$LOCK_HEARTBEAT"); then
    age=$((now - hb)) src="heartbeat"
  else
    m=$(mtime "$LOCK" || echo "$now")
    age=$((now - m)) src="lock file time (heartbeat unreadable)"
  fi
  if [ "$age" -lt 0 ]; then age=0; fi

  if is_claude "$LOCK_PID" && [ "$age" -lt "$STALE_AFTER" ]; then
    note "lead pid $LOCK_PID alive, $src $((age / 60)) min old; exit"
    exit 0
  fi

  if is_claude "$LOCK_PID"; then
    reason="lead pid $LOCK_PID alive but its $src is $((age / 60)) min old"
    if ! end_process "$LOCK_PID"; then
      note "$reason; it is still running after TERM and KILL: starting nothing"
      exit 1
    fi
    KILLED_PID=$LOCK_PID
    reason="$reason: ended it"
  elif is_alive "$LOCK_PID"; then
    reason="pid $LOCK_PID is alive but not a claude process (pid reused): not killed"
  else
    reason="lead process ${LOCK_PID:-(no pid)} is gone"
  fi
  record_crash "${LOCK_PID:-none}" "$reason"
  rm -f "$LOCK"
  note "crash: $reason; removed LEAD.lock"
}

# A shift that runs without a lock: give it 30 minutes to write LEAD.lock, then treat it like a stale lead.
handle_lockless_shift() {
  local cpid m age
  if [ ! -f "$CURRENT_PID" ]; then return 0; fi
  cpid=$(read_pid_file "$CURRENT_PID")
  if [ -z "$cpid" ] || [ "$cpid" = "$KILLED_PID" ] || ! is_claude "$cpid"; then return 0; fi
  m=$(mtime "$CURRENT_PID" || true)
  if [ -z "$m" ]; then return 0; fi
  age=$(($(now_epoch) - m))
  if [ "$age" -lt "$STALE_AFTER" ]; then
    note "shift pid $cpid started $((age / 60)) min ago and holds no LEAD.lock yet; exit"
    exit 0
  fi
  if ! end_process "$cpid"; then
    note "shift pid $cpid ran $((age / 60)) min without LEAD.lock and is still running after TERM and KILL: starting nothing"
    exit 1
  fi
  KILLED_PID=$cpid
  record_crash "$cpid" "shift pid $cpid ran $((age / 60)) min without writing LEAD.lock: ended it"
  note "crash: shift pid $cpid held no LEAD.lock after $((age / 60)) min; ended it"
}

# After ending a lead, give its shift.sh up to 10 s to finish: it may write PAUSED_UNTIL, then removes current.pid.
wait_for_wrapper() {
  local i=0 cur
  while [ "$i" -lt 20 ]; do
    if [ ! -f "$CURRENT_PID" ]; then return 0; fi
    cur=$(read_pid_file "$CURRENT_PID")
    if [ "$cur" != "$1" ]; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 0
}

# ---- step 5: start a shift -----------------------------------------------------------------------------------
start_shift() {
  local stamp wrapper cpid="" i=0
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then die "claude not found ('$CLAUDE_BIN'); no shift started"; fi
  if [ ! -f "$PROMPT_FILE" ]; then die "build prompt not found ($PROMPT_FILE); no shift started"; fi
  if [ ! -f "$SCRIPT_DIR/shift.sh" ]; then die "shift.sh missing in $SCRIPT_DIR; no shift started"; fi
  stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
  rm -f "$CURRENT_PID"
  export ROSIE_CODE_DIR="$CODE_DIR" ROSIE_OPS_DIR="$OPS_DIR" ROSIE_HANDOVER_DIR="$HANDOVER_DIR" ROSIE_CLAUDE_BIN="$CLAUDE_BIN"
  # Its own process group (set -m), so it outlives this run; the plist also sets AbandonProcessGroup.
  set -m
  nohup /bin/bash "$SCRIPT_DIR/shift.sh" "$stamp" </dev/null >>"$SHIFTS_DIR/shifts.log" 2>&1 &
  wrapper=$!
  set +m
  while [ "$i" -lt 20 ]; do
    if [ -s "$CURRENT_PID" ]; then break; fi
    if ! is_alive "$wrapper"; then break; fi
    sleep 0.5
    i=$((i + 1))
  done
  cpid=$(read_pid_file "$CURRENT_PID")
  if [ -n "$cpid" ]; then
    note "started shift $stamp: claude pid $cpid (wrapper $wrapper), output ops/shifts/$stamp.jsonl"
  elif is_alive "$wrapper"; then
    note "started shift $stamp: wrapper $wrapper, claude pid not recorded yet; output ops/shifts/$stamp.jsonl"
  else
    note "started shift $stamp, which has already ended: see ops/shifts/shifts.log and ops/shifts/$stamp.*"
  fi
}

main() {
  local n
  if [ ! -d "$OPS_DIR" ]; then die "no ops folder at $OPS_DIR"; fi
  cd "$CODE_DIR"
  mkdir -p "$WD_DIR" "$SHIFTS_DIR"
  take_run_lock

  # 2. A pause set at a usage limit (rule 7.13).
  if paused_now; then exit 0; fi

  # A crash stop holds until a person deletes ops/watchdog/STOPPED.
  if [ -f "$STOPPED" ]; then
    note "stopped since $(sed -n 's/^stopped=//p' "$STOPPED"): starting nothing until ops/watchdog/STOPPED is deleted"
    exit 0
  fi

  # 3. One lead.
  if [ -f "$LOCK" ]; then handle_lock; fi
  handle_lockless_shift
  if [ -n "$KILLED_PID" ]; then
    wait_for_wrapper "$KILLED_PID"
    if paused_now; then exit 0; fi
  fi

  # 4. The crash stop.
  n=$(recent_crashes)
  if [ "$n" -ge "$CRASH_LIMIT" ]; then
    stop_watchdog "$n"
    exit 0
  fi

  # 5. No lead is running: start a shift.
  if [ -z "$NOTES" ]; then note "no lead running"; fi
  start_shift
}

main "$@"
