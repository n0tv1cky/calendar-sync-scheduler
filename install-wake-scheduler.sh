#!/bin/bash
# Installs a root LaunchDaemon that runs schedule-wakeups.sh once nightly
# (00:05) to queue that day's `pmset schedule wake` events for every
# sync.activeHours slot -- see schedule-wakeups.sh's header for the full
# reasoning and caveats (root requirement, one-time-not-recurring pmset
# events, unreliable on battery).
#
# Requires sudo -- run this yourself, not via an unattended agent:
#   ! cd /Users/n0tv1cky/Documents/Personal/masters/scripts/calendar-sync && sudo ./install-wake-scheduler.sh
#
# This is a genuinely optional add-on to the core sync (which already has
# its own catch-up-on-wake safety net via sync-schedule.mjs's
# isWithinActiveHours + shouldRunNow). If scheduled wake turns out not to
# work reliably on this machine (e.g. usually running on battery), just
# don't install this, or remove it later with:
#   sudo launchctl bootout system/com.n0tv1cky.calendar-sync-wake-scheduler
#   sudo rm /Library/LaunchDaemons/com.n0tv1cky.calendar-sync-wake-scheduler.plist

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "This needs to run as root -- re-run as: sudo $0" >&2
  exit 1
fi

REPO_DIR="/Users/n0tv1cky/Documents/Personal/masters/scripts/calendar-sync"
DEPLOY_DIR="/Users/n0tv1cky/.calendar-sync"
PLIST_LABEL="com.n0tv1cky.calendar-sync-wake-scheduler"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

# Deploys both the script AND a copy of config.json alongside it -- the
# daemon runs as root with no Terminal/WindowServor session, and a bare
# root process reading anything under ~/Documents gets EPERM from TCC
# (confirmed live), so schedule-wakeups.sh reads its config from here, not
# from $REPO_DIR. Re-run this installer after any change to either file.
mkdir -p "$DEPLOY_DIR"
cp "$REPO_DIR/schedule-wakeups.sh" "$DEPLOY_DIR/schedule-wakeups.sh"
cp "$REPO_DIR/config.json" "$DEPLOY_DIR/config.json"
chmod +x "$DEPLOY_DIR/schedule-wakeups.sh"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${DEPLOY_DIR}/schedule-wakeups.sh</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>5</integer>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${DEPLOY_DIR}/wake-scheduler.log</string>

    <key>StandardErrorPath</key>
    <string>${DEPLOY_DIR}/wake-scheduler.log</string>
</dict>
</plist>
PLIST

chown root:wheel "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

launchctl bootout system "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap system "$PLIST_PATH"

echo "Installed. Runs nightly at 00:05 as root to queue that day's pmset wake times, and ran once now (RunAtLoad) to queue today's remaining slots."
echo "Check queued wake times with: pmset -g sched"
echo "Logs: ${DEPLOY_DIR}/wake-scheduler.log"
