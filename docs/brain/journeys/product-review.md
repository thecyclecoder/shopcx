# journeys/product-review

Tokenized product-review collection — the surface a review request points at.

**Definition:** `journey_definitions` slug `product-review` (seeded by `supabase/migrations/20261215130000_seed_product_review_journey.sql`)
**Public magic link:** `src/app/review/[token]/page.tsx` + `src/app/api/review/[token]/route.ts` — **no login**
**Portal (authenticated) surface:** `src/lib/portal/handlers/review-journey.ts`
**Shared core:** `src/lib/review-journey-core.ts` — both surfaces call it, so they cannot diverge
**Owner:** [[../functions/cmo]] — "Review collection" mandate

## Flow

Sol picks a product and mints a `journey_sessions` row (token + `product_id` + `config_snapshot`). The link goes out by SMS, email, or in the ticket thread — **one session per ask, not per channel**, so a double-click can't double-issue a reward and the nudge suppresses itself once the session completes.

Landing page: product image, the same hand-picked fact the message used, then ascending effort — **5-star (one click) → sliders (four drags) → comment (typing)**. Each step is a small commitment that makes the next easier. The comment prompt is seeded from the customer's own slider answers.

Submit writes `product_reviews` (with `attribute_scores`), mints a customer-scoped reward via [[../libraries/coupons]] `createCustomerDiscount`, and:

- **rating ≥ 4** → `status='published'`
- **rating ≤ 3** → NOT published; opens a CS ticket instead. A detractor caught privately is a save opportunity.

The reward is minted **regardless of rating** — contingent-on-a-good-rating is paying for positive reviews.

## Question sets

`config.question_sets` is per-product. Default (inherited from the retired Klaviyo flow): Convenience · Effectiveness · Flavor · Overall Expectation. The `accessory` set drops Flavor — asking how a Tumbler tastes is what makes a message read as automated. `config.accessory_handles` routes tumbler/mixer/mug there.

`config_snapshot` freezes whichever set applied at session creation, so editing this definition can never corrupt an in-flight session.

## Gotchas

- **The definition row is load-bearing.** Phase 3 originally shipped the handler without it and the journey was unreachable. A `journey_definition_active_by_slug` probe now guards that ([[../libraries/spec-check-db-probes]]).
- Submit is idempotent under concurrency: a compare-and-set claim on the session fires before any side effect, so two simultaneous POSTs produce one review and one reward.
- The session is bound to the **authenticated** portal customer (and their linked accounts) — a token alone is not authorization.

## Related

[[../tables/product_reviews]] · [[../tables/review_requests]] · [[../tables/journey_sessions]] · [[../libraries/coupons]] · [[../functions/cmo]]

---

[[../README]] · [[../../CLAUDE]]

## Why there are two surfaces

The journey first shipped as a portal handler only. But `PortalAuthResult.loggedInCustomerId` is a **non-optional string** — the portal is authenticated by construction — so a security pass correctly bound the token to the logged-in customer. That was right for the portal and wrong for the product: it turned a no-login magic link into a login wall in front of a message already asking the customer for a favour. The spec asked for "tokenized magic link, no login" AND "portal handler" in the same phase; those are incompatible.

The **public** route is now the real path. **The token is the credential**: 96 stored random bits, an expiry, a single-use compare-and-set claim, and every authority (workspace, customer, product) read from the session row rather than the request. Holding a link lets you review one product as one customer, once, before it expires.

Same posture as the CSAT flow already in production (`src/app/api/csat/[ticketId]/route.ts`), and strictly stronger — CSAT's token is a deterministic HMAC of the ticket id.

The portal surface is kept for logged-in customers and retains its extra linked-account binding. Both call `review-journey-core`, so the review write, low-star routing, reward mint, and single-use claim are defined once.

## The route must be in PUBLIC_ROUTES

`/review` and `/api/review` are listed in `PUBLIC_ROUTES` (`src/lib/supabase/middleware.ts`), beside `/csat` and `/api/csat` — the same token-authorized, no-login shape.

Without that entry the middleware 307s the magic link to `/login`, which is the login wall the public route exists to remove, just one layer higher. It was caught by curling the deployed route rather than trusting the merge: `csat api → 401` (reaches the handler, refuses on token) vs `review api → 307 → /login` (never reaches the handler at all).
