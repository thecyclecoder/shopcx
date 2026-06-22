# loop_heartbeats

The Control Tower's per-run liveness log ([[../specs/control-tower]] Phase 1). Every monitored **cron** and box **agent-kind** runner writes **one row at the END of each run** so the [[../inngest/control-tower-monitor]] cron (and the [[../dashboard/control-tower]] dashboard) can answer "did this loop actually run, and did it do its job?". The box build worker itself is the exception — its ~5s poll beat lives in [[worker_heartbeats]], not here (one row every 5s would be enormous); this table is for loops whose "run" is a discrete event.

**Global infra, not workspace-scoped** — the box + crons are one shared fleet (same model as [[worker_heartbeats]]). RLS: any authenticated user reads; the service role does all writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `loop_id` | `text` | the monitored loop's stable id — a cron's **inngest function id** (e.g. `triage-escalations-cron`), `agent:<kind>` for a box agent-kind run (e.g. `agent:build`), or `ai:<name>` for an inline AI agent (e.g. `ai:ticket-analyzer`). Matches an `id` in the registry (`src/lib/control-tower/registry.ts`) |
| `kind` | `text` | `cron` ｜ `agent-kind` ｜ `inline-agent` — which loop type emitted this (free text; no CHECK constraint) |
| `ran_at` | `timestamptz` | end-of-run timestamp · default `now()` · the freshness signal |
| `ok` | `boolean` | default `true` · `false` ⇒ the run threw or reported a failure (surfaced amber in P1; the page-on-it false-success assertion is P2) |
| `produced` | `jsonb?` | what the run produced this cycle — counts/summary, e.g. `{ enqueued, workspaces }` (cron) or `{ status }` (agent-kind) |
| `detail` | `text?` | free-text note |
| `duration_ms` | `int?` | run wall-clock |
| `created_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writers:** each monitored cron via `emitCronHeartbeat()` ([[../libraries/control-tower]]) wrapped in a `step.run("emit-heartbeat", …)` before its return — [[../inngest/triage-escalations]], [[../inngest/spec-test-cron]], [[../inngest/migration-audit-retry]], [[../inngest/migration-integrity-sweep]], [[../inngest/internal-subscription-renewals]], [[../inngest/social-scheduler]], and [[../inngest/control-tower-monitor]] itself. The box worker writes the `agent:<kind>` beats inline (`writeLoopHeartbeat` in `scripts/builder-worker.ts`, in the `launch()` finally — one beat per agent-job run). The 3 inline AI agents write `ai:<name>` beats via `emitInlineAgentHeartbeat()` in a try/finally at the end of each run — [[../libraries/ticket-analyzer]] (`analyzeTicket`), [[../libraries/journey-delivery]] (`launchJourneyForTicket`), [[../libraries/fraud-detector]] (`checkOrderForFraud`). Service role.
- **Reader:** [[../inngest/control-tower-monitor]] (`buildControlTowerSnapshot`) reads the latest beat per `loop_id` to decide cron freshness + last-ran; for inline agents it reads the in-window beats (success/error counts) plus a per-agent upstream work count. The [[../dashboard/control-tower]] dashboard reads the last ~10 beats per loop for the tile history strip.

## Gotchas

- **Cron freshness = recency of the latest beat**, evaluated against each loop's `livenessWindowMs` in the registry (cadence + grace). No beat *ever* ⇒ **amber** ("awaiting first run"), never red — so a freshly-shipped cron doesn't false-alarm before its first tick.
- **Agent-kind beats are NOT used for the alert.** A genuinely-idle lane (no builds queued) must stay **green**, so the STUCK-JOB alert is driven off [[agent_jobs]] (a row queued/building past the per-kind threshold), not off the absence of a beat. The beats only feed last-ran + history on the tile.
- **Inline-agent beats DO drive their alert, but only against upstream work.** An `ai:<name>` agent is event-driven, so silence alone is fine (no tickets to QC = green). The alert fires only when `0` *successful* in-window beats coincide with upstream work that existed (e.g. closed AI tickets awaiting QC), or when the in-window error rate spikes. `ok:true` covers both a real run and an intentional skip; `ok:false` is reserved for genuine errors/throws so the error-rate check doesn't trip on healthy skips.
- **Best-effort writes.** A heartbeat write never breaks the loop it reports on — both the lib helper and the worker's inline writer swallow + log on error.

## Migration

`supabase/migrations/20260622120000_control_tower.sql` (this table + [[loop_alerts]] + RLS) · apply: `scripts/apply-control-tower-migration.ts`

## Related

[[../specs/control-tower]] · [[loop_alerts]] · [[worker_heartbeats]] · [[agent_jobs]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]]
