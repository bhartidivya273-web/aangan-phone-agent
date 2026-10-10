import type { Slot } from "./booking";
import { slotLabel } from "./booking";
import type { Config } from "./config";

/**
 * Minimal Cal.com API v2 client (https://cal.com/docs/api-reference/v2). Versions per endpoint, from Cal.com's OpenAPI spec on 2026-10-10:
 *   GET  /v2/slots     header cal-api-version: 2024-09-04
 *   POST /v2/bookings  header cal-api-version: 2026-02-25
 * Authorization: Bearer <cal_...api key>. Cal.com enforces availability and blocks the calendar; this client only asks it.
 */
const BASE = "https://api.cal.com";
const SLOTS_VERSION = "2024-09-04";
const BOOKINGS_VERSION = "2026-02-25";

export type CalBookResult =
  | { ok: true; uid: string; start: string; end: string; status: string }
  | { ok: false; httpStatus: number | null; message: string };

export interface CalClient {
  slots(fromIso: string, toIso: string): Promise<Slot[]>;
  book(a: { startIso: string; name: string; phone: string | null; notes: string | null }): Promise<CalBookResult>;
}

export function createCalClient(cfg: Config, fetchImpl: typeof fetch = fetch): CalClient {
  const c = cfg.calcom;
  const headers = (version: string) => ({ Authorization: `Bearer ${c.apiKey}`, "cal-api-version": version, "content-type": "application/json" });
  return {
    async slots(fromIso, toIso) {
      const qs = new URLSearchParams({ eventTypeId: String(c.eventTypeId), start: fromIso, end: toIso, timeZone: c.timeZone, format: "range" });
      const res = await fetchImpl(`${BASE}/v2/slots?${qs}`, { headers: headers(SLOTS_VERSION), signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`cal.com slots ${res.status}`);
      const body = (await res.json()) as { data?: Record<string, Array<{ start: string; end?: string }>> };
      const out: Slot[] = [];
      for (const day of Object.values(body.data ?? {})) {
        for (const s of day) {
          const start = new Date(s.start);
          if (Number.isNaN(start.getTime())) continue;
          const end = s.end ? new Date(s.end) : new Date(start.getTime() + cfg.booking.slotMinutes * 60_000);
          out.push({ start: start.toISOString(), end: end.toISOString(), label: slotLabel(start.toISOString(), cfg) });
        }
      }
      return out.sort((a, b) => a.start.localeCompare(b.start));
    },

    async book({ startIso, name, phone, notes }) {
      const body = {
        start: startIso,
        eventTypeId: c.eventTypeId,
        attendee: {
          name,
          timeZone: c.timeZone,
          language: "en",
          ...(c.attendeeEmail ? { email: c.attendeeEmail } : {}),
          ...(phone ? { phoneNumber: phone } : {}),
        },
        metadata: { source: "aangan-phone-agent", ...(notes ? { notes: notes.slice(0, 480) } : {}), ...(phone ? { caller: phone } : {}) },
      };
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}/v2/bookings`, { method: "POST", headers: headers(BOOKINGS_VERSION), body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      } catch (e) {
        return { ok: false, httpStatus: null, message: `network: ${(e as Error).message}` };
      }
      const json = (await res.json().catch(() => ({}))) as { status?: string; data?: { uid?: string; start?: string; end?: string; status?: string }; error?: { message?: string } | string; message?: string };
      if (!res.ok || json.status === "error" || !json.data?.uid) {
        const msg = typeof json.error === "string" ? json.error : json.error?.message ?? json.message ?? `http ${res.status}`;
        return { ok: false, httpStatus: res.status, message: String(msg).slice(0, 300) };
      }
      return { ok: true, uid: json.data.uid, start: json.data.start ?? startIso, end: json.data.end ?? startIso, status: json.data.status ?? "accepted" };
    },
  };
}

/** The Cal.com client when Cal.com is the configured calendar, otherwise undefined (built-in scheduler). */
export function calIfConfigured(cfg: Config, fetchImpl: typeof fetch = fetch): CalClient | undefined {
  return cfg.booking.provider === "calcom" && cfg.calcom.apiKey && cfg.calcom.eventTypeId ? createCalClient(cfg, fetchImpl) : undefined;
}
