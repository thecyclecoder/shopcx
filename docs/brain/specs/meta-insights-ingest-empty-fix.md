# Meta insights ingest writes zero ad-level rows → degenerate ROAS ⏳

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

## Phase 1 — diagnose the empty ingest + fix population + attribution + false-success guard ⏳
Trace the ingest write path, fix ad/adset/campaign population + attribution-spend derivation, add the rows-written output assertion. Brain: [[../libraries/meta-performance]] · [[../libraries/meta-scorecards]] · [[../tables/meta_insights_daily]] · [[../tables/meta_attribution_daily]] · [[../tables/iteration_scorecards_daily]] · [[storefront-iteration-engine]] · [[control-tower]].
