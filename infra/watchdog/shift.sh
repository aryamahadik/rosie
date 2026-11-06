#!/bin/bash
# One headless lead shift: factory spec section 10 (steps 5 and 6), build prompt 5.8 and 7.13.
# rosie-watchdog.sh starts it in the background. It runs claude in the code folder with the continue message,
# writes claude's pid to ops/shifts/current.pid (the lead copies it into ops/LEAD.lock), waits for the run to
# end, and if the run stopped on a usage limit with a reset time, writes that time to ops/PAUSED_UNTIL.
# Output: ops/shifts/<stamp>.jsonl (stream-json) and ops/shifts/<stamp>.stderr.log; events go to
# ops/shifts/shifts.log. It never reads keys. Bash 3.2 (macOS /bin/bash).
# Usage: shift.sh [stamp, e.g. 2026-11-05T201500Z]
# Overrides, for the self-test: ROSIE_CODE_DIR, ROSIE_OPS_DIR, ROSIE_HANDOVER_DIR, ROSIE_CLAUDE_BIN.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CODE_DIR=${ROSIE_CODE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}
OPS_DIR=${ROSIE_OPS_DIR:-$CODE_DIR/ops}
HANDOVER_DIR=${ROSIE_HANDOVER_DIR:-/Users/aryamahadik/Downloads/Rosfield_Main/Rosfield Main Handover}
CLAUDE_BIN=${ROSIE_CLAUDE_BIN:-claude}
PROMPT_FILE="$HANDOVER_DIR/3 Build Plan Prompt for Claude.md"
SHIFTS_DIR="$OPS_DIR/shifts"
CURRENT_PID="$SHIFTS_DIR/current.pid"
PAUSED="$OPS_DIR/PAUSED_UNTIL"
LOG="$SHIFTS_DIR/shifts.log"

# The continue message, word for word (build prompt, "How to use", step 4).
MESSAGE='Continue the Rosie build as its lead. Read `3 Build Plan Prompt for Claude.md` in the Rosfield Main Handover folder, then ops/STATE.md and ops/BOARD.md, then carry on.'

# A usage-limit message: the spec's three phrases, widened to the wording of Claude Code 2.1.318
# ("You've hit your weekly limit", "You've hit your 5-hour limit"), matched case-insensitively.
LIMIT_RE='usage limit|limit reached|hit your ([a-z0-9-]+ )*limit'

RE_STAMP='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z$'
RE_EPOCH='^[0-9]{9,11}$'
RE_ISO='^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(:([0-9]{2}))?(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

die() {
  if [ -d "$SHIFTS_DIR" ]; then log "error: $*"; fi
  echo "shift.sh: $*" >&2
  exit 1
}

iso_from_epoch() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }

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

# Alive (not a zombie) and its command line names claude.
is_claude() {
  local st cmd
  case ${1:-} in '' | *[!0-9]*) return 1 ;; esac
  if [ "$1" -le 1 ] || ! kill -0 "$1" 2>/dev/null; then return 1; fi
  st=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  case $st in Z*) return 1 ;; esac
  cmd=$(ps -o command= -p "$1" 2>/dev/null) || return 1
  case $cmd in *[Cc][Ll][Aa][Uu][Dd][Ee]*) return 0 ;; esac
  return 1
}

# date in a given IANA zone; an empty zone means this Mac's own.
tz_date() {
  local tz=$1
  shift
  if [ -n "$tz" ]; then TZ="$tz" date "$@"; else date "$@"; fi
}

month_number() {
  case $1 in
    Jan) echo 01 ;; Feb) echo 02 ;; Mar) echo 03 ;; Apr) echo 04 ;; May) echo 05 ;; Jun) echo 06 ;;
    Jul) echo 07 ;; Aug) echo 08 ;; Sep) echo 09 ;; Oct) echo 10 ;; Nov) echo 11 ;; Dec) echo 12 ;;
    *) return 1 ;;
  esac
}

# The reset time in a limit message, as Claude Code writes it: "resets 3pm (America/New_York)",
# "resets Nov 9, 10:30am (Europe/London)", "resets Jan 2, 2027, 10am", or "reset at 15:00". Prints the epoch.
epoch_from_reset_text() {
  local rest mon="" day="" year="" given_year="" hh mm ap utc tz="" m today e now
  local re_date='^([A-Z][a-z]{2}) ([0-9]{1,2}), (([0-9]{4}), )?(.*)$'
  local re_time='^([0-9]{1,2})(:([0-9]{2}))? ?([AaPp][Mm])?(Z)?(.*)$'
  local re_tz='^ \(([A-Za-z_]+(/[A-Za-z0-9_+-]+)*)\)'
  rest=$(printf '%s' "$1" | sed -nE 's/.*[Rr]esets?( at)? //p')
  if [ -z "$rest" ]; then return 1; fi
  if [[ $rest =~ $re_date ]]; then
    mon=${BASH_REMATCH[1]} day=${BASH_REMATCH[2]} given_year=${BASH_REMATCH[4]} rest=${BASH_REMATCH[5]}
  fi
  if ! [[ $rest =~ $re_time ]]; then return 1; fi
  hh=$((10#${BASH_REMATCH[1]})) mm=$((10#${BASH_REMATCH[3]:-0})) ap=${BASH_REMATCH[4]} utc=${BASH_REMATCH[5]}
  rest=${BASH_REMATCH[6]}
  case $ap in
    [Aa][Mm]) if [ "$hh" -eq 12 ]; then hh=0; fi ;;
    [Pp][Mm]) if [ "$hh" -lt 12 ]; then hh=$((hh + 12)); fi ;;
  esac
  if [ "$hh" -gt 23 ] || [ "$mm" -gt 59 ]; then return 1; fi
  if [[ $rest =~ $re_tz ]] && [ -f "/usr/share/zoneinfo/${BASH_REMATCH[1]}" ]; then tz=${BASH_REMATCH[1]}; fi
  if [ -n "$utc" ]; then tz=UTC; fi
  now=$(date -u +%s)
  if [ -n "$mon" ]; then
    m=$(month_number "$mon") || return 1
    year=${given_year:-$(tz_date "$tz" +%Y)}
    e=$(tz_date "$tz" -j -f '%Y-%m-%d %H:%M:%S' "$(printf '%04d-%s-%02d %02d:%02d:00' "$year" "$m" "$((10#$day))" "$hh" "$mm")" +%s 2>/dev/null) || return 1
    if [ -z "$given_year" ] && [ "$e" -lt $((now - 86400)) ]; then # "Jan 2" read in late December
      e=$(tz_date "$tz" -j -f '%Y-%m-%d %H:%M:%S' "$(printf '%04d-%s-%02d %02d:%02d:00' "$((year + 1))" "$m" "$((10#$day))" "$hh" "$mm")" +%s 2>/dev/null) || return 1
    fi
  else
    today=$(tz_date "$tz" +%Y-%m-%d)
    e=$(tz_date "$tz" -j -f '%Y-%m-%d %H:%M:%S' "$(printf '%s %02d:%02d:00' "$today" "$hh" "$mm")" +%s 2>/dev/null) || return 1
    if [ "$e" -le "$now" ]; then # the next such clock time is tomorrow (date -v keeps it right across DST)
      e=$(tz_date "$tz" -j -v+1d -f '%Y-%m-%d %H:%M:%S' "$(printf '%s %02d:%02d:00' "$today" "$hh" "$mm")" +%s 2>/dev/null) || return 1
    fi
  fi
  echo "$e"
}

# Prints the reset time (epoch) when the run ended on a usage limit, "none" when there is a limit message but
# no readable reset time, and nothing otherwise. It reads only what Claude Code itself writes (error results,
# API error messages, rate-limit events, stderr), never tool results or the model's own words, so a file or
# a summary that mentions a limit cannot pause the build.
limit_reset_epoch() {
  local out=$1 err=$2 lines hits line e="" t now
  lines=$({
    grep -v -E '^\{"type":"user"' "$out" | grep -E '"type":"result"' | grep -F '"is_error":true' || true
    grep -v -E '^\{"type":"user"' "$out" | grep -E '"type":"assistant"' | grep -F '"is_api_error_message":true' || true
    cat "$err" || true
  } 2>/dev/null)
  # "Server is temporarily limiting requests (not your usage limit)" is a server throttle, not a limit.
  hits=$(printf '%s\n' "$lines" | grep -E -i "$LIMIT_RE" | grep -v -i 'not your usage limit' || true)
  if [ -z "$hits" ]; then return 0; fi
  # 1. The refused request's own record (api_error_params.rate_limit_info), or the older "limit reached|<epoch>".
  e=$(printf '%s\n' "$hits" | sed -nE 's/.*"rate_limit_info":\{"status":"rejected"[^{}]*"resetsAt":([0-9]{9,11}).*/\1/p' | tail -n 1)
  if [ -z "$e" ]; then
    e=$(printf '%s\n' "$hits" | sed -nE 's/.*limit reached\|([0-9]{9,11}).*/\1/Ip' | tail -n 1)
  fi
  # 2. The run's last rate-limit event, when it says requests are refused.
  if [ -z "$e" ]; then
    e=$(grep -v -E '^\{"type":"user"' "$out" 2>/dev/null | grep -E '"type":"rate_limit_event"' | tail -n 1 |
      sed -nE 's/.*"rate_limit_info":\{"status":"rejected"[^{}]*"resetsAt":([0-9]{9,11}).*/\1/p' || true)
  fi
  # 3. The clock time in the message text.
  if [ -z "$e" ]; then
    while IFS= read -r line; do
      if t=$(epoch_from_reset_text "$line"); then e=$t; fi
    done <<EOF
$hits
EOF
  fi
  now=$(date -u +%s)
  # A reset from a day ago up to 8 days ahead (a weekly limit resets within 7 days); anything else is not trusted.
  if [ -n "$e" ] && [ "$e" -gt $((now - 86400)) ] && [ "$e" -lt $((now + 8 * 86400)) ]; then
    echo "$e"
  else
    echo none
  fi
}

# Writes the reset time to ops/PAUSED_UNTIL, unless it already holds a later time.
write_paused_until() {
  local e=$1 raw="" old=""
  if [ -f "$PAUSED" ]; then
    IFS= read -r raw <"$PAUSED" || true
    old=$(epoch_from_iso "$(trim "$raw")" || true)
  fi
  if [ -n "$old" ] && [ "$old" -gt "$e" ]; then
    log "usage limit: reset $(iso_from_epoch "$e"); ops/PAUSED_UNTIL already holds the later $(iso_from_epoch "$old"), kept"
    return 0
  fi
  printf '%s\n' "$(iso_from_epoch "$e")" >"$PAUSED.tmp"
  mv -f "$PAUSED.tmp" "$PAUSED"
  log "usage limit: wrote ops/PAUSED_UNTIL $(iso_from_epoch "$e")"
}

main() {
  local stamp out err pid rc=0 started reset cur
  stamp=${1:-$(date -u +%Y-%m-%dT%H%M%SZ)}
  if ! [[ $stamp =~ $RE_STAMP ]]; then die "bad stamp '$stamp' (expected e.g. 2026-11-05T201500Z)"; fi
  if [ ! -d "$OPS_DIR" ]; then die "no ops folder at $OPS_DIR"; fi
  mkdir -p "$SHIFTS_DIR"
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then die "claude not found ('$CLAUDE_BIN')"; fi
  if [ ! -d "$HANDOVER_DIR" ]; then die "handover folder not found: $HANDOVER_DIR"; fi
  if [ ! -f "$PROMPT_FILE" ]; then die "build prompt not found: $PROMPT_FILE"; fi
  if [ -f "$CURRENT_PID" ]; then
    cur=$(read_pid_file "$CURRENT_PID")
    if is_claude "$cur"; then die "a shift is already running (pid $cur)"; fi
  fi
  out="$SHIFTS_DIR/$stamp.jsonl"
  err="$SHIFTS_DIR/$stamp.stderr.log"

  # The shift's environment (5.8): no ceiling on waiting for background work, subagents one level deep, never
  # agent teams. No API key either, so the shift runs on the signed-in Claude account (rule 6: no spend).
  unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1

  cd "$CODE_DIR"
  started=$(date -u +%s)
  # --append-system-prompt-file is not in `claude --help` but 2.1.318 defines it (hidden option).
  # --permission-prompts none: a prompt nobody can answer is denied, never waited on (5.8).
  "$CLAUDE_BIN" -p "$MESSAGE" \
    --add-dir "$HANDOVER_DIR" \
    --append-system-prompt-file "$PROMPT_FILE" \
    --permission-mode acceptEdits \
    --permission-prompts none \
    --output-format stream-json \
    --verbose \
    </dev/null >"$out" 2>"$err" &
  pid=$!
  printf '%s\n' "$pid" >"$CURRENT_PID.tmp"
  mv -f "$CURRENT_PID.tmp" "$CURRENT_PID"
  log "started shift $stamp: pid $pid, output ops/shifts/$stamp.jsonl"

  wait "$pid" || rc=$?
  export LC_ALL=C # read the output as bytes from here on; the shift itself kept the caller's locale

  # 6. A usage limit with a reset time pauses the watchdog until then (rule 7.13).
  reset=$(limit_reset_epoch "$out" "$err" || true)
  if [ "$reset" = none ]; then
    log "usage-limit message without a readable reset time: ops/PAUSED_UNTIL not written"
  elif [ -n "$reset" ]; then
    write_paused_until "$reset"
  fi

  cur=$(read_pid_file "$CURRENT_PID")
  if [ "$cur" = "$pid" ]; then rm -f "$CURRENT_PID"; fi
  log "ended shift $stamp: pid $pid, exit $rc, after $((($(date -u +%s) - started) / 60)) min"
}

main "$@"
