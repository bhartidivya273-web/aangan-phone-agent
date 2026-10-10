import { NextResponse } from "next/server";
import { alertUnclaimed, retryFailedHandoffs } from "@/lib/handoff";
import { getConfig } from "@/lib/config";
import { retryHubSpot } from "@/lib/pipeline";
import { productionDeps } from "@/lib/runtime";

export const runtime = "nodejs";

/** Run every few minutes: alerts Nikhil about unclaimed leads past the first-contact target and retries failed Telegram and HubSpot sends. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const deps = productionDeps();
  const retried = await retryFailedHandoffs(deps);
  const hubspot = await retryHubSpot(deps).catch(() => 0);
  const alerted = await alertUnclaimed({ ...deps, nikhilChatId: deps.chats.nikhil, cfg: getConfig() });
  return NextResponse.json({ ok: true, retried, alerted, hubspot });
}
