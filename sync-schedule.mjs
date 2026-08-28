// Syncs the MSDSM class schedule (a raw .xlsx on Drive) into a Google
// Calendar. Safe to run as often as you like -- idempotent reconciliation
// via lib/calendarEvents.mjs.
//
// Runs only within config.sync.activeHours (in config.timeZone), at most
// every config.sync.intervalMinutes -- both configurable, no code changes
// needed to adjust either. install-launchd.sh reads the same config to
// schedule launchd's wakeups to land exactly on those active-hours
// boundaries (so nothing even wakes up outside the window, not just a
// no-op check-in), but this script enforces both checks itself too as a
// safety net -- a stale/misconfigured launchd job, a manual double-run, or
// RunAtLoad firing right after a scheduled run should still behave
// correctly on its own. `--force` bypasses both checks (used by
// `npm run sync:force` and by `--dry-run`, which always implies it).

import { google } from "googleapis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGoogleAuthClient } from "./lib/googleAuth.mjs";
import { fetchScheduleWorkbook, parseTimetable, parseLegend } from "./lib/schedule.mjs";
import { buildDesiredEvents, syncEvents } from "./lib/calendarEvents.mjs";
import { buildChangeSummaryEmail, sendChangeEmail } from "./lib/notify.mjs";
import { mergeLocalConfig } from "./lib/configLocal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
  return mergeLocalConfig(__dirname, JSON.parse(raw));
}

// "HH:MM" compared against the current time-of-day *in config.timeZone*,
// not the machine's local time -- matters if this ever runs on a host set
// to a different zone than the schedule's own (Asia/Kolkata).
function isWithinActiveHours(activeHours, timeZone, now = new Date()) {
  const nowHHMM = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return nowHHMM >= activeHours.start && nowHHMM <= activeHours.end;
}

// GRACE_MINUTES matters more than it looks like it should: launchd fires
// this exactly on the hour, but the previous run's persisted lastRun
// timestamp lands a few seconds AFTER that (script startup + the actual
// Drive/Calendar API round-trip) -- confirmed live, a real run completed at
// 08:00:10, and the very next hourly firing at 09:00:00 was then only
// 59m56s past it, just under the un-grace'd 60min threshold, and got
// skipped. Without slack, that pattern repeats every single hour (each
// skip leaves lastRun stale, so the hour after THAT one is ~119m late and
// runs, restarting the same few-seconds-short cycle) -- i.e. an "hourly"
// sync silently settles into running every OTHER hour, forever, with no
// error or warning anywhere. A few minutes of grace comfortably absorbs
// normal run latency while still preventing a genuine double-fire (e.g. a
// manual run seconds after a scheduled one) from double-counting.
const GRACE_MINUTES = 3;

function shouldRunNow(stateFile, intervalMinutes, force) {
  if (force) return { run: true };
  if (!fs.existsSync(stateFile)) return { run: true };
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const lastRun = new Date(state.lastRun);
  const elapsedMinutes = (Date.now() - lastRun.getTime()) / 60000;
  if (elapsedMinutes >= intervalMinutes - GRACE_MINUTES) return { run: true };
  return { run: false, minutesRemaining: Math.ceil(intervalMinutes - GRACE_MINUTES - elapsedMinutes) };
}

function appendLog(logFile, entry) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force") || dryRun;
  // Groups every log line from one invocation so a later grep/jq over
  // runs.jsonl can pull out exactly one run's full detail, not just its
  // summary counts.
  const runId = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  const config = loadConfig();
  const intervalMinutes = config.sync?.intervalMinutes ?? 60;
  const activeHours = config.sync?.activeHours ?? { start: "00:00", end: "23:59" };

  if (!force && !isWithinActiveHours(activeHours, config.timeZone)) {
    console.log(`Skipping -- outside active hours (${activeHours.start}-${activeHours.end} ${config.timeZone}, config.sync.activeHours). Use --force to override.`);
    appendLog(expandHome(config.logging.runsLogFile), { runId, ts: new Date().toISOString(), outcome: "skipped-outside-hours" });
    return;
  }

  const stateFile = expandHome(config.stateFile);
  const gate = shouldRunNow(stateFile, intervalMinutes, force);
  if (!gate.run) {
    console.log(`Skipping -- last sync was under ${intervalMinutes}min ago (config.sync.intervalMinutes). ~${gate.minutesRemaining}min until next sync. Use --force to override.`);
    appendLog(expandHome(config.logging.runsLogFile), { runId, ts: new Date().toISOString(), outcome: "skipped", minutesRemaining: gate.minutesRemaining });
    return;
  }

  const clientSecretFile = path.join(__dirname, config.googleOAuth.clientSecretFile);
  const tokenFile = expandHome(config.googleOAuth.tokenFile);
  const auth = await getGoogleAuthClient(clientSecretFile, tokenFile);

  const drive = google.drive({ version: "v3", auth });
  const calendar = google.calendar({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });

  console.log(`Fetching schedule workbook (${config.term})...`);
  const workbook = await fetchScheduleWorkbook(drive, config.scheduleFile.id);
  const timetableRows = parseTimetable(workbook, config.scheduleFile.sheetName, config.scheduleFile.legendMarker);
  const legend = parseLegend(workbook, config.scheduleFile.sheetName, config.scheduleFile.legendMarker);

  // Cross-check config.subjectCodeMap against the legend's own Abbreviation
  // column -- same warning scripts/attendance's mark-attendance.mjs prints,
  // done independently here since this is a separate hand-duplicated copy
  // (see docs/course-codes.md). Catches a new term's legend changing without
  // this config being updated to match.
  for (const [code, info] of Object.entries(legend)) {
    if (info.abbrev && config.subjectCodeMap[info.abbrev] && config.subjectCodeMap[info.abbrev] !== code) {
      console.warn(`WARNING: config.json's subjectCodeMap["${info.abbrev}"] = "${config.subjectCodeMap[info.abbrev]}" but the schedule's own legend says "${code}" -- update config.json if the schedule changed.`);
    }
  }

  const desiredEvents = buildDesiredEvents(timetableRows, config, legend);
  console.log(`Parsed ${desiredEvents.length} class session(s) from the schedule.`);

  const result = await syncEvents(
    calendar,
    { calendarId: config.calendar.id, sourceTag: config.calendar.sourceTag, timeZone: config.timeZone },
    desiredEvents,
    { dryRun },
  );

  console.log(`${dryRun ? "[dry-run] " : ""}created: ${result.created.length}, adopted: ${result.adopted.length}, updated: ${result.updated.length}, deleted: ${result.deleted.length}, unchanged: ${result.unchanged}`);
  if (result.created.length) console.log("  created:", result.created.map((e) => e.key).join(", "));
  if (result.adopted.length) console.log("  adopted:", result.adopted.map((e) => e.key).join(", "));
  if (result.updated.length) {
    console.log("  updated:");
    for (const { key, changes } of result.updated) {
      console.log(`    ${key}:`);
      for (const { field, before, after } of changes) console.log(`      ${field}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
  }
  if (result.deleted.length) console.log("  deleted:", result.deleted.map((e) => `${e.key ?? "untagged-leftover"} (${e.summary})`).join(", "));

  // Full per-event detail (not just counts) goes to runs.jsonl -- one JSON
  // object per run, tagged with runId -- specifically so a question like
  // "why did session X's title/color change on date Y" can be answered by
  // grepping this file for the key, instead of having to guess or re-derive
  // it. `jq 'select(.runId=="...")' runs.jsonl` pulls one full run;
  // `jq 'select(.outcome=="ran") | .updated[] | select(.key=="...")'`
  // finds every time a specific event was ever changed and why.
  appendLog(expandHome(config.logging.runsLogFile), {
    runId,
    ts: new Date().toISOString(),
    outcome: "ran",
    dryRun,
    counts: {
      created: result.created.length,
      adopted: result.adopted.length,
      updated: result.updated.length,
      deleted: result.deleted.length,
      unchanged: result.unchanged,
    },
    created: result.created,
    adopted: result.adopted,
    updated: result.updated,
    deleted: result.deleted,
  });

  const totalChanges = result.created.length + result.updated.length + result.deleted.length;
  if (!dryRun && totalChanges > 0 && config.notifications?.enabled) {
    // Email failures shouldn't fail the whole sync -- the calendar write
    // already succeeded and matters more than the notification about it.
    //
    // from = toEmail (not looked up via gmail.users.getProfile) deliberately
    // -- getProfile needs a broader scope than gmail.send grants (confirmed
    // live: "insufficient authentication scopes" with only gmail.send), and
    // the account sending is always the same account receiving, so there's
    // nothing to actually look up.
    try {
      const calendarLink = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(config.calendar.id)}`;
      const { subject, html } = buildChangeSummaryEmail({ term: config.term, calendarLink, timeZone: config.timeZone, result });
      await sendChangeEmail(gmail, { to: config.notifications.toEmail, from: config.notifications.toEmail, subject, html });
      console.log(`Sent change-summary email to ${config.notifications.toEmail}.`);
    } catch (err) {
      console.error("WARNING: failed to send change-summary email (sync itself still succeeded):", err.message);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastRun: new Date().toISOString(), runId }, null, 2));
  }
}

main().catch((err) => {
  console.error("calendar-sync failed:", err);
  try {
    const config = loadConfig();
    appendLog(expandHome(config.logging.runsLogFile), {
      ts: new Date().toISOString(),
      outcome: "failed",
      error: err.message,
      stack: err.stack,
    });
  } catch {
    // config itself may be what's broken -- don't let logging-the-failure fail the process differently than the original error already will.
  }
  process.exit(1);
});
