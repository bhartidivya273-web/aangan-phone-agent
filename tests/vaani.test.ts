import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCall } from "../src/lib/pipeline";
import { agentPriceLeaks } from "../src/lib/priceFilter";
import { loadRules } from "../src/lib/rules";
import { buildVaaniPrompt } from "../src/lib/vaaniPrompt";
import { createVaaniAdapter, normalizeVaaniTranscript } from "../src/lib/voice/vaani";
import { handleVoiceEvents } from "../src/lib/voice/webhook";
import { cfg, cls, deps, fakeLLM, rules } from "./helpers";

// shaped exactly like the sample in Vaani's webhook guide (call_postprocessing)
const post = (over: Record<string, unknown> = {}) => ({
  event: "call_postprocessing",
  call_id: "inbound-1784899978-36cec598",
  timestamp: "2026-10-09T09:16:00+00:00",
  data: {
    room_name: "inbound-1784899978-36cec598",
    call_id: "inbound-1784899978-36cec598",
    call_duration: 300000,
    end_reason: "Call ended",
    summary: "s",
    entities: { name: "Priya" },
    dispositions: {},
    recording_url: "https://x/stream/1",
    transcript: "[13:33:14] AGENT: Hello, you have reached Aangan Studio. [13:33:30] USER: I want to redo my 3BHK in Kothrud. [13:34:00] AGENT: Thank you.",
  },
  ...over,
});

const history = (calls: object[], hasNext = false) => ({ data: calls, pagination: { has_next: hasNext } });
const fetchReturning = (...pages: object[]) => {
  let i = 0;
  return vi.fn(async () => new Response(JSON.stringify(pages[Math.min(i++, pages.length - 1)]), { status: 200 })) as unknown as typeof fetch;
};

describe("Vaani adapter: webhook parsing", () => {
  const a = createVaaniAdapter();
  it("turns call_postprocessing into an end-of-call report with a clean transcript and derived times", () => {
    const [ev] = a.parse(post());
    expect(ev).toMatchObject({ type: "end_of_call_report", report: { providerCallId: "inbound-1784899978-36cec598", durationSec: 300, answeredBy: "ai", callerPhone: null } });
    if (ev.type !== "end_of_call_report") throw new Error();
    expect(ev.report.transcript).toBe("AI Agent: Hello, you have reached Aangan Studio. Caller: I want to redo my 3BHK in Kothrud. AI Agent: Thank you.");
    expect(ev.report.endedAt).toBe("2026-10-09T09:16:00.000Z");
    expect(ev.report.startedAt).toBe("2026-10-09T09:11:00.000Z");
  });
  it.each(["call_started", "call_ended", "user_picked_up_at", "human_transfer_initiated", "call_no_answer"])("ignores %s", (event) => {
    expect(a.parse({ event, room_name: "r" })[0].type).toBe("ignored");
  });
  it("rejects garbage", () => {
    expect(() => a.parse({ nothing: true })).toThrow();
    expect(() => a.parse({ event: "call_postprocessing", data: {} })).toThrow(/call id/);
  });
  it("normalises both transcript styles Vaani uses", () => {
    expect(normalizeVaaniTranscript("AGENT: Hi\n\n USER: Hello\n\n AGENT: Bye")).toBe("AI Agent: Hi Caller: Hello AI Agent: Bye");
  });
});

describe("Vaani adapter: authentication (the docs describe no signature, so a secret in the URL)", () => {
  beforeEach(() => vi.stubEnv("VOICE_WEBHOOK_SECRET", "s3cret-key"));
  afterEach(() => vi.unstubAllEnvs());
  const a = createVaaniAdapter();
  it("accepts ?key=..., or the header; rejects everything else", () => {
    expect(a.verify(new Headers(), "", new URL("https://x/api/voice/webhook?key=s3cret-key"))).toBe(true);
    expect(a.verify(new Headers({ "x-webhook-secret": "s3cret-key" }), "", new URL("https://x/api/voice/webhook"))).toBe(true);
    expect(a.verify(new Headers(), "", new URL("https://x/api/voice/webhook?key=nope-nope!"))).toBe(false);
    expect(a.verify(new Headers(), "", new URL("https://x/api/voice/webhook"))).toBe(false);
    vi.stubEnv("VOICE_WEBHOOK_SECRET", "");
    expect(a.verify(new Headers(), "", new URL("https://x/api/voice/webhook?key="))).toBe(false);
  });
});

describe("Vaani adapter: enrich() from the call-history API", () => {
  beforeEach(() => { vi.stubEnv("VAANI_API_KEY", "k"); vi.stubEnv("VAANI_CREDIT_TO_INR", "2"); });
  afterEach(() => vi.unstubAllEnvs());
  const id = "inbound-1784899978-36cec598";
  const row = { call_id: id, call_type: "Inbound", direction: "Incoming", from_number: "+919999900123", to_number: "+911234567890", Start_time: "2026-10-09T09:10:55Z", End_time: "2026-10-09T09:16:01Z", user_picked_up_at: "2026-10-09T09:10:58Z", duration_ms: 306000, call_cost: 12.5 };

  it("fills caller number, real times and cost (credits x rate); sends the API key header", async () => {
    const f = fetchReturning(history([row]));
    const a = createVaaniAdapter(f);
    const e = await a.enrich!(a.parse(post())[0]);
    if (e.type !== "end_of_call_report") throw new Error();
    expect(e.report).toMatchObject({ callerPhone: "+919999900123", startedAt: "2026-10-09T09:10:55Z", answeredAt: "2026-10-09T09:10:58Z", durationSec: 306, providerCost: { amount: 25, currency: "INR" } });
    expect((f as unknown as { mock: { calls: Array<[string, { headers: Record<string, string> }]> } }).mock.calls[0][1].headers["X-API-Key"]).toBe("k");
  });
  it("looks on later pages when the call is not on the first", async () => {
    const a = createVaaniAdapter(fetchReturning(history([{ call_id: "other" }], true), history([row])));
    const e = await a.enrich!(a.parse(post())[0]);
    if (e.type !== "end_of_call_report") throw new Error();
    expect(e.report.callerPhone).toBe("+919999900123");
  });
  it("no cost is invented when VAANI_CREDIT_TO_INR is unset", async () => {
    vi.stubEnv("VAANI_CREDIT_TO_INR", "");
    const a = createVaaniAdapter(fetchReturning(history([row])));
    const e = await a.enrich!(a.parse(post())[0]);
    if (e.type !== "end_of_call_report") throw new Error();
    expect(e.report.providerCost).toBeNull();
  });
  it("never throws: API error, network failure, missing key or unknown call all return the event unchanged", async () => {
    const original = createVaaniAdapter().parse(post())[0];
    for (const f of [vi.fn(async () => new Response("no", { status: 500 })), vi.fn(async () => { throw new Error("offline"); }), fetchReturning(history([{ call_id: "x" }]))]) {
      expect(await createVaaniAdapter(f as unknown as typeof fetch).enrich!(original)).toEqual(original);
    }
    vi.stubEnv("VAANI_API_KEY", "");
    expect(await createVaaniAdapter().enrich!(original)).toEqual(original);
  });
});

describe("Vaani call through the whole pipeline", () => {
  it("duplicate webhooks do not call the vendor API again; the call is logged with the caller number", async () => {
    vi.stubEnv("VAANI_API_KEY", "k");
    const f = fetchReturning(history([{ call_id: "inbound-1784899978-36cec598", call_type: "Inbound", from_number: "+919999900124", Start_time: "2026-10-09T09:10:55Z", End_time: "2026-10-09T09:16:01Z", duration_ms: 306000 }]));
    const a = createVaaniAdapter(f);
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    const ev = a.parse(post());
    const r1 = await handleVoiceEvents(ev, "vaani", d, a.enrich!.bind(a));
    const r2 = await handleVoiceEvents(ev, "vaani", d, a.enrich!.bind(a));
    expect(r1[0]).toMatchObject({ status: "processed", outcome: "qualified", handoff: "new" });
    expect(r2[0].status).toBe("duplicate");
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ caller_phone: "+919999900124", provider: "vaani" });
    expect(notifier.sent).toHaveLength(1);
    vi.unstubAllEnvs();
  });
  it("other Vaani events are ignored without touching the database", async () => {
    const a = createVaaniAdapter();
    const { d, store } = deps({ llm: fakeLLM(cls()) });
    const r = await handleVoiceEvents(a.parse({ event: "call_started", room_name: "r", phone_number: "+91" }), "vaani", d);
    expect(r[0].status).toBe("ignored");
    expect(store.calls).toHaveLength(0);
  });
});

describe("price-rule safety net for vendor-spoken calls", () => {
  it("agentPriceLeaks finds price-like AGENT sentences only (not the caller's, not the approved line)", () => {
    const t = `AI Agent: Hello. Caller: How much does it cost? AI Agent: ${rules.approvedPriceLine} Caller: ok. AI Agent: Typically it is Rs 2000 per sq ft. Caller: I can pay 5 lakh.`;
    const leaks = agentPriceLeaks(t);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toContain("Rs 2000");
  });
  it("a call where the agent leaked a price is flagged and Nikhil is alerted straight away", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({ outcome: "other" })) });
    const r = await processCall({ transcript: "AI Agent: Hi. Caller: cost? AI Agent: It will be around Rs 20 lakh. Caller: ok", callerPhone: "9999900130", startedAt: "2026-10-09T09:11:00Z", provider: "vaani" }, d);
    expect(store.calls[0].flags).toContain("agent_price_leak");
    const alert = notifier.sent.find((n) => n.text.startsWith("PRICE RULE BREACH"));
    expect(alert?.chatId).toBe("NIKHIL");
    expect(alert?.text).toContain("Rs 20 lakh");
    expect(r.call.id).toBeTruthy();
  });
  it("a call where the agent promised a date is flagged agent_promise, without an alert (the exact slip seen in Vaani's own chat test)", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    await processCall({ transcript: "AI Agent: Hi. Caller: Tuesday and Thursday please. AI Agent: Noted, specifically the thirteen and fifteen of October. A designer will follow up.", callerPhone: "9999900132", startedAt: "2026-10-09T09:11:00Z", provider: "vaani" }, d);
    expect(store.calls[0].flags).toContain("agent_promise");
    expect(notifier.sent.some((n) => n.text.startsWith("PRICE RULE BREACH"))).toBe(false);
  });
  it("clean calls raise no breach alert", async () => {
    const { d, notifier } = deps({ llm: fakeLLM(cls({ outcome: "other" })) });
    await processCall({ transcript: `AI Agent: Hi. Caller: cost? AI Agent: ${rules.approvedPriceLine}`, callerPhone: "9999900131", startedAt: "2026-10-09T09:11:00Z" }, d);
    expect(notifier.sent.some((n) => n.text.startsWith("PRICE RULE BREACH"))).toBe(false);
  });
});

describe("generated Vaani agent prompt", () => {
  const p = buildVaaniPrompt(loadRules(), cfg);
  it("opens with the exact greeting and carries the approved price line verbatim", () => {
    expect(p).toContain(`"Hello, you've reached Aangan Studio. I'm an AI assistant`);
    expect(p).toContain(`"${rules.approvedPriceLine}"`);
  });
  it("never contains the internal pricing guide or any rupee figure", () => {
    expect(p).not.toContain("Standard specification");
    expect(p).not.toContain("Indicative range");
    expect(p).not.toMatch(/₹|\bRs\.?\s?\d|\d\s?lakh/i);
  });
  it("says the greeting is automatic and must not be repeated; requires the name; forbids dates and 'soon'", () => {
    expect(p).toMatch(/Never say it again/);
    expect(p).toMatch(/MUST have the caller's name/);
    expect(p).toMatch(/Never make up a time or a date yourself/);
    expect(p).toMatch(/Do not add "soon"/);
  });
  it("carries the studio's own rules (services, rubric, outcomes)", () => {
    expect(p).toContain("Pune city");
    expect(p).toContain("five criteria");
    expect(p).toContain("repeat_caller");
  });
});
