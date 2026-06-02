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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
