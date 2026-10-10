import type { Config } from "./config";
import { dueTime, formatDate, formatTime } from "./time";
import type { Notifier } from "./telegram";
import { TelegramError } from "./telegram";
import type { Store } from "./store";
import type { CallRow, HandoffKind, HandoffRow, LeadRow } from "./types";
import { slotLabel } from "./booking";

const PROJECT_LABEL: Record<string, string> = {
  residential_full: "full home",
  residential_partial: "partial home",
  single_room: "single room",
  commercial: "commercial",
  other: "other",
  unknown: "type not given",
};

export interface NoteRecord {
  callTime: string;
  lead: Pick<LeadRow, "fields" | "call_count" | "first_call_at">;
  callerPhone: string | null;
  flags: string[];
  pricingAsked: boolean;
  isUpdate: boolean;
  callId: string;
  /** Consultation the assistant booked during the call (ISO start). */
  bookingStart?: string | null;
}

const NG = "not given";
const v = (x: string | number | null | undefined) => (x === null || x === undefined || x === "" ? NG : String(x));

/** Telegram note format from docs/PRD_build_spec.md. Plain text. */
export function buildHandoffNote(r: NoteRecord, cfg: Config): string {
  const f = r.lead.fields;
  const when = new Date(r.callTime);
  const head = r.isUpdate ? "UPDATED LEAD" : "NEW LEAD";
  const dm =
    f.decision_maker == null
      ? NG
      : `${f.decision_maker}${f.decision_maker_confirmed === true ? " (confirmed)" : f.decision_maker_confirmed === false ? " (not confirmed)" : ""}`;
  const area = f.carpet_area_sqft != null ? `~${f.carpet_area_sqft} sq ft carpet` : "area not given";
  const type = f.project_type ? PROJECT_LABEL[f.project_type] : "type not given";
  const lines = [
    `${head} - call ${formatDate(when, cfg)}, ${formatTime(when, cfg)}${r.isUpdate ? ` (call #${r.lead.call_count})` : ""}`,
    `${v(f.name)}, ${v(r.callerPhone ?? f.phone)}`,
    `${v(f.locality)}, ${type}, ${area}`,
    `Scope: ${v(f.scope)}`,
    `Timeline: ${v(f.timeline)}`,
    `Decision-maker: ${dm}`,
    `Source: ${v(f.referral_source)}`,
    `Pricing asked: ${r.pricingAsked ? "yes" : "no"}`,
    `Flags: ${r.flags.length ? r.flags.join(", ") : "none"}`,
    `Preferred slots: ${v(f.preferred_days)}`,
    ...(r.bookingStart ? [`Consultation booked: ${slotLabel(r.bookingStart, cfg)} (${cfg.booking.mode})`] : []),
    `Call summary: ${cfg.appBaseUrl}/dashboard/calls/${r.callId}`,
  ];
  if (r.isUpdate && r.lead.first_call_at) {
    lines.splice(1, 0, `Repeat caller - first call ${formatDate(new Date(r.lead.first_call_at), cfg)}. This replaces the earlier note.`);
  }
  return lines.join("\n");
}

/** Every label the spec requires on a qualified-lead note; used by tests. */
export const REQUIRED_NOTE_LABELS = [
  "NEW LEAD",
  "Scope:",
  "Timeline:",
  "Decision-maker:",
  "Source:",
  "Pricing asked:",
  "Flags:",
  "Preferred slots:",
  "Call summary:",
] as const;

export interface SendDeps {
  store: Store;
  notifier: Notifier;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

async function sendWithRetry(deps: SendDeps, args: Parameters<Notifier["send"]>[0]) {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await deps.notifier.send(args);
    } catch (e) {
      last = e;
      if (!(e instanceof TelegramError) || !e.retryable) break;
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

export interface SendHandoffArgs {
  text: string;
  chatId: string;
  kind: HandoffKind;
  leadId: string | null;
  callId: string | null;
  dueAt?: Date | null;
  replyToMessageId?: number;
}

/**
 * sendHandoff(): posts via the Telegram Bot API and records the attempt. Never throws on a Telegram failure:
 * the row is stored as 'failed' so the cron job can retry and the call log is still complete.
 */
export async function sendHandoff(deps: SendDeps, a: SendHandoffArgs): Promise<HandoffRow> {
  const now = (deps.now ?? (() => new Date()))();
  const base = {
    lead_id: a.leadId,
    call_id: a.callId,
    kind: a.kind,
    telegram_chat_id: a.chatId,
    note_text: a.text,
    due_at: a.dueAt ? a.dueAt.toISOString() : null,
    claimed_by: null,
    claimed_at: null,
    unclaimed_alert_sent_at: null,
  };
  try {
    const { messageId } = await sendWithRetry(deps, { chatId: a.chatId, text: a.text, replyToMessageId: a.replyToMessageId });
    return deps.store.insertHandoff({ ...base, status: "sent", telegram_message_id: messageId, sent_at: now.toISOString(), error: null });
  } catch (e) {
    return deps.store.insertHandoff({
      ...base,
      status: "failed",
      telegram_message_id: null,
      sent_at: null,
      error: (e as Error).message.slice(0, 500),
    });
  }
}

/** Re-send handoffs that failed earlier (called from the cron route). */
export async function retryFailedHandoffs(deps: SendDeps): Promise<number> {
  const failed = await deps.store.listFailedHandoffs();
  let ok = 0;
  for (const h of failed) {
    if (!h.telegram_chat_id) continue;
    try {
      const { messageId } = await sendWithRetry(deps, { chatId: h.telegram_chat_id, text: h.note_text });
      await deps.store.updateHandoff(h.id, {
        status: "sent",
        telegram_message_id: messageId,
        sent_at: (deps.now ?? (() => new Date()))().toISOString(),
        error: null,
      });
      ok++;
    } catch (e) {
      await deps.store.updateHandoff(h.id, { error: (e as Error).message.slice(0, 500) });
    }
  }
  return ok;
}

export function firstContactDue(sentAt: Date, cfg: Config): Date {
  return dueTime(sentAt, cfg.firstContactOfficeMinutes, cfg);
}

export function buildEscalationAlert(call: Pick<CallRow, "id" | "reason" | "caller_phone" | "extracted" | "started_at">, cfg: Config): { text: string; due: Date } {
  const started = new Date(call.started_at);
  const due = dueTime(started, cfg.escalationCallbackOfficeMinutes, cfg);
  const x = call.extracted;
  const text = [
    `ESCALATION - complaint call ${formatDate(started, cfg)}, ${formatTime(started, cfg)}`,
    `${v(x.name)}, ${v(call.caller_phone)}`,
    `${v(x.locality)}${x.scope ? `, ${x.scope}` : ""}`,
    `Why: ${call.reason ?? NG}`,
    `Needs a senior callback by ${formatDate(due, cfg)}, ${formatTime(due, cfg)} (proposed target).`,
    `Not a lead. Call summary: ${cfg.appBaseUrl}/dashboard/calls/${call.id}`,
  ].join("\n");
  return { text, due };
}

// ---- claim by reply -------------------------------------------------------------------------------------------

const DEFAULT_CLAIM = /\b(taking\s+it|take\s+it|i'?ll\s+take|i\s+will\s+take|claim(?:ed|ing)?|mine|on\s+it|got\s+it|i'?ve\s+got\s+this)\b/i;

export interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    reply_to_message?: { message_id: number };
  };
}

export type ClaimResult =
  | { action: "claimed"; handoffId: string; by: string; recorded: string[] }
  | { action: "already_claimed"; handoffId: string; by: string | null; recorded: string[] }
  | { action: "recorded"; handoffId: string; recorded: string[] }
  | { action: "ignored"; reason: string };

/**
 * Reply conventions that feed the dashboard (documented in the README). Free text in a reply to a note:
 *  - claim:        "taking it", "mine", "on it" ...
 *  - first contact: "called", "contacted", "spoke to them" ... (on an escalation: "called back")
 *  - consultation:  "consultation booked / scheduled / done"
 *  - fit verdict:   "good fit" / "poor fit" / "not a fit"
 *  - project:       "signed", "won", "project started"
 */
const CONTACT = /\b(called(?:\s+back)?|contacted|spoke(?:n)?\s+(?:to|with)|reached\s+out|messaged|whatsapped)\b/i;
const CONSULT = /\bconsultation\s+(?:is\s+)?(?:booked|scheduled|fixed|done|completed)\b/i;
const FIT_GOOD = /\bgood\s+fit\b/i;
const FIT_POOR = /\b(?:poor|bad)\s+fit\b|\bnot\s+a\s+(?:good\s+)?fit\b/i;
const SIGNED = /\b(?:signed|closed\s+won|project\s+(?:started|confirmed)|won\s+(?:it|the\s+project))\b/i;

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  deps: SendDeps & { claimPattern?: RegExp },
): Promise<ClaimResult> {
  const m = update.message;
  if (!m?.text || !m.reply_to_message) return { action: "ignored", reason: "not a reply" };
  const chatId = String(m.chat.id);
  const h = await deps.store.findHandoffByMessage(chatId, m.reply_to_message.message_id);
  if (!h || !["new", "updated", "escalation"].includes(h.kind)) return { action: "ignored", reason: "reply is not to a lead note" };

  const text = m.text;
  const isLeadNote = h.kind === "new" || h.kind === "updated";
  const wantsClaim = isLeadNote && (deps.claimPattern ?? DEFAULT_CLAIM).test(text);
  const wantsContact = CONTACT.test(text);
  const wantsConsult = isLeadNote && CONSULT.test(text);
  const fit: "good" | "poor" | null = FIT_POOR.test(text) ? "poor" : FIT_GOOD.test(text) ? "good" : null;
  const wantsSigned = isLeadNote && SIGNED.test(text);
  if (!wantsClaim && !wantsContact && !wantsConsult && !fit && !wantsSigned) return { action: "ignored", reason: "reply does not look like a claim or an update" };

  const by = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || `telegram:${m.from?.id ?? "unknown"}`;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const recorded: string[] = [];
  const say = (t: string) => deps.notifier.send({ chatId, text: t, replyToMessageId: m.message_id }).catch(() => undefined);

  let won: HandoffRow | null = null;
  let already = false;
  if (wantsClaim || (wantsContact && isLeadNote && !h.claimed_at)) {
    // saying you have already contacted the lead also claims it
    won = await deps.store.claimHandoff(h.id, by, at);
    already = !won;
    if (won) recorded.push("claimed");
  }
  const patch: Partial<HandoffRow> = {};
  if (wantsContact && !h.first_contact_at) {
    patch.first_contact_at = at;
    recorded.push(h.kind === "escalation" ? "callback_made" : "first_contact");
  }
  if (fit) {
    patch.fit_verdict = fit;
    recorded.push(`fit_${fit}`);
  }
  if (Object.keys(patch).length) await deps.store.updateHandoff(h.id, patch);

  if ((wantsConsult || wantsSigned) && h.lead_id) {
    const lp: Record<string, string> = {};
    if (wantsConsult) {
      lp.consultation_at = at;
      recorded.push("consultation");
    }
    if (wantsSigned) {
      lp.project_signed_at = at;
      recorded.push("project_signed");
    }
    await deps.store.updateLead(h.lead_id, lp);
  }

  if (won) {
    await say(`Claimed by ${by}.${recorded.length > 1 ? ` Recorded: ${recorded.filter((r) => r !== "claimed").join(", ")}.` : ""}`);
    return { action: "claimed", handoffId: h.id, by, recorded };
  }
  if (already && wantsClaim) {
    await say(`Already claimed by ${h.claimed_by ?? "someone"}.`);
    return { action: "already_claimed", handoffId: h.id, by: h.claimed_by, recorded };
  }
  if (recorded.length) {
    await say(`Recorded: ${recorded.join(", ")}.`);
    return { action: "recorded", handoffId: h.id, recorded };
  }
  return { action: "ignored", reason: "nothing new to record" };
}

// ---- unclaimed-lead alert to Nikhil ----------------------------------------------------------------------------

export async function alertUnclaimed(deps: SendDeps & { nikhilChatId: string; cfg: Config }): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.store.listUnclaimedDue(now.toISOString());
  for (const h of due) {
    const first = h.note_text.split("\n").slice(0, 3).join("\n");
    const text = `UNCLAIMED LEAD - no designer has claimed this past the first-contact target (${formatDate(new Date(h.due_at!), deps.cfg)}, ${formatTime(new Date(h.due_at!), deps.cfg)}).\n${first}`;
    await sendHandoff(deps, { text, chatId: deps.nikhilChatId, kind: "unclaimed_alert", leadId: h.lead_id, callId: h.call_id });
    await deps.store.markUnclaimedAlerted(h.id, now.toISOString());
  }
  return due.length;
}
