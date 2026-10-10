import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cls, deps, fakeLLM } from "./helpers";

const h = deps({ llm: fakeLLM(cls()) });
vi.mock("@/lib/runtime", () => ({ productionDeps: () => h.d }));

describe("booking tool endpoints (called by the voice assistant)", () => {
  beforeEach(() => vi.stubEnv("VOICE_WEBHOOK_SECRET", "bk-secret"));
  afterEach(() => vi.unstubAllEnvs());
  const get = (qs: string, key: string | null = "bk-secret") => new Request(`http://x/api/booking/slots?${key ? `key=${key}&` : ""}${qs}`);
  const post = (body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }, key: string | null = "bk-secret") =>
    new Request(`http://x/api/booking/book${key ? `?key=${key}` : ""}`, { method: "POST", headers, body });

  it("both endpoints reject calls without the secret", async () => {
    const { GET } = await import("../src/app/api/booking/slots/route");
    const { POST } = await import("../src/app/api/booking/book/route");
    expect((await GET(get("", null))).status).toBe(401);
    expect((await GET(get("", "wrong"))).status).toBe(401);
    expect((await POST(post("{}", undefined, null))).status).toBe(401);
  });
  it("slots: returns spoken labels and exact start values, honours weekdays and limit", async () => {
    const { GET } = await import("../src/app/api/booking/slots/route");
    const j = await (await GET(get("weekdays=tuesday,thursday&limit=2"))).json();
    expect(j.ok).toBe(true);
    expect(j.slots).toHaveLength(2);
    expect(j.slots[0]).toMatchObject({ say: expect.stringMatching(/^(Tuesday|Thursday), \d+ \w+ at \d+:\d\d (am|pm)$/), start: expect.stringMatching(/Z$/) });
    expect(j.consultation).toBe("phone or video call");
  });
  it("responses also carry a `data` object (data.slots, data.message) matching Vaani's default variable mapping", async () => {
    const { GET } = await import("../src/app/api/booking/slots/route");
    const { POST } = await import("../src/app/api/booking/book/route");
    const j = await (await GET(get("limit=2"))).json();
    expect(j.data.slots).toEqual(j.slots);
    expect(typeof j.data.message).toBe("string");
    const bad = await (await POST(post(JSON.stringify({ start: "nonsense", name: "X" })))).json();
    expect(bad.data.message).toMatch(/./);
  });
  it("slots also answers POST (how Vaani sends tool parameters), with the secret in a header", async () => {
    const { POST } = await import("../src/app/api/booking/slots/route");
    const req = (body: string, headers: Record<string, string>) => new Request("http://x/api/booking/slots", { method: "POST", headers, body });
    const ok = await (await POST(req(JSON.stringify({ weekdays: "tuesday", part: "morning", limit: 2 }), { "content-type": "application/json", "x-webhook-secret": "bk-secret" }))).json();
    expect(ok.ok).toBe(true);
    expect(ok.slots).toHaveLength(2);
    expect(ok.slots.every((s: { say: string }) => s.say.startsWith("Tuesday"))).toBe(true);
    expect((await POST(req("{}", { "content-type": "application/json" }))).status).toBe(401);
    expect((await (await POST(req("not json at all", { "x-webhook-secret": "bk-secret" }))).json()).ok).toBe(true); // unreadable body = no filters
  });
  it("book also accepts the secret in a header", async () => {
    const { POST } = await import("../src/app/api/booking/book/route");
    const r = await POST(new Request("http://x/api/booking/book", { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "bk-secret" }, body: JSON.stringify({ start: "nonsense", name: "X" }) }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(false);
  });
  it("book: JSON body books; the same slot again is refused with alternatives; form bodies work too", async () => {
    const { GET } = await import("../src/app/api/booking/slots/route");
    const { POST } = await import("../src/app/api/booking/book/route");
    const { slots } = await (await GET(get("limit=3"))).json();
    const a = await (await POST(post(JSON.stringify({ start: slots[0].start, name: "Divya" })))).json();
    expect(a).toMatchObject({ ok: true, booked: slots[0].say });
    const b = await (await POST(post(JSON.stringify({ start: slots[0].start, name: "Other" })))).json();
    expect(b).toMatchObject({ ok: false, reason: "not_available" });
    expect(b.alternatives.length).toBeGreaterThan(0);
    const c = await (await POST(post(`start=${encodeURIComponent(slots[1].start)}&name=Form+Caller`, { "content-type": "application/x-www-form-urlencoded" }))).json();
    expect(c).toMatchObject({ ok: true, booked: slots[1].say });
    expect(h.store.bookings.map((x) => x.customer_name)).toEqual(["Divya", "Form Caller"]);
  });
  it("book without a name or with a made-up time is refused", async () => {
    const { POST } = await import("../src/app/api/booking/book/route");
    expect((await (await POST(post(JSON.stringify({ start: "2026-12-01T05:00:00Z" })))).json()).reason).toBe("name_required");
    expect((await (await POST(post(JSON.stringify({ start: "tomorrow morning", name: "X" })))).json()).ok).toBe(false);
  });
});
