# libraries/gated-migration-approval

Turns a **destructive merged-but-unapplied migration** into a **real, tappable Approval Request** that applies the file once approved. It is the pure decision half of the migration-drift reconciler's `onApprovalNeeded` hook ([[control-tower]] § `migration-drift.ts` → `applyMergedMigrations`).

**File:** `src/lib/control-tower/gated-migration-approval.ts` · **Box wiring:** `scripts/builder-worker.ts` `fileGatedMigrationApproval` (filing) + `executeGatedMigrationApproval` (execution, called from `runCeoAuthorizedOutOfLeashJob`) · **Tests:** `npm run test:gated-migration-approval`

## Why this exists

The drift reconciler auto-applies `additive` migrations. A file that [[migration-safety]] `classifyMigrationSql` flags `reversible_destructive` or `irreversible_destructive` goes to `onApprovalNeeded` instead. Until this page's change, that hook only ran `console.warn("… run the sanctioned apply script")`. It created no card and no `agent_jobs` row, so nobody had anything to tap and the file stayed unapplied indefinitely. The standard CHECK-widening pattern (`DROP CONSTRAINT IF EXISTS …; ADD CONSTRAINT …`) trips the classifier as `ALTER … DROP CONSTRAINT`. That is how `20270109120000_dashboard_notifications_billing_alert_and_auth_expired_types.sql` and `20261008120000_ticket_resolution_events_verified_outcome_nothing_due.sql` were merged but never applied, and every `billing_alert` notification was rejected in prod by the old CHECK.

North star ([[../operational-rules]] § North star): when a tool hits a rail, it escalates to the objective owner. Before this change the escalation went nowhere.

## How it works: reuses the out-of-leash approval rail

No new job kind or parallel approval path. A drift-filed request is an ordinary [[../tables/agent_jobs]] row of kind **`ceo-authorized-out-of-leash`**. That is the same rail Ada's founder-prompted raises use ([[../specs/ceo-authorized-out-of-leash-actions]]). The kind is owner `ceo` in [[control-tower-node-registry]] `KIND_OWNER_FALLBACK`, and its executor lane and claim already exist. Node completeness therefore comes from the existing kind (owner, kill switch, heartbeat).

1. **File** (`fileGatedMigrationApproval`, box, each drift tick). For every gated migration:
   - Read the prior drift rows for that version: `kind='ceo-authorized-out-of-leash'`, `spec_slug='migration-drift:<version>'`, any status.
   - Run `decideGatedMigrationFiling`.
   - If the decision is to file, insert one `needs_approval` row built by `buildGatedMigrationApprovalJob`, with one `apply_migration` pending action. A failed prior-row read files nothing on that tick, so a transient error cannot fan out duplicates.
   - Record a `raised_gated_migration_approval` [[../tables/director_activity]] row.
2. **Surface.** [[approval-inbox]] `reconcileApprovalInbox` emits the routed `agent_approval_request` notification, which appears in the **Approvals inbox** of the routed seat (CEO, or Ada when she is live). It is mirrored to `#cto-ada` when that is configured. The card shows:
   - title `ceo-authorized-out-of-leash: Apply gated migration <file> (<severity>)`
   - `$ applyMigrationAndRecord supabase/migrations/<file> …`
   - the evidence block: file, version and sha256 prefix, severity, classifier matches, routing reason, and an SQL preview of up to 1800 chars
3. **Decide.** `/api/roadmap/approve` (`approveRoadmapAction`) flips the action to approved or declined and the job to `queued_resume`.
4. **Execute.** `runCeoAuthorizedOutOfLeashJob` sees `instructions.origin === 'migration-drift'`. It **never shell-runs** the `cmd` label. Instead it reads the action's `migration_drift` marker (`readGatedMigrationMarker`) and calls `executeGatedMigrationApproval`, which does three things:
   - re-reads the file on main and runs `validateGatedMigrationExecution`
   - calls the same `applyMigrationAndRecord` the additive path uses (statement-level apply plus the `supabase_migrations.schema_migrations` ledger row)
   - zeroes `lastMigrationDriftCheck`, so the next poll re-runs the drift check and the tile clears

   A missing or malformed marker fails closed and nothing executes. A decline closes the job as `completed` with no execution.

## Exports

| Export | What |
|---|---|
| `GATED_MIGRATION_JOB_KIND` | `'ceo-authorized-out-of-leash'` (the reused kind) |
| `GATED_MIGRATION_ORIGIN` | `'migration-drift'`: the value of `instructions.origin` and the dedupe namespace |
| `migrationContentHash(sql)` | sha256 hex of the exact file bytes |
| `gatedMigrationDedupeKey(version, sql)` | `migration-drift::<version>::<sha256[0..16]>` |
| `gatedMigrationSpecSlug(version)` | `migration-drift:<version>`: the per-version lookup key on `agent_jobs.spec_slug` |
| `parseExistingGatedMigrationRow(row)` | instructions JSON → `{ id, status, dedupeKey, version }`. Malformed JSON gives a null key and never throws |
| `decideGatedMigrationFiling(existing, { version, dedupeKey })` | `file` or `skip`, plus `supersedeIds` |
| `resolveGatedMigrationRoute({ sql, blastRadius, platformAutoApprover })` | `routeDestructiveAction`, then the dormant-Platform ⇒ CEO fail-safe |
| `buildGatedMigrationApprovalJob(input)` | the `agent_jobs` insert (card content, marker, override, instructions) |
| `readGatedMigrationMarker(action)` | `{ version, file, content_hash }` or null |
| `validateGatedMigrationExecution({ marker, onDiskSql, appliedVersions })` | the executor's pre-apply re-check |
| `gatedMigrationCmd(file)` · `gatedMigrationSqlPreview(sql)` | card display helpers |

## Dedupe rules (`decideGatedMigrationFiling`)

- **Key = version + content hash.** Any prior row with the **same key, in any status**, means skip. Each status reads as follows:
  - open (`needs_approval`): already filed
  - `queued_resume` / `claimed`: executing
  - `completed`: applied or **declined**. A decline is **not re-filed until the file content changes.**
  - `needs_attention`: the approved apply failed and a human owns it

  Re-ticks never fan out.
- **The file was edited after filing** (new hash): a fresh request is filed. Any still-open row for the same version with the old key is **superseded**: compare-and-set from `needs_approval` to `completed`, with its pending action declined. The inbox therefore shows one card per version.

## Routing (`resolveGatedMigrationRoute`)

`routeDestructiveAction` ([[migration-safety]] Phase 4) routes on severity × rename-and-expire × business-materiality:
- `reversible_destructive` that is not business-material, or that follows the rename-and-expire convention, goes to **Platform/Ada**.
- Everything else goes to the **CEO**.

When the route says Platform but `platformIsAutoApprover(loadAutonomyMap())` is false, the request goes to the **CEO** instead (`platformDormantFallback: true`), so it never waits on a dormant approver. A CEO route is never widened to Platform.

The result is persisted as `routed_to_function_override`. [[approval-inbox]] `routingOwnerForJob` re-validates that override at read time: it honors a Platform override only on an `apply_migration` whose `blastRadius.severity` is `reversible_destructive`. The blast radius is computed **without a pg client**: static severity only, and unapproved SQL is never dry-run against prod.

## Execution re-check (`validateGatedMigrationExecution`)

| Check | Outcome on failure |
|---|---|
| Marker file is a bare `YYYYMMDDNNNNNN_name.sql` whose prefix equals the version (no path parts) | `invalid` (refused) |
| File still exists on main | `missing` (refused) |
| Bytes hash to the approved `content_hash` | `content-changed`: refused. The next drift tick files a fresh card for the new content |
| Version is not already in `schema_migrations` | `already-applied`: reported as success, with no DDL re-run |

An unreadable ledger (`appliedVersions === null`) proceeds. `applyMigrationAndRecord` records conflict-safely, and its statement-level handling of duplicate objects covers a raced apply.

## Gotchas

- **The `cmd` on these actions is a display label, not a shell command.** Only the marker path executes. Never add a shell fallback for `origin: 'migration-drift'`.
- **Ledger-gap migrations** (objects already live, version unrecorded) still pass through here if they classify destructive. On approval, `applyMigrationAndRecord` reconciles them: duplicate-object statements are verified as already present and the version is recorded.
- **Decision grades.** `runCeoAuthorizedOutOfLeashJob` writes the Phase-4 `director_decision_grades` marker for a drift-origin request **only** when it was routed to Platform, which makes it Ada's call. A CEO decision on a deterministic tool's filing is not a director call to grade.

## Callers

- `scripts/builder-worker.ts`:
  - `runMigrationDriftJob` binds `onApprovalNeeded` to `fileGatedMigrationApproval`
  - `runCeoAuthorizedOutOfLeashJob` dispatches to `executeGatedMigrationApproval` for drift-origin actions
- `src/lib/control-tower/migration-drift.ts`: `applyMergedMigrations` passes the exact `sql` it classified to `onApprovalNeeded`, so the card previews and hashes the same bytes.

---

[[control-tower]] · [[migration-safety]] · [[approval-inbox]] · [[../README]]
