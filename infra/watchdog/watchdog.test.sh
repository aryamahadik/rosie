#!/bin/bash
# Self-test for the watchdog (factory spec section 10). It runs rosie-watchdog.sh and shift.sh against a
# temporary ops folder, a temporary handover folder and a fake claude command, so no real shift starts and
# the real ops/ folder is never touched. Run: infra/watchdog/watchdog.test.sh   (exit 0 when every check passes)
# Covers: fresh heartbeat -> exits; stale heartbeat -> kills and restarts; dead pid -> restarts; PAUSED_UNTIL in
# the future -> exits; 3 crashes in 2 hours -> STOPPED and no start; a usage-limit message -> PAUSED_UNTIL
# written. Also: the shift's exact flags and environment, look-alike messages, a shift without a lock, a reused
# pid, status.sh, and bash -n / plutil -lint on every file.
set -euo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/rosie-watchdog-test.XXXXXX")
T=$(cd "$T" && pwd -P)
OPS="$T/code/ops"
NY=America/New_York
PASS=0
FAIL=0
WD_RC=0
MESSAGE='Continue the Rosie build as its lead. Read `3 Build Plan Prompt for Claude.md` in the Rosfield Main Handover folder, then ops/STATE.md and ops/BOARD.md, then carry on.'

# Only processes this test started are ever signalled: fakes by their command line, sleeps by theirs.
is_fake() { case $(ps -o command= -p "$1" 2>/dev/null) in *"$T/bin/claude"*) return 0 ;; esac; return 1; }
is_test_sleep() { case $(ps -o command= -p "$1" 2>/dev/null) in "sleep 300") return 0 ;; esac; return 1; }

cleanup() {
  local pid
  if [ -f "$T/fake-pids" ]; then
    while read -r pid; do if is_fake "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi; done <"$T/fake-pids"
  fi
  if [ -f "$T/other-pids" ]; then
    while read -r pid; do if is_test_sleep "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi; done <"$T/other-pids"
  fi
  sleep 0.5
  rm -rf "$T"
}
trap cleanup EXIT

# ---- the fake claude ----------------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/handover" "$T/fixtures"
echo "fake build prompt" >"$T/handover/3 Build Plan Prompt for Claude.md"
cat >"$T/bin/claude" <<'FAKE'
#!/bin/bash
# Fake claude for watchdog.test.sh: records how it was called and prints canned output. It contacts nothing.
set -u
echo "$$" >>"$FAKE_DIR/fake-pids"
n=1
while [ -e "$FAKE_DIR/call-$n.args" ]; do n=$((n + 1)); done
for a in "$@"; do printf '%s\n' "$a"; done >"$FAKE_DIR/call-$n.args"
{
  echo "cwd=$PWD"
  echo "bg=${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS-unset}"
  echo "depth=${CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH-unset}"
  echo "teams=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS-unset}"
  echo "apikey=${ANTHROPIC_API_KEY+set}"
  echo "authtoken=${ANTHROPIC_AUTH_TOKEN+set}"
  if [ -t 0 ]; then echo "stdin=tty"; else echo "stdin=redirected"; fi
} >"$FAKE_DIR/call-$n.env"
echo '{"type":"system","subtype":"init","session_id":"fake"}'
case ${FAKE_CLAUDE_MODE:-ok} in
  long)
    trap 'kill "$child" 2>/dev/null; exit 143' TERM
    sleep 120 &
    child=$!
    wait "$child"
    ;;
  output)
    cat "$FAKE_CLAUDE_OUTPUT"
    exit "${FAKE_CLAUDE_RC:-1}"
    ;;
  *)
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"fake"}'
    ;;
esac
FAKE
chmod +x "$T/bin/claude"

export FAKE_DIR="$T"
export ROSIE_CODE_DIR="$T/code" ROSIE_OPS_DIR="$OPS" ROSIE_HANDOVER_DIR="$T/handover" ROSIE_CLAUDE_BIN="$T/bin/claude"
export PATH="$T/bin:$PATH"
# Set on purpose, with fake values: the shift must drop all three (5.8: never agent teams; rule 6: no API key).
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 ANTHROPIC_API_KEY=not-a-real-key ANTHROPIC_AUTH_TOKEN=not-a-real-token
unset FAKE_CLAUDE_MODE FAKE_CLAUDE_OUTPUT FAKE_CLAUDE_RC

# Refuse to run unless every path points into the temporary folder and "claude" is the fake.
for p in "$ROSIE_CODE_DIR" "$ROSIE_OPS_DIR" "$ROSIE_HANDOVER_DIR" "$ROSIE_CLAUDE_BIN"; do
  case $p in "$T"/*) ;; *)
    echo "watchdog.test.sh: unsafe path $p" >&2
    exit 1
    ;;
  esac
done
if [ "$(command -v claude)" != "$T/bin/claude" ]; then
  echo "watchdog.test.sh: the fake claude is not first on PATH" >&2
  exit 1
fi

printf '%s\n' -p "$MESSAGE" --add-dir "$T/handover" \
  --append-system-prompt-file "$T/handover/3 Build Plan Prompt for Claude.md" \
  --permission-mode acceptEdits --permission-prompts none --output-format stream-json --verbose >"$T/expected.args"

# ---- helpers ------------------------------------------------------------------------------------------------
check() {
  local name=$1
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s\n' "$name"
  fi
}
now() { date -u +%s; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
iso_ago() { iso $(($(now) - $1)); }
iso_in() { iso $(($(now) + $1)); }
count_in() {
  local n
  n=$(grep -c -F -- "$2" "$1" 2>/dev/null || true)
  echo "${n:-0}"
}
calls() {
  local n=0 f
  for f in "$T"/call-*.args; do if [ -e "$f" ]; then n=$((n + 1)); fi; done
  echo "$n"
}
calls_are() { [ "$(calls)" -eq "$1" ]; }
ended_are() { [ "$(count_in "$OPS/shifts/shifts.log" 'ended shift')" -eq "$1" ]; }
all_ended() { [ "$(count_in "$OPS/shifts/shifts.log" 'started shift')" -eq "$(count_in "$OPS/shifts/shifts.log" 'ended shift')" ]; }
crashes_are() { [ "$(count_in "$OPS/watchdog/crashes.log" ' crash ')" -eq "$1" ]; }
log_lines_are() { [ "$(count_in "$OPS/watchdog/watchdog.log" 'T')" -eq "$1" ]; }
gone() {
  if ! kill -0 "$1" 2>/dev/null; then return 0; fi
  case $(ps -o stat= -p "$1" 2>/dev/null) in Z*) return 0 ;; esac
  return 1
}
running() { ! gone "$1"; }
wait_for() {
  local tries=$(($1 * 5)) i=0
  shift
  while [ "$i" -lt "$tries" ]; do
    if "$@"; then return 0; fi
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}
last_log_has() {
  local l
  l=$(tail -n 1 "$OPS/watchdog/watchdog.log" 2>/dev/null || true)
  case $l in *"$1"*) return 0 ;; esac
  return 1
}
file_has() { grep -q -F -- "$2" "$1" 2>/dev/null; }
not_in_file() { ! grep -q -F -- "$2" "$1" 2>/dev/null; }
file_is() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
no_file() { [ ! -e "$1" ]; }
dead_pid() { /bin/bash -c 'echo $$'; }

# Ends what the previous case left running, waits for its shifts to finish, and empties the ops folder.
reset_state() {
  local pid
  if [ -f "$T/fake-pids" ]; then
    while read -r pid; do if is_fake "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi; done <"$T/fake-pids"
  fi
  if ! wait_for 10 all_ended; then echo "warning: a shift from the previous case did not end" >&2; fi
  rm -rf "$T/code" "$T"/call-*
  mkdir -p "$OPS"
}

run_wd() {
  WD_RC=0
  "$HERE/rosie-watchdog.sh" >"$T/wd.out" 2>"$T/wd.err" || WD_RC=$?
}

# The same with one variable changed for this run only (it must still point into the temporary folder).
run_wd_env() {
  case $ROSIE_CLAUDE_BIN in "$T"/*) ;; *) return 1 ;; esac
  WD_RC=0
  ROSIE_CLAUDE_BIN="$ROSIE_CLAUDE_BIN" "$HERE/rosie-watchdog.sh" >"$T/wd.out" 2>"$T/wd.err" || WD_RC=$?
}

# A fake lead started through shift.sh, as the watchdog does it. Prints the fake claude's pid.
start_lead() {
  local before
  before=$(calls)
  FAKE_CLAUDE_MODE=long nohup /bin/bash "$HERE/shift.sh" </dev/null >/dev/null 2>&1 &
  wait_for 10 calls_are $((before + 1)) || return 1
  wait_for 10 test -s "$OPS/shifts/current.pid" || return 1
  tr -d ' \t\r\n' <"$OPS/shifts/current.pid"
}

write_lock() { printf 'pid=%s\nstarted=%s\nheartbeat=%s\n' "$1" "$(iso_ago 3600)" "$2" >"$OPS/LEAD.lock"; }

shift_refused() {
  if /bin/bash "$HERE/shift.sh" >/dev/null 2>&1; then return 1; fi
  file_has "$OPS/shifts/shifts.log" "a shift is already running (pid $1)"
}

# One shift in the foreground with canned output.
shift_with() {
  FAKE_CLAUDE_MODE=output FAKE_CLAUDE_OUTPUT="$1" FAKE_CLAUDE_RC="${2:-1}" /bin/bash "$HERE/shift.sh" >/dev/null 2>&1 || true
}

# Times as Claude Code 2.1.318 prints them in America/New_York: "3pm", "3:30pm", "Nov 9, 10am".
ny() { TZ=$NY date -r "$1" "$2"; }
clock() {
  local h m ap
  h=$(ny "$1" +%I)
  m=$(ny "$1" +%M)
  ap=$(ny "$1" +%p | tr 'APM' 'apm')
  h=${h#0}
  if [ "$m" = 00 ]; then echo "$h$ap"; else echo "$h:$m$ap"; fi
}
day_clock() {
  local d
  d=$(ny "$1" +%d)
  echo "$(ny "$1" +%b) ${d#0}, $(clock "$1")"
}

# ---- 0. syntax ----------------------------------------------------------------------------------------------
echo "== 0. syntax"
for f in rosie-watchdog.sh shift.sh install.sh uninstall.sh status.sh watchdog.test.sh; do
  check "bash -n $f" /bin/bash -n "$HERE/$f"
done
check "plutil -lint com.rosfield.rosie-watchdog.plist" plutil -lint -s "$HERE/com.rosfield.rosie-watchdog.plist"

# ---- 1. fresh heartbeat -------------------------------------------------------------------------------------
echo "== 1. fresh heartbeat: one lead, the watchdog exits"
reset_state
P=$(start_lead)
write_lock "$P" "$(iso_ago 60)"
run_wd
check "exits 0" [ "$WD_RC" -eq 0 ]
check "the lead keeps running" running "$P"
check "no second shift starts" calls_are 1
check "LEAD.lock is kept" [ -f "$OPS/LEAD.lock" ]
check "no crash is recorded" crashes_are 0
check "exactly one log line for the run" log_lines_are 1
check "the log line names the live lead" last_log_has "lead pid $P alive, heartbeat 1 min old; exit"
check "current.pid holds the lead's pid" file_is "$OPS/shifts/current.pid" "$P"
check "shift.sh refuses a second shift while one runs" shift_refused "$P"
kill -TERM "$P" 2>/dev/null || true
check "the lead's shift.sh logs its end and removes current.pid" wait_for 10 ended_are 1
check "... current.pid is gone" no_file "$OPS/shifts/current.pid"

# ---- 2. stale heartbeat -------------------------------------------------------------------------------------
echo "== 2. stale heartbeat: the watchdog ends the lead, records a crash and restarts"
reset_state
P=$(start_lead)
write_lock "$P" "$(iso_ago 2700)"
run_wd
check "exits 0" [ "$WD_RC" -eq 0 ]
check "the stale lead is ended" wait_for 5 gone "$P"
check "a crash is recorded for it" file_has "$OPS/watchdog/crashes.log" "crash pid=$P lead pid $P alive but its heartbeat is 45 min old: ended it"
check "the stale lock is removed" no_file "$OPS/LEAD.lock"
check "a new shift starts" wait_for 10 calls_are 2
check "both shifts end" wait_for 10 ended_are 2
check "the log line tells the story" last_log_has "crash: lead pid $P alive but its heartbeat is 45 min old: ended it; removed LEAD.lock; started shift"
check "claude gets exactly the shift's flags and continue message" cmp -s "$T/expected.args" "$T/call-2.args"
check "env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0" file_has "$T/call-2.env" "bg=0"
check "env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1" file_has "$T/call-2.env" "depth=1"
check "env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS removed" file_has "$T/call-2.env" "teams=unset"
check "env ANTHROPIC_API_KEY removed" grep -q -x 'apikey=' "$T/call-2.env"
check "env ANTHROPIC_AUTH_TOKEN removed" grep -q -x 'authtoken=' "$T/call-2.env"
check "stdin is not a terminal" file_has "$T/call-2.env" "stdin=redirected"
check "it runs in the code folder" file_has "$T/call-2.env" "cwd=$T/code"
NEWPID=$(tail -n 1 "$T/fake-pids")
check "shifts.log records the new pid and its output file" grep -q -E "started shift [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z: pid $NEWPID, output ops/shifts/[0-9T-]+Z\.jsonl" "$OPS/shifts/shifts.log"
STAMP=$(sed -n "s/.*started shift \([0-9T-]*Z\): pid $NEWPID,.*/\1/p" "$OPS/shifts/shifts.log")
check "the stream-json output is in ops/shifts/<UTC stamp>.jsonl" file_has "$OPS/shifts/$STAMP.jsonl" '"type":"result"'

# ---- 3. dead pid --------------------------------------------------------------------------------------------
echo "== 3. dead pid: the watchdog records a crash and restarts"
reset_state
D=$(dead_pid)
write_lock "$D" "$(iso_ago 60)"
run_wd
check "exits 0" [ "$WD_RC" -eq 0 ]
check "the pid is really dead" gone "$D"
check "a crash is recorded" file_has "$OPS/watchdog/crashes.log" "crash pid=$D lead process $D is gone"
check "the lock is removed" no_file "$OPS/LEAD.lock"
check "a new shift starts" wait_for 10 calls_are 1
check "it ends" wait_for 10 ended_are 1

# ---- 4. PAUSED_UNTIL ----------------------------------------------------------------------------------------
echo "== 4. PAUSED_UNTIL in the future: the watchdog exits"
reset_state
FUT=$(iso_in 3600)
echo "$FUT" >"$OPS/PAUSED_UNTIL"
run_wd
check "exits 0" [ "$WD_RC" -eq 0 ]
check "no shift starts" calls_are 0
check "PAUSED_UNTIL is left as it was" file_is "$OPS/PAUSED_UNTIL" "$FUT"
check "the log line says paused" last_log_has "paused until $FUT (60 min left); exit"
reset_state
TZ=Etc/GMT+5 date -r $(($(now) + 3600)) +%Y-%m-%dT%H:%M:%S-05:00 >"$OPS/PAUSED_UNTIL"
run_wd
check "a future time with a -05:00 offset also pauses" calls_are 0
reset_state
PAST=$(iso_ago 600)
echo "$PAST" >"$OPS/PAUSED_UNTIL"
run_wd
check "a past PAUSED_UNTIL does not hold: a shift starts" wait_for 10 calls_are 1
check "a past PAUSED_UNTIL is left for the next shift to clear" file_is "$OPS/PAUSED_UNTIL" "$PAST"
check "... and the log says so" last_log_has "has passed (left for the next shift to clear)"
wait_for 10 ended_are 1 || true
reset_state
echo "next monday" >"$OPS/PAUSED_UNTIL"
run_wd
check "an unreadable PAUSED_UNTIL starts nothing" calls_are 0
check "... and the log says so" last_log_has "ops/PAUSED_UNTIL is unreadable ('next monday')"
reset_state
: >"$OPS/PAUSED_UNTIL"
run_wd
check "an empty PAUSED_UNTIL holds no time: a shift starts" wait_for 10 calls_are 1
wait_for 10 ended_are 1 || true

# ---- 5. crash stop ------------------------------------------------------------------------------------------
echo "== 5. 3 crashes in 2 hours: STOPPED, an alert, no start"
reset_state
mkdir -p "$OPS/watchdog"
t1=$(($(now) - 3000))
t2=$(($(now) - 1500))
printf '%s epoch=%s crash pid=111 lead process 111 is gone\n' "$(iso $t1)" "$t1" >"$OPS/watchdog/crashes.log"
printf '%s epoch=%s crash pid=222 lead process 222 is gone\n' "$(iso $t2)" "$t2" >>"$OPS/watchdog/crashes.log"
D=$(dead_pid)
write_lock "$D" "$(iso_ago 60)"
run_wd
check "exits 0" [ "$WD_RC" -eq 0 ]
check "the third crash is recorded" crashes_are 3
check "STOPPED is written with the reason" file_has "$OPS/watchdog/STOPPED" "reason=3 shifts in the last 2 hours ended without deleting ops/LEAD.lock"
check "the alert placeholder writes ALERT.md for Jay and the CTO" file_has "$OPS/watchdog/ALERT.md" "watchdog stopped after 3 crashes in 2 hours"
check "no shift starts" calls_are 0
check "the log line says so" last_log_has "3 crashes in 2 hours: wrote ops/watchdog/STOPPED"
run_wd
check "while STOPPED exists, a later run starts nothing" calls_are 0
check "... and its log line says why" last_log_has "starting nothing until ops/watchdog/STOPPED is deleted"
check "... and it does not alert again" [ "$(count_in "$OPS/watchdog/ALERT.md" '## ')" -eq 1 ]
rm -f "$OPS/watchdog/STOPPED"
run_wd
check "after STOPPED is deleted, crashes from before the stop no longer count: a shift starts" wait_for 10 calls_are 1
wait_for 10 ended_are 1 || true
reset_state
mkdir -p "$OPS/watchdog"
for k in 1 2 3; do
  t=$(($(now) - 3 * 3600 - k * 60))
  printf '%s epoch=%s crash pid=%s lead process %s is gone\n' "$(iso $t)" "$t" "$k" "$k" >>"$OPS/watchdog/crashes.log"
done
run_wd
check "3 crashes older than 2 hours do not stop it: a shift starts" wait_for 10 calls_are 1
check "... and no STOPPED is written" no_file "$OPS/watchdog/STOPPED"
wait_for 10 ended_are 1 || true

# ---- 6. usage limits ----------------------------------------------------------------------------------------
echo "== 6. a usage-limit message: PAUSED_UNTIL is written"
reset_state
R=$(($(now) + 2 * 86400 + 1234))
FX="$T/fixtures/limit-full.jsonl"
cat >"$FX" <<EOF
{"type":"system","subtype":"init","session_id":"fake"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":$R,"rateLimitType":"seven_day","utilization":0.97,"isUsingOverage":false},"uuid":"u1","session_id":"fake"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"rule 7.13: Claude's weekly usage limit. Claude AI usage limit reached|$((R - 7200))"}]},"parent_tool_use_id":null,"session_id":"fake"}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":$R,"rateLimitType":"seven_day","isUsingOverage":false},"uuid":"u2","session_id":"fake"}
{"type":"assistant","message":{"id":"m1","type":"message","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You've hit your weekly limit · resets $(day_clock $R) ($NY)"}]},"parent_tool_use_id":null,"session_id":"fake","error":"rate_limit","is_api_error_message":true,"api_error":"usage_limit_reached","api_error_params":{"rate_limit_info":{"status":"rejected","resetsAt":$R,"rateLimitType":"seven_day","isUsingOverage":false}}}
{"type":"result","subtype":"success","is_error":true,"num_turns":3,"result":"You've hit your weekly limit · resets $(day_clock $R) ($NY)","session_id":"fake","permission_denials":[]}
EOF
export FAKE_CLAUDE_MODE=output FAKE_CLAUDE_OUTPUT="$FX"
run_wd
unset FAKE_CLAUDE_MODE FAKE_CLAUDE_OUTPUT
check "the watchdog starts the shift, which ends" wait_for 10 ended_are 1
check "PAUSED_UNTIL holds the exact reset time of the refused request" file_is "$OPS/PAUSED_UNTIL" "$(iso $R)"
check "shifts.log says so" file_has "$OPS/shifts/shifts.log" "usage limit: wrote ops/PAUSED_UNTIL $(iso $R)"
run_wd
check "the next watchdog run is paused and starts nothing" calls_are 1
check "... and its log line says so" last_log_has "paused until $(iso $R)"

reset_state
R=$((($(now) + 3 * 86400) / 3600 * 3600))
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"You've hit your weekly limit · resets $(day_clock $R) ($NY)\",\"session_id\":\"fake\"}" >"$T/fixtures/day.jsonl"
shift_with "$T/fixtures/day.jsonl"
check "text only, 'resets $(day_clock $R) ($NY)': PAUSED_UNTIL = that time" file_is "$OPS/PAUSED_UNTIL" "$(iso $R)"

reset_state
R=$((($(now) + 2 * 3600) / 3600 * 3600 + 1800))
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"You've hit your 5-hour limit · resets $(clock $R) ($NY)\",\"session_id\":\"fake\"}" >"$T/fixtures/clock.jsonl"
shift_with "$T/fixtures/clock.jsonl"
check "text only, 'resets $(clock $R) ($NY)': PAUSED_UNTIL = the next such time" file_is "$OPS/PAUSED_UNTIL" "$(iso $R)"

reset_state
R=$(($(now) + 5 * 3600))
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Claude AI usage limit reached|$R\",\"session_id\":\"fake\"}" >"$T/fixtures/legacy.jsonl"
shift_with "$T/fixtures/legacy.jsonl"
check "older form 'usage limit reached|<epoch>': PAUSED_UNTIL = that epoch" file_is "$OPS/PAUSED_UNTIL" "$(iso $R)"

reset_state
R=$(($(now) + 4 * 3600 + 77))
cat >"$T/fixtures/event.jsonl" <<EOF
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":$R,"rateLimitType":"five_hour","isUsingOverage":false},"uuid":"u","session_id":"fake"}
{"type":"result","subtype":"success","is_error":true,"result":"API Error: Claude usage limit reached.","session_id":"fake"}
EOF
shift_with "$T/fixtures/event.jsonl"
check "a message without a time plus a rejected rate_limit_event: PAUSED_UNTIL = the event's reset" file_is "$OPS/PAUSED_UNTIL" "$(iso $R)"

reset_state
R=$(($(now) + 2 * 86400))
cat >"$T/fixtures/lookalike.jsonl" <<EOF
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Claude AI usage limit reached|$R. You've hit your weekly limit · resets $(day_clock $R) ($NY)"}]},"session_id":"fake"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Weekly usage limit at 40%; it resets $(day_clock $R) ($NY)."}]},"session_id":"fake"}
{"type":"result","subtype":"success","is_error":false,"result":"Shift over. Weekly usage limit at 40%, resets $(day_clock $R) ($NY).","session_id":"fake"}
EOF
shift_with "$T/fixtures/lookalike.jsonl" 0
check "limit words in tool results, the model's text or a successful result write nothing" no_file "$OPS/PAUSED_UNTIL"

reset_state
cat >"$T/fixtures/throttle.jsonl" <<'EOF'
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"}]},"session_id":"fake","error":"rate_limit","is_api_error_message":true}
{"type":"result","subtype":"success","is_error":true,"result":"API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited","session_id":"fake"}
EOF
shift_with "$T/fixtures/throttle.jsonl"
check "a server throttle ('not your usage limit') writes nothing" no_file "$OPS/PAUSED_UNTIL"
check "... and is not taken for a limit message" not_in_file "$OPS/shifts/shifts.log" "usage-limit message"

reset_state
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"result":"Claude usage limit reached. Try again later.","session_id":"fake"}' >"$T/fixtures/notime.jsonl"
shift_with "$T/fixtures/notime.jsonl"
check "a limit message without a readable reset time writes nothing" no_file "$OPS/PAUSED_UNTIL"
check "... and shifts.log says so" file_has "$OPS/shifts/shifts.log" "usage-limit message without a readable reset time"

reset_state
R=$(($(now) + 30 * 86400))
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Claude AI usage limit reached|$R\",\"session_id\":\"fake\"}" >"$T/fixtures/far.jsonl"
shift_with "$T/fixtures/far.jsonl"
check "a reset 30 days ahead is not trusted" no_file "$OPS/PAUSED_UNTIL"

reset_state
LATER=$(iso_in $((6 * 86400)))
echo "$LATER" >"$OPS/PAUSED_UNTIL"
shift_with "$T/fixtures/legacy.jsonl"
check "a later PAUSED_UNTIL already in place is kept" file_is "$OPS/PAUSED_UNTIL" "$LATER"

# ---- 7. a shift without LEAD.lock ---------------------------------------------------------------------------
echo "== 7. a shift without LEAD.lock: 30 minutes of grace, then ended and restarted"
reset_state
P=$(start_lead)
run_wd
check "a fresh shift without a lock is left alone" running "$P"
check "... no second shift starts" calls_are 1
check "... and the log line says why" last_log_has "shift pid $P started 0 min ago and holds no LEAD.lock yet; exit"
touch -t "$(date -r $(($(now) - 1860)) +%Y%m%d%H%M.%S)" "$OPS/shifts/current.pid"
run_wd
check "after 30 minutes without a lock it is ended" wait_for 5 gone "$P"
check "... a crash is recorded" file_has "$OPS/watchdog/crashes.log" "crash pid=$P shift pid $P ran 31 min without writing LEAD.lock: ended it"
check "... and a new shift starts" wait_for 10 calls_are 2
wait_for 10 ended_are 2 || true

# ---- 8. a reused pid ----------------------------------------------------------------------------------------
echo "== 8. a stale lock whose pid now belongs to another program: never killed"
reset_state
sleep 300 &
S=$!
echo "$S" >>"$T/other-pids"
write_lock "$S" "$(iso_ago 2700)"
run_wd
check "the other program keeps running" running "$S"
check "a crash is recorded, naming the reused pid" file_has "$OPS/watchdog/crashes.log" "pid $S is alive but not a claude process (pid reused): not killed"
check "the lock is removed" no_file "$OPS/LEAD.lock"
check "a new shift starts" wait_for 10 calls_are 1
kill "$S" 2>/dev/null || true
wait "$S" 2>/dev/null || true
wait_for 10 ended_are 1 || true

# ---- 9. edge cases ------------------------------------------------------------------------------------------
echo "== 9. edge cases: half-written lock, unreadable heartbeat, run lock, missing claude"
reset_state
printf 'pid=\n' >"$OPS/LEAD.lock"
(
  sleep 1
  rm -f "$OPS/LEAD.lock"
) &
run_wd
check "a lock deleted while it is re-read is a clean end: no crash" crashes_are 0
check "... and a shift starts" wait_for 10 calls_are 1
wait_for 10 ended_are 1 || true
reset_state
P=$(start_lead)
write_lock "$P" "garbage"
run_wd
check "an unreadable heartbeat falls back to the lock's file time: the live lead is kept" running "$P"
check "... no second shift starts" calls_are 1
check "... and the log says which time it used" last_log_has "lead pid $P alive, lock file time (heartbeat unreadable) 0 min old; exit"
kill -TERM "$P" 2>/dev/null || true
wait_for 10 ended_are 1 || true
reset_state
mkdir -p "$OPS/watchdog/.run.lock"
run_wd
check "a run lock held by another run: exit, start nothing" calls_are 0
check "... and the log says so" last_log_has "another watchdog run is active; exit"
touch -t "$(date -r $(($(now) - 900)) +%Y%m%d%H%M.%S)" "$OPS/watchdog/.run.lock"
run_wd
check "a run lock left 15 minutes ago by a killed run is cleared: a shift starts" wait_for 10 calls_are 1
check "... and the run lock is released afterwards" no_file "$OPS/watchdog/.run.lock"
wait_for 10 ended_are 1 || true
reset_state
ROSIE_CLAUDE_BIN="$T/bin/missing-claude" run_wd_env
check "a missing claude: exit 1" [ "$WD_RC" -eq 1 ]
check "... starts nothing" calls_are 0
check "... and logs the error" last_log_has "error: claude not found"
export ROSIE_CLAUDE_BIN="$T/bin/claude"

# ---- 10. status.sh ------------------------------------------------------------------------------------------
echo "== 10. status.sh reads the state and changes nothing"
reset_state
write_lock 1 "$(iso_ago 120)"
iso_in 600 >"$OPS/PAUSED_UNTIL"
"$HERE/status.sh" >"$T/status.out" 2>&1 || echo "status.sh exited non-zero" >>"$T/status.out"
check "it shows the lock and its heartbeat age" file_has "$T/status.out" "Lead lock: pid 1"
check "... the heartbeat age" file_has "$T/status.out" "(2 min ago; stale at 30)"
check "... the pause" file_has "$T/status.out" "(paused, 10 min left)"
check "... whether the job is loaded" grep -q -E '^Job: (loaded|not loaded)' "$T/status.out"
check "... and exits 0" not_in_file "$T/status.out" "status.sh exited non-zero"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
