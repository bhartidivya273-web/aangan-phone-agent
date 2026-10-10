import { describe, expect, it } from "vitest";
import { agentTurn, buildAgentSystemPrompt, newCallState, transcriptOf, type AgentState } from "../src/lib/agent";
import { findPriceLeaks } from "../src/lib/priceFilter";
import { enforceOneQuestion, findPromiseViolations } from "../src/lib/promiseFilter";
import { bookingOffer } from "../src/lib/rules";
import { cfg, fakeLLM, rules } from "./helpers";

const agentCfg = { ...cfg, modelAgent: "fake-agent" };
const START = "2026-09-10T06:02:00Z"; // Thu 11:32am IST, office hours
const AFTER = "2026-09-10T17:17:00Z"; // Thu 10:47pm IST

const t = (say: string, over: Record<string, unknown> = {}) => ({ say, intent: "continue", price_asked: false, close: false, ...over });
const deps = (llm: ReturnType<typeof fakeLLM>, now = START) => ({ llm, rules, config: agentCfg, now: () => new Date(now) });

/** Plays caller lines against a scripted model; returns every agent line and the final state. */
async function run(replies: Array<object | string>, callerLines: string[], now = START) {
  const llm = fakeLLM(...replies);
  let { say, state } = await agentTurn(newCallState(now), null, deps(llm, now));
  const said = [say];
  for (const line of callerLines) {
    const r = await agentTurn(state, line, deps(llm, now));
    state = r.state;
    said.push(r.say);
  }
  return { said, state, llm };
}

describe("agentTurn: greeting and disclosure (FR3)", () => {
  it("first turn is the fixed greeting from context/agent.md, says it is an AI assistant, and makes no model call", async () => {
    const llm = fakeLLM(t("x"));
    const r = await agentTurn(newCallState(START), null, deps(llm));
    expect(r.say).toMatch(/Aangan Studio/);
    expect(r.say).toMatch(/AI assistant/);
    expect(llm.calls).toBe(0);
    expect(r.state.history).toHaveLength(1);
  });
  it("greeting is read from the file at runtime (editable without code)", async () => {
    const edited = { ...rules, agent: rules.agent.replace(/Hello, you've reached Aangan Studio\./, "Namaste, Aangan Studio here.") };
    const r = await agentTurn(newCallState(START), null, { llm: fakeLLM(t("x")), rules: edited, config: agentCfg });
    expect(r.say.startsWith("Namaste, Aangan Studio here.")).toBe(true);
  });
});

describe("agentTurn: one question at a time", () => {
  it("passes a single question through unchanged", async () => {
    const { said } = await run([t("Lovely. Which area is the flat in?")], ["I want to redo my flat"]);
    expect(said[1]).toBe("Lovely. Which area is the flat in?");
  });
  it("trims a stacked reply to the first question and records the guard", async () => {
    const { said, state } = await run([t("Good scope. Which area is it in? And how big is the flat?")], ["Full redesign"]);
    expect(said[1]).toBe("Good scope. Which area is it in?");
    expect(state.guards).toContain("one_question_trimmed");
  });
  it("enforceOneQuestion leaves statements and single questions alone", () => {
    expect(enforceOneQuestion("Thanks, noted.").trimmed).toBe(false);
    expect(enforceOneQuestion("Is it a 3BHK?").trimmed).toBe(false);
    expect(enforceOneQuestion("Is it a 3BHK? Or a 2BHK?").text).toBe("Is it a 3BHK?");
  });
});

describe("agentTurn: price deflection (never a number)", () => {
  const asked = (extra: Record<string, unknown> = {}) => t("It is about Rs 2000 per sq ft.", { price_asked: true, ...extra });

  it("1st ask: exactly the approved line from pricing.md", async () => {
    const { said } = await run([asked()], ["How much will a 2BHK cost?"]);
    expect(said[1]).toBe(rules.approvedPriceLine);
  });
  it("2nd ask: the booking offer once more, then moves on with the next question; 3rd+: just moves on", async () => {
    const { said, state } = await run(
      [asked(), t("Sure. Which area is the flat in?", { price_asked: true }), t("Which area is the flat in?", { price_asked: true }), t("How big is it?", { price_asked: true })],
      ["How much?", "Just a rough range please", "Is it 20 lakh or 30?", "Come on, ballpark?"],
    );
    expect(said[1]).toBe(rules.approvedPriceLine);
    expect(said[2]).toBe(`${bookingOffer(rules.approvedPriceLine)} Sure. Which area is the flat in?`);
    expect(said[3]).toBe("Which area is the flat in?");
    expect(said[4]).toBe("How big is it?");
    expect(state.priceAsks).toBe(4);
    expect(state.signals).toContain("pricing_asked");
    for (const line of said) expect(findPriceLeaks(line)).toEqual([]);
  });
  it("a model that tries to leak a figure on a later ask is replaced by the approved line (guard recorded)", async () => {
    const { said, state } = await run(
      [asked(), asked(), t("Typically 3x for premium, around Rs 2400 per sq ft.", { price_asked: true })],
      ["How much?", "Range?", "Come on"],
    );
    expect(said[3]).toBe(rules.approvedPriceLine);
    expect(state.guards.some((g) => g.startsWith("price_filter_replaced"))).toBe(true);
    for (const line of said) expect(findPriceLeaks(line)).toEqual([]);
  });
  it("a leak on a turn where the caller did NOT ask about price is still blocked", async () => {
    const { said } = await run([t("A 2BHK usually costs 8 to 12 lakh. Which area is it in?")], ["I have a 2BHK"]);
    expect(said[1]).toBe(rules.approvedPriceLine);
    expect(findPriceLeaks(said[1])).toEqual([]);
  });
  it("the agent prompt never contains the internal pricing guide", () => {
    const p = buildAgentSystemPrompt(rules, agentCfg);
    expect(p).not.toContain("Standard specification");
    expect(p).not.toContain("Indicative range");
  });
});

describe("agentTurn: never promises a time or slot", () => {
  it("keeps the harmless sentences and drops only the promise", async () => {
    const { said } = await run([t("Great scope. I've booked you for tomorrow at 4pm. Which area is the flat in?")], ["ok"]);
    expect(said[1]).toBe("Great scope. Which area is the flat in?");
  });
  it.each([
    "I've booked you for tomorrow at 4pm.",
    "Your consultation is confirmed for Saturday.",
    "A designer will call you within 30 minutes.",
    "We will get back to you shortly.",
    "I can schedule it for Monday afternoon.",
  ])("replaces: %s", async (promise) => {
    const { said, state } = await run([t(promise)], ["ok"]);
    expect(said[1]).toBe("I'll note that down, and a designer will confirm the timing with you directly.");
    expect(state.guards.some((g) => g.startsWith("promise_filter"))).toBe(true);
  });
  it.each([
    "I have noted Tuesdays and Thursdays, specifically the thirteen and fifteen of October.",
    "Your consultation could be on 13th October.",
    "How about October 15 for the visit?",
    "We can do it on the 20th of November.",
  ])("replaces a made-up calendar date: %s", async (promise) => {
    const { said } = await run([t(promise)], ["ok"]);
    expect(said[1]).toBe("I'll note that down, and a designer will confirm the timing with you directly.");
  });
  it.each([
    "Which days of the week would suit you for the consultation?",
    "You need it complete by March, got it.",
    "Is the end of March a hard deadline?",
    "The flat is two years old and has three bedrooms.",
    "I've noted your preferred days, and a designer will follow up with you.",
    "Would weekends work better for you?",
  ])("allows: %s", (ok) => {
    expect(findPromiseViolations(ok)).toEqual([]);
  });
});

describe("agentTurn: human requested / not understood (FR22)", () => {
  it("human request switches to take-message mode and logs the signal", async () => {
    const { state } = await run([t("Of course. May I have your name?", { intent: "human_requested" })], ["Can I talk to a real person?"]);
    expect(state.mode).toBe("take_message");
    expect(state.signals).toContain("human_requested");
  });
  it("directive to take a message reaches the model on the next turn", async () => {
    const { llm } = await run([t("May I have your name?", { intent: "human_requested" }), t("Thanks. What is it about?")], ["A human please", "Rahul"]);
    expect(llm.lastUser).toContain("MODE: take_message");
  });
  it("two not-understood turns in a row switch to take-message mode", async () => {
    const { state } = await run([t("Sorry, could you repeat?", { intent: "not_understood" })], ["mmm", "krrr"]);
    expect(state.mode).toBe("take_message");
    expect(state.signals).toContain("not_understood");
  });
  it("an empty model reply (provider error) is retried once before the fallback is spoken", async () => {
    let n = 0;
    const llm = { calls: 0, lastSystem: "", lastUser: "", async complete() { n++; if (n === 1) throw new Error("gemini returned no text"); return { text: JSON.stringify(t("Which area is it in?")), usage: { input_tokens: 10, output_tokens: 5 }, model: "x" }; } };
    const g = await agentTurn(newCallState(START), null, deps(llm as never));
    const r = await agentTurn(g.state, "I have a flat", deps(llm as never));
    expect(r.say).toBe("Which area is it in?");
    expect(r.state.guards.some((x) => x.startsWith("llm_error"))).toBe(true);
  });
  it("an unusable model reply is replaced by the spoken fallback and counts as not understood", async () => {
    const { said, state } = await run(["garbage", "garbage"], ["hello?"]);
    expect(said[1]).toBe("Sorry, I didn't catch that. Could you say that again?");
    expect(state.misunderstood).toBe(1);
    expect(state.guards).toContain("model_reply_unusable");
  });
  it("a close in take-message mode adds no callback time", async () => {
    const { said } = await run([t("Of course. May I have your name?", { intent: "human_requested" }), t("Thank you, someone from the team will call you back.", { close: true })], ["Human please", "Ravi, about my flat"]);
    expect(said[2]).not.toMatch(/\d/);
  });
});

describe("agentTurn: complaint -> callback line composed by code (T09)", () => {
  it("in office hours says 15 minutes, from context/agent.md and config", async () => {
    const { said, state } = await run([t("I'm so sorry. What's your name?", { intent: "complaint" }), t("Noted, thank you Sheetal.", { intent: "complaint", close: true })], ["My designer hasn't replied in five days!", "Sheetal Deshpande, designer Aryan"]);
    expect(said[2]).toContain("within 15 minutes");
    expect(state.closed).toBe(true);
    expect(state.signals).toContain("complaint");
  });
  it("after hours says 10:30am next morning", async () => {
    const { said } = await run([t("So sorry. Your name?", { intent: "complaint" }), t("Noted.", { intent: "complaint", close: true })], ["Complaint!", "Sheetal"], AFTER);
    expect(said[2]).toContain("10:30am tomorrow morning");
  });
  it("the model's own callback sentence is dropped so the callback is said exactly once", async () => {
    const { said } = await run([t("So sorry. Your name?", { intent: "complaint" }), t("Thank you Sheetal. A senior team member will call you. I have what I need.", { intent: "complaint", close: true })], ["Complaint!", "Sheetal"]);
    expect(said[2]).toBe("Thank you Sheetal. I have what I need. I'm sorry about this. I've alerted a senior person at the studio, and they will call you back within 15 minutes.");
    expect((said[2].match(/call you/g) ?? []).length).toBe(1);
  });
  it("a promise inside a complaint keeps the harmless sentences; if nothing is left it uses the complaint fallback", async () => {
    const a = await run([t("I am so sorry to hear that. I'll get someone right away. Could I take your name?", { intent: "complaint" })], ["Complaint!"]);
    expect(a.said[1]).toBe("I am so sorry to hear that. Could I take your name?");
    const b = await run([t("Someone will ring you shortly.", { intent: "complaint" })], ["Complaint!"]);
    expect(b.said[1]).toBe("I'm very sorry about this. Could I take your name and the designer's name?");
  });
  it("a callback time written by the model itself is filtered; only the code-composed line speaks times", async () => {
    const { said } = await run([t("So sorry. Your name?", { intent: "complaint" }), t("We will call you within 5 minutes.", { intent: "complaint", close: true })], ["Complaint!", "Sheetal"]);
    expect(said[2]).not.toContain("within 5 minutes");
    expect(said[2]).toContain("within 15 minutes");
  });
});

describe("agentTurn: state and limits", () => {
  it("after the call is closed it says nothing more", async () => {
    const llm = fakeLLM(t("Thank you, a designer will follow up.", { close: true }));
    const g = await agentTurn(newCallState(START), null, deps(llm));
    const a = await agentTurn(g.state, "that's all", deps(llm));
    expect(a.closed).toBe(true);
    const b = await agentTurn(a.state, "hello?", deps(llm));
    expect(b.say).toBe("");
  });
  it("the length cap wraps up the call", async () => {
    process.env.AGENT_MAX_TURNS = "2";
    try {
      const { said, state } = await run([t("Next question?")], ["a", "b", "c"]);
      expect(said[3]).toMatch(/pass everything/);
      expect(state.closed).toBe(true);
      expect(state.guards).toContain("turn_cap_reached");
    } finally {
      delete process.env.AGENT_MAX_TURNS;
    }
  });
  it("state is plain JSON (a stateless webhook can store it) and accumulates token usage", async () => {
    const { state } = await run([t("Which area?")], ["flat redo", "Kothrud"]);
    const round: AgentState = JSON.parse(JSON.stringify(state));
    expect(round.usage.input_tokens).toBe(2000);
    expect(transcriptOf(round)).toContain("AI Agent:");
    expect(transcriptOf(round)).toContain("Caller: Kothrud");
  });
});
