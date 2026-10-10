import { NextResponse } from "next/server";
import { checkSecret } from "@/lib/auth";
import { findSlots, parseWeekdays } from "@/lib/booking";
import { calIfConfigured } from "@/lib/calcom";
import { getConfig } from "@/lib/config";
import { productionDeps } from "@/lib/runtime";

export const runtime = "nodejs";
export const maxDuration = 10; // the voice provider expects a tool answer within 2-3 seconds

/**
 * Tool for the voice assistant: next free consultation slots.
 * GET  ?key=<secret>&weekdays=tuesday,thursday&part=morning|afternoon|evening&date=YYYY-MM-DD&limit=3
 * POST same fields as a JSON or form body (how Vaani's custom tools send their parameters); secret in the `x-webhook-secret` header or `?key=`.
 */
async function handle(req: Request, input: Record<string, unknown>) {
  const url = new URL(req.url);
  if (!checkSecret(req.headers, url)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = getConfig();
  if (!cfg.booking.enabled) return NextResponse.json({ ok: false, error: "booking is switched off", slots: [] });
  const get = (k: string) => {
    const v = input[k] ?? url.searchParams.get(k);
    const t = typeof v === "number" ? String(v) : v; // tool parameters may arrive as numbers or text
    return typeof t === "string" && t.trim() ? t.trim() : null;
  };
  const part = get("part")?.toLowerCase();
  const date = get("date");
  const limit = Math.min(6, Math.max(1, Number(get("limit")) || 3));
  const slots = await findSlots(
    productionDeps().store,
    cfg,
    new Date(),
    {
      weekdays: parseWeekdays(get("weekdays")),
      part: part === "morning" || part === "afternoon" || part === "evening" ? part : undefined,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      limit,
    },
    calIfConfigured(cfg),
  ).catch(() => null);
  if (slots === null) return NextResponse.json({ ok: false, error: "calendar unavailable", slots: [], instruction: "Say a designer will follow up to arrange a time." });
  return NextResponse.json({
    ok: true,
    consultation: cfg.booking.mode,
    slots: slots.map((s) => ({ start: s.start, say: s.label })),
    instruction: slots.length
      ? "Offer at most two or three of these. Read the 'say' text exactly. To book, pass the exact 'start' value."
      : "No slot matches. Say a designer will follow up to arrange a time.",
  });
}

export async function GET(req: Request) {
  return handle(req, {});
}

export async function POST(req: Request) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    /* an unreadable body just means "no filters" */
  }
  return handle(req, body);
}
