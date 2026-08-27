// One-off, read-only inspector -- NOT part of the sync pipeline. Lists
// upcoming events across the user's calendars so we can learn the existing
// color-coding / description conventions (e.g. IIT Indore vs IIM Indore
// classes) before deciding how sync-schedule.mjs should format new events.
// Safe to delete once that convention is captured in calendarEvents.mjs.

import { google } from "googleapis";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getGoogleAuthClient } from "./lib/googleAuth.mjs";
import { mergeLocalConfig } from "./lib/configLocal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = mergeLocalConfig(__dirname, JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")));
const expandHome = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

const auth = await getGoogleAuthClient(
  path.join(__dirname, config.googleOAuth.clientSecretFile),
  expandHome(config.googleOAuth.tokenFile),
);
const calendar = google.calendar({ version: "v3", auth });

// Deliberately NOT calling calendar.calendarList.list() -- that needs a
// broader scope (calendar / calendar.readonly / calendar.calendarlist) than
// calendar.events grants. calendar.events is enough to read/write events on
// a calendar you already know the ID of, which is all the real sync needs,
// so this inspector stays within that same scope rather than requesting
// more just for one-off debugging. Pass calendar ID(s) to inspect via argv
// (defaults to "primary").
const calendarIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["primary"];

// Skipping calendar.colors.get() too -- also needs broader-than-events
// scope. Google's event colorId palette is a fixed, documented set of 11
// (https://developers.google.com/calendar/api/v3/reference/colors), colorId
// on each event below is enough to see which ones are actually in use.

const now = new Date();
const past = new Date(now.getTime() - 21 * 24 * 3600 * 1000);
const future = new Date(now.getTime() + 21 * 24 * 3600 * 1000);

for (const calendarId of calendarIds) {
  const res = await calendar.events.list({
    calendarId,
    timeMin: past.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  const items = res.data.items ?? [];
  console.log(`\n=== Events on "${calendarId}" (${items.length}) ===`);
  for (const ev of items) {
    console.log(JSON.stringify({
      summary: ev.summary,
      colorId: ev.colorId,
      start: ev.start,
      description: (ev.description ?? "").slice(0, 200),
      location: ev.location,
    }));
  }
}
