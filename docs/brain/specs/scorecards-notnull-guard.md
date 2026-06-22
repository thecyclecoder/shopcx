# Scorecards upsert — guard the NOT-NULL violation (23502) ✅

**Owner:** [[../functions/growth]] · **Parent:** follow-on to [[iteration-scorecard-upsert-resilience]] (which hardened FK + error capture; this is the NOT-NULL gap it didn't cover).

The Vercel feed surfaced `[scorecards] batch upsert failed (rows 0..6): 23502 null value` (×3) from `/api/inngest`. Postgres **23502 = not_null_violation** — a row in the `iteration_scorecards_daily` batch has a **NULL in a NOT-NULL column**. [[iteration-scorecard-upsert-resilience]] added per-batch error capture + dangling-FK nulling + a real-count return, so the failure is now *visible* (good — that's why we caught it) and *isolated* (per-row fallback), but the underlying row is still being **dropped**, so those scorecard rows never persist.

## Fix
- **Identify the NOT-NULL column** going null. The upsert keys on `(workspace_id, level, object_id, snapshot_date)` — most likely one of those (e.g. `object_id` null for a rollup level, or `snapshot_date`), or a NOT-NULL metric column the rollup leaves null for some rows.
- **Guard at the source:** either coalesce to a sane default (e.g. metric `0`), skip rows that can't satisfy a genuinely-required key (with a logged count — never silent), or relax the column to nullable if NULL is legitimately valid for that level. Match the fix to *why* it's null (a level that has no object_id? a window with no data?).
- The per-row fallback should then persist every valid row; the dropped-row count goes to 0.

## Verification
- Re-run `computeScorecards` for the affected account → **0 rows** hit 23502; the persisted count equals the valid built count (no silent drops); the Vercel `scorecards … 23502` incident stops recurring.
- Inspect `iteration_scorecards_daily` → the previously-failing `(workspace_id, level, object_id, snapshot_date)` rows are present.
- Negative: a row that's genuinely invalid (truly missing a required key) is **skipped with a logged reason**, not silently dropped and not force-inserted with bad data.

## Phase 1 — find + guard the null column ✅
Located the mechanism: every NOT-NULL metric is typed-default-0, but a *derived* value can still go `NaN`/`±Infinity`, and `JSON.stringify` (used by supabase-js to build the upsert payload) serializes both to `null` — which the DB rejects with `23502`. The conflict-key columns (`workspace_id`/`meta_ad_account_id`/`level`/`object_id`/`snapshot_date`) all come from NOT-NULL sources, but a row can still arrive without one if upstream data is incomplete.

**Fix shipped** in `src/lib/meta/scorecards.ts` — a pre-write pass after the FK-resilience nulling:
- **Skip-with-log** any row missing a required key (logged reason + count; never force-inserted, never silently dropped).
- **Coalesce** any non-finite value in a NOT-NULL metric/bool column to its column default (the nullable deltas + `variant_attribution_coverage` are left untouched). Counts are logged (never silent).
- `persisted` is now measured against the *valid* (kept) count, so for valid rows the dropped count is 0.

Folded into [[../libraries/meta__scorecards]] (Persist gotcha) · [[../tables/iteration_scorecards_daily]] (gotcha) · [[iteration-scorecard-upsert-resilience]].

Verification remaining (owner / spec-test, needs prod observation): re-run `computeScorecards` for the affected account → 0 rows hit 23502; persisted == valid built count; the Vercel `scorecards … 23502` incident stops recurring.
