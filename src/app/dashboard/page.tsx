import { getConfig } from "@/lib/config";
import { getDashboardSource } from "@/lib/dashboardSource";
import { computeDashboard } from "@/lib/metrics";
import { isPublicView } from "@/lib/publicView";
import { DashboardView } from "./DashboardView";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const days = Math.min(365, Math.max(1, Number((await searchParams).days) || 30));
  const cfg = getConfig();
  try {
    const src = getDashboardSource();
    const data = await src.store.listAll(new Date(src.now.getTime() - days * 86_400_000).toISOString());
    return <DashboardView m={computeDashboard(data, cfg, src.now, days)} demo={src.demo || data.calls.some((c) => c.provider === "demo")} tz={cfg.tzOffsetMinutes} redact={isPublicView()} />;
  } catch (e) {
    return (
      <div className="wrap">
        <h1>Dashboard unavailable</h1>
        <p className="bad">{(e as Error).message}</p>
      </div>
    );
  }
}
