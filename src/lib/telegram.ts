export interface SendArgs {
  chatId: string;
  text: string;
  replyToMessageId?: number;
}

/** Seam for tests; the real implementation talks to the Telegram Bot API. */
export interface Notifier {
  send(args: SendArgs): Promise<{ messageId: number }>;
}

export class TelegramError extends Error {
  constructor(message: string, public status: number | null, public retryable: boolean) {
    super(message);
  }
}

export function telegramNotifier(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Notifier {
  return {
    async send({ chatId, text, replyToMessageId }) {
      let res: Response;
      try {
        res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Plain text on purpose (no parse_mode): caller names and notes are untrusted and need no escaping.
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
          }),
        });
      } catch (e) {
        throw new TelegramError(`network error: ${(e as Error).message}`, null, true);
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id: number } };
      if (!res.ok || !body.ok || !body.result) {
        throw new TelegramError(
          `telegram ${res.status}: ${body.description ?? "unknown error"}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      return { messageId: body.result.message_id };
    },
  };
}

export function notifierFromEnv(env = process.env, fetchImpl: typeof fetch = fetch): Notifier {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
  return telegramNotifier(env.TELEGRAM_BOT_TOKEN, fetchImpl);
}

export function chatsFromEnv(env = process.env) {
  const designers = env.TELEGRAM_CHAT_ID ?? "";
  return { designers, nikhil: env.TELEGRAM_NIKHIL_CHAT_ID || designers };
}
