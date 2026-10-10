import { z } from "zod";
import { checkSecret } from "../auth";
import type { VoiceAdapter, VoiceEvent } from "./types";

/**
 * Vaani Voice adapter (https://docs.vaanivoice.ai). Built from the vendor's docs on 2026-10-10:
 *  - The webhook event that carries the finished call is `call_postprocessing` (payload nested under `data`:
 *    call_id, call_duration in ms, summary, entities, transcript as "[hh:mm:ss] AGENT: ... [..] USER: ..."). It does NOT carry
 *    the caller's number, the real start time or the cost; those come from GET /api/call-history (X-API-Key), see enrich().
 *  - Every other event (call_started, call_ended, transfers ...) is ignored.
 *  - The docs describe no signature scheme, so the webhook URL carries a secret: .../api/voice/webhook?key=<VOICE_WEBHOOK_SECRET>
 *    (an `x-webhook-secret` header is accepted too, in case the vendor adds custom headers).
 */

const Payload = z.object({
  event: z.string(),
  room_name: z.string().optional(),
  phone_number: z.string().optional(),
  call_id: z.string().optional(),
  timestamp: z.string().optional(),
  data: z
    .object({
      call_id: z.string().optional(),
      room_name: z.string().optional(),
      call_duration: z.number().optional(), // milliseconds on call_postprocessing
      end_reason: z.string().optional(),
      summary: z.string().optional(),
      transcript: z.string().optional(),
    })
    .optional(),
});

/** "[13:33:14] AGENT: hi [13:34:00] USER: hello" (or "AGENT: ..\n\n USER: ..") -> "AI Agent: hi Caller: hello". */
export function normalizeVaaniTranscript(t: string): string {
  return t
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, "")
    .replace(/\b(?:AGENT|ASSISTANT):\s*/g, "AI Agent: ")
    .replace(/\b(?:USER|CUSTOMER|CALLER):\s*/g, "Caller: ")
    .replace(/\s+/g, " ")
    .trim();
}

const secretOk = (headers: Headers, url?: URL) => checkSecret(headers, url);

interface HistoryCall {
  call_id: string;
  from_number?: string | null;
  to_number?: string | null;
  call_type?: string;
  Start_time?: string | null;
  End_time?: string | null;
  user_picked_up_at?: string | null;
  duration_ms?: number | null;
  call_cost?: number | null;
}

const API = "https://api.vaanivoice.ai";

export function createVaaniAdapter(fetchImpl: typeof fetch = fetch): VoiceAdapter {
  return {
    name: "vaani",
    verify: (headers, _raw, url) => secretOk(headers, url),

    parse(body): VoiceEvent[] {
      const p = Payload.parse(body);
      const now = new Date().toISOString();
      // in-progress events: remember the caller's number and the pick-up time, to be joined to the end-of-call report by call id
      if (p.event === "call_started" && p.room_name) {
        return [{ type: "session", session: { providerCallId: p.room_name, callerPhone: p.phone_number ?? null, startedAt: now } }];
      }
      if (p.event === "user_picked_up_at" && p.room_name) {
        return [{ type: "session", session: { providerCallId: p.room_name, answeredAt: now } }];
      }
      if (p.event !== "call_postprocessing") return [{ type: "ignored", reason: `event ${p.event} is not the end-of-call event` }];
      const d = p.data ?? {};
      const id = d.call_id ?? p.call_id ?? d.room_name;
      if (!id) throw new Error("call_postprocessing without a call id");
      const durationSec = d.call_duration != null ? Math.round(d.call_duration / 1000) : null;
      const ended = p.timestamp && !Number.isNaN(Date.parse(p.timestamp)) ? new Date(p.timestamp) : new Date();
      const started = new Date(ended.getTime() - (durationSec ?? 0) * 1000);
      return [
        {
          type: "end_of_call_report",
          report: {
            providerCallId: id,
            callerPhone: null, // filled by enrich()
            startedAt: started.toISOString(),
            endedAt: ended.toISOString(),
            durationSec,
            transcript: normalizeVaaniTranscript(d.transcript ?? ""),
            answeredBy: "ai",
          },
        },
      ];
    },

    /** Look the call up in Vaani's call history (newest first) for the caller number, real times and cost. Best effort. */
    async enrich(ev) {
      if (ev.type !== "end_of_call_report") return ev;
      const key = process.env.VAANI_API_KEY;
      if (!key) return ev;
      try {
        for (let page = 1; page <= 3; page++) {
          const res = await fetchImpl(`${API}/api/call-history?page=${page}&page_size=50`, {
            headers: { "X-API-Key": key },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return ev;
          const body = (await res.json()) as { data?: HistoryCall[]; pagination?: { has_next?: boolean } };
          const hit = body.data?.find((c) => c.call_id === ev.report.providerCallId);
          if (hit) {
            const rate = Number(process.env.VAANI_CREDIT_TO_INR ?? "");
            return {
              type: "end_of_call_report",
              report: {
                ...ev.report,
                // for an inbound call the caller is the "from" number
                callerPhone: ((hit.call_type ?? "").toLowerCase().startsWith("out") ? hit.to_number : hit.from_number) ?? ev.report.callerPhone,
                startedAt: hit.Start_time ?? ev.report.startedAt,
                endedAt: hit.End_time ?? ev.report.endedAt,
                answeredAt: hit.user_picked_up_at ?? hit.Start_time ?? null,
                durationSec: hit.duration_ms != null ? Math.round(hit.duration_ms / 1000) : ev.report.durationSec,
                providerCost: hit.call_cost != null && rate > 0 ? { amount: hit.call_cost * rate, currency: "INR" } : null,
              },
            };
          }
          if (!body.pagination?.has_next) break;
        }
      } catch {
        /* network trouble: carry on with what the webhook gave us */
      }
      return ev;
    },
  };
}

export const vaaniAdapter = createVaaniAdapter();
