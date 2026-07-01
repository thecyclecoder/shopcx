# `src/lib/inngest/storefront-optimizer.ts` — Storefront Optimizer scheduling

The Phase-1 trigger of the [[../specs/storefront-optimizer-agent|Storefront Optimizer agent]] (M4). Daily, enqueues one `storefront-optimizer` [[../tables/agent_jobs]] campaign cycle per DUE (product × lander-type × audience) for each workspace with an active optimizer policy. The box worker (`runStorefrontOptimizerJob`) claims the queued jobs on its own concurrency-1 lane. Heavy lifting in [[../libraries/storefront-optimizer-agent]]. Spec `docs/brain/specs/storefront-optimizer-agent.md`.

## Functions

| Function | Trigger | Does |
|---|---|---|
| `storefrontOptimizerCron` | cron `30 14 * * *` (daily, after the M1 refresh at 12:00 + M2 decay at 13:00) | Fan-out: finds every workspace with an `active=true` [[../tables/storefront_optimizer_policy]] row. **Tier-0** (before the fan-out): runs [[../libraries/storefront-lever-memory]] `seedChapterPriorsFromFunnel({apply:true})` per workspace so the outcome-anchored chapter priors (funnel-tree bottleneck → GET-TO-PRICING vs DECISION boost, per-surface dwell+CTA fallback) are fresh for the day's lever pick. Best-effort per workspace — a seed failure logs and lets the schedule fan-out proceed. Then fires one `storefront/optimizer-schedule` event per workspace. Heartbeats every tick. |
| `storefrontOptimizerSchedule` | event `storefront/optimizer-schedule` (concurrency 1 per `workspace_id`) | Per-workspace worker: `enqueueDueCampaigns` — insert one `storefront-optimizer` agent_jobs row per DUE surface (in-scope · no active campaign · no live job · next-best lever ≥ `MIN_LEVER_SCORE_TO_TEST`). |

## Events
- **Listens:** `storefront/optimizer-schedule` `{ workspace_id }`.
- **Sends:** `storefront/optimizer-schedule` (cron → worker fan-out).

## Tables
- **Reads:** [[../tables/storefront_optimizer_policy]] (active + product_scope), [[../tables/storefront_lever_importance]] / [[../tables/storefront_levers]] (next-best lever), [[../tables/storefront_experiments]] (surface dedup), [[../tables/agent_jobs]] (queue dedup), [[../tables/storefront_events]] + [[../tables/storefront_sessions]] (funnel-tree bottleneck signal for the Tier-0 chapter-prior seed).
- **Writes:** [[../tables/agent_jobs]] (`kind='storefront-optimizer'`, `spec_slug=product:lander:audience`, `instructions={workspace_id, product_id, lander_type, audience, lever_key, lever_reason}`); [[../tables/storefront_levers]] `prior` (chapter-level rows, refreshed daily by the Tier-0 seed).

## Gotchas
- **Cadence after the learning loop.** Scheduled after the daily M1 attribution refresh + M2 decay so the next-best lever reflects the day's committed learnings.
- **Off by default.** The cron only fans out to workspaces whose `storefront_optimizer_policy.active=true` — a dark workspace produces zero jobs.
- **Deduped + bounded.** ≤1 active campaign per surface (`hasActiveCampaignForSurface`) and ≤1 live optimizer job per surface (queue dedup) — mirrors the [[../specs/repair-agent]] / [[../specs/box-escalation-triage]] enqueue discipline.
- **Registered** in `src/lib/inngest/registered-functions.ts` (both functions) — the serve route picks them up.
