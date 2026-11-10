# libraries/ship-time-backfill-detector

The post-merge safety net for one-time data backfills that ship as `scripts/_backfill-*.ts` — [[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] Phase 1. Migrations auto-apply on ship (via [[control-tower/migration-drift|applyMergedMigrations]]), but a TS backfill script does NOT — it lands as dead code the deployed runtime never executes. This module makes an un-run backfill VISIBLE.

**File:** `src/lib/ship-time-backfill-detector.ts` · called from [[agent-jobs]] `applyMergedBuildEffects` on every merged claude/* build.

## North star — detect + escalate; the CEO disposes

Mirrors the migration-drift ledger pattern ([[control-tower/migration-drift]]). The detector is the SUPERVISOR on the "ship-a-backfill" proxy — its degenerate state is a spec whose data-op silently never runs (the Superfood Tabs 2/4 incident; the migration-ledger drift class). It escalates every un-run row to the CEO inbox as a routed `agent_approval_request` and NEVER auto-passes. Phase 2 closes the loop via [[ship-time-backfill-executor]] + [[ship-time-backfill-reaudit]]: the executor spawns `pending` rows with `--apply`, and the reaudit repairs any historical rows that the old executor only dry-ran.

## Exports

- `SHIP_TIME_BACKFILL_LOOP_ID = "ship-time-backfill-detector"` — the [[../tables/loop_heartbeats]] `loop_id` the detector beats under (kind `reactive`). Also the id of its [[../libraries/control-tower]] `MONITORED_LOOPS` entry.
- `SHIP_TIME_BACKFILL_ESCALATION_KIND = "ship_time_backfill_unrun"` — the `dashboard_notifications.metadata.escalation_kind` the escalator emits under (shared with any downstream router).
- `isBackfillScriptPath(path)` — pure regex predicate: true iff `path` matches the bounded convention `scripts/_backfill-*.ts` **or** `scripts/_ledger-reconcile-*.ts` (`^scripts/_(?:backfill|ledger-reconcile)-[a-z0-9][a-z0-9._-]*\.ts$`) **and is not** a `*.test.ts` / `*.spec.ts` companion. The single source of truth for what counts as a ship-time backfill. The test/spec exclusion is load-bearing: the convention regex alone also matches `_backfill-foo.test.ts` (the `.test` is just more `[a-z0-9._-]`), so without it the detector ledgered unit-test files as `pending` backfills — two such phantom `data_op_runs` rows existed on main until [[../specs/ship-time-backfill-executor-passes-apply]] Phase 1.
- `isTestFileScriptPath(path)` — pure predicate: true iff `path` ends `.test.ts` / `.spec.ts`. The exclusion `isBackfillScriptPath` applies, and the filter the one-time `scripts/_backfill-fail-test-file-ledger-rows.ts` cleanup uses to find the phantom rows.
- `markLedgerRowFailed(admin, { id, workspaceId, error })` — the ledger's own writer: flip ONE `pending` [[../tables/data_op_runs]] row to `failed` with a reason via a compare-and-set on `(id, workspace_id, status='pending')` + `.select('id')` (never raw `.from(...).update` from a one-off). Returns true iff exactly one row transitioned (false if a concurrent pass already advanced it). Used by the `_backfill-fail-test-file-ledger-rows.ts` cleanup to retire the two phantom test-file rows through the ledger module, not SQL.
- `markLedgerRowPendingForReaudit(admin, { id, workspaceId, note })` — the ledger's own writer for the reverse transition: flip ONE `ran` row BACK to `pending` with a compare-and-set on `status='ran'`, clearing `ran_at` and writing `note` into `error` (the audit trail). Used by the Phase-2 [[ship-time-backfill-reaudit]] (`_backfill-reaudit-dry-run-ledger-rows.ts`) to reset a historical `ran` row whose fresh dry run still reports pending work so the executor re-drains it.
- `listBackfillFilesAddedByPr(prNumber)` — hits the GitHub PR-files API (`GET /repos/{repo}/pulls/{n}/files?per_page=100`) with `GITHUB_TOKEN` / `AGENT_TODO_GITHUB_TOKEN`, filters to `status:'added'`, and returns only the filenames matching `isBackfillScriptPath`. Best-effort: a missing token / API failure returns `[]` (the detector no-ops for this merge; a later reconcile pass over the same PR can retry cleanly because the ledger is upsert-keyed).
- `detectAndEscalateShipTimeBackfills({ workspaceId, specSlug, prNumber, mergeSha })` — the one-shot post-merge pass. Steps:
  1. List added `scripts/_backfill-*.ts` files in the merged PR.
  2. Upsert one `pending` row into [[../tables/data_op_runs]] per file, keyed on `(workspace_id, spec_slug, script_path)` with `ignoreDuplicates:true` — a repeat hook pass never demotes a `ran` row to `pending`.
  3. RE-SELECT the same rows post-upsert (so a row a concurrent pass wrote is picked up) and, for every row whose status is NOT `ran`, insert a routed `dashboard_notifications` card of type `agent_approval_request` with `routed_to_function:'ceo'` + `escalated_by_director:'platform'`. Deduped per `(workspace_id, spec_slug, script_path, UTC day)` via a `metadata->>dedupe_key` predicate (the same shape [[media-buyer/agent]] `escalateUnderProvisionedCohort` uses).
  4. Emit a reactive heartbeat under `SHIP_TIME_BACKFILL_LOOP_ID` from a `try/finally` — a throw still beats `ok:false` so the loop is never silently dark.
  Returns a `ShipTimeBackfillDetectionSummary` (prNumber, specSlug, detected, ledgered, escalated, githubUnavailable) — also carried on the heartbeat's `produced` blob for the Control Tower tile.

## Guardrails / invariants

- **NEVER THROWS.** Wrapped in try/catch so a GitHub outage / missing token / DB hiccup can't break the merge hook that carries it. The caller ALSO wraps the call in try/catch, so nothing here can break `applyMergedBuildEffects`.
- **Idempotent on repeat calls.** The ledger's unique `(workspace_id, spec_slug, script_path)` and the escalation's per-UTC-day dedupe mean the manual-squash-reconcile + auto-merge-webhook race collapses to one row + one card, safe to re-fire.
- **BOUNDED convention.** Only `scripts/_backfill-*.ts` filenames match. An arbitrary existing script is never surfaced or auto-run — the ledger scopes strictly to files THIS spec's merge added.
- **NEVER SILENTLY PASSES.** A `pending` or `failed` row escalates every UTC day until it becomes `ran` — the [[ship-time-backfill-executor]] spawns the script on the box post-merge, or a human can run `npx tsx <path>` / convert it to a migration.
- **NODE-COMPLETENESS TRIO** ([[../operational-rules]] § Node completeness). OWNER: `platform` in the MONITORED_LOOPS entry. KILL-SWITCH ANCESTRY: inherits Platform's via the node-registry (`parentIdForOwner('platform') → 'director:platform'` → `dept:platform`). HEARTBEAT: `emitReactiveHeartbeat(SHIP_TIME_BACKFILL_LOOP_ID, …)` from `try/finally`.

## Related

[[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] · [[agent-jobs]] (the caller) · [[../tables/data_op_runs]] (the ledger) · [[../tables/dashboard_notifications]] (the CEO-inbox surface) · [[control-tower/migration-drift]] (the sibling ledger this mirrors — migrations, not TS scripts) · [[media-buyer/agent]] (`escalateUnderProvisionedCohort` — the escalation-card shape reused here) · [[control-tower]] (the MONITORED_LOOPS entry) · [[../operational-rules]] (§ Node completeness · § North star)
