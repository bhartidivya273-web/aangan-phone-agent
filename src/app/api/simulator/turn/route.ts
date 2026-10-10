import { NextResponse } from "next/server";
import { agentTurn, newCallState, type AgentState } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Text-chat simulator turn. State is returned to the browser and sent back each turn (the server keeps nothing). */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ ok: false, error: "state too large" }, { status: 413 });
  const body = JSON.parse(raw || "{}") as { state?: AgentState | null; utterance?: string | null };
  const state = body.state ?? newCallState(new Date().toISOString());
  if (!Array.isArray(state.history) || state.history.length > 120) return NextResponse.json({ ok: false, error: "bad state" }, { status: 400 });
  try {
    const r = await agentTurn(state, body.state ? (body.utterance ?? "") : null);
    return NextResponse.json({ ok: true, say: r.say, state: r.state, closed: r.closed });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
