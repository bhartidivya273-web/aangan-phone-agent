import { NextResponse } from "next/server";
import { agentCostUsd, transcriptOf, type AgentState } from "@/lib/agent";
import { getConfig } from "@/lib/config";
import { processCall } from "@/lib/pipeline";
import { MemoryStore } from "@/lib/store";
import type { Notifier, SendArgs } from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Ends a simulated call: classifies it and builds the handoff exactly as a real call would, but against an in-memory store
 * and a capturing notifier. Nothing is saved and nothing is sent to Telegram, so rehearsals never pollute the dashboard.
 */
export async function POST(req: Request) {
  const { state } = (await req.json()) as { state: AgentState };
  if (!state || !Array.isArray(state.history) || state.history.length === 0) return NextResponse.json({ ok: false, error: "no conversation" }, { status: 400 });
  const cfg = getConfig();
  const sent: SendArgs[] = [];
  const notifier: Notifier = { async send(a) { sent.push(a); return { messageId: sent.length }; } };
  try {
    const r = await processCall(
      {
        transcript: transcriptOf(state),
        callerPhone: "+919999900000",
        startedAt: state.callStart,
        durationSec: Math.max(1, Math.round((Date.now() - Date.parse(state.callStart)) / 1000)),
        provider: "simulator",
        agentUsage: { model: cfg.modelAgent, input_tokens: state.usage.input_tokens, output_tokens: state.usage.output_tokens, cost_usd: agentCostUsd(state, cfg) },
      },
      { cfg, store: new MemoryStore(), notifier, chats: { designers: "designers", nikhil: "nikhil" } },
    );
    return NextResponse.json({
      ok: true,
      outcome: r.classification?.outcome ?? null,
      effectiveOutcome: r.effectiveOutcome,
      reason: r.classification?.reason ?? null,
      flags: r.classification?.flags ?? [],
      handoff: r.handoffKind,
      wouldSend: sent.map((s) => ({ to: s.chatId, text: s.text })),
      guards: state.guards,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
