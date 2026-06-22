# loop_heartbeats

The Control Tower's per-run liveness log ([[../specs/control-tower]] Phase 1). Every monitored **cron** and box **agent-kind** runner writes **one row at the END of each run** so the [[../inngest/control-tower-monitor]] cron (and the [[../dashboard/control-tower]] dashboard) can answer "did this loop actually run, and did it do its job?". The box build worker itself is the exception — its ~5s poll beat lives in [[worker_heartbeats]], not here (one row every 5s would be enormous); this table is for loops whose "run" is a discrete event.

**Global infra, not workspace-scoped** — the box + crons are one shared fleet (same model as [[worker_heartbeats]]). RLS: any authenticated user reads; the service role does all writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `loop_id` | `text` | the monitored loop's stable id — a cron's **inngest function id** (e.g. `triage-escalations-cron`), `agent:<kind>` for a box agent-kind run (e.g. `agent:build`), `ai:<agent>` for an inline event-driven AI agent (e.g. `ai:ticket-analyzer`), or `feed:<source>` for an error-feed "received a delivery" liveness beat (e.g. `feed:vercel`, `feed:supabase-logs` — [[../specs/error-feed-honest-panels]]). The first three match an `id` in the registry (`src/lib/control-tower/registry.ts`); `feed:*` ids are NOT registered, so the monitor ignores them |
| `kind` | `text` | `cron` ｜ `agent-kind` ｜ `inline-agent` ｜ `feed` — which loop type emitted this (free text, no DB check constraint) |
| `ran_at` | `timestamptz` | end-of-run timestamp · default `now()` · the freshness signal |
| `ok` | `boolean` | default `true` · `false` ⇒ the run threw or reported a failure (surfaced amber in P1; the page-on-it false-success assertion is P2) |
| `produced` | `jsonb?` | what the run produced this cycle — counts/summary, e.g. `{ enqueued, workspaces }` (cron) or `{ status }` (agent-kind) |
| `detail` | `text?` | free-text note |
| `duration_ms` | `int?` | run wall-clock |
| `created_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writers:** each monitored cron via `emitCronHeartbeat()` ([[../libraries/control-tower]]) wrapped in a `step.run("emit-heartbeat", …)` before its return — [[../inngest/triage-escalations]], [[../inngest/spec-test-cron]], [[../inngest/migration-audit-retry]], [[../inngest/migration-integrity-sweep]], [[../inngest/internal-subscription-renewals]], [[../inngest/social-scheduler]], and [[../inngest/control-tower-monitor]] itself. The box worker writes the `agent:<kind>` beats inline (`writeLoopHeartbeat` in `scripts/builder-worker.ts`, in the `launch()` finally — one beat per agent-job run). The **inline event-driven AI agents** write `ai:<agent>` beats via `emitInlineAgentHeartbeat()` in a try/finally at the END of each run ([[../specs/control-tower-agent-coverage]]): [[../libraries/ticket-analyzer]] `analyzeTicket` (`ai:ticket-analyzer`), [[../libraries/journey-delivery]] `launchJourneyForTicket` (`ai:journey-delivery`), [[../libraries/fraud-detector]] `checkOrderForFraud` (`ai:fraud-detector`), and [[../libraries/sonnet-orchestrator-v2]] `callSonnetOrchestratorV2` (`ai:orchestrator` — the per-ticket decision agent; `ok:false` on a thrown or degraded/fallback decision). Service role.
- **Reader:** [[../inngest/control-tower-monitor]] (`buildControlTowerSnapshot`) reads the latest beat per `loop_id` to decide cron freshness + last-ran; the [[../dashboard/control-tower]] dashboard reads the last ~10 beats per loop for the tile history strip. Cron + agent-kind beats are read via the **`control_tower_loop_beats(p_history_limit)` RPC** — one grouped query returning the latest ≤10 beats **per loop_id** plus the **all-time beat count** per loop, riding the `(loop_id, ran_at desc)` index ([[../specs/control-tower-monitor-accuracy]] Phase 1). It replaced an earlier global "last 600 beats, order by ran_at desc" window that (a) crowded a low-frequency cron's latest beat out → false `never_fired`, and (b) had no single-column index to ride → started **500-ing `GET /rest/v1/loop_heartbeats`** as the table grew. Inline-agent/reactive beats are read via a **dedicated windowed fetch** (exact ok/errored counts over the loop's window + latest + history) and are excluded from the RPC so their high volume can't starve a low-frequency cron's latest beat.

## Gotchas

- **Cron freshness = recency of the latest beat**, evaluated against each loop's `livenessWindowMs` in the registry (cadence + grace). A cron with **any** historical beat is only ever amber/red on *freshness* (overdue vs its window), **never** `never_fired` — `never_fired` keys off the **all-time beat count** (0 beats in all of history), not "0 since deploy" ([[../specs/control-tower-monitor-accuracy]] Phase 1). A registered cron with **0 beats ever** past deploy+grace ⇒ **red `never_fired`** (Inngest isn't invoking it); a just-shipped cron before its first tick (or unknown deploy age) ⇒ **amber** ("awaiting first run"), never red.
- **Agent-kind beats are NOT used for the alert.** A genuinely-idle lane (no builds queued) must stay **green**, so the STUCK-JOB alert is driven off [[agent_jobs]] (a row queued/building past the per-kind threshold), not off the absence of a beat. The beats only feed last-ran + history on the tile.
- **Inline-agent beats: ok=true means "ran successfully", NOT "did something".** An intentional skip (analyzer: no AI messages / spam tag; journey: `social_comments` channel) is `ok=true` — the agent correctly chose not to act — so it never trips the error-rate alert. `ok=false` is reserved for a thrown run or a real failure (grader HTTP/parse error, a non-delivery). The liveness-when-work-exists alert fires only when an **independent** upstream-work count > 0 AND there are **0 successful** beats in the window, so a genuinely-idle agent is green.
- **Best-effort writes.** A heartbeat write never breaks the loop it reports on — both the lib helper and the worker's inline writer swallow + log on error.
- **`feed:<source>` beats are liveness, not loops.** Written by `recordFeedDelivery()` ([[../libraries/control-tower]] `error-feed.ts`) on each clean delivery (a Vercel drain POST, a successful Supabase-logs poll) so the [[../dashboard/control-tower]] error panels can show **green "connected"** vs **amber "not configured / awaiting first event"** instead of a misleading green "0 errors" while disconnected ([[../specs/error-feed-honest-panels]]). They're low-volume and read only by `buildErrorFeedSnapshot` (latest `feed:<source>` per source); the monitor ignores them (not in the registry).

## Migration

`supabase/migrations/20260622120000_control_tower.sql` (this table + [[loop_alerts]] + RLS, incl. the `(loop_id, ran_at desc)` index) · apply: `scripts/apply-control-tower-migration.ts`. The grouped-read RPC: `supabase/migrations/20260622160000_control_tower_loop_beats.sql` (`control_tower_loop_beats(p_history_limit)`) · apply: `scripts/apply-control-tower-loop-beats-migration.ts`. **Rewritten index-backed** in `supabase/migrations/20260622180000_control_tower_loop_beats_skipscan.sql` (apply: `scripts/apply-control-tower-loop-beats-skipscan-migration.ts`) — the original body's `row_number()`/`count(*) over (partition by loop_id)` ran over the **whole** table before the `rn <= p_history_limit` filter, so it couldn't ride the `(loop_id, ran_at desc)` index and **timed out (8.1s statement timeout) on the 5.22M-row table → returned null → false `never_fired` cascade** ([[../specs/control-tower-loop-beats-rpc-timeout]]). The rewrite drives a **recursive index skip-scan** over distinct `loop_id`s, then a **LATERAL** that fetches only each loop's newest `p_history_limit` beats (index range seek), with `rn`/`total_count` now windowed over that ≤10-row per-loop set. `total_count` is therefore a **presence** signal (1..limit), not the all-time count — sufficient because every `evalCron` read tests it via `everBeatCount === 0`.

## Related

[[../specs/control-tower]] · [[../specs/control-tower-agent-coverage]] · [[loop_alerts]] · [[worker_heartbeats]] · [[agent_jobs]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]]
