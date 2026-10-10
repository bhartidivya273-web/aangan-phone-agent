import { z } from "zod";

export const OUTCOMES = [
  "qualified",
  "ask_one_question",
  "not_a_fit",
  "timeline_too_short",
  "pricing_asked",
  "escalate",
  "existing_client",
  "other",
  "dropped_or_missed",
  "repeat_caller",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const PROJECT_TYPES = [
  "residential_full",
  "residential_partial",
  "single_room",
  "commercial",
  "other",
  "unknown",
] as const;

const str = z.string().trim().min(1).nullable();

export const ExtractedSchema = z.object({
  name: str,
  phone: str,
  locality: str,
  project_type: z.enum(PROJECT_TYPES).nullable(),
  scope: str,
  carpet_area_sqft: z.number().positive().nullable(),
  timeline: str,
  /** ISO date (YYYY-MM-DD) by which the caller needs the whole project COMPLETE / to move in; null if not stated or only a start date was given. */
  timeline_target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Computed in code from timeline_target_date and the call date; the model does not fill this. */
  timeline_weeks_from_call: z.number().min(0).nullable().default(null),
  decision_maker: str,
  decision_maker_confirmed: z.boolean().nullable(),
  referral_source: str,
  volunteered_budget: str,
  preferred_days: str,
  /** For vendor / existing-client / other calls: the message to pass on. */
  message_for_team: str,
});
export type Extracted = z.infer<typeof ExtractedSchema>;

export const ClassificationSchema = z.object({
  outcome: z.enum(OUTCOMES),
  reason: z.string().trim().min(1).max(400),
  extracted: ExtractedSchema,
  flags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(20),
  pricing_asked: z.boolean(),
  /** Only when outcome is repeat_caller: what the call would have been classified as otherwise. */
  underlying_outcome: z.enum(OUTCOMES).nullable().default(null),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const EMPTY_EXTRACTED: Extracted = {
  name: null,
  phone: null,
  locality: null,
  project_type: null,
  scope: null,
  carpet_area_sqft: null,
  timeline: null,
  timeline_target_date: null,
  timeline_weeks_from_call: null,
  decision_maker: null,
  decision_maker_confirmed: null,
  referral_source: null,
  volunteered_budget: null,
  preferred_days: null,
  message_for_team: null,
};

export interface PriorCall {
  date: string;
  outcome: string | null;
  summary: string;
}

export interface CallMeta {
  callId?: string;
  callerPhone: string | null;
  /** ISO timestamp the call started. Timeline arithmetic is done from this date. */
  callTime: string;
  durationSec?: number | null;
  source?: "ai" | "front_desk";
  afterHours?: boolean;
  priorCalls?: PriorCall[];
}
