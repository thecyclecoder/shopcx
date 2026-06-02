# libraries/klaviyo

Klaviyo API client (reviews, profiles, events). See [[../integrations/klaviyo]].

**File:** `src/lib/klaviyo.ts`

## File header

```
Klaviyo API client — reviews sync, management, and retrieval.
Klaviyo Reviews API fields (from actual API docs):
- review_type: "review" | "question" | "rating" | "store"
- status.value: "published" | "unpublished" | "pending" | "featured" | "rejected"
- product.external_id: Shopify product ID (often null)
- relationships.item.data.id: "$shopify:::$default:::{product_id}" (reliable source)
- smart_quote: AI-extracted excerpt
- email: reviewer email (server API only)
- images: array of image URLs
```

## Exports

### `fetchKlaviyoReviews` — function

```ts
async function fetchKlaviyoReviews(workspaceId: string, options?: { sinceDate?: string },) : Promise<KlaviyoReview[]>
```

### `buildSyncUrl` — function

```ts
function buildSyncUrl(options?: { fullSync?: boolean }) : string
```

### `syncReviewPage` — function

```ts
async function syncReviewPage(workspaceId: string, pageUrl: string,) : Promise<
```

### `syncReviewsForWorkspace` — function

```ts
async function syncReviewsForWorkspace(workspaceId: string, options?: { fullSync?: boolean },) : Promise<
```

### `updateReviewStatus` — function

```ts
async function updateReviewStatus(workspaceId: string, klaviyoReviewId: string, action: "publish" | "reject" | "feature" | "unfeature", rejectionReason?: RejectionReason, rejectionExplanation?: string,) : Promise<
```

### `updateReviewType` — function

```ts
async function updateReviewType(workspaceId: string, klaviyoReviewId: string, reviewType: "review" | "store",) : Promise<
```

### `polishReviewBodies` — function

```ts
async function polishReviewBodies(workspaceId: string)
```

### `generateMissingSummaries` — function

```ts
async function generateMissingSummaries(workspaceId: string)
```

### `getReviewsForProducts` — function

```ts
async function getReviewsForProducts(workspaceId: string, productIds: string[],) : Promise<
```

### `RejectionReason` — type

## Callers

- `src/app/api/workspaces/[id]/reviews/[reviewId]/route.ts`
- `src/lib/inngest/sync-reviews.ts`
- `src/lib/remedy-selector.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
