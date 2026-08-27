# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Syncs the MSDSM class schedule (a raw `.xlsx` on Drive) into a Google Calendar, creating/updating/deleting events as the sheet changes. Runs unattended via `launchd`, on an hourly interval, only within a configured active-hours window — see `sync-schedule.mjs`'s header comment for the two-gate (launchd scheduling + the script's own `isWithinActiveHours`/`shouldRunNow` checks) design.

Unlike the sibling `zoom-recordings`/`attendance` projects, this one had **no prior git history** — it was created directly in the split-out `projects/` layout on 2026-08-27, so its single initial commit already reflects the scrubbed-config convention described below; there's no pre-split history to worry about here.

**Git workflow:** this repo has a real GitHub remote (`origin`, `n0tv1cky/calendar-sync-scheduler`). Commit as normal, but **never push without being explicitly asked** — a push here is visible to whoever has access to that GitHub repo.

## Secrets (read before touching config or docs)

`config.json` in this repo contains only **placeholder** values (`<YOUR_...>`) for anything sensitive — the schedule-sheet ID, the Google Calendar ID, the live Zoom meeting link/meeting ID/passcode, the reading-material Drive folder link, and the institute email. The real values live in `config.local.json`, which is gitignored and deep-merged over `config.json` at load time by `lib/configLocal.mjs` (see `loadConfig()` in `sync-schedule.mjs` and `inspect-calendar.mjs`).

**Never put a real Sheet/Calendar/Drive ID, the real Zoom meeting link, meeting ID, or passcode directly into `config.json`, code, or docs** — put it in `config.local.json` instead, following the existing keys there as the pattern for any new sensitive field. Note the live Zoom credentials end up embedded in every synced calendar event's `description` field (see `lib/calendarEvents.mjs`'s `buildDescription`) — that's expected (the point is for you to see them on the calendar event), but it means those values are already visible to anyone with access to the calendar, independent of this repo's own secrecy.

`oauth-client.json` (Google Cloud "Desktop app" OAuth client secret) is gitignored and has never been committed.

## Commands

Plain Node ESM script — no build step, no bundler, no lint config, no test suite.

```bash
npm install
npm run sync              # node sync-schedule.mjs
npm run sync:dry          # --dry-run: always implies --force, shows what would change, no writes
npm run sync:force        # --force: bypass the active-hours/interval gate and sync now
node inspect-calendar.mjs [calendarId ...]  # one-off read-only inspector, not part of the sync pipeline -- see its header comment
```

**Redeploying `run.sh` after editing it:** launchd runs a copy of this outside `~/Documents` (macOS TCC blocks background/non-GUI processes from executing scripts that live inside `~/Documents`). Re-run `install-launchd.sh` after editing `run.sh` (it redeploys the copy and reinstalls the LaunchAgent) — see that script's header. Also re-run `install-launchd.sh` after changing `config.json`'s `sync.intervalMinutes` or `sync.activeHours`, since the LaunchAgent's `StartCalendarInterval` entries are generated from those values and won't update themselves.

`install-launchd.sh` and `install-wake-scheduler.sh` both hardcode `REPO_DIR="/Users/n0tv1cky/Documents/Personal/masters/projects/calendar-sync"` — if this repo is ever moved again, update `REPO_DIR` in both and re-run them, or the unattended job will silently break (this happened during the 2026-08-27 split and had to be fixed by hand across all three sibling projects).

## OAuth credentials

`oauth-client.json` sits in the repo root, gitignored, never committed — treat it as a secret if you ever touch it.

Cached user token lives outside the repo, at `~/.calendar-sync/google-oauth-token.json`. This is an OAuth **testing-status** app token — Google can expire it (commonly after ~7 days unused, or without periodic re-consent), which shows up as an auth failure requiring one interactive re-login, not a code bug.

Change-summary emails (sent only when a sync run actually creates/updates/deletes something, never one-per-event) go out via the Gmail API using the *same* token as the Calendar/Drive scopes above — `sendChangeEmail` in `lib/notify.mjs` deliberately sets `from` = `toEmail` without an extra `gmail.users.getProfile` lookup, since that call needs a broader scope than what's granted (confirmed live: "insufficient authentication scopes").

## Architecture

**Pipeline:** read the schedule workbook off Drive (`drive.files.get(alt=media)` + `xlsx`, same pattern as the sibling `attendance` project) → parse the timetable and the course legend → cross-check `config.json`'s `subjectCodeMap` against the legend's own abbreviations, warning (not failing) on drift → build the desired set of Calendar events → reconcile against the calendar (create/patch/delete) → email a change summary if anything actually changed.

Key design points:

- **Idempotent reconciliation** (`lib/calendarEvents.mjs`): every event is tagged with `extendedProperties.private.{source, key}` (`key` = `subjectCode|isoDay|slotLabel`), so a second run with no sheet changes makes zero API writes. `colorId` is explicitly set to `null` (not left `undefined`) when a course wants no color — `undefined` gets silently dropped by `JSON.stringify` and `patch()` could never actually *clear* a stray colorId, which was a real bug (a hand-made template event had one left over).
- **Adopting pre-existing events**: ~60 events on the target calendar were created by hand before this tool existed, so they carry none of the tagging above. `findAdoptableEvent` looks for an untagged event occupying a desired event's exact time slot and adopts it (tags + updates it) instead of inserting a duplicate — but only when exactly one untagged candidate is found; zero or multiple candidates are left alone rather than guessed at.
- **Timezone-correct comparisons**: event start/end times are always compared and written with a real UTC offset (`withOffset()` in `lib/calendarEvents.mjs`), not a bare local-time string — Calendar's API always returns offset-inclusive datetimes, so comparing against a bare string never matched and caused every single event to be re-patched on every run (confirmed live: "updated: 139" for a sheet with zero actual changes).
- **Active-hours/interval gating** (`sync-schedule.mjs`): enforced twice — once by `install-launchd.sh` only scheduling wakeups inside the window, and again by the script's own `isWithinActiveHours`/`shouldRunNow` checks, as a safety net for a stale plist, a manual double-run, or a `RunAtLoad` firing right after a scheduled run. `GRACE_MINUTES = 3` in `shouldRunNow` matters more than it looks — without it, run-latency alone (a few seconds between `lastRun` being persisted and the next hourly firing) can push an "hourly" sync into silently running only every *other* hour, forever, with no error (confirmed live, see the comment above `GRACE_MINUTES`).
- **Optional lid-closed wake workaround** (`schedule-wakeups.sh` + `install-wake-scheduler.sh`, a root `LaunchDaemon`, not installed by default) mirrors the sibling `zoom-recordings` project's own wake scheduler — see `docs/background-automation.md` for the shared pattern. Genuinely optional; scheduled wake is only reliable on AC power.
- **`inspect-calendar.mjs`** is a one-off, read-only debugging tool (not part of the sync pipeline) used to learn the existing hand-made events' color/description conventions before `lib/calendarEvents.mjs` was written to match them — deliberately avoids `calendarList.list()`/`colors.get()` since those need broader scopes than the real sync ever requests.

There is no `README.md` in this repo yet beyond what's here and in code comments — the `.mjs`/`.sh` file headers carry most of the "why," each the result of a real bug found live (see the comments cited above for the specifics).
