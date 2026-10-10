import { getConfig } from "../src/lib/config";
import type { LLM } from "../src/lib/llm";
import { loadRules } from "../src/lib/rules";
import { EMPTY_EXTRACTED } from "../src/lib/schema";
import { MemoryStore } from "../src/lib/store";
import type { Notifier, SendArgs } from "../src/lib/telegram";
import type { ProcessDeps } from "../src/lib/pipeline";

export const cfg = getConfig({ MODEL_CLASSIFIER: "fake-model", APP_BASE_URL: "https://app.test" });
export const rules = loadRules();

export function cls(over: Record<string, unknown> = {}, extracted: Record<string, unknown> = {}) {
  return {
    outcome: "qualified",
    reason: "test reason",
    extracted: { ...EMPTY_EXTRACTED, name: "Priya", phone: "+919000000001", locality: "Kothrud", project_type: "residential_full", scope: "kitchen, living room, bedrooms", carpet_area_sqft: 1400, timeline: "by March", timeline_target_date: "2027-03-01", decision_maker: "owner (self + husband)", decision_maker_confirmed: true, ...extracted },
    flags: [],
    pricing_asked: false,
    underlying_outcome: null,
    ...over,
  };
}

/** Fake model that replies with the given objects/strings in order (last one repeats). */
export function fakeLLM(...replies: Array<object | string>): LLM & { calls: number; lastSystem: string; lastUser: string } {
  const f = {
    calls: 0,
    lastSystem: "",
    lastUser: "",
    async complete(req: Parameters<LLM["complete"]>[0]) {
      const r = replies[Math.min(f.calls, replies.length - 1)];
      f.calls++;
      f.lastSystem = req.system;
      f.lastUser = req.messages[0].content;
      return { text: typeof r === "string" ? r : JSON.stringify(r), usage: { input_tokens: 1000, output_tokens: 200 }, model: "fake-model" };
    },
  };
  return f;
}

export function fakeNotifier(opts: { failTimes?: number } = {}): Notifier & { sent: SendArgs[] } {
  let id = 100;
  let fails = opts.failTimes ?? 0;
  const n = {
    sent: [] as SendArgs[],
    async send(a: SendArgs) {
      if (fails > 0) {
        fails--;
        const { TelegramError } = await import("../src/lib/telegram");
        throw new TelegramError("telegram 500", 500, true);
      }
      n.sent.push(a);
      return { messageId: ++id };
    },
  };
  return n;
}

export function deps(over: Partial<ProcessDeps> & { llm: LLM }) {
  const store = new MemoryStore();
  const notifier = fakeNotifier();
  const d: ProcessDeps = { cfg, rules, store, notifier, chats: { designers: "DESIGNERS", nikhil: "NIKHIL" }, now: () => new Date("2026-09-03T09:00:00Z"), sleep: async () => {}, ...over };
  return { d, store: d.store as MemoryStore, notifier: d.notifier as ReturnType<typeof fakeNotifier> };
}
