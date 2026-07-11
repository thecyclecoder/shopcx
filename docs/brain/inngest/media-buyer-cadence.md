# inngest/media-buyer-cadence

The daily cadence cron that enqueues the Media Buyer agent across every ACTIVE [[../tables/media_buyer_test_cohorts]] row ([[../specs/media-buyer-daily-cadence-cron]] Phase 1 — the missing daily-cadence piece of the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode (read-only)" milestone). Once daily it finds every workspace with ≥1 active cohort row, fans out one event per workspace, and the per-workspace handler inserts one [[../tables/agent_jobs]] row `kind='media-buyer'` per (workspace, meta_ad_account_id) pair — narrowed to that account via `instructions.meta_ad_account_id` (or `null` for a workspace-wide cohort → the runner fans out over every connected [[../tables/meta_ad_accounts]] row). Same-UTC-day re-fires are a no-op — the sweep skips any pair with an unfinished `kind='media-buyer'` job already created today.

**File:** `src/lib/inngest/media-buyer-cadence.ts` · agent runner in [[../libraries/media-buyer-agent]] (`runMediaBuyerLoop` invoked by the box worker's `runMediaBuyerJob` lane)

## Functions

### `media-buyer-cadence-cron`
- **Trigger:** cron `0 13 * * *` (once daily at 13:00 UTC — 1h after the growth-ad-spend-governor pass so the fresh `daily_meta_ad_spend` snapshot from the sync is already in and the ad-spend supervisor has already run)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads `media_buyer_test_cohorts.workspace_id` (distinct, `is_active=true`) — every workspace that has opted the Media Buyer's autonomous go-live in. For each, it `step.sendEvent("growth/media-buyer-cadence-sweep", { workspace_id })`. End-of-run heartbeat via `emitCronHeartbeat("media-buyer-cadence-cron", { ok:true, produced:{evaluated, dispatched}, detail })`.
- **Returns** `{ evaluated, dispatched }` (workspaces observed + sweeps fanned out — always equal here).

### `media-buyer-cadence-sweep`
- **Trigger:** event `growth/media-buyer-cadence-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls `dispatchMediaBuyerCadence(admin, workspace_id)` which (1) selects every active cohort row for the workspace, (2) reads every `kind='media-buyer'` [[../tables/agent_jobs]] row for the workspace created since the current UTC day's midnight, (3) inserts one new `agent_jobs` row per cohort whose `meta_ad_account_id` pair isn't already covered by an unfinished job today. Each insert carries `instructions = { meta_ad_account_id }` (verbatim from the cohort row) so the [[../libraries/media-buyer-agent]] runner narrows to that account; a workspace-wide cohort writes `meta_ad_account_id: null` so the runner fans out across every connected account. The insert also stamps `spec_slug = mediaBuyerSpecSlug(account)` — a per-cadence-slot key (`media-buyer:<account-id>` per-account, `media-buyer:workspace` workspace-wide) so the `agent_jobs.spec_slug NOT NULL` column is satisfied and the Roadmap rollup index (`agent_jobs_slug_idx (workspace_id, spec_slug, created_at desc)`) groups a slot's history. An "unfinished" job is one whose `status` ∈ `queued|claimed|building|needs_input|needs_approval|queued_resume|blocked_on_usage` (the `ACTIVE_MEDIA_BUYER_JOB_STATUSES` set).
- **Returns** `{ status: "complete", evaluated, dispatched }`.

## Idempotency

Both a same-UTC-day re-fire of the cron and a duplicate `growth/media-buyer-cadence-sweep` event are safe no-ops: the sweep re-reads today's `agent_jobs`, matches by `instructions.meta_ad_account_id`, and dispatches only for pairs not already covered by an unfinished row. A `completed`/`failed`/terminal job from earlier today does NOT block a fresh dispatch — the day's real cadence beats the terminated attempt.

## Shadow-default under the M2 policy

Under the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode (read-only)" milestone, the newest [[../tables/media_buyer_iteration_policy]] row for the workspace is `mode='shadow'` → the [[../libraries/media-buyer-agent]] shadow branch fires (proposed writes routed to the [[../tables/media_buyer_shadow_reviews]] inbox; no Meta writes). So this cron is safe to enable BEFORE any workspace flips the policy live — the whole rail is inert until the owner promotes the policy.

## North-star invariant

The cadence cron is a **dispatch tool** ([[../operational-rules]] § North star): it enqueues supervision passes, it never publishes an ad or moves a budget itself. The Media Buyer agent is the supervised worker on the run's proxies (cohort ROAS, per-account spend); its rails ([[../libraries/media-buyer-publish-gate]], the M2 shadow branch, the [[../libraries/ad-spend-governor]]) are what actually gate writes.

## Downstream events sent

- `growth/media-buyer-cadence-sweep` (one per workspace with an active cohort, from the cron's fan-out)

Downstream side effect from the sweep is a `kind='media-buyer'` [[../tables/agent_jobs]] insert per new (workspace, meta_ad_account_id) pair. The box worker's `runMediaBuyerJob` lane picks it up and runs [[../libraries/media-buyer-agent]] `runMediaBuyerLoop`.

## Tables written

- [[../tables/agent_jobs]] (one `kind='media-buyer'` row per new (workspace, meta_ad_account_id) pair — `instructions = { meta_ad_account_id }`, `spec_slug = media-buyer:<account-id>` or `media-buyer:workspace`)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/media_buyer_test_cohorts]] (active-cohort discovery + per-cohort `meta_ad_account_id`)
- [[../tables/agent_jobs]] (today's `kind='media-buyer'` rows for idempotency)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs` 26h, `registeredAt: 2026-07-08T13:00:00Z` for the newcron-grace) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer-agent]] · [[../libraries/media-buyer-publish-gate]] · [[../libraries/media-buyer-grader]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/media_buyer_iteration_policy]] · [[../tables/media_buyer_shadow_reviews]] · [[../tables/agent_jobs]] · [[growth-ad-spend-governor]] · [[../specs/media-buyer-daily-cadence-cron]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
