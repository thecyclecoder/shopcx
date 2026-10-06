# libraries/billing-forecast

Event writes to [[../tables/billing_forecast_events]]. Materialized rollup into [[../tables/billing_forecasts]].

**File:** `src/lib/billing-forecast.ts`

## File header

```
Billing forecast: one pending row per subscription
Event-driven updates from Appstle webhooks ONLY (all mutations go through Appstle → webhook)
```

## Exports

### `calculateExpectedRevenue` — function

```ts
function calculateExpectedRevenue(items: ForecastItem[]) : number
```

### `logForecastEvent` — function

```ts
async function logForecastEvent(params: { workspaceId: string; forecastId: string; contractId: string; forecastDate: string; // YYYY-MM-DD eventType: string; deltaCents: number; description?: string; })
```

### `getPendingForecast` — function

```ts
async function getPendingForecast(workspaceId: string, contractId: string)
```

### `createForecast` — function

```ts
async function createForecast(params: { workspaceId: string; contractId: string; subscriptionId?: string | null; customerId?: string | null; expectedDate: string; items: ForecastItem[]; billingInterval?: string | null; billingIntervalCount?: number | null; createdFrom: string; source?: string; forecastType?: string; // renewal, dunning, paused })
```

### `forecastCollected` — function

```ts
async function forecastCollected(params: { workspaceId: string; contractId: string; actualRevenueCents: number; orderId?: string | null; orderNumber?: string | null; billingAttemptId?: string | null; nextBillingDate?: string | null; items?: ForecastItem[]; billingInterval?: string | null; billingIntervalCount?: number | null; source?: string; })
```

### `forecastFailed` — function

```ts
async function forecastFailed(params: { workspaceId: string; contractId: string; failureReason?: string | null; billingAttemptId?: string | null; })
```

### `forecastCancelled` — function

```ts
async function forecastCancelled(workspaceId: string, contractId: string)
```

### `forecastPaused` — function

```ts
async function forecastPaused(workspaceId: string, contractId: string)
```

### `forecastDateChanged` — function

```ts
async function forecastDateChanged(workspaceId: string, contractId: string, newDate: string)
```

### `forecastItemsChanged` — function

```ts
async function forecastItemsChanged(workspaceId: string, contractId: string, items: ForecastItem[], nextBillingDate?: string | null)
```

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`

## Gotchas

### Concurrent-webhook race on `createForecast` — caught at DB level

`createForecast` intentionally handles concurrent inserts for the same `(workspace_id, shopify_contract_id)` pair via the `idx_billing_forecasts_pending` partial unique index on `(workspace_id, shopify_contract_id)` WHERE `status='pending'`.

When two Appstle webhooks fire concurrently for the same subscription renewal:
1. Both read `getPendingForecast` and see no pending row (no existing forecast).
2. Both attempt to INSERT a new pending row.
3. The first INSERT succeeds; the second hits a 23505 constraint violation on `idx_billing_forecasts_pending`.
4. The app catches `error.code === '23505'` with message containing `idx_billing_forecasts_pending`, re-reads the winning row, and applies the same UPDATE branch (expected_date, expected_revenue_cents, expected_items, billing_interval, billing_interval_count, updated_at) to converge on one canonical pending row. Returns the winner's id.

**Capture:** The 23505 is expected by design and dropped from error-feed logging via `isExpectedBillingForecastsPendingUniqViolation(message, query)` in [[control-tower]] — the Postgres error is flagged at the `postgres` LogQuery mapRow in `supabase-log-poll.ts` before signature generation, so healthy concurrent-webhook races do not page Platform.

**Scope:** The filter is narrowly gated to INSERT-only (COPY replay, UPDATE ... ON CONFLICT hitting the same index still surface) and this constraint only (23505 on a different unique index still pages).

---

[[../README]] · [[../../CLAUDE]]
