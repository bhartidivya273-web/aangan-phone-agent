# Aangan Studio: AI phone-enquiry agent (MVP)

A Pune interior-design studio gets ~200 enquiries a month and replies to fewer than half in time. This system answers every call, qualifies it
against the founder's rubric, books a consultation, and puts the lead in front of the people who need it. **The agent never quotes a price**
(enforced in code, not just in the prompt).

**Live dashboard (auto-deployed from this repo by Vercel):** https://aangan-phone-agent-wine.vercel.app/dashboard (public view: no names, phone numbers or transcripts)

## The flow

```
Customer calls ──> Vaani voice agent answers (AI disclosed, English/Hinglish), asks one question at a time
                          │ qualifies against the rubric in context/*.md (editable without code)
                          │ if it qualifies: Find slots -> Book consultation  ──> Cal.com blocks the calendar
                          ▼
              call ends: Vaani webhook ──> /api/voice/webhook  (this app)
                          ├─ classify the call (10 outcomes, flags, extracted fields)  ── Gemini
                          ├─ Supabase call log + cost per call
                          ├─ Telegram: complete lead note to the designers' group (claim by replying "taking it")
                          ├─ HubSpot: contact + note for the founder
                          └─ Dashboard: results, funnel, designer response, cost per qualified lead
```

Booking details: the assistant calls two tools (our endpoints) during the call; they ask Cal.com for real free slots and create the booking there,
so the slot is blocked on the studio calendar. Every booking also posts "CONSULTATION BOOKED" in the designers' Telegram group immediately.

Read first: `CLAUDE.md`, `docs/PRD_build_spec.md`, and `CHANGELOG.md` (every decision, assumption and open question).

## What is where

| Path | What |
|---|---|
| `context/*.md` | Business rules Nikhil can edit without code: `services.md`, `qualified.md`, `pricing.md`, `outcomes.md`, `agent.md` (greeting + fixed wording). Read at runtime on every call. |
| `src/lib/classify.ts` | `classifyCall(transcript, callMeta)` returns schema-validated JSON (outcome, reason, fields, flags, pricing_asked). |
| `src/lib/agent.ts` | `agentTurn(state, callerUtterance)`: the conversational agent. |
| `src/lib/priceFilter.ts`, `promiseFilter.ts` | The price-leak and no-promised-slot filters applied to every spoken line. |
| `src/lib/pipeline.ts` | `processCall`: classify, merge repeat callers by caller ID, write the log and costs, send handoffs. |
| `src/lib/handoff.ts` | Telegram note, claim-by-reply, designer follow-up replies, unclaimed-lead alert, escalation alert. |
| `src/lib/voice/` | Provider-agnostic voice layer: adapter interface, stub adapter, registry, webhook core. |
| `src/app/api/voice/webhook` | End-of-call reports and telephony call-log rows (FR19). |
| `src/app/dashboard` | The nine-panel dashboard and call detail pages. `src/app/simulator` is a text chat to rehearse calls. |
| `supabase/migrations/` | `0001_init.sql`, `0002_dashboard.sql`. |
| `scripts/` | `replay.ts`, `simulate.ts`, `seed.ts`. |

## Setup

Requires Node 20+ (this repo was built with Node 24). If you have no Node, a project-local copy may exist in `.tools/node`:
`export PATH="$PWD/.tools/node/bin:$PATH"`.

```bash
npm install
cp .env.example .env.local     # then fill in; never commit .env.local
```

### Environment variables (all in `.env.example`; real values only in `.env.local` / Vercel)

| Variable | Needed for | Notes |
|---|---|---|
| `LLM_PROVIDER`, `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | agent + classifier | `gemini` or `anthropic`; inferred from the model name if unset. |
| `MODEL_CLASSIFIER`, `MODEL_AGENT` | agent + classifier | Model ids, so cost can be tuned. `EFFORT_CLASSIFIER`, `EFFORT_AGENT` set reasoning depth (empty omits the parameter). |
| `PRICE_*`, `USD_TO_INR`, `PRICE_VOICE_PER_MIN_INR` | cost panel | Unit prices. Left at 0/blank on purpose; set them from your provider invoices. Without `USD_TO_INR` the dashboard shows USD and INR side by side. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | call log, dashboard | Server side only. The service role key must never reach the browser. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_NIKHIL_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | handoffs | Designers' group, Nikhil's chat (falls back to the group), webhook secret token. |
| `CRON_SECRET` | unclaimed-lead alert | Bearer secret for `/api/cron/unclaimed`. |
| `VOICE_PROVIDER`, `VOICE_WEBHOOK_SECRET` | voice webhook | Adapter name (default `stub`) and its shared secret. |
| `DASHBOARD_PASSWORD` / `DASHBOARD_PUBLIC` | dashboard, simulator | `DASHBOARD_PASSWORD`: HTTP Basic auth. Without it the pages are closed (503) in production unless `DASHBOARD_PUBLIC=true`, which opens the dashboard to anyone with the URL (call numbers and transcripts become public) and keeps the simulator closed. |
| `DECLINE_RULE`, `LEAD_TIME_*`, `COMMERCIAL_MIN_SQFT`, `OFFICE_*`, `FIRST_CONTACT_*`, `ESCALATED_REPEAT_ALSO_NOTES` ... | open-question switches | Defaults and meaning are in `.env.example` and `CHANGELOG.md`. |

### Database

Apply `supabase/migrations/0001_init.sql`, `0002_dashboard.sql` and `0003_harden.sql` (Supabase SQL editor, or `supabase db push`).
The migrations create `calls`, `leads`, `handoffs`, `costs` and block deleting declined/escalated calls. Optional demo data:

```bash
npm run seed -- --reset     # ~200 synthetic calls (provider = "demo"); demo rows are the only deletable protected rows
```

## Running and testing

```bash
npm test               # unit + acceptance tests (no network, no keys needed)
npm run typecheck
npm run replay         # the 20 phone transcripts through classifyCall; expected vs actual (labels are PROVISIONAL)
npm run simulate -- --mode persona   # live conversations against the agent; add --mode literal for the scripted caller lines
npm run dev            # http://localhost:3000/dashboard (demo data if Supabase is not configured) and /simulator
```

`replay` and `simulate` call the real model, so they need the LLM key and cost a few cents. `simulate` never sends to
Telegram (in-memory store, capturing notifier) and prints the spec's acceptance checks. Transcripts and the notes that would
have been sent are written to `out/`.

## Deploying to Vercel

1. Push the repo to GitHub and import it in Vercel (framework: Next.js).
2. Add every variable from `.env.example` under Project Settings, Environment Variables. Set `DASHBOARD_PASSWORD`.
3. Apply the two migrations to your Supabase project. Deploy.
4. **Telegram webhook** (claim-by-reply and follow-up replies). Run once with your real values:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-app>.vercel.app/api/telegram/webhook" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
   Add the bot to the designers' group. Telegram delivers replies to the bot's own messages even with privacy mode on, so claim-by-reply works without changing it.
5. **Unclaimed-lead alerts** need `/api/cron/unclaimed` called every few minutes with `Authorization: Bearer <CRON_SECRET>`.
   Vercel Cron sends that header automatically when `CRON_SECRET` is set, but sub-daily schedules need a Pro plan
   (`vercel.json`: `{"crons":[{"path":"/api/cron/unclaimed","schedule":"*/5 * * * *"}]}`; I did not commit it because a Hobby deploy would reject it).
   On Hobby, call the URL from GitHub Actions or any uptime pinger instead.
6. **Voice provider**: point its end-of-call webhook at `https://<your-app>.vercel.app/api/voice/webhook` (see below).

The webhook function allows up to 60 s (`maxDuration`), because classification and the Telegram send happen inside the request.

### The live deployment

Production: https://aangan-phone-agent-wine.vercel.app (Vercel project `aangan-phone-agent`). Redeploy with `npx vercel deploy --prod --yes`
after `npx vercel login`; environment variables live in Vercel (Settings, Environment Variables) and mirror `.env.local`.

**Finding Telegram chat ids:** add the bot to a chat and send `/chatid`; the bot replies with the id. Put the designers' group id in
`TELEGRAM_CHAT_ID` and Nikhil's in `TELEGRAM_NIKHIL_CHAT_ID` (Vercel and `.env.local`), then redeploy.

**Scheduling the unclaimed-lead alert every 5 minutes without a paid Vercel plan** (run once in the Supabase SQL editor; replace the placeholder with your `CRON_SECRET`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('unclaimed-lead-alerts', '*/5 * * * *', $$
  select net.http_get(
    url := 'https://aangan-phone-agent-wine.vercel.app/api/cron/unclaimed',
    headers := jsonb_build_object('authorization', 'Bearer <YOUR CRON_SECRET>')) $$);
-- to stop it: select cron.unschedule('unclaimed-lead-alerts');
```

## Designer reply conventions (they feed the dashboard)

Designers reply **to the note** in Telegram, in plain words:

| Say | Effect |
|---|---|
| "taking it", "mine", "on it" | Claims the lead (first claim wins; later ones are told who has it). |
| "called", "contacted", "spoke to them" | Records first contact (also claims an unclaimed lead). On an escalation message, "called back" records the callback. |
| "consultation booked" / "scheduled" / "done" | Marks the consultation (funnel). |
| "good fit" / "poor fit" | Fit verdict (designer-response panel). |
| "signed", "won", "project started" | Marks the project (funnel). |

## Voice webhook

`POST /api/voice/webhook` accepts, through the configured adapter, either an **end-of-call report** (transcript, caller number,
start/end time, provider cost) or a **call-log row** from the telephony provider (FR19, e.g. a call the front desk answered).
It authenticates (fails closed), parses, then for reports runs `classifyCall`, merges repeat callers, writes the log and cost rows,
and sends the handoff. It is idempotent on `(provider, providerCallId)`, so provider retries and a call that shows up both as a
report and as a call-log row are recorded once. It answers 500 when an event fails so the provider retries.

With the stub adapter (header `x-webhook-secret: <VOICE_WEBHOOK_SECRET>`):

```bash
curl -X POST https://<your-app>/api/voice/webhook -H "content-type: application/json" -H "x-webhook-secret: $VOICE_WEBHOOK_SECRET" -d '{
  "type": "end_of_call_report", "providerCallId": "demo-1", "callerPhone": "+919999900001",
  "startedAt": "2026-10-09T09:11:00Z", "endedAt": "2026-10-09T09:16:00Z",
  "transcript": "AI Agent: Hello. Caller: I want to redo my 3BHK in Kothrud.",
  "providerCost": {"amount": 4.2, "currency": "INR"} }'
# front-desk call from the telephony log (logged, not classified, no note):
#  {"type":"call_log","providerCallId":"fd-1","callerPhone":"+919999900002","startedAt":"...","answeredBy":"front_desk","durationSec":200}
# several at once: {"events":[ ... ]}
```

## Vaani Voice setup (the provider in use)

Built from Vaani's public docs (https://docs.vaanivoice.ai) on 2026-10-10. What the adapter (`src/lib/voice/vaani.ts`) does:

- Listens for Vaani's `call_postprocessing` event (the finished call with its transcript) and ignores every other event.
- That event has no caller number, real start time or cost, so the adapter looks the call up in Vaani's call-history API
  (`GET https://api.vaanivoice.ai/api/call-history`, header `X-API-Key`) using `VAANI_API_KEY`. If that lookup fails it carries on without them.
- Vaani's docs describe no webhook signature, so the webhook address carries a secret: `https://<app>/api/voice/webhook?key=<VOICE_WEBHOOK_SECRET>`.
- Vaani's own AI speaks the words, so the price rule cannot be blocked by code mid-call. Instead: (1) `npm run vaani:prompt` writes
  `vaani/agent-prompt.md` (greeting, approved price sentence word for word, never-promise-times, the studio's rules, no rupee figures) to paste into the Vaani agent;
  (2) every finished call is scanned for price-like agent sentences, flagged `agent_price_leak`, and Nikhil is alerted immediately.
- Stricter option for later: Vaani's "Bring Your Own LLM" sends each turn to a WebSocket server you run, which would let this code (the same filters as the in-house agent) control every sentence. It needs an always-on server (Vercel cannot hold WebSockets).
- Not available from Vaani's docs: calls answered by the front desk on a separate phone line (FR19) come from whoever runs the studio's main line, not from Vaani.

## Swapping the voice provider

The voice layer is deliberately provider-agnostic; **no vendor is hard-coded and none of the real providers' APIs were coded**
(you are choosing after your validation spike, and vendor payloads change, so check the provider's current docs first).

1. Create `src/lib/voice/<provider>.ts` exporting a `VoiceAdapter` (`src/lib/voice/types.ts`):
   - `verify(headers, rawBody)`: check the vendor's signature or secret. Must return `false` when anything is missing.
   - `parse(body)`: map the vendor payload to `VoiceEvent[]`: `end_of_call_report` (transcript text or speaker turns, caller number,
     `startedAt`, `endedAt`, `durationSec`, `providerCost`, `answeredBy`), `call_log` for telephony-log rows, or `ignored` for
     event types you do not need. Throw on malformed input (the route answers 400).
2. Register it in `src/lib/voice/registry.ts` (one line) and set `VOICE_PROVIDER=<name>`.
3. Add a test beside `tests/voice.test.ts` using a real sample payload from the vendor's docs.

Nothing else changes: classification, handoff, log and dashboard consume the normalised events. For FR19, point the provider's call
log (webhook or a scheduled export) at the same endpoint as `call_log` events. If the vendor runs the live conversation itself with
a custom-LLM hook, `agentTurn` (pure function of state + utterance) is the function to call; `/api/simulator/turn` shows the shape.

## Cal.com (calendar of record) and HubSpot (founder's CRM)

- **Cal.com:** set `CAL_API_KEY`, `CAL_EVENT_TYPE_ID` (and `CAL_ATTENDEE_EMAIL`, where Cal.com sends confirmations because callers rarely give an email).
  With these set, `/api/booking/slots` and `/api/booking/book` talk to Cal.com (slots: API 2024-09-04; bookings: API 2026-02-25). Without them the built-in
  scheduler (a table in Supabase, Mon-Sat 10am-7pm) is used. If Cal.com is down the assistant is told not to say anything is booked and a designer follows up.
- **HubSpot:** set `HUBSPOT_ACCESS_TOKEN` (a private-app token with contacts read/write and notes scopes). Each qualified lead creates or updates a contact
  (found by phone) and adds a note with every detail and the booked slot. Failures never affect the call log or Telegram; they are retried by the cron route.

## Privacy of a public repo and a public dashboard

- No secrets are committed (`.env*` is git-ignored; `.env.example` lists names only). Real keys live in Vercel and a local `.env.local`.
- The internal pricing guide is **not** in the repo: `context/pricing.md` is the public version (the approved sentence only). The private guide comes from the
  `PRICING_GUIDE_MD` environment variable or a git-ignored `context/pricing.private.md`, and is used only by the classifier.
- With `DASHBOARD_PUBLIC=true` and no `DASHBOARD_PASSWORD` the dashboard is a **public view**: no names, phone numbers, reasons or transcripts. Set a password to see everything.

## Guardrails (all enforced in code and covered by tests)

- No price, range, multiple or per-sq-ft figure: every spoken line goes through `findPriceLeaks`; a leak is replaced by the approved line.
- No promised time or slot: filtered; the only timed sentence is the complaint-callback line, composed by code from `context/agent.md` and config.
- AI disclosure in the fixed greeting; one question at a time; declined and escalated calls are never deleted (DB trigger).
- Caller numbers and transcripts live only in the call log; the dashboard masks numbers and sits behind a password.

## Not verified yet (be aware)

- No live run against a real Supabase project, a real Telegram chat, or a real voice provider. The SQL was applied and its trigger and
  constraints tested in an in-memory Postgres; the Supabase client code, Telegram calls and webhook route are covered by fakes.
- Latency per agent turn is unmeasured against a voice-call budget; no audio is involved in this MVP.
- Open questions listed in `CHANGELOG.md` (decline rule, lead time, commercial minimum, assignment, answering mode, consent/DPDP, Marathi, cost ceiling) are
  switches or notes, not decisions.
