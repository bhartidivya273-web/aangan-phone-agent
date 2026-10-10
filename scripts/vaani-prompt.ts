/** npm run vaani:prompt : writes vaani/agent-prompt.md from context/*.md. Paste its contents into the Vaani agent. */
import { writeFileSync } from "node:fs";
import { getConfig } from "../src/lib/config";
import { loadRules } from "../src/lib/rules";
import { findPriceLeaks } from "../src/lib/priceFilter";
import { buildVaaniPrompt } from "../src/lib/vaaniPrompt";

const rules = loadRules();
const prompt = buildVaaniPrompt(rules, getConfig());
// the only money-like text allowed in the prompt is the instruction itself describing what never to say; check nothing numeric slipped in
const numeric = prompt.split("\n").filter((l) => /\d/.test(l) && findPriceLeaks(l).length && !/NEVER state|Never say a number|price rule|ask about price/i.test(l));
if (numeric.length) console.warn("WARNING: lines with price-like content:\n" + numeric.join("\n"));
writeFileSync("vaani/agent-prompt.md", prompt);
console.log(`vaani/agent-prompt.md written (${prompt.length} characters)`);
