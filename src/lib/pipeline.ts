import { classifyCall, type ClassificationResult } from "./classify";
import { getConfig, type Config } from "./config";
import {
  buildEscalationAlert,
  buildHandoffNote,
  firstContactDue,
  sendHandoff,
  type SendDeps,
} from "./handoff";
import type { LLM } from "./llm";
import { buildNoteHtml, createHubSpot, type HubSpotClient } from "./hubspot";
import { normalizePhone } from "./phone";
import { agentPriceLeaks } from "./priceFilter";
import { agentPromiseViolations } from "./promiseFilter";
import type { Rules } from "./rules";
import { EMPTY_EXTRACTED, type CallMeta, type Extracted, type Outcome } from "./schema";
import type { CallRow, CostRow, LeadRow, LeadStatus } from "./types";

export interface ProcessCallInput {
  transcript: string;
  callerPhone: string | null;
  startedAt: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSec?: number | null;
  source?: "ai" | "front_desk";
  provider?: string | null;
  providerCallId?: string | null;
  providerCost?: { amount: number; currency: "USD" | "INR" } | null;
  /** Extra LLM cost already incurred in the live conversation (agent turns). */
  agentUsage?: { model: string; input_tokens: number; output_tokens: number; cost_usd: number } | null;
  /** Set false to log only (e.g. front-desk-answered calls). Default true. */
  handoff?: boolean;
}

export interface ProcessDeps extends SendDeps {
  cfg?: Config;
  llm?: LLM;
  rules?: Rules;
  chats: { designers: string; nikhil: string };
  /** Override for tests; by default built from HUBSPOT_ACCESS_TOKEN. */
  hubspot?: HubSpotClient | null;
}

export interface ProcessResult {
  call: CallRow;
  lead: LeadRow | null;
  classification: ClassificationResult | null;
  effectiveOutcome: Outcome | null;
  handoffKind: "new" | "updated" | "escalation" | null;
}

const STATUS_BY_OUTCOME: Partial<Record<Outcome, LeadStatus>> = {
  qualified: "qualified",
  not_a_fit: "declined",
  timeline_too_short: "declined",
  escalate: "escalated",
  existing_client: "existing_client",
  other: "other",
};

/** Merge: new non-null values win; null never erases something already known. */
export function mergeFields(old: Partial<Extracted>, fresh: Partial<Extracted>): Partial<Extracted> {
  const out: Partial<Extracted> = { ...old };
  for (const [k, val] of Object.entries(fresh)) {
    if (val !== null && val !== undefined) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}

function nextStatus(prev: LeadStatus | null, outcome: Outcome | null): LeadStatus {
  const next = outcome ? STATUS_BY_OUTCOME[outcome] : undefined;
  if (!next) return prev ?? "open"; // ask_one_question, pricing_asked, dropped_or_missed: no verdict yet
  // a qualified lead is not silently downgraded by a later vendor/other call
  if (prev === "qualified" && (next === "other" || next === "existing_client")) return prev;
  return next;
}

export async function processCall(input: ProcessCallInput, deps: ProcessDeps): Promise<ProcessResult> {
  const cfg = deps.cfg ?? getConfig();
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const phoneNorm = normalizePhone(input.callerPhone);

  let lead = phoneNorm ? await store.findLeadByPhone(phoneNorm) : null;
  const prior = lead ? await store.listCallsForLead(lead.id) : [];
  const meta: CallMeta = {
    callerPhone: input.callerPhone,
    callTime: input.startedAt,
    durationSec: input.durationSec ?? null,
    source: input.source ?? "ai",
    priorCalls: prior.map((c) => ({
      date: c.started_at,
      outcome: c.outcome,
      summary: c.reason ?? (c.classification_status === "failed" ? "classification failed" : "no summary"),
    })),
  };

  // the hard rule: the agent never states a price. Where the live voice is a vendor's model, this is the safety net.
  const priceLeaks = (input.source ?? "ai") === "ai" ? agentPriceLeaks(input.transcript) : [];
  // a consultation the assistant booked with the booking tool during this call (it was made before the call report arrives)
  const startMs = Date.parse(input.startedAt);
  const endMs = input.endedAt ? Date.parse(input.endedAt) : startMs + (input.durationSec ?? 0) * 1000;
  const bookingCandidates =
    cfg.booking.enabled && (input.source ?? "ai") === "ai" && input.provider !== "simulator"
      ? await store.findUnlinkedBookings(new Date(startMs - 60_000).toISOString(), new Date(endMs + 10 * 60_000).toISOString())
      : [];
  const linkedBooking = bookingCandidates.length
    ? (phoneNorm ? bookingCandidates.find((b) => b.customer_phone_normalized === phoneNorm) : undefined) ??
      [...bookingCandidates].sort((a, b) => Math.abs(Date.parse(a.created_at) - endMs) - Math.abs(Date.parse(b.created_at) - endMs))[0]
    : null;
  // softer sibling of the price check: promised times, slots or calendar dates. Flag only (no alert); times from the booking tool are legitimate.
  const promises = (input.source ?? "ai") === "ai" && input.provider !== "simulator" && !linkedBooking ? agentPromiseViolations(input.transcript) : [];

  let cls: ClassificationResult | null = null;
  let classifyError: string | null = null;
  try {
    cls = await classifyCall(input.transcript, meta, { llm: deps.llm, rules: deps.rules, config: cfg });
  } catch (e) {
    classifyError = (e as Error).message.slice(0, 500);
  }

  const effective: Outcome | null = cls ? (cls.outcome === "repeat_caller" ? cls.underlying_outcome ?? null : cls.outcome) : null;
  const extracted: Partial<Extracted> = cls?.extracted ?? { ...EMPTY_EXTRACTED };

  // --- lead (merge by caller ID). A qualified call with NO caller id still gets a lead (without a phone key), so it is never lost. ---
  if (phoneNorm || effective === "qualified") {
    const merged = mergeFields(lead?.fields ?? {}, { ...extracted, phone: extracted.phone ?? input.callerPhone });
    lead = await store.saveLead({
      ...(lead ?? { first_call_at: input.startedAt, flags: [], status: "open" as LeadStatus }),
      phone_normalized: phoneNorm ?? null,
      name: (merged.name as string | null | undefined) ?? lead?.name ?? null,
      fields: merged,
      status: nextStatus(lead?.status ?? null, effective),
      flags: [...new Set([...(lead?.flags ?? []), ...(cls?.flags ?? [])])],
      call_count: (lead?.call_count ?? 0) + 1,
      last_call_at: input.startedAt,
    } as Omit<LeadRow, "id"> & { id?: string });
  }

  // --- call log (every call, including declined/escalated: never deleted) ---
  const call = await store.insertCall({
    lead_id: lead?.id ?? null,
    source: input.source ?? "ai",
    caller_phone: input.callerPhone,
    caller_phone_normalized: phoneNorm,
    started_at: input.startedAt,
    answered_at: input.answeredAt ?? input.startedAt,
    ended_at: input.endedAt ?? null,
    duration_sec: input.durationSec ?? null,
    after_hours: cls?.flags.includes("after_hours") ?? false,
    transcript: input.transcript,
    classification_status: cls ? "ok" : "failed",
    outcome: cls?.outcome ?? null,
    underlying_outcome: cls?.underlying_outcome ?? null,
    reason: cls?.reason ?? null,
    extracted,
    flags: [...(cls?.flags ?? []), ...(priceLeaks.length ? ["agent_price_leak"] : []), ...(promises.length ? ["agent_promise"] : [])],
    pricing_asked: cls?.pricing_asked ?? false,
    guards: cls?.guards ?? [],
    classifier_model: cls?.model ?? null,
    provider: input.provider ?? null,
    provider_call_id: input.providerCallId ?? null,
    error: classifyError,
  });

  if (linkedBooking) {
    await store.updateBooking(linkedBooking.id, {
      call_id: call.id,
      lead_id: lead?.id ?? null,
      customer_phone: linkedBooking.customer_phone ?? input.callerPhone,
      customer_phone_normalized: linkedBooking.customer_phone_normalized ?? phoneNorm,
    });
    if (lead) lead = await store.updateLead(lead.id, { consultation_at: linkedBooking.start_at });
  }

  // --- costs: one row per component, always written (stubbed zero amounts allowed until unit prices are set) ---
  const costs: CostRow[] = [];
  if (cls) {
    costs.push({
      call_id: call.id,
      kind: "llm_classifier",
      model: cls.model,
      input_tokens: cls.usage.input_tokens + (cls.usage.cache_read_input_tokens ?? 0) + (cls.usage.cache_creation_input_tokens ?? 0),
      output_tokens: cls.usage.output_tokens,
      amount: cls.cost_usd,
      currency: "USD",
    });
  }
  if (input.agentUsage) {
    costs.push({
      call_id: call.id,
      kind: "llm_agent",
      model: input.agentUsage.model,
      input_tokens: input.agentUsage.input_tokens,
      output_tokens: input.agentUsage.output_tokens,
      amount: input.agentUsage.cost_usd,
      currency: "USD",
    });
  }
  if (input.durationSec != null && (input.source ?? "ai") === "ai") {
    const minutes = input.durationSec / 60;
    costs.push({ call_id: call.id, kind: "voice", minutes, amount: minutes * cfg.prices.voicePerMinInr, currency: "INR" });
  }
  if (input.providerCost) {
    costs.push({ call_id: call.id, kind: "telephony", amount: input.providerCost.amount, currency: input.providerCost.currency });
  }
  await store.insertCosts(costs);

  // --- handoffs ---
  let handoffKind: ProcessResult["handoffKind"] = null;
  if (input.handoff !== false) {
    if (priceLeaks.length) {
      await sendHandoff(deps, {
        text: `PRICE RULE BREACH - on a call the agent said something that looks like a price. Please review it: ${cfg.appBaseUrl}/dashboard/calls/${call.id}\nWhat it said: ${priceLeaks.slice(0, 3).join(" | ")}`,
        chatId: deps.chats.nikhil,
        kind: "failure_alert",
        leadId: lead?.id ?? null,
        callId: call.id,
      });
    }
    if (!cls) {
      // never lose a call silently: tell Nikhil it needs a human look
      await sendHandoff(deps, {
        text: `CLASSIFICATION FAILED - call ${input.startedAt} from ${input.callerPhone ?? "unknown"}. Transcript is saved: ${cfg.appBaseUrl}/dashboard/calls/${call.id}\nPlease review manually.`,
        chatId: deps.chats.nikhil,
        kind: "failure_alert",
        leadId: lead?.id ?? null,
        callId: call.id,
      });
    } else {
      const sendLeadNote = async (): Promise<"new" | "updated"> => {
        const prevNote = await store.latestNoteForLead(lead!.id);
        const isUpdate = prevNote !== null;
        const text = buildHandoffNote(
          {
            callTime: input.startedAt,
            lead: lead!,
            callerPhone: input.callerPhone,
            flags: lead!.flags.includes("repeat_caller") || isUpdate ? [...new Set([...cls.flags, "repeat_caller"])] : cls.flags,
            pricingAsked: cls.pricing_asked || lead!.flags.includes("pricing_asked"),
            isUpdate,
            callId: call.id,
            bookingStart: linkedBooking?.start_at ?? null,
          },
          cfg,
        );
        const prevClaimed = prevNote?.claimed_at != null;
        await sendHandoff(deps, {
          text,
          chatId: deps.chats.designers,
          kind: isUpdate ? "updated" : "new",
          leadId: lead!.id,
          callId: call.id,
          // an update to an already-claimed lead must not raise a second unclaimed alert
          dueAt: prevClaimed ? null : firstContactDue(now, cfg),
          replyToMessageId: prevNote?.telegram_message_id ?? undefined,
        });
        if (prevNote && !prevClaimed) await store.updateHandoff(prevNote.id, { due_at: null }); // superseded by the update
        return isUpdate ? "updated" : "new";
      };

      if (effective === "qualified" && lead) {
        handoffKind = await sendLeadNote();
        // the founder's CRM gets the same lead at the same moment (never blocks or fails the call)
        await syncCallToHubSpot(call, lead, { ...deps, cfg });
      } else if (effective === "escalate") {
        // OPEN (ESCALATED_REPEAT_ALSO_NOTES): a complaint from someone who already has a lead note also updates the designers.
        if (cfg.escalatedRepeatAlsoNotes && lead && (await store.latestNoteForLead(lead.id))) await sendLeadNote();
        const alert = buildEscalationAlert(call, cfg);
        await sendHandoff(deps, {
          text: alert.text,
          chatId: deps.chats.nikhil,
          kind: "escalation",
          leadId: lead?.id ?? null,
          callId: call.id,
          dueAt: alert.due,
        });
        handoffKind = "escalation";
      }
    }
  }

  return { call, lead, classification: cls, effectiveOutcome: effective, handoffKind };
}

export interface LogOnlyInput {
  callerPhone: string | null;
  startedAt: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSec?: number | null;
  source: "ai" | "front_desk";
  provider: string;
  providerCallId: string;
  providerCost?: { amount: number; currency: "USD" | "INR" } | null;
  /** Set for calls nobody answered or that dropped before any speech; leave null for calls we simply have no transcript for. */
  outcome?: Outcome | null;
  reason?: string;
}

/**
 * FR19: log a call that never went through the classifier (front-desk-answered calls from the telephony log, unanswered
 * calls, empty transcripts). It appears in the dashboard and is never turned into a lead or a handoff.
 */
export async function logOnlyCall(input: LogOnlyInput, deps: Pick<ProcessDeps, "store">): Promise<CallRow> {
  const phoneNorm = normalizePhone(input.callerPhone);
  const lead = phoneNorm ? await deps.store.findLeadByPhone(phoneNorm) : null;
  const call = await deps.store.insertCall({
    lead_id: lead?.id ?? null,
    source: input.source,
    caller_phone: input.callerPhone,
    caller_phone_normalized: phoneNorm,
    started_at: input.startedAt,
    answered_at: input.answeredAt ?? null,
    ended_at: input.endedAt ?? null,
    duration_sec: input.durationSec ?? null,
    after_hours: false,
    transcript: null,
    classification_status: input.outcome ? "ok" : "pending",
    outcome: input.outcome ?? null,
    underlying_outcome: null,
    reason: input.reason ?? null,
    extracted: {},
    flags: [],
    pricing_asked: false,
    guards: [],
    classifier_model: null,
    provider: input.provider,
    provider_call_id: input.providerCallId,
    error: null,
  });
  if (input.providerCost) {
    await deps.store.insertCosts([{ call_id: call.id, kind: "telephony", amount: input.providerCost.amount, currency: input.providerCost.currency }]);
  }
  return call;
}

/**
 * Send one qualified lead to HubSpot (contact + note) and remember the outcome on the call. Never throws: a HubSpot problem is
 * recorded in calls.hubspot_error and retried by the cron job, it must not disturb the call log or the Telegram handoff.
 */
export async function syncCallToHubSpot(call: CallRow, lead: LeadRow | null, deps: Pick<ProcessDeps, "store" | "cfg" | "hubspot">): Promise<"synced" | "skipped" | "failed"> {
  const cfg = deps.cfg ?? getConfig();
  const client = deps.hubspot === undefined ? (cfg.hubspot.token ? createHubSpot(cfg.hubspot.token, cfg.hubspot.createDeal) : null) : deps.hubspot;
  if (!client || !lead) return "skipped";
  try {
    const booking = await deps.store.getBookingForCall(call.id);
    const r = await client.syncLead({
      name: lead.name ?? (lead.fields.name as string | null) ?? null,
      phone: call.caller_phone ?? (lead.fields.phone as string | null) ?? null,
      locality: (lead.fields.locality as string | null) ?? null,
      callIso: call.started_at,
      noteHtml: buildNoteHtml(call, lead, booking, cfg),
      existingContactId: lead.hubspot_contact_id ?? null,
    });
    await deps.store.updateCall(call.id, { hubspot_contact_id: r.contactId, hubspot_note_id: r.noteId, hubspot_error: null });
    if (lead.hubspot_contact_id !== r.contactId) await deps.store.updateLead(lead.id, { hubspot_contact_id: r.contactId });
    return "synced";
  } catch (e) {
    await deps.store.updateCall(call.id, { hubspot_error: (e as Error).message.slice(0, 400) }).catch(() => undefined);
    return "failed";
  }
}

/** Cron helper: retry HubSpot syncs that failed earlier. */
export async function retryHubSpot(deps: Pick<ProcessDeps, "store" | "cfg" | "hubspot">, limit = 20): Promise<number> {
  const failed = await deps.store.listHubspotFailures(limit);
  let ok = 0;
  for (const c of failed) {
    const lead = c.lead_id ? await deps.store.getLead(c.lead_id) : null;
    if ((await syncCallToHubSpot(c, lead, deps)) === "synced") ok++;
  }
  return ok;
}
