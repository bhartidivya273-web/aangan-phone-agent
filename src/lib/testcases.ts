import { readFileSync } from "node:fs";

export interface PhoneCase {
  id: string;
  transcript: string;
  provisional_expected_outcome: string;
  provisional_expected_flags: string[];
}

export function loadPhoneCases(file = "data/phone_test_cases.json"): PhoneCase[] {
  return JSON.parse(readFileSync(file, "utf8"));
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** "T01 · Phone · 2 September · 10:23am · 4 min 12 sec ..." -> call time (year 2026, office tz) + duration. */
export function parseHeader(transcript: string, tzOffsetMinutes: number): { callTime: string; durationSec: number | null } {
  const m = transcript.match(/·\s*(\d{1,2})\s+([A-Za-z]+)\s*·\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) throw new Error(`cannot parse call date from: ${transcript.slice(0, 80)}`);
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const utc = Date.UTC(2026, MONTHS[m[2].toLowerCase()], Number(m[1]), hour, Number(m[4])) - tzOffsetMinutes * 60_000;
  const d = transcript.match(/(\d+)\s*min\s*(\d+)\s*sec/i);
  return { callTime: new Date(utc).toISOString(), durationSec: d ? Number(d[1]) * 60 + Number(d[2]) : null };
}

/** The only edit made to a transcript before classification: drop the "— ESCALATE" label from the header (it leaks the answer). */
export function stripLabels(transcript: string): string {
  return transcript.replace(/\s*—\s*ESCALATE\b/, "");
}

export const testPhone = (id: string) => `+9190000000${id.slice(1)}`;
