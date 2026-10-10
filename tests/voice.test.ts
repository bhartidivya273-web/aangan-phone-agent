import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAdapter } from "../src/lib/voice/stub";
import { getAdapter } from "../src/lib/voice/registry";
import { handleVoiceEvents, transcriptText } from "../src/lib/voice/webhook";
import { cls, deps, fakeLLM } from "./helpers";

const report = (over: Record<string, unknown> = {}) => ({
  type: "end_of_call_report", providerCallId: "p-1", callerPhone: "+919999900001", startedAt: "2026-09-03T09:11:00Z", endedAt: "2026-09-03T09:16:00Z",
  transcript: "AI Agent: Hello. Caller: I want to redo my 3BHK in Kothrud.", providerCost: { amount: 4.2, currency: "INR" }, ...over,
});

describe("stub adapter", () => {
  beforeEach(() => vi.stubEnv("VOICE_WEBHOOK_SECRET", "s3cret"));
  afterEach(() => vi.unstubAllEnvs());

  it("authenticates with the shared secret and fails closed", () => {
    expect(stubAdapter.verify(new Headers({ "x-webhook-secret": "s3cret" }), "")).toBe(true);
    expect(stubAdapter.verify(new Headers({ "x-webhook-secret": "wrong!" }), "")).toBe(false);
    expect(stubAdapter.verify(new Headers(), "")).toBe(false);
    vi.stubEnv("VOICE_WEBHOOK_SECRET", "");
    expect(stubAdapter.verify(new Headers({ "x-webhook-secret": "" }), "")).toBe(false);
  });
  it("parses a single report, a call-log row and a batch", () => {
    expect(stubAdapter.parse(report())[0]).toMatchObject({ type: "end_of_call_report", report: { providerCallId: "p-1" } });
    expect(stubAdapter.parse({ type: "call_log", providerCallId: "p-2", startedAt: "2026-09-03T09:11:00Z", answeredBy: "front_desk" })[0].type).toBe("call_log");
    expect(stubAdapter.parse({ events: [report(), report({ providerCallId: "p-3" })] })).toHaveLength(2);
  });
  it("rejects malformed payloads", () => {
    expect(() => stubAdapter.parse({ type: "end_of_call_report" })).toThrow();
    expect(() => stubAdapter.parse(report({ startedAt: "not a date" }))).toThrow();
    expect(() => stubAdapter.parse({ events: [] })).toThrow();
  });
  it("registry returns the stub by default and refuses unknown providers", () => {
    expect(getAdapter().name).toBe("stub");
    expect(() => getAdapter("nope")).toThrow(/Unknown VOICE_PROVIDER/);
  });
});

describe("handleVoiceEvents", () => {
  it("end-of-call report: classifies, writes the log with provider id and cost, sends the designer note", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    const [r] = await handleVoiceEvents(stubAdapter.parse(report()), "stub", d);
    expect(r).toMatchObject({ status: "processed", outcome: "qualified", handoff: "new" });
    expect(store.calls[0]).toMatchObject({ provider: "stub", provider_call_id: "p-1", source: "ai" });
    expect(store.costs.map((c) => c.kind).sort()).toEqual(["llm_classifier", "telephony", "voice"]);
    expect(notifier.sent).toHaveLength(1);
  });

  it("is idempotent: a retried webhook does not duplicate the call, lead or note", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    await handleVoiceEvents(stubAdapter.parse(report()), "stub", d);
    const [again] = await handleVoiceEvents(stubAdapter.parse(report()), "stub", d);
    expect(again.status).toBe("duplicate");
    expect(store.calls).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("empty transcript or unanswered: logged as dropped_or_missed WITHOUT calling the classifier", async () => {
    const llm = fakeLLM(cls());
    const { d, store } = deps({ llm });
    await handleVoiceEvents(stubAdapter.parse({ events: [report({ providerCallId: "a", transcript: "" }), report({ providerCallId: "b", answeredBy: "none", transcript: "x" })] }), "stub", d);
    expect(llm.calls).toBe(0);
    expect(store.calls.map((c) => c.outcome)).toEqual(["dropped_or_missed", "dropped_or_missed"]);
    expect(store.calls[1].answered_at).toBeNull();
  });

  it("FR19: a front-desk-answered call from the telephony log appears in the log, no classifier, no lead, no note", async () => {
    const llm = fakeLLM(cls());
    const { d, store, notifier } = deps({ llm });
    const [r] = await handleVoiceEvents(stubAdapter.parse({ type: "call_log", providerCallId: "fd-1", callerPhone: "9999900002", startedAt: "2026-09-03T05:00:00Z", answeredAt: "2026-09-03T05:00:20Z", durationSec: 200, answeredBy: "front_desk", providerCost: { amount: 1.1, currency: "INR" } }), "stub", d);
    expect(r.status).toBe("logged");
    expect(llm.calls).toBe(0);
    expect(store.calls[0]).toMatchObject({ source: "front_desk", classification_status: "pending", outcome: null, answered_at: "2026-09-03T05:00:20Z" });
    expect(store.leads.size).toBe(0);
    expect(notifier.sent).toHaveLength(0);
    expect(store.costs[0]).toMatchObject({ kind: "telephony", amount: 1.1 });
  });

  it("a front-desk call that arrives with a transcript is classified but raises no designer note", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    await handleVoiceEvents(stubAdapter.parse(report({ providerCallId: "fd-2", answeredBy: "front_desk" })), "stub", d);
    expect(store.calls[0]).toMatchObject({ source: "front_desk", outcome: "qualified" });
    expect(notifier.sent).toHaveLength(0);
  });

  it("an unanswered call in the telephony log is recorded as missed", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls()) });
    await handleVoiceEvents(stubAdapter.parse({ type: "call_log", providerCallId: "m-1", callerPhone: "9999900003", startedAt: "2026-09-03T17:17:00Z", answeredBy: "none" }), "stub", d);
    expect(store.calls[0]).toMatchObject({ outcome: "dropped_or_missed", answered_at: null });
  });

  it("the same call as a report and then a call-log row is recorded once", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls()) });
    await handleVoiceEvents(stubAdapter.parse(report()), "stub", d);
    const [r] = await handleVoiceEvents(stubAdapter.parse({ type: "call_log", providerCallId: "p-1", startedAt: "2026-09-03T09:11:00Z", answeredBy: "ai" }), "stub", d);
    expect(r.status).toBe("duplicate");
    expect(store.calls).toHaveLength(1);
  });

  it("one bad event does not stop the rest of a batch", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls()) });
    const store2 = store;
    store2.insertCall = async () => { throw new Error("db down"); };
    const res = await handleVoiceEvents(stubAdapter.parse({ events: [report({ providerCallId: "e1" }), report({ providerCallId: "e2" })] }), "stub", d);
    expect(res.map((x) => x.status)).toEqual(["error", "error"]);
  });

  it("normalises speaker turns into the transcript format", () => {
    expect(transcriptText([{ speaker: "assistant", text: "Hello" }, { speaker: "user", text: "Hi" }, { speaker: "agent", text: " " }])).toBe("AI Agent: Hello Caller: Hi");
  });
});
