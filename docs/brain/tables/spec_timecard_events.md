# spec_timecard_events

The per-lifecycle-step ledger for every spec — Mario's foundation ([[../specs/spec-timecard-ledger-and-sdk]], [[../lifecycles/mario-pipeline-plumbing]] M1). Append-only. One row per lifecycle event: `created`, review pass/fail, phase build start/done, ship, spec-test start/verdict, security verdict, fold start/done, wait entered/exited, job queued/claimed. Powers (a) the M3 detector cron's "step-done to next-step-started beyond SLA" scan and (b) the M5 detail-page timeline. The only writer is [[../libraries/spec-timecards]] `recordTimecardEvent` — every lifecycle chokepoint calls it best-effort so a write error never blocks the chokepoint.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text` | the [[specs]].slug this event is about |
| `phase_index` | `int?` | the [[spec_phases]].phase_index for a phase-scoped event · NULL for a spec-level event (created / folded / …) |
| `event_kind` | `text` | free text (no CHECK) — the SDK owns the vocabulary. Mirrors the `agent_jobs.kind` convention so a new lifecycle event lands **without a migration**. See vocabulary below. |
| `actor` | `text` | who/what emitted — one of `worker` ｜ `vale` ([[../libraries/spec-review-agent]]) ｜ `sol` ([[../libraries/sol-orchestrator]]) ｜ `mario` (once the M3 detector cron lands) ｜ `owner` ｜ `ceo` ｜ the box worker's `agent_jobs.id` |
| `wait_kind` | `text?` | set on `wait_entered` / `wait_exited` only. One of `needs_input` ｜ `needs_approval` ｜ `blocked_on_dependency` ｜ `blocked_on_usage` (mirrors the [[agent_jobs]] `status` values that pause a build) |
| `waiting_on` | `text?` | set with `wait_kind`. Owner display name / `ceo` / a blocker spec slug — who or what the spec is waiting on |
| `at` | `timestamptz` | when the event happened · default `now()` · the primary sort key (per-spec timeline + last-event-per-spec scan both order by this) |
| `metadata` | `jsonb` | free-form context: `{ pr_number, merge_sha, verdict, dedupe_key, backfill_source, … }` · default `{}` |
| `created_at` | `timestamptz` | insert time · default `now()` (typically = `at`; differs only for a backfilled event where `at` is the historical timestamp) |

## `event_kind` vocabulary

Owned by the SDK ([[../libraries/spec-timecards]] `TimecardEventKind`). Free-text on the row so the vocabulary can grow without a migration. Initial set:

- **Spec lifecycle** — `created`, `review_started`, `review_passed`, `review_failed`, `folded`
- **Phase lifecycle** (each carries `phase_index`) — `build_started`, `build_done`, `phase_shipped`, `spec_test_started`, `spec_test_verdict`, `security_verdict`
- **Job lifecycle** (a build/fold/spec-test [[agent_jobs]] row transitioning) — `job_queued`, `job_claimed`, `job_completed`, `job_failed`
- **Waits** (paired — every `wait_entered` closes with a `wait_exited`) — `wait_entered`, `wait_exited`
- **Fold** — `fold_started`, `fold_done`

## Wait-span pattern

Two events per wait: a `wait_entered` (carrying `wait_kind` + `waiting_on`) opens the span, a `wait_exited` (matching `wait_kind`) closes it. `getTimecard` folds a matched pair into a SINGLE step of `event_kind='wait_exited'` whose `duration_ms` is the entry-to-exit delta — the `wait_entered` marker on its own is NOT a timeline step, only an open-wait signal. An unmatched `wait_entered` surfaces as an open wait in `TimecardView.open_waits` with a `gap_ms` counting up to `now()` (the spec is still waiting on someone). This is the only paired-event pattern in the vocabulary — every other kind is a point-in-time.

### Emission rule (Phase 4)

The paired events are emitted at the SINGLE `agent_jobs.status` update chokepoint in the box worker (`scripts/builder-worker.ts` `update()` — the same helper that carries the needs_input orphan guard). The worker reads the CURRENT `agent_jobs.status` right before the write and compares it to the DESTINATION:

- **Entering a wait** — destination ∈ `{needs_input, needs_approval, blocked_on_dependency, blocked_on_usage}` AND current is NOT a wait → emit `wait_entered` with `wait_kind` = destination.
- **Exiting a wait** — destination = `queued_resume` AND current IS a wait → emit `wait_exited` with `wait_kind` = the CURRENT (exiting) wait status.
- **Wait → wait** (e.g. `needs_input` → `needs_approval`) — NO emission. The ledger records ONE CONTINUOUS wait span; only entry into and exit from the wait region are marked.
- **Non-wait → non-wait** — NO emission (the wait vocabulary is silent).
- **Spec-less rows** (a per-workspace triage sweep with `spec_slug=null`) — NO emission (the ledger is keyed on spec).

### `waiting_on` vocabulary (derived at entry)

| `wait_kind` | `waiting_on` |
|---|---|
| `needs_input` · `needs_approval` | The workspace owner's `display_name` from [[workspace_members]] (or `null` when the lookup misses / the owner has no display name set). This IS the party the spec is waiting on: the CEO answering a question / approving a gated action. |
| `blocked_on_dependency` | The dependency slug carried on the job's `pending_actions` (`dependency_slug` / `blocked_by` / `spec_slug` on any pending action, first match wins), else `null`. The Claude-breaker path uses this destination too, and the caller records the breaker cause on `agent_jobs.error`. |
| `blocked_on_usage` | The literal `'max-usage'` sentinel — the box parked the job because every Max account hit its usage wall ([[../libraries/box-multi-account-failover]]); auto-resumes at the soonest reset. |

Every emission is best-effort (write error logs and returns, never blocks the status transition itself) and fire-and-forget (a slow `.insert()` cannot delay a queue-critical write).

## Reads / writes

- **Writer:** [[../libraries/spec-timecards]] `recordTimecardEvent` — a single `.insert()` through [[../libraries/supabase-admin|createAdminClient]] wrapped in a best-effort try/catch. Chokepoints (Vale, the box worker's status transitions, Sol, fold, spec-test) call it after they've done their real work — a write error logs and returns, never throws.
- **Reader (per-spec):** [[../libraries/spec-timecards]] `getTimecard(workspace_id, spec_slug)` orders by `at asc` and folds paired waits into spans; the M5 spec-detail-page timeline consumes this.
- **Reader (cron):** [[../libraries/spec-timecards]] `listStalledCandidates(admin, { workspace_id?, older_than_ms })` reads the last event per `(workspace_id, spec_slug)` and returns rows whose since-then gap exceeds `older_than_ms`; the M3 detector cron passes its per-step SLA here.

## Indexes / RLS

- `spec_timecard_events_lookup_idx (workspace_id, spec_slug, at)` — covers both the per-spec timeline read and the last-event-per-spec scan.
- RLS: `spec_timecard_events_select` (workspace members read) · `spec_timecard_events_service` (service role all writes). Mirrors [[agent_jobs]] — the box worker uses the service role.

## Backfill

The Mario M1 backfill script (Phase 3, [[../recipes/backfill-spec-timecards]]) seeds history from [[spec_status_history]], [[../libraries/director-activity|director_activity]], [[spec_test_runs]], and [[agent_jobs]] so specs authored before this ships still have a timeline. Backfilled rows carry `actor='backfill'` + `metadata.backfill_source` naming the source table, so a later audit can distinguish reconstructed from real events. Wait-span events are **not** backfilled (no historical source for who was waiting on whom — a forward-only signal).

## Migration

`supabase/migrations/20261001120000_spec_timecard_events.sql` creates the table, `spec_timecard_events_lookup_idx`, and the two RLS policies. Apply: `npx tsx scripts/apply-spec-timecard-events-migration.ts`. Verify schema: `npx tsx scripts/_verify-spec-timecard-events-schema.ts` (prints the live columns, indexes, policies).

## Related

[[../specs/spec-timecard-ledger-and-sdk]] · [[../goals/mario-pipeline-plumbing]] · [[../libraries/spec-timecards]] · [[specs]] · [[spec_phases]] · [[spec_status_history]] · [[spec_test_runs]] · [[agent_jobs]]
