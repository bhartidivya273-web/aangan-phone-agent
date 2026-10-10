import { NextResponse } from "next/server";
import { checkSecret } from "@/lib/auth";
import { bookConsultation } from "@/lib/booking";
import { calIfConfigured } from "@/lib/calcom";
import { getConfig } from "@/lib/config";
import { productionDeps } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 10;

/** Tool for the voice assistant: book one consultation slot. Body JSON or form: start (exact value from the slots tool), name, phone?, notes?. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!checkSecret(req.headers, url)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = getConfig();
  if (!cfg.booking.enabled) return NextResponse.json({ ok: false, reason: "disabled", message: "Booking is switched off. Say a designer will follow up." });

  const raw = await req.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : url.searchParams.get(k));
  const deps = productionDeps();
  const r = await bookConsultation(
    { start: str("start") ?? "", name: str("name"), phone: str("phone"), notes: str("notes") },
    { store: deps.store, cfg, notifier: deps.notifier, designersChatId: deps.chats.designers || undefined, cal: calIfConfigured(cfg) },
  );
  if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason, message: r.message, alternatives: r.alternatives.map((s) => ({ start: s.start, say: s.label })) });
  return NextResponse.json({
    ok: true,
    booked: r.label,
    consultation: r.mode,
    instruction: `Tell the caller the consultation is booked for ${r.label}, as a ${r.mode} with a designer. Say it once.`,
  });
}
