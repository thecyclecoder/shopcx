# libraries/media-buyer__cold-scaler-cac-ltv-sensor

Campaign-scoped **CAC:LTV sensor** for the M4 cold-scaler surface — the missing grain between the per-creative ROAS grader ([[media-buyer-grader]]) and the workspace-blended composer ([[blended-cac-ltv]]). One row per `(workspace, cold_scaler_cohort, iso_week)` on [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] persists the scaler campaign's own spend + new-customer revenue + blended LTV + derived `cacLtvRatio` + `paybackDays` + `band` (`red|yellow|green|unknown`) + human-readable `flags`. Authored by [[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] (Phase 2; M4 of [[../goals/bianca-temperature-aware-campaign-structure]]).

**File:** `src/lib/media-buyer/cold-scaler-cac-ltv-sensor.ts`

**Callers:** [[media-buyer__cold-scaler-arming-gate]] `runColdScalerArmingGate` (via `readLatestColdScalerCacLtvSnapshot`) — the gate's CAC:LTV precondition prefers this campaign-scoped snapshot when a row exists and falls through to [[blended-cac-ltv]] `computeBlendedCacLtv` when absent. The dispatch surface for the orchestrator (a Growth-supervised box lane on weekly cadence) is pending — the Phase-2 artifact is the pure sensor + orchestrator + reader + tests + brain pages.

**Distinct from [[blended-cac-ltv]]** — that composer blends every mapped ad account into ONE workspace-wide number (the Growth Director's top-line). This sensor answers the different question: *what is THIS scaler campaign's own CAC:LTV*? Same math, different grain. The two never disagree on the formula because the sensor delegates its ratio derivation to `blendedCacLtvFromTotals` verbatim.

**Distinct from [[../tables/media_buyer_cold_scaler_arming_authorization]]** — that row pins the shadow→armed AUTHORIZATION decision + reasons; the snapshot pins the CAC:LTV NUMBER the authorization consumes. The two ship in either order — the arming gate reads the snapshot when present, else the workspace-blended composite.

## Exports

### `computeColdScalerCacLtvSnapshot` — function (pure)

```ts
function computeColdScalerCacLtvSnapshot(input: {
  spendCents: number;
  newCustomers: number;
  revenueCents: number;
  ltvCents: number;
  target?: number;        // default COLD_SCALER_CAC_LTV_GREEN_MIN (= DEFAULT_BLENDED_CAC_LTV_TARGET = 3)
  flags?: string[];       // extra flags forwarded to the composer + surfaced on the snapshot
  windowDays?: number;    // default 7 (one ISO week)
}): ColdScalerCacLtvSnapshot
```

The pure math step — delegates the `cacLtvRatio` + `paybackDays` derivation to [[blended-cac-ltv]] `blendedCacLtvFromTotals` (single source of truth for the formula), then maps the ratio to a band via the boundary constants. Returns `{ spendCents, newCustomers, revenueCents, ltvCents, cacLtvRatio, paybackDays, band, flags }`. Unit tests pin each band by feeding fixture ratios.

### `runColdScalerCacLtvSensor` — function (DB)

```ts
async function runColdScalerCacLtvSensor(admin: Admin, input: {
  workspaceId: string;
  coldScalerCohortId: string;
  isoWeek: string;                // YYYY-Www label
  target?: number;
  now?: Date;
}): Promise<RunColdScalerCacLtvSensorResult>
```

The DB-touching orchestrator. Resolves the scaler's `meta_ad_id` set (cohort → `scaler_meta_campaign_id` → [[../tables/meta_adsets]] → [[../tables/meta_ads]]), aggregates `attributed_spend_cents` + `revenue_cents` + `orders` from [[../tables/meta_attribution_daily]] over the ISO-week window, blends the LTV numerator via [[blended-cac-ltv]] `computeBlendedCacLtv` (LTV field only — the ratio + band come from the scaler-scope totals), calls `computeColdScalerCacLtvSnapshot`, upserts one snapshot row keyed by `(workspace, cohort, iso_week)`, and stamps ONE `media_buyer_cold_scaler_cac_ltv_snapshot_written` [[../tables/director_activity]] row per snapshot so the Growth digest + grader can cite the number without re-derivation. Returns `{ snapshotId, band, cacLtvRatio, spendCents, ltvCents }`.

### `readLatestColdScalerCacLtvSnapshot` — function (DB, read)

```ts
async function readLatestColdScalerCacLtvSnapshot(admin: Admin, input: {
  workspaceId: string;
  coldScalerCohortId: string;
}): Promise<ColdScalerCacLtvSnapshotRow | null>
```

The [[media-buyer__cold-scaler-arming-gate]] consumer chokepoint. Returns the newest snapshot row for `(workspace, cohort)` (ordered by `evaluated_at DESC`), or `null`. The arming gate treats `null` as "no snapshot yet" and falls through to `computeBlendedCacLtv` — same denial-branch shape (`cac_ltv_below_target` / `cac_ltv_unknown`) works either way. Bigint-as-string columns (`spend_cents`, `revenue_cents`, `ltv_cents`, `cac_ltv_ratio`, `payback_days`) are normalized to `number` so callers don't have to.

### `upsertColdScalerCacLtvSnapshot` — function (DB, write)

```ts
async function upsertColdScalerCacLtvSnapshot(admin: Admin, args: {
  workspaceId: string;
  metaAdAccountId: string | null;
  coldScalerCohortId: string;
  isoWeek: string;
  snapshot: ColdScalerCacLtvSnapshot;
  evaluatedAt: string;
}): Promise<string | null>
```

Select-then-write compare-and-set on `(workspace_id, cold_scaler_cohort_id, iso_week)` — the same pattern as the sibling [[media-buyer__cold-scaler-arming-gate]] `upsertColdScalerAuthorization`. A re-evaluation within the same ISO-week UPDATEs in place (newest evaluation wins; `updated_at` bumps via the row's touch trigger); a new week INSERTs. Returns the row id or `null` on error.

### `ratioToBand` — function (pure)

```ts
function ratioToBand(ratio: number | null, target?: number): ColdScalerCacLtvBand
```

Bare `cacLtvRatio` → band label. Exported for surfaces (Growth digest, CEO card) that carry a ratio without the full snapshot and need the same band vocabulary. `null` → `'unknown'`; `≥ target` → `'green'`; `≥ COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER × target` and below `target` → `'yellow'`; below → `'red'`.

### `isoWeekWindow` — function (pure)

```ts
function isoWeekWindow(isoWeek: string): { startDate: string; endDate: string }
```

Parses a `YYYY-Www` ISO-week label into its inclusive Mon..Sun `startDate` / `endDate` (ISO 8601, Thursday-based year). Same convention as [[media-buyer__cold-scaler-arming-gate]] `isoWeekLabel`. Throws on a malformed label.

### Constants

- `COLD_SCALER_CAC_LTV_GREEN_MIN` (`3`, sourced from `DEFAULT_BLENDED_CAC_LTV_TARGET`) — green floor; a scaler running LTV ≥ 3× CAC lands in the healthy band.
- `COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER` (`0.7`) — yellow floor as a fraction of the target. Kept relative so the same buffer applies when a caller lowers the target for a workspace on a shorter payback runway.

### Types

`ColdScalerCacLtvBand` (`'red' | 'yellow' | 'green' | 'unknown'`), `ColdScalerCacLtvSnapshot`, `ColdScalerCacLtvSnapshotRow`, `ComputeColdScalerCacLtvSnapshotInput`, `RunColdScalerCacLtvSensorInput`, `RunColdScalerCacLtvSensorResult`, `ReadLatestColdScalerCacLtvSnapshotInput` — see source.

## Tests

`src/lib/media-buyer/cold-scaler-cac-ltv-sensor.test.ts` — `npm run test:media-buyer-cold-scaler-cac-ltv-sensor`. Pins (a) each band boundary via `ratioToBand` + `computeColdScalerCacLtvSnapshot` on fixture ratios; (b) that the pure sensor DELEGATES to `blendedCacLtvFromTotals` (same `cacLtvRatio` / `paybackDays` / `flags` as calling the composer directly); (c) `readLatestColdScalerCacLtvSnapshot` round-trip through an in-memory admin, including the bigint-string → number normalisation and the null-ratio surface (`null` stays `null`, band `'unknown'`).

## Gotchas

- **Sensor is scaler-scoped; the composer is workspace-wide.** Do NOT interpret a red snapshot as "the workspace is unprofitable" — it only means THIS scaler campaign's own attributed spend/revenue is below target. A healthy workspace can carry a red scaler cohort while the composite is green.
- **`null` cacLtvRatio means UNKNOWN, not `0`.** The pure sensor emits `band='unknown'` and a `flags` line explaining why (no new customers, no LTV, no meta_ads under the scaler campaign). NEVER treat a null ratio as failing the target — the [[media-buyer__cold-scaler-arming-gate]] routes `null` to the distinct `cac_ltv_unknown` denial code.
- **LTV numerator uses the workspace-blended composer.** For simplicity + to keep the sensor and composer aligned on the LTV formula, `computeScalerLtvNumeratorCents` calls `computeBlendedCacLtv` over the ISO-week window and takes its `blendedLtvCents`. When per-cohort product filtering lands (spec follow-on), the sensor will pass `groupIds` filtered to the products the scaler advertised; today the LTV is workspace-blended and a `ltv:` prefixed flag surfaces on the snapshot.
- **`spend`/`revenue`/`newCustomers` are scaler-scope.** They come from [[../tables/meta_attribution_daily]] filtered to the `meta_ad_id` set under `scaler_meta_campaign_id` — not from the workspace-wide `acquisition-roas` blend. This is what makes the number gradable at the scaler campaign level.
- **A fresh scaler campaign lands as `band='unknown'`.** Until [[../tables/meta_ads]] / [[../tables/meta_adsets]] are populated for the campaign (mid-ingest), the sensor writes a zeros snapshot with a `no meta_adsets found …` / `no meta_ads found …` flag and `band='unknown'`. The arming gate then denies with `cac_ltv_unknown` — the correct dormant behaviour for an unproven cohort.
- **`director_activity` write is best-effort.** `recordDirectorActivity` never throws; a failed activity write logs a warning but the snapshot row still lands. The snapshot IS the durable artifact — the activity row is an audit convenience for the Growth digest + grader.
- **Do NOT read `media_buyer_cold_scaler_cac_ltv_snapshots` outside this SDK.** The reader normalizes bigint-string columns + validates the band enum; a raw `.from(...)` will silently mis-type or accept a widened band value.

## Migration

- **[[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] Phase 1:** `supabase/migrations/20261024120000_media_buyer_cold_scaler_cac_ltv_snapshots.sql` — the snapshot table this sensor writes to. Apply with `npx tsx scripts/apply-media-buyer-cold-scaler-cac-ltv-snapshots-migration.ts`.

## Related

[[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] · [[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/media_buyer_cold_scaler_arming_authorization]] · [[../tables/meta_attribution_daily]] · [[../tables/meta_ads]] · [[../tables/meta_adsets]] · [[blended-cac-ltv]] · [[media-buyer__cold-scaler-arming-gate]] · [[cold-scaler-cohort]] · [[media-buyer-grader]] · [[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)

---

[[../README]] · [[../../CLAUDE]]
