# libraries/meta/performance

Meta performance ingestion (Graph v21.0) — Storefront Iteration Engine Phase 1.
Mirrors campaign/adset/ad structure into [[../tables/meta_campaigns]] /
[[../tables/meta_adsets]] / [[../tables/meta_ads]], pulls daily object-grain
insights into [[../tables/meta_insights_daily]], and reconciles against
[[../tables/daily_meta_ad_spend]].

**File:** `src/lib/meta/performance.ts`

## Exports

### `syncMetaStructure` — function

```ts
async function syncMetaStructure(p: SyncParams): Promise<{ campaigns: number; adsets: number; ads: number }>
```
Upserts campaigns/adsets/ads (+ budgets, status) keyed on the Meta object id.

After the [[../tables/meta_adsets]] upsert, on the **scoped path only**
(`opts.campaignIds` provided), runs a drop-out reconcile: any mirror row for
those campaigns that Meta didn't return this run and isn't already `ARCHIVED`
is flipped to `status='ARCHIVED'`, `effective_status='ARCHIVED'` (chunked
compare-and-set, workspace + account scoped). Meta excludes archived adsets
from its default `/adsets` list, so without this an archived adset stays stuck
ACTIVE in the mirror forever (Superfood Tabs incident). Never runs on the
full-account path — the 2-hourly test-cadence sync scopes to the test
campaigns, so the surface that needs it self-heals every 2 hours.

### `reconcileDroppedAdsetIds` — function

```ts
function reconcileDroppedAdsetIds(
  syncedCampaignIds: string[],
  returnedAdsetIds: string[],
  mirroredAdsets: Array<{ meta_adset_id: string; meta_campaign_id: string | null; status: string | null }>,
): string[]
```
Pure set-difference used by `syncMetaStructure`'s drop-out reconcile: returns
the mirrored adset ids that belong to a synced campaign but Meta didn't return
and aren't already ARCHIVED. Kept pure so the Superfood-Tabs case is unit-tested
without touching Graph or Supabase — see `performance.reconcile-dropped-adsets.test.ts`.

After the [[../tables/meta_ads]] upsert, the same scoped-only drop-out reconcile
is applied to `meta_ads` via `reconcileDroppedAdIds` — a dropped AD leaves the
same ghost the Ad Testing creative view + ad-level signals read against.
Campaign-level drop-out is out of scope (campaigns are long-lived).

### `reconcileDroppedAdIds` — function

```ts
function reconcileDroppedAdIds(
  syncedCampaignIds: string[],
  returnedAdIds: string[],
  mirroredAds: Array<{ meta_ad_id: string; meta_campaign_id: string | null; status: string | null }>,
): string[]
```
Meta-ads mirror of `reconcileDroppedAdsetIds`. Same shape, same scope guard,
same idempotency; consumed by `syncMetaStructure` after the meta_ads upsert to
flip dropped ads to ARCHIVED. Kept pure and covered by the same test file.

### `syncMetaInsightsForLevel` — function

```ts
async function syncMetaInsightsForLevel(p: SyncParams, level: "campaign"|"adset"|"ad", startDate: string, endDate: string): Promise<{ rows: number }>
```
`GET /act_{id}/insights?level=…&time_increment=1`; upserts on `(workspace_id, meta_object_id, level, snapshot_date)`. `rows` is the count **persisted**, not attempted — the upsert goes through `upsertOrThrow` (checks `{ error }`, surfaces to the Control Tower, throws). See the false-success gotcha below.

### `syncMetaInsights` — function

```ts
async function syncMetaInsights(p: SyncParams, startDate: string, endDate: string): Promise<{ campaign: number; adset: number; ad: number }>
```
All three levels for the window. The window is **sliced into ≤14-day sub-windows
(newest-first)** and each `(sub-window × level)` is pulled + upserted independently
— so the first-run 90-day backfill never issues one heavy synchronous request
(which trips Meta's transient code 2 "Service temporarily unavailable"), and
partial progress is durable.

### `syncMetaInsightsAsync` / `syncMetaInsightsForLevelAsync` — functions

```ts
async function syncMetaInsightsAsync(p: SyncParams, startDate: string, endDate: string): Promise<{ campaign: number; adset: number; ad: number }>
async function syncMetaInsightsForLevelAsync(p: SyncParams, level: "campaign"|"adset"|"ad", startDate: string, endDate: string): Promise<{ rows: number }>
```
Meta's **async report** path for the first-run backfill window
(iteration-ingest-async-reports): `POST /act_{id}/insights` → `report_run_id` →
poll `GET /{report_run_id}` until `async_status='Job Completed'` → page
`GET /{report_run_id}/insights`. One server-side job per level over the FULL range
(no client-side ≤14-day slicing — Meta chunks it), for a years-long first backfill
that would strain even the chunked synchronous GETs. Output runs through the SAME
`mapInsightsRecords` + `upsertOrThrow` as the sync path, so idempotency and the
rows-written assertion are unchanged. Polls every 5s up to a 10-min ceiling per
level; a `Job Failed`/`Job Skipped`/timeout throws (supervisable, not a silent hang).

### `isAsyncBackfillEnabled` — function

```ts
async function isAsyncBackfillEnabled(admin, adAccountId: string): Promise<boolean>
```
Per-account gate read from `meta_ad_accounts.async_insights_backfill_enabled`
(default false). Read **defensively** — a missing column (pre-migration) or missing
row → `false`, so the code is safe to ship dark before/after the migration. Only
`ingestMetaPerformance` uses it, and only for the first-run backfill window; the
daily incremental window always keeps the light synchronous GET.

### `reconcileInsightsVsSpend` — function

```ts
async function reconcileInsightsVsSpend(p: SyncParams, startDate: string, endDate: string, tolerance?): Promise<{ daysChecked: number; drift: ReconcileDrift[] }>
```
Per-day sum of campaign-level insights spend vs [[../tables/daily_meta_ad_spend]]; flags drift > $1 AND > 2%.

### `ingestMetaPerformance` — function

```ts
async function ingestMetaPerformance(p: SyncParams, opts?: { incrementalDays?: number; backfillDays?: number }): Promise<…>
```
Full per-account ingest: structure → insights → **rows-written assertion** → reconcile. Backfills 90 days on first run (no insights rows yet), else incremental (default 3 days). On the **first-run backfill window only**, when the per-account flag `async_insights_backfill_enabled` is on (`isAsyncBackfillEnabled`), insights come via the async-report path (`syncMetaInsightsAsync`) instead of the chunked synchronous `syncMetaInsights`; the daily incremental window always uses the sync GET. The chosen path is returned as `asyncBackfill` (surfaced on the iteration-run `ingest` stage as `async_backfill`). The assertion (meta-insights-ingest-empty-fix) fails the run loud if it persisted **0** ad/adset/campaign insight rows but the independent [[../tables/daily_meta_ad_spend]] rollup proves the account spent in the window — surfaces a `META_INGEST_EMPTY` incident to the Control Tower and throws. An account with no spend → 0 rollup spend → 0 rows is correct + silent.

`SyncParams = { workspaceId, adAccountId (our uuid), metaAccountId (bare), accessToken }`.

## Callers

- `src/lib/inngest/meta-performance.ts`

## Gotchas

- Token via `getMetaUserToken(workspaceId)` in [[meta-ads]] (decrypt + workspace fallback).
- Budgets from Meta are already minor units (no ×100); spend/cpc/revenue are dollars (×100).
- `roas` is derived (`revenue/spend`), not Meta's `purchase_roas`.
- `graphGet` routes through [[meta__graph-retry]] `graphFetchJson` — transient Meta
  errors (code 1/2, `is_transient`, 429, 5xx) retry with bounded backoff; fatal
  errors (token/permission/validation) still fail fast. Combined with the chunked
  backfill, `ingestMetaPerformance` self-heals to the incremental path once any
  `meta_insights_daily` row lands (`backfilled = !count`).
- **No swallowed writes (meta-insights-ingest-empty-fix).** Every upsert goes
  through `upsertOrThrow`, which checks the Supabase `{ error }`, reports it to the
  Control Tower feed (`reportDbError`), and throws — and all sync functions return
  the count **persisted**, never `records.length`. The original regression: the old
  code ignored the upsert `{ error }` and returned rows *attempted*, so a 133s run
  that wrote 0 rows still reported `status='ok'` (the four meta_* tables went empty
  while attribution rows sat at `spend=0`). Mirror of the [[meta__scorecards]] hardening.

---

[[../README]] · [[../../CLAUDE]]
