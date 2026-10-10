# Aangan Studio - AI Phone Enquiry Agent

Read docs/PRD_build_spec.md first. Context the agent uses lives in context/ (services.md, qualified.md, pricing.md). Test data is in data/.

## Non-negotiable rules
- The agent NEVER states a price, range, multiple or per-sq-ft figure. The only price response is the approved line in pricing.md / the spec. Enforce in code (output filter + test), not just in the prompt.
- Never hard-code the business rules in application code if they can live in context/*.md; load them at runtime so Nikhil can edit them (FR18).
- Never commit secrets. Use .env.local (gitignored); provide .env.example.
- Never delete declined or escalated call records.
- Labels in data/phone_test_cases.json are PROVISIONAL. Do not treat them as ground truth; report mismatches instead of tuning the prompt to fit them blindly.
- Where the spec lists an open question, implement a config switch or a clearly marked TODO; do not invent the answer.
- Keep a CHANGELOG.md of decisions and assumptions.
