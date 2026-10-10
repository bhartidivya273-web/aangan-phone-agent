import { describe, expect, it } from "vitest";
import {
  alertUnclaimed, buildEscalationAlert, buildHandoffNote, firstContactDue, handleTelegramUpdate,
  REQUIRED_NOTE_LABELS, retryFailedHandoffs, sendHandoff,
} from "../src/lib/handoff";
import { MemoryStore } from "../src/lib/store";
import { cfg, fakeNotifier } from "./helpers";
import type { CallRow } from "../src/lib/types";

const lead = {
  call_count: 1,
  first_call_at: "2026-09-03T09:11:00Z",
  fields: { name: "Priya", locality: "Kothrud", project_type: "residential_full" as const, scope: "kitchen, living room", carpet_area_sqft: 1400, timeline: "by March", decision_maker: "owner", decision_maker_confirmed: true, referral_source: "Shruti Joshi", preferred_days: null },
};
const rec = { callTime: "2026-09-03T09:11:00Z", lead, callerPhone: "+919000000001", flags: ["timeline_tight"], pricingAsked: true, isUpdate: false, callId: "c1" };

describe("buildHandoffNote", () => {
  it("follows the spec format with every required field", () => {
    const note = buildHandoffNote(rec, cfg);
    for (const label of REQUIRED_NOTE_LABELS) expect(note).toContain(label);
    expect(note.split("\n")[0]).toBe("NEW LEAD - call 3 Sep 2026, 2:41pm");
    expect(note).toContain("Priya, +919000000001");
    expect(note).toContain("Kothrud, full home, ~1400 sq ft carpet");
    expect(note).toContain("Decision-maker: owner (confirmed)");
    expect(note).toContain("Pricing asked: yes");
    expect(note).toContain("Flags: timeline_tight");
    expect(note).toContain("Preferred slots: not given");
    expect(note).toContain("Call summary: https://app.test/dashboard/calls/c1");
  });
  it("says 'none' when there are no flags and marks unconfirmed decision-makers", () => {
    const n = buildHandoffNote({ ...rec, flags: [], pricingAsked: false, lead: { ...lead, fields: { ...lead.fields, decision_maker: "parents", decision_maker_confirmed: false } } }, cfg);
    expect(n).toContain("Flags: none");
    expect(n).toContain("Decision-maker: parents (not confirmed)");
    expect(n).toContain("Pricing asked: no");
  });
  it("an updated note is labelled as such and replaces the earlier one", () => {
    const n = buildHandoffNote({ ...rec, isUpdate: true, lead: { ...lead, call_count: 2 } }, cfg);
    expect(n.startsWith("UPDATED LEAD")).toBe(true);
    expect(n).toContain("This replaces the earlier note");
  });
  it("never contains a price figure", async () => {
    const { findPriceLeaks } = await import("../src/lib/priceFilter");
    expect(findPriceLeaks(buildHandoffNote(rec, cfg))).toEqual([]);
  });
});

describe("first-contact target (proposed: 1h in office hours, else 10:30am next office day)", () => {
  it("1 hour inside office hours", () => {
    expect(firstContactDue(new Date("2026-09-03T09:11:00Z"), cfg).toISOString()).toBe("2026-09-03T10:11:00.000Z");
  });
  it("after hours -> 10:30am IST next office day", () => {
    // Thu 10:47pm IST -> Fri 10:30am IST = 05:00Z
    expect(firstContactDue(new Date("2026-09-03T17:17:00Z"), cfg).toISOString()).toBe("2026-09-04T05:00:00.000Z");
  });
  it("an hour that would run past closing rolls to next morning", () => {
    // Thu 6:30pm IST (13:00Z) +1h = 7:30pm > close
    expect(firstContactDue(new Date("2026-09-03T13:00:00Z"), cfg).toISOString()).toBe("2026-09-04T05:00:00.000Z");
  });
  it("Saturday evening skips Sunday to Monday 10:30am", () => {
    // Sat 7 Sep... 2026-09-05 is Saturday; 8pm IST = 14:30Z -> Mon 7 Sep 10:30 IST = 05:00Z
    expect(firstContactDue(new Date("2026-09-05T14:30:00Z"), cfg).toISOString()).toBe("2026-09-07T05:00:00.000Z");
  });
});

describe("sendHandoff", () => {
  it("posts via the notifier and records message id and due time", async () => {
    const store = new MemoryStore();
    const notifier = fakeNotifier();
    const h = await sendHandoff({ store, notifier }, { text: "hi", chatId: "DESIGNERS", kind: "new", leadId: "l1", callId: "c1", dueAt: new Date("2026-09-03T10:11:00Z") });
    expect(h.status).toBe("sent");
    expect(h.telegram_message_id).toBe(101);
    expect(h.due_at).toBe("2026-09-03T10:11:00.000Z");
  });
  it("retries transient Telegram errors", async () => {
    const store = new MemoryStore();
    const h = await sendHandoff({ store, notifier: fakeNotifier({ failTimes: 2 }), sleep: async () => {} }, { text: "hi", chatId: "D", kind: "new", leadId: null, callId: null });
    expect(h.status).toBe("sent");
  });
  it("stores a failed row instead of throwing, and cron retry re-sends it", async () => {
    const store = new MemoryStore();
    const h = await sendHandoff({ store, notifier: fakeNotifier({ failTimes: 99 }), sleep: async () => {} }, { text: "hi", chatId: "D", kind: "new", leadId: null, callId: null });
    expect(h.status).toBe("failed");
    const ok = await retryFailedHandoffs({ store, notifier: fakeNotifier(), sleep: async () => {} });
    expect(ok).toBe(1);
    expect(store.handoffs[0].status).toBe("sent");
  });
});

describe("claim by reply", () => {
  async function setup() {
    const store = new MemoryStore();
    const notifier = fakeNotifier();
    const h = await sendHandoff({ store, notifier }, { text: "note", chatId: "-1001", kind: "new", leadId: "l1", callId: "c1", dueAt: new Date("2026-09-03T10:11:00Z") });
    return { store, notifier, h };
  }
  const reply = (id: number, text: string, name = "Aryan") => ({
    message: { message_id: 900, text, chat: { id: -1001 }, from: { id: 5, first_name: name }, reply_to_message: { message_id: id } },
  });

  it("'taking it' as a reply claims the lead and confirms", async () => {
    const { store, notifier, h } = await setup();
    const r = await handleTelegramUpdate(reply(h.telegram_message_id!, "taking it"), { store, notifier });
    expect(r).toMatchObject({ action: "claimed", by: "Aryan" });
    expect(store.handoffs[0].claimed_by).toBe("Aryan");
    expect(notifier.sent.at(-1)!.text).toContain("Claimed by Aryan");
  });
  it("first claim wins; a second says already claimed", async () => {
    const { store, notifier, h } = await setup();
    await handleTelegramUpdate(reply(h.telegram_message_id!, "taking it"), { store, notifier });
    const r = await handleTelegramUpdate(reply(h.telegram_message_id!, "mine", "Meera"), { store, notifier });
    expect(r).toMatchObject({ action: "already_claimed", by: "Aryan" });
  });
  it("ignores non-replies, chatter, and replies to other messages", async () => {
    const { store, notifier, h } = await setup();
    expect((await handleTelegramUpdate({ message: { message_id: 1, text: "taking it", chat: { id: -1001 } } }, { store, notifier })).action).toBe("ignored");
    expect((await handleTelegramUpdate(reply(h.telegram_message_id!, "what is the address?"), { store, notifier })).action).toBe("ignored");
    expect((await handleTelegramUpdate(reply(555, "taking it"), { store, notifier })).action).toBe("ignored");
    expect(store.handoffs[0].claimed_at).toBeNull();
  });
});

describe("unclaimed-lead alert to Nikhil", () => {
  it("alerts once when past the target and unclaimed; never when claimed", async () => {
    const store = new MemoryStore();
    const notifier = fakeNotifier();
    const a = await sendHandoff({ store, notifier }, { text: "NEW LEAD - x\nPriya, 1\nKothrud", chatId: "D", kind: "new", leadId: "l1", callId: "c1", dueAt: new Date("2026-09-03T10:11:00Z") });
    const b = await sendHandoff({ store, notifier }, { text: "NEW LEAD - y", chatId: "D", kind: "new", leadId: "l2", callId: "c2", dueAt: new Date("2026-09-03T10:11:00Z") });
    await store.claimHandoff(b.id, "Aryan", "2026-09-03T09:30:00Z");

    const early = await alertUnclaimed({ store, notifier, nikhilChatId: "NIKHIL", cfg, now: () => new Date("2026-09-03T10:00:00Z") });
    expect(early).toBe(0);
    const late = await alertUnclaimed({ store, notifier, nikhilChatId: "NIKHIL", cfg, now: () => new Date("2026-09-03T10:30:00Z") });
    expect(late).toBe(1);
    expect(notifier.sent.at(-1)).toMatchObject({ chatId: "NIKHIL" });
    expect(notifier.sent.at(-1)!.text).toContain("UNCLAIMED LEAD");
    const again = await alertUnclaimed({ store, notifier, nikhilChatId: "NIKHIL", cfg, now: () => new Date("2026-09-03T11:30:00Z") });
    expect(again).toBe(0);
    expect(a.id).toBeTruthy();
  });
});

describe("escalation alert", () => {
  it("names the caller, reason and callback target; says it is not a lead", () => {
    const call = { id: "c9", reason: "Complaint: designer unresponsive for five days", caller_phone: "+919000000009", started_at: "2026-09-10T06:02:00Z", extracted: { name: "Sheetal Deshpande", locality: "Viman Nagar" } } as unknown as CallRow;
    const { text, due } = buildEscalationAlert(call, cfg);
    expect(text).toContain("ESCALATION");
    expect(text).toContain("Sheetal Deshpande");
    expect(text).toContain("Not a lead");
    expect(text).not.toContain("Caller was told");
    expect(due.toISOString()).toBe("2026-09-10T06:17:00.000Z"); // +15 min in office hours
  });
});
