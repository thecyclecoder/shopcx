# Recipe: backfill spec-timecards from history

Reconstruct the [[../tables/spec_timecard_events]] ledger for specs authored BEFORE Mario's Phase-1 table shipped, so the M3 stall-detector cron + the M5 detail-page timeline read a complete history from day one. The genre of the `scripts/backfill-*.ts` two-phase pattern ([[../../recipes/backfill]] · [[../recipes/backfill]]).

**Script:** `scripts/backfill-spec-timecards-from-history.ts` · **Spec:** [[../specs/spec-timecard-ledger-and-sdk]] Phase 3 · **Goal:** [[../goals/mario-pipeline-plumbing]] M1

## Invocation

```bash
# Dry-run (default) — prints per-workspace count of proposed inserts, touches nothing.
npx tsx scripts/backfill-spec-timecards-from-history.ts

# Apply — writes the counted rows. Re-running is a no-op (idempotent dedupe).
npx tsx scripts/backfill-spec-timecards-from-history.ts --apply

# Scope to one workspace (useful for a per-tenant sanity check before the fleet-wide apply).
npx tsx scripts/backfill-spec-timecards-from-history.ts --workspace=<uuid>
npx tsx scripts/backfill-spec-timecards-from-history.ts --workspace=<uuid> --apply
```

Prints per-workspace `proposed=N already-backfilled=M to-insert=K` and a fleet-wide total at the end.

## Source mapping

Every reconstructed row carries `actor='backfill'` + `metadata.backfill_source` naming the source table so a later audit can distinguish reconstructed from real events. The DB-column shapes cited below live on the source-table brain pages ([[../tables/specs]] · [[../tables/spec_status_history]] · [[../tables/spec_phases]] · [[../tables/spec_test_runs]] · [[../tables/agent_jobs]]).

| Event kind | Source | `at` column | Notes |
|---|---|---|---|
| `created` | `specs` | `created_at` | one per spec |
| `review_started` | `spec_status_history` where `field='status' AND to_value='"in_review"'` | `at` | one per transition INTO review |
| `review_passed` | `specs` | `vale_review_passed_at` | one per spec IF the durable Vale-pass stamp is set (`vale_pass=true` is transient; `vale_review_passed_at` survives disposition) |
| `phase_shipped` | `spec_phases` where `merge_sha IS NOT NULL` | `updated_at` | one per shipped phase; carries `merge_sha` + `pr` on metadata; `phase_index` = `position` (1-indexed) |
| `build_started` | `agent_jobs` where `kind='build' AND claimed_at IS NOT NULL` | `claimed_at` | one per build claim |
| `build_done` | `agent_jobs` where `kind='build' AND status='completed'` | `updated_at` | one per completed build |
| `spec_test_verdict` | `spec_test_runs` | `run_at` | one per QA run; carries `agent_verdict` on metadata |
| `folded` | `spec_status_history` where `field='status' AND to_value='"folded"'` | `at` | one per fold-transition |

**Deliberately skipped** (documented on the script's header so the omission is auditable):

- **`wait_entered` / `wait_exited`** — no historical source names WHO was waiting on WHOM (a needs_input/needs_approval/dependency/usage wait is a forward-only signal). The M2 chokepoints will start emitting live wait pairs; backfill leaves that dimension empty rather than fabricate it.
- **`fold_started` / `fold_done`** — an `agent_jobs kind='fold'` row's `spec_slug` is the `'fold-batch'` sentinel, not the folded spec ([[../tables/agent_jobs]] § `enqueue_fold`). The batch-fanout mapping isn't reliably reconstructable, so the terminal `folded` event (from the [[../tables/spec_status_history]] transition) is the ledger anchor; the started/done pair belongs to the fold job, not the spec.
- **`review_failed`** — the current Vale schema has no durable "review failed" stamp on specs (`vale_pass=false` is a transient tri-state that gets cleared on re-author). A future signal from [[../tables/director_activity]] can add this without a schema change.

## Idempotency

Dedupe key: `(workspace_id, spec_slug, event_kind, at)`. On each workspace pass the script snapshots every existing `actor='backfill'` row, builds a `Set` of those keys, and skips any proposed row already in the set (and any same-batch duplicate). A re-run counts `already-backfilled=N` and inserts 0. Live rows written by the M2 chokepoints (`actor='vale'` / `actor='worker'` / …) are NEVER touched — the dedupe filter reads only `actor='backfill'` and the writer stays append-only ([[../libraries/spec-timecards]]'s `recordTimecardEvent` never mutates a prior row).

## Verification

- **Dry-run** — run the command without `--apply`, expect per-workspace `proposed=N to-insert=K` lines and a fleet-wide total; nothing writes.
- **Apply** — re-run with `--apply`, expect `inserted=K` and a second `--apply` shortly after to print `to-insert=0` (idempotency).
- **Sanity read** — pick one shipped-and-folded spec and call `getTimecard(admin, workspace_id, spec_slug)` ([[../libraries/spec-timecards]]) → expect at least a `created` step and a `folded` step, plus a non-null `total_elapsed_ms` (the folder anchors at the `folded` event's `at`).

## Related

[[../tables/spec_timecard_events]] · [[../libraries/spec-timecards]] · [[../specs/spec-timecard-ledger-and-sdk]] · [[../goals/mario-pipeline-plumbing]] · [[../tables/specs]] · [[../tables/spec_status_history]] · [[../tables/spec_phases]] · [[../tables/spec_test_runs]] · [[../tables/agent_jobs]] · [[backfill]]
