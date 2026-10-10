import { slotLabel } from "./booking";
import type { Config } from "./config";
import { formatDate, formatTime } from "./time";
import type { BookingRow, CallRow, LeadRow } from "./types";

/**
 * HubSpot CRM sync (API v3, private-app access token). For each qualified lead: find the contact by phone (or create it), then add a note
 * with everything a founder needs, linked to the contact. Optional deal (HUBSPOT_CREATE_DEAL). Errors throw; the pipeline records them and a
 * cron job retries, so a HubSpot outage never loses a lead or breaks the call log.
 * Endpoints used: POST /crm/v3/objects/contacts/search, POST|PATCH /crm/v3/objects/contacts, POST /crm/v3/objects/notes,
 * PUT /crm/v4/objects/notes/{id}/associations/default/contacts/{id} (fallback), POST /crm/v3/objects/deals.
 */
const BASE = "https://api.hubapi.com";
const NOTE_TO_CONTACT = 202; // HubSpot-defined association type id
const DEAL_TO_CONTACT = 3;

export class HubSpotError extends Error {
  constructor(message: string, public status: number | null) {
    super(message);
  }
}

export const toE164 = (raw: string | null | undefined): string | null => {
  let d = (raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0")) d = d.slice(1); // domestic trunk prefix
  return d.length === 10 ? `+91${d}` : `+${d}`;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface HubSpotLead {
  name: string | null;
  phone: string | null;
  locality: string | null;
  callIso: string;
  noteHtml: string;
  existingContactId?: string | null;
  dealName?: string;
}

export function buildNoteHtml(call: Pick<CallRow, "id" | "flags" | "pricing_asked" | "started_at">, lead: Pick<LeadRow, "fields" | "name">, booking: Pick<BookingRow, "start_at"> | null, cfg: Config): string {
  const f = lead.fields;
  const when = new Date(call.started_at);
  const type = f.project_type ? String(f.project_type).replace(/_/g, " ") : "not given";
  const row = (k: string, v: unknown) => `${esc(k)}: ${v === null || v === undefined || v === "" ? "not given" : esc(v)}<br>`;
  return [
    `<b>New phone lead via the Aangan phone assistant</b><br>`,
    row("Call", `${formatDate(when, cfg)}, ${formatTime(when, cfg)} IST`),
    row("Name", lead.name ?? f.name),
    row("Locality", f.locality),
    row("Project", `${type}${f.carpet_area_sqft ? `, ~${f.carpet_area_sqft} sq ft carpet` : ""}`),
    row("Scope", f.scope),
    row("Timeline", f.timeline),
    row("Decision-maker", f.decision_maker ? `${f.decision_maker}${f.decision_maker_confirmed === true ? " (confirmed)" : f.decision_maker_confirmed === false ? " (not confirmed)" : ""}` : null),
    row("Source", f.referral_source),
    row("Pricing asked", call.pricing_asked ? "yes" : "no"),
    row("Flags", call.flags.length ? call.flags.join(", ") : "none"),
    booking ? row("Consultation booked", `${slotLabel(booking.start_at, cfg)} (${cfg.booking.mode})`) : row("Preferred slots", f.preferred_days),
    `Dashboard: ${esc(`${cfg.appBaseUrl}/dashboard/calls/${call.id}`)}`,
  ].join("\n");
}

export interface HubSpotResult {
  contactId: string;
  noteId: string;
  dealId?: string;
}

export function createHubSpot(token: string, createDeal = false, fetchImpl: typeof fetch = fetch) {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new HubSpotError(`network: ${(e as Error).message}`, null);
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  const fail = (what: string, r: { status: number; json: any }) =>
    new HubSpotError(`${what} failed (${r.status}): ${String(r.json?.message ?? r.json?.error ?? "").slice(0, 200)}`, r.status);

  return {
    async syncLead(lead: HubSpotLead): Promise<HubSpotResult> {
      const [first, ...rest] = (lead.name ?? "").trim().split(/\s+/).filter(Boolean);
      const phone = toE164(lead.phone);
      const props: Record<string, string> = {
        ...(first ? { firstname: first } : {}),
        ...(rest.length ? { lastname: rest.join(" ") } : {}),
        ...(phone ? { phone } : {}),
        ...(lead.locality ? { city: lead.locality } : {}),
      };

      // 1) find or create the contact (phone is the only identifier a phone call gives us)
      let contactId = lead.existingContactId ?? null;
      if (!contactId && phone) {
        const s = await call("POST", "/crm/v3/objects/contacts/search", {
          filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
          properties: ["firstname", "phone"], limit: 1, after: "0", sorts: [],
        });
        if (s.status >= 300) throw fail("contact search", s);
        contactId = s.json?.results?.[0]?.id ?? null;
      }
      if (contactId) {
        const u = await call("PATCH", `/crm/v3/objects/contacts/${contactId}`, { properties: props });
        if (u.status >= 300) throw fail("contact update", u);
      } else {
        const c = await call("POST", "/crm/v3/objects/contacts", { properties: { ...props, lifecyclestage: "lead", hs_lead_status: "NEW" } });
        if (c.status >= 300 || !c.json?.id) throw fail("contact create", c);
        contactId = String(c.json.id);
      }

      // 2) the note, linked to the contact
      const noteProps = { hs_timestamp: new Date(lead.callIso).toISOString(), hs_note_body: lead.noteHtml };
      let n = await call("POST", "/crm/v3/objects/notes", {
        properties: noteProps,
        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
      });
      let noteId: string | null = n.status < 300 ? String(n.json?.id ?? "") || null : null;
      if (!noteId) {
        // fallback: create the note bare, then link it with the "default association" endpoint (no type id needed)
        n = await call("POST", "/crm/v3/objects/notes", { properties: noteProps });
        if (n.status >= 300 || !n.json?.id) throw fail("note create", n);
        noteId = String(n.json.id);
        const a = await call("PUT", `/crm/v4/objects/notes/${noteId}/associations/default/contacts/${contactId}`);
        if (a.status >= 300) throw fail("note association", a);
      }

      // 3) optional deal (best effort; stage ids are those of HubSpot's default sales pipeline)
      let dealId: string | undefined;
      if (createDeal) {
        const d = await call("POST", "/crm/v3/objects/deals", {
          properties: { dealname: lead.dealName ?? `Aangan lead - ${lead.name ?? phone ?? "unknown"}`, pipeline: "default", dealstage: "appointmentscheduled" },
          associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_CONTACT }] }],
        });
        if (d.status < 300 && d.json?.id) dealId = String(d.json.id);
      }
      return { contactId, noteId, dealId };
    },
  };
}

export type HubSpotClient = ReturnType<typeof createHubSpot>;
