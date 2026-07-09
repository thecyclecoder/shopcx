# mario_thresholds

Mario's self-owned SLA table ([[../specs/spec-mario-stall-detector-cron-and-thresholds]], [[../lifecycles/mario-pipeline-plumbing]] M3). One row per `(workspace_id, from_event, to_event)` pair carrying the deadline (in ms) beyond which Mario treats the gap between the two lifecycle events as a stall. Seeded with the M3 defaults; the M4 self-tuning agent is the sole writer of updates. Read by the M3 detector cron ([[../libraries/mario|src/lib/mario.ts]] `evaluateStalledSpecs`), which converts each row into an `older_than_ms` input to [[../libraries/spec-timecards]] `listStalledCandidates`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE — each workspace tunes its own SLAs |
| `from_event` | `text` | the [[spec_timecard_events]] `event_kind` that opens the span. Free text (no CHECK) — mirrors the timecard vocabulary so a new lifecycle event lands without a migration |
| `to_event` | `text` | the `event_kind` that closes the span. A gap greater than `sla_ms` between `from_event` and `to_event` (with no intervening `to_event`) is a stall |
| `sla_ms` | `bigint` | the deadline in milliseconds. `evaluateStalledSpecs` passes this as `older_than_ms` when it scans the ledger |
| `min_count` | `int` | how many independent stalled specs must show the same overshoot before the M4 self-tuner will widen the SLA — a bounded proxy against a single flaky spec dragging the whole row wider. Default `1` |
| `last_widened_at` | `timestamptz?` | audit trail: when the M4 self-tuner last widened this SLA |
| `last_widened_reason` | `text?` | audit trail: why (typically `"observed p95 of 45min over 12 specs — widened from 30m to 45m"`). Nullable — a row that has never been widened has both `last_*` columns null |
| `created_at` | `timestamptz` | insert time · default `now()` |
| `updated_at` | `timestamptz` | last update · default `now()` — the M4 self-tuner is expected to bump this on every widening |

**Unique constraint:** `(workspace_id, from_event, to_event)` — one row per pair per workspace; the seed insert is idempotent against re-runs of the migration.

## Pair vocabulary

The seeded rows carry the M3 defaults. Both endpoints are literals from the [[spec_timecard_events]] `event_kind` vocabulary; the M4 self-tuner adjusts `sla_ms` on the existing rows and does not add new pairs (adding a new pair is a code change to the SDK vocabulary, not a runtime widening).

| `from_event` | `to_event` | default `sla_ms` | what it covers |
|---|---|---|---|
| `build_done` | `phase_shipped` | 1,800,000 (30 min) | a phase's build finished (tsc clean, PR opened) but the PR has not merged and the phase is not shipped |
| `review_started` | `review_passed` | 1,200,000 (20 min) | Vale ([[../libraries/spec-review-agent]]) started reviewing a spec but has not emitted a verdict |
| `spec_test_started` | `spec_test_verdict` | 1,800,000 (30 min) | the spec-test agent ([[../libraries/spec-test-agent]]) started QA'ing a shipped spec but has not emitted a verdict |
| `fold_started` | `folded` | 1,200,000 (20 min) | a fold job started but did not complete |
| `job_queued` | `job_claimed` | 600,000 (10 min) | the worker-liveness SLA — a queued [[agent_jobs]] row nothing has claimed in 10min is a stall (the box worker is likely dead or partitioned) |
| `phase_shipped` | `build_started` | 1,800,000 (30 min) | the auto-queue chain broke — a shipped phase should have the next phase's build_started picked up within one SLA window |

## Self-tuning contract (M4 owns updates)

`mario_thresholds` is the only place Mario can widen an SLA at runtime — every SLA lookup in [[../libraries/mario|src/lib/mario.ts]] reads from this table, never from a code constant. The M4 self-tuning agent's contract:

- **Read-only outside M4.** The M3 evaluator only SELECTs from this table; adjusting an SLA is exclusively M4's job.
- **Widen, don't tighten.** M4 only ever raises `sla_ms` — a wider SLA can only reduce false-positive stalls. Tightening is a spec change, not a runtime tuner concern.
- **Evidence-gated.** M4 only widens when at least `min_count` distinct spec_slugs have shown the same overshoot within the sampling window. The `min_count` column bounds the proxy so a single flaky spec cannot move the row.
- **Auditable.** Every widening MUST update `last_widened_at = now()` and `last_widened_reason = <one-line human-readable reason with the observed p95 + the number of specs>`. Reason strings are the audit trail — a human can `select from_event, to_event, sla_ms, last_widened_at, last_widened_reason from public.mario_thresholds` and see the history.
- **Additive schema only.** Adding a new `(from_event, to_event)` pair to the vocabulary is a code + migration change (add the row via a new migration and add the pair to the SDK's typed vocabulary in [[../libraries/mario]]). M4 never inserts.

## Reads / writes

- **Reader:** [[../libraries/mario|src/lib/mario.ts]] `evaluateStalledSpecs` — reads every row for a workspace and issues one `listStalledCandidates(admin, { workspace_id, older_than_ms: row.sla_ms })` scan per row.
- **Writer (seed):** the M3 migration inserts the six default rows for every existing workspace. Idempotent — the unique constraint means re-running the migration is a no-op.
- **Writer (runtime):** the M4 self-tuning agent only. Every widening bumps `last_widened_at` + `last_widened_reason` + `updated_at`.

## Indexes / RLS

- Primary key on `id` + the `(workspace_id, from_event, to_event)` unique index cover every read path (the evaluator scans by `workspace_id`; the M4 widener locates a row by the full triple).
- RLS: `mario_thresholds_select` (workspace members read) · `mario_thresholds_service` (service role all writes). Mirrors [[spec_timecard_events]] — the M3 detector cron and the M4 tuner both run under the service role.

## Migration

`supabase/migrations/20261004120000_mario_thresholds.sql` creates the table, seeds the six default rows for every workspace, and installs the two RLS policies. Apply: `npx tsx scripts/apply-mario-thresholds-migration.ts`. Verify schema: `npx tsx scripts/_verify-mario-thresholds-schema.ts` (prints the live columns, indexes, unique constraint, policies).

## Related

[[../specs/spec-mario-stall-detector-cron-and-thresholds]] · [[../goals/mario-pipeline-plumbing]] · [[../libraries/mario]] · [[../libraries/spec-timecards]] · [[spec_timecard_events]] · [[../inngest/mario-stall-cron]] · [[agent_jobs]] · [[workspaces]]
