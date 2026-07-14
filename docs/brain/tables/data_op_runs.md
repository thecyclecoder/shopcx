# data_op_runs

The **ledger for ship-time data backfills** ([[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] Phase 1) — one row per `scripts/_backfill-*.ts` script a shipped spec added to the merged diff. Migrations auto-apply on ship (via [[../libraries/control-tower/migration-drift|applyMergedMigrations]]), but a TS backfill script does NOT — it lands as dead code the deployed runtime never executes. Twice now this shape has bitten (media-buyer cohort-template Superfood Tabs stayed 2/4 for days; the migration-ledger drift class), invisible until someone noticed the wrong data.

**Detector → ledger → escalate is the safety net.** [[../libraries/agent-jobs|applyMergedBuildEffects]] calls [[../libraries/ship-time-backfill-detector|detectAndEscalateShipTimeBackfills]] on every merged claude/* build; it lists the PR's added files, filters to the `scripts/_backfill-*.ts` convention, upserts one `pending` row per file here, and ESCALATES any row without a successful `ran` outcome to the CEO inbox as a routed `agent_approval_request`. Phase 2 will auto-execute idempotent scripts on ship and flip status to `ran` / `failed`, with a Control Tower tile that stays RED while any row is `pending` or `failed` — same shape as the migration-drift tile.

**Idempotent by design.** The unique `(workspace_id, spec_slug, script_path)` key means the post-merge hook can re-fire (manual-squash reconcile + auto-merge webhook can race, and a resume-after-approval finalize can re-run applyMergedBuildEffects) without producing duplicate rows or duplicate escalation cards (the CEO-inbox emitter dedupes per `(spec_slug, script_path, UTC day)` — see [[../libraries/ship-time-backfill-detector]]).

**Primary key:** `id` (uuid) · **Unique:** `(workspace_id, spec_slug, script_path)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` default |
| `workspace_id` | `uuid?` | FK → `workspaces.id`, `on delete cascade`. Nullable so a legacy or system-owned backfill (workspace-less) can still be ledgered. |
| `spec_slug` | `text` | The spec whose merged build added the script (matches [[specs]]`.slug`). Not FK'd — a folded spec's rows still carry historical value. |
| `script_path` | `text` | Repo-relative path of the shipped script (e.g. `scripts/_backfill-foo.ts`). Bounded by the [[../libraries/ship-time-backfill-detector]] regex to the `scripts/_backfill-*.ts` convention. |
| `status` | `text` | `pending` (detected, no successful run yet — escalated) · `ran` (executed successfully, Phase 2) · `failed` (executor threw, error captured — escalated). CHECK-constrained. |
| `ran_at` | `timestamptz?` | Timestamp of the last successful run (Phase 2). Null while status is `pending` / `failed`. |
| `error` | `text?` | Captured stderr / throw message from a `failed` run (Phase 2). Null while status is `pending` / `ran`. |
| `created_at` | `timestamptz` | Default `now()` — first-detected timestamp. |
| `updated_at` | `timestamptz` | Default `now()`. Bumped on every executor pass (Phase 2). |

## Invariants

- **UNIQUE (workspace_id, spec_slug, script_path)** — one row per shipped backfill. The upsert in [[../libraries/ship-time-backfill-detector]] `detectAndEscalateShipTimeBackfills` uses `onConflict: "workspace_id,spec_slug,script_path", ignoreDuplicates:true`, so a repeat hook pass is a no-op (never demotes a `ran` row to `pending`).
- **status is CHECK-constrained** to `('pending','ran','failed')`.
- **A `pending` or `failed` row means an escalation MUST have fired** (dedupe caveat: at most once per UTC day per row). The Phase 2 Control Tower tile reads the same rows and stays RED until every one is `ran`.
- **RLS: service_role only.** Every read/write flows through server-side code via `createAdminClient()` — matches the 294 other tables' house convention.

## Readers / writers

- **[[../libraries/ship-time-backfill-detector|`detectAndEscalateShipTimeBackfills`]]** — Phase 1 · the ONLY writer. Called from [[../libraries/agent-jobs|`applyMergedBuildEffects`]] on every merged claude/* build. Idempotent + best-effort — never throws.
- **[[../libraries/agent-jobs|`applyMergedBuildEffects`]]** — the caller. Passes `(workspaceId, specSlug, prNumber, mergeSha)` behind a try/catch so a detector failure never breaks the merge hook.
- **Phase 2** (planned) — the box-side executor will `SELECT` `pending` rows and run each via `tsx`, flipping to `ran` on exit 0 / `failed` on non-zero. A Control Tower `migration-drift`-shaped output assertion will read `SELECT count(*) FROM data_op_runs WHERE status IN ('pending','failed')` to flip a tile RED.

## Related

[[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] · [[../libraries/ship-time-backfill-detector]] · [[../libraries/agent-jobs]] (calls the detector) · [[../libraries/control-tower/migration-drift]] (the sibling ledger this mirrors — migrations, not TS scripts) · [[dashboard_notifications]] (the CEO-inbox surface an unrun row escalates to) · [[../operational-rules]] (§ North star — supervisable autonomy · § Node completeness)
