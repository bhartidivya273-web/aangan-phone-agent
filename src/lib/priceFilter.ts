/**
 * HARD RULE: the agent never quotes a price, range, multiple or per-sq-ft figure.
 * This filter runs on everything the agent would say to a caller. It is deliberately over-eager: a false positive
 * swaps the sentence for the approved line, a false negative leaks a price.
 */

export interface PriceViolation {
  rule: string;
  match: string;
}

const TIME_UNITS =
  "(?:weeks?|wks?|days?|months?|years?|yrs?|hours?|hrs?|minutes?|mins?|am|pm|bhk|bhks|rooms?|bedrooms?|people|persons?|floors?|sq|square|st|nd|rd|th|%)";

const RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "currency_symbol", re: /[₹$€£]/ },
  { rule: "rs_inr", re: /\b(?:rs|inr)\b\.?|\brupees?\b/i },
  { rule: "lakh_crore", re: /\b(?:lakhs?|lacs?|crores?|cr)\b/i },
  { rule: "k_amount", re: /\b\d+(?:\.\d+)?\s?k\b/i },
  {
    rule: "per_sq_ft",
    re: /(?:\bper\s*|\ba\s+|\/\s*)(?:sq\.?\s*(?:ft|feet|foot|\.?\s*ft)|square\s*(?:feet|foot|ft)|sqft)\b|\bpsf\b|\bper\s+square\b/i,
  },
  {
    rule: "multiple",
    re: /(?:\b\d+(?:\.\d+)?\s*(?:x|×)(?![a-z0-9])|\b(?:two|three|four|five|six|ten|\d+)\s+times\b|\b(?:double|triple|twice)\b(?:\s+the)?\s+(?:cost|price|amount))/i,
  },
  {
    rule: "cost_phrase",
    re: /\b(?:it'?ll|it\s+will|that'?ll|would|will|should|typically|usually|generally)\s+(?:cost|come\s+(?:to|around|up\s+to))\b|\b(?:costs?|priced?)\s+(?:around|about|roughly|approximately|between|from|upwards)\b|\b(?:rates?|prices?|pricing)\s+(?:start|begin|range|are\s+around|is\s+around)\b|\bstarts?\s+(?:at|from)\s+\S*\d|\bballpark\s+(?:of|is)\b/i,
  },
  { rule: "between_numbers", re: /\bbetween\s+\d[\d,.]*\s+and\s+\d/i },
];

// numeric range "5-8", "5 to 8", "1,50,000 – 2,00,000"; allowed when followed by a time/room unit ("3-4 weeks", "10 to 7 pm").
const RANGE_RE = new RegExp(
  `\\d[\\d,.]*\\s*(?:-|–|—|to)\\s*\\d[\\d,.]*(?!\\d)(?!\\s*(?:${TIME_UNITS})\\b)`,
  "gi",
);

export function findPriceLeaks(text: string): PriceViolation[] {
  const out: PriceViolation[] = [];
  for (const { rule, re } of RULES) {
    const m = text.match(re);
    if (m) out.push({ rule, match: m[0] });
  }
  for (const m of text.matchAll(RANGE_RE)) {
    // a range ending in a unit the lookahead missed (e.g. "3-4 weeks") is allowed; everything else is flagged
    out.push({ rule: "numeric_range", match: m[0] });
  }
  return out;
}

export const hasPriceLeak = (text: string) => findPriceLeaks(text).length > 0;

export class PriceLeakError extends Error {
  constructor(public violations: PriceViolation[], public text: string) {
    super(`price leak: ${violations.map((v) => `${v.rule}="${v.match}"`).join(", ")}`);
  }
}

export function assertNoPriceLeak(text: string): void {
  const v = findPriceLeaks(text);
  if (v.length) throw new PriceLeakError(v, text);
}

/**
 * Last line of defence for caller-facing text: if anything price-like slipped out of the model, say the approved
 * line instead. Returns the text actually safe to speak plus whether it was replaced.
 */
export function enforcePriceSafe(text: string, approvedPriceLine: string): { text: string; replaced: boolean; violations: PriceViolation[] } {
  const violations = findPriceLeaks(text);
  if (violations.length === 0) return { text, replaced: false, violations };
  return { text: approvedPriceLine, replaced: true, violations };
}

/**
 * After-the-fact check for calls where the live voice is produced by a vendor's own model (so this code cannot block a
 * sentence mid-call): returns the agent turns of a finished transcript that contain anything price-like.
 */
export function agentPriceLeaks(transcript: string): string[] {
  const out: string[] = [];
  for (const seg of transcript.split(/(?=(?:AI Agent|Caller|Front Desk): )/)) {
    if (!seg.startsWith("AI Agent: ")) continue;
    const text = seg.slice("AI Agent: ".length).trim();
    if (findPriceLeaks(text).length) out.push(text.length > 200 ? `${text.slice(0, 200)}...` : text);
  }
  return out;
}
