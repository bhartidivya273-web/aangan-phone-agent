import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyGuards, buildSystemPrompt, classifyCall } from "../src/lib/classify";
import { getConfig } from "../src/lib/config";
import { loadRules } from "../src/lib/rules";
import { ClassificationSchema } from "../src/lib/schema";
import { cfg, cls, fakeLLM, rules } from "./helpers";

const meta = { callerPhone: "+919000000001", callTime: "2026-09-03T09:11:00Z" }; // 2:41pm IST Thursday

describe("classifyCall", () => {
  it("returns schema-validated JSON plus usage and cost", async () => {
    const r = await classifyCall("transcript", meta, { llm: fakeLLM(cls()), config: cfg, rules });
    expect(r.outcome).toBe("qualified");
    expect(r.usage.input_tokens).toBe(1000);
    ClassificationSchema.parse({ ...r });
  });

  it("tolerates prose/fences around the JSON", async () => {
    const r = await classifyCall("t", meta, { llm: fakeLLM("```json\n" + JSON.stringify(cls()) + "\n```"), config: cfg, rules });
    expect(r.outcome).toBe("qualified");
  });

  it("retries once with the validation error, then succeeds", async () => {
    const llm = fakeLLM({ ...cls(), outcome: "maybe" }, cls({ outcome: "not_a_fit" }));
    const r = await classifyCall("t", meta, { llm, config: cfg, rules });
    expect(llm.calls).toBe(2);
    expect(r.outcome).toBe("not_a_fit");
    expect(r.usage.input_tokens).toBe(2000); // both attempts are costed
  });

  it("throws after two invalid replies (caller logs the failure)", async () => {
    await expect(classifyCall("t", meta, { llm: fakeLLM("not json"), config: cfg, rules })).rejects.toThrow(/invalid model output/);
  });

  it("requires MODEL_CLASSIFIER", async () => {
    await expect(classifyCall("t", meta, { llm: fakeLLM(cls()), config: getConfig({}), rules })).rejects.toThrow(/MODEL_CLASSIFIER/);
  });

  it("loads business rules from context/*.md at call time (FR18): an edited file changes the prompt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-"));
    cpSync("context", dir, { recursive: true });
    writeFileSync(path.join(dir, "qualified.md"), "# EDITED BY NIKHIL\nMarker-rule-12345");
    const llm = fakeLLM(cls());
    await classifyCall("t", meta, { llm, config: cfg, rules: loadRules(dir) });
    expect(llm.lastSystem).toContain("Marker-rule-12345");
  });

  it("puts the config switches for the open questions into the prompt", () => {
    const a = buildSystemPrompt(rules, getConfig({ DECLINE_RULE: "two_criteria", COMMERCIAL_MIN_SQFT: "", LEAD_TIME_HARD_MIN_WEEKS: "8" }));
    expect(a).toContain("two_criteria");
    expect(a).toContain("COMMERCIAL MINIMUM SIZE (config: none)");
    expect(a).toContain("Fewer than 8 weeks");
    const b = buildSystemPrompt(rules, getConfig({}));
    expect(b).toContain("one_hard_fail");
    expect(b).toContain("under 500 sq ft");
  });
});

describe("guards (code-level, always reported)", () => {
  const base = ClassificationSchema.parse(cls());

  it("forces timeline_too_short when extracted lead time is below the hard minimum", () => {
    const { c, guards } = applyGuards(ClassificationSchema.parse(cls({}, { timeline_target_date: "2026-09-24" })), meta, cfg);
    expect(c.outcome).toBe("timeline_too_short");
    expect(guards[0]).toMatch(/timeline_override/);
  });

  it("repairs a model that wrongly says timeline_too_short when the computed lead time is enough (T02 case)", () => {
    const { c, guards } = applyGuards(ClassificationSchema.parse(cls({ outcome: "timeline_too_short" }, { timeline_target_date: "2026-11-01" })), meta, cfg);
    expect(c.outcome).toBe("qualified");
    expect(c.flags).toContain("timeline_tight");
    expect(guards.some((g) => g.startsWith("timeline_override_up"))).toBe(true);
  });

  it("keeps timeline_too_short when the computed lead time really is short (T07 case)", () => {
    const { c } = applyGuards(ClassificationSchema.parse(cls({ outcome: "timeline_too_short" }, { timeline_target_date: "2026-09-24" })), meta, cfg);
    expect(c.outcome).toBe("timeline_too_short");
  });

  it("flags timeline_tight between the hard minimum and the tight threshold, keeps qualified", () => {
    const { c } = applyGuards(ClassificationSchema.parse(cls({}, { timeline_target_date: "2026-11-01" })), meta, cfg);
    expect(c.outcome).toBe("qualified");
    expect(c.flags).toContain("timeline_tight");
  });

  it("computes weeks in code from the target date (3 Sep -> 1 Nov = 8.4 weeks)", () => {
    const { c } = applyGuards(ClassificationSchema.parse(cls({}, { timeline_target_date: "2026-11-01" })), meta, cfg);
    expect(c.extracted.timeline_weeks_from_call).toBeCloseTo(8.2, 0);
  });

  it("adds decision_maker_unconfirmed when the model says the decision-maker is not confirmed", () => {
    const { c, guards } = applyGuards(ClassificationSchema.parse(cls({}, { decision_maker_confirmed: false })), meta, cfg);
    expect(c.flags).toContain("decision_maker_unconfirmed");
    expect(c.outcome).toBe("qualified"); // never declines on its own
    expect(guards).toContain("added_flag_decision_maker_unconfirmed");
  });

  it("leaves a comfortable timeline alone", () => {
    const { c, guards } = applyGuards(base, meta, cfg);
    expect(c.flags).not.toContain("timeline_tight");
    expect(guards).not.toContain("added_flag_timeline_tight");
  });

  it("adds pricing_asked flag when the boolean is true", () => {
    const { c } = applyGuards(ClassificationSchema.parse(cls({ pricing_asked: true })), meta, cfg);
    expect(c.flags).toContain("pricing_asked");
  });

  it("adds after_hours from call time (10:47pm IST) and not at 2:41pm", () => {
    const night = applyGuards(base, { ...meta, callTime: "2026-09-09T17:17:00Z" }, cfg).c; // 10:47pm IST
    expect(night.flags).toContain("after_hours");
    expect(applyGuards(base, meta, cfg).c.flags).not.toContain("after_hours");
  });

  it("treats Sunday as after hours (office days Mon-Sat by default)", () => {
    const sunday = applyGuards(base, { ...meta, callTime: "2026-09-06T06:30:00Z" }, cfg).c; // Sun 12:00 IST
    expect(sunday.flags).toContain("after_hours");
  });

  it("adds repeat_caller flag when prior calls exist", () => {
    const { c } = applyGuards(base, { ...meta, priorCalls: [{ date: "x", outcome: "dropped_or_missed", summary: "s" }] }, cfg);
    expect(c.flags).toContain("repeat_caller");
  });
});
