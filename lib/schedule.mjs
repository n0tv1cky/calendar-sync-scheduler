// Reads the term's daily timetable + course-code legend from the schedule
// .xlsx (a raw Office file on Drive, view-only for us -- so this goes
// through Drive's files.get(alt=media) + the `xlsx` package, never the
// Sheets API, which flatly refuses to touch non-native files). Parsing
// logic mirrors scripts/attendance/lib/schedule.mjs, which reads this same
// file -- kept as a separate copy rather than a shared module because these
// are two independent script projects with their own dependencies/configs,
// per the existing convention in this repo.

import XLSX from "xlsx";

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseSheetDate(raw) {
  // Sheet dates are strings like "14-Aug-26" -- not Sheets serial numbers,
  // since this is a raw xlsx read with the `xlsx` package (raw: false gives
  // us the displayed string, which is what's reliably parseable here).
  const m = String(raw ?? "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const year = 2000 + parseInt(m[3], 10);
  return new Date(year, month, day);
}

function isNonClassCell(cell, nonClassMarkers) {
  const s = String(cell ?? "").trim().toLowerCase();
  if (!s) return true;
  return nonClassMarkers.some((marker) => s.includes(marker));
}

// Resolves a raw timetable cell (e.g. "DSM 101 (2)", "ME-1 (KN)", "SM3",
// "MC 1", "ME 11 (DS)") down to just the canonical subject code, ignoring
// session numbers and trailing faculty-initial parens -- see
// scripts/attendance/lib/schedule.mjs for the full rationale (verified
// against the real data there).
export function resolveSubjectCode(rawCell, subjectCodeMap, nonClassMarkers) {
  const cell = String(rawCell ?? "").trim();
  if (isNonClassCell(cell, nonClassMarkers)) return null;

  let m = cell.match(/^DSM\s*(\d{3})/i);
  if (m) return `DSM ${m[1]}`;

  m = cell.match(/^([A-Za-z]+)/);
  if (!m) return null;
  const abbrev = m[1].toUpperCase();
  return subjectCodeMap[abbrev] ?? null;
}

// Best-effort extraction of whatever number is hand-written in a raw
// timetable cell (e.g. "DSM 103 (5)" -> 5, "ME-1 (KN)" -> 1, "MC 1" -> 1,
// "BR1" -> 1, "ME - 3 (KN)" -> 3), NOT used to determine the actual session
// number (see resolveSubjectCode's comment -- the cell text is too
// inconsistent to trust for that, which is exactly why countSessionOccurrences-
// style chronological counting is the real logic). This exists purely to
// DETECT when the sheet's own hand-written number disagrees with the
// computed one, so that disagreement can be surfaced rather than silently
// diverging -- confirmed live: someone deleted a DSM 103 occurrence from
// the sheet without renumbering the "(N)" labels in every cell after it, so
// the sheet's own raw text permanently skips a number from that point on,
// while the computed (correct) sequence stays dense. Strips the leading
// subject token first (DSM-code or alpha abbreviation) so a 3-digit DSM
// code itself is never mistaken for a session number, then takes the first
// remaining digit run. Returns null if no number is found at all (e.g. a
// cell with only faculty initials in parens, nothing to compare against).
export function extractRawSessionNumber(rawCell) {
  const original = String(rawCell ?? "").trim();
  if (!original) return null;
  let rest = original.replace(/^DSM\s*\d{3}/i, "");
  if (rest === original) rest = original.replace(/^[A-Za-z]+/, "");
  const m = rest.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export async function fetchScheduleWorkbook(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return XLSX.read(Buffer.from(res.data), { type: "buffer" });
}

// Returns the raw array-of-cells rows for the header row and every data row
// of the timetable (before the legend table).
export function parseTimetable(workbook, sheetName, legendMarker) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`Schedule workbook has no sheet named "${sheetName}" (found: ${workbook.SheetNames.join(", ")})`);
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const legendIdx = allRows.findIndex((r) => String(r[0] ?? "").trim() === legendMarker);
  return legendIdx === -1 ? allRows : allRows.slice(0, legendIdx);
}

const TITLE_HEADER_CANDIDATES = ["title", "course title", "course name", "subject", "subject name"];
const INSTRUCTOR_HEADER_CANDIDATES = ["instructor", "faculty", "faculty name", "professor"];
const EMAIL_HEADER_CANDIDATES = ["email", "e-mail", "instructor email"];

function findHeaderCol(header, candidates) {
  const lower = header.map((h) => String(h ?? "").trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

// Which institute teaches a course is NOT a column in the legend -- it's
// derived from the instructor email domain (@iiti.ac.in vs
// @iimidr.ac.in-ish), which is the one place the sheet actually records it
// reliably. Confirmed against the real data: every course whose email(s)
// contain "iiti" is the one tagged "IIT Indore" + colorId 11 on the user's
// existing hand-built calendar events, and every "iimidr"/"iim" course is
// the untagged/default-color one. Some emails in the sheet have a find-
// replace typo (e.g. "amitv@IIM Indoreidr.ac.in") -- matching on the
// substring "iim" rather than the full domain survives that.
export function resolveInstitute(emailField) {
  const lower = String(emailField ?? "").toLowerCase();
  if (lower.includes("iiti")) return "IIT Indore";
  if (lower.includes("iim")) return "IIM Indore";
  return undefined;
}

// The legend's Course Title column has real spelling typos in the source
// sheet (confirmed live, same family of error as the Email column's typos
// documented in docs/course-codes.md) -- "Stattistics", "Mathmatical".
// Corrected here rather than left as-is, because the pre-existing hand-made
// calendar events already used the corrected spelling; syncing the raw
// sheet title verbatim would have been a visible regression (confirmed
// live: it silently reverted an already-correct "Probability & Statistics"
// title back to the sheet's "Stattistics" on the first sync run). Add an
// entry here if a future term's legend has a new one.
const TITLE_TYPO_FIXES = [
  [/\bStattistics\b/i, "Statistics"],
  [/\bMathmatical\b/i, "Mathematical"],
];

function fixKnownTypos(title) {
  return TITLE_TYPO_FIXES.reduce((s, [pattern, fix]) => s.replace(pattern, fix), title);
}

// Parses the course legend table (Course Code / Title / Instructor /
// Abbreviation / Email / ...) into
// { [canonicalCode]: { abbrev, title, instructor, institute } }, keyed by
// the canonical DSM code so calendar events can show the real course name
// and institute instead of just "DSM 101". Columns are matched by header
// name against a few known variants -- if the sheet doesn't have one, that
// field comes back undefined and callers fall back to the bare code.
export function parseLegend(workbook, sheetName, legendMarker) {
  const ws = workbook.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const legendIdx = allRows.findIndex((r) => String(r[0] ?? "").trim() === legendMarker);
  if (legendIdx === -1) return {};

  const header = allRows[legendIdx];
  const codeCol = header.indexOf("Course Code");
  const abbrevCol = header.indexOf("Abbreviation");
  const titleCol = findHeaderCol(header, TITLE_HEADER_CANDIDATES);
  const instructorCol = findHeaderCol(header, INSTRUCTOR_HEADER_CANDIDATES);
  const emailCol = findHeaderCol(header, EMAIL_HEADER_CANDIDATES);

  const byCode = {};
  for (const row of allRows.slice(legendIdx + 1)) {
    const code = String(row[codeCol] ?? "").trim();
    if (!code) continue;
    const email = emailCol !== -1 ? String(row[emailCol] ?? "").trim() : "";
    byCode[code] = {
      abbrev: abbrevCol !== -1 ? String(row[abbrevCol] ?? "").trim().toUpperCase() : undefined,
      title: titleCol !== -1 ? fixKnownTypos(String(row[titleCol] ?? "").trim()) || undefined : undefined,
      instructor: instructorCol !== -1 ? String(row[instructorCol] ?? "").trim() || undefined : undefined,
      institute: resolveInstitute(email),
    };
  }
  return byCode;
}
