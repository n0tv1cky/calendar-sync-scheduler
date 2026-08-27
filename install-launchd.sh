#!/bin/bash
# Deploys run.sh outside ~/Documents (required -- see run.sh's comment) and
# (re)installs the launchd job that fires it. Run this after any change to
# run.sh, or after changing config.json's `sync` block (intervalMinutes or
# activeHours) -- the launchd StartCalendarInterval entries below are
# derived from those values, so they have to be regenerated whenever either
# changes.
#
# Fires ONLY at exact intervalMinutes steps within activeHours (e.g. 08:00,
# 09:00, ..., 20:00 for the default 60min/08:00-20:00) via an array of
# StartCalendarInterval entries -- not a generic recurring StartInterval
# that would also fire outside the window. This means the Mac genuinely
# doesn't wake up outside active hours, not just "wakes up and no-ops" --
# sync-schedule.mjs's own isWithinActiveHours() check is still there too,
# as a safety net for a stale plist or a manual/RunAtLoad firing.
#
# CAVEAT: StartCalendarInterval fires against the *system clock's* time
# zone, not config.json's `timeZone` -- fine as long as this Mac's system
# timezone is actually Asia/Kolkata (true for this user), but worth knowing
# if this is ever deployed somewhere else.

set -euo pipefail

REPO_DIR="/Users/n0tv1cky/Documents/Personal/masters/scripts/calendar-sync"
DEPLOY_DIR="$HOME/.calendar-sync"
PLIST_LABEL="com.n0tv1cky.calendar-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

mkdir -p "$DEPLOY_DIR"
cp "$REPO_DIR/run.sh" "$DEPLOY_DIR/run.sh"
chmod +x "$DEPLOY_DIR/run.sh"

# Emits the <dict>Hour/Minute</dict> entries for every step from
# activeHours.start to .end (inclusive), one per line, ready to drop into
# StartCalendarInterval's array. Node (not bash arithmetic) because bash has
# no clean HH:MM parsing.
CALENDAR_INTERVALS=$(node -e "
const config = JSON.parse(require('fs').readFileSync('$REPO_DIR/config.json', 'utf8'));
const { intervalMinutes, activeHours } = config.sync;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const startMin = toMinutes(activeHours.start);
const endMin = toMinutes(activeHours.end);
const entries = [];
for (let t = startMin; t <= endMin; t += intervalMinutes) {
  entries.push(\`    <dict><key>Hour</key><integer>\${Math.floor(t / 60)}</integer><key>Minute</key><integer>\${t % 60}</integer></dict>\`);
}
console.log(entries.join('\n'));
")

INTERVAL_MINUTES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_DIR/config.json','utf8')).sync.intervalMinutes)")
ACTIVE_START=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_DIR/config.json','utf8')).sync.activeHours.start)")
ACTIVE_END=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_DIR/config.json','utf8')).sync.activeHours.end)")

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
        <string>${DEPLOY_DIR}/run.sh</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/n0tv1cky/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/n0tv1cky</string>
    </dict>

    <key>StartCalendarInterval</key>
    <array>
${CALENDAR_INTERVALS}
    </array>

    <key>StandardOutPath</key>
    <string>${DEPLOY_DIR}/run.log</string>

    <key>StandardErrorPath</key>
    <string>${DEPLOY_DIR}/run.log</string>

    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "Installed. launchd fires every ${INTERVAL_MINUTES}min between ${ACTIVE_START} and ${ACTIVE_END} (config.json's sync.intervalMinutes / sync.activeHours) -- no wakeups outside that window."
echo "Logs: ${DEPLOY_DIR}/run.log"
