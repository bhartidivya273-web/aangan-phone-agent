import { describe, expect, it } from "vitest";
import { assertNoPriceLeak, enforcePriceSafe, findPriceLeaks, hasPriceLeak, PriceLeakError } from "../src/lib/priceFilter";
import { loadRules } from "../src/lib/rules";
import { loadPhoneCases } from "../src/lib/testcases";

const { approvedPriceLine } = loadRules();

describe("price-leak filter: must flag", () => {
  const leaks: Array<[string, string]> = [
    ["rupee symbol", "That would be ₹1,800 for a standard spec."],
    ["Rs", "It's around Rs 20 lakh."],
    ["Rs.", "Rs. 5000"],
    ["INR", "INR 250000"],
    ["rupees", "a few lakh rupees"],
    ["dollar", "$40,000"],
    ["lakh", "somewhere under ten lakh"],
    ["lakhs", "8 lakhs or so"],
    ["lac", "5 lac"],
    ["crore", "a crore"],
    ["k amount", "about 50k for a room"],
    ["per sq ft", "our rates are per sq ft based"],
    ["per sq. ft.", "charged per sq. ft."],
    ["per square foot", "per square foot pricing"],
    ["slash sq ft", "1800/sq ft"],
    ["psf", "around 2000 psf"],
    ["numeric range dash", "between 1,800-2,400"],
    ["numeric range to", "2400 to 3500"],
    ["numeric range en dash", "5–8"],
    ["between and", "between 5 and 8"],
    ["multiple x", "premium can be 3x the standard"],
    ["multiple ×", "that's 3× the cost"],
    ["multiple times", "three times the cost"],
    ["double", "it can double the cost"],
    ["it'll cost", "It'll cost you quite a bit"],
    ["will cost", "a full home will cost more"],
    ["rates start", "our rates start low"],
    ["costs around", "it costs around that"],
    ["starts at number", "starts at 1500"],
    ["ballpark of", "a ballpark of what you need"],
  ];
  it.each(leaks)("%s", (_n, text) => {
    expect(hasPriceLeak(text), text).toBe(true);
    expect(() => assertNoPriceLeak(text)).toThrow(PriceLeakError);
  });

  it("flags the human front-desk line in T13 ('3× the cost') so the agent cannot copy that behaviour", () => {
    const t13 = loadPhoneCases().find((c) => c.id === "T13")!;
    const frontDesk = t13.transcript.match(/The difference between[^.]*\./)![0];
    expect(findPriceLeaks(frontDesk).map((v) => v.rule)).toContain("multiple");
  });
});

describe("price-leak filter: must allow", () => {
  const safe = [
    approvedPriceLine,
    "Hi, I'm an AI assistant for Aangan Studio. How can I help?",
    "Design usually takes three to four weeks.",
    "Design takes 3-4 weeks and execution 8-16 weeks.",
    "We're open 10am to 7pm, Monday to Saturday.",
    "A senior person will call you back within 15 minutes.",
    "Is it a 2BHK or 3 BHK?",
    "About 1,400 sq ft carpet, got it.",
    "Which floor is the flat on, 4th or 5th?",
    "Could you share your name and the best number to reach you?",
    "A designer will follow up with you.",
    "Would 10:30am work? I can't promise a slot, but I'll note it.",
  ];
  it.each(safe)("%s", (text) => {
    expect(findPriceLeaks(text)).toEqual([]);
  });

  it("the approved line is read from context/pricing.md and is itself clean", () => {
    expect(approvedPriceLine).toMatch(/^Pricing depends on the site/);
    expect(() => assertNoPriceLeak(approvedPriceLine)).not.toThrow();
  });
});

describe("enforcePriceSafe", () => {
  it("passes clean text through", () => {
    expect(enforcePriceSafe("Great, which area is it in?", approvedPriceLine)).toMatchObject({ replaced: false, text: "Great, which area is it in?" });
  });
  it("swaps a leaking reply for the approved line", () => {
    const r = enforcePriceSafe("Typically it's Rs 2000 per sq ft.", approvedPriceLine);
    expect(r.replaced).toBe(true);
    expect(r.text).toBe(approvedPriceLine);
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
