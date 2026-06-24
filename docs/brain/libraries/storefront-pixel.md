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

### `setExperimentAssignments` — function

```ts
function setExperimentAssignments(assignments: { experiment_id, variant_id, arm, surface }[])
```
Registers the server-resolved experiment arm(s) for the page so EVERY `/api/pixel` flush carries them (a top-level `experiment_assignments` field, alongside `events` + `session_context`). The pixel route merges these into [[../tables/storefront_sessions]]`.experiment_assignments` — the **canonical** attribution signal, decoupled from whether the `experiment_exposure` event survives ([[../lifecycles/storefront-session-attribution]] § 4). Call once per page in `StorefrontPixelInit` BEFORE the first `track()`. The edge-served PDP arm is read server-side from the `sx_variant` cookie, so it isn't passed here.

## Callers

- `src/app/(storefront)/_components/StorefrontPixelInit.tsx`
- `src/app/(storefront)/checkout/_components/CheckoutClient.tsx`
- `src/app/(storefront)/customize/_components/CustomizeClient.tsx`
- `src/app/(storefront)/thank-you/_components/ThankYouClient.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
