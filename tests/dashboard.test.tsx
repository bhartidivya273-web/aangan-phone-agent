import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../src/app/dashboard/DashboardView";
import { getConfig } from "../src/lib/config";
import { getDashboardSource } from "../src/lib/dashboardSource";
import { DEMO_PHONE_PREFIX, generateDemoData } from "../src/lib/demo";
import { computeDashboard, median, percentile } from "../src/lib/metrics";
import type { CallRow, DashboardData, HandoffRow } from "../src/lib/types";

const NOW = new Date("2026-10-09T10:00:00Z");
const cfg = getConfig({ USD_TO_INR: "85", PRICE_VOICE_PER_MIN_INR: "7" });

describe("demo data", () => {
  const d = generateDemoData(NOW, cfg);
  it("is deterministic, synthetic and sized like a month of enquiries", () => {
    expect(generateDemoData(NOW, cfg).calls.map((c) => c.started_at)).toEqual(d.calls.map((c) => c.started_at));
    expect(d.calls.length).toBeGreaterThan(150);
    expect(d.calls.every((c) => c.provider === "demo" && c.caller_phone_normalized!.startsWith(DEMO_PHONE_PREFIX))).toBe(true);
    expect(d.calls.every((c) => new Date(c.started_at) <= NOW)).toBe(true);
  });
  it("every call has at least one cost row (acceptance 6)", () => {
    const costed = new Set(d.costs.map((c) => c.call_id));
    expect(d.calls.every((c) => costed.has(c.id))).toBe(true);
  });
  it("synthetic unclaimed leads are pre-marked as alerted so the unclaimed-lead cron can never message Nikhil about them", () => {
    const unclaimed = d.handoffs.filter((h) => !h.claimed_at);
    expect(unclaimed.length).toBeGreaterThan(0);
    expect(unclaimed.every((h) => !!h.unclaimed_alert_sent_at)).toBe(true);
  });
  it("covers all outcomes, front-desk calls, escalations and declined calls so every panel has content", () => {
    const outs = new Set(d.calls.map((c) => c.outcome));
    for (const o of ["qualified", "not_a_fit", "escalate", "dropped_or_missed", "existing_client"]) expect(outs.has(o as never)).toBe(true);
    expect(d.calls.some((c) => c.source === "front_desk")).toBe(true);
    expect(d.handoffs.some((h) => h.kind === "escalation")).toBe(true);
  });
});

describe("dashboard renders all nine panels from seeded data (acceptance 7)", () => {
  const m = computeDashboard(generateDemoData(NOW, cfg), cfg, NOW, 30);
  const html = renderToStaticMarkup(<DashboardView m={m} demo={true} />);
  it.each(["Responsiveness", "Leads", "Designer response", "Funnel", "Outcomes", "Quality", "Escalations", "Cost", "Review"])("panel: %s", (name) => {
    expect(html).toContain(name);
  });
  it("shows the demo banner, real-looking numbers and no 'NaN'/'undefined'", () => {
    expect(html).toContain("DEMO DATA");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
    expect(m.responsiveness.calls).toBeGreaterThan(100);
    expect(m.cost.perQualifiedLeadInr).toBeGreaterThan(0);
    expect(m.cost.perCallInr).toBeGreaterThan(0);
    expect(m.review.length).toBeGreaterThan(0);
  });
  it("masks caller numbers in the review table", () => {
    expect(html).not.toContain(DEMO_PHONE_PREFIX);
    expect(html).toMatch(/•••• \d{4}/);
  });
  it("renders an empty window without crashing", () => {
    const empty = computeDashboard({ calls: [], leads: [], handoffs: [], costs: [] }, cfg, NOW, 7);
    const h = renderToStaticMarkup(<DashboardView m={empty} demo={false} />);
    expect(h).not.toMatch(/NaN|undefined|Infinity/);
    expect(h).not.toContain("DEMO DATA");
  });
});

describe("metrics on a hand-built dataset", () => {
  const call = (o: Partial<CallRow>): CallRow => ({
    id: "c", lead_id: null, source: "ai", caller_phone: "+919999900001", caller_phone_normalized: "9999900001",
    started_at: "2026-10-08T05:00:00.000Z", answered_at: "2026-10-08T05:00:10.000Z", ended_at: null, duration_sec: 200, after_hours: false,
    transcript: "", classification_status: "ok", outcome: "qualified", underlying_outcome: null, reason: "r", extracted: {}, flags: [], pricing_asked: false,
    guards: [], classifier_model: "m", provider: "t", provider_call_id: null, error: null, ...o,
  });
  const note = (o: Partial<HandoffRow>): HandoffRow => ({
    id: "h", lead_id: "l", call_id: "c1", kind: "new", status: "sent", telegram_chat_id: "d", telegram_message_id: 1, note_text: "n",
    sent_at: "2026-10-08T05:05:00.000Z", due_at: "2026-10-08T06:05:00.000Z", claimed_by: null, claimed_at: null, unclaimed_alert_sent_at: null, error: null, ...o,
  });
  const data: DashboardData = {
    calls: [
      call({ id: "c1", lead_id: "l1" }),
      call({ id: "c2", answered_at: "2026-10-08T05:20:00.000Z", flags: ["after_hours"] }), // answered after 20 min
      call({ id: "c3", outcome: "not_a_fit", flags: ["outside_area"] }),
      call({ id: "c4", outcome: "dropped_or_missed", answered_at: null, duration_sec: 10 }),
      call({ id: "c5", source: "front_desk", outcome: null, classification_status: "pending" }),
      call({ id: "c6", outcome: "escalate", reason: "complaint" }),
    ],
    leads: [{ id: "l1", phone_normalized: "x", name: null, fields: {}, status: "qualified", flags: [], call_count: 1, first_call_at: null, last_call_at: "2026-10-08T05:00:00.000Z", consultation_at: "2026-10-09T05:00:00.000Z", project_signed_at: null }],
    handoffs: [
      note({ id: "h1", call_id: "c1", claimed_at: "2026-10-08T05:15:00.000Z", claimed_by: "A", first_contact_at: "2026-10-08T05:35:00.000Z", fit_verdict: "good" }),
      note({ id: "h2", call_id: "c2" }), // unclaimed, past due
      note({ id: "h3", call_id: "c6", kind: "escalation", first_contact_at: "2026-10-08T05:25:00.000Z", sent_at: "2026-10-08T05:05:00.000Z" }),
    ],
    costs: [
      { call_id: "c1", kind: "llm_classifier", amount: 0.01, currency: "USD" },
      { call_id: "c1", kind: "voice", amount: 14, currency: "INR", minutes: 2 },
      { call_id: "c2", kind: "telephony", amount: 1, currency: "INR" },
    ],
  };
  const m = computeDashboard(data, cfg, NOW, 30);

  it("responsiveness counts every call incl. front desk; answered-within-5-min is of all calls", () => {
    expect(m.responsiveness).toMatchObject({ calls: 6, unanswered: 1, ai: 5, frontDesk: 1, afterHoursCalls: 1 });
    expect(m.responsiveness.pctWithin5Min).toBeCloseTo(66.7, 1); // 4 of 6
  });
  it("leads and designer response", () => {
    expect(m.leads).toMatchObject({ notesSent: 2, claimed: 1, claimRatePct: 50, consultations: 1 });
    expect(m.designerResponse).toMatchObject({ medianClaimMin: 10, medianFirstContactMin: 30, unclaimed: 1, overdue: 1 });
    expect(m.designerResponse.fit).toEqual({ good: 1, poor: 0, notRecorded: 1 });
  });
  it("funnel, outcomes, declines", () => {
    expect(m.funnel.steps.map((s) => s.count)).toEqual([6, 1, 1, 0]) // qualified LEADS: c2 has no lead record;
    expect(m.outcomes.byOutcome.find((o) => o.outcome === "qualified")!.count).toBe(2);
    expect(m.outcomes.declineReasons).toEqual([{ label: "Outside Pune / PCMC", count: 1 }]);
    expect(m.outcomes.unclassified).toBe(1);
  });
  it("quality: hang-ups under 30 s among answered AI calls only", () => {
    expect(m.quality.hangupsUnder30s).toBe(0); // the 10 s call was never answered
  });
  it("escalations: time to callback from the escalation handoff", () => {
    expect(m.escalations).toMatchObject({ count: 1, open: 0, medianCallbackMin: 20 });
  });
  it("cost: converts USD with USD_TO_INR; per qualified lead divides by qualified leads", () => {
    expect(m.cost.totalInr).toBeCloseTo(0.01 * 85 + 14 + 1, 5);
    expect(m.cost.perCallInr).toBeCloseTo(m.cost.totalInr! / 6, 5);
    expect(m.cost.perQualifiedLeadInr).toBeCloseTo(m.cost.totalInr! / 1, 5);
  });
  it("cost without USD_TO_INR shows USD separately and refuses to invent a rate", () => {
    const m2 = computeDashboard(data, getConfig({}), NOW, 30);
    expect(m2.cost.totalInr).toBeNull();
    expect(m2.cost.perQualifiedLeadInr).toBeNull();
    expect(m2.cost.totalUsd).toBeCloseTo(0.01);
    expect(m2.cost.currencyNote).toMatch(/USD_TO_INR/);
    expect(m2.cost.perCallParts!.usd).toBeCloseTo(0.01 / 6, 6);
    expect(m2.cost.perCallParts!.inr).toBeCloseTo(15 / 6, 6);
    const html = renderToStaticMarkup(<DashboardView m={m2} demo={false} />);
    expect(html).toMatch(/\$0\.00\d \+ ₹/); // per-call cost shown as USD + INR, not a dash
  });
  it("median / percentile helpers", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(median([])).toBeNull();
  });
});

describe("dashboard source", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("never shows demo data silently in production", () => {
    expect(() => getDashboardSource({ NODE_ENV: "production" })).toThrow(/Supabase is not configured/);
  });
  it("shows labelled demo data when asked, or in development without Supabase", () => {
    expect(getDashboardSource({ DASHBOARD_SOURCE: "demo", NODE_ENV: "production" }).demo).toBe(true);
    expect(getDashboardSource({ NODE_ENV: "development" }).demo).toBe(true);
  });
});
