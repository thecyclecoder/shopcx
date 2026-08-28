# journeys/product-review

Tokenized product-review collection — the surface a review request points at.

**Definition:** `journey_definitions` slug `product-review` (seeded by `supabase/migrations/20261215130000_seed_product_review_journey.sql`)
**Handler:** `src/lib/portal/handlers/review-journey.ts`
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
