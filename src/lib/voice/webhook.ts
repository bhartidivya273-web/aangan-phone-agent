import { logOnlyCall, processCall, type ProcessDeps } from "../pipeline";
import type { CallLogEntry, EndOfCallReport, VoiceEvent } from "./types";

type Enrich = (e: VoiceEvent) => Promise<VoiceEvent>;

export type EventResult = {
  providerCallId: string;
  status: "processed" | "logged" | "duplicate" | "ignored" | "error";
  outcome?: string | null;
  handoff?: string | null;
  callId?: string;
  detail?: string;
};

export function transcriptText(t: EndOfCallReport["transcript"]): string {
  if (typeof t === "string") return t.trim();
  return t
    .filter((x) => x.text.trim())
    .map((x) => `${/^(agent|ai|assistant|bot)/i.test(x.speaker) ? "AI Agent" : /^(front|desk|staff)/i.test(x.speaker) ? "Front Desk" : "Caller"}: ${x.text.trim()}`)
    .join(" ");
}

const durationOf = (r: { durationSec?: number | null; startedAt: string; endedAt?: string | null }) =>
  r.durationSec ?? (r.endedAt ? Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) : null);

/**
 * Runs normalised voice events through the pipeline. Idempotent on (provider, providerCallId): providers retry webhooks,
 * and a call that arrives both as an end-of-call report and as a call-log row is only recorded once.
 */
export async function handleVoiceEvents(events: VoiceEvent[], provider: string, deps: ProcessDeps, enrich?: Enrich): Promise<EventResult[]> {
  const out: EventResult[] = [];
  for (const ev of events) {
    if (ev.type === "ignored") {
      out.push({ providerCallId: "", status: "ignored", detail: ev.reason });
      continue;
    }
    const id = ev.type === "end_of_call_report" ? ev.report.providerCallId : ev.entry.providerCallId;
    try {
      const existing = await deps.store.findCallByProviderId(provider, id);
      if (existing) {
        out.push({ providerCallId: id, status: "duplicate", callId: existing.id });
        continue;
      }
      // enrich only after the duplicate check, so a retried webhook costs no extra vendor API call
      const full = enrich ? await enrich(ev) : ev;
      if (full.type === "ignored") {
        out.push({ providerCallId: id, status: "ignored", detail: full.reason });
        continue;
      }
      out.push(full.type === "end_of_call_report" ? await onReport(full.report, provider, deps) : await onLogEntry(full.entry, provider, deps));
    } catch (e) {
      out.push({ providerCallId: id, status: "error", detail: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}

async function onReport(r: EndOfCallReport, provider: string, deps: ProcessDeps): Promise<EventResult> {
  const answeredBy = r.answeredBy ?? "ai";
  const text = transcriptText(r.transcript);
  const duration = durationOf(r);
  if (answeredBy === "none" || text === "") {
    // nobody spoke: a missed or dropped call. Logged without calling the classifier.
    const call = await logOnlyCall(
      { callerPhone: r.callerPhone, startedAt: r.startedAt, answeredAt: answeredBy === "none" ? null : r.answeredAt, endedAt: r.endedAt, durationSec: duration, source: answeredBy === "front_desk" ? "front_desk" : "ai", provider, providerCallId: r.providerCallId, providerCost: r.providerCost, outcome: "dropped_or_missed", reason: answeredBy === "none" ? "Unanswered call (provider report)" : "Call ended with no transcript" },
      deps,
    );
    return { providerCallId: r.providerCallId, status: "logged", outcome: "dropped_or_missed", callId: call.id };
  }
  const res = await processCall(
    {
      transcript: text,
      callerPhone: r.callerPhone,
      startedAt: r.startedAt,
      answeredAt: r.answeredAt,
      endedAt: r.endedAt,
      durationSec: duration,
      source: answeredBy === "front_desk" ? "front_desk" : "ai",
      provider,
      providerCallId: r.providerCallId,
      providerCost: r.providerCost,
      agentUsage: r.agentUsage,
      // OPEN: calls the front desk answered are logged and classified but do not raise designer notes (the desk forwards them today).
      handoff: answeredBy === "ai",
    },
    deps,
  );
  return { providerCallId: r.providerCallId, status: "processed", outcome: res.classification?.outcome ?? null, handoff: res.handoffKind, callId: res.call.id };
}

async function onLogEntry(e: CallLogEntry, provider: string, deps: ProcessDeps): Promise<EventResult> {
  if (e.transcript && e.transcript.trim() && e.answeredBy !== "none") {
    return onReport({ ...e, transcript: e.transcript }, provider, deps);
  }
  const call = await logOnlyCall(
    {
      callerPhone: e.callerPhone,
      startedAt: e.startedAt,
      answeredAt: e.answeredBy === "none" ? null : (e.answeredAt ?? e.startedAt),
      endedAt: e.endedAt,
      durationSec: durationOf(e),
      source: e.answeredBy === "front_desk" ? "front_desk" : "ai",
      provider,
      providerCallId: e.providerCallId,
      providerCost: e.providerCost,
      outcome: e.answeredBy === "none" ? "dropped_or_missed" : null,
      reason: e.answeredBy === "none" ? "Unanswered call (telephony call log)" : undefined,
    },
    deps,
  );
  return { providerCallId: e.providerCallId, status: "logged", outcome: call.outcome, callId: call.id };
}
