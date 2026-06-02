# libraries/storefront-pixel

Browser pixel client lib (track, identify, batching, sendBeacon on unload).

**File:** `src/lib/storefront-pixel.ts`

## Exports

### `initPixel` — function

```ts
function initPixel(opts: { workspaceId: string; customerId?: string | null })
```

### `track` — function

```ts
function track(eventType: string, meta?: EventMeta)
```

### `identify` — function

```ts
function identify(id: string)
```

### `getAnonymousId` — function

```ts
function getAnonymousId() : string | null
```

## Callers

- `src/app/(storefront)/_components/StorefrontPixelInit.tsx`
- `src/app/(storefront)/checkout/_components/CheckoutClient.tsx`
- `src/app/(storefront)/customize/_components/CustomizeClient.tsx`
- `src/app/(storefront)/thank-you/_components/ThankYouClient.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
