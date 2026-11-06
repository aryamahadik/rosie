#!/bin/bash
# Installs the watchdog as this user's launchd agent (factory spec section 10). The CTO runs it once, when
# D-000 reaches check 3 (it is not installed before that):
#   infra/watchdog/install.sh          (asks first)      or      infra/watchdog/install.sh --yes
# It copies com.rosfield.rosie-watchdog.plist to ~/Library/LaunchAgents/ and loads it with
# launchctl bootstrap gui/<uid>. RunAtLoad is on: the first check runs at once, and it starts a shift if no
# lead holds ops/LEAD.lock and neither ops/PAUSED_UNTIL nor ops/watchdog/STOPPED holds it back.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CODE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
LABEL=com.rosfield.rosie-watchdog
SRC="$SCRIPT_DIR/$LABEL.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

# ---- checks -------------------------------------------------------------------------------------------------
if [ "$(uname -s)" != Darwin ]; then die "macOS only (on Linux the watchdog is a systemd timer)"; fi
plutil -lint "$SRC" >/dev/null || die "$SRC does not pass plutil -lint"
wd=$(plutil -extract WorkingDirectory raw -o - "$SRC") || die "cannot read WorkingDirectory from $SRC"
if [ "$wd" != "$CODE_DIR" ]; then die "the plist names $wd but this code folder is $CODE_DIR: update the paths in $SRC first"; fi
prog=$(plutil -extract ProgramArguments.2 raw -o - "$SRC") || die "cannot read ProgramArguments from $SRC"
if [ "$prog" != "$SCRIPT_DIR/rosie-watchdog.sh" ]; then die "the plist runs $prog, expected $SCRIPT_DIR/rosie-watchdog.sh"; fi
if [ ! -d "$CODE_DIR/ops" ]; then die "no ops/ folder in $CODE_DIR (the lead's ops repository must exist first)"; fi
for f in rosie-watchdog.sh shift.sh; do
  if [ ! -x "$SCRIPT_DIR/$f" ]; then chmod u+x "$SCRIPT_DIR/$f"; fi
done
job_path=$(plutil -extract EnvironmentVariables.PATH raw -o - "$SRC") || die "cannot read PATH from $SRC"
for t in claude node npm; do
  if ! (PATH=$job_path && command -v "$t" >/dev/null 2>&1); then die "$t is not on the job's PATH ($job_path): fix PATH in $SRC"; fi
done

# ---- confirm ------------------------------------------------------------------------------------------------
if [ "${1:-}" != "--yes" ]; then
  if [ ! -t 0 ]; then die "no terminal to ask in: run it in a terminal, or pass --yes"; fi
  echo "This loads the Rosie watchdog for $(id -un). It checks at once and then every 15 minutes, and starts an"
  echo "unattended lead shift whenever no lead holds ops/LEAD.lock (unless ops/PAUSED_UNTIL or ops/watchdog/STOPPED"
  echo "holds it back)."
  printf 'Install it now? [y/N] '
  read -r answer || answer=""
  case $answer in
    y | Y | yes | YES) ;;
    *)
      echo "Not installed."
      exit 1
      ;;
  esac
fi

# ---- install ------------------------------------------------------------------------------------------------
mkdir -p "$CODE_DIR/ops/watchdog" "$DEST_DIR"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Already loaded: reloading it."
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
fi
cp "$SRC" "$DEST"
chmod 644 "$DEST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$DEST"; then
  sleep 2 # a job that was just booted out can take a moment to go
  launchctl bootstrap "$DOMAIN" "$DEST" || die "launchctl bootstrap $DOMAIN $DEST failed"
fi

cat <<EOF
Installed $DEST and loaded it as $DOMAIN/$LABEL.
  Check it:   infra/watchdog/status.sh    (or: launchctl print $DOMAIN/$LABEL)
  Its log:    ops/watchdog/watchdog.log, one line per run; launchd's own output: ops/watchdog/launchd.*.log
  Check now:  launchctl kickstart $DOMAIN/$LABEL
  Stop it:    infra/watchdog/uninstall.sh  (a running shift keeps going until it deletes ops/LEAD.lock)
The code folder is in ~/Downloads, which macOS protects. If macOS asks whether "zsh" may access the Downloads
folder, allow it. If ops/watchdog/watchdog.log gets no new line within a minute, or launchd.err.log says
"Operation not permitted", allow /bin/zsh under System Settings > Privacy & Security > Files and Folders
(or Full Disk Access).
EOF
