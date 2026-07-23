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
| `build_lanes` | `int?` | total build/plan lanes (`MAX_CONCURRENT`) — the pool ceiling ([[../specs/build-box-status-view]]). Kept for back-compat with pre-`lane_groups` heartbeat readers; the box page prefers `lane_groups.build_plan.cap`. |
| `fold_lanes` | `int?` | total fold lanes (`MAX_FOLD`, concurrency-1). Kept for back-compat; the box page prefers `lane_groups.fold.cap`. |
| `lane_groups` | `jsonb?` | per-lane-group cap map: `{ build_plan: { cap, kinds[] }, customer_service: { cap, kinds[] }, director: { cap, kinds[] }, fold: { cap, kinds[] }, other: { cap, kinds[] } }`. Each entry is a named lane group with its OWN cap and the set of `agent_jobs.kind` values that count against it. The [[../dashboard/roadmap__box]] page + `BoxChip` render each group against its OWN cap by filtering `lanes` on the group's kind-set — before this the page lumped every non-fold kind against `build_lanes` and could show "13/10 in use". The kind-sets mirror the poll-loop `count*` helpers in `scripts/builder-worker.ts` (`countPlatformDirector` groups `platform-director + director-bounce-back + growth-director`; `countFold` groups `fold + goal-fold`; …). NULL on a heartbeat row written before the column existed — readers fall back to `build_lanes` / `fold_lanes`. |
| `lanes` | `jsonb` | default `'[]'` — `[{ kind, job_id, spec_slug, since, phase? }]` for every in-flight lane this tick (`phase` = `"Phase N"` for a chained/per-phase build, null otherwise — [[../specs/box-lane-show-phase]]) |
| `accounts` | `jsonb` | default `'{}'` — per-account Max load + failover state ([[../specs/box-multi-account-failover]] Phase 2): `{ pool: [{ label, in_flight, capped, capped_until }], healthy, total, all_capped, soonest_reset, events: [{ at, type, account, detail }] }`. `events.type` ∈ `cap｜failover｜all_capped｜recovered` (newest first, ring of ≤12). `{}` on a single-account / legacy box ⇒ readers treat as null. **`pool[].in_flight` is the GROUND-TRUTH active-lane count** (`activeLaneCountForAccount` off the `laneAccount` map — one entry per running lane, cleared in the single outer `runJob().finally`), NOT the free-running `acct.inFlight` counter. The counter used to be shown and drifted UP (a missed `inFlight--` on a reap/crash bail) + double-counted a `runBoxLane` lane (`withAccountFailover` and `runBoxSession` both `inFlight++`) — "Round Robin 2: 5 in flight" with 3 real lanes. The worker also reconciles `acct.inFlight` to this ground truth each heartbeat tick (`reconcileAccountLoad`) so the round-robin least-loaded selection self-heals — `consolidate-grade-coach-one-session` Phase 2. |
| `started_at` | `timestamptz?` | when this worker process booted |
| `last_poll_at` | `timestamptz?` | heartbeat — set every poll tick (~30s, widened from ~5s 2026-07-22); a stale value ⇒ box down |
| `updated_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writer:** the box worker, every poll tick (`writeHeartbeat()`), plus a one-off `status='updating'` just before a self-update exit and a one-off `status='needs_attention'` when the crash-loop guard gives up. Service role (the worker holds the creds).
- **Reader:** [[../dashboard/branches]] via `GET /api/branches` (returns a `worker` object). The page renders a **Build box** banner — `worker <sha> · healthy/idle · last poll Ns ago` — green when the last poll is < 90s old, red when stale or `needs_attention`. Any authenticated workspace member can read (box infra is global, not workspace-scoped).
- **Reader:** [[../dashboard/roadmap]] `/dashboard/roadmap/box` via `GET /api/roadmap/box` (returns `worker` + open `agent_jobs` split into `queue`/`paused`). The **live build-box view** ([[../specs/build-box-status-view]]): health + SHA, a **Max accounts** panel (per-account load + an all-capped banner + recent cap/failover events, from `accounts` — [[../specs/box-multi-account-failover]] P2), the **per-lane-group lane grid** ([[../dashboard/roadmap__box]] — one `LaneRowGrid` per `lane_groups` entry, each showing in-use/cap for its OWN kinds against the group's OWN cap), queue depth, and a paused callout — plus a compact lane/health **chip** on the roadmap board header (counts the build/plan pool only). **Live via Realtime Broadcast, not polling** (roadmap-box-broadcast) — see below.

### Trigger — `worker_heartbeats_broadcast_trg` (live SHA/liveness)

`20261203120000`. An `after insert or update` trigger that `realtime.send(..., 'box_change', 'box:'||<single-tenant workspace>, private)` — pushing the box's `running_sha` + liveness + lane usage to the roadmap/box dashboards live, so they no longer poll `/api/roadmap/box` (was ~5s page / ~10s chip). This row updates every poll tick (~30s) and on restart but **never touches `agent_jobs`**, so it needs its OWN broadcast trigger — otherwise a SHA change on an idle box would only surface on the client's slow backstop. Being a global **singleton** (no `workspace_id`), it resolves the topic's workspace via the "oldest workspace" rule (matching [[../libraries/brain-roadmap]] `resolveDefaultWorkspaceId`). Consumed by [[../libraries/use-box-live]]; feeds the same `box:<ws>` topic as [[agent_jobs]] + [[roadmap_chats]]. Broadcast (not Postgres Changes — RLS/Walrus bug); see [[../recipes/realtime-subscriptions]].
- **Reader:** [[../libraries/control-tower]] `evalWorker` (the box tile on [[../dashboard/control-tower]]) reads `accounts.all_capped` → amber "all Max accounts capped — builds parked, auto-resume" so an everything's-capped throughput stall isn't silent behind a green box, and surfaces per-account load in the tile's `lastProduced` ([[../specs/box-multi-account-failover]] P2).

## Gotchas

- **Health = recency, not just `status`.** A worker that died can't flip its own row to unhealthy, so the dashboard treats a stale `last_poll_at` as down regardless of the stored `status`. The registry [[../libraries/control-tower]] liveness window for the box worker is 5 min (`livenessWindowMs`), comfortably > the `POLL_MS` cadence — which was widened ~5s → **~30s** (2026-07-22, box-loop-30s-db-load) to cut the always-on DB-request floor; the worker still bumps `last_poll_at` every tick, so a ~30s cadence stays many ticks inside the 5-min window.
- **Not workspace-scoped.** Unlike [[agent_jobs]], the box is global infra; the select policy is "any authenticated user" (`auth.uid() is not null`), not workspace membership.
- **Self-update never runs mid-build — and a stale-but-busy box QUEUES a restart instead of force-killing.** The worker only resets/exits when `active_builds === 0`; an in-flight lane keeps the old code until it clears. When the box is far behind (`≥ FORCE_STALE_COMMITS`) AND busy, it no longer abandons in-flight builds — it sets the `worker_controls.drain_for_update` flag (`status='draining'`), stops claiming new work (incoming jobs queue), drains to idle, then self-updates on the fresh SHA. Same drain the "Queue restart" button triggers manually. NEVER kills a live session (see [[../specs/worker-self-update]] § Safety).

## Migration

`supabase/migrations/20260619140000_worker_heartbeats.sql` (table + RLS) · apply: `scripts/apply-worker-heartbeats-migration.ts`
`supabase/migrations/20260619150000_worker_heartbeats_lanes.sql` (lane detail: `build_lanes`/`fold_lanes`/`lanes`) · apply: `scripts/apply-worker-heartbeats-lanes-migration.ts` ([[../specs/build-box-status-view]])
`supabase/migrations/20260622220000_worker_heartbeats_accounts.sql` (per-account Max load: `accounts`) · apply: `scripts/apply-worker-heartbeats-accounts-migration.ts` ([[../specs/box-multi-account-failover]] Phase 2)
`supabase/migrations/20261001120000_worker_heartbeats_lane_groups.sql` (per-lane-group caps: `lane_groups`) · apply: `scripts/apply-worker-heartbeats-lane-groups-migration.ts`

## Related

[[../specs/worker-self-update]] · [[../specs/box-self-update-persist-skip-reason]] · [[../recipes/build-box-setup]] · [[../dashboard/branches]] · [[agent_jobs]] · [[../lifecycles/roadmap-build-console]]
