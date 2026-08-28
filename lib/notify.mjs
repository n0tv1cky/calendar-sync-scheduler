// Sends one summary email per sync run when anything actually changed --
// deliberately NOT one email per event (confirmed live: the first sync
// created/adopted 139 events in one run; a per-event email would have been
// 139 emails in someone's inbox for a single `npm run sync`). Skipped
// entirely when created+updated+deleted is zero, so a normal no-op run
// (the common case once the term settles) sends nothing.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "Managerial Economics (ME) - Session 3" -> "Managerial Economics (ME)" --
// the email groups by course visually via the session pill instead, so the
// repeated "- Session N" suffix in every row would just be noise.
function courseName(summary) {
  return String(summary ?? "").replace(/\s*-\s*Session\s+\d+$/i, "");
}

function sessionLabel(summary) {
  const m = String(summary ?? "").match(/Session\s+(\d+)$/i);
  return m ? `Session ${m[1]}` : "";
}

function formatWhen(isoWithOffset, timeZone) {
  if (!isoWithOffset) return "";
  const d = new Date(isoWithOffset);
  const datePart = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(d);
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  return `${datePart} · ${timePart}`;
}

const FIELD_LABELS = { summary: "Title", location: "Institute", colorId: "Color", start: "Start time", end: "End time" };

// IST, 24-hour HH:MM, no date -- the "Start time"/"End time" diff line is
// about a slot changing within a day, so the date (already shown once at
// the top of the card) would just be redundant repetition here. The stored
// dateTime strings already carry the +05:30 offset (baked in against
// config.timeZone), so this is already IST -- no further conversion.
function timeOnly24h(isoWithOffset) {
  const m = String(isoWithOffset ?? "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : isoWithOffset;
}

function humanFieldValue(field, value) {
  if (field === "start" || field === "end") return timeOnly24h(value?.split("|")[0]);
  if (field === "colorId") return value ? `#${value}` : "default";
  return value;
}

// "Managerial Economics (ME) - Session 3" -> "ME S3" -- a compact label for
// the subject line, where a notification banner truncates around 40-60
// chars and every character showing the *actual* course beats a generic
// "N changes" count.
function compactLabel(summary) {
  const abbrevMatch = String(summary ?? "").match(/\(([A-Z]+)\)/);
  const sessionMatch = String(summary ?? "").match(/Session\s+(\d+)$/i);
  const abbrev = abbrevMatch ? abbrevMatch[1] : courseName(summary).slice(0, 12);
  return sessionMatch ? `${abbrev} S${sessionMatch[1]}` : abbrev;
}

// One line per changed event describing WHAT changed, not just THAT it did
// -- e.g. "PS S1 moved 19:00→20:00" beats "PS S1 updated". Falls back to
// the changed field's label when it's not start/end (the only field with a
// human-friendly diff worth compressing into a subject line). IST 24-hour
// HH:MM, same as the email body's diff lines (see timeOnly24h above).
function describeUpdate(item) {
  const label = compactLabel(item.summary);
  const timeChange = item.changes.find((c) => c.field === "start");
  if (timeChange) {
    const before = timeOnly24h(timeChange.before.split("|")[0]);
    const after = timeOnly24h(timeChange.after.split("|")[0]);
    return `${label} moved ${before}→${after}`;
  }
  const otherFields = item.changes.filter((c) => c.field !== "description" && c.field !== "end").map((c) => FIELD_LABELS[c.field] ?? c.field);
  if (otherFields.length > 0) return `${label} ${otherFields.join("/")} changed`;
  return `${label} updated`;
}

// Builds a subject that front-loads the most information a notification
// banner can show: for a single change, the exact course/session and what
// happened to it; for several, as many compact per-event descriptions as
// fit before falling back to a "+N more" tail.
function buildSubject(result) {
  const items = [
    ...result.created.map((e) => ({ text: `${compactLabel(e.summary)} added` })),
    ...result.adopted.map((e) => ({ text: `${compactLabel(e.summary)} added` })),
    ...result.updated.map((e) => ({ text: describeUpdate(e) })),
    ...result.deleted.map((e) => ({ text: `${compactLabel(e.summary)} cancelled` })),
  ];

  if (items.length === 1) return `MSDSM: ${items[0].text}`;

  const SUBJECT_BUDGET = 70;
  let subject = `MSDSM (${items.length}): `;
  let shown = 0;
  for (const item of items) {
    const candidate = shown === 0 ? item.text : `, ${item.text}`;
    if (subject.length + candidate.length > SUBJECT_BUDGET) break;
    subject += candidate;
    shown++;
  }
  if (shown < items.length) subject += ` +${items.length - shown} more`;
  return subject;
}

// One card per change, in a shared visual shape: a colored left accent bar,
// course name + session pill (tinted amber instead of the usual neutral
// gray when numberingNote is set -- see renderNumberingLine below for why
// that distinction needs to exist at all), when, and (for updates) a
// compact diff list.
function renderCard({ accentColor, summary, start, timeZone, body, numberingNote }) {
  const pillTint = numberingNote ? "background:#fef3d9; color:#8a6100;" : "background:#f1f3f4; color:#5f6368;";
  return `
    <tr>
      <td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:10px; box-shadow:0 1px 2px rgba(0,0,0,0.06); overflow:hidden;">
          <tr>
            <td width="4" style="background:${accentColor};"></td>
            <td style="padding:14px 16px;">
              <div style="font-size:14px; font-weight:600; color:#1a1a1a;">
                ${escapeHtml(courseName(summary))}
                ${sessionLabel(summary) ? `<span style="font-weight:500; font-size:12px; ${pillTint} border-radius:10px; padding:2px 8px; margin-left:6px;">${numberingNote ? "↻ " : ""}${escapeHtml(sessionLabel(summary))}</span>` : ""}
              </div>
              <div style="font-size:12.5px; color:#5f6368; margin-top:2px;">${escapeHtml(formatWhen(start, timeZone))}</div>
              ${numberingNote ? renderNumberingLine(numberingNote) : ""}
              ${body ?? ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

// One quiet line, same visual weight as the "when" line above it -- not a
// boxed alert. Distinct from an ordinary field diff (renderDiffLine) on
// purpose: this isn't "the sheet says X now" the way every other change in
// this email is, it's "OUR script computed a different session number than
// what's literally written in the sheet's cell." Conflating the two would
// make it look like the sheet itself was edited to say "Session 4" when it
// wasn't -- everyone treats the sheet as the source of truth, so that
// distinction matters, just not loudly. See buildDescription's
// sessionNumberNote in lib/calendarEvents.mjs for the calendar-event-side
// version of this same disclosure.
function renderNumberingLine({ rawSessionNumber, sessionNumber }) {
  return `<div style="font-size:11.5px; color:#8a6100; margin-top:2px;">Sheet still says (${rawSessionNumber}) — recalculated to Session ${sessionNumber}</div>`;
}

function renderDiffLine({ field, before, after }) {
  const label = FIELD_LABELS[field] ?? field;
  return `<div style="font-size:12.5px; margin-top:6px; padding-top:6px; border-top:1px solid #f1f3f4;">
    <span style="color:#5f6368;">${escapeHtml(label)}:</span>
    <span style="color:#c5221f; text-decoration:line-through; margin-left:4px;">${escapeHtml(humanFieldValue(field, before))}</span>
    <span style="color:#5f6368;"> → </span>
    <span style="color:#188038; font-weight:600;">${escapeHtml(humanFieldValue(field, after))}</span>
  </div>`;
}

function renderSection(title, badgeColor, items, cardHtmlFor) {
  if (items.length === 0) return "";
  return `
    <tr><td style="padding:22px 0 8px 2px;">
      <span style="font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:${badgeColor};">${escapeHtml(title)}</span>
      <span style="font-size:11px; color:#9aa0a6; margin-left:6px;">${items.length}</span>
    </td></tr>
    ${items.map(cardHtmlFor).join("")}`;
}

export function buildChangeSummaryEmail({ term, calendarLink, timeZone, result }) {
  const totalChanges = result.created.length + result.updated.length + result.deleted.length;
  const subject = buildSubject(result);

  const numberingAffected = [...result.created, ...result.adopted, ...result.updated].filter((e) => e.numberingNote);

  const createdSection = renderSection("New sessions", "#188038", [...result.created, ...result.adopted], (e) =>
    renderCard({ accentColor: "#34a853", summary: e.summary, start: e.start, timeZone, numberingNote: e.numberingNote }));

  const updatedSection = renderSection("Changed sessions", "#e37400", result.updated, (e) => {
    const fieldDiffs = e.changes.filter((c) => c.field !== "description").map(renderDiffLine).join("");
    // Only show the generic "Description updated" filler when nothing else
    // explains the description change -- the numbering line already does
    // that job when it applies, so showing both would just repeat itself.
    const body = fieldDiffs || (e.numberingNote ? "" : `<div style="font-size:12.5px; color:#5f6368; margin-top:6px;">Description updated</div>`);
    return renderCard({ accentColor: "#fbbc04", summary: e.summary, start: e.start, timeZone, body, numberingNote: e.numberingNote });
  });

  const deletedSection = renderSection("Removed sessions", "#c5221f", result.deleted, (e) =>
    renderCard({ accentColor: "#ea4335", summary: e.summary, start: e.start, timeZone }));

  // One quiet line at the top, not a boxed alert -- still the first thing
  // visible, still unambiguous about the sheet-vs-calendar distinction, but
  // sized like a subtitle rather than a warning banner.
  const numberingBanner = numberingAffected.length > 0
    ? `<div style="font-size:12.5px; color:#8a6100; margin-top:6px;">↻ ${numberingAffected.length} session number${numberingAffected.length === 1 ? "" : "s"} recalculated — the sheet's own labels aren't renumbered to match yet.</div>`
    : "";

  const html = `
<div style="background:#f4f5f7; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; margin:0 auto;">
    <tr>
      <td style="padding-bottom:18px;">
        <div style="font-size:13px; color:#5f6368; font-weight:600; letter-spacing:0.02em;">📅 MSDSM SCHEDULE SYNC</div>
        <div style="font-size:20px; font-weight:700; color:#1a1a1a; margin-top:4px;">${totalChanges} change${totalChanges === 1 ? "" : "s"} to ${escapeHtml(term)}</div>
        <div style="font-size:13px; color:#5f6368; margin-top:4px;">Your <a href="${calendarLink}" style="color:#1a73e8; text-decoration:none;">Term I Schedule</a> calendar has already been updated to match.</div>
        ${numberingBanner}
      </td>
    </tr>
    ${createdSection}
    ${updatedSection}
    ${deletedSection}
    <tr>
      <td style="padding-top:28px; border-top:1px solid #e8eaed; margin-top:12px;">
        <div style="font-size:11.5px; color:#9aa0a6; padding-top:14px;">Sent automatically by calendar-sync whenever the schedule sheet changes. If something looks wrong, check the source sheet first — this only mirrors it.</div>
      </td>
    </tr>
  </table>
</div>`;

  return { subject, html };
}

function buildRawMessage({ to, from, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  const message = messageParts.join("\r\n");
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendChangeEmail(gmail, { to, from, subject, html }) {
  const raw = buildRawMessage({ to, from, subject, html });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}
