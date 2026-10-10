import type { Config } from "./config";
import type { CallRow, CostRowFull, DashboardData, HandoffRow, LeadRow } from "./types";

const sec = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** The outcome that decides what a call "was", looking through repeat_caller to what it would otherwise have been. */
const effective = (c: CallRow) => (c.outcome === "repeat_caller" ? (c.underlying_outcome ?? "repeat_caller") : c.outcome);
const isNote = (h: HandoffRow) => h.kind === "new" || h.kind === "updated";

export const OUTCOME_ORDER = ["qualified", "ask_one_question", "pricing_asked", "not_a_fit", "timeline_too_short", "escalate", "existing_client", "other", "dropped_or_missed", "repeat_caller"] as const;

const DECLINE_REASONS: Array<[string, string]> = [
  ["outside_area", "Outside Pune / PCMC"],
  ["advice_only", "Advice only"],
  ["outside_services", "Outside services (restaurant, hospitality ...)"],
  ["budget_far_below_scope", "Volunteered budget far below scope"],
  ["below_minimum_size_rule_unconfirmed", "Below minimum size (rule unconfirmed)"],
];

export interface Dashboard {
  windowDays: number;
  since: string;
  responsiveness: { calls: number; answered: number; unanswered: number; ai: number; frontDesk: number; medianAnswerSec: number | null; p90AnswerSec: number | null; pctWithin5Min: number | null; pctAfterHours: number | null; afterHoursCalls: number };
  leads: { notesSent: number; failedSends: number; claimed: number; claimRatePct: number | null; consultations: number; updatedNotes: number };
  designerResponse: { medianClaimMin: number | null; medianFirstContactMin: number | null; p90FirstContactMin: number | null; contacted: number; unclaimed: number; overdue: number; fit: { good: number; poor: number; notRecorded: number } };
  funnel: { steps: Array<{ label: string; count: number; pctOfPrev: number | null }> };
  outcomes: { byOutcome: Array<{ outcome: string; count: number; pct: number | null }>; declineReasons: Array<{ label: string; count: number }>; unclassified: number };
  quality: { qualifiedCalls: number; fieldsCaptured: Array<{ field: string; pct: number | null }>; avgCompletenessPct: number | null; hangupsUnder30s: number; hangupsPct: number | null; humanRequests: number; notUnderstood: number };
  escalations: { count: number; open: number; overdue: number; medianCallbackMin: number | null; items: Array<{ callId: string; at: string; reason: string | null; callbackMin: number | null; due: string | null; overdue: boolean }> };
  cost: {
    currencyNote: string | null;
    totalInr: number | null; totalUsd: number; totalInrPart: number;
    perCallParts: { usd: number; inr: number } | null; perQualifiedLeadParts: { usd: number; inr: number } | null; llmUsd: number; voiceInr: number; telephonyInr: number; telephonyUsd: number;
    perCallInr: number | null; perQualifiedLeadInr: number | null; projectedMonthInr: number | null;
    pctOfProjectLow: number | null; pctOfProjectHigh: number | null; avgProjectLow: number; avgProjectHigh: number; callsCosted: number; qualifiedLeads: number;
  };
  review: Array<{ callId: string; at: string; outcome: string; reason: string | null; flags: string[]; phoneLast4: string; source: string }>;
}

const KEY_FIELDS: Array<[string, (c: CallRow) => boolean]> = [
  ["Name", (c) => !!c.extracted.name],
  ["Locality", (c) => !!c.extracted.locality],
  ["Project type", (c) => !!c.extracted.project_type && c.extracted.project_type !== "unknown"],
  ["Carpet area", (c) => c.extracted.carpet_area_sqft != null],
  ["Timeline", (c) => !!c.extracted.timeline],
  ["Decision-maker", (c) => !!c.extracted.decision_maker],
];

export function computeDashboard(data: DashboardData, cfg: Config, now: Date, windowDays: number): Dashboard {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const calls = data.calls.filter((c) => c.started_at >= since);
  const callIds = new Set(calls.map((c) => c.id));
  const handoffs = data.handoffs.filter((h) => !h.call_id || callIds.has(h.call_id));
  const costs = data.costs.filter((c) => callIds.has(c.call_id));

  // 1 Responsiveness: every call, including front-desk-answered ones (FR19)
  const answeredCalls = calls.filter((c) => c.answered_at);
  const answerSecs = answeredCalls.map((c) => Math.max(0, sec(c.started_at, c.answered_at!)));
  const after = calls.filter((c) => c.after_hours || c.flags.includes("after_hours"));
  const responsiveness = {
    calls: calls.length,
    answered: answeredCalls.length,
    unanswered: calls.length - answeredCalls.length,
    ai: calls.filter((c) => c.source === "ai").length,
    frontDesk: calls.filter((c) => c.source === "front_desk").length,
    medianAnswerSec: median(answerSecs),
    p90AnswerSec: percentile(answerSecs, 90),
    pctWithin5Min: pct(answerSecs.filter((s) => s <= 300).length, calls.length),
    pctAfterHours: pct(after.length, calls.length),
    afterHoursCalls: after.length,
  };

  // 2 Leads
  const notes = handoffs.filter((h) => isNote(h) && h.status === "sent");
  const claimed = notes.filter((h) => h.claimed_at);
  const leadsInWindow = data.leads.filter((l) => l.last_call_at && l.last_call_at >= since);
  const leadsPanel = {
    notesSent: notes.length,
    failedSends: handoffs.filter((h) => h.status === "failed").length,
    claimed: claimed.length,
    claimRatePct: pct(claimed.length, notes.length),
    consultations: leadsInWindow.filter((l) => l.consultation_at).length,
    updatedNotes: notes.filter((h) => h.kind === "updated").length,
  };

  // 3 Designer response
  const mins = (a: string, b: string) => sec(a, b) / 60;
  const claimMins = claimed.map((h) => mins(h.sent_at!, h.claimed_at!));
  const contactMins = notes.filter((h) => h.first_contact_at && h.sent_at).map((h) => mins(h.sent_at!, h.first_contact_at!));
  const nowIso = now.toISOString();
  const unclaimed = notes.filter((h) => !h.claimed_at);
  const designerResponse = {
    medianClaimMin: median(claimMins),
    medianFirstContactMin: median(contactMins),
    p90FirstContactMin: percentile(contactMins, 90),
    contacted: contactMins.length,
    unclaimed: unclaimed.length,
    overdue: unclaimed.filter((h) => h.due_at && h.due_at < nowIso).length,
    fit: {
      good: notes.filter((h) => h.fit_verdict === "good").length,
      poor: notes.filter((h) => h.fit_verdict === "poor").length,
      notRecorded: notes.filter((h) => !h.fit_verdict).length,
    },
  };

  // 4 Funnel
  const qualifiedLeadIds = new Set(calls.filter((c) => effective(c) === "qualified" && c.lead_id).map((c) => c.lead_id!));
  const qLeads = data.leads.filter((l) => qualifiedLeadIds.has(l.id));
  const consults = qLeads.filter((l) => l.consultation_at).length;
  const projects = qLeads.filter((l) => l.project_signed_at).length;
  const steps = [
    { label: "Calls", count: calls.length },
    { label: "Qualified leads", count: qualifiedLeadIds.size },
    { label: "Consultations", count: consults },
    { label: "Projects", count: projects },
  ].map((s, i, a) => ({ ...s, pctOfPrev: i === 0 ? null : pct(s.count, a[i - 1].count) }));

  // 5 Outcomes
  const classified = calls.filter((c) => c.outcome);
  const byOutcome = OUTCOME_ORDER.map((o) => {
    const n = calls.filter((c) => c.outcome === o).length;
    return { outcome: o, count: n, pct: pct(n, calls.length) };
  });
  const declined = calls.filter((c) => c.outcome === "not_a_fit" || c.outcome === "timeline_too_short");
  const declineReasons = DECLINE_REASONS.map(([flag, label]) => ({ label, count: declined.filter((c) => c.flags.includes(flag)).length }));
  declineReasons.push({ label: "Timeline too short", count: declined.filter((c) => c.outcome === "timeline_too_short").length });
  const known = declineReasons.reduce((s, r) => s + r.count, 0);
  if (declined.length > known) declineReasons.push({ label: "Other", count: declined.length - known });

  // 6 Quality
  const qCalls = calls.filter((c) => effective(c) === "qualified");
  const fieldsCaptured = KEY_FIELDS.map(([field, ok]) => ({ field, pct: pct(qCalls.filter(ok).length, qCalls.length) }));
  const completeness = qCalls.length ? qCalls.reduce((s, c) => s + KEY_FIELDS.filter(([, ok]) => ok(c)).length / KEY_FIELDS.length, 0) / qCalls.length : null;
  const aiCalls = calls.filter((c) => c.source === "ai" && c.answered_at);
  const hangups = aiCalls.filter((c) => c.duration_sec != null && c.duration_sec < 30);
  const quality = {
    qualifiedCalls: qCalls.length,
    fieldsCaptured,
    avgCompletenessPct: completeness === null ? null : Math.round(completeness * 1000) / 10,
    hangupsUnder30s: hangups.length,
    hangupsPct: pct(hangups.length, aiCalls.length),
    humanRequests: calls.filter((c) => c.flags.includes("human_requested")).length,
    notUnderstood: calls.filter((c) => c.flags.includes("not_understood")).length,
  };

  // 7 Escalations
  const escCalls = calls.filter((c) => effective(c) === "escalate");
  const escItems = escCalls
    .map((c) => {
      const h = handoffs.find((x) => x.call_id === c.id && x.kind === "escalation");
      const callbackMin = h?.first_contact_at && h.sent_at ? mins(h.sent_at, h.first_contact_at) : null;
      const overdue = !h?.first_contact_at && !!h?.due_at && h.due_at < nowIso;
      return { callId: c.id, at: c.started_at, reason: c.reason, callbackMin, due: h?.due_at ?? null, overdue };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const escalations = {
    count: escCalls.length,
    open: escItems.filter((e) => e.callbackMin === null).length,
    overdue: escItems.filter((e) => e.overdue).length,
    medianCallbackMin: median(escItems.flatMap((e) => (e.callbackMin === null ? [] : [e.callbackMin]))),
    items: escItems.slice(0, 10),
  };

  // 8 Cost
  const usd = costs.filter((c) => c.currency === "USD").reduce((s, c) => s + c.amount, 0);
  const inr = (kind: CostRowFull["kind"]) => costs.filter((c) => c.currency === "INR" && c.kind === kind).reduce((s, c) => s + c.amount, 0);
  const llmUsd = costs.filter((c) => c.currency === "USD" && (c.kind === "llm_classifier" || c.kind === "llm_agent")).reduce((s, c) => s + c.amount, 0);
  const telUsd = costs.filter((c) => c.currency === "USD" && c.kind === "telephony").reduce((s, c) => s + c.amount, 0);
  const fx = cfg.prices.usdToInr;
  const toInr = (u: number) => (fx > 0 ? u * fx : null);
  const totalInr = fx > 0 ? usd * fx + costs.filter((c) => c.currency === "INR").reduce((s, c) => s + c.amount, 0) : null;
  const callsCosted = new Set(costs.map((c) => c.call_id)).size;
  const perCall = totalInr !== null && calls.length ? totalInr / calls.length : null;
  const perQ = totalInr !== null && qualifiedLeadIds.size ? totalInr / qualifiedLeadIds.size : null;
  const cost = {
    currencyNote: fx > 0 ? null : "USD_TO_INR is not set, so USD and INR amounts are shown separately and the per-call / per-lead figures are unavailable.",
    totalInr, totalUsd: usd, totalInrPart: costs.filter((c) => c.currency === "INR").reduce((s, c) => s + c.amount, 0),
    perCallParts: calls.length ? { usd: usd / calls.length, inr: costs.filter((c) => c.currency === "INR").reduce((s, c) => s + c.amount, 0) / calls.length } : null,
    perQualifiedLeadParts: qualifiedLeadIds.size ? { usd: usd / qualifiedLeadIds.size, inr: costs.filter((c) => c.currency === "INR").reduce((s, c) => s + c.amount, 0) / qualifiedLeadIds.size } : null,
    llmUsd, voiceInr: inr("voice"), telephonyInr: inr("telephony"), telephonyUsd: telUsd,
    perCallInr: perCall, perQualifiedLeadInr: perQ,
    projectedMonthInr: totalInr !== null ? (totalInr / windowDays) * 30 : null,
    pctOfProjectLow: perQ !== null ? Math.round((perQ / cfg.avgProjectValueInr.low) * 10000) / 100 : null,
    pctOfProjectHigh: perQ !== null ? Math.round((perQ / cfg.avgProjectValueInr.high) * 10000) / 100 : null,
    avgProjectLow: cfg.avgProjectValueInr.low, avgProjectHigh: cfg.avgProjectValueInr.high,
    callsCosted, qualifiedLeads: qualifiedLeadIds.size,
  };
  void toInr;

  // 9 Review: declined calls with their reasons (transcripts one click away)
  const review = declined
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 25)
    .map((c) => ({ callId: c.id, at: c.started_at, outcome: c.outcome!, reason: c.reason, flags: c.flags, phoneLast4: (c.caller_phone ?? "").replace(/\D/g, "").slice(-4) || "----", source: c.source }));

  return {
    windowDays, since, responsiveness, leads: leadsPanel, designerResponse, funnel: { steps },
    outcomes: { byOutcome, declineReasons: declineReasons.filter((r) => r.count > 0), unclassified: calls.length - classified.length },
    quality, escalations, cost, review,
  };
}

export type { LeadRow };
