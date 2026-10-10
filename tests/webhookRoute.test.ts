import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cls, deps, fakeLLM } from "./helpers";

const h = deps({ llm: fakeLLM(cls()) });
vi.mock("@/lib/runtime", () => ({ productionDeps: () => h.d }));

const body = { type: "end_of_call_report", providerCallId: "r-1", callerPhone: "9999900010", startedAt: "2026-09-03T09:11:00Z", transcript: "AI Agent: Hi. Caller: 3BHK Kothrud please." };
const post = (b: unknown, headers: Record<string, string> = { "x-webhook-secret": "s3cret" }) =>
  new Request("http://x/api/voice/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof b === "string" ? b : JSON.stringify(b) });

describe("POST /api/voice/webhook", () => {
  beforeEach(() => { vi.stubEnv("VOICE_WEBHOOK_SECRET", "s3cret"); vi.stubEnv("VOICE_PROVIDER", "stub"); });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without the secret; nothing is written", async () => {
    const { POST } = await import("../src/app/api/voice/webhook/route");
    const res = await POST(post(body, {}));
    expect(res.status).toBe(401);
    expect(h.store.calls).toHaveLength(0);
  });
  it("400 on a malformed payload", async () => {
    const { POST } = await import("../src/app/api/voice/webhook/route");
    expect((await POST(post({ type: "end_of_call_report" }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
  });
  it("200 and a processed result for a valid report; a retry is a harmless duplicate", async () => {
    const { POST } = await import("../src/app/api/voice/webhook/route");
    const ok = await POST(post(body));
    expect(ok.status).toBe(200);
    expect((await ok.json()).results[0]).toMatchObject({ status: "processed", outcome: "qualified" });
    const again = await POST(post(body));
    expect(again.status).toBe(200);
    expect((await again.json()).results[0].status).toBe("duplicate");
    expect(h.store.calls).toHaveLength(1);
  });
  it("500 when an event fails so the provider retries", async () => {
    const { POST } = await import("../src/app/api/voice/webhook/route");
    const orig = h.store.insertCall.bind(h.store);
    h.store.insertCall = async () => { throw new Error("db down"); };
    const res = await POST(post({ ...body, providerCallId: "r-2" }));
    expect(res.status).toBe(500);
    h.store.insertCall = orig;
  });
});
