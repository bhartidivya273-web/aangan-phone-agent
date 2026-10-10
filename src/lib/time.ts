import type { Config } from "./config";

type TimeCfg = Pick<
  Config,
  "officeOpenHour" | "officeCloseHour" | "officeDays" | "tzOffsetMinutes" | "tzName" | "afterHoursDeadline"
>;

/** Local (office timezone) wall-clock parts. The office timezone is a fixed offset (IST has no DST). */
export function localParts(d: Date, cfg: Pick<Config, "tzOffsetMinutes">) {
  const l = new Date(d.getTime() + cfg.tzOffsetMinutes * 60_000);
  return {
    y: l.getUTCFullYear(),
    m: l.getUTCMonth(),
    d: l.getUTCDate(),
    hour: l.getUTCHours(),
    minute: l.getUTCMinutes(),
    weekday: l.getUTCDay(),
  };
}

export function fromLocal(y: number, m: number, d: number, hour: number, minute: number, cfg: Pick<Config, "tzOffsetMinutes">) {
  return new Date(Date.UTC(y, m, d, hour, minute) - cfg.tzOffsetMinutes * 60_000);
}

export function isOfficeHours(d: Date, cfg: TimeCfg): boolean {
  const p = localParts(d, cfg);
  return cfg.officeDays.includes(p.weekday) && p.hour >= cfg.officeOpenHour && p.hour < cfg.officeCloseHour;
}

/** Next office day (today if still before opening) at the after-hours deadline, e.g. 10:30. */
export function nextDeadlineMorning(from: Date, cfg: TimeCfg): Date {
  const [hh, mm] = cfg.afterHoursDeadline.split(":").map(Number);
  const p = localParts(from, cfg);
  for (let i = 0; i < 8; i++) {
    const day = fromLocal(p.y, p.m, p.d + i, hh, mm, cfg);
    const wd = localParts(day, cfg).weekday;
    if (day.getTime() > from.getTime() && cfg.officeDays.includes(wd)) return day;
  }
  throw new Error("OFFICE_DAYS has no valid day");
}

/**
 * Proposed first-contact / callback rule: `officeMinutes` after the event if that still falls in office hours,
 * otherwise by the after-hours deadline on the next office day.
 */
export function dueTime(event: Date, officeMinutes: number, cfg: TimeCfg): Date {
  if (isOfficeHours(event, cfg)) {
    const t = new Date(event.getTime() + officeMinutes * 60_000);
    if (isOfficeHours(t, cfg)) return t;
  }
  return nextDeadlineMorning(event, cfg);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(d: Date, cfg: Pick<Config, "tzOffsetMinutes">): string {
  const p = localParts(d, cfg);
  return `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

export function formatTime(d: Date, cfg: Pick<Config, "tzOffsetMinutes">): string {
  const p = localParts(d, cfg);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")}${p.hour < 12 ? "am" : "pm"}`;
}
