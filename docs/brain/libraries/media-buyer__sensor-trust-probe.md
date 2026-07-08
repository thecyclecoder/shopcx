# media-buyer__sensor-trust-probe

`src/lib/media-buyer/sensor-trust-probe.ts` — Phase 2 of [[../specs/media-buyer-sensor-trust-probe]]. The per-workspace daily probe that rolls attribution + insights into a green/yellow/red **sensor-trust** verdict so [[media-buyer-agent]] (Phase 3) can refuse to trust ROAS when the sensor is dirty.

## Purpose

Directly serves the [[../goals/autonomous-media-buyer-supervision]] "shadow-mode winner/loser calls match a human review within tolerance" success criterion by refusing to grade Media Buyer calls against untrusted spend/revenue. Every cadence the probe:

1. Rolls `meta_attribution_daily` + `meta_insights_daily` over the lookback window scoped to `(workspace_id, meta_ad_account_id)` (or workspace-wide when the account axis is null).
2. Derives `coverage_ratio`, `unresolved_revenue_share`, `spend_allocation_ratio` per [[meta__attribution]] § Coverage shape.
3. ANDs those signals against the cohort's owner-editable thresholds ([[../tables/media_buyer_test_cohorts]] `green_min_coverage` / `yellow_min_coverage` / `max_unresolved_share`) into ONE **green / yellow / red** band with a `reasons` array.
4. Upserts one row on the composite unique `(workspace_id, coalesce(meta_ad_account_id::text, ''), snapshot_date)`.

The worst signal wins — a single failing dimension (sample too thin, coverage below floor, unresolved share over cap) demotes trust. Mirrors the north-star rail behaviour: hit a rail = **escalate**, not proceed.

## Exports

### `computeSensorTrust(totals: SensorTrustTotals, thresholds: SensorTrustThresholds): SensorTrustVerdict` — PURE

Given rolled window totals + the cohort thresholds, returns `{ band, reasons, coverageRatio, unresolvedRevenueShare, spendAllocationRatio, sampleOrders, sampleSpendCents }`. **No DB, no clocks** — the same inputs produce the same verdict every time so [[#sensor-trust-probe.test]] pins band math against fixture totals.

Bands:
- **red**  — sample below `MIN_SAMPLE_ORDERS` OR coverage below yellow floor OR unresolved share over cap
- **yellow** — coverage between yellow and green floors, unresolved share within cap; or spend-allocation ratio thin as a secondary rail
- **green** — coverage at or above green floor, unresolved share within cap, sample present

`reasons` tokens (contract for [[media-buyer-agent]] Phase 3 to route into `director_activity.metadata`): `insufficient_sample`, `no_meta_revenue`, `low_coverage`, `coverage_below_green`, `unresolved_share_over_cap`, `spend_allocation_thin`.

### `runSensorTrustProbe(admin, args)` — orchestrator

`args = { workspaceId, metaAdAccountId?, snapshotDate?, windowDays?, nowMs? }`. Reads the effective thresholds from [[../tables/media_buyer_test_cohorts]] (per-account row beats workspace-wide), rolls totals from [[../tables/meta_attribution_daily]] + [[../tables/meta_insights_daily]] over `[snapshotDate - windowDays, snapshotDate]`, calls `computeSensorTrust`, and upserts one [[../tables/media_buyer_sensor_trust]] row on the composite unique — returning `{ snapshotDate, windowDays, band, reasons, coverageRatio, unresolvedRevenueShare, spendAllocationRatio, sampleOrders, sampleSpendCents, persisted }`.

Defaults:
- `snapshotDate` — yesterday (Central-time bucket, matches [[meta__attribution]]'s window)
- `windowDays` — `DEFAULT_WINDOW_DAYS` (14, matches the spec's `[today-14d, today-1d]`). Clamped to `[1, MAX_WINDOW_DAYS]` (matches the table check constraint).
- `metaAdAccountId` — `null` = workspace-wide snapshot.

Threshold fallbacks (a cohort row that leaves a column NULL):
- `DEFAULT_GREEN_MIN_COVERAGE = 0.7`
- `DEFAULT_YELLOW_MIN_COVERAGE = 0.5`
- `DEFAULT_MAX_UNRESOLVED_SHARE = 0.3`

Sample floor:
- `MIN_SAMPLE_ORDERS = 5` — windows below this always band `red` with `insufficient_sample` (mirrors [[media-buyer-grader]]'s realized-window discipline: a 2-order window is not evidence the sensor is clean).

## Callers

- **`scripts/builder-worker.ts` — `sensor-trust-probe` lane.** `runSensorTrustProbeJob` claims a queued job of `kind='sensor-trust-probe'`, parses the instructions JSON (`{ meta_ad_account_id?, snapshot_date?, window_days? }`), fans out over `null` (workspace-wide) + every connected `meta_ad_accounts` row when no explicit account is passed, and stamps `agent_jobs.status='completed'` with the per-scope band + reasons in `log_tail`. Concurrency-1 lane (`MAX_SENSOR_TRUST_PROBE`).
- **`src/lib/media-buyer/agent.ts` (Phase 3 — pending).** Reads the newest `media_buyer_sensor_trust` row for `(workspaceId, metaAdAccountId, snapshot_date desc, limit 1)` before `computeMediaBuyerPlan` and short-circuits on missing / stale / `band='red'`.

## Callees

- [[meta__attribution]] — coverage-shape definitions the probe mirrors (`variant_attribution_coverage` numerator/denominator, `UNRESOLVED_VARIANT` sentinel).
- [[../tables/meta_attribution_daily]] — attribution rollup; the probe sums `attributed_spend_cents`, `revenue_cents`, `orders` split by `variant === UNRESOLVED_VARIANT`.
- [[../tables/meta_insights_daily]] — insights rollup at `level='ad'`; the probe sums `spend_cents` for the window (denominator of `spend_allocation_ratio`).
- [[../tables/media_buyer_test_cohorts]] — reads `green_min_coverage` / `yellow_min_coverage` / `max_unresolved_share` (all nullable → probe defaults).
- [[../tables/media_buyer_sensor_trust]] — the probe's only writer; upsert on the composite unique.

## Gotchas

- **`(unresolved)` counts toward BOTH numerator and denominator per [[../tables/meta_attribution_daily]] § Gotchas.** The `computeSensorTrust` denominator is `resolvedRevenueCents + unresolvedRevenueCents` — dropping the sentinel would over-report coverage.
- **Yellow > Green is coerced to Green.** A cohort authored with `yellow_min_coverage > green_min_coverage` would paint every window `red`-or-`green` with no middle band. The probe clamps yellow down to green so the band ordering is preserved.
- **Spend-allocation thinness is a SECONDARY rail (demotes to `yellow`, not `red`).** Coverage is the dominant signal; a thin allocation ratio is a caution flag the operator should see, but not a full-red denial (the coverage rail already catches the dominant case).
- **Workspace-wide + per-account rows coexist.** The composite unique folds `NULL` `meta_ad_account_id` to `''`, so a fan-out pass can leave both a workspace-wide row (`meta_ad_account_id=null`) AND per-account rows for the same date without colliding.
- **Central-time bucket is approximated.** The probe's `yesterdayCentralIso` uses a fixed 6h offset to bias into Central without pulling a tz lib — sufficient because the underlying rollups already pad ±1d in UTC per [[meta__attribution]].
- **The probe is service-role only.** [[../tables/media_buyer_sensor_trust]] has workspace-member SELECT RLS but only the service role writes; the lane runs from the box with admin credentials.
- **`.upsert(...).select("id")` is the compare-and-set guard.** A same-day re-run updates in place (the table's `updated_at` trigger bumps the timestamp); a zero-row result means the coalesce-expression conflict didn't match and the caller sees `persisted=false`.

## Tests

- `src/lib/media-buyer/sensor-trust-probe.test.ts` — pure `computeSensorTrust` fixtures. Pins:
  - Empty window → `band='red'`, `reasons` includes `insufficient_sample`, `sample_orders=0` (Phase 2 verification).
  - Clean window (high coverage + low unresolved + full spend allocation) → `band='green'`.
  - Coverage in the yellow band (with unresolved share within cap) → `band='yellow'` + `coverage_below_green`.
  - Coverage below yellow floor → `band='red'` + `low_coverage`.
  - Unresolved share over cap alone demotes to `red` + `unresolved_share_over_cap`.
  - Spend-allocation thin secondary rail demotes green to `yellow` + `spend_allocation_thin`.
  - Null thresholds fall back to code-level defaults.
  - Sample below `MIN_SAMPLE_ORDERS` demotes to `red` even at perfect coverage.
  - `yellow > green` cohort configuration is coerced (yellow clamped down).

Run: `npm run test:media-buyer-sensor-trust` (script added in package.json).

## Related

[[../tables/media_buyer_sensor_trust]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/meta_attribution_daily]] · [[../tables/meta_insights_daily]] · [[meta__attribution]] · [[media-buyer-agent]] · [[media-buyer-grader]] · [[../specs/media-buyer-sensor-trust-probe]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
