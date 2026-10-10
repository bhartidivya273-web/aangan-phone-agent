import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { productionDeps } from "@/lib/runtime";
import { getAdapter } from "@/lib/voice/registry";
import { handleVoiceEvents } from "@/lib/voice/webhook";

export const runtime = "nodejs";
export const maxDuration = 60; // classification + Telegram happen inside the request

/**
 * Voice provider webhook. Accepts end-of-call reports and telephony call-log rows (FR19) through the configured
 * adapter (VOICE_PROVIDER). Fails closed on authentication; idempotent on provider call id so provider retries are safe.
 */
export async function POST(req: Request) {
  let adapter;
  try {
    adapter = getAdapter();
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  const raw = await req.text();
  if (!adapter.verify(req.headers, raw, new URL(req.url))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let events;
  try {
    events = adapter.parse(JSON.parse(raw));
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) : [(e as Error).message];
    return NextResponse.json({ ok: false, error: "bad payload", detail }, { status: 400 });
  }

  const results = await handleVoiceEvents(events, adapter.name, productionDeps(), adapter.enrich?.bind(adapter));
  const failed = results.some((r) => r.status === "error");
  // 500 on a real failure so the provider retries; duplicates are harmless because of the idempotency check
  return NextResponse.json({ ok: !failed, results }, { status: failed ? 500 : 200 });
}
