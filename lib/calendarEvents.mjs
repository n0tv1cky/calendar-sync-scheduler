// Turns parsed timetable rows into desired Calendar events, matching the
// exact convention already used by ~60 hand-created events on the user's
// "Term I Schedule" calendar (confirmed live via inspect-calendar.mjs):
//   summary:     "<Course Title> (<ABBREV>) - Session <N>"
//   location:    "IIT Indore" | "IIM Indore"
//   colorId:     "11" for IIT Indore courses, unset (default) for IIM Indore
//   description: "Course: ...\nInstructor(s): ...\n\nZoom link for joining
//                 classes\nLink: ...\nMeeting ID: ...\nPasscode: ...\n\n
//                 Reading Material Folder\n<link>"
//
// Reconciles against the calendar: create what's missing, patch what
// changed (time/title edits on the sheet), delete what's gone (a class
// cancelled/removed from the sheet since the last sync). Idempotent by
// design: running this again with no sheet changes makes zero API writes.
//
// MIGRATION / DUPLICATE AVOIDANCE: those ~60 existing events were created
// by hand, not by this script, so they carry none of our identifying
// extendedProperties. A naive sync would be blind to them (see
// listTaggedEvents below) and create a second, duplicate event for every
// class already on the calendar. To avoid that, syncEvents first checks
// for an untagged event already occupying a desired event's exact time
// slot and *adopts* it (tags it, updates its fields to match) instead of
// inserting a new one. This is a one-time cost per event -- once adopted,
// it's tagged and found by the fast bulk lookup on every later run.
//
// STALE UNTAGGED LEFTOVERS: the flip side of adoption -- an untagged
// hand-made event whose slot the sheet no longer claims at all (a class
// removed from the schedule after the manual import, before this tool
// existed) is invisible to BOTH the adoption loop above (no desired event
// ever points at its slot) AND the tagged-deletion loop below (it was never
// tagged), so without an explicit pass for it, it sits on the calendar
// forever. syncEvents fetches every untagged event across the whole
// schedule's date range up front and sweeps up whatever's left unclaimed
// after adoption -- see the pass after the tagged-deletion loop.

import { parseSheetDate, resolveSubjectCode, extractRawSessionNumber } from "./schedule.mjs";

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateTime(isoDay, hhmm, timeZone) {
  // Includes the real UTC offset (via withOffset, defined below -- function
  // declarations hoist) rather than a bare local string, because Calendar
  // always returns event.start/end.dateTime WITH an offset -- comparing a
  // bare string against that in needsUpdate() never matches, which was a
  // real bug here: every single event got re-patched on every run
  // (confirmed live: a second sync run reported "updated: 139" for a sheet
  // with zero actual changes).
  return withOffset(`${isoDay}T${hhmm}:00`, timeZone);
}

function eventKey(subjectCode, isoDay, slotLabel) {
  return `${subjectCode}|${isoDay}|${slotLabel}`;
}

// sessionNumberNote is non-null exactly when the sheet's own hand-written
// "(N)" in the raw cell disagrees with the session number this script
// actually computed (by counting occurrences -- see resolveSubjectCode's
// and extractRawSessionNumber's comments for why the two can legitimately
// differ: someone edits/deletes a session from the sheet without
// renumbering every cell after it). Surfaced directly on the event
// description -- not just in the change email -- because the calendar
// event is the thing that outlives any one sync run and gets looked at by
// itself later, long after the notification email is gone. Confirmed live
// this actually happens: deleting Aug 27's DSM 103 class left the sheet's
// own "(5)", "(6)", ... labels permanently one ahead of the correct
// chronological count from that point on.
function buildDescription(title, abbrev, instructor, config, sessionNumberNote) {
  const lines = [`Course: ${title} (${abbrev})`];
  if (instructor) lines.push(`Instructor(s): ${instructor.replace(/\s+and\s+/gi, ", ")}`);
  lines.push(
    "",
    "Zoom link for joining classes",
    `Link: ${config.zoom.meetingLink}`,
    `Meeting ID: ${config.zoom.meetingId}`,
    `Passcode: ${config.zoom.passcode}`,
    "",
    "Reading Material Folder",
    config.readingMaterialFolder,
  );
  if (sessionNumberNote) {
    lines.push(
      "",
      `↻ Sheet still says "(${sessionNumberNote.raw})" — recalculated here to Session ${sessionNumberNote.computed} (this calendar counts actual occurrences; the sheet's own label wasn't updated).`,
    );
  }
  return lines.join("\n");
}

// Returns [{ key, summary, description, location, colorId, start, end }]
// for every real class session in the timetable that resolves to a known
// subject in the legend (skips holidays/exams/blank cells and any cell
// that doesn't resolve to a known subject -- see README for why this
// script doesn't try to guess a generic fallback title/institute for the
// unresolved case the way the original manual import sometimes did).
export function buildDesiredEvents(timetableRows, config, legend) {
  const dateColIdx = 0;
  const dataRows = timetableRows.slice(1);
  const sessionCounts = {};
  const events = [];

  for (const row of dataRows) {
    const date = parseSheetDate(row[dateColIdx]);
    if (!date) continue;
    const isoDay = isoDate(date);
    const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
    const isWeekend = dayName === "Saturday" || dayName === "Sunday";
    const slots = isWeekend ? config.timeSlots.weekend : config.timeSlots.weekday;

    for (const slot of slots) {
      const rawCell = row[slot.column];
      const subjectCode = resolveSubjectCode(rawCell, config.subjectCodeMap, config.nonClassMarkers);
      if (!subjectCode) continue;

      const info = legend?.[subjectCode];
      if (!info?.title || !info?.abbrev) continue; // no legend entry -- can't build a real title/institute, skip rather than guess

      sessionCounts[subjectCode] = (sessionCounts[subjectCode] ?? 0) + 1;
      const sessionNumber = sessionCounts[subjectCode];

      const rawSessionNumber = extractRawSessionNumber(rawCell);
      const sessionNumberMismatch = rawSessionNumber !== null && rawSessionNumber !== sessionNumber;
      const sessionNumberNote = sessionNumberMismatch ? { raw: rawSessionNumber, computed: sessionNumber } : null;

      const titleHasAbbrev = info.title.includes(`(${info.abbrev})`);
      const summary = `${titleHasAbbrev ? info.title : `${info.title} (${info.abbrev})`} - Session ${sessionNumber}`;
      const institute = info.institute;
      const colorId = institute ? config.instituteColors[institute] ?? undefined : undefined;

      events.push({
        key: eventKey(subjectCode, isoDay, slot.label),
        summary,
        description: buildDescription(info.title, info.abbrev, info.instructor, config, sessionNumberNote),
        location: institute,
        colorId: colorId ?? undefined,
        start: dateTime(isoDay, slot.start, config.timeZone),
        end: dateTime(isoDay, slot.end, config.timeZone),
        sessionNumberMismatch,
        rawSessionNumber,
        sessionNumber,
      });
    }
  }

  return events;
}

async function listTaggedEvents(calendar, calendarId, sourceTag) {
  const existing = new Map();
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId,
      privateExtendedProperty: [`source=${sourceTag}`],
      maxResults: 2500,
      pageToken,
      showDeleted: false,
      singleEvents: true,
    });
    for (const ev of res.data.items ?? []) {
      const key = ev.extendedProperties?.private?.key;
      if (key) existing.set(key, ev);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return existing;
}

// events.list's timeMin/timeMax need a real UTC offset, not just a bare
// "YYYY-MM-DDTHH:MM:SS" local string -- computed generically via Intl
// rather than hardcoding one timezone's offset (which breaks the day a DST
// transition or a config change makes it wrong).
function withOffset(localIsoNoZone, timeZone) {
  const asUtc = new Date(localIsoNoZone + "Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(asUtc).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const zoned = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMinutes = Math.round((zoned - asUtc.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${localIsoNoZone}${offsetStr}`;
}

// Bounds (offset-inclusive RFC3339) covering every desired event's start..
// end, used to fetch every untagged event that could possibly be an
// adoption candidate OR a stale leftover in one paginated listing, instead
// of one events.list call per slot.
function computeRangeBounds(desiredEvents) {
  if (desiredEvents.length === 0) return null;
  let timeMin = desiredEvents[0].start;
  let timeMax = desiredEvents[0].end;
  for (const e of desiredEvents) {
    if (e.start < timeMin) timeMin = e.start;
    if (e.end > timeMax) timeMax = e.end;
  }
  return { timeMin, timeMax };
}

async function listAllEventsInRange(calendar, calendarId, timeMin, timeMax) {
  const events = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId, timeMin, timeMax, singleEvents: true, maxResults: 2500, pageToken, showDeleted: false,
    });
    events.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return events;
}

// Only events whose summary already looks like a class session -- either
// this script's own generated format ("<Title> (<ABBREV>) - Session <N>")
// or the generic placeholder text the original hand-made import used
// ("IIT Indore - Class Session" / "IIM Indore - Class Session") -- are ever
// eligible for adoption OR stale-leftover cleanup. This matters: the same
// calendar also holds hand-made non-class entries (confirmed live: several
// "Mid Term Examinations (...)" blocks that happen to sit inside a regular
// class time slot on exam days, which nonClassMarkers correctly keeps out
// of buildDesiredEvents) -- those must never be touched by reconciliation,
// since "no desired event wants this slot" is also exactly what a
// deliberate, correct exam/holiday entry looks like from this code's point
// of view. Restricting to the class-summary shape is what keeps the two
// apart.
const CLASS_SESSION_SUMMARY = /-\s*Session\s*\d+\s*$/i;
const GENERIC_CLASS_PLACEHOLDER = /^(IIT|IIM) Indore - Class Session$/i;

function looksLikeClassEvent(summary) {
  const s = String(summary ?? "").trim();
  return CLASS_SESSION_SUMMARY.test(s) || GENERIC_CLASS_PLACEHOLDER.test(s);
}

// Groups every untagged, class-shaped event in range by its exact start|end
// slot, so both adoption (a desired slot with no tagged event yet) and
// stale-leftover detection (a slot the sheet no longer claims at all) can
// share one pre-fetched listing instead of a live per-slot API call each.
// Only an exactly-one-candidate slot is ever touched by either -- same
// ambiguity guard as before: safer to leave an ambiguous slot alone than
// guess wrong.
function groupUntaggedByTimeSlot(events) {
  const byTime = new Map();
  for (const ev of events) {
    if (ev.extendedProperties?.private?.key) continue;
    if (!looksLikeClassEvent(ev.summary)) continue;
    const timeKey = `${ev.start?.dateTime}|${ev.end?.dateTime}`;
    if (!byTime.has(timeKey)) byTime.set(timeKey, []);
    byTime.get(timeKey).push(ev);
  }
  return byTime;
}

// Returns [{ field, before, after }] for every field that differs --
// empty array means no update needed. Used both to decide whether to patch
// *and* to log exactly what changed and why, so a later "why did this event
// change" question can be answered from runs.jsonl instead of guesswork
// (see sync-schedule.mjs's appendLog).
function diffFields(existingEvent, desired, timeZone) {
  const diffs = [];
  const compare = (field, before, after) => {
    if (before !== after) diffs.push({ field, before, after });
  };
  compare("summary", existingEvent.summary, desired.summary);
  compare("description", existingEvent.description, desired.description);
  compare("location", existingEvent.location ?? undefined, desired.location ?? undefined);
  compare("colorId", existingEvent.colorId ?? undefined, desired.colorId ?? undefined);
  compare("start", `${existingEvent.start?.dateTime}|${existingEvent.start?.timeZone}`, `${desired.start}|${timeZone}`);
  compare("end", `${existingEvent.end?.dateTime}|${existingEvent.end?.timeZone}`, `${desired.end}|${timeZone}`);
  return diffs;
}

// Reconciles desired vs. existing tagged events (adopting untagged
// pre-existing ones where found -- see file header). Returns a summary of
// what happened, with per-event detail (not just counts) so a run can
// always be traced back later -- see sync-schedule.mjs's appendLog. Only
// actually calls the API when dryRun is false.
export async function syncEvents(calendar, { calendarId, sourceTag, timeZone }, desiredEvents, { dryRun = false } = {}) {
  const existing = await listTaggedEvents(calendar, calendarId, sourceTag);
  const desiredKeys = new Set(desiredEvents.map((e) => e.key));

  // One prefetched listing of every untagged event across the whole
  // schedule's date range, grouped by exact time slot -- feeds both
  // adoption below (a slot the sheet still wants, no tagged event yet) and
  // the stale-leftover cleanup pass at the end (a slot the sheet no longer
  // wants at all). Untagged events are always pre-tool hand-made ones (see
  // file header) -- nothing new is ever created untagged -- so this is a
  // closed, shrinking set: once a slot's leftover is adopted or deleted, it
  // never needs revisiting.
  const range = computeRangeBounds(desiredEvents);
  const untaggedByTime = range
    ? groupUntaggedByTimeSlot(await listAllEventsInRange(calendar, calendarId, range.timeMin, range.timeMax))
    : new Map();

  const result = { created: [], adopted: [], updated: [], deleted: [], unchanged: 0 };

  for (const desired of desiredEvents) {
    const resource = {
      summary: desired.summary,
      description: desired.description,
      location: desired.location,
      // null (not undefined) is deliberate -- undefined gets silently
      // dropped by JSON.stringify, so patch() would never be able to
      // *clear* a colorId a course doesn't want (confirmed live: one
      // pre-existing hand-made event had a stray colorId left over from
      // being used as a copy-paste template, which needsUpdate correctly
      // flagged every run but `undefined` here could never actually fix).
      // null tells Calendar's patch to reset the field instead of leaving
      // it untouched.
      colorId: desired.colorId ?? null,
      start: { dateTime: desired.start, timeZone },
      end: { dateTime: desired.end, timeZone },
      extendedProperties: { private: { source: sourceTag, key: desired.key } },
    };

    const numberingNote = desired.sessionNumberMismatch
      ? { rawSessionNumber: desired.rawSessionNumber, sessionNumber: desired.sessionNumber }
      : null;

    let existingEvent = existing.get(desired.key);
    if (!existingEvent) {
      const timeKey = `${desired.start}|${desired.end}`;
      const candidates = untaggedByTime.get(timeKey) ?? [];
      if (candidates.length === 1) {
        const adoptable = candidates[0];
        result.adopted.push({ key: desired.key, summary: desired.summary, start: desired.start, adoptedEventId: adoptable.id, numberingNote });
        if (!dryRun) await calendar.events.patch({ calendarId, eventId: adoptable.id, requestBody: resource });
        untaggedByTime.delete(timeKey); // consumed -- not a stale leftover
        continue;
      }
    }

    if (!existingEvent) {
      result.created.push({ key: desired.key, summary: desired.summary, start: desired.start, numberingNote });
      if (!dryRun) await calendar.events.insert({ calendarId, requestBody: resource });
    } else {
      const changes = diffFields(existingEvent, desired, timeZone);
      if (changes.length > 0) {
        result.updated.push({ key: desired.key, summary: desired.summary, start: desired.start, changes, numberingNote });
        if (!dryRun) await calendar.events.patch({ calendarId, eventId: existingEvent.id, requestBody: resource });
      } else {
        result.unchanged++;
      }
    }
  }

  for (const [key, ev] of existing) {
    if (!desiredKeys.has(key)) {
      result.deleted.push({ key, summary: ev.summary, start: ev.start?.dateTime });
      if (!dryRun) await calendar.events.delete({ calendarId, eventId: ev.id });
    }
  }

  // Stale untagged leftovers: whatever's left in untaggedByTime is an
  // untagged event whose exact slot no class in the current sheet occupies
  // -- i.e. a pre-tool hand-made event for a class that's since been
  // removed/moved in the sheet, sitting at a slot no desired event ever
  // claimed this run (so the adoption loop above never touched it, and the
  // tagged-deletion loop above can't see it either since it was never
  // tagged). Confirmed live: a Friday 20:15 IIM Indore placeholder event
  // stayed on the calendar indefinitely after that slot went empty in the
  // sheet, because nothing in the reconciliation logic ever looked at
  // untagged events that ARE NOT a match for a currently-desired slot. Only
  // single-candidate slots are removed -- same ambiguity guard as adoption
  // (an ambiguous slot is left alone rather than risking the wrong delete).
  for (const [, candidates] of untaggedByTime) {
    if (candidates.length !== 1) continue;
    const ev = candidates[0];
    result.deleted.push({ key: null, summary: ev.summary, start: ev.start?.dateTime, wasUntagged: true });
    if (!dryRun) await calendar.events.delete({ calendarId, eventId: ev.id });
  }

  return result;
}
