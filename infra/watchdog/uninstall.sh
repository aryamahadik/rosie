#!/bin/bash
# Removes the watchdog's launchd agent (factory spec section 10): launchctl bootout gui/<uid>, then deletes the
# plist from ~/Library/LaunchAgents/. No new shift starts after this. A shift that is running is not stopped:
# it ends itself by deleting ops/LEAD.lock; to end it at once, stop the pid that infra/watchdog/status.sh shows.
set -euo pipefail

LABEL=com.rosfield.rosie-watchdog
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "Unloaded $DOMAIN/$LABEL."
else
  echo "$DOMAIN/$LABEL was not loaded."
fi
if [ -f "$DEST" ]; then
  rm -f "$DEST"
  echo "Removed $DEST."
fi
echo "No new shift will start. A running shift keeps going until it deletes ops/LEAD.lock; see infra/watchdog/status.sh."
