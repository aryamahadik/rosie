# infra/watchdog: shifts and the watchdog

Factory spec section 10; build prompt 5.8 (running unattended) and 7.13 (the weekly usage limit).
Owner: release engineer. Not installed in D-000 until check 3. Nothing here starts a shift on its own.

| File                                | What it is                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `rosie-watchdog.sh`                 | The check that launchd runs every 15 minutes                                                         |
| `shift.sh`                          | Runs one headless lead shift, records its pid, waits, and writes `ops/PAUSED_UNTIL` on a usage limit |
| `com.rosfield.rosie-watchdog.plist` | The launchd job, with the code folder path filled in                                                 |
| `install.sh`, `uninstall.sh`        | Load or unload the job for this user (`gui/<uid>`)                                                   |
| `status.sh`                         | Whether the job is loaded, the lock, the pause and stop, the last 5 log lines. Reads only            |
| `watchdog.test.sh`                  | Self-test against a temporary ops folder and a fake `claude`                                         |

## What each run does

1. Goes to the code folder, makes sure `ops/watchdog/` and `ops/shifts/` exist, and writes one line to
   `ops/watchdog/watchdog.log` (no secrets).
2. `ops/PAUSED_UNTIL` holds a future time: exit. A past time is left in place for the next shift to clear.
3. `ops/watchdog/STOPPED` exists (an earlier crash stop): exit. It holds until a person deletes it.
4. `ops/LEAD.lock` names a live `claude` process whose heartbeat is under 30 minutes old: exit (one lead).
   Otherwise the watchdog ends that process (TERM, 10 seconds, then KILL), records a crash in
   `ops/watchdog/crashes.log` and removes the stale lock. A pid that is alive but is not a `claude` process
   (a reused pid) is never killed. A shift in `ops/shifts/current.pid` that holds no lock gets 30 minutes to
   write one; after that it is ended and counted as a crash.
5. 3 crashes within 2 hours: it starts nothing, writes `ops/watchdog/STOPPED` with the reason, alerts, and exits.
6. Otherwise it starts `shift.sh` in the background, in its own process group, so the shift outlives the run.

## The shift

`shift.sh` runs this in the code folder, with stdin from `/dev/null`:

```
claude -p "<continue message>" --add-dir "<handover>" \
  --append-system-prompt-file "<handover>/3 Build Plan Prompt for Claude.md" \
  --settings "<code folder>/.claude/settings.json" \
  --permission-mode acceptEdits --permission-prompts none --output-format stream-json --verbose
```

- The continue message is the build prompt's ("How to use", step 4), word for word.
- `--settings` passes the project's own `.claude/settings.json` explicitly. This workspace is not marked trusted in
  Claude Code, and a headless run then ignores the file's allow rules ("this workspace has not been trusted"), so
  every allowed command was refused in check 3's first run. Passed this way, its allow and deny rules and the guard
  hook apply to the shift and its subagents. A shift does not start if the file is missing (DL-053).
- Environment: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`.
  Removed: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (never agent teams), `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN`. Without them the shift runs on the signed-in Claude account and cannot bill an
  API key by accident (rule 6).
- Output: `ops/shifts/<UTC stamp>.jsonl` (stream-json) and `<UTC stamp>.stderr.log`. The pid goes to
  `ops/shifts/current.pid`, and events (started, ended, usage limit) go to `ops/shifts/shifts.log`.

Flags checked against Claude Code 2.1.318 on this Mac (Nov 5 2026):

| Flag or variable                                                                               | Finding                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`, `--add-dir`, `--permission-mode acceptEdits`, `--output-format stream-json`, `--verbose` | Listed in `claude --help`                                                                                                                                                                                        |
| `--append-system-prompt-file`                                                                  | Not listed in `--help`. The binary defines it as a hidden option ("Read system prompt from a file and append to the default system prompt", with its own "file not found" error), so it is used as the spec says |
| `--permission-prompts none`                                                                    | Listed in `--help`: "anything that would prompt is denied automatically". Added to meet 5.8's rule that a prompt nobody can answer is denied, never waited on                                                    |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`                                                         | Read by this version; `0` means wait for background tasks without a ceiling                                                                                                                                      |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`                                                         | Read by this version ("Subagent nesting limit reached (depth n of m)")                                                                                                                                           |

Whether the version honours both variables in a real run is the lead's entry in `DECISIONS.md` after check 3 (5.8).

## `ops/LEAD.lock` (the lead writes it)

```
pid=<claude pid: copy it from ops/shifts/current.pid>
started=<ISO 8601 UTC, e.g. 2026-11-05T20:15:00Z>
heartbeat=<ISO 8601 UTC>
```

- Write it in the shift's first minutes (the watchdog allows 30) and refresh `heartbeat` at every loop. Check 3
  wants it never older than 15 minutes.
- Use UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`). A local time with a `Z` reads as hours old and gets the lead ended.
- Write the whole file in one go (the Write tool is fine). If a lock looks half-written, the watchdog waits
  2 seconds and reads it again before acting.
- A clean end deletes it. A shift that ends with the lock still in place counts as a crash.

## `ops/PAUSED_UNTIL`

- One line: an ISO 8601 time with a zone (`2026-11-09T15:00:00Z` or `2026-11-09T10:00:00-05:00`), or epoch seconds.
- The lead writes it at a planned stop (7.13). `shift.sh` writes it when the run ends on a usage limit with a
  reset time, and keeps a later time that is already there.
- In the future: no shift starts. In the past: left in place, and the next shift deletes it. Empty: no pause.
  Unreadable: no shift starts, and the log says so until someone fixes or deletes the file.

How `shift.sh` spots a usage limit:

- It reads only what Claude Code itself writes: `result` lines with `"is_error":true`, `assistant` lines with
  `"is_api_error_message":true`, and stderr. It never reads tool results or the model's own words, so a file or
  a summary that mentions a limit cannot pause the build.
- A line counts when it matches, case-insensitively, `usage limit|limit reached|hit your ([a-z0-9-]+ )*limit`.
  That is the spec's three phrases, widened because 2.1.318 writes "You've hit your weekly limit" and
  "You've hit your 5-hour limit". The server throttle "temporarily limiting requests (not your usage limit)"
  does not count.
- The reset time is the first of: (1) the refused request's own `api_error_params.rate_limit_info.resetsAt`
  (epoch), or the older `limit reached|<epoch>`; (2) the run's last `rate_limit_event` whose status is
  `rejected`; (3) the clock time in the text, as in "resets 3pm (America/New_York)" or
  "resets Nov 9, 10am (America/New_York)".
- The time is used only if it falls between a day ago and 8 days ahead. With no usable reset time it writes
  nothing, and `shifts.log` says so.
- Still to watch in check 3: whether a headless 2.1.318 shift exits at a limit, or waits for the reset (the
  binary has an `autoContinueAtUsageLimit` setting). Either way the build pauses. If it exits, `shift.sh` writes
  the pause. If it waits, its heartbeat goes stale, the watchdog ends it (one crash), `shift.sh` writes the pause
  from the output, and the watchdog starts nothing until the reset.

## The crash stop

- A crash is a shift that ended, or was ended, while `LEAD.lock` was still in place, or one that ran 30 minutes
  without writing it. Each crash is a line in `ops/watchdog/crashes.log`.
- After 3 crashes within 2 hours the watchdog writes `ops/watchdog/STOPPED`, adds a stop line to
  `crashes.log`, and alerts Jay and the CTO. Until the night-shift channel is decided (Q-49), the alert is a
  placeholder that appends to `ops/watchdog/ALERT.md`. While `STOPPED` exists, no run starts anything.
- To resume: read `crashes.log`, `ops/shifts/shifts.log` and the last shift outputs, fix the cause, then delete
  `ops/watchdog/STOPPED`. Crashes from before the stop do not count again.
- A shift that exits before it ever writes `LEAD.lock` (a failed start) is not a crash. It shows in
  `shifts.log`, and the watchdog tries again 15 minutes later.

## How a shift ends

The lead stops assigning, lets running tasks report, and writes `STATE.md`. At a usage limit it also writes the
handoff and `PAUSED_UNTIL`. Then it deletes `LEAD.lock` and exits. `shift.sh` removes `current.pid`, and the
watchdog starts the next shift within 15 minutes.

## Install, check, remove (at check 3, with the CTO)

- `infra/watchdog/install.sh` asks first; `--yes` skips the question. It refuses if the plist's paths do not
  match this folder or if `claude`, `node` or `npm` is missing from the job's PATH. `RunAtLoad` is on, so the
  first check runs at once.
- `infra/watchdog/status.sh` shows the state. `launchctl kickstart gui/$(id -u)/com.rosfield.rosie-watchdog`
  runs a check now.
- `infra/watchdog/uninstall.sh` stops new shifts. A running shift keeps going until it deletes `LEAD.lock`.

macOS notes:

- The job runs in the logged-in user's GUI session (`gui/<uid>`), where Claude Code's sign-in in the login
  keychain is available. It does not run while nobody is logged in, and the Mac must stay on and awake.
- The code folder is in `~/Downloads`, which macOS protects. When the job first runs, allow "zsh" to access
  the Downloads folder if macOS asks. If no log line appears, or `ops/watchdog/launchd.err.log` says
  "Operation not permitted", allow `/bin/zsh` under System Settings > Privacy & Security > Files and Folders
  (or Full Disk Access).
- `AbandonProcessGroup` in the plist, plus the shift's own process group, keep launchd from ending the shift
  when the watchdog run exits.
- `ops/shifts/*.jsonl` grows with every shift. Keep the files out of the ops repository's commits and delete
  old ones.

## Self-test

Run `infra/watchdog/watchdog.test.sh`; it exits 0 when every check passes. It runs the real scripts against a
temporary ops folder, handover folder and fake `claude`, through `ROSIE_CODE_DIR`, `ROSIE_OPS_DIR`,
`ROSIE_HANDOVER_DIR` and `ROSIE_CLAUDE_BIN`. It refuses to run unless all four point into its temporary folder,
so it never starts a real shift and never touches `ops/`.

It covers:

- a fresh heartbeat (the watchdog exits);
- a stale heartbeat (it ends the lead and restarts);
- a dead pid (it restarts);
- `PAUSED_UNTIL` in the future (it exits), in the past, empty, and unreadable;
- 3 crashes in 2 hours (`STOPPED`, no start), then resuming;
- usage-limit messages (`PAUSED_UNTIL` written) and look-alikes, including the server throttle (nothing written);
- the exact flags and environment of the shift;
- a shift without a lock;
- a reused pid;
- `status.sh`;
- `bash -n` on every script and `plutil -lint` on the plist.
