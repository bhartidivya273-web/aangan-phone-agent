import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { VoiceAdapter, VoiceEvent } from "./types";

const money = z.object({ amount: z.number().min(0), currency: z.enum(["USD", "INR"]) });
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date-time");

const Report = z.object({
  type: z.literal("end_of_call_report"),
  providerCallId: z.string().min(1),
  callerPhone: z.string().nullable().default(null),
  startedAt: iso,
  answeredAt: iso.nullable().optional(),
  endedAt: iso.nullable().optional(),
  durationSec: z.number().min(0).nullable().optional(),
  transcript: z.union([z.string(), z.array(z.object({ speaker: z.string(), text: z.string() }))]),
  providerCost: money.nullable().optional(),
  answeredBy: z.enum(["ai", "front_desk", "none"]).optional(),
  agentUsage: z.object({ model: z.string(), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }).nullable().optional(),
});

const Entry = z.object({
  type: z.literal("call_log"),
  providerCallId: z.string().min(1),
  callerPhone: z.string().nullable().default(null),
  startedAt: iso,
  answeredAt: iso.nullable().optional(),
  endedAt: iso.nullable().optional(),
  durationSec: z.number().min(0).nullable().optional(),
  answeredBy: z.enum(["ai", "front_desk", "none"]),
  transcript: z.string().nullable().optional(),
  providerCost: money.nullable().optional(),
});

const Payload = z.union([Report, Entry]);
const Batch = z.object({ events: z.array(Payload).min(1).max(500) });

/**
 * Stub adapter: a plain JSON contract used for the text simulator, tests and curl. A real provider adapter implements
 * the same two methods for its own payload format (see README "Swapping the voice provider").
 *
 * Auth: header `x-webhook-secret` must equal env VOICE_WEBHOOK_SECRET (constant-time compare). Missing secret = reject.
 */
export const stubAdapter: VoiceAdapter = {
  name: "stub",
  verify(headers) {
    const secret = process.env.VOICE_WEBHOOK_SECRET;
    const got = headers.get("x-webhook-secret");
    if (!secret || !got) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  parse(body): VoiceEvent[] {
    const parsed = "events" in (body as object) ? Batch.parse(body).events : [Payload.parse(body)];
    return parsed.map((p): VoiceEvent => {
      if (p.type === "end_of_call_report") {
        const { type: _t, ...report } = p;
        return { type: "end_of_call_report", report };
      }
      const { type: _t, ...entry } = p;
      return { type: "call_log", entry };
    });
  },
};
