/**
 * The agent never promises a time or slot (no calendar in the MVP, spec guardrail). Applied to every model-written
 * reply. The only timed sentence the agent ever speaks is the complaint-callback line, which is composed by code
 * from context/agent.md and the configured targets, never by the model.
 */
export interface PromiseViolation {
  rule: string;
  match: string;
}

const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|today|next\\s+week|this\\s+(?:week|weekend|morning|afternoon|evening)";
const CONFIRM = "(?:book(?:ed|ing)?|confirm(?:ed|ing)?|schedul(?:e|ed|ing)|fix(?:ed)?|reserv(?:e|ed|ing)|arrang(?:e|ed|ing)|lock(?:ed)?\\s+in|set\\s+up|pencil(?:led)?)";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUM = "(?:\\d{1,2}(?:st|nd|rd|th)?|(?:the\\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[- ]one)?)";

const RULES: Array<{ rule: string; re: RegExp }> = [
  // a specific calendar date ("13th October", "October 13", "the thirteen and fifteen of October"); a bare month ("by March") is fine
  { rule: "calendar_date", re: new RegExp(`\\b${NUM}(?:\\s+(?:and|or|to)\\s+${NUM})?\\s+(?:of\\s+)?${MONTH}\\b|\\b${MONTH}\\s+${NUM}\\b`, "i") },
  { rule: "clock_time", re: /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\b(?:noon|midnight)\b|\b\d{1,2}:\d{2}\b/i },
  { rule: "within_period", re: /\bwithin\s+(?:the\s+next\s+)?(?:a|an|one|two|three|four|five|ten|fifteen|thirty|few|\d+)\s+(?:minutes?|mins?|hours?|hrs?|days?)\b|\bwithin\s+the\s+(?:hour|day)\b|\bin\s+(?:about\s+|around\s+)?(?:\d+|a|an|one|two|three|four|five|ten|fifteen|thirty|few)\s+(?:minutes?|mins?|hours?|hrs?)\b/i },
  { rule: "urgency_promise", re: /\b(?:shortly|right\s+away|immediately|by\s+end\s+of\s+(?:the\s+)?day|end\s+of\s+day|first\s+thing)\b/i },
  { rule: "slot_confirmed", re: new RegExp(`\\b${CONFIRM}\\b[^.?!]*\\b(?:${DAY})\\b|\\b(?:${DAY})\\b[^.?!]*\\b${CONFIRM}\\b`, "i") },
  { rule: "booked_statement", re: /\b(?:you(?:'re|\s+are)\s+(?:all\s+set|booked|confirmed)|(?:consultation|appointment|visit|slot)\s+(?:is|has\s+been)\s+(?:confirmed|booked|scheduled|fixed)|i(?:'ve|\s+have)\s+(?:booked|scheduled|confirmed|fixed))\b/i },
];

export function findPromiseViolations(text: string): PromiseViolation[] {
  const out: PromiseViolation[] = [];
  for (const { rule, re } of RULES) {
    const m = text.match(re);
    if (m) out.push({ rule, match: m[0] });
  }
  return out;
}

/** Keep everything up to and including the first question; drop anything after it (one question at a time). */
export function enforceOneQuestion(text: string): { text: string; trimmed: boolean } {
  const first = text.indexOf("?");
  if (first < 0 || text.indexOf("?", first + 1) < 0) return { text, trimmed: false };
  // find the start of the second question's sentence and cut there
  const rest = text.slice(first + 1);
  const keep = text.slice(0, first + 1) + (rest.match(/^[\s"')\]]*/)?.[0] ?? "");
  return { text: keep.trim(), trimmed: true };
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Drop only the sentences that break the no-promise rule, keeping the rest of the reply. */
export function stripPromiseSentences(text: string): string {
  return sentences(text).filter((x) => findPromiseViolations(x).length === 0).join(" ").trim();
}

const CALLBACK_TALK = /\b(?:call(?:s|ed)?\s+(?:you|back)|callback|call-back|ring\s+you|senior)\b/i;

/** On a complaint close the system speaks the callback line itself; remove the model's own callback talk so it is said once. */
export function stripCallbackSentences(text: string): string {
  return sentences(text).filter((x) => !CALLBACK_TALK.test(x)).join(" ").trim();
}

/**
 * After-the-fact check for calls whose live voice is a vendor's model: agent turns that promise a time, slot or calendar date.
 * The caller-side and the code-composed complaint callback line are not scanned (only "AI Agent:" turns that are not that line).
 */
export function agentPromiseViolations(transcript: string): string[] {
  const out: string[] = [];
  for (const seg of transcript.split(/(?=(?:AI Agent|Caller|Front Desk): )/)) {
    if (!seg.startsWith("AI Agent: ")) continue;
    const text = seg.slice("AI Agent: ".length).trim();
    if (findPromiseViolations(text).length) out.push(text.length > 200 ? `${text.slice(0, 200)}...` : text);
  }
  return out;
}
