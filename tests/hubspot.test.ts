import { describe, expect, it, vi } from "vitest";
import { buildNoteHtml, createHubSpot, HubSpotError, toE164 } from "../src/lib/hubspot";
import { processCall, retryHubSpot, syncCallToHubSpot } from "../src/lib/pipeline";
import { getConfig } from "../src/lib/config";
import { cfg, cls, deps, fakeLLM } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Req = { url: string; method: string; headers: Record<string, string>; body: any };
/** Fake HubSpot: routes by method+path. */
function fakeHubSpot(handlers: Record<string, (b: any) => Response>) {
  const reqs: Req[] = [];
  const f = vi.fn(async (url: string, init: any) => {
    const path = new URL(url).pathname;
    reqs.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const h = handlers[`${init.method} ${path}`] ?? (Object.entries(handlers).find(([k]) => { const [m, p] = k.split(" "); return m === init.method && p.endsWith("*") && path.startsWith(p.slice(0, -1)); })?.[1]);
    if (!h) return json({ message: `no handler ${init.method} ${path}` }, 404);
    return h(init.body ? JSON.parse(init.body) : undefined);
  });
  return { f: f as unknown as typeof fetch, reqs };
}
const lead = { name: "Divya Bharti Sharma", phone: "+919999900001", locality: "Kothrud", callIso: "2026-10-09T09:11:00Z", noteHtml: "<b>n</b>" };

describe("toE164", () => {
  it.each([["9999900001", "+919999900001"], ["+91 99999 00001", "+919999900001"], ["09999900001", "+919999900001"], ["919999900001", "+919999900001"], ["", null]])("%s", (i, o) => expect(toE164(i)).toBe(o));
});

describe("HubSpot client", () => {
  it("new lead: searches by phone, creates the contact (lead/NEW), then a note linked to it", async () => {
    const { f, reqs } = fakeHubSpot({
      "POST /crm/v3/objects/contacts/search": () => json({ results: [] }),
      "POST /crm/v3/objects/contacts": () => json({ id: "501" }, 201),
      "POST /crm/v3/objects/notes": () => json({ id: "9001" }, 201),
    });
    const r = await createHubSpot("tok_123", false, f).syncLead(lead);
    expect(r).toEqual({ contactId: "501", noteId: "9001", dealId: undefined });
    expect(reqs[0].headers.Authorization).toBe("Bearer tok_123");
    expect(reqs[0].body.filterGroups[0].filters[0]).toEqual({ propertyName: "phone", operator: "EQ", value: "+919999900001" });
    expect(reqs[1].body.properties).toEqual({ firstname: "Divya", lastname: "Bharti Sharma", phone: "+919999900001", city: "Kothrud", lifecyclestage: "lead", hs_lead_status: "NEW" });
    expect(reqs[2].body).toEqual({ properties: { hs_timestamp: "2026-10-09T09:11:00.000Z", hs_note_body: "<b>n</b>" }, associations: [{ to: { id: "501" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] });
  });
  it("existing contact: updates it (never resets its lead status) and still adds a note", async () => {
    const { f, reqs } = fakeHubSpot({
      "POST /crm/v3/objects/contacts/search": () => json({ results: [{ id: "77" }] }),
      "PATCH /crm/v3/objects/contacts/77": () => json({ id: "77" }),
      "POST /crm/v3/objects/notes": () => json({ id: "9002" }, 201),
    });
    const r = await createHubSpot("t", false, f).syncLead(lead);
    expect(r.contactId).toBe("77");
    const patch = reqs.find((x) => x.method === "PATCH")!;
    expect(patch.body.properties).not.toHaveProperty("hs_lead_status");
    expect(patch.body.properties).not.toHaveProperty("lifecyclestage");
  });
  it("a known contact id skips the search entirely", async () => {
    const { f, reqs } = fakeHubSpot({ "PATCH /crm/v3/objects/contacts/55": () => json({}), "POST /crm/v3/objects/notes": () => json({ id: "1" }, 201) });
    await createHubSpot("t", false, f).syncLead({ ...lead, existingContactId: "55" });
    expect(reqs.some((r) => r.url.includes("/search"))).toBe(false);
  });
  it("if linking the note on creation is refused, creates it bare and links with the default-association endpoint", async () => {
    let calls = 0;
    const { f, reqs } = fakeHubSpot({
      "POST /crm/v3/objects/contacts/search": () => json({ results: [{ id: "77" }] }),
      "PATCH /crm/v3/objects/contacts/77": () => json({}),
      "POST /crm/v3/objects/notes": () => (calls++ === 0 ? json({ message: "bad association" }, 400) : json({ id: "9003" }, 201)),
      "PUT /crm/v4/objects/notes/9003/associations/default/contacts/77": () => json({}),
    });
    const r = await createHubSpot("t", false, f).syncLead(lead);
    expect(r.noteId).toBe("9003");
    expect(reqs.at(-1)).toMatchObject({ method: "PUT" });
    expect(reqs.at(-2)!.body).not.toHaveProperty("associations");
  });
  it("optional deal is created in the default pipeline and linked to the contact; a deal failure does not fail the sync", async () => {
    const h = { "POST /crm/v3/objects/contacts/search": () => json({ results: [{ id: "77" }] }), "PATCH /crm/v3/objects/contacts/77": () => json({}), "POST /crm/v3/objects/notes": () => json({ id: "1" }, 201) };
    const ok = fakeHubSpot({ ...h, "POST /crm/v3/objects/deals": () => json({ id: "D1" }, 201) });
    expect((await createHubSpot("t", true, ok.f).syncLead(lead)).dealId).toBe("D1");
    expect(ok.reqs.at(-1)!.body.properties).toMatchObject({ pipeline: "default", dealstage: "appointmentscheduled" });
    const bad = fakeHubSpot({ ...h, "POST /crm/v3/objects/deals": () => json({ message: "no stage" }, 400) });
    expect((await createHubSpot("t", true, bad.f).syncLead(lead)).dealId).toBeUndefined();
  });
  it("API errors become HubSpotError with the status; a network failure too", async () => {
    const e401 = createHubSpot("bad", false, fakeHubSpot({ "POST /crm/v3/objects/contacts/search": () => json({ message: "invalid token" }, 401) }).f).syncLead(lead);
    await expect(e401).rejects.toMatchObject({ status: 401 });
    await expect(e401).rejects.toBeInstanceOf(HubSpotError);
    await expect(createHubSpot("t", false, (async () => { throw new Error("offline"); }) as unknown as typeof fetch).syncLead(lead)).rejects.toMatchObject({ status: null });
  });
});

describe("note body", () => {
  const call = { id: "c1", flags: ["pricing_asked"], pricing_asked: true, started_at: "2026-10-09T09:11:00Z" };
  const l = { name: "Divya", fields: { locality: "Kothrud", project_type: "residential_full" as const, carpet_area_sqft: 1200, scope: "<script>x</script> kitchen", timeline: "by March", decision_maker: "owner", decision_maker_confirmed: true as const, referral_source: null, preferred_days: "Fridays" } };
  it("contains everything, escapes HTML, shows the booked slot when there is one", () => {
    const h = buildNoteHtml(call, l, { start_at: "2026-10-13T04:30:00.000Z" }, cfg);
    expect(h).toContain("Name: Divya");
    expect(h).toContain("Project: residential full, ~1200 sq ft carpet");
    expect(h).toContain("Decision-maker: owner (confirmed)");
    expect(h).toContain("Pricing asked: yes");
    expect(h).toContain("Consultation booked: Tuesday, 13 October at 10:00 am (phone or video call)");
    expect(h).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(h).not.toContain("<script>");
    expect(h).toContain("https://app.test/dashboard/calls/c1");
    expect(buildNoteHtml(call, l, null, cfg)).toContain("Preferred slots: Fridays");
  });
});

describe("HubSpot in the call pipeline", () => {
  const hs = (over: Partial<Record<string, () => Response>> = {}) => fakeHubSpot({
    "POST /crm/v3/objects/contacts/search": () => json({ results: [] }),
    "POST /crm/v3/objects/contacts": () => json({ id: "501" }, 201),
    "POST /crm/v3/objects/notes": () => json({ id: "9001" }, 201),
    "PATCH /crm/v3/objects/contacts/501": () => json({ id: "501" }),
    ...over,
  });
  const withHub = (client: ReturnType<typeof createHubSpot>, llm = fakeLLM(cls({}, { name: "Divya", locality: "Kothrud" }))) => deps({ llm, hubspot: client });
  const call = { transcript: "AI Agent: hi. Caller: 3BHK", callerPhone: "+919999900001", startedAt: "2026-10-09T09:11:00Z" };

  it("a qualified lead goes to HubSpot together with the Telegram note; ids are stored on the call and lead", async () => {
    const h = hs();
    const { d, store, notifier } = withHub(createHubSpot("t", false, h.f));
    const r = await processCall(call, d);
    expect(notifier.sent.some((n) => n.text.startsWith("NEW LEAD"))).toBe(true);
    expect(store.calls[0]).toMatchObject({ hubspot_contact_id: "501", hubspot_note_id: "9001", hubspot_error: null });
    expect(r.lead!.hubspot_contact_id).toBe("501");
    expect(h.reqs.some((x) => x.url.endsWith("/notes"))).toBe(true);
  });
  it("non-qualified calls (declined, vendor, escalation) are not sent to HubSpot", async () => {
    for (const outcome of ["not_a_fit", "other", "escalate", "dropped_or_missed"]) {
      const h = hs();
      const { d } = withHub(createHubSpot("t", false, h.f), fakeLLM(cls({ outcome })));
      await processCall({ ...call, callerPhone: `+9199999${outcome.length}0000` }, d);
      expect(h.reqs, outcome).toHaveLength(0);
    }
  });
  it("a HubSpot failure never breaks the call: the Telegram note still goes, the error is recorded for retry", async () => {
    const h = hs({ "POST /crm/v3/objects/contacts/search": () => json({ message: "down" }, 500) });
    const { d, store, notifier } = withHub(createHubSpot("t", false, h.f));
    const r = await processCall(call, d);
    expect(r.handoffKind).toBe("new");
    expect(notifier.sent).toHaveLength(1);
    expect(store.calls[0].hubspot_error).toMatch(/contact search failed \(500\)/);
    expect(store.calls[0].hubspot_note_id ?? null).toBeNull();
  });
  it("cron retry syncs the failed one once HubSpot is back, and never twice", async () => {
    let up = false;
    const h = hs({ "POST /crm/v3/objects/contacts/search": () => (up ? json({ results: [] }) : json({ message: "down" }, 500)) });
    const { d, store } = withHub(createHubSpot("t", false, h.f));
    await processCall(call, d);
    expect(await retryHubSpot(d)).toBe(0);
    up = true;
    expect(await retryHubSpot(d)).toBe(1);
    expect(store.calls[0]).toMatchObject({ hubspot_note_id: "9001", hubspot_error: null });
    expect(await retryHubSpot(d)).toBe(0);
  });
  it("no token configured: skipped silently", async () => {
    const { d, store } = deps({ llm: fakeLLM(cls()), hubspot: null });
    await processCall(call, d);
    expect(store.calls[0].hubspot_note_id ?? null).toBeNull();
    expect(await syncCallToHubSpot(store.calls[0], null, { store, cfg, hubspot: null })).toBe("skipped");
  });
  it("a repeat caller is matched to the same HubSpot contact (no search, no duplicate contact)", async () => {
    const h = hs();
    const { d } = deps({ llm: fakeLLM(cls({}, { name: "Divya" }), cls({ outcome: "repeat_caller", underlying_outcome: "qualified" }, { name: "Divya" })), hubspot: createHubSpot("t", false, h.f) });
    await processCall(call, d);
    await processCall({ ...call, startedAt: "2026-10-10T09:11:00Z" }, d);
    expect(h.reqs.filter((x) => x.url.includes("/search"))).toHaveLength(1);
    expect(h.reqs.filter((x) => x.method === "POST" && x.url.endsWith("/contacts"))).toHaveLength(1);
    expect(h.reqs.filter((x) => x.url.endsWith("/notes"))).toHaveLength(2);
  });
});
