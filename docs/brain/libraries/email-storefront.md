# libraries/email-storefront

Storefront transactional emails (order confirmation, shipping notifications).

**File:** `src/lib/email-storefront.ts`

## File header

```
Storefront transactional emails:
- sendOrderConfirmationEmail  — fires from /api/checkout after a
successful order (separate from packing slip, which is printed
by Amplifier; this is the inbox copy)
- sendShippingNotificationEmail — fires from the Amplifier
order.shipped webhook once the warehouse hands the package to
the carrier and we have a tracking number
Both are best-effort: failure logs but never blocks the calling
pipeline (order creation succeeds even if the inbox email fails;
the customer can always read it on the dashboard).
```

## Exports

### `sendOrderConfirmationEmail` — function

```ts
async function sendOrderConfirmationEmail(opts: { workspaceId: string; order: OrderForEmail; isFirstOrder: boolean; subscribing: boolean; nextBillingDate?: string | null; /** Personal note from the founder — same message that prints on the * packing slip. Wraps in a styled blockquote with attribution. */ founderNote?: string | null; /** What the customer WOULD have paid for shipping had they checked * out as a one-time shopper. Used for the strikethrough → Free * treatment on subscribing orders. When omitted we don't show a * strikethrough. */ shippingValueCents?: number | null; }) : Promise<{ success: boolean; error?: string; resendEmailId?: string }>
```

**Return shape (Phase 3 of [[../specs/shopify-order-confirmation-emails]]).** On success returns `{ success: true, resendEmailId: <Resend id> }`. The Phase-4 queued sender stamps [[../tables/orders]] `order_confirmation_email_id` + `order_confirmation_sent_at` from `resendEmailId`, which doubles as the dedupe key. Also lets `/api/webhooks/resend-events` join delivered/opened back to the order via [[../tables/email_events]] `order_id`.

### `sendShippingNotificationEmail` — function

```ts
async function sendShippingNotificationEmail(opts: { workspaceId: string; order: OrderForEmail; }) : Promise<
```

### `sendAbandonedCartEmail` — function

```ts
async function sendAbandonedCartEmail(opts: { workspaceId: string; to: string; firstName?: string | null; cartToken: string; lineItems: AbandonedCartLine[]; subtotalCents: number; storefrontDomain: string | null; }) : Promise<
```

## Callers

- `src/lib/inngest/abandoned-cart.ts`

### `uuidLineItemProductIds` — function

```ts
export function uuidLineItemProductIds(ids: ReadonlyArray<string | null | undefined>): string[]
```

UUID-shape guard for the featured-review query. Both `sendOrderConfirmationEmail` and `sendShippingNotificationEmail` render a social-proof review sourced by `.in('product_id', productIds)` against `product_reviews`. Some line items carry a Shopify NUMERIC product id in `product_id` rather than the internal UUID — Shipping Protection is the confirmed case (its `product_id` is the Shopify id `7634377900205`; the row's real internal UUID lives at `products.shopify_product_id`). A single non-UUID value makes Postgres raise `22P02 invalid input syntax for type uuid` and errors the WHOLE query, silently dropping the review block for every valid product in the same order. This helper strips non-UUID ids before they reach the filter; it is applied at both build sites AND as defense-in-depth inside `pickFeaturedReview`. Same join-discipline invariant as the fraud order_ids / customer-fraud-status fixes: never mix Shopify ids into a UUID column filter.

**Standard guard for ANY `products.id` UUID-column `.in()` filter — not just the review-block path.** The same 22P02 class recurs anywhere a productIds array reaches an `.in("id", …)` (or `.in("product_id", …)`) against a UUID column and any element of that array was derived from a line-item / cart-draft / anywhere Shopify-numeric ids can leak in. Wrap the array through `uuidLineItemProductIds` immediately before the `.in(...)` call. Current call sites: `src/lib/cart-recovery.ts` (products + product_reviews), `src/lib/customer-timeline.ts` (variant → product title lookup), `src/lib/portal/handlers/resources.ts` (owned-resources for a customer), `src/lib/social/featured-review-cards.ts` (product-title resolver for card gen), `src/lib/media-buyer/director-digest.ts` (`resolveProductTitlesForWorkspace` — guard is inside the helper so every future caller inherits it), `src/app/api/storefront/[workspace]/featured-reviews/route.ts`, `src/app/api/workspaces/[id]/storefront-funnel/route.ts` (predicted-LTV cohorts + campaign-grades title lookup), `src/app/api/workspaces/[id]/analytics/roas/route.ts`.

### `isReviewableProduct` — function

```ts
export function isReviewableProduct(product: { product_type?: string | null; handle?: string | null }): boolean
```

Identity-based exclusion of non-reviewable add-on / system products from the featured-review sourcing set. Shipping Protection is the confirmed case (`product_type` = `ShopWill`, `handle` = `shipping-insurance` on the workspace's `ee261540…` product) — it will never carry customer reviews and must never source the social-proof block. Applied inside `pickFeaturedReview` after the UUID guard: the picker resolves candidate ids against `public.products` and drops any row that fails `isReviewableProduct` before hitting `product_reviews`. This is the SEMANTIC guard behind the [[../../tables/product_reviews]] block: the UUID shape guard (above) excludes Shipping Protection today only as a side-effect of its line-item id being Shopify-numeric — if an add-on ever carried a valid product UUID, only this identity check would keep it out of review sourcing. Add new add-on markers to `NON_REVIEWABLE_PRODUCT_TYPES` / `NON_REVIEWABLE_PRODUCT_HANDLES` in the file, not as ad-hoc checks at call sites.

## Gotchas

- **Non-UUID line-item `product_id` poisons the featured-review query.** `product_reviews.product_id` is a UUID column; a Shopify-numeric id (Shipping Protection = `7634377900205`) in the `.in(...)` array 22P02s the entire query. `uuidLineItemProductIds` is the guard — always run it before calling `pickFeaturedReview`, and it's also applied inside the picker for defense-in-depth.
- **Non-reviewable add-ons are excluded from the featured review by identity, not UUID accident.** Shipping Protection (`product_type` `ShopWill` / `handle` `shipping-insurance`) is dropped by `isReviewableProduct` inside `pickFeaturedReview` after the UUID guard, so an add-on that ever carried a valid product UUID cannot slip back into review sourcing. Register a new add-on / system product by adding its `product_type` or `handle` to the sets in `email-storefront.ts` — don't hand-roll the check at a new call site.
- **`cart_drafts.line_items[].product_id` is untyped JSONB — the UUID guard is mandatory in `cart-recovery`.** The abandoned-cart pipeline reads `line_items` from a JSONB column and feeds each element's `product_id` into `.in("id", productIds)` against `public.products` AND `.in("product_id", productIds)` against `public.product_reviews`. Both are UUID columns, so a Shopify-numeric leak 22P02s the whole query and drops the entire recovery email's product-title lookup + featured-review context. Run `uuidLineItemProductIds` on the deduped productIds before either call — the guard covers both `.in()` calls at the same site.

---

[[../README]] · [[../../CLAUDE]]
