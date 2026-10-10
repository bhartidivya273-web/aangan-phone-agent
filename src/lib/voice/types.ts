/**
 * Provider-agnostic voice layer. A provider adapter turns whatever the telephony/voice vendor POSTs into these
 * normalised events; nothing outside src/lib/voice/ knows about a specific vendor.
 */
export interface Money {
  amount: number;
  currency: "USD" | "INR";
}

export type AnsweredBy = "ai" | "front_desk" | "none";

export interface EndOfCallReport {
  providerCallId: string;
  callerPhone: string | null;
  startedAt: string; // ISO
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSec?: number | null;
  /** Plain text ("AI Agent: ... Caller: ...") or speaker turns. */
  transcript: string | Array<{ speaker: string; text: string }>;
  providerCost?: Money | null;
  answeredBy?: AnsweredBy; // default "ai"
  /** Live-conversation LLM usage, if the provider ran our agent turns (optional). */
  agentUsage?: { model: string; input_tokens: number; output_tokens: number; cost_usd: number } | null;
}

/** One row of the telephony provider's call log (FR19): covers calls the AI never handled, e.g. answered by the front desk. */
export interface CallLogEntry {
  providerCallId: string;
  callerPhone: string | null;
  startedAt: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSec?: number | null;
  answeredBy: AnsweredBy;
  transcript?: string | null;
  providerCost?: Money | null;
}

/** Facts learned while the call is still running (e.g. Vaani's call_started carries the caller's number). */
export interface SessionInfo {
  providerCallId: string;
  callerPhone?: string | null;
  startedAt?: string | null;
  answeredAt?: string | null;
}

export type VoiceEvent =
  | { type: "session"; session: SessionInfo }
  | { type: "end_of_call_report"; report: EndOfCallReport }
  | { type: "call_log"; entry: CallLogEntry }
  | { type: "ignored"; reason: string };

export interface VoiceAdapter {
  /** Short stable id, stored in calls.provider and used with VOICE_PROVIDER. */
  readonly name: string;
  /** Authenticate the request (signature / shared secret). Must fail closed. */
  verify(headers: Headers, rawBody: string, url?: URL): boolean;
  /**
   * Optional: fill in what the vendor's webhook leaves out (caller number, real start time, cost) from the vendor's own API.
   * Best effort: it must never throw for a missing record; it returns the event unchanged instead.
   */
  enrich?(event: VoiceEvent): Promise<VoiceEvent>;
  /** Parse the vendor payload into normalised events. Throw on a malformed payload (the route answers 400). */
  parse(body: unknown): VoiceEvent[];
}
