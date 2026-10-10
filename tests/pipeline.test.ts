import { describe, expect, it } from "vitest";
import { processCall } from "../src/lib/pipeline";
import { cls, deps, fakeLLM } from "./helpers";

const T = (iso: string) => ({ startedAt: iso, durationSec: 240 });

describe("processCall: qualified lead", () => {
  it("logs the call, creates the lead, sends ONE designer note with a due time, writes costs", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({ pricing_asked: true, flags: ["pricing_asked"] })) });
    const r = await processCall({ transcript: "t", callerPhone: "+91 90000 00001", ...T("2026-09-03T09:11:00Z") }, d);
    expect(r.handoffKind).toBe("new");
    expect(store.calls).toHaveLength(1);
    expect(store.leads.size).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].chatId).toBe("DESIGNERS");
    expect(notifier.sent[0].text).toContain("Pricing asked: yes");
    expect(store.handoffs[0].due_at).toBe("2026-09-03T10:00:00.000Z"); // now() is 09:00Z fixture + 1h
    const kinds = store.costs.map((c) => c.kind);
    expect(kinds).toContain("llm_classifier");
    expect(kinds).toContain("voice");
  });
});

describe("processCall: repeat caller (T16/T17) merges into one record and one updated note", () => {
  it("same caller ID twice -> one lead, two calls, second note is UPDATED and replies to the first", async () => {
    const llm = fakeLLM(cls({ outcome: "dropped_or_missed", reason: "line dropped" }, { name: null, locality: null, project_type: null, scope: null, carpet_area_sqft: null, timeline: null, timeline_weeks_from_call: null, decision_maker: null, decision_maker_confirmed: null }), cls({ flags: ["first_call_dropped"] }, { name: "Ritu Kapoor", locality: "Pimple Saudagar", carpet_area_sqft: 1050 }));
    const { d, store, notifier } = deps({ llm });
    const first = await processCall({ transcript: "dropped", callerPhone: "9000000017", ...T("2026-09-22T08:44:00Z") }, d);
    expect(first.handoffKind).toBeNull(); // a dropped call has no note
    const second = await processCall({ transcript: "full call", callerPhone: "+919000000017", ...T("2026-09-22T08:46:00Z") }, d);
    expect(store.leads.size).toBe(1);
    expect(store.calls).toHaveLength(2);
    expect(store.calls[1].lead_id).toBe(store.calls[0].lead_id);
    expect(second.lead!.call_count).toBe(2);
    expect(second.lead!.flags).toContain("first_call_dropped");
    expect(second.handoffKind).toBe("new"); // first real note for this lead
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].text).toContain("Ritu Kapoor");
    expect(notifier.sent[0].text).toContain("repeat_caller");
  });

  it("a later call after a note exists sends ONE updated note, threaded to the first, and supersedes its unclaimed alert", async () => {
    const llm = fakeLLM(cls({}, { name: "Girish Nair", locality: "Viman Nagar" }), cls({ outcome: "repeat_caller", underlying_outcome: "qualified", flags: ["handle_with_care"] }, { name: "Girish Nair", locality: null, preferred_days: "weekday evenings" }));
    const { d, store, notifier } = deps({ llm });
    await processCall({ transcript: "monday", callerPhone: "9000000016", ...T("2026-09-14T09:00:00Z") }, d);
    const r = await processCall({ transcript: "friday", callerPhone: "9000000016", ...T("2026-09-19T05:08:00Z") }, d);
    expect(r.handoffKind).toBe("updated");
    expect(store.leads.size).toBe(1);
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1].text.startsWith("UPDATED LEAD")).toBe(true);
    expect(notifier.sent[1].replyToMessageId).toBe(101);
    expect(notifier.sent[1].text).toContain("weekday evenings");
    expect(notifier.sent[1].text).toContain("Viman Nagar"); // earlier info kept (merge never erases)
    expect(store.handoffs[0].due_at).toBeNull(); // old note's alert superseded
    expect(store.handoffs[1].due_at).not.toBeNull();
  });
});

describe("processCall: a complaint from a caller who already has a lead note (T16 variant)", () => {
  const script = () => fakeLLM(cls({}, { name: "Girish Nair", locality: "Viman Nagar" }), cls({ outcome: "repeat_caller", underlying_outcome: "escalate", flags: ["complaint", "handle_with_care"] }, { name: "Girish Nair", locality: null }));
  it("by default alerts Nikhil AND sends the updated lead note to designers", async () => {
    const { d, store, notifier } = deps({ llm: script() });
    await processCall({ transcript: "monday", callerPhone: "9000000050", ...T("2026-09-14T09:00:00Z") }, d);
    const r = await processCall({ transcript: "angry", callerPhone: "9000000050", ...T("2026-09-19T05:08:00Z") }, d);
    expect(r.handoffKind).toBe("escalation");
    expect(notifier.sent.map((n) => n.chatId)).toEqual(["DESIGNERS", "DESIGNERS", "NIKHIL"]);
    expect(notifier.sent[1].text.startsWith("UPDATED LEAD")).toBe(true);
    expect(store.leads.size).toBe(1);
  });
  it("ESCALATED_REPEAT_ALSO_NOTES=false alerts Nikhil only", async () => {
    const { getConfig } = await import("../src/lib/config");
    const c = { ...getConfig({ MODEL_CLASSIFIER: "fake-model", ESCALATED_REPEAT_ALSO_NOTES: "false" }) };
    const { d, notifier } = deps({ llm: script(), cfg: c });
    await processCall({ transcript: "monday", callerPhone: "9000000051", ...T("2026-09-14T09:00:00Z") }, d);
    await processCall({ transcript: "angry", callerPhone: "9000000051", ...T("2026-09-19T05:08:00Z") }, d);
    expect(notifier.sent.map((n) => n.chatId)).toEqual(["DESIGNERS", "NIKHIL"]);
  });
  it("a first-time complaint with no lead note still sends Nikhil the alert only (T09)", async () => {
    const { d, notifier } = deps({ llm: fakeLLM(cls({ outcome: "escalate", flags: ["complaint"] })) });
    await processCall({ transcript: "c", callerPhone: "9000000052", ...T("2026-09-10T06:02:00Z") }, d);
    expect(notifier.sent.map((n) => n.chatId)).toEqual(["NIKHIL"]);
  });
});

describe("processCall: no lead note for non-leads; calls always retained", () => {
  it("not_a_fit: logged with reason, no handoff", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({ outcome: "not_a_fit", reason: "Nashik is outside the service area", flags: ["outside_area"] })) });
    const r = await processCall({ transcript: "t", callerPhone: "9000000003", ...T("2026-09-03T10:45:00Z") }, d);
    expect(r.handoffKind).toBeNull();
    expect(notifier.sent).toHaveLength(0);
    expect(store.calls[0]).toMatchObject({ outcome: "not_a_fit", reason: "Nashik is outside the service area" });
    expect(store.leads.values().next().value!.status).toBe("declined");
  });

  it("escalate (T09): alerts Nikhil with a callback target, sends NO lead note", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({ outcome: "escalate", reason: "Complaint: designer unresponsive", flags: ["complaint"] }, { name: "Sheetal Deshpande" })) });
    const r = await processCall({ transcript: "t", callerPhone: "9000000009", ...T("2026-09-10T06:02:00Z") }, d);
    expect(r.handoffKind).toBe("escalation");
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].chatId).toBe("NIKHIL");
    expect(notifier.sent[0].text).toContain("ESCALATION");
    expect(notifier.sent.some((s) => s.text.includes("NEW LEAD"))).toBe(false);
    expect(store.leads.values().next().value!.status).toBe("escalated");
    expect(store.handoffs[0].kind).toBe("escalation");
  });

  it("other/vendor: logged, message kept, no note", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({ outcome: "other", reason: "Vendor" }, { message_for_team: "Tile vendor wants a callback" })) });
    await processCall({ transcript: "t", callerPhone: "9000000030", ...T("2026-09-03T10:45:00Z") }, d);
    expect(notifier.sent).toHaveLength(0);
    expect(store.calls[0].extracted.message_for_team).toContain("callback");
  });

  it("a qualified lead is not downgraded by a later vendor-type call on the same number", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls(), cls({ outcome: "other" })) });
    await processCall({ transcript: "a", callerPhone: "9000000031", ...T("2026-09-03T10:45:00Z") }, d);
    await processCall({ transcript: "b", callerPhone: "9000000031", ...T("2026-09-04T10:45:00Z") }, d);
    expect(store.leads.values().next().value!.status).toBe("qualified");
  });
});

describe("processCall: robustness", () => {
  it("classifier failure still logs the call (with the error) and alerts Nikhil; nothing is lost", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM("garbage") });
    const r = await processCall({ transcript: "important transcript", callerPhone: "9000000040", ...T("2026-09-03T10:45:00Z") }, d);
    expect(r.classification).toBeNull();
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ classification_status: "failed", transcript: "important transcript" });
    expect(notifier.sent[0].chatId).toBe("NIKHIL");
    expect(notifier.sent[0].text).toContain("CLASSIFICATION FAILED");
  });

  it("Telegram down: call and lead are still logged, handoff stored as failed for retry", async () => {
    const { fakeNotifier } = await import("./helpers");
    const { d, store } = deps({ llm: fakeLLM(cls()), notifier: fakeNotifier({ failTimes: 99 }) });
    const r = await processCall({ transcript: "t", callerPhone: "9000000041", ...T("2026-09-03T10:45:00Z") }, d);
    expect(r.call.id).toBeTruthy();
    expect(store.handoffs[0].status).toBe("failed");
  });

  it("every call writes cost rows, including calls with no caller ID", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls({ outcome: "dropped_or_missed" })) });
    const r = await processCall({ transcript: "missed", callerPhone: null, ...T("2026-09-03T10:45:00Z") }, d);
    expect(r.lead).toBeNull();
    expect(store.costs.filter((c) => c.call_id === r.call.id).length).toBeGreaterThan(0);
  });

  it("front-desk calls can be logged without a handoff (FR19 groundwork)", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls()) });
    await processCall({ transcript: "t", callerPhone: "9000000042", source: "front_desk", handoff: false, ...T("2026-09-03T10:45:00Z") }, d);
    expect(store.calls[0].source).toBe("front_desk");
    expect(notifier.sent).toHaveLength(0);
  });
});

describe("processCall: qualified call whose caller number is unknown (e.g. the voice provider lookup failed)", () => {
  it("still creates a lead and sends the designer note (phone shown as not given); nothing is lost", async () => {
    const { d, store, notifier } = deps({ llm: fakeLLM(cls({}, { name: "Anita", phone: null })) });
    const r = await processCall({ transcript: "AI Agent: hi. Caller: 3BHK Kothrud", callerPhone: null, ...T("2026-09-03T09:11:00Z") }, d);
    expect(r.handoffKind).toBe("new");
    expect(r.lead).not.toBeNull();
    expect(r.lead!.phone_normalized).toBeNull();
    expect(notifier.sent[0].text).toContain("Anita, not given");
    expect(store.calls[0].lead_id).toBe(r.lead!.id);
  });
  it("non-qualified calls without a number still create no lead (nothing to merge on)", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls({ outcome: "other" })) });
    const r = await processCall({ transcript: "vendor", callerPhone: null, ...T("2026-09-03T09:11:00Z") }, d);
    expect(r.lead).toBeNull();
    expect(store.leads.size).toBe(0);
  });
  it("two unknown-number qualified calls are two separate leads (they are never merged by accident)", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls({}, { name: "A" }), cls({}, { name: "B" })) });
    await processCall({ transcript: "a", callerPhone: null, ...T("2026-09-03T09:11:00Z") }, d);
    await processCall({ transcript: "b", callerPhone: null, ...T("2026-09-03T10:11:00Z") }, d);
    expect(store.leads.size).toBe(2);
  });
});
