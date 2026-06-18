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
`GET /act_{id}/insights?level=…&time_increment=1`; upserts on `(workspace_id, meta_object_id, level, snapshot_date)`.

### `syncMetaInsights` — function

```ts
async function syncMetaInsights(p: SyncParams, startDate: string, endDate: string): Promise<{ campaign: number; adset: number; ad: number }>
```
All three levels for the window.

### `reconcileInsightsVsSpend` — function

```ts
async function reconcileInsightsVsSpend(p: SyncParams, startDate: string, endDate: string, tolerance?): Promise<{ daysChecked: number; drift: ReconcileDrift[] }>
```
Per-day sum of campaign-level insights spend vs [[../tables/daily_meta_ad_spend]]; flags drift > $1 AND > 2%.

### `ingestMetaPerformance` — function

```ts
async function ingestMetaPerformance(p: SyncParams, opts?: { incrementalDays?: number; backfillDays?: number }): Promise<…>
```
Full per-account ingest: structure → insights → reconcile. Backfills 90 days on first run (no insights rows yet), else incremental (default 3 days).

`SyncParams = { workspaceId, adAccountId (our uuid), metaAccountId (bare), accessToken }`.

## Callers

- `src/lib/inngest/meta-performance.ts`

## Gotchas

- Token via `getMetaUserToken(workspaceId)` in [[meta-ads]] (decrypt + workspace fallback).
- Budgets from Meta are already minor units (no ×100); spend/cpc/revenue are dollars (×100).
- `roas` is derived (`revenue/spend`), not Meta's `purchase_roas`.

---

[[../README]] · [[../../CLAUDE]]
