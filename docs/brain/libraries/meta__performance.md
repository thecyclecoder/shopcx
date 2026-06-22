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

### `reconcileInsightsVsSpend` — function

```ts
async function reconcileInsightsVsSpend(p: SyncParams, startDate: string, endDate: string, tolerance?): Promise<{ daysChecked: number; drift: ReconcileDrift[] }>
```
Per-day sum of campaign-level insights spend vs [[../tables/daily_meta_ad_spend]]; flags drift > $1 AND > 2%.

### `ingestMetaPerformance` — function

```ts
async function ingestMetaPerformance(p: SyncParams, opts?: { incrementalDays?: number; backfillDays?: number }): Promise<…>
```
Full per-account ingest: structure → insights → **rows-written assertion** → reconcile. Backfills 90 days on first run (no insights rows yet), else incremental (default 3 days). The assertion (meta-insights-ingest-empty-fix) fails the run loud if it persisted **0** ad/adset/campaign insight rows but the independent [[../tables/daily_meta_ad_spend]] rollup proves the account spent in the window — surfaces a `META_INGEST_EMPTY` incident to the Control Tower and throws. An account with no spend → 0 rollup spend → 0 rows is correct + silent.

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
