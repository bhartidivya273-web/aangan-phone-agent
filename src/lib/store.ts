import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BookingRow, CallRow, CostRow, CostRowFull, DashboardData, HandoffRow, LeadRow } from "./types";

type New<T extends { id: string }> = Omit<T, "id"> & { id?: string };

/** Persistence seam. SupabaseStore is production; MemoryStore backs tests, replay and local simulation. */
export interface Store {
  findLeadByPhone(normalized: string): Promise<LeadRow | null>;
  saveLead(lead: New<LeadRow>): Promise<LeadRow>;
  insertCall(call: New<CallRow>): Promise<CallRow>;
  listCallsForLead(leadId: string): Promise<CallRow[]>;
  insertHandoff(h: New<HandoffRow>): Promise<HandoffRow>;
  findHandoffByMessage(chatId: string, messageId: number): Promise<HandoffRow | null>;
  latestNoteForLead(leadId: string): Promise<HandoffRow | null>;
  /** Atomic first-claim-wins. Returns the updated row, or null if it was already claimed. */
  claimHandoff(id: string, by: string, at: string): Promise<HandoffRow | null>;
  listUnclaimedDue(now: string): Promise<HandoffRow[]>;
  markUnclaimedAlerted(id: string, at: string): Promise<void>;
  updateHandoff(id: string, patch: Partial<HandoffRow>): Promise<HandoffRow>;
  listFailedHandoffs(): Promise<HandoffRow[]>;
  insertCosts(rows: CostRow[]): Promise<void>;
  updateLead(id: string, patch: Partial<LeadRow>): Promise<LeadRow>;
  getLead(id: string): Promise<LeadRow | null>;
  findCallByProviderId(provider: string, providerCallId: string): Promise<CallRow | null>;
  /** Dashboard read: everything since `sinceIso` (calls by start time, handoffs/costs by creation time). */
  listAll(sinceIso: string): Promise<DashboardData>;
  listBookings(fromIso: string, toIso: string): Promise<BookingRow[]>;
  /** Atomic: returns null when the slot is already at capacity. */
  bookSlot(a: { start: string; end: string; capacity: number; name: string; phone: string | null; phoneNormalized: string | null; notes: string | null }): Promise<BookingRow | null>;
  updateCall(id: string, patch: Partial<CallRow>): Promise<CallRow>;
  getBookingForCall(callId: string): Promise<BookingRow | null>;
  /** Qualified calls whose HubSpot sync failed and has not succeeded since. */
  listHubspotFailures(limit: number): Promise<CallRow[]>;
  /** Merge what we learn mid-call (never erases a value already known). */
  upsertVoiceSession(a: { provider: string; providerCallId: string; callerPhone?: string | null; startedAt?: string | null; answeredAt?: string | null }): Promise<void>;
  getVoiceSession(provider: string, providerCallId: string): Promise<{ callerPhone: string | null; startedAt: string | null; answeredAt: string | null } | null>;
  insertBooking(b: Omit<BookingRow, "id" | "created_at">): Promise<BookingRow>;
  findUnlinkedBookings(fromIso: string, toIso: string): Promise<BookingRow[]>;
  updateBooking(id: string, patch: Partial<BookingRow>): Promise<BookingRow>;
  getCallDetail(id: string): Promise<{ call: CallRow; costs: CostRowFull[]; handoffs: HandoffRow[]; lead: LeadRow | null } | null>;
}

export class MemoryStore implements Store {
  leads = new Map<string, LeadRow>();
  calls: CallRow[] = [];
  handoffs: HandoffRow[] = [];
  costs: CostRow[] = [];

  async findLeadByPhone(n: string) {
    return [...this.leads.values()].find((l) => l.phone_normalized === n) ?? null;
  }
  async saveLead(lead: New<LeadRow>) {
    const row = { ...lead, id: lead.id ?? randomUUID() } as LeadRow;
    this.leads.set(row.id, row);
    return row;
  }
  async insertCall(call: New<CallRow>) {
    const row = { ...call, id: call.id ?? randomUUID() } as CallRow;
    this.calls.push(row);
    return row;
  }
  async listCallsForLead(leadId: string) {
    return this.calls.filter((c) => c.lead_id === leadId).sort((a, b) => a.started_at.localeCompare(b.started_at));
  }
  async insertHandoff(h: New<HandoffRow>) {
    const row = { ...h, id: h.id ?? randomUUID() } as HandoffRow;
    this.handoffs.push(row);
    return row;
  }
  async findHandoffByMessage(chatId: string, messageId: number) {
    return this.handoffs.find((h) => h.telegram_chat_id === chatId && h.telegram_message_id === messageId) ?? null;
  }
  async latestNoteForLead(leadId: string) {
    const notes = this.handoffs.filter(
      (h) => h.lead_id === leadId && (h.kind === "new" || h.kind === "updated") && h.status === "sent",
    );
    return notes.at(-1) ?? null;
  }
  async claimHandoff(id: string, by: string, at: string) {
    const h = this.handoffs.find((x) => x.id === id);
    if (!h || h.claimed_at) return null;
    h.claimed_by = by;
    h.claimed_at = at;
    return h;
  }
  async listUnclaimedDue(now: string) {
    return this.handoffs.filter(
      (h) =>
        (h.kind === "new" || h.kind === "updated") &&
        h.status === "sent" &&
        !h.claimed_at &&
        !h.unclaimed_alert_sent_at &&
        h.due_at !== null &&
        h.due_at <= now,
    );
  }
  async markUnclaimedAlerted(id: string, at: string) {
    const h = this.handoffs.find((x) => x.id === id);
    if (h) h.unclaimed_alert_sent_at = at;
  }
  async updateHandoff(id: string, patch: Partial<HandoffRow>) {
    const h = this.handoffs.find((x) => x.id === id);
    if (!h) throw new Error("handoff not found");
    Object.assign(h, patch);
    return h;
  }
  async listFailedHandoffs() {
    return this.handoffs.filter((h) => h.status === "failed" && (h.kind === "new" || h.kind === "updated" || h.kind === "escalation"));
  }
  async insertCosts(rows: CostRow[]) {
    this.costs.push(...rows.map((r) => ({ ...r, created_at: new Date().toISOString() })));
  }
  async updateLead(id: string, patch: Partial<LeadRow>) {
    const l = this.leads.get(id);
    if (!l) throw new Error("lead not found");
    Object.assign(l, patch);
    return l;
  }
  async getLead(id: string) {
    return this.leads.get(id) ?? null;
  }
  async findCallByProviderId(provider: string, providerCallId: string) {
    return this.calls.find((c) => c.provider === provider && c.provider_call_id === providerCallId) ?? null;
  }
  async listAll(sinceIso: string): Promise<DashboardData> {
    const calls = this.calls.filter((c) => c.started_at >= sinceIso);
    const ids = new Set(calls.map((c) => c.id));
    return {
      calls,
      leads: [...this.leads.values()],
      handoffs: this.handoffs.filter((h) => (h.call_id ? ids.has(h.call_id) : true)),
      costs: this.costs.filter((c) => ids.has(c.call_id)),
    };
  }
  bookings: BookingRow[] = [];
  async listBookings(fromIso: string, toIso: string) {
    return this.bookings.filter((b) => b.status === "booked" && b.start_at >= fromIso && b.start_at <= toIso);
  }
  async bookSlot(a: { start: string; end: string; capacity: number; name: string; phone: string | null; phoneNormalized: string | null; notes: string | null }) {
    if (this.bookings.filter((b) => b.status === "booked" && b.start_at === a.start).length >= a.capacity) return null;
    const row: BookingRow = { id: randomUUID(), start_at: a.start, end_at: a.end, status: "booked", customer_name: a.name, customer_phone: a.phone, customer_phone_normalized: a.phoneNormalized, notes: a.notes, call_id: null, lead_id: null, created_at: new Date().toISOString() };
    this.bookings.push(row);
    return row;
  }
  voiceSessions = new Map<string, { callerPhone: string | null; startedAt: string | null; answeredAt: string | null }>();
  async upsertVoiceSession(a: { provider: string; providerCallId: string; callerPhone?: string | null; startedAt?: string | null; answeredAt?: string | null }) {
    const k = `${a.provider}:${a.providerCallId}`;
    const cur = this.voiceSessions.get(k) ?? { callerPhone: null, startedAt: null, answeredAt: null };
    this.voiceSessions.set(k, { callerPhone: a.callerPhone ?? cur.callerPhone, startedAt: cur.startedAt ?? a.startedAt ?? null, answeredAt: a.answeredAt ?? cur.answeredAt });
  }
  async getVoiceSession(provider: string, providerCallId: string) {
    return this.voiceSessions.get(`${provider}:${providerCallId}`) ?? null;
  }
  async updateCall(id: string, patch: Partial<CallRow>) {
    const c = this.calls.find((x) => x.id === id);
    if (!c) throw new Error("call not found");
    Object.assign(c, patch);
    return c;
  }
  async getBookingForCall(callId: string) {
    return this.bookings.find((b) => b.call_id === callId && b.status === "booked") ?? null;
  }
  async listHubspotFailures(limit: number) {
    return this.calls.filter((c) => !!c.hubspot_error && !c.hubspot_note_id).slice(0, limit);
  }
  async insertBooking(b: Omit<BookingRow, "id" | "created_at">) {
    const row: BookingRow = { ...b, id: randomUUID(), created_at: new Date().toISOString() };
    this.bookings.push(row);
    return row;
  }
  async findUnlinkedBookings(fromIso: string, toIso: string) {
    return this.bookings.filter((b) => b.status === "booked" && !b.call_id && b.created_at >= fromIso && b.created_at <= toIso);
  }
  async updateBooking(id: string, patch: Partial<BookingRow>) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new Error("booking not found");
    Object.assign(b, patch);
    return b;
  }
  async getCallDetail(id: string) {
    const call = this.calls.find((c) => c.id === id);
    if (!call) return null;
    return {
      call,
      costs: this.costs.filter((c) => c.call_id === id),
      handoffs: this.handoffs.filter((h) => h.call_id === id),
      lead: call.lead_id ? (this.leads.get(call.lead_id) ?? null) : null,
    };
  }
}

function fail(op: string, error: { message: string } | null): asserts error is null {
  if (error) throw new Error(`supabase ${op}: ${error.message}`);
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  static fromEnv(env = process.env): SupabaseStore {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async findLeadByPhone(n: string) {
    const { data, error } = await this.db.from("leads").select("*").eq("phone_normalized", n).maybeSingle();
    fail("findLeadByPhone", error);
    return (data as LeadRow | null) ?? null;
  }
  async saveLead(lead: New<LeadRow>) {
    const { data, error } = await this.db
      .from("leads")
      .upsert({ ...lead, updated_at: new Date().toISOString() })
      .select()
      .single();
    fail("saveLead", error);
    return data as LeadRow;
  }
  async insertCall(call: New<CallRow>) {
    const { data, error } = await this.db.from("calls").insert(call).select().single();
    fail("insertCall", error);
    return data as CallRow;
  }
  async listCallsForLead(leadId: string) {
    const { data, error } = await this.db.from("calls").select("*").eq("lead_id", leadId).order("started_at");
    fail("listCallsForLead", error);
    return (data ?? []) as CallRow[];
  }
  async insertHandoff(h: New<HandoffRow>) {
    const { data, error } = await this.db.from("handoffs").insert(h).select().single();
    fail("insertHandoff", error);
    return data as HandoffRow;
  }
  async findHandoffByMessage(chatId: string, messageId: number) {
    const { data, error } = await this.db
      .from("handoffs")
      .select("*")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_message_id", messageId)
      .maybeSingle();
    fail("findHandoffByMessage", error);
    return (data as HandoffRow | null) ?? null;
  }
  async latestNoteForLead(leadId: string) {
    const { data, error } = await this.db
      .from("handoffs")
      .select("*")
      .eq("lead_id", leadId)
      .in("kind", ["new", "updated"])
      .eq("status", "sent")
      .order("created_at", { ascending: false })
      .limit(1);
    fail("latestNoteForLead", error);
    return ((data ?? [])[0] as HandoffRow | undefined) ?? null;
  }
  async claimHandoff(id: string, by: string, at: string) {
    const { data, error } = await this.db
      .from("handoffs")
      .update({ claimed_by: by, claimed_at: at })
      .eq("id", id)
      .is("claimed_at", null)
      .select();
    fail("claimHandoff", error);
    return ((data ?? [])[0] as HandoffRow | undefined) ?? null;
  }
  async listUnclaimedDue(now: string) {
    const { data, error } = await this.db
      .from("handoffs")
      .select("*")
      .in("kind", ["new", "updated"])
      .eq("status", "sent")
      .is("claimed_at", null)
      .is("unclaimed_alert_sent_at", null)
      .lte("due_at", now);
    fail("listUnclaimedDue", error);
    return (data ?? []) as HandoffRow[];
  }
  async markUnclaimedAlerted(id: string, at: string) {
    const { error } = await this.db.from("handoffs").update({ unclaimed_alert_sent_at: at }).eq("id", id);
    fail("markUnclaimedAlerted", error);
  }
  async updateHandoff(id: string, patch: Partial<HandoffRow>) {
    const { data, error } = await this.db.from("handoffs").update(patch).eq("id", id).select().single();
    fail("updateHandoff", error);
    return data as HandoffRow;
  }
  async listFailedHandoffs() {
    const { data, error } = await this.db
      .from("handoffs")
      .select("*")
      .eq("status", "failed")
      .in("kind", ["new", "updated", "escalation"]);
    fail("listFailedHandoffs", error);
    return (data ?? []) as HandoffRow[];
  }
  async insertCosts(rows: CostRow[]) {
    if (rows.length === 0) return;
    const { error } = await this.db.from("costs").insert(rows);
    fail("insertCosts", error);
  }
  async updateLead(id: string, patch: Partial<LeadRow>) {
    const { data, error } = await this.db.from("leads").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    fail("updateLead", error);
    return data as LeadRow;
  }
  async getLead(id: string) {
    const { data, error } = await this.db.from("leads").select("*").eq("id", id).maybeSingle();
    fail("getLead", error);
    return (data as LeadRow | null) ?? null;
  }
  async findCallByProviderId(provider: string, providerCallId: string) {
    const { data, error } = await this.db.from("calls").select("*").eq("provider", provider).eq("provider_call_id", providerCallId).maybeSingle();
    fail("findCallByProviderId", error);
    return (data as CallRow | null) ?? null;
  }
  /** PostgREST returns at most 1000 rows per request, so page through. */
  private async page<T>(table: string, build: (q: any) => any): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(this.db.from(table).select("*")).range(from, from + 999);
      fail(`list ${table}`, error);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) return out;
    }
  }
  async listAll(sinceIso: string): Promise<DashboardData> {
    const calls = await this.page<CallRow>("calls", (q) => q.gte("started_at", sinceIso).order("started_at"));
    const [leads, handoffs, costs] = await Promise.all([
      this.page<LeadRow>("leads", (q) => q.gte("last_call_at", sinceIso).order("id")),
      this.page<HandoffRow>("handoffs", (q) => q.gte("created_at", sinceIso).order("created_at")),
      this.page<CostRowFull>("costs", (q) => q.gte("created_at", sinceIso).order("created_at")),
    ]);
    return { calls, leads, handoffs, costs };
  }
  async listBookings(fromIso: string, toIso: string) {
    const { data, error } = await this.db.from("bookings").select("*").eq("status", "booked").gte("start_at", fromIso).lte("start_at", toIso);
    fail("listBookings", error);
    return (data ?? []) as BookingRow[];
  }
  async bookSlot(a: { start: string; end: string; capacity: number; name: string; phone: string | null; phoneNormalized: string | null; notes: string | null }) {
    const { data: id, error } = await this.db.rpc("book_slot", { p_start: a.start, p_end: a.end, p_capacity: a.capacity, p_name: a.name, p_phone: a.phone, p_phone_norm: a.phoneNormalized, p_notes: a.notes });
    fail("bookSlot", error);
    if (!id) return null;
    const { data, error: e2 } = await this.db.from("bookings").select("*").eq("id", id as string).single();
    fail("bookSlot read", e2);
    return data as BookingRow;
  }
  async upsertVoiceSession(a: { provider: string; providerCallId: string; callerPhone?: string | null; startedAt?: string | null; answeredAt?: string | null }) {
    const cur = await this.getVoiceSession(a.provider, a.providerCallId);
    const { error } = await this.db.from("voice_sessions").upsert({
      provider: a.provider,
      provider_call_id: a.providerCallId,
      caller_phone: a.callerPhone ?? cur?.callerPhone ?? null,
      started_at: cur?.startedAt ?? a.startedAt ?? null,
      answered_at: a.answeredAt ?? cur?.answeredAt ?? null,
    });
    fail("upsertVoiceSession", error);
  }
  async getVoiceSession(provider: string, providerCallId: string) {
    const { data, error } = await this.db.from("voice_sessions").select("*").eq("provider", provider).eq("provider_call_id", providerCallId).maybeSingle();
    fail("getVoiceSession", error);
    return data ? { callerPhone: data.caller_phone as string | null, startedAt: data.started_at as string | null, answeredAt: data.answered_at as string | null } : null;
  }
  async updateCall(id: string, patch: Partial<CallRow>) {
    const { data, error } = await this.db.from("calls").update(patch).eq("id", id).select().single();
    fail("updateCall", error);
    return data as CallRow;
  }
  async getBookingForCall(callId: string) {
    const { data, error } = await this.db.from("bookings").select("*").eq("call_id", callId).eq("status", "booked").limit(1);
    fail("getBookingForCall", error);
    return ((data ?? [])[0] as BookingRow | undefined) ?? null;
  }
  async listHubspotFailures(limit: number) {
    const { data, error } = await this.db.from("calls").select("*").not("hubspot_error", "is", null).is("hubspot_note_id", null).order("started_at", { ascending: false }).limit(limit);
    fail("listHubspotFailures", error);
    return (data ?? []) as CallRow[];
  }
  async insertBooking(b: Omit<BookingRow, "id" | "created_at">) {
    const { data, error } = await this.db.from("bookings").insert(b).select().single();
    fail("insertBooking", error);
    return data as BookingRow;
  }
  async findUnlinkedBookings(fromIso: string, toIso: string) {
    const { data, error } = await this.db.from("bookings").select("*").eq("status", "booked").is("call_id", null).gte("created_at", fromIso).lte("created_at", toIso);
    fail("findUnlinkedBookings", error);
    return (data ?? []) as BookingRow[];
  }
  async updateBooking(id: string, patch: Partial<BookingRow>) {
    const { data, error } = await this.db.from("bookings").update(patch).eq("id", id).select().single();
    fail("updateBooking", error);
    return data as BookingRow;
  }
  async getCallDetail(id: string) {
    const { data: call, error } = await this.db.from("calls").select("*").eq("id", id).maybeSingle();
    fail("getCallDetail", error);
    if (!call) return null;
    const [costs, handoffs, lead] = await Promise.all([
      this.db.from("costs").select("*").eq("call_id", id),
      this.db.from("handoffs").select("*").eq("call_id", id),
      (call as CallRow).lead_id ? this.getLead((call as CallRow).lead_id!) : Promise.resolve(null),
    ]);
    return { call: call as CallRow, costs: (costs.data ?? []) as CostRowFull[], handoffs: (handoffs.data ?? []) as HandoffRow[], lead };
  }
}
