# libraries/ship-time-backfill-detector

The post-merge safety net for one-time data backfills that ship as `scripts/_backfill-*.ts` — [[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] Phase 1. Migrations auto-apply on ship (via [[control-tower/migration-drift|applyMergedMigrations]]), but a TS backfill script does NOT — it lands as dead code the deployed runtime never executes. This module makes an un-run backfill VISIBLE.

**File:** `src/lib/ship-time-backfill-detector.ts` · called from [[agent-jobs]] `applyMergedBuildEffects` on every merged claude/* build.

## North star — detect + escalate; the CEO disposes

Mirrors the migration-drift ledger pattern ([[control-tower/migration-drift]]). The detector is the SUPERVISOR on the "ship-a-backfill" proxy — its degenerate state is a spec whose data-op silently never runs (the Superfood Tabs 2/4 incident; the migration-ledger drift class). It escalates every un-run row to the CEO inbox as a routed `agent_approval_request` and NEVER auto-passes. Phase 2 will add the auto-execute + Control Tower tile so the loop closes for idempotent scripts.

## Exports

- `SHIP_TIME_BACKFILL_LOOP_ID = "ship-time-backfill-detector"` — the [[../tables/loop_heartbeats]] `loop_id` the detector beats under (kind `reactive`). Also the id of its [[../libraries/control-tower]] `MONITORED_LOOPS` entry.
- `SHIP_TIME_BACKFILL_ESCALATION_KIND = "ship_time_backfill_unrun"` — the `dashboard_notifications.metadata.escalation_kind` the escalator emits under (shared with any downstream router).
- `isBackfillScriptPath(path)` — pure regex predicate: true iff `path` matches the bounded convention `scripts/_backfill-*.ts` (`^scripts/_backfill-[a-z0-9][a-z0-9._-]*\.ts$`). The single source of truth for what counts as a ship-time backfill.
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
- **NEVER SILENTLY PASSES.** A `pending` or `failed` row escalates every UTC day until it becomes `ran` (Phase 2 will provide the executor; today the escalation calls for a human to run `npx tsx <path>` or convert it to a migration).
- **NODE-COMPLETENESS TRIO** ([[../operational-rules]] § Node completeness). OWNER: `platform` in the MONITORED_LOOPS entry. KILL-SWITCH ANCESTRY: inherits Platform's via the node-registry (`parentIdForOwner('platform') → 'director:platform'` → `dept:platform`). HEARTBEAT: `emitReactiveHeartbeat(SHIP_TIME_BACKFILL_LOOP_ID, …)` from `try/finally`.

## Related

[[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] · [[agent-jobs]] (the caller) · [[../tables/data_op_runs]] (the ledger) · [[../tables/dashboard_notifications]] (the CEO-inbox surface) · [[control-tower/migration-drift]] (the sibling ledger this mirrors — migrations, not TS scripts) · [[media-buyer/agent]] (`escalateUnderProvisionedCohort` — the escalation-card shape reused here) · [[control-tower]] (the MONITORED_LOOPS entry) · [[../operational-rules]] (§ Node completeness · § North star)
