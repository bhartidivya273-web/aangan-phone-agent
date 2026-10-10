import { randomUUID } from "node:crypto";
import type { Config } from "./config";
import { firstContactDue } from "./handoff";
import { dueTime, fromLocal, localParts } from "./time";
import type { CallRow, CostRowFull, DashboardData, HandoffRow, LeadRow } from "./types";
import type { Outcome } from "./schema";

/**
 * Deterministic DEMO data so the dashboard renders before any real call exists. Names, numbers and amounts are
 * synthetic (phones start 99999, provider = "demo") and the dashboard says so. Distributions are arbitrary, not Aangan facts.
 */
export const DEMO_PHONE_PREFIX = "99999";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHTS: Array<[Outcome, number]> = [
  ["qualified", 31], ["not_a_fit", 14], ["existing_client", 8], ["other", 9], ["dropped_or_missed", 11],
  ["pricing_asked", 4], ["ask_one_question", 5], ["timeline_too_short", 5], ["escalate", 3], ["repeat_caller", 10],
];
const LOCALITIES = ["Kothrud", "Baner", "Aundh", "Wakad", "Hadapsar", "Koregaon Park", "Viman Nagar", "Pimple Saudagar", "Undri", "Magarpatta"];
const DECLINE_FLAGS = ["outside_area", "advice_only", "outside_services", "budget_far_below_scope", "below_minimum_size_rule_unconfirmed"];
const DECLINE_REASON: Record<string, string> = {
  outside_area: "Site is outside Pune and PCMC",
  advice_only: "Wants advice only, no design and execution",
  outside_services: "Restaurant / hospitality project, out of scope",
  budget_far_below_scope: "Volunteered budget far below the scope described",
  below_minimum_size_rule_unconfirmed: "Commercial space below the minimum size",
};

export function generateDemoData(now: Date, cfg: Config, opts: { days?: number; calls?: number; seed?: number } = {}): DashboardData {
  const days = opts.days ?? 30;
  const n = opts.calls ?? 200;
  const r = rng(opts.seed ?? 7);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (a: number, b: number) => a + r() * (b - a);
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  const outcomeOf = (): Outcome => {
    let x = r() * total;
    for (const [o, w] of WEIGHTS) if ((x -= w) < 0) return o;
    return "other";
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  const calls: CallRow[] = [];
  const leads = new Map<string, LeadRow>();
  const handoffs: HandoffRow[] = [];
  const costs: CostRowFull[] = [];
  let phoneSeq = 10000;

  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const back = Math.floor(r() * days);
    const base = localParts(new Date(now.getTime() - back * 86_400_000), cfg);
    const afterHours = r() < 0.34;
    const hour = afterHours ? pick([6, 7, 8, 9, 19, 20, 21, 22, 23]) : Math.floor(between(10, 19));
    const t = fromLocal(base.y, base.m, base.d, hour, Math.floor(r() * 60), cfg).getTime();
    if (t < now.getTime() - 3 * 60_000) times.push(t);
  }
  times.sort((a, b) => a - b);

  const demoPrices = { classIn: 0.5, classOut: 3, agentIn: 0.1, agentOut: 0.5, voiceInrPerMin: cfg.prices.voicePerMinInr || 7 };
  const repeatPool: string[] = [];

  for (const t of times) {
    let outcome = outcomeOf();
    const frontDesk = r() < 0.14;
    const unanswered = outcome === "dropped_or_missed" && r() < 0.5;
    const flags: string[] = [];
    const id = randomUUID();
    const startedAt = iso(t);
    const local = localParts(new Date(t), cfg);
    const inHours = cfg.officeDays.includes(local.weekday) && local.hour >= cfg.officeOpenHour && local.hour < cfg.officeCloseHour;
    if (!inHours) flags.push("after_hours");
    const source: CallRow["source"] = frontDesk && inHours ? "front_desk" : "ai";
    const duration = outcome === "dropped_or_missed" ? Math.floor(between(2, 28)) : outcome === "qualified" ? Math.floor(between(150, 420)) : Math.floor(between(45, 260));
    const answerAfter = unanswered ? null : source === "ai" ? between(2, 14) : between(8, 70);

    let phone = `${DEMO_PHONE_PREFIX}${phoneSeq++}`;
    if (outcome === "repeat_caller" && repeatPool.length) phone = pick(repeatPool);
    else if (outcome === "repeat_caller") outcome = "qualified";
    if (outcome === "qualified" && r() < 0.15) repeatPool.push(phone);

    const extracted: CallRow["extracted"] = {};
    let reason: string | null = null;
    let effective: Outcome = outcome === "repeat_caller" ? "qualified" : outcome;
    if (outcome === "dropped_or_missed") reason = unanswered ? "Unanswered call" : "Line dropped before any detail";
    if (effective === "qualified") {
      extracted.name = `Demo Caller ${phoneSeq}`;
      extracted.locality = pick(LOCALITIES);
      extracted.project_type = pick(["residential_full", "residential_full", "residential_partial", "single_room", "commercial"] as const);
      extracted.carpet_area_sqft = r() < 0.9 ? Math.round(between(450, 2400) / 10) * 10 : null;
      extracted.timeline = r() < 0.9 ? "Within 6 to 8 months" : null;
      extracted.decision_maker = r() < 0.88 ? "Owner" : null;
      if (r() < 0.25) flags.push("pricing_asked");
      if (r() < 0.12) flags.push("timeline_tight");
      if (r() < 0.1) flags.push("decision_maker_unconfirmed");
      reason = `Qualified ${String(extracted.project_type).replace("_", " ")} enquiry in ${extracted.locality}`;
    } else if (effective === "not_a_fit") {
      const f = pick(DECLINE_FLAGS);
      flags.push(f);
      reason = DECLINE_REASON[f];
    } else if (effective === "timeline_too_short") {
      reason = "Needs the project complete sooner than design plus execution allow";
      flags.push("callback_for_later_start");
    } else if (effective === "escalate") {
      flags.push("complaint");
      reason = "Complaint about a running project";
    } else if (effective === "existing_client") reason = "Status check on a running project";
    else if (effective === "other") reason = pick(["Vendor enquiry", "Job seeker", "Wrong number", "Contractor"]);
    else if (effective === "pricing_asked") { flags.push("pricing_asked"); reason = "Asked about price only"; }
    else if (effective === "ask_one_question") reason = "Needs one more detail before a designer can take it";
    if (outcome === "repeat_caller") flags.push("repeat_caller");
    if (r() < 0.03 && source === "ai" && !unanswered) flags.push(pick(["human_requested", "not_understood"]));

    const unclassifiedFrontDesk = source === "front_desk" && r() < 0.5;
    const call: CallRow = {
      id, lead_id: null, source, caller_phone: `+91${phone}`, caller_phone_normalized: phone,
      started_at: startedAt, answered_at: answerAfter === null ? null : iso(t + answerAfter * 1000), ended_at: iso(t + duration * 1000),
      duration_sec: duration, after_hours: !inHours, transcript: "(demo transcript - synthetic)",
      classification_status: unclassifiedFrontDesk ? "pending" : "ok",
      outcome: unclassifiedFrontDesk ? null : outcome, underlying_outcome: outcome === "repeat_caller" ? effective : null,
      reason: unclassifiedFrontDesk ? null : reason, extracted, flags, pricing_asked: flags.includes("pricing_asked"), guards: [],
      classifier_model: "demo", provider: "demo", provider_call_id: id, error: null,
    };

    // lead + handoff
    if (!unclassifiedFrontDesk && source === "ai" && ["qualified", "not_a_fit", "timeline_too_short", "escalate", "existing_client", "other"].includes(effective)) {
      const existing = [...leads.values()].find((l) => l.phone_normalized === phone);
      const lead: LeadRow = existing ?? {
        id: randomUUID(), phone_normalized: phone, name: (extracted.name as string) ?? null, fields: extracted,
        status: effective === "qualified" ? "qualified" : effective === "escalate" ? "escalated" : effective === "existing_client" ? "existing_client" : effective === "other" ? "other" : "declined",
        flags, call_count: 0, first_call_at: startedAt, last_call_at: startedAt,
      };
      lead.call_count += 1;
      lead.last_call_at = startedAt;
      leads.set(lead.id, lead);
      call.lead_id = lead.id;

      if (effective === "qualified") {
        const sentMs = t + duration * 1000 + between(60, 300) * 1000;
        const sent = new Date(sentMs);
        if (sent.getTime() < now.getTime()) {
          const due = firstContactDue(sent, cfg);
          const claimed = r() < 0.86;
          const claimDelay = between(4, 140) * 60_000;
          const claimedAt = claimed && sentMs + claimDelay < now.getTime() ? sentMs + claimDelay : null;
          const contacted = claimedAt && r() < 0.78 ? claimedAt + between(10, 300) * 60_000 : null;
          const firstContact = contacted && contacted < now.getTime() ? contacted : null;
          const fit = firstContact ? (r() < 0.6 ? "good" : r() < 0.6 ? "poor" : null) : null;
          handoffs.push({
            id: randomUUID(), lead_id: lead.id, call_id: id, kind: existing ? "updated" : "new", status: "sent",
            telegram_chat_id: "DEMO", telegram_message_id: handoffs.length + 1, note_text: "NEW LEAD (demo)", sent_at: sent.toISOString(),
            due_at: due.toISOString(), claimed_by: claimedAt ? pick(["Designer A", "Designer B", "Designer C"]) : null,
            claimed_at: claimedAt ? iso(claimedAt) : null, unclaimed_alert_sent_at: null, error: null,
            first_contact_at: firstContact ? iso(firstContact) : null, fit_verdict: fit as "good" | "poor" | null,
          });
          if (fit === "good" && r() < 0.55) {
            lead.consultation_at = iso((firstContact as number) + between(1, 6) * 86_400_000 > now.getTime() ? now.getTime() - 3_600_000 : (firstContact as number) + between(1, 6) * 86_400_000);
            if (r() < 0.3) lead.project_signed_at = iso(Math.min(now.getTime(), Date.parse(lead.consultation_at) + between(3, 12) * 86_400_000));
          }
        }
      } else if (effective === "escalate") {
        const sentMs = t + duration * 1000 + 20_000;
        const due = dueTime(new Date(sentMs), cfg.escalationCallbackOfficeMinutes, cfg);
        const back = r() < 0.8 ? sentMs + between(6, 45) * 60_000 : null;
        handoffs.push({
          id: randomUUID(), lead_id: lead.id, call_id: id, kind: "escalation", status: "sent", telegram_chat_id: "DEMO",
          telegram_message_id: handoffs.length + 1, note_text: "ESCALATION (demo)", sent_at: iso(sentMs), due_at: due.toISOString(),
          claimed_by: null, claimed_at: null, unclaimed_alert_sent_at: null, error: null,
          first_contact_at: back && back < now.getTime() ? iso(back) : null, fit_verdict: null,
        });
      }
    }
    calls.push(call);

    // costs: classifier + agent tokens for AI-handled calls, voice minutes, telephony
    if (source === "ai" && call.classification_status === "ok" && !unanswered) {
      const cin = Math.round(between(3600, 4600));
      const cout = Math.round(between(180, 420));
      costs.push({ call_id: id, kind: "llm_classifier", model: "demo", input_tokens: cin, output_tokens: cout, amount: (cin * demoPrices.classIn + cout * demoPrices.classOut) / 1e6, currency: "USD", created_at: startedAt });
      const turns = Math.max(1, Math.round(duration / 40));
      const ain = Math.round(turns * between(1800, 2600));
      const aout = Math.round(turns * between(30, 70));
      costs.push({ call_id: id, kind: "llm_agent", model: "demo", input_tokens: ain, output_tokens: aout, amount: (ain * demoPrices.agentIn + aout * demoPrices.agentOut) / 1e6, currency: "USD", created_at: startedAt });
      costs.push({ call_id: id, kind: "voice", minutes: duration / 60, amount: (duration / 60) * demoPrices.voiceInrPerMin, currency: "INR", created_at: startedAt });
    }
    costs.push({ call_id: id, kind: "telephony", amount: Math.round(between(0.3, 1.1) * 100) / 100, currency: "INR", created_at: startedAt });
  }
  return { calls, leads: [...leads.values()], handoffs, costs };
}
