# inngest/post-order-review-ask-detector-cron

Hourly cron that finds first-purchase-of-a-reviewable-product events, applies the shared ladder skip predicates, and fires one `review/post-order.ask-due` Inngest event per candidate that Phase 2 will consume through the shared draft/validate/send path. Phase 1 of the review-request-post-order-ask program.

**File:** `src/lib/inngest/post-order-review-ask-detector-cron.ts`

**Spec:** [[../specs/review-request-post-order-ask]] — the ticket cohort reaches only ~340 customers a month (people who write in); this is the path to the other ~1,500 who never do. August-2026 estimate: 1,889 candidate asks, 377 already reviewed, leaving ~1,500 (1,793 repeat-buyer + 96 first-time).

## Functions

### `post-order-review-ask-detector-cron`
- **Trigger:** cron `0 * * * *` (hourly) — NOT an Inngest event
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`enqueue-post-order-asks`** — read the sliding window of eligible orders + resolve the products through the shopify_product_id join + apply the pure predicates + fan out one `review/post-order.ask-due` Inngest event per surviving candidate.

   - **Sliding window on ORDER DATE.** `orders.created_at` between `now - (POST_ORDER_LOOKBACK_DAYS = 22d)` and `now - (POST_ORDER_LOOKAHEAD_FLOOR_DAYS = 9d)` — the exact strip where a 10d-repeat or a 21d-first-time candidate can become due on this tick. Bound the read to `POST_ORDER_READ_CAP * 4` for the raw row set; the pure selector cap trims to `POST_ORDER_READ_CAP = 200` per tick.
   - **⚠️ The join. `products.shopify_product_id`, NEVER a uuid cast.** `orders.line_items[].product_id` is the SHOPIFY product id (a numeric string), not our internal uuid. A query that casts it to uuid and joins `products.id` silently matches nothing — a detector built that way would enqueue zero asks while looking healthy. The spec's ⚠️ warning pins this; the pure test suite ([[./post-order-review-ask-detector-cron.selection.test]]) covers the classifier / reachability / dedup invariants that flow off the resolved uuid.
   - **Reviewable-only.** The products read filters `reviewable = true` — Shipping Protection, Mystery Item, and free-gift SKUs never reach downstream regardless of what surfaced in the line-item read (`isReviewableProduct` in [[../libraries/email-storefront]] applies the identity guard on the same rail).
   - **⚠️ Forward-only — no historical backfill.** Line-item `product_id` coverage was 6-13% through June 2026 and only jumped to 94-95% in July, so an older-orders sweep would attribute confidently for a minority and silently miss the majority. The 22-day floor keeps every read inside the covered-coverage era.
   - **Per-product first-time detection.** For each candidate the cron reads all orders with `created_at < earliestAnchor` for the candidate customer set (ONE read, in-memory grouping) and asks: does this customer's prior-orders bag contain the candidate's `shopify_product_id`? If NO ⇒ first-time (21d window); if YES ⇒ repeat (10d window). The split is PER PRODUCT, not per customer — a customer on their twelfth Superfood Tabs order who just tried Creatine Prime+ is a first-timer for Creatine.
   - **Skip predicates (same as the ticket path):**
     - `askedKeys` — a `review_requests` row exists for `(workspace, customer, product)`. Both triggers write here so neither can double-ask the same customer about the same product. Counted under `skipped_already_asked`.
     - `reviewedKeys` — a `product_reviews` row exists for `(workspace, customer, product)`. Counted under `skipped_already_reviewed`.
     - `marketingByCustomer` reachability — the spec's "SMS-subscribed → SMS, otherwise email, never to an explicit unsubscribe" rule. `sms_marketing_status='subscribed' OR email_marketing_status != 'unsubscribed'`; neither channel reachable ⇒ counted under `skipped_unreachable`.
     - Window classifier — a candidate whose per-product window has not yet elapsed is counted under `skipped_not_due` and will pick up on a later tick.
     - Within-tick de-dupe on `(customer, product)` — a customer with two orders of the same product inside the sliding window enqueues ONE ask; the earliest anchor date wins.
   - **Fan-out.** ONE `review/post-order.ask-due` event per surviving candidate carrying `{ workspace_id, customer_id, product_id, shopify_product_id, order_id, order_created_at, window }`. Phase 2 wires the handler that drafts, validates, and sends through the shared review-ask path (`insertReviewRequestRow` + the canary-held pending ticket_message queue). No handler yet ⇒ Inngest logs and drops the event; Phase 1's contract is the detector + join + control-tower registration only.

2. **`emit-heartbeat`** — `emitCronHeartbeat("post-order-review-ask-detector-cron", { ok: true, produced: { candidates, eligible, enqueued, deferred, skipped_already_asked, skipped_already_reviewed, skipped_unreachable, skipped_not_due, skipped_no_shopify_id } })` — every tick (idle or not) so the CT watchdog sees a beat and can distinguish a genuinely-idle tick from an Inngest schedule that has gone dark.

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("post-order-review-ask-detector-cron")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately; the CT tile renders AMBER `off by <ancestor>` instead of RED "no beats".

**Cadence + liveness** — pinned in [[../libraries/control-tower]] `registry.ts`: `expectedCadence: "every hour (0 * * * *)"`, `livenessWindowMs: 90 min` (≥ 1.2× the 60m cadence per `assertRegistryInvariants`). `registeredAt: "2026-08-31T00:00:00Z"` graces the first-tick window (newcron-grace).

## Downstream events sent

- **`review/post-order.ask-due`** — Phase 2 wires the handler. Payload: `{ workspace_id, customer_id, product_id, shopify_product_id, order_id, order_created_at, window: 'first-time' | 'repeat' }`.

## Related

- **Sibling detector (ticket cohort)** — [[review-candidacy-detector-cron]]: same shape, different trigger (a ticket quiet for 24h since we spoke last), same downstream ladder. Both must write to `review_requests` so neither can double-ask.
- **Ladder** — [[../tables/review_requests]] carries the ask's memory keyed on `(workspace, customer, product)`. Both triggers write here; both read it as a skip predicate.
- **Reviewability guard** — `products.reviewable = true` filter matches the same identity-based `isReviewableProduct` guard in [[../libraries/email-storefront]] that keeps Shipping Protection out of the order-confirmation review block.
- **Node registry** — [[../libraries/control-tower-node-registry]]: owner `cmo` (Iris's review-collection mandate).

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_requests]] · [[review-candidacy-detector-cron]]
