import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Rules {
  services: string;
  qualified: string;
  pricing: string;
  outcomes: string;
  /** Editable agent wording (context/agent.md): greeting, fixed lines and style. */
  agent: string;
  /** The one sentence the agent may say in response to any price question, extracted from pricing.md. */
  approvedPriceLine: string;
}

export function contextDir(): string {
  return process.env.CONTEXT_DIR ?? path.join(process.cwd(), "context");
}

/**
 * Business rules are plain markdown read from context/*.md on every call (FR18), so Nikhil can edit them without
 * a deploy of code. No in-process caching on purpose; the files are small.
 */
export function loadRules(dir: string = contextDir()): Rules {
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  // The full internal pricing guide is private: PRICING_GUIDE_MD (deployment) > context/pricing.private.md (local, git-ignored) > context/pricing.md (public version).
  const pricing = process.env.PRICING_GUIDE_MD?.trim() || (existsSync(path.join(dir, "pricing.private.md")) ? read("pricing.private.md") : read("pricing.md"));
  return {
    services: read("services.md"),
    qualified: read("qualified.md"),
    pricing,
    outcomes: read("outcomes.md"),
    agent: read("agent.md"),
    approvedPriceLine: extractApprovedPriceLine(pricing),
  };
}

export function extractApprovedPriceLine(pricingMd: string): string {
  const marker = pricingMd.search(/only acceptable response to a pricing question/i);
  if (marker < 0) throw new Error("pricing.md: could not find 'only acceptable response to a pricing question'");
  const rest = pricingMd.slice(marker);
  const m = rest.match(/["“]([^"”]+)["”]/);
  if (!m) throw new Error("pricing.md: approved price line must be in quotes after the marker");
  return m[1].trim();
}

/** The first quoted string under a "## heading" in a markdown file. Throws if the heading or quote is missing. */
export function quotedUnder(md: string, heading: string): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (i < 0) throw new Error(`agent.md: missing section "## ${heading}"`);
  for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
    const m = lines[j].match(/["“](.+)["”]\s*$/);
    if (m) return m[1].trim();
  }
  throw new Error(`agent.md: no quoted line under "## ${heading}"`);
}

/** Everything under "## Style" (free text for the agent prompt). */
export function sectionText(md: string, heading: string): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (i < 0) throw new Error(`agent.md: missing section "## ${heading}"`);
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) out.push(lines[j]);
  return out.join("\n").trim();
}

/** Last sentence of the approved price line: the booking offer, reused verbatim on the second price ask. */
export function bookingOffer(approvedPriceLine: string): string {
  const sentences = approvedPriceLine.match(/[^.!?]+[.!?]+/g) ?? [approvedPriceLine];
  return sentences[sentences.length - 1].trim();
}
