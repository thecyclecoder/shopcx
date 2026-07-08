# spec_timecard_events

The per-lifecycle-step ledger for every spec — Mario's foundation ([[../specs/spec-timecard-ledger-and-sdk]], [[../goals/mario-pipeline-plumbing]] M1). Append-only. One row per lifecycle event: `created`, review pass/fail, phase build start/done, ship, spec-test start/verdict, security verdict, fold start/done, wait entered/exited, job queued/claimed. Powers (a) the M3 detector cron's "step-done to next-step-started beyond SLA" scan and (b) the M5 detail-page timeline. The only writer is [[../libraries/spec-timecards]] `recordTimecardEvent` — every lifecycle chokepoint calls it best-effort so a write error never blocks the chokepoint.

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

Two events per wait: a `wait_entered` (carrying `wait_kind` + `waiting_on`) opens the span, a `wait_exited` (matching `wait_kind`) closes it. `getTimecard` folds a matched pair into a single closed span with `duration_ms`; an unmatched `wait_entered` surfaces as an open wait in `TimecardView.open_waits` (the spec is still waiting on someone). This is the only paired-event pattern in the vocabulary — every other kind is a point-in-time.

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
