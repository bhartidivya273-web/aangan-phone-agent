import { describe, expect, it } from "vitest";
import { availableSlots, bookConsultation, countsByStart, findSlots, parseWeekdays, slotLabel } from "../src/lib/booking";
import { getConfig } from "../src/lib/config";
import { buildHandoffNote } from "../src/lib/handoff";
import { processCall } from "../src/lib/pipeline";
import { MemoryStore } from "../src/lib/store";
import { buildVaaniPrompt } from "../src/lib/vaaniPrompt";
import { cfg, cls, deps, fakeLLM, fakeNotifier, rules } from "./helpers";

const NOW = new Date("2026-10-09T09:00:00Z"); // Friday 2:30pm IST
const slots = (q = {}, booked = new Map<string, number>(), c = cfg) => availableSlots(c, NOW, booked, { limit: 500, ...q });

describe("slot rules", () => {
  it("labels in office time", () => {
    expect(slotLabel("2026-10-13T04:30:00.000Z", cfg)).toBe("Tuesday, 13 October at 10:00 am");
    expect(slotLabel("2026-10-09T13:00:00.000Z", cfg)).toBe("Friday, 9 October at 6:30 pm");
  });
  it("starts after the minimum notice, inside office hours, never on Sunday", () => {
    const all = slots();
    expect(all[0].label).toBe("Friday, 9 October at 6:30 pm"); // 2:30pm + 4h notice = 6:30pm
    expect(all[1].label).toBe("Saturday, 10 October at 10:00 am");
    expect(all.some((s) => s.label.startsWith("Sunday"))).toBe(false);
    expect(all.every((s) => { const h = Number(s.label.match(/at (\d+):(\d+) (am|pm)/)!.slice(1, 2)[0]); return h >= 1; })).toBe(true);
    // last slot of a day ends at closing time (7pm): 6:30pm start with 30 min slots
    expect(all.some((s) => s.label.endsWith("7:00 pm"))).toBe(false);
    expect(all.some((s) => s.label.endsWith("9:30 am"))).toBe(false);
  });
  it("stops at the booking horizon (14 days)", () => {
    const last = slots().at(-1)!;
    expect(new Date(last.start).getTime()).toBeLessThanOrEqual(NOW.getTime() + 15 * 86_400_000);
  });
  it("filters by weekday, part of day and date", () => {
    expect(slots({ weekdays: parseWeekdays("tuesday, thu"), limit: 2 }).map((s) => s.label)).toEqual(["Tuesday, 13 October at 10:00 am", "Tuesday, 13 October at 10:30 am"]);
    expect(slots({ part: "evening", limit: 1 })[0].label).toBe("Friday, 9 October at 6:30 pm");
    expect(slots({ part: "morning", date: "2026-10-12", limit: 1 })[0].label).toBe("Monday, 12 October at 10:00 am");
    expect(slots({ part: "afternoon", date: "2026-10-12" }).every((s) => /(1[2]|[1-4]):\d\d pm/.test(s.label))).toBe(true);
    expect(slots({ date: "2026-10-11" })).toEqual([]); // a Sunday
  });
  it("parseWeekdays understands names and short forms", () => {
    expect(parseWeekdays("Tuesday and Thursday")).toEqual([2, 4]);
    expect(parseWeekdays("sat, sun")).toEqual([6, 0]);
    expect(parseWeekdays("")).toEqual([]);
    expect(parseWeekdays("whenever")).toEqual([]);
  });
  it("a full slot disappears; capacity 2 keeps it open for one more", () => {
    const first = slots()[0];
    expect(slots({}, new Map([[first.start, 1]]))[0].label).not.toBe(first.label);
    const c2 = { ...cfg, booking: { ...cfg.booking, capacity: 2 } };
    expect(slots({}, new Map([[first.start, 1]]), c2)[0].label).toBe(first.label);
  });
  it("respects configured slot length and hours", () => {
    const c = getConfig({ MODEL_CLASSIFIER: "x", BOOKING_SLOT_MINUTES: "60", OFFICE_OPEN_HOUR: "11", OFFICE_CLOSE_HOUR: "13" });
    const day = availableSlots(c, NOW, new Map(), { limit: 50, date: "2026-10-12" });
    expect(day.map((s) => s.label)).toEqual(["Monday, 12 October at 11:00 am", "Monday, 12 October at 12:00 pm"]);
  });
});

describe("bookConsultation", () => {
  const setup = () => {
    const store = new MemoryStore();
    const notifier = fakeNotifier();
    return { store, notifier, d: { store, cfg, now: () => NOW, notifier, designersChatId: "DESIGNERS" } };
  };
  it("books a real slot, stores it and tells the designers' group immediately", async () => {
    const { d, store, notifier } = setup();
    const first = (await findSlots(store, cfg, NOW, { limit: 1 }))[0];
    const r = await bookConsultation({ start: first.start, name: "Divya", phone: "+91 99999 00001" }, d);
    expect(r).toMatchObject({ ok: true, label: "Friday, 9 October at 6:30 pm" });
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({ customer_name: "Divya", customer_phone_normalized: "9999900001", status: "booked" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].chatId).toBe("DESIGNERS");
    expect(notifier.sent[0].text).toContain("CONSULTATION BOOKED - Friday, 9 October at 6:30 pm");
  });
  it("the same slot cannot be booked twice; the answer carries alternatives", async () => {
    const { d, store } = setup();
    const first = (await findSlots(store, cfg, NOW, { limit: 1 }))[0];
    await bookConsultation({ start: first.start, name: "A" }, d);
    const r = await bookConsultation({ start: first.start, name: "B" }, d);
    expect(r).toMatchObject({ ok: false, reason: "not_available" });
    if (r.ok) throw new Error();
    expect(r.alternatives).toHaveLength(3);
    expect(r.alternatives.every((s) => s.start !== first.start)).toBe(true);
    expect(store.bookings).toHaveLength(1);
  });
  it("two simultaneous callers: exactly one gets the slot", async () => {
    const { d, store } = setup();
    const first = (await findSlots(store, cfg, NOW, { limit: 1 }))[0];
    const [a, b] = await Promise.all([bookConsultation({ start: first.start, name: "A" }, d), bookConsultation({ start: first.start, name: "B" }, d)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(store.bookings).toHaveLength(1);
  });
  it.each([
    ["a time off the slot grid", "2026-10-13T04:45:00.000Z"],
    ["a Sunday", "2026-10-11T05:00:00.000Z"],
    ["the past", "2026-10-01T05:00:00.000Z"],
    ["before the minimum notice", "2026-10-09T10:00:00.000Z"],
    ["beyond the horizon", "2027-01-05T05:00:00.000Z"],
    ["nonsense", "next tuesday"],
  ])("rejects %s", async (_n, start) => {
    const { d, store } = setup();
    const r = await bookConsultation({ start, name: "A" }, d);
    expect(r.ok).toBe(false);
    expect(store.bookings).toHaveLength(0);
  });
  it("needs the caller's name", async () => {
    const { d } = setup();
    const first = (await findSlots(d.store, cfg, NOW, { limit: 1 }))[0];
    expect(await bookConsultation({ start: first.start, name: "  " }, d)).toMatchObject({ ok: false, reason: "name_required" });
  });
  it("countsByStart ignores cancelled bookings", () => {
    expect(countsByStart([{ start_at: "2026-10-12T04:30:00Z", status: "booked" }, { start_at: "2026-10-12T04:30:00Z", status: "cancelled" }]).get("2026-10-12T04:30:00.000Z")).toBe(1);
  });
});

describe("a consultation booked during a call reaches the lead note", () => {
  const callAt = "2026-10-09T09:11:00Z";
  async function bookedThenCall(over: { startedAt?: string; endedAt?: string } = {}) {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({}, { name: "Divya", preferred_days: "Friday" })) });
    const first = (await findSlots(store, cfg, new Date("2026-10-09T09:12:00Z"), { limit: 1 }))[0];
    // the booking tool is called mid-call, a minute before the call report
    const b = await store.bookSlot({ start: first.start, end: first.end, capacity: 1, name: "Divya", phone: null, phoneNormalized: null, notes: null });
    b!.created_at = "2026-10-09T09:14:00.000Z";
    const r = await processCall({ transcript: `AI Agent: Hi. Caller: Divya. AI Agent: Booked for ${first.label}.`, callerPhone: "+919999900099", startedAt: over.startedAt ?? callAt, endedAt: over.endedAt ?? "2026-10-09T09:16:00Z", provider: "vaani" }, d);
    return { r, store, notifier, first, b: b! };
  }
  it("links the booking to the call and lead, adds it to the note, counts it as the consultation, and does not flag the time as a promise", async () => {
    const { r, store, notifier, first, b } = await bookedThenCall();
    expect(b.call_id).toBe(r.call.id);
    expect(b.lead_id).toBe(r.lead!.id);
    expect(b.customer_phone).toBe("+919999900099");
    expect(r.lead!.consultation_at).toBe(first.start);
    const note = notifier.sent.find((n) => n.text.startsWith("NEW LEAD"))!;
    expect(note.text).toContain(`Consultation booked: ${first.label} (phone or video call)`);
    expect(store.calls[0].flags).not.toContain("agent_promise");
  });
  it("a booking from outside the call's window is not attached", async () => {
    const { b } = await bookedThenCall({ startedAt: "2026-10-09T07:00:00Z", endedAt: "2026-10-09T07:05:00Z" });
    expect(b.call_id).toBeNull();
  });
  it("buildHandoffNote shows the booking line only when there is one", () => {
    const rec = { callTime: callAt, lead: { call_count: 1, first_call_at: callAt, fields: { name: "D" } }, callerPhone: "1", flags: [], pricingAsked: false, isUpdate: false, callId: "c" };
    expect(buildHandoffNote(rec, cfg)).not.toContain("Consultation booked");
    expect(buildHandoffNote({ ...rec, bookingStart: "2026-10-13T04:30:00.000Z" }, cfg)).toContain("Consultation booked: Tuesday, 13 October at 10:00 am (phone or video call)");
  });
});

describe("assistant instructions follow the booking switch", () => {
  it("with booking on: tools, exact-slot rules, and times only from a tool", () => {
    const p = buildVaaniPrompt(rules, cfg);
    expect(p).toContain("# Booking the consultation");
    expect(p).toContain("Only if Book consultation answers ok: true");
    expect(p).toContain("ONLY times you may ever say are consultation slots that a booking tool returned");
  });
  it("with booking off: the earlier no-dates wording and no tools", () => {
    const p = buildVaaniPrompt(rules, getConfig({ MODEL_CLASSIFIER: "x", BOOKING_ENABLED: "false" }));
    expect(p).not.toContain("# Booking the consultation");
    expect(p).toContain("NEVER turn weekdays into calendar dates");
  });
});
