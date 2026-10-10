/**
 * npm run replay [-- --only T02,T13 --concurrency 4 --strict]
 * Runs the 20 phone transcripts in data/phone_test_cases.json through classifyCall and prints expected vs actual.
 * The expected labels are PROVISIONAL (Nikhil has not confirmed them): disagreements are reported, never "fixed"
 * by bending the prompt. Exit code is 0 unless --strict is passed and something mismatches.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { classifyCall, type ClassificationResult } from "../src/lib/classify";
import { getConfig } from "../src/lib/config";
import { loadRules } from "../src/lib/rules";
import type { CallMeta } from "../src/lib/schema";
import { loadPhoneCases, parseHeader, stripLabels, testPhone, type PhoneCase as Case } from "../src/lib/testcases";

loadEnv({ path: ".env.local" });
loadEnv();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = getConfig();
const rules = loadRules();
const cases = loadPhoneCases();
const only = arg("only")?.split(",");
const selected = only ? cases.filter((c) => only.includes(c.id)) : cases;
const concurrency = Number(arg("concurrency") ?? 4);

async function runOne(c: Case) {
  const transcript = stripLabels(c.transcript);
  const { callTime, durationSec } = parseHeader(c.transcript, cfg.tzOffsetMinutes);
  const meta: CallMeta = {
    callerPhone: testPhone(c.id),
    callTime,
    durationSec,
  };
  try {
    const r = await classifyCall(transcript, meta, { config: cfg, rules });
    return { c, r, error: null as string | null };
  } catch (e) {
    return { c, r: null as ClassificationResult | null, error: (e as Error).message };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

async function main() {
  const gemini = (process.env.LLM_PROVIDER ?? (/^gemini/i.test(cfg.modelClassifier) ? "gemini" : "anthropic")) === "gemini";
  if (gemini ? !process.env.GEMINI_API_KEY : !process.env.ANTHROPIC_API_KEY)
    throw new Error(`${gemini ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} is not set (put it in .env.local)`);
  console.log(`classifier model: ${cfg.modelClassifier}  decline_rule=${cfg.declineRule}  lead_time=${cfg.leadTimeHardMinWeeks}/${cfg.leadTimeTightUnderWeeks}w  commercial_min=${cfg.commercialMinSqft ?? "none"}\n`);
  const results = await pool(selected, concurrency, runOne);

  console.log(`${pad("ID", 4)} ${pad("expected", 18)} ${pad("actual", 18)} ok  flags(expected | actual)  diff`);
  console.log("-".repeat(110));
  const rows = results.map(({ c, r, error }) => {
    const exp = new Set(c.provisional_expected_flags);
    const act = new Set(r?.flags ?? []);
    const missing = [...exp].filter((f) => !act.has(f));
    const extra = [...act].filter((f) => !exp.has(f));
    const outcomeOk = r?.outcome === c.provisional_expected_outcome;
    const flagsOk = missing.length === 0 && extra.length === 0;
    console.log(
      `${pad(c.id, 4)} ${pad(c.provisional_expected_outcome, 18)} ${pad(r?.outcome ?? "ERROR", 18)} ${outcomeOk ? "Y " : "N "}  ` +
        `[${[...exp].join(",")}] | [${[...act].join(",")}]` +
        `${flagsOk ? "" : `  missing=[${missing}] extra=[${extra}]`}${error ? `  ERROR: ${error}` : ""}`,
    );
    return { id: c.id, expected: c.provisional_expected_outcome, expectedFlags: c.provisional_expected_flags, r, error, outcomeOk, flagsOk, missing, extra };
  });

  const outcomeMismatch = rows.filter((x) => !x.outcomeOk);
  const flagMismatch = rows.filter((x) => x.outcomeOk && !x.flagsOk);
  console.log(`\nOutcome matches: ${rows.length - outcomeMismatch.length}/${rows.length}   flag-set exact matches: ${rows.filter((x) => x.flagsOk).length}/${rows.length}`);
  console.log("Reminder: expected labels are PROVISIONAL (Nikhil to confirm). Disagreements below are findings, not failures.\n");

  if (outcomeMismatch.length) {
    console.log("OUTCOME DISAGREEMENTS");
    for (const x of outcomeMismatch) {
      console.log(`- ${x.id}: expected ${x.expected}, got ${x.r?.outcome ?? "ERROR"}${x.r?.underlying_outcome ? ` (underlying ${x.r.underlying_outcome})` : ""}`);
      console.log(`    model's reason: ${x.r?.reason ?? x.error}`);
      if (x.r?.guards.length) console.log(`    guards applied: ${x.r.guards.join(", ")}`);
    }
    console.log();
  }
  if (flagMismatch.length) {
    console.log("FLAG DISAGREEMENTS (outcome matched)");
    for (const x of flagMismatch) console.log(`- ${x.id}: missing [${x.missing}] extra [${x.extra}]`);
    console.log();
  }

  const tokensIn = rows.reduce((s, x) => s + (x.r?.usage.input_tokens ?? 0) + (x.r?.usage.cache_read_input_tokens ?? 0) + (x.r?.usage.cache_creation_input_tokens ?? 0), 0);
  const tokensOut = rows.reduce((s, x) => s + (x.r?.usage.output_tokens ?? 0), 0);
  const cost = rows.reduce((s, x) => s + (x.r?.cost_usd ?? 0), 0);
  console.log(`Tokens: ${tokensIn} in / ${tokensOut} out across ${rows.length} calls. Cost at configured unit prices: $${cost.toFixed(4)} (0 until PRICE_* env vars are set)`);

  mkdirSync("out", { recursive: true });
  writeFileSync("out/replay-latest.json", JSON.stringify({ model: cfg.modelClassifier, at: new Date().toISOString(), rows }, null, 2));
  console.log("Full results: out/replay-latest.json");
  if (process.argv.includes("--strict") && (outcomeMismatch.length || flagMismatch.length)) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
