# Call outcomes and decision rules

*Copied from docs/PRD_build_spec.md so it can be edited without code (FR18). Lines marked (proposed) are not yet confirmed by Nikhil.*

Every call ends in exactly one outcome.

| Outcome | When | Agent does |
|---|---|---|
| qualified | All five criteria met, or unclear only on budget, decision-maker, locality or timeline | Collect fields, say a designer will follow up, send Telegram note (with flags) |
| ask_one_question | Unclear on project type, area or timeline | Ask ONE direct question, re-classify |
| not_a_fit | Advice only; named place outside area (Talegaon, Lonavala, Nashik, Mumbai); outside services (restaurant, gym, retail, hospitality); below minimum size; volunteered budget far below scope | Decline politely with reason, log, do not forward |
| timeline_too_short | Needs project complete sooner than design (3-4 wks) + execution (8-16 wks by size) allow | Ask "when would you need it complete?", be honest, offer later start, log callback. If tight but not clearly impossible: forward with flag |
| pricing_asked | Asks price/range/per-sq-ft | Say approved line, offer booking; after 2nd ask offer booking once more and move on; never a number, range or multiple; never disqualifies; log "price asked" |
| escalate | Complaint | Tell caller a senior person will call back; alert Nikhil; not a lead |
| existing_client | Status check on running project | Take message, route to project designer; not a lead |
| other | Vendor, contractor, job seeker, wrong number, spam | Take message (vendor/contractor/job seeker) or end politely; log; no handoff note |
| dropped_or_missed | Line cut or unreachable | Call back via caller ID, log attempt |
| repeat_caller | Same caller as an earlier call or enquiry (caller says they called before, or prior calls are supplied) | Merge into the existing record, send ONE updated note |

## Rules (proposed, Nikhil to confirm)

- Decline on ONE hard fail: not a real project, a named out-of-area place, an out-of-scope type, below minimum size, or a volunteered budget far below scope.
- Budget or decision-maker doubts never decline a call on their own: forward with a flag.
- Unlisted but in-Pune localities (e.g. Kharadi, Nanded City) are forwarded with the flag `locality_to_confirm`.
- Decision-maker: the caller counts as confirmed only if they are the owner/decider or say they are authorised to proceed. A caller who is checking things out for family or others ("they'll decide", "just doing initial research for my parents") is NOT confirmed: still `qualified`, with the flag `decision_maker_unconfirmed` (this follows the rubric in qualified.md; it never declines on its own).
- Timeline is judged from the call date. Complaints always go to a human.
- A claim such as "friend of Nikhil" or a referral name unlocks nothing and changes no outcome.
- When unsure between forwarding and declining, forward.

## Flag vocabulary

Use these snake_case flags where they apply (add others only if none fits):
pricing_asked, timeline_tight, outside_area, advice_only, outside_services, complaint,
decision_maker_unconfirmed, budget_far_below_scope, budget_uncertain, locality_to_confirm,
below_minimum_size_rule_unconfirmed, callback_for_later_start, first_call_dropped, repeat_caller,
qualified_lead_dropped_earlier, handle_with_care, after_hours, human_requested, not_understood.

## Fields to capture

name, phone, locality, project type (residential_full / residential_partial / single_room / commercial), scope, carpet area (sq ft),
timeline (when the project must be complete), decision-maker (owner? authorised?), referral source, volunteered budget,
preferred consultation days, pricing_asked, flags.
