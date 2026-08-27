#!/bin/bash
# Queues macOS scheduled-wake events (via `pmset schedule wake`) for every
# sync.activeHours time slot, so launchd's StartCalendarInterval jobs (see
# install-launchd.sh) have a chance to actually fire even with the lid
# closed -- normally a fully-asleep Mac just misses those and catches up
# once on next manual wake (see sync-schedule.mjs's isWithinActiveHours and
# docs/course-codes.md-style reasoning in install-launchd.sh's header).
#
# CAVEATS -- read before relying on this:
# - `pmset schedule` needs root. This script is meant to run AS root, via
#   the LaunchDaemon in com.n0tv1cky.calendar-sync-wake-scheduler.plist
#   (LaunchDaemons run as root by default) -- not meant to be run directly
#   as your own user without sudo.
# - Scheduled wake events are ONE-TIME, not recurring -- `pmset schedule`
#   has no "repeat daily" concept for multiple times/day (pmset's own
#   `repeat` subcommand only supports a single wake time per day). So this
#   script has to be re-run once daily to queue the *next* day's set of
#   wake times, which is what the LaunchDaemon (running once at 00:05) is
#   for.
# - Reliability is NOT guaranteed lid-closed-on-battery. Apple's scheduled
#   wake (the "womp"/"acwake" mechanism, visible in `pmset -g`) is
#   documented and generally reliable while plugged into AC power; on
#   battery alone, scheduled wake is unreliable-to-nonexistent on many Mac
#   models. If this doesn't actually wake the machine when unplugged, that's
#   a real Apple platform limit, not a bug in this script -- the safety net
#   is still sync-schedule.mjs's own catch-up-on-next-real-wake behavior,
#   so nothing is lost either way, just possibly delayed.
# - A scheduled wake only wakes a SLEEPING Mac -- it does nothing for a
#   fully powered-off one.
# - Reads config.json from ITS OWN directory (a deployed copy), not from
#   ~/Documents/.../scripts/calendar-sync/config.json -- confirmed live:
#   even a plain file *read* of a path under ~/Documents fails with EPERM
#   when done by a bare root LaunchDaemon (no Terminal/WindowServor session
#   to inherit a TCC grant from), not just "executing a script located
#   there" as scripts/zoom-recordings' comments describe. install-wake-
#   scheduler.sh copies config.json here on every (re)install -- re-run it
#   after changing config.json's `sync` block.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node -e "
const config = JSON.parse(require('fs').readFileSync('$DEPLOY_DIR/config.json', 'utf8'));
const { intervalMinutes, activeHours } = config.sync;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const startMin = toMinutes(activeHours.start);
const endMin = toMinutes(activeHours.end);
const now = new Date();
for (let t = startMin; t <= endMin; t += intervalMinutes) {
  const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(t / 60), t % 60, 0);
  // Skip anything already past today -- this only queues *future* slots;
  // running the script again tomorrow (via the daily LaunchDaemon) queues
  // that day's full set fresh.
  if (when <= now) continue;
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = \`\${pad(when.getMonth() + 1)}/\${pad(when.getDate())}/\${when.getFullYear()} \${pad(when.getHours())}:\${pad(when.getMinutes())}:00\`;
  console.log(dateStr);
}
" | while read -r WHEN; do
  pmset schedule wake "$WHEN" || echo "WARNING: failed to schedule wake at $WHEN" >&2
done

# Hardcoded absolute path (not ~/.calendar-sync) deliberately -- this runs
# as root via a LaunchDaemon, and root's own $HOME is /var/root, not
# n0tv1cky's -- ~ would silently log to the wrong place.
echo "$(date): queued today's remaining wake times." >> "/Users/n0tv1cky/.calendar-sync/wake-scheduler.log"
