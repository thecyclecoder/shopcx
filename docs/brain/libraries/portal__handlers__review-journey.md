# libraries/portal__handlers__review-journey

Portal handler for the product-review journey — product-specific review collection with slider questions, seeded comments, and reward coupons. Phase 3 of [[../specs/review-collection-foundations]].

**File:** `src/lib/portal/handlers/review-journey.ts`

## Exports

### `reviewJourney` — RouteHandler

```ts
const reviewJourney: RouteHandler = async ({ auth, route, req, url }) => Promise<Response>
```

Handles GET and POST requests to `/api/portal/review-journey?token=…`.

## Behavior

### GET

Returns form config for a tokenized review session:

```json
{
  "ok": true,
  "route": "review-journey",
  "session_id": "uuid",
  "product": {
    "id": "uuid",
    "title": "string",
    "image_url": "string | null"
  },
  "questions": [
    {
      "key": "string",
      "label": "string",
      "low": "string",
      "high": "string",
      "type": "slider" | "choice",
      "choices": "string[] | undefined"
    }
  ],
  "min_comment_length": 15
}
```

- **Session lookup:** workspace-scoped by token. Rejects 404 if not found.
- **Authorization:** Binds session to authenticated customer's linked-account group (Phase 2 fix). Rejects 403 if `auth.loggedInCustomerId` not in session's customer's linked peers.
- **Product context:** Loads product from `products` table (workspace-scoped). Rejects 404 if not found, 409 if `reviewable=false`.
- **Question set:** Filters `DEFAULT_QUESTIONS` to drop Flavor for accessories (matched by `product_type=accessory | merch` or title patterns like "tumbler", "mixer", "mug"). Uses frozen set from `config_snapshot` if present.

### POST

Submits review + claims session + opens CS ticket if low-star + mints reward:

```json
{
  "ok": true,
  "route": "review-journey",
  "review_id": "uuid",
  "published": true | false,
  "ticket_id": "uuid | null",
  "reward_code": "string | null",
  "reward_source": "shopify" | "internal" | null
}
```

#### Validation

- Requires `rating` (1-5 integer), `comment` (≥15 chars), `attribute_scores` (object, optional)
- Returns 400 if invalid rating or comment too short

#### Session claim (Phase 1 fix — idempotency guard)

Atomic compare-and-set: updates session from `['pending', 'in_progress']` → `'processing'` scoped to workspace + customer linked-account group. Returns 409 if already processing or completed. Prevents duplicate review / duplicate coupon on concurrent POSTs.

#### Review insertion

Inserts `product_reviews` row:
- `status = 'published'` if `rating ≥ 4`, else `'pending'` (low-star routed to CS instead)
- Includes `attribute_scores` (slider answers) + `verified_purchase=true` + `review_type='review'`
- Returns 500 if insert fails

#### Low-star routing (rating ≤ 3)

Opens a CS ticket with:
- `subject: "Low-star review: [product_title]"`
- `channel='portal'`, `tags=['review:low_star']`
- Internal message carries body + attribute_scores for moderator context
- `review_requests.ticket_id` is stamped by the **send** side of the ladder, not here

#### Reward minting

Calls `createCustomerDiscount()` with:
- `amount: 5` (dollars)
- `codePrefix: 'REVIEW'`
- `expiryDays: 90`
- `title: "Review reward — [product_title]"`

**Always mints, regardless of rating** (Low rating ≠ forfeited incentive). Falls back to internal `mintCustomerCoupon` if customer has no `shopify_customer_id`.

#### Session completion

Compare-and-set from `'processing'` → `'completed'` with:
- `outcome = 'review_published'` if `rating ≥ 4`, else `'review_routed_to_cs'`
- `responses = { rating, attribute_scores, comment }` for analytics

Completes even if reward mint fails (reviews are not lost). Frontend receives null code on reward failure and falls back to "we'll email your reward" message.

## Authorization (Phase 2 fix)

Before any GET response or POST side effect:

1. Verify `auth.loggedInCustomerId` is set (else 401)
2. Resolve it to internal customer + linked-account group via `linkedCustomerIdsFor()`
3. Load session scoped to workspace + token
4. Verify session's `customer_id` is in the linked set (else 403)
5. Load product scoped to workspace + `product_id` (else 404)
6. Verify `reviewable=true` (else 409)

The compare-and-set claim also pins to the linked-account group as defense-in-depth.

## Gotchas

- **Flavor skipped for non-consumables** — matched by `product_type` or title patterns (NON_FLAVOR_TITLE_PATTERNS). Editorial oversight in the question set survives session freeze.
- **Comment is required** — ≥15 chars. Star-only reviews silently fail to render (filtered in `src/app/api/storefront/[workspace]/product-reviews/route.ts`).
- **Status determined by rating alone** — no moderation override. ≤3 stars → pending (routed to CS), ≥4 → published. The moderation rule treats low-star as support signal, not display material.
- **Reward minted regardless** — contingent-on-good-rating would be paying for positive reviews. Incentive is unconditional.
- **Concurrent POST idempotency** — guard via session claim compare-and-set. Two concurrent POSTs with the same token will conflict on the claim; one succeeds, one gets 409.

## Related

[[../journeys/product-review]] · [[../tables/product_reviews]] · [[../tables/journey_sessions]] · [[../libraries/coupons]] · [[../specs/review-collection-foundations]]
