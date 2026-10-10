import { describe, expect, it } from "vitest";
import { handleTelegramUpdate, sendHandoff } from "../src/lib/handoff";
import { MemoryStore } from "../src/lib/store";
import { fakeNotifier } from "./helpers";

async function setup(kind: "new" | "escalation" = "new") {
  const store = new MemoryStore();
  const notifier = fakeNotifier();
  const lead = await store.saveLead({ phone_normalized: "9999900020", name: "X", fields: {}, status: "qualified", flags: [], call_count: 1, first_call_at: null, last_call_at: null });
  const h = await sendHandoff({ store, notifier }, { text: "note", chatId: "-1", kind, leadId: lead.id, callId: "c1", dueAt: new Date("2026-09-03T10:00:00Z") });
  const reply = (text: string, name = "Aryan") => ({ message: { message_id: 50, text, chat: { id: -1 }, from: { id: 1, first_name: name }, reply_to_message: { message_id: h.telegram_message_id! } } });
  return { store, notifier, lead, h, reply, now: () => new Date("2026-09-03T11:00:00Z") };
}

describe("designer reply conventions (feed the dashboard)", () => {
  it("'called' records first contact and also claims an unclaimed lead", async () => {
    const s = await setup();
    const r = await handleTelegramUpdate(s.reply("called her, she is keen"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(r).toMatchObject({ action: "claimed" });
    expect(s.store.handoffs[0]).toMatchObject({ claimed_by: "Aryan", first_contact_at: "2026-09-03T11:00:00.000Z" });
  });
  it("claim and a later contact are recorded separately; first_contact is set once", async () => {
    const s = await setup();
    await handleTelegramUpdate(s.reply("taking it"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(s.store.handoffs[0].first_contact_at ?? null).toBeNull();
    const r = await handleTelegramUpdate(s.reply("spoke to them"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(r).toMatchObject({ action: "recorded", recorded: ["first_contact"] });
    await handleTelegramUpdate(s.reply("called again"), { store: s.store, notifier: () => undefined as never, now: () => new Date("2026-09-03T15:00:00Z") } as never).catch(() => undefined);
    expect(s.store.handoffs[0].first_contact_at).toBe("2026-09-03T11:00:00.000Z");
  });
  it("fit verdicts, consultation and signed project update the handoff and the lead", async () => {
    const s = await setup();
    await handleTelegramUpdate(s.reply("taking it"), { store: s.store, notifier: s.notifier, now: s.now });
    await handleTelegramUpdate(s.reply("good fit, consultation booked"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(s.store.handoffs[0].fit_verdict).toBe("good");
    expect((await s.store.getLead(s.lead.id))!.consultation_at).toBe("2026-09-03T11:00:00.000Z");
    await handleTelegramUpdate(s.reply("poor fit"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(s.store.handoffs[0].fit_verdict).toBe("poor");
    await handleTelegramUpdate(s.reply("signed!"), { store: s.store, notifier: s.notifier, now: s.now });
    expect((await s.store.getLead(s.lead.id))!.project_signed_at).toBeTruthy();
  });
  it("on an escalation message, 'called back' records the callback time and nothing claims it", async () => {
    const s = await setup("escalation");
    const r = await handleTelegramUpdate(s.reply("called back, sorted"), { store: s.store, notifier: s.notifier, now: s.now });
    expect(r).toMatchObject({ action: "recorded", recorded: ["callback_made"] });
    expect(s.store.handoffs[0].claimed_at).toBeNull();
    expect(s.store.handoffs[0].first_contact_at).toBe("2026-09-03T11:00:00.000Z");
  });
  it("ordinary chatter in the thread is still ignored", async () => {
    const s = await setup();
    expect((await handleTelegramUpdate(s.reply("what is the address?"), { store: s.store, notifier: s.notifier, now: s.now })).action).toBe("ignored");
  });
});
