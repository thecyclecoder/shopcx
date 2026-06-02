# libraries/easypost

SDK wrapper, address validation, rate selection (USPS-pinned). See [[../integrations/easypost]].

**File:** `src/lib/easypost.ts`

## File header

```
EasyPost return label integration — rate quotes, label purchase, tracking
```

## Exports

### `getEasyPostClient` — function

```ts
async function getEasyPostClient(workspaceId: string, mode?: "test" | "live",) : Promise<InstanceType<typeof EasyPostClient>>
```

### `isTestMode` — function

```ts
async function isTestMode(workspaceId: string) : Promise<boolean>
```

### `getActualShippingCost` — function

```ts
async function getActualShippingCost(workspaceId: string, shipmentId: string,) : Promise<
```

### `getReturnShippingRate` — function

```ts
async function getReturnShippingRate(workspaceId: string, params: ReturnShippingRateParams,) : Promise<ReturnShippingRate>
```

### `purchaseReturnLabel` — function

```ts
async function purchaseReturnLabel(workspaceId: string, shipmentId: string, rateId?: string,) : Promise<PurchasedLabel>
```

### `getTrackingStatus` — function

```ts
async function getTrackingStatus(workspaceId: string, shipmentId: string,) : Promise<TrackingStatus>
```

### `verifyAddress` — function

```ts
async function verifyAddress(workspaceId: string, address: { name?: string; street1: string; street2?: string; city: string; state: string; zip: string; country: string; phone?: string; },) : Promise<AddressVerificationResult>
```

### `lookupTracking` — function

```ts
async function lookupTracking(workspaceId: string, trackingNumber: string, carrier?: string,) : Promise<TrackingStatus>
```

### `ReturnShippingRateParams` — interface

### `ReturnShippingRate` — interface

### `PurchasedLabel` — interface

### `TrackingStatus` — interface

### `AddressVerificationResult` — interface

## Callers

- `src/app/api/workspaces/[id]/replacements/verify-address/route.ts`
- `src/app/api/workspaces/[id]/returns/create-label/route.ts`
- `src/app/api/workspaces/[id]/returns/rate-quote/route.ts`
- `src/app/api/workspaces/[id]/returns/test-connection/route.ts`
- `src/lib/easypost-order-sync.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
