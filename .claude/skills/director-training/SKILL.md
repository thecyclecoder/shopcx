# director-training

**When:** the founder asks how the 48h growth-agent supervision is going — "how's the director training going?", "what has the watch been up to?", "how are Bianca and Dahlia doing?", "is Max ready?". A READ-ONLY status report — reads the recorded watch activity + the two agents' live state and gives one digest. Does NOT act (that's the watch turn's job).

**Why:** the two live growth agents — **Bianca** (media buyer) + **Dahlia** (ad creative) — run autonomously under live rails (the $500/day cap, media-buyer auto-disarm, and the [[../../../docs/brain/libraries/budget-alerts|SMS budget tripwire]]). This skill is how the founder checks in on how they're doing — and, once the founder-armed "be Max for 48h" supervision watch is running, on what that watch has been doing — without reading raw tables. Current state (2026-07-10): the agents + rails are live; the armed hourly watch is a deliberate later build, so if there's no active `max_watch_windows` row, just report the agents' live state + spend (skip steps 1–2).

## Procedure (read-only)

1. **Window (if any).** Read the latest `max_watch_windows` row for workspace `fdc11e10-b89f-4989-8b73-ed6526c4d906`. If none active, say "no armed watch running — reporting agents' live state directly" and skip to step 3. If active: report status, started_at, ends_at, **hours elapsed / remaining**, turns_enqueued, last_turn_at (flag if >90 min stale → driver may be stuck).

2. **What the watch did (if a window exists).** Read `director_activity` rows `action_kind='max_watch_turn'` (+ any `max_watch_%`), newest first. Summarize by tag: `[MONEY-FIX]` / `[CAMPAIGN]` (every spend/campaign change, before→after), `[HICCUP]` / `[GOTCHA]` (problems + whether fixed), `[GRADE]` (running grades per agent), `[COACHING]` (steers). List open items.

3. **Bianca (media buyer) live state.** Active `iteration_policies` row (mode armed? trust_meta_reported_signal? crown/trim knobs). Recent `media_buyer_%` `director_activity` (crowns/kills/denials/errors). **Today's Superfood Tabs Meta spend vs the $500/day cap** — VERIFY LIVE (getMetaUserToken + a scorecard/insights read; never state a spend number you didn't measure). Any adset that crowned (CPA ≤ $150 @ ≥ $450) or should have. Any `kind='media-buyer'` job stuck/failed.

4. **Dahlia (ad creative) live state.** `listReadyToTest` bin depth per product; recent `kind='ad-creative'` jobs (completed/failed); QA-fail rate; whether the bin is actually feeding Bianca.

5. **Money check (headline).** Total ad spend across the window vs expectation, biggest single-adset spend, and an explicit "no runaway spend detected" or a flagged concern. This is the founder's first question — lead with it.

6. **Max readiness.** From the accumulated `max_watch_turn` notes: what's crystallizing about Max's role (the supervisory/analytical/coaching patterns, the recurring gotchas, the grading rubric that's working). If the window has ended, point to the authored Max spec.

**Output:** a tight founder-facing digest — spend headline first, then what the watch fixed, how each agent is performing (with grades), open risks, and Max-readiness. Numbers must be measured this run, not recalled. Keep it scannable.

## Related
[[../../../src/lib/media-buyer/agent]] (Bianca) · [[../../../src/lib/ads/creative-agent]] (Dahlia) · [[../../../docs/brain/libraries/budget-alerts]] (the SMS spend tripwire) · [[../../../src/lib/media-buyer/meta-cpa-signal]] (the trusted signal she runs on).
