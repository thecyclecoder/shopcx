# inngest/ads-supervisor-cadence

The 3-hourly cadence cron that fires the persistent supervisory pass over Bianca ([[../libraries/media-buyer-agent]]) + Dahlia ([[../libraries/creative-agent]]) — the standing every-3h audit that keeps the crown/kill loop + creative bins honest and repairs the two growth workers via authored fix-specs ([[../specs/growth-ads-supervisor-3h-agent]] Phase 1). The founder wanted a persistent supervisor beyond any interactive `CronCreate` session; this is that deployed box agent (like Reva/Mario/Sol). It NEVER moves spend / pauses / crowns / places ads directly (north-star: supervisable autonomy — the supervisor never becomes a proxy-optimizer) — it PROPOSES via fix-specs Bianca and Dahlia consume, and posts one digest to #director-growth-max.

**File:** `src/lib/inngest/ads-supervisor-cadence.ts` · lane runner in `scripts/builder-worker.ts` (`runAdsSupervisorJob`)

## Functions

### `ads-supervisor-cadence`
- **Trigger:** cron `14 */3 * * *` (every 3h at :14 — the :14 offset stays clear of the daily media-buyer / ad-creative cadence crons that fire on `:00`)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads `media_buyer_test_cohorts.workspace_id` (distinct, `is_active=true`) — every workspace that has opted the growth stack in. For each, it `step.sendEvent("growth/ads-supervisor-sweep", { workspace_id })`. End-of-run heartbeat via `emitCronHeartbeat("ads-supervisor-cadence", { ok:true, produced:{evaluated, dispatched}, detail })`.
- **Returns** `{ evaluated, dispatched }` (workspaces observed + sweeps fanned out — always equal here).

### `ads-supervisor-cadence-sweep`
- **Trigger:** event `growth/ads-supervisor-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls `dispatchAdsSupervisor(admin, workspace_id)` which (1) confirms the workspace has ≥1 active [[../tables/media_buyer_test_cohorts]] row (else no-op), (2) reads every `kind='ads-supervisor'` [[../tables/agent_jobs]] row for the workspace and checks whether any is still in a not-yet-terminal status (`ACTIVE_MEDIA_BUYER_JOB_STATUSES`), (3) if none is open, inserts EXACTLY ONE workspace-scoped row: `spec_slug = 'ads-supervisor:workspace'`, `instructions = { trigger: 'cron' }`.
- **Returns** `{ status: "complete", evaluated, dispatched }` where `evaluated` is 0 or 1 (has-active-cohort) and `dispatched` ∈ `{0, 1}`.

## Idempotency

At a 3h cadence a still-running prior pass covers the slot, so the dedup is unbounded — the sweep skips the insert whenever ANY not-yet-terminal `kind='ads-supervisor'` row already exists for the workspace. A `completed`/`failed`/terminal row from an earlier tick does NOT block a fresh dispatch — the next 3h beat re-dispatches. A same-tick re-fire of the cron (or a duplicate sweep event) is a safe no-op.

## What the pass does (Phase 2 — filled in by a follow-up)

Phase 1 wires the cron + the dispatchable box lane + the node-completeness trio (owner / kill-switch / heartbeat) and ships a heartbeat-emitting stub lane. Phase 2 implements the pass logic inside `runAdsSupervisorJob`: getTestingResults (via [[../libraries/testing-results-sdk]]) → iteration-policies decision tree → should-pause / should-crown list → Bianca-acted check via `media_buyer_iteration_actions` + `director_activity` → Dahlia bin depth vs floor (archived-excluded) + competitor-seeded proven-angles check → live-ad LF8 QA of headline / primary-text / destination → deduped fix-spec authoring via `authorSpecRowStructured` (owner=growth, machine-only checks) → ONE director-voice digest to #director-growth-max (`postAsGrowthDirector`), suppressing identical no-op digests.

## Node-completeness trio (CLAUDE.md hard rule)

- **Owner:** `growth` on the cron row in [[../libraries/control-tower]] AND on the `ads-supervisor` agent-kind (in `src/lib/control-tower/node-registry.ts` `KIND_OWNER_FALLBACK` + `BUILDER_WORKER_KINDS`).
- **Kill-switch:** covered by the ancestor `growth` department row in [[../tables/kill_switches]] (the cascade in [[../libraries/kill-switch-resolver]] resolves any child owned by growth) — no per-cron/per-agent row required, per the node-completeness rule ("its own row OR an ancestor's").
- **Heartbeat:** the cron emits `emitCronHeartbeat("ads-supervisor-cadence", ...)` at end-of-run; the box lane emits `emitAgentHeartbeat("ads-supervisor", ...)` in a try/finally (ok:false on throw).

## North-star invariant

The cadence cron is a **dispatch tool** ([[../operational-rules]] § North star): it enqueues supervisory passes; it never moves spend or edits a live ad itself. The pass it dispatches is the SUPERVISOR of Bianca + Dahlia — it AUDITS them and REPAIRS them (via fix-specs) — never a proxy-optimizer on their behalf.

## Downstream events sent

- `growth/ads-supervisor-sweep` (one per workspace with an active cohort, from the cron's fan-out)

Downstream side effect from the sweep is exactly ONE workspace-scoped `kind='ads-supervisor'` [[../tables/agent_jobs]] insert per workspace per pass (dedup-gated). The box worker's `runAdsSupervisorJob` lane picks it up.

## Tables written

- [[../tables/agent_jobs]] (EXACTLY ONE `kind='ads-supervisor'` workspace-scoped row per pass — `instructions = { trigger: 'cron' }`, `spec_slug = 'ads-supervisor:workspace'`)
- [[../tables/loop_heartbeats]] (its own end-of-run cron beat)

## Tables read (not written)

- [[../tables/media_buyer_test_cohorts]] (active-workspace fan-out set)
- [[../tables/agent_jobs]] (open `kind='ads-supervisor'` rows for idempotency)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth`, `expectedCadence: "every 3h (14 */3 * * *)"`, `livenessWindowMs: 4h` (3h × 1.2 = 3.6h clears the jitter grace; 4h leaves comfortable slack — satisfies `assertRegistryInvariants`). `registeredAt: 2026-07-14T00:00:00Z` for the newcron-grace. Per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer-agent]] · [[../libraries/creative-agent]] · [[../libraries/testing-results-sdk]] · [[../libraries/ads-analysis]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/agent_jobs]] · [[media-buyer-cadence]] · [[ad-creative-cadence]] · [[../specs/growth-ads-supervisor-3h-agent]] · [[../functions/growth]]
