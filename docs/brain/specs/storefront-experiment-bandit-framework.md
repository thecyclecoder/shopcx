# Storefront experiment + bandit framework ⏳

**Owner:** [[../functions/growth]] · **Parent:** M1 — Storefront experiment + bandit framework

The greenfield on-site experimentation substrate for the [[../goals/storefront-optimizer]] — the foundation every later milestone consumes. Today a lander's identity is only URL-encoded (`?variant=…&angle={slug}` parsed from [[../tables/storefront_sessions]]`.landing_url`); there is no first-class notion of an *experiment*, a *variant under test*, a *holdout*, or an *outcome window*. This spec builds that: a variant model over DB-driven landers ([[../tables/advertorial_pages]]), deterministic sticky per-session assignment, exposure tracking into [[../tables/storefront_events]], outcome attribution across the delayed-purchase/sub-attach window, Thompson-sampling stats vs a holdout/control arm, and auto-rollback on a regression. It is the on-site analogue of the ads-side [[storefront-iteration-engine]] and must talk to it (a winning lander → route more ad spend; the ad engine's audiences → which lander/angle to test). Success metric served: **predicted-LTV-per-visitor** per `(product × lander-type × audience)` — this milestone produces the clean, attributed exposure→outcome stream that metric is computed over (M3 plugs in the reward; this milestone owns the harness).

## Phase 1 — Experiment + variant data model ⏳
- ⏳ planned
- New tables `storefront_experiments` (one row per hypothesis: `workspace_id`, `product_id`, `lander_type` ∈ `pdp｜listicle｜beforeafter｜advertorial`, `audience` key, `lever` under test, `status` ∈ `draft｜running｜promoted｜killed｜rolled_back`, `holdout_pct`, `started_at`/`stopped_at`, `created_by`) and `storefront_experiment_variants` (one row per arm: `experiment_id`, `is_control bool`, the variant payload — a config patch over the DB-driven lander, e.g. an `advertorial_pages` field override or a chapter add/remove/reorder, plus the Thompson-sampling posterior state `alpha`/`beta` or numeric `reward_sum`/`n`).
- A variant's payload is a **reversible patch over DB-driven lander content** (copy / hero `hero_storage_path` / chapter order) — never a code deploy. Migration `supabase/migrations/{ts}_storefront_experiments.sql` + a [[write-brain-page]] `tables/storefront_experiments.md` + `tables/storefront_experiment_variants.md`.
- RLS: workspace-member SELECT, service-role write (mirror [[../tables/advertorial_pages]]).

## Phase 2 — Deterministic sticky assignment + exposure tracking ⏳
- ⏳ planned
- Assignment library `src/lib/storefront/experiments.ts` — `assignVariant(session, experiment)` hashes a stable key (`storefront_sessions.customer_id ?? anonymous_id` + `experiment_id`) → a variant or the holdout, **sticky** for the life of the session/identity so a visitor never flips arms. Honor `holdout_pct`.
- Resolve assignment at lander render (the route that today calls `loadAdvertorialContent`) and apply the variant's content patch over the DB-driven lander top.
- Emit a new `storefront_events` `event_type='experiment_exposure'` row carrying `{experiment_id, variant_id, is_holdout}` in `meta` — reuses the existing append-only log + client-UUID CAPI-dedup PK; no new event pipeline. Skip `is_internal`/`is_bot` sessions (already flagged on [[../tables/storefront_sessions]]).

## Phase 3 — Outcome attribution across the delayed-purchase / sub-attach window ⏳
- ⏳ planned
- Join exposure → outcome per variant: `experiment_exposure` event → session → order(s), using the persisted [[../tables/storefront_sessions]]`.advertorial_page_id`/`ad_campaign_id` and `orders` first-touch attribution (the same persisted-id-then-URL-parse fallback the [[storefront-iteration-engine]] Phase 2b uses), keyed by `customer_id ?? anonymous_id`.
- **Delayed-purchase window:** an outcome is attributed if the order lands within a configurable window (default ≥ the typical consider→buy lag) of first exposure; record `converted`, `is_subscription` (sub-attach), and order margin inputs. This is the raw stream M3's predicted-LTV proxy is computed over — this spec records the attributed events, M3 owns the LTV math.
- Persist per-variant rollups (sessions, conversions, sub-attach, revenue) into `storefront_experiment_variants` posterior columns; idempotent upsert so a re-run never double-counts (mirror [[storefront-iteration-engine]] Phase 3 discipline).

## Phase 4 — Thompson-sampling stats + holdout/control + significance ⏳
- ⏳ planned
- `src/lib/storefront/bandit.ts` — Thompson sampling over the variant posteriors to (a) allocate the next exposures (minimize regret) and (b) report each arm's posterior win-probability vs the control/holdout. A daily/N-exposure refresh updates posteriors from Phase 3 rollups.
- **Significance + decision:** an arm is `promoted` only when its win-probability over control crosses a threshold at a minimum-exposure floor; a clear loser is `killed`. Until M3's reconciler has calibrated once, run **conservatively** — smaller traffic share to non-control arms, tighter promote threshold (the goal's "run conservatively until the slow loop calibrates" rule; the conservative flag is read from M3).
- Wire the run as an Inngest function (mirror `meta-scorecards-refresh` cadence) writing a run record; surface per-experiment posteriors on the [[../dashboard/storefront__funnel|funnel dashboard]].

## Phase 5 — Auto-rollback on regression ⏳
- ⏳ planned
- A guardrail pass on each refresh: if a `running` or just-`promoted` variant shows an **LTV-proxy regression vs control** (predicted-LTV-per-visitor below the control arm beyond a tolerance for ≥2 windows) **or a refund-spike** on its attributed cohort, auto-flip the experiment to `rolled_back`, restore the control content patch, and log the trigger + the offending posterior snapshot.
- Rollback is reversible-content only (it never touches a code deploy or an offer); a regression escalates to the [[../functions/growth|Growth director]] (surface, don't silently bury) per the supervisable-autonomy north star ([[../operational-rules]] § North star).

## Safety / invariants
- **Reversible levers only.** A variant payload is a content/config patch over a DB-driven lander (copy/hero/chapter) — never a code deploy, never an offer/pricing change (offers are M6, approval-gated). Promote/kill/rollback only swap which patch is live.
- **Sticky assignment.** A given identity (`customer_id ?? anonymous_id`) sees one arm for the life of the experiment — never flips, so attribution stays clean.
- **Holdout is sacred.** Every experiment carries a control/holdout arm; the bandit may starve a losing arm but never the control.
- **Idempotent attribution.** Exposure→outcome rollups upsert on stable keys; a refresh re-run never double-counts a conversion (the [[storefront-iteration-engine]] Phase 3 lesson).
- **Internal/bot traffic excluded** (reuse `storefront_sessions.is_internal`/`is_bot`).
- **Conservative until calibrated.** Smaller bets + tighter promote thresholds until M3's 4-month reconciler has calibrated the proxy once.
- **Supervisable, not silent.** Every promote/kill/rollback logs its triggering posterior snapshot + the rule invoked; a regression rollback escalates to Growth.

## Completion criteria
- `storefront_experiments` + `storefront_experiment_variants` tables exist (typed, RLS'd, brain pages written), with a control/holdout arm per experiment.
- A live experiment on Amazing Coffee assigns a sticky variant per session and emits `experiment_exposure` events into [[../tables/storefront_events]].
- Per-variant exposure→outcome rollups (sessions, conversions, sub-attach, revenue) populate over the delayed-purchase window, idempotently.
- Thompson-sampling allocates exposures, reports per-arm win-probability vs control, and promotes/kills at a significance + min-exposure threshold; runs conservatively while uncalibrated.
- An induced LTV-proxy / refund-spike regression auto-rolls-back the variant to control and escalates to Growth.
- The funnel dashboard surfaces running experiments + their posteriors.

## Verification
- Apply the migration → expect `✓ public.storefront_experiments has N columns` and `✓ public.storefront_experiment_variants has N columns`; in Supabase confirm the columns + the `status`/`lander_type` CHECKs.
- On an Amazing Coffee lander with one `running` experiment, load the page twice in one session → expect the SAME variant both times (sticky), and `select event_type, meta from storefront_events where event_type='experiment_exposure' order by created_at desc limit 1;` → a row carrying `{experiment_id, variant_id, is_holdout}`. Load as a flagged-internal session → expect NO exposure row.
- Place an order from an exposed session within the delayed-purchase window → expect the variant's rollup increments (sessions/conversions/sub-attach); re-run the attribution refresh → counts stable (idempotent).
- Trigger the bandit refresh (Inngest event) → expect per-arm posteriors updated and a run record; an arm crossing the threshold flips `status='promoted'`, a clear loser `killed`.
- Seed a variant whose attributed cohort sits below control on predicted-LTV for ≥2 windows → expect `status='rolled_back'`, the control patch restored, and a Growth escalation logged.
- On `/dashboard/storefront/funnel` → expect a running-experiments section showing each arm's win-probability vs control.
