import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone";
import { extractApprovedPriceLine, loadRules } from "../src/lib/rules";
import { loadPhoneCases, parseHeader, stripLabels } from "../src/lib/testcases";
import { getConfig } from "../src/lib/config";

describe("normalizePhone", () => {
  it.each([["+91 90000 00001", "9000000001"], ["09000000001", "9000000001"], ["9000000001", "9000000001"], ["+919000000001", "9000000001"]])("%s", (i, o) => {
    expect(normalizePhone(i)).toBe(o);
  });
  it("null for empty", () => expect(normalizePhone("")).toBeNull());
});

describe("rules loader", () => {
  it("loads all four files and the approved line verbatim from pricing.md", () => {
    const r = loadRules();
    expect(r.services).toContain("Service area");
    expect(r.qualified).toContain("five criteria");
    expect(r.outcomes).toContain("repeat_caller");
    expect(r.approvedPriceLine).toBe(
      "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.",
    );
  });
  it("throws loudly if the approved line is missing", () => {
    expect(() => extractApprovedPriceLine("# nothing")).toThrow();
  });
});

describe("test-case helpers", () => {
  const cfg = getConfig({});
  it("parses the call time as IST", () => {
    expect(parseHeader("T02 · Phone · 3 September · 2:41pm · 5 min 08 sec x", cfg.tzOffsetMinutes)).toEqual({ callTime: "2026-09-03T09:11:00.000Z", durationSec: 308 });
    expect(parseHeader("T08 · Phone · 9 September · 10:47pm · MISSED CALL", cfg.tzOffsetMinutes).callTime).toBe("2026-09-09T17:17:00.000Z");
  });
  it("parses all 20 headers and strips only the ESCALATE label", () => {
    const cases = loadPhoneCases();
    expect(cases).toHaveLength(20);
    for (const c of cases) expect(() => parseHeader(c.transcript, cfg.tzOffsetMinutes)).not.toThrow();
    const t09 = cases.find((c) => c.id === "T09")!;
    expect(stripLabels(t09.transcript)).not.toContain("— ESCALATE");
    expect(stripLabels(t09.transcript)).toContain("Escalated to studio head");
  });
});
