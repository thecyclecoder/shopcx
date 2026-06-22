# Meta insights ingest writes zero ad-level rows → degenerate ROAS ✅

**Owner:** [[../functions/growth]] · **Parent:** fixes a live regression in [[storefront-iteration-engine]]; relates to [[iteration-engine-ingest-resilience]] (ingest hardening) + [[control-tower]] (false-success). · **Repair-signature:** spec-test regression `storefront-iteration-engine` (2026-06-22 run).

A spec-test regression + live verification (2026-06-22) found the iteration engine's **ad-economics data is degenerate**:
- `meta_insights_daily` / `meta_campaigns` / `meta_adsets` / `meta_ads` **exist but are empty** — zero rows.
- `iteration_scorecards_daily` has only **`variant` (8) + `angle` (6)** levels — **zero `ad`/`adset`/`campaign` rows**, the engine's *primary* optimization grain.
- All **111 `meta_attribution_daily` rows have `attributed_spend_cents = 0`** (spend derives from the missing insights) → per-variant **ROAS / unit-economics are meaningless**.
- The ingest stage **reports `status='ok'`** the whole time — a silent false-success: it claims success while populating nothing.

The iteration engine optimizes ad spend it can't actually see. (NB: a 90-day backfill for account `d6d619a5` reportedly "completed" — `ingest 133014ms, status complete` — yet the tables are empty, so the run *did something for 2 minutes and persisted nothing*.)

## Investigate → fix
- **Why does the ingest write zero rows?** Trace `syncMetaInsights` / the iteration-run ingest stage (`src/lib/meta/performance.ts`, `scorecards.ts`): does it call the Meta Graph insights endpoint, get rows back, and upsert them? Candidate root causes: (a) the Meta API returns empty (token/permission/`act_` id wrong → 0 rows, but the code treats empty-OK); (b) the upsert targets a different workspace/account (RLS / id mismatch) so rows land nowhere visible; (c) the backfill ran but a silent error/early-return persisted nothing; (d) the ad/adset/campaign levels are never requested (only variant/angle paths run).
- **Fix the population** so `meta_insights_daily` (+ campaigns/adsets/ads) actually fill at the ad/adset/campaign grain for the active account, and `iteration_scorecards_daily` produces ad/adset/campaign-level rows.
- **Fix attribution spend** — `meta_attribution_daily.attributed_spend_cents` must derive non-zero once insights exist; verify the join/derivation.
- **Stop the false-success** — the ingest must NOT report `status='ok'` when Meta has data but it persisted 0 rows. Make it assert its output (rows-written > 0 when insights are expected) → fail loud / surface to the Control Tower (the [[control-tower]] false-success assertion class), so this can never silently degrade again.

## Verification
- After the fix, for the active account: `meta_insights_daily` has rows at `campaign`/`adset`/`ad`; `select level, count(*) from iteration_scorecards_daily` includes `ad`/`adset`/`campaign` (not just variant/angle).
- `meta_attribution_daily` rows have **non-zero** `attributed_spend_cents`; a spot-checked variant's ROAS = revenue ÷ real spend (not ÷ 0).
- An ingest run that gets Meta data but persists 0 rows → **does not** report `ok`; it fails/surfaces (no silent false-success).
- Negative: an account that genuinely has no Meta spend → 0 rows is correct + reported honestly (not a false alarm).

## Phase 1 — diagnose the empty ingest + fix population + attribution + false-success guard ✅
Trace the ingest write path, fix ad/adset/campaign population + attribution-spend derivation, add the rows-written output assertion. Brain: [[../libraries/meta-performance]] · [[../libraries/meta-scorecards]] · [[../tables/meta_insights_daily]] · [[../tables/meta_attribution_daily]] · [[../tables/iteration_scorecards_daily]] · [[storefront-iteration-engine]] · [[control-tower]].

### Diagnosis (2026-06-22)
The empty tables were a **swallowed-write false-success**, not a missing-data problem. `meta_attribution_daily` had 111 rows (it reads internal `storefront_sessions`/`orders`) but every row's `attributed_spend_cents = 0` because spend derives from `meta_insights_daily` (level='ad'), which — like `meta_campaigns`/`meta_adsets`/`meta_ads` — was **empty**. Those four tables are populated from the **Meta Graph API** via `syncMetaStructure` / `syncMetaInsightsForLevel` in `src/lib/meta/performance.ts`, and **both functions ignored the `{ error }` returned by every `.upsert()` and returned `records.length` (rows *attempted*), not rows *persisted*.** So a run could page Meta for ~2 minutes (the observed `ingest 133014ms, status complete`), have every upsert fail, and still return high counts + `status='ok'` with 0 rows written. `computeVariantAttribution` in `attribution.ts` had the identical swallow. (The unique constraints all exist and match the `onConflict` targets — so the conflict spec itself wasn't the error; the point is *any* upsert error was invisible.) `scorecards.ts` was already hardened against this exact class; performance/attribution were not.

### Fix (landed)
- **`performance.ts`** — new `upsertOrThrow()` helper: chunks ≤500, checks `{ error }` on every upsert, surfaces it to the Control Tower feed via `reportDbError`, throws with the PG code+message, and returns the count **persisted**. `syncMetaStructure` and `syncMetaInsightsForLevel` now route through it and return persisted counts (no longer `records.length`).
- **Rows-written output assertion** — `ingestMetaPerformance` now cross-checks against the independent `daily_meta_ad_spend` account rollup: if it persisted **0** ad/adset/campaign insight rows but the rollup proves the account **spent** in the window, it surfaces a `META_INGEST_EMPTY` false-success to the Control Tower and **throws** (run fails loud). An account with genuinely no spend → 0 rollup spend → 0 rows stays silent (the negative case).
- **`attribution.ts`** — `computeVariantAttribution` upsert now checks `{ error }`, surfaces via `reportDbError`, throws, and returns persisted count. Spend is non-zero once `meta_insights_daily` (level='ad') populates — the derivation/allocation logic was already correct; it was starved of the (empty) insights input.
- **Observability** — the `meta/iteration-run` ingest stage records `insight_rows` (rows-written) on its `StageRecord`.

## Verification
- On `meta/iteration-run` (or `meta/sync-performance`) for the active account, after a successful run → expect `meta_insights_daily` to have rows at `level` ∈ `campaign`/`adset`/`ad` (`select level, count(*) from meta_insights_daily where meta_ad_account_id = '<acct>' group by level`), and `meta_campaigns`/`meta_adsets`/`meta_ads` non-empty.
- On `iteration_scorecards_daily` after a run → expect `select level, count(*) from iteration_scorecards_daily group by level` to include `ad`/`adset`/`campaign` rows, not just `variant`/`angle`.
- On `meta_attribution_daily` after a run → expect rows with **non-zero** `attributed_spend_cents`; spot-check one variant's `roas = revenue_cents / attributed_spend_cents` (not ÷ 0).
- Inject a forced upsert error (or run against an account whose `daily_meta_ad_spend` shows spend while Meta returns 0 insight rows) → expect the `ingest` step to **throw** (`META_INGEST_EMPTY` / a `meta_*_upsert failed …` error), the `iteration_runs` row to be `status='failed'`, an ops alert, and a `supabase`-source incident on `/dashboard/developer/control-tower` — **not** a `status='ok'`/`complete` run.
- Negative: on an account with no Meta spend in the window (empty `daily_meta_ad_spend`) → expect the run to complete with 0 insight rows and **no** alert/throw (0 rows is honest, not a false alarm).
