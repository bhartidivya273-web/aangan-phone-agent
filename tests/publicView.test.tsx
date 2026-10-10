import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../src/app/dashboard/DashboardView";
import { getConfig } from "../src/lib/config";
import { generateDemoData } from "../src/lib/demo";
import { computeDashboard } from "../src/lib/metrics";
import { isPublicView } from "../src/lib/publicView";
import { extractApprovedPriceLine, loadRules } from "../src/lib/rules";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("public view switch", () => {
  it("public only when explicitly enabled and no password is set", () => {
    expect(isPublicView({ DASHBOARD_PUBLIC: "true" })).toBe(true);
    expect(isPublicView({ DASHBOARD_PUBLIC: "true", DASHBOARD_PASSWORD: "x" })).toBe(false);
    expect(isPublicView({})).toBe(false);
  });
  it("redacted dashboard shows no phone digits, reasons or links to call pages", () => {
    const now = new Date("2026-10-09T10:00:00Z");
    const d = generateDemoData(now, getConfig({}));
    const m = computeDashboard(d, getConfig({}), now, 30);
    const html = renderToStaticMarkup(<DashboardView m={m} demo={false} redact />);
    expect(html).toContain("Public view");
    expect(html).not.toMatch(/•••• \d{4}/);
    expect(html).not.toContain("/dashboard/calls/");
    for (const r of m.review.slice(0, 5)) if (r.reason) expect(html).not.toContain(r.reason);
    expect(html).toContain("hidden in public view");
    const full = renderToStaticMarkup(<DashboardView m={m} demo={false} />);
    expect(full).toContain("/dashboard/calls/");
  });
});

describe("pricing guide sources (the public repo ships only the approved line)", () => {
  it("the shipped context/pricing.md has no price figures but still carries the approved sentence", () => {
    const pub = readFileSync("context/pricing.md", "utf8");
    expect(pub).not.toMatch(/₹\s?\d|\d\s?lakh|per sq ft:|Indicative range/i);
    expect(extractApprovedPriceLine(pub)).toMatch(/^Pricing depends on the site/);
  });
  it("order of precedence: PRICING_GUIDE_MD env, then pricing.private.md, then pricing.md", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-"));
    cpSync("context", dir, { recursive: true });
    rmSync(path.join(dir, "pricing.private.md"), { force: true });
    expect(loadRules(dir).pricing).toContain("public version");
    writeFileSync(path.join(dir, "pricing.private.md"), "PRIVATE FILE. **The only acceptable response to a pricing question**: \"Pricing depends on the site - x.\"");
    expect(loadRules(dir).pricing).toContain("PRIVATE FILE");
    process.env.PRICING_GUIDE_MD = "FROM ENV. **The only acceptable response to a pricing question**: \"Pricing depends on the site - y.\"";
    try {
      expect(loadRules(dir).pricing).toContain("FROM ENV");
      expect(loadRules(dir).approvedPriceLine).toBe("Pricing depends on the site - y.");
    } finally {
      delete process.env.PRICING_GUIDE_MD;
    }
  });
});
