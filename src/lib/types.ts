import type { Extracted, Outcome } from "./schema";

export type LeadStatus = "open" | "qualified" | "declined" | "escalated" | "existing_client" | "other";

export interface LeadRow {
  id: string;
  phone_normalized: string | null;
  name: string | null;
  fields: Partial<Extracted>;
  status: LeadStatus;
  flags: string[];
  call_count: number;
  first_call_at: string | null;
  last_call_at: string | null;
  consultation_at?: string | null;
  project_signed_at?: string | null;
  hubspot_contact_id?: string | null;
}

export interface CallRow {
  id: string;
  lead_id: string | null;
  source: "ai" | "front_desk";
  caller_phone: string | null;
  caller_phone_normalized: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  after_hours: boolean;
  transcript: string | null;
  classification_status: "ok" | "failed" | "pending";
  outcome: Outcome | null;
  underlying_outcome: Outcome | null;
  reason: string | null;
  extracted: Partial<Extracted>;
  flags: string[];
  pricing_asked: boolean;
  guards: string[];
  classifier_model: string | null;
  provider: string | null;
  provider_call_id: string | null;
  error: string | null;
  hubspot_contact_id?: string | null;
  hubspot_note_id?: string | null;
  hubspot_error?: string | null;
}

export type HandoffKind = "new" | "updated" | "escalation" | "unclaimed_alert" | "failure_alert" | "booking_alert";

export interface HandoffRow {
  id: string;
  lead_id: string | null;
  call_id: string | null;
  kind: HandoffKind;
  status: "sent" | "failed";
  telegram_chat_id: string | null;
  telegram_message_id: number | null;
  note_text: string;
  sent_at: string | null;
  due_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  unclaimed_alert_sent_at: string | null;
  error: string | null;
  /** Set when a designer replies that they have contacted the lead (or, for escalations, called back). */
  first_contact_at?: string | null;
  fit_verdict?: "good" | "poor" | null;
}

export interface CostRow {
  call_id: string;
  kind: "llm_classifier" | "llm_agent" | "voice" | "telephony";
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  minutes?: number | null;
  amount: number;
  currency: "USD" | "INR";
}

export interface CostRowFull extends CostRow {
  id?: string;
  created_at?: string;
}

/** Everything the dashboard needs for a window. */
export interface DashboardData {
  bookings?: BookingRow[];
  calls: CallRow[];
  leads: LeadRow[];
  handoffs: HandoffRow[];
  costs: CostRowFull[];
}

export interface BookingRow {
  id: string;
  start_at: string;
  end_at: string;
  status: "booked" | "cancelled";
  customer_name: string | null;
  customer_phone: string | null;
  customer_phone_normalized: string | null;
  notes: string | null;
  call_id: string | null;
  lead_id: string | null;
  created_at: string;
  external_provider?: string | null;
  external_id?: string | null;
}
