import { getConfig } from "./config";
import { generateDemoData } from "./demo";
import { MemoryStore, SupabaseStore, type Store } from "./store";

export interface DashboardSource {
  store: Store;
  demo: boolean;
  now: Date;
}

/**
 * Real data from Supabase; or seeded demo data (in memory) when DASHBOARD_SOURCE=demo, or when Supabase is not configured
 * outside production. In production without Supabase it throws instead of silently showing fake numbers.
 */
export function getDashboardSource(env = process.env): DashboardSource {
  const now = new Date();
  const wantsDemo = env.DASHBOARD_SOURCE === "demo";
  const hasDb = !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
  if (!wantsDemo && hasDb) return { store: SupabaseStore.fromEnv(env), demo: false, now };
  if (!wantsDemo && env.NODE_ENV === "production") {
    throw new Error("Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Set them, or DASHBOARD_SOURCE=demo to show demo data.");
  }
  // Cached per server process for an hour, so call ids stay stable between the dashboard and the call-detail pages.
  const g = globalThis as unknown as { __aanganDemo?: { at: number; store: MemoryStore } };
  if (!g.__aanganDemo || now.getTime() - g.__aanganDemo.at > 3_600_000) {
    const store = new MemoryStore();
    const d = generateDemoData(now, getConfig(env));
    store.calls.push(...d.calls);
    for (const l of d.leads) store.leads.set(l.id, l);
    store.handoffs.push(...d.handoffs);
    store.costs.push(...d.costs);
    g.__aanganDemo = { at: now.getTime(), store };
  }
  return { store: g.__aanganDemo.store, demo: true, now };
}
