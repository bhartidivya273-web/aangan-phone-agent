import type { CalClient } from "./calcom";
import type { Config } from "./config";
import { normalizePhone } from "./phone";
import type { Store } from "./store";
import type { Notifier } from "./telegram";
import { sendHandoff } from "./handoff";
import { fromLocal, localParts } from "./time";
import type { BookingRow } from "./types";

/**
 * Consultation booking: ONE shared calendar. Slots are the office days/hours (OFFICE_DAYS, OFFICE_OPEN_HOUR/CLOSE_HOUR) cut into
 * BOOKING_SLOT_MINUTES steps, at least BOOKING_MIN_NOTICE_HOURS from now and at most BOOKING_DAYS_AHEAD days ahead.
 * BOOKING_CAPACITY consultations can share one slot (default 1). The database function book_slot() makes the last step atomic,
 * so two callers can never take the same slot beyond its capacity. No real calendar is synced yet (OPEN).
 */
export interface Slot {
  start: string; // ISO instant
  end: string;
  label: string; // what the assistant says aloud
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function slotLabel(startIso: string, cfg: Pick<Config, "tzOffsetMinutes">): string {
  const p = localParts(new Date(startIso), cfg);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${DAYS[p.weekday]}, ${p.d} ${MONTHS[p.m]} at ${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "tuesday, thu" -> [2, 4]. Unknown words are ignored. */
export function parseWeekdays(input: string | null | undefined): number[] {
  if (!input) return [];
  const out = new Set<number>();
  for (const w of input.toLowerCase().split(/[,\s/&]+|and/).filter(Boolean)) {
    const i = DAYS.findIndex((d) => d.toLowerCase().startsWith(w.slice(0, 3)) && w.length >= 3);
    if (i >= 0) out.add(i);
  }
  return [...out];
}

export interface SlotQuery {
  weekdays?: number[];
  date?: string; // YYYY-MM-DD (office timezone)
  part?: "morning" | "afternoon" | "evening";
  limit?: number;
}

const iso = (d: Date) => d.toISOString();

/** Every slot in the booking window, whether free or not, in order. */
function grid(cfg: Config, now: Date): Slot[] {
  const b = cfg.booking;
  const out: Slot[] = [];
  const today = localParts(now, cfg);
  for (let i = 0; i <= b.daysAhead; i++) {
    const noon = fromLocal(today.y, today.m, today.d + i, 12, 0, cfg);
    const day = localParts(noon, cfg);
    if (!cfg.officeDays.includes(day.weekday)) continue;
    for (let mins = cfg.officeOpenHour * 60; mins + b.slotMinutes <= cfg.officeCloseHour * 60; mins += b.slotMinutes) {
      const start = fromLocal(day.y, day.m, day.d, Math.floor(mins / 60), mins % 60, cfg);
      const end = new Date(start.getTime() + b.slotMinutes * 60_000);
      out.push({ start: iso(start), end: iso(end), label: slotLabel(iso(start), cfg) });
    }
  }
  return out;
}

export function countsByStart(bookings: Pick<BookingRow, "start_at" | "status">[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bookings) if (b.status === "booked") {
    const k = iso(new Date(b.start_at));
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Keep slots that satisfy the notice window and the caller's preferences (weekday, part of day, date). */
export function filterSlots(all: Slot[], cfg: Config, now: Date, q: SlotQuery = {}, isFull: (s: Slot) => boolean = () => false): Slot[] {
  const earliest = now.getTime() + cfg.booking.minNoticeHours * 3_600_000;
  const out: Slot[] = [];
  for (const s of all) {
    if (new Date(s.start).getTime() < earliest) continue;
    if (isFull(s)) continue;
    const p = localParts(new Date(s.start), cfg);
    if (q.weekdays?.length && !q.weekdays.includes(p.weekday)) continue;
    if (q.date) {
      const ymd = `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
      if (ymd !== q.date) continue;
    }
    if (q.part === "morning" && p.hour >= 13) continue;
    if (q.part === "afternoon" && (p.hour < 13 || p.hour >= 17)) continue;
    if (q.part === "evening" && p.hour < 17) continue;
    out.push(s);
    if (out.length >= (q.limit ?? 4)) break;
  }
  return out;
}

export function availableSlots(cfg: Config, now: Date, booked: Map<string, number>, q: SlotQuery = {}): Slot[] {
  return filterSlots(grid(cfg, now), cfg, now, q, (s) => (booked.get(s.start) ?? 0) >= cfg.booking.capacity);
}

/** Free slots: from Cal.com when a client is given (it knows the real calendar), otherwise from the built-in scheduler. */
export async function findSlots(store: Store, cfg: Config, now: Date, q: SlotQuery, cal?: CalClient) {
  const to = new Date(now.getTime() + (cfg.booking.daysAhead + 2) * 86_400_000);
  if (cal) {
    const all = await cal.slots(iso(now), iso(to));
    return filterSlots(all, cfg, now, q);
  }
  const booked = countsByStart(await store.listBookings(iso(now), iso(to)));
  return availableSlots(cfg, now, booked, q);
}

export interface BookArgs {
  start: string;
  name?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export type BookResult =
  | { ok: true; booking: BookingRow; label: string; mode: string }
  | { ok: false; reason: "invalid_time" | "not_available" | "name_required" | "booking_error"; message: string; alternatives: Slot[] };

export interface BookDeps {
  store: Store;
  cfg: Config;
  now?: () => Date;
  notifier?: Notifier;
  designersChatId?: string;
  /** When set, Cal.com is the calendar of record. */
  cal?: CalClient;
}

/**
 * Books a slot. The requested start must be one of the real slots (so a made-up time is rejected), and the final step is atomic.
 * On success the designers' group gets an immediate "consultation booked" message, so a booking is never lost even if the call
 * report never arrives. On failure the result carries the next free slots so the assistant can offer them straight away.
 */
export async function bookConsultation(args: BookArgs, deps: BookDeps): Promise<BookResult> {
  const { store, cfg } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const wanted = Date.parse(args.start);
  const alternatives = async () => findSlots(store, cfg, now, { limit: 3 });
  if (!args.name || !args.name.trim()) return { ok: false, reason: "name_required", message: "Ask for the caller's name first.", alternatives: [] };
  if (Number.isNaN(wanted)) return { ok: false, reason: "invalid_time", message: "That time was not understood. Offer one of the listed slots.", alternatives: await alternatives() };
  const startIso = iso(new Date(wanted));
  const name = args.name.trim().slice(0, 120);
  const alt = async () => findSlots(store, cfg, now, { limit: 3 }, deps.cal);

  let booking: BookingRow | null;
  let slot: Slot;
  if (deps.cal) {
    // Cal.com: it owns availability and blocks the calendar. We check the slot is really offered, then ask it to book.
    let offered: Slot[];
    try {
      offered = (await deps.cal.slots(new Date(wanted - 60_000).toISOString(), new Date(wanted + 60 * 60_000).toISOString())).filter((x) => x.start === startIso);
    } catch (e) {
      return { ok: false, reason: "booking_error", message: "The calendar could not be reached. Do not say it is booked: say a designer will follow up to arrange a time.", alternatives: [] };
    }
    if (new Date(startIso).getTime() < now.getTime() + cfg.booking.minNoticeHours * 3_600_000 || offered.length === 0) {
      return { ok: false, reason: "not_available", message: "That slot is not available. Offer one of the alternatives.", alternatives: await alt().catch(() => []) };
    }
    slot = offered[0];
    // a retried tool call for the same caller and slot must not look like a failure
    const already = (await store.listBookings(startIso, startIso)).find((b) => b.external_provider === "calcom" && (b.customer_name ?? "").toLowerCase() === name.toLowerCase());
    if (already) return { ok: true, booking: already, label: slot.label, mode: cfg.booking.mode };
    const r = await deps.cal.book({ startIso, name, phone: args.phone?.trim() || null, notes: args.notes?.trim() || null });
    if (!r.ok) {
      const taken = r.httpStatus !== null && [400, 409, 422].includes(r.httpStatus);
      return taken
        ? { ok: false, reason: "not_available", message: "That slot was just taken. Offer one of the alternatives.", alternatives: await alt().catch(() => []) }
        : { ok: false, reason: "booking_error", message: "The calendar had a problem. Do not say it is booked: say a designer will follow up to arrange a time.", alternatives: [] };
    }
    booking = await store.insertBooking({
      start_at: slot.start, end_at: slot.end, status: "booked", customer_name: name, customer_phone: args.phone?.trim() || null,
      customer_phone_normalized: normalizePhone(args.phone), notes: args.notes?.trim().slice(0, 500) || null,
      call_id: null, lead_id: null, external_provider: "calcom", external_id: r.uid,
    });
  } else {
    const free = await findSlots(store, cfg, now, { limit: 10_000 });
    const found = free.find((s) => s.start === startIso);
    if (!found) return { ok: false, reason: "not_available", message: "That slot is not available. Offer one of the alternatives.", alternatives: await alt() };
    slot = found;
    booking = await store.bookSlot({ start: slot.start, end: slot.end, capacity: cfg.booking.capacity, name, phone: args.phone?.trim() || null, phoneNormalized: normalizePhone(args.phone), notes: args.notes?.trim().slice(0, 500) || null });
    if (!booking) return { ok: false, reason: "not_available", message: "That slot was just taken. Offer one of the alternatives.", alternatives: await alt() };
  }
  if (deps.notifier && deps.designersChatId) {
    await sendHandoff(
      { store, notifier: deps.notifier, now: () => now },
      {
        text: `CONSULTATION BOOKED - ${slotLabel(slot.start, cfg)} (${cfg.booking.mode})${deps.cal ? " - blocked in Cal.com" : ""}\n${booking!.customer_name}${booking!.customer_phone ? `, ${booking!.customer_phone}` : ""}\nBooked by the phone assistant during a call. The full lead note follows when the call ends.`,
        chatId: deps.designersChatId,
        kind: "booking_alert",
        leadId: null,
        callId: null,
      },
    );
  }
  return { ok: true, booking: booking!, label: slotLabel(slot.start, cfg), mode: cfg.booking.mode };
}
