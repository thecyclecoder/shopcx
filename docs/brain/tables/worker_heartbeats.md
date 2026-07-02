# worker_heartbeats

The box build worker's liveness + visibility row ([[../specs/worker-self-update]] Phase 3). The worker (`scripts/builder-worker.ts`, [[../recipes/build-box-setup]]) **upserts one row per poll tick** so the dashboard can answer "what SHA is the box running, is it idle, is it healthy?" without SSH. A **singleton** keyed by `id` (default `'box'`; the `id` column supports more than one box later).

This is the answer to the gap that bit us on 2026-06-18/19: a merged worker fix ([[../specs/build-lifecycle-hardening]] #77) was **inert until a human redeployed**, with no UI signal the box was behind. Now the worker [[../specs/worker-self-update|self-updates when idle]] and writes its running SHA here.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | PK · default `'box'` — one row per box |
| `running_sha` | `text?` | short SHA (`git rev-parse --short HEAD`) the worker process is running, captured at boot |
| `status` | `text` | `healthy` (default) ｜ `draining` (queued restart: far behind + busy → claiming paused, finishing in-flight lanes before the idle self-update) ｜ `updating` (mid self-update, about to exit→restart) ｜ `needs_attention` (crash-loop guard tripped) |
| `active_builds` | `int` | lanes busy at the last tick (`active.size`) · `0` = idle |
| `detail` | `text?` | last note. On a healthy poll tick it carries the **self-update skip reason** ([[../specs/box-self-update-persist-skip-reason]]) — `self-update skipped: git fetch failed …` \| `self-update skipped: watchdog quarantine on <sha> — holding on <sha>` \| `self-update deferred: busy w/ N active build(s), non-runtime change` \| `self-update skipped: git reset failed …` — so the [[../libraries/control-tower]] box tile flips from a bare `self-update stuck for Xh` red to `stuck for Xh · <cause>`. Cleared to null when the worker is fully current + on the successful update path. Also carries the one-off `self-update <from>→<to>` on the pre-exit `status='updating'` tick, `restart queued — <N> behind …` on the drain-request tick, and the crash-loop reason on `status='needs_attention'`. |
| `build_lanes` | `int?` | total build/plan lanes (`MAX_CONCURRENT`) — the pool ceiling ([[../specs/build-box-status-view]]) |
| `fold_lanes` | `int?` | total fold lanes (`MAX_FOLD`, concurrency-1) |
| `lanes` | `jsonb` | default `'[]'` — `[{ kind, job_id, spec_slug, since, phase? }]` for every in-flight lane this tick (`phase` = `"Phase N"` for a chained/per-phase build, null otherwise — [[../specs/box-lane-show-phase]]) |
| `accounts` | `jsonb` | default `'{}'` — per-account Max load + failover state ([[../specs/box-multi-account-failover]] Phase 2): `{ pool: [{ label, in_flight, capped, capped_until }], healthy, total, all_capped, soonest_reset, events: [{ at, type, account, detail }] }`. `events.type` ∈ `cap｜failover｜all_capped｜recovered` (newest first, ring of ≤12). `{}` on a single-account / legacy box ⇒ readers treat as null. **`pool[].in_flight` is the GROUND-TRUTH active-lane count** (`activeLaneCountForAccount` off the `laneAccount` map — one entry per running lane, cleared in the single outer `runJob().finally`), NOT the free-running `acct.inFlight` counter. The counter used to be shown and drifted UP (a missed `inFlight--` on a reap/crash bail) + double-counted a `runBoxLane` lane (`withAccountFailover` and `runBoxSession` both `inFlight++`) — "Round Robin 2: 5 in flight" with 3 real lanes. The worker also reconciles `acct.inFlight` to this ground truth each heartbeat tick (`reconcileAccountLoad`) so the round-robin least-loaded selection self-heals — `consolidate-grade-coach-one-session` Phase 2. |
| `started_at` | `timestamptz?` | when this worker process booted |
| `last_poll_at` | `timestamptz?` | heartbeat — set every poll tick (~5s); a stale value ⇒ box down |
| `updated_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writer:** the box worker, every poll tick (`writeHeartbeat()`), plus a one-off `status='updating'` just before a self-update exit and a one-off `status='needs_attention'` when the crash-loop guard gives up. Service role (the worker holds the creds).
- **Reader:** [[../dashboard/branches]] via `GET /api/branches` (returns a `worker` object). The page renders a **Build box** banner — `worker <sha> · healthy/idle · last poll Ns ago` — green when the last poll is < 90s old, red when stale or `needs_attention`. Any authenticated workspace member can read (box infra is global, not workspace-scoped).
- **Reader:** [[../dashboard/roadmap]] `/dashboard/roadmap/box` via `GET /api/roadmap/box` (returns `worker` + open `agent_jobs` split into `queue`/`paused`). The **live build-box view** ([[../specs/build-box-status-view]]): health + SHA, a **Max accounts** panel (per-account load + an all-capped banner + recent cap/failover events, from `accounts` — [[../specs/box-multi-account-failover]] P2), the lane grid (`build_lanes`/`fold_lanes` cells, each in-use cell from a `lanes` row), queue depth, and a paused callout — plus a compact lane/health **chip** on the roadmap board header. Polls ~5s (chip ~10s).
- **Reader:** [[../libraries/control-tower]] `evalWorker` (the box tile on [[../dashboard/control-tower]]) reads `accounts.all_capped` → amber "all Max accounts capped — builds parked, auto-resume" so an everything's-capped throughput stall isn't silent behind a green box, and surfaces per-account load in the tile's `lastProduced` ([[../specs/box-multi-account-failover]] P2).

## Gotchas

- **Health = recency, not just `status`.** A worker that died can't flip its own row to unhealthy, so the dashboard treats a `last_poll_at` older than ~90s (vs the ~5s `POLL_MS`) as down regardless of the stored `status`.
- **Not workspace-scoped.** Unlike [[agent_jobs]], the box is global infra; the select policy is "any authenticated user" (`auth.uid() is not null`), not workspace membership.
- **Self-update never runs mid-build — and a stale-but-busy box QUEUES a restart instead of force-killing.** The worker only resets/exits when `active_builds === 0`; an in-flight lane keeps the old code until it clears. When the box is far behind (`≥ FORCE_STALE_COMMITS`) AND busy, it no longer abandons in-flight builds — it sets the `worker_controls.drain_for_update` flag (`status='draining'`), stops claiming new work (incoming jobs queue), drains to idle, then self-updates on the fresh SHA. Same drain the "Queue restart" button triggers manually. NEVER kills a live session (see [[../specs/worker-self-update]] § Safety).

## Migration

`supabase/migrations/20260619140000_worker_heartbeats.sql` (table + RLS) · apply: `scripts/apply-worker-heartbeats-migration.ts`
`supabase/migrations/20260619150000_worker_heartbeats_lanes.sql` (lane detail: `build_lanes`/`fold_lanes`/`lanes`) · apply: `scripts/apply-worker-heartbeats-lanes-migration.ts` ([[../specs/build-box-status-view]])
`supabase/migrations/20260622220000_worker_heartbeats_accounts.sql` (per-account Max load: `accounts`) · apply: `scripts/apply-worker-heartbeats-accounts-migration.ts` ([[../specs/box-multi-account-failover]] Phase 2)

## Related

[[../specs/worker-self-update]] · [[../specs/box-self-update-persist-skip-reason]] · [[../recipes/build-box-setup]] · [[../dashboard/branches]] · [[agent_jobs]] · [[../lifecycles/roadmap-build-console]]
