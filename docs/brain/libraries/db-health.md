# libraries/db-health

The detection + classification + dedup + spec-templating brain behind the **DB Health Agent** ([[../specs/db-health-agent]] Phase 1) — a standing box agent that watches Postgres health and **proposes** fixes (retention / index / query-rewrite / index-drop / vacuum). It mirrors [[repair-agent]] (propose-don't-auto-apply) + [[control-tower-migration-drift-check]] (box-side DB introspection). Commissioned after the `loop_heartbeats` flood silently blinded the Control Tower — exactly the class of problem a DB agent catches *early*.

**File:** `src/lib/control-tower/db-health.ts` · box runners: `scripts/builder-worker.ts` `runDbHealthSlowQueryJob` / `runDbHealthSizeJob` / `runDbHealthJob` (see [[../recipes/build-box-setup]]).

## North star — surface-don't-auto-apply

DDL/deletes are higher-stakes autonomy ([[../operational-rules]] § North star): a bad index slows writes; a retention delete loses data. So the agent applies **zero** DDL/deletes — it detects read-only (reads `pg_stat_*`, runs `EXPLAIN`), classifies the root cause, **pre-authors** the matching fix spec, and **surfaces** it for one-tap owner Build (the [[agent_jobs]] `db_health` proposal + the Control Tower DB Health panel). A tool optimizing a bounded proxy (DB perf/size), supervised by Platform.

## Where it runs — the box, not the deployed runtime

Like the migration-drift check, detection runs on the box: `EXPLAIN` + `pg_stat_statements` + `pg_class`/`pg_stat_user_*` need a raw pooler connection the deployed Next runtime can't use. The box passes the read rows into this PURE module (no fs/pg/network at module load) so the LOGIC stays testable.

## Exports

- **Loop ids** `DB_HEALTH_SLOWQ_LOOP_ID` (`"db-health-slow-query"`) + `DB_HEALTH_SIZE_LOOP_ID` (`"db-health-size-sweep"`) — re-exported from [[control-tower]] `registry.ts`; the loop_ids of the two box-emitted passes (`kind:'cron'` beats). Liveness tiles (green when beating) — findings surface as **proposals**, not by reddening the tile.
- **Taxonomy:** `DbHealthCause` (10: `seq_scan` · `no_index_match` · `sort_spill` · `full_aggregate` · `missing_limit` · `bloat_stale_stats` · `unbounded_growth` · `missing_index` · `unused_index` · `bloat_vacuum_lag`), `DbHealthFixKind` (`retention_cron` · `add_index` · `drop_index` · `query_rewrite` · `vacuum_tuning`), `DbHealthCategory` (`slow_query` · `growth` · `index` · `bloat`). `FIX_KIND_BY_CAUSE` maps each cause → its fix.
- **Input row shapes** the box feeds in: `SlowQueryRow` (a `pg_stat_statements` row), `TableSizeRow` (a [[../tables/db_table_size_history]] row), `IndexStatRow` (a `pg_stat_user_indexes` row + size + is_unique/is_primary).
- **Thresholds** (the bounded proxy's guardrails, all tunable): `SLOW_QUERY_MIN_MEAN_MS` (100) · `SLOW_QUERY_MIN_TOTAL_MS` (30s) · `SIZE_MIN_BYTES` (200 MB) · `GROWTH_FLAG_FRACTION` (0.25/day) · `SEQ_SCAN_SHARE_FLAG` (0.5) + `SEQ_SCAN_MIN_ABS` (10k) · `UNUSED_INDEX_MIN_BYTES` (50 MB) · `BLOAT_DEAD_RATIO_FLAG` (0.2) + `BLOAT_AUTOVACUUM_STALE_MS` (1d) · `RETENTION_AWARE_TABLES` (don't re-propose retention — `loop_heartbeats` has its pruner) · `DB_HEALTH_REPROPOSE_WINDOW_MS` (7d).
- **The EXPLAIN root-cause brain:** `isSafeSelect(query)` (only EXPLAIN read-only SELECT/WITH, never a write — a `WITH` with any write keyword is rejected), `classifyExplainPlan(planText)` → `{ cause, seqScanTables, hint }` (order matters: disk-sort + full-aggregate beat a bare seq scan), `analyzeSlowQuery(row, planText|null)` → a `DbHealthFinding` over the impact floor (null below it; a null plan — a parameterized statement EXPLAIN couldn't plan — falls back to a conservative text-based cause + a rewrite-review fix).
- **The size/index/bloat detectors:** `analyzeGrowth(latest, prior)` (unbounded growth vs the prior daily snapshot — none on the first sweep), `analyzeIndexUsage(tables, indexes)` (missing-index = high seq-scan share on a big table; unused-index = `idx_scan=0` non-PK/non-unique index ≥50 MB → drop), `analyzeBloat(tables, now)` (high dead-tuple ratio + stale autovacuum).
- **Ranking + dedup:** `rankFindings` (by impact score desc), `dedupeFindings` (collapse same-signature, keep the highest), `summarizeFindings` (one-line beat detail).
- **Spec templating:** `buildFixSpecMarkdown(finding)` → the single-phase fix spec (`⏳`, owner platform) with the cause-specific guidance + the EXPLAIN/stat **evidence quoted verbatim** + the `**DBHealth-signature:**` / `**DBHealth-fix:**` machine markers.
- **Surface (admin client):** `enqueueDbHealthProposal(admin, finding)` → enqueue ONE deduped `db_health` [[agent_jobs]] proposal (`needs_approval`, carrying the pre-authored spec body in `instructions` + a `db_health_build` `pending_actions` entry). `getDbHealthPanel(admin, workspaceId)` → READ-ONLY `{ topTables, slowQueries, proposals, lastSizeSweepAt, lastSlowQueryAt }` for the dashboard.

## The two box passes

- **`runDbHealthSlowQueryJob`** (~hourly): top 25 `pg_stat_statements` offenders by `total_exec_time` → `EXPLAIN` each safe SELECT (plain `EXPLAIN`, no `ANALYZE` — non-executing, safe on prod; retries `EXPLAIN (GENERIC_PLAN)` for a parameterized statement on PG16+) → `analyzeSlowQuery` → surface top-N. Beats with `produced.slow_queries` for the panel.
- **`runDbHealthSizeJob`** (daily): snapshot every `public` table's size + stats into [[../tables/db_table_size_history]] (so growth is computable), read the prior batch, run `analyzeGrowth` + `analyzeIndexUsage` + `analyzeBloat`, surface top-N. Beats with `produced.top` (biggest tables).
- Both are fire-and-forget in the poll loop with an in-flight guard (never overlap/stall the 5s poll), cap proposals to `DB_HEALTH_MAX_PROPOSALS_PER_PASS` (5), and **never throw** (a pass failure can't break the box). No DB password on this host ⇒ the pass beats `status:'skipped'` (honest, never a false "healthy").

## Dedup discipline

One open proposal per finding **signature** (`dbhealth:<category>:<key>`, e.g. `dbhealth:growth:loop_heartbeats`, `dbhealth:unused-index:<name>`, `dbhealth:slowq:<queryid>:<table>`). `enqueueDbHealthProposal` skips if a **live** proposal (`needs_approval`/queued/…/`needs_attention`) exists for the signature **or** a non-dismissed proposal for it was built within `DB_HEALTH_REPROPOSE_WINDOW_MS` (its fix is deploying — don't flap while the condition resolves). Never proposes retention for a `RETENTION_AWARE_TABLES` table, an index already present, or a PK/unique index for drop.

## Owner action — the gate

`POST /api/developer/control-tower/db-health` (`{ jobId, action:'build'|'dismiss' }`, owner-gated). **Dismiss** resolves the proposal directly (`completed`). **Build** flips it to `queued_resume`; the box's `runDbHealthJob` re-claims it on the `db_health` lane, commits the pre-authored fix spec to `main` (`putFileMain`), and queues the actual `build` job (auto-build-deduped via `hasActiveBuildForSlug`) — the build runs through the normal pipeline + lands the migration/apply-script in a PR for owner review. NOTHING touches schema/data without that tap.

## Gotchas

- **No migration for the proposal queue** — `db_health` is a free-text [[agent_jobs]] `kind`; the surfaced fix parks in the existing `pending_actions` jsonb (`type:'db_health_build'`, `spec_slug` + `spec_title`). Only [[../tables/db_table_size_history]] is new.
- **The spec is pre-authored at detection, committed on Build** — unlike [[repair-agent]] (which runs an LLM diagnosis), DB-health diagnosis is deterministic (EXPLAIN classification), so the full spec body is built at detection time and carried on `instructions.spec_body`; the box only writes it to `main` when the owner taps Build (no orphan spec files for dismissed findings).
- **`EXPLAIN` never `ANALYZE`s in Phase 1** — plain `EXPLAIN` doesn't execute the query (safe on prod, and a normalized `$1` statement can't be ANALYZEd anyway). The plan still shows Seq Scan / estimated rows — enough to classify. `EXPLAIN (ANALYZE, BUFFERS)` on confirmed-safe SELECTs is a Phase 2 option.
- **The agent is watched too** — both passes are `kind:'cron'` MONITORED_LOOPS tiles ([[control-tower]] `registry.ts`); a dead pass shows red via cron freshness, with `registeredAt` gracing the first-run window.

## Callers

`scripts/builder-worker.ts` (`runDbHealthSlowQueryJob` · `runDbHealthSizeJob` · `runDbHealthJob` · the poll-loop fire) · `src/app/api/developer/control-tower/route.ts` (`getDbHealthPanel`) · `src/app/api/developer/control-tower/db-health/route.ts` (Build/Dismiss) · `src/app/dashboard/developer/control-tower/page.tsx` (the DB Health panel).

## Related

[[../specs/db-health-agent]] · [[control-tower]] · [[repair-agent]] · [[../specs/control-tower-migration-drift-check]] · [[../tables/db_table_size_history]] · [[../tables/agent_jobs]] · [[../tables/loop_heartbeats]] · [[../specs/loop-heartbeats-retention]] · [[../dashboard/control-tower]] · [[../recipes/write-a-migration-apply-script]] · [[../operational-rules]]
