import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cls, deps, fakeLLM } from "./helpers";

const h = deps({ llm: fakeLLM(cls()) });
vi.mock("@/lib/runtime", () => ({ productionDeps: () => h.d }));

const post = (body: unknown, secret: string | null = "tg-secret") =>
  new Request("http://x/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(body) });

describe("POST /api/telegram/webhook", () => {
  beforeEach(() => vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "tg-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("401 without the right secret token", async () => {
    const { POST } = await import("../src/app/api/telegram/webhook/route");
    expect((await POST(post({}, null))).status).toBe(401);
    expect((await POST(post({}, "wrong"))).status).toBe(401);
  });
  it("/chatid replies with the chat id (setup helper)", async () => {
    const { POST } = await import("../src/app/api/telegram/webhook/route");
    const res = await POST(post({ message: { message_id: 1, text: "/chatid@AanganAI_Bot".replace("@AanganAI_Bot", ""), chat: { id: -100123, type: "supergroup", title: "Designers" } } }));
    expect((await res.json()).result.action).toBe("chatid");
    expect(h.notifier.sent.at(-1)).toMatchObject({ chatId: "-100123", text: "This chat's id is -100123" });
  });
  it("ordinary messages fall through to claim handling and are ignored", async () => {
    const { POST } = await import("../src/app/api/telegram/webhook/route");
    const res = await POST(post({ message: { message_id: 1, text: "hello", chat: { id: 5 } } }));
    expect((await res.json()).result).toMatchObject({ action: "ignored" });
  });
});
