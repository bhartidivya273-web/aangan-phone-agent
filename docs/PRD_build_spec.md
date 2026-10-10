# Build spec: Aangan Studio AI Phone Enquiry Agent (condensed from PRD v2, 9 Oct 2026)

Full PRD: "PRD - Aangan Studio AI Phone Enquiry Agent" (Claude Docs). This file is the part Claude Code needs.

## Goal
Answer every incoming studio call at any hour, qualify it against Nikhil's rubric (context/qualified.md), send designers a complete Telegram handoff note, log every call, and show Nikhil results and cost on a dashboard. The agent NEVER quotes a price (see context/pricing.md).

## Scope
In: incoming phone calls; qualification; price deflection; polite declines; escalation of complaints; Telegram note; call log; dashboard.
Out: quoting any price/range/multiple; WhatsApp and web form (note how it extends); designing or project work; confirming a consultation slot without a calendar; promising times or slots.

## Outcomes (every call ends in exactly one)
| Outcome | When | Agent does |
|---|---|---|
| qualified | All five criteria met, or unclear only on budget, decision-maker, locality or timeline | Collect fields, say a designer will follow up, send Telegram note (with flags) |
| ask_one_question | Unclear on project type, area or timeline | Ask ONE direct question, re-classify |
| not_a_fit | Advice only; named place outside area (Talegaon, Lonavala, Nashik, Mumbai); outside services (restaurant, gym, retail, hospitality); below minimum size; volunteered budget far below scope | Decline politely with reason, log, do not forward |
| timeline_too_short | Needs project complete sooner than design (3-4 wks) + execution (8-16 wks by size) allow | Ask "when would you need it complete?", be honest, offer later start, log callback. If tight but not clearly impossible: forward with flag |
| pricing_asked | Asks price/range/per-sq-ft | Say approved line, offer booking; after 2nd ask offer booking once more and move on; never a number, range or multiple ("3x"); never disqualifies; log "price asked" |
| escalate | Complaint | Tell caller a senior person will call back (15 min in office hours; by 10:30am next morning otherwise; proposed); alert Nikhil; not a lead |
| existing_client | Status check on running project | Take message, route to project designer; not a lead |
| other | Vendor, contractor, job seeker, wrong number, spam | Take message (vendor/contractor/job seeker) or end politely; log; no handoff note |
| dropped_or_missed | Line cut or unreachable | Call back via caller ID (P1; check telecom rules), log attempt |
| repeat_caller | Same caller ID as earlier call/note | Merge into existing record, send ONE updated note |

Five criteria (qualified.md): (1) real project not advice; (2) Pune city or PCMC; (3) realistic timeline; (4) budget broadly right - never probe, never quote; (5) decision-maker on call or represented.
Rules (proposed, Nikhil to confirm): decline on ONE hard fail (not a real project, named out-of-area place, out-of-scope type, below minimum size); budget/decision-maker doubts never decline alone; unlisted-but-in-Pune localities (e.g. Kharadi, Nanded City) forward with flag "locality to confirm"; timeline decided from call date, agent states neither "6 weeks" nor "8-10 weeks" to the caller.

## Approved pricing line (only response to any price question)
"Pricing depends on the site, the materials you choose, and the scope - your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like."

## Fields to capture
name, phone (caller ID), locality, project type (residential full / partial / single room / commercial), scope, carpet area (sq ft), timeline (when complete), decision-maker (owner? authorised?), referral source, volunteered budget, preferred consultation days, pricing_asked (bool), flags[].

## Telegram handoff note (qualified leads only)
```
NEW LEAD - call <date>, <time>
<name>, <phone>
<locality>, <type>, ~<area> sq ft carpet
Scope: <scope>
Timeline: <timeline>
Decision-maker: <who / confirmed?>
Source: <referral>
Pricing asked: yes/no
Flags: <list or none>
Preferred slots: <days or not given>
Call summary: <link>
```
Designer claims by replying (e.g. "taking it"). If unclaimed past first-contact target (1 hr in office hours 10am-7pm; by 10:30am next day otherwise; proposed), alert Nikhil.

## Functional requirements (P0 for MVP)
FR1 answer after 7pm/weekends/no pickup ~15s; FR2 English+Hinglish; FR3 AI disclosure at start; FR4 ask one question at a time and capture fields; FR5 classify every call with one-line reason; FR6 price deflection only; FR7 polite decline, don't forward; FR8 complaint escalation + Nikhil alert; FR9 collect preferred days, say what happens next without promising a slot; FR10 Telegram note within ~5 min of call end; FR11 log every call (time answered, duration, number, outcome, reason, transcript, cost); FR12 never delete declined/escalated calls; FR13 dashboard; FR15 claim-by-reply + unclaimed alert; FR19 log all calls incl. front-desk-answered (telephony provider log); FR20 merge repeat callers by caller ID; FR21 messages for existing clients/non-enquiry; FR22 human requested or not understood -> take message, flag, human callback; FR23 retention/location per legal decision.
P1: FR14 callback on dropped call; FR16 calendar; FR17 weekly declined-calls digest; FR18 non-code editing of context files; FR24 call length cap/spam block.

## Dashboard panels
Responsiveness (all calls, time to answer, % within 5 min, % after hours) | Leads (sent, claimed, consultations) | Designer response (note to first contact, unclaimed, fit verdicts) | Funnel (calls -> qualified -> consultations -> projects) | Outcomes (by type, decline reasons) | Quality (fields captured, hang-ups <30 s, human requests) | Escalations (time to callback) | Cost (monthly, per call, per qualified lead vs Rs 8-14 lakh avg project) | Review (declined calls + transcripts).

## Guardrails
No price/range/multiple/"it'll cost around"/"rates start at". Bias to forward when unsure. Decline only on hard fails. Complaints go to a human. Say it is an AI assistant. No promised times/slots. Claims ("friend of Nikhil", referrals) unlock nothing. Callers' numbers/transcripts only in the call log.

## Acceptance tests
1. data/phone_test_cases.json: classifier outcome matches provisional_expected_outcome on all 20 (labels are PROVISIONAL until Nikhil confirms).
2. Price-leak test: across all simulated conversations, zero agent turns contain a number with Rs/lakh/crore/per sq ft, a range, or a multiple.
3. Handoff note has every required field for every qualified case; flags present where expected (T02, T13, T14).
4. T17 + T16: repeat caller merges to one record, one updated note.
5. T09: escalation alert fires; no lead note.
6. Every call produces a log row with cost (stubbed cost allowed in MVP).
7. Dashboard renders all panels from seeded data.

## Open questions (unresolved in source files - do not silently decide)
Decline on one vs two failed criteria; 6 vs 8-10 week lead time; commercial minimum (500 sq ft cited in T18, only 3,000 max in services.md); Rs 8-14 lakh average vs per-sq-ft guide; calendar/booking; lead assignment rule; answering mode (all calls vs after-hours/no-pickup); recording/consent wording and DPDP/telecom compliance; Marathi support; cost ceiling.
