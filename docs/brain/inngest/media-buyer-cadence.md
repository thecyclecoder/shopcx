# inngest/media-buyer-cadence

The daily cadence cron that enqueues the Media Buyer agent for each workspace with ≥1 active [[../tables/media_buyer_test_cohorts]] row ([[../specs/media-buyer-daily-cadence-cron]] Phase 1 — the missing daily-cadence piece of the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode (read-only)" milestone). Once daily it fans out one event per workspace, and the per-workspace handler inserts EXACTLY ONE workspace-scoped [[../tables/agent_jobs]] row `kind='media-buyer'` (`instructions.meta_ad_account_id = null`, `spec_slug = 'media-buyer:workspace'`). The box-worker media-buyer lane downstream fans the single job out across every connected [[../tables/meta_ad_accounts]] row × the account's active per-product cohorts, and delivers ONE consolidated Growth-Director digest at the end (media-buyer-digest-consolidate-product-names-suppress-noop Phase 2). Same-UTC-day re-fires are a no-op — the sweep skips any workspace whose slot is already covered by an unfinished `kind='media-buyer'` job created today.

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
- **What it does:** calls `dispatchMediaBuyerCadence(admin, workspace_id)` which (1) reads every active cohort row for the workspace (evaluated-count only — the dispatcher no longer fans out per cohort), (2) reads every `kind='media-buyer'` [[../tables/agent_jobs]] row for the workspace created since the current UTC day's midnight, (3) if ≥1 active cohort exists AND no unfinished workspace-scoped row already covers today, inserts EXACTLY ONE row: `instructions = { meta_ad_account_id: null }`, `spec_slug = 'media-buyer:workspace'`. The downstream box-worker media-buyer lane resolves `instructions.meta_ad_account_id=null` as "fan out across every connected [[../tables/meta_ad_accounts]] row" and runs `runMediaBuyerLoopForAccount` per account — that helper itself fans out over the account's active per-product cohorts + preserves the dormant-heartbeat pass for a null-product cohort. One job → one run → one consolidated digest (media-buyer-digest-consolidate-product-names-suppress-noop Phase 2). An "unfinished" job is one whose `status` ∈ `queued|claimed|building|needs_input|needs_approval|queued_resume|blocked_on_usage` (the `ACTIVE_MEDIA_BUYER_JOB_STATUSES` set); ANY such row for the workspace covers the slot (including legacy per-account rows in flight during the Phase-2 rollout, so no duplicate lands).
- **Returns** `{ status: "complete", evaluated, dispatched }` where `evaluated` is the active-cohort count (preserves the pre-Phase-2 cron log signal) and `dispatched` ∈ `{0, 1}`.

## Idempotency

Both a same-UTC-day re-fire of the cron and a duplicate `growth/media-buyer-cadence-sweep` event are safe no-ops: the sweep re-reads today's `agent_jobs`, checks whether ANY unfinished `kind='media-buyer'` row already covers the workspace, and skips the insert when so. A `completed`/`failed`/terminal job from earlier today does NOT block a fresh dispatch — the day's real cadence beats the terminated attempt.

## Shadow-default under the M2 policy

Under the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode (read-only)" milestone, the newest [[../tables/media_buyer_iteration_policy]] row for the workspace is `mode='shadow'` → the [[../libraries/media-buyer-agent]] shadow branch fires (proposed writes routed to the [[../tables/media_buyer_shadow_reviews]] inbox; no Meta writes). So this cron is safe to enable BEFORE any workspace flips the policy live — the whole rail is inert until the owner promotes the policy.

## North-star invariant

The cadence cron is a **dispatch tool** ([[../operational-rules]] § North star): it enqueues supervision passes, it never publishes an ad or moves a budget itself. The Media Buyer agent is the supervised worker on the run's proxies (cohort ROAS, per-account spend); its rails ([[../libraries/media-buyer-publish-gate]], the M2 shadow branch, the [[../libraries/ad-spend-governor]]) are what actually gate writes.

## Downstream events sent

- `growth/media-buyer-cadence-sweep` (one per workspace with an active cohort, from the cron's fan-out)

Downstream side effect from the sweep is exactly ONE workspace-scoped `kind='media-buyer'` [[../tables/agent_jobs]] insert per workspace per pass (media-buyer-digest-consolidate-product-names-suppress-noop Phase 2). The box worker's `runMediaBuyerJob` lane picks it up, fans out over the workspace's connected [[../tables/meta_ad_accounts]] × per-product cohorts, and delivers ONE consolidated digest.

## Tables written

- [[../tables/agent_jobs]] (EXACTLY ONE `kind='media-buyer'` workspace-scoped row per pass — `instructions = { meta_ad_account_id: null }`, `spec_slug = 'media-buyer:workspace'`)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/media_buyer_test_cohorts]] (active-cohort discovery + per-cohort `meta_ad_account_id`)
- [[../tables/agent_jobs]] (today's `kind='media-buyer'` rows for idempotency)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs` 26h, `registeredAt: 2026-07-08T13:00:00Z` for the newcron-grace) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer-agent]] · [[../libraries/media-buyer-publish-gate]] · [[../libraries/media-buyer-grader]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/media_buyer_iteration_policy]] · [[../tables/media_buyer_shadow_reviews]] · [[../tables/agent_jobs]] · [[growth-ad-spend-governor]] · [[../specs/media-buyer-daily-cadence-cron]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
