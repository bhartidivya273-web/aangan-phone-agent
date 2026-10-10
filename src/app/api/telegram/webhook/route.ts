import { NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/handoff";
import { productionDeps } from "@/lib/runtime";

export const runtime = "nodejs";

type Chat = { id: number | string; type?: string; title?: string; first_name?: string };

/**
 * Telegram webhook: claim-by-reply and designer follow-ups. Register with setWebhook and secret_token = TELEGRAM_WEBHOOK_SECRET.
 * Setup helper: `/chatid` (or `/start`) in any chat makes the bot answer with that chat's id, and every chat the bot is
 * added to is written to the server log, so TELEGRAM_CHAT_ID / TELEGRAM_NIKHIL_CHAT_ID can be filled in without guessing.
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const update = await req.json().catch(() => null);
  if (!update) return NextResponse.json({ ok: false }, { status: 400 });

  const chat: Chat | undefined = update.message?.chat ?? update.my_chat_member?.chat;
  if (chat && (update.my_chat_member || /^\/(chatid|start)\b/.test(update.message?.text ?? ""))) {
    console.info(`[telegram] chat seen: id=${chat.id} type=${chat.type} title=${chat.title ?? chat.first_name ?? ""}`);
  }
  const deps = productionDeps();
  if (chat && /^\/(chatid|start)\b/.test(update.message?.text ?? "")) {
    await deps.notifier.send({ chatId: String(chat.id), text: `This chat's id is ${chat.id}` }).catch(() => undefined);
    return NextResponse.json({ ok: true, result: { action: "chatid" } });
  }

  const pattern = process.env.TELEGRAM_CLAIM_PATTERN ? new RegExp(process.env.TELEGRAM_CLAIM_PATTERN, "i") : undefined;
  const result = await handleTelegramUpdate(update, { ...deps, claimPattern: pattern });
  return NextResponse.json({ ok: true, result });
}
