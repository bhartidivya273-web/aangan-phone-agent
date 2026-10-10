import { describe, expect, it, vi } from "vitest";
import { bookConsultation, findSlots } from "../src/lib/booking";
import { calIfConfigured, createCalClient, type CalClient } from "../src/lib/calcom";
import { getConfig } from "../src/lib/config";
import { MemoryStore } from "../src/lib/store";
import { fakeNotifier } from "./helpers";

const cfg = getConfig({ MODEL_CLASSIFIER: "x", CAL_API_KEY: "cal_live_abc", CAL_EVENT_TYPE_ID: "4242", CAL_ATTENDEE_EMAIL: "bookings@studio.example", APP_BASE_URL: "https://app.test" });
const NOW = new Date("2026-10-09T09:00:00Z");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const slotsBody = { status: "success", data: { "2026-10-13": [{ start: "2026-10-13T10:00:00.000+05:30", end: "2026-10-13T10:30:00.000+05:30" }, { start: "2026-10-13T10:30:00.000+05:30", end: "2026-10-13T11:00:00.000+05:30" }], "2026-10-12": [{ start: "2026-10-12T15:00:00.000+05:30", end: "2026-10-12T15:30:00.000+05:30" }] } };

describe("config", () => {
  it("uses Cal.com only when the key and event type are both set (or forced)", () => {
    expect(cfg.booking.provider).toBe("calcom");
    expect(getConfig({}).booking.provider).toBe("internal");
    expect(getConfig({ CAL_API_KEY: "k" }).booking.provider).toBe("internal");
    expect(getConfig({ CAL_API_KEY: "k", CAL_EVENT_TYPE_ID: "1", BOOKING_PROVIDER: "internal" }).booking.provider).toBe("internal");
    expect(calIfConfigured(cfg)).toBeDefined();
    expect(calIfConfigured(getConfig({}))).toBeUndefined();
  });
});

describe("Cal.com client", () => {
  it("slots: calls /v2/slots with the documented version header and parses, sorts and labels (IST)", async () => {
    const f = vi.fn(async () => json(slotsBody));
    const slots = await createCalClient(cfg, f as unknown as typeof fetch).slots("2026-10-09T09:00:00Z", "2026-10-24T09:00:00Z");
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toMatch(/^https:\/\/api\.cal\.com\/v2\/slots\?/);
    expect(url).toContain("eventTypeId=4242");
    expect(url).toContain("timeZone=Asia%2FKolkata");
    expect(url).toContain("format=range");
    expect(init.headers["cal-api-version"]).toBe("2024-09-04");
    expect(init.headers.Authorization).toBe("Bearer cal_live_abc");
    expect(slots.map((s) => s.label)).toEqual(["Monday, 12 October at 3:00 pm", "Tuesday, 13 October at 10:00 am", "Tuesday, 13 October at 10:30 am"]);
    expect(slots[1].start).toBe("2026-10-13T04:30:00.000Z");
  });
  it("slots: an API error throws (callers turn it into 'designer will follow up')", async () => {
    await expect(createCalClient(cfg, (async () => json({}, 401)) as unknown as typeof fetch).slots("a", "b")).rejects.toThrow(/401/);
  });
  it("book: sends the documented body and version header, with the fallback email only when configured", async () => {
    const f = vi.fn(async () => json({ status: "success", data: { uid: "bk_123", status: "accepted", start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:00:00.000Z" } }, 201));
    const r = await createCalClient(cfg, f as unknown as typeof fetch).book({ startIso: "2026-10-13T04:30:00.000Z", name: "Divya", phone: "+919999900001", notes: "3BHK Kothrud" });
    expect(r).toMatchObject({ ok: true, uid: "bk_123", status: "accepted" });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.cal.com/v2/bookings");
    expect(init.headers["cal-api-version"]).toBe("2026-02-25");
    expect(JSON.parse(init.body)).toEqual({
      start: "2026-10-13T04:30:00.000Z", eventTypeId: 4242,
      attendee: { name: "Divya", timeZone: "Asia/Kolkata", language: "en", email: "bookings@studio.example", phoneNumber: "+919999900001" },
      metadata: { source: "aangan-phone-agent", notes: "3BHK Kothrud", caller: "+919999900001" },
    });
    const noEmail = getConfig({ MODEL_CLASSIFIER: "x", CAL_API_KEY: "k", CAL_EVENT_TYPE_ID: "1" });
    const f2 = vi.fn(async () => json({ status: "success", data: { uid: "u" } }, 201));
    await createCalClient(noEmail, f2 as unknown as typeof fetch).book({ startIso: "2026-10-13T04:30:00.000Z", name: "A", phone: null, notes: null });
    expect(JSON.parse((f2.mock.calls[0] as unknown as [string, { body: string }])[1].body).attendee).toEqual({ name: "A", timeZone: "Asia/Kolkata", language: "en" });
  });
  it("book: maps API errors and network failures to a result instead of throwing", async () => {
    const bad = await createCalClient(cfg, (async () => json({ status: "error", error: { message: "no_available_users_found_error" } }, 400)) as unknown as typeof fetch).book({ startIso: "x", name: "A", phone: null, notes: null });
    expect(bad).toMatchObject({ ok: false, httpStatus: 400, message: "no_available_users_found_error" });
    const net = await createCalClient(cfg, (async () => { throw new Error("offline"); }) as unknown as typeof fetch).book({ startIso: "x", name: "A", phone: null, notes: null });
    expect(net).toMatchObject({ ok: false, httpStatus: null });
  });
});

describe("bookConsultation with Cal.com as the calendar of record", () => {
  const OFFERED = { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:00:00.000Z", label: "Tuesday, 13 October at 10:00 am" };
  const fakeCal = (over: Partial<CalClient> = {}): CalClient & { booked: unknown[] } => {
    const c = {
      booked: [] as unknown[],
      async slots(from: string, to: string) { return [OFFERED, { start: "2026-10-13T05:00:00.000Z", end: "2026-10-13T05:30:00.000Z", label: "Tuesday, 13 October at 10:30 am" }].filter((s) => s.start >= from && s.start <= to); },
      async book(a: unknown) { c.booked.push(a); return { ok: true as const, uid: "bk_1", start: OFFERED.start, end: OFFERED.end, status: "accepted" }; },
      ...over,
    };
    return c as never;
  };
  const setup = (cal: CalClient) => { const store = new MemoryStore(); const notifier = fakeNotifier(); return { store, notifier, d: { store, cfg, now: () => NOW, notifier, designersChatId: "DESIGNERS", cal } }; };

  it("books in Cal.com, mirrors the booking with its uid, and tells the designers it is blocked in Cal.com", async () => {
    const cal = fakeCal();
    const { d, store, notifier } = setup(cal);
    const r = await bookConsultation({ start: OFFERED.start, name: "Divya", phone: "+919999900001" }, d);
    expect(r).toMatchObject({ ok: true, label: "Tuesday, 13 October at 10:00 am" });
    expect(cal.booked).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({ external_provider: "calcom", external_id: "bk_1", customer_name: "Divya", customer_phone_normalized: "9999900001" });
    expect(notifier.sent[0].text).toContain("CONSULTATION BOOKED - Tuesday, 13 October at 10:00 am (phone or video call) - blocked in Cal.com");
  });
  it("a time Cal.com does not offer is refused without calling book(); alternatives come from Cal.com", async () => {
    const cal = fakeCal();
    const { d } = setup(cal);
    const r = await bookConsultation({ start: "2026-10-13T04:45:00.000Z", name: "A" }, d);
    expect(r).toMatchObject({ ok: false, reason: "not_available" });
    if (r.ok) throw new Error();
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(cal.booked).toHaveLength(0);
  });
  it("Cal.com says the slot was just taken (409) -> not_available with alternatives", async () => {
    const { d } = setup(fakeCal({ async book() { return { ok: false, httpStatus: 409, message: "taken" }; } }));
    expect(await bookConsultation({ start: OFFERED.start, name: "A" }, d)).toMatchObject({ ok: false, reason: "not_available" });
  });
  it("Cal.com down or erroring -> booking_error, never 'booked'; the assistant is told to say a designer will follow up", async () => {
    const a = setup(fakeCal({ async book() { return { ok: false, httpStatus: 500, message: "boom" }; } }));
    const r = await bookConsultation({ start: OFFERED.start, name: "A" }, a.d);
    expect(r).toMatchObject({ ok: false, reason: "booking_error" });
    expect(r.ok === false && r.message).toMatch(/designer will follow up/);
    const b = setup(fakeCal({ async slots() { throw new Error("offline"); } }));
    expect(await bookConsultation({ start: OFFERED.start, name: "A" }, b.d)).toMatchObject({ ok: false, reason: "booking_error" });
    expect(a.store.bookings).toHaveLength(0);
  });
  it("a retried tool call for the same caller and slot does not book twice and still answers ok", async () => {
    const cal = fakeCal();
    const { d, store } = setup(cal);
    await bookConsultation({ start: OFFERED.start, name: "Divya" }, d);
    const again = await bookConsultation({ start: OFFERED.start, name: "divya" }, d);
    expect(again.ok).toBe(true);
    expect(cal.booked).toHaveLength(1);
    expect(store.bookings).toHaveLength(1);
  });
  it("findSlots via Cal.com applies the notice window, weekday and part-of-day filters", async () => {
    const cal = fakeCal();
    const store = new MemoryStore();
    expect((await findSlots(store, cfg, NOW, { weekdays: [2], limit: 5 }, cal)).map((s) => s.label)).toEqual(["Tuesday, 13 October at 10:00 am", "Tuesday, 13 October at 10:30 am"]);
    expect(await findSlots(store, cfg, NOW, { weekdays: [4] }, cal)).toEqual([]);
    expect(await findSlots(store, cfg, NOW, { part: "afternoon" }, cal)).toEqual([]);
  });
});
