# Product Review

Product-specific review collection: 5-star rating, per-product slider questions (attribute_scores), and a seeded comment. Database row in [[../tables/journey_definitions]]: `slug='product-review'`, `journey_type='review'`, `trigger_intent='product_review'`.

See [[../lifecycles/review-collection]] for end-to-end tracing.

## Trigger

- **trigger_intent**: `product_review`
- **match_patterns** (from DB): empty `[]` (review requests are prepended via the ladder, not auto-triggered from pattern matching)
- **priority**: 0 (normal)

The review request ladder enqueues review-ask Inngest functions that call `launchJourneyForTicket` with explicit `journey_slug='product-review'`.

## Channels

`email`, `sms`. (Not `social_comments` — never.)

## Steps

Built live by `src/lib/portal/handlers/review-journey.ts`. Sequence:

1. **Product context** — product image (from `products.image_url`) and the fact the notification used, so the page reads as continuous.

2. **5-star rating** — single click. Lowest friction first.

3. **Slider questions** — 3-4 per-product sliders depending on product type:
   - **Convenience** (Not Convenient · Very Convenient) — always shown
   - **Effectiveness** (Not Effective · Very Effective) — always shown
   - **Flavor** (I Don't Like It · I Love It) — **skipped for accessories** (Tumbler, Mixer, Mug) because meaningless for non-consumables. Matched by `product_type=accessory` or `product_type=merch` or title patterns.
   - **Overall Expectation** — choice field: "Did Not Meet", "What I Expected", "Exceeded Expectations" — always shown

4. **Seeded comment** — text area with a prompt auto-generated from the customer's slider answers:
   - High effectiveness (≥4) + high flavor (≥4) → "You said it works well and you love the taste — what would you tell someone who's on the fence?"
   - High effectiveness + high convenience → "You said it works well and is easy to use — what would you tell a friend trying it for the first time?"
   - Expectation exceeded → "You said [product] exceeded your expectations — what surprised you most?"
   - Low effectiveness (≤2) or expectation not met → "What didn't work about [product]? Anything specific we could improve?"
   - Fallback → "Tell someone else what your experience with [product] was like."
   - **Comment floor:** ≥15 characters. Star-only reviews do not render in the widget (filtered at `src/app/api/storefront/[workspace]/product-reviews/route.ts`).

## Submit

On POST to `/api/portal/review-journey`:

1. **Atomic claim** — workspace-scoped compare-and-set from `['pending', 'in_progress']` → `'processing'` on the session row. Prevents concurrent duplicate-review / duplicate-coupon attacks. Returns 409 if already processing or completed.

2. **Review insertion** — write [[../tables/product_reviews]] row with:
   - `rating`, `body` (comment), `attribute_scores` (slider answers as jsonb), `verified_purchase=true`, `review_type='review'`
   - Status determined by rating: `'published'` if ≥4 stars, `'pending'` if ≤3 stars

3. **Low-star routing** — if rating ≤3, open a CS ticket with:
   - `subject: "Low-star review: [product_title]"`, `channel='portal'`, `tags: ['review:low_star']`
   - Internal message carries the review body + attribute_scores for moderator context
   - (Note: `review_requests.ticket_id` is stamped by the **send** side of the ladder, not the submit handler)

4. **Reward coupon** — mint a customer-scoped Shopify discount via `createCustomerDiscount()` (the shared [[../libraries/coupons]] chokepoint):
   - Amount: $5 fixed
   - Code prefix: `REVIEW`
   - Expiry: 90 days
   - Title: `"Review reward — [product_title]"`
   - Falls back to internal `mintCustomerCoupon` for customers with no `shopify_customer_id`
   - **Reward is minted REGARDLESS of rating** — a low rating does not forfeit the incentive (contingent-on-good-rating would be paying for positive reviews)

5. **Session completion** — compare-and-set from `'processing'` → `'completed'` with:
   - `outcome: 'review_published'` if ≥4 stars, else `'review_routed_to_cs'`
   - `responses: { rating, attribute_scores, comment }` serialized for analytics

## Authorization

- Tokenized session via bearer token (query param `?token=`)
- Session is bound to the authenticated portal customer **before any GET returns product data or any POST fires a side effect**. Rejects 403 if `auth.loggedInCustomerId` does not resolve to a customer in the session's linked-account group (Phase 2 of [[../specs/review-collection-foundations]])
- Product lookup is workspace-scoped so a cross-workspace SKU cannot be smuggled in
- Session lookup is workspace-scoped
- `products.reviewable=true` checked after load so a race (session created before an add-on was flipped) still refuses

## Outcomes

| Tag | When |
|---|---|
| `j:review` | Always |
| `jo:positive` | Customer submitted ≥4 stars |
| `jo:negative` | Customer submitted ≤3 stars (routed to CS) |

## Step ticket status

`open` — ticket stays open for moderator review. (Not used for ≥4 star submissions.)

## Config snapshot

The `journey_sessions.config_snapshot` freezes the per-product question set at session creation so editing `journey_definitions.config` can't corrupt an in-flight form. Defaults to `DEFAULT_QUESTIONS` unless overridden per-product in the journey definition config.

## Files

| File | Purpose |
|---|---|
| `src/lib/portal/handlers/review-journey.ts` | Portal handler — GET returns form config, POST submits + claims + routes to CS / mints coupon |
| `src/lib/coupons.ts` | `createCustomerDiscount()` chokepoint used to mint review rewards |
| `src/lib/portal/handlers/index.ts` | Exports `reviewJourney` |

## Related

[[../README]] · [[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/product_reviews]] · [[../tables/review_requests]] · [[../libraries/portal__handlers__review-journey]] · [[../libraries/coupons]]
