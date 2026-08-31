# inngest/post-order-review-ask-send

Reactive Inngest handler that consumes `review/post-order.ask-due` events fired by the [[post-order-review-ask-detector-cron]] and routes each candidate through the shared apply-path in [[../libraries/review-request-sender]] — the same trigger-agnostic pipeline the ticket-side Phase-2 apply-path will call.

**File:** `src/lib/inngest/post-order-review-ask-send.ts`

**Spec:** [[../specs/review-request-post-order-ask]] Phase 2 — "Reuse the existing send path; one ladder across both triggers." The whole point of Phase 2 is `applyReviewRequest` — the ticket-trigger apply-path and the post-order-trigger apply-path both call it, so their draft/validator/ladder/canary/nudge behaviour cannot diverge.

## Functions

### `post-order-review-ask-send`
- **Trigger:** event `review/post-order.ask-due` — NOT a cron
- **Retries:** 2 · **Concurrency:** 3

Two passes per event:

1. **`apply-post-order-review-request`** — validate the payload, load the shared admin client, and hand off to `applyReviewRequest` with `context: { type: 'post-order', window, orderId }`. The shared pipeline runs:
   1. `assertProductReviewJourneyActive` — the reachable-not-just-compiled probe.
   2. Shared ladder dedup read (`review_requests` for `(workspace, customer, product)`) — the one-ladder invariant lives here so a race between the two triggers cannot both slip through.
   3. Workspace-scoped `customers` + `products` reads (guarded against cross-workspace ids).
   4. `pickReviewRequestChannel` on the customer's marketing status.
   5. `getActiveReviewRubric` — a workspace with no active rubric is a hard SKIP.
   6. `composeReviewRequestFirstTouchBody` with `trigger:'post-order'` so the copy leans on the product + the tenure fact rather than a fabricated support conversation.
   7. `validateReviewRequest` — the shared deterministic pre-send validator.
   8. `saveReviewMessageDraft` regardless of validator verdict, so a blocked draft persists with its `validator_verdict` reason list for a later grader sweep.
   9. `insertReviewRequestRow` — writes the SHARED ladder with `angle: 'post-order:<angle>'` so a later analyze can split repeat/first-time asks against ticket asks without a schema change (the validator's `unapproved_pretext` rail reads `draft.angle`, not the ladder-row's trigger-prefixed label — safe).
   10. `queueReviewRequestAsPendingTicketMessage` on a per-ask portal-channel synthetic ticket (`createPostOrderAnchorTicket`) — the deliver-pending-sends outbox drains it after the shared 18h canary hold, and [[review-request-canary-digest-cron]] surfaces every held draft to the CEO inbox before send.

2. **`emit-heartbeat`** — `emitReactiveHeartbeat("post-order-review-ask-send", { ok: true, produced: { apply: <outcome> } })` — every event handler run so the CT watchdog can see the reactive lane beating. The `apply` field carries the exact discriminated outcome (`skipped_journey_inactive`, `skipped_ladder_dedup`, `skipped_customer_missing`, `skipped_product_missing`, `skipped_unreachable`, `skipped_no_rubric`, `blocked_by_validator`, or `queued`).

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("post-order-review-ask-send")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately.

**Cadence + liveness** — pinned in [[../libraries/control-tower]] `registry.ts`: this is a REACTIVE lane so there is no cadence; `livenessWindowMs: 36 h` (1.2× a 30h daily register-cadence, with slack) is long enough to survive a genuinely idle day without alerting.

## Downstream events sent

_None._ The handler writes directly to `review_message_drafts` + `review_requests` + `tickets` + `ticket_messages` through the shared SDK.

## Related

- **Detector** — [[post-order-review-ask-detector-cron]]: Phase 1's forward-only sweep that fires the events this handler consumes.
- **Shared apply-path** — [[../libraries/review-request-sender]] `applyReviewRequest`: the trigger-agnostic pipeline both this handler and the ticket-side Phase-2 apply-path route through.
- **Shared body composer** — [[../libraries/review-request-compose]] `composeReviewRequestFirstTouchBody`: pure, trigger-aware body composition — post-order shape leans on the product + tenure; ticket shape references the resolved conversation.
- **Shared validator** — [[../libraries/review-request-validator]] `validateReviewRequest`: the deterministic pre-send rails (unfilled mustache, tenure-degenerate, wrong-product, unapproved-pretext, sentiment-conditional-coupon, SMS block-layout).
- **Shared ladder** — [[../tables/review_requests]]: the memory both triggers write and read to prevent a double-ask on the same `(workspace, customer, product)` triple.
- **Shared canary digest** — [[review-request-canary-digest-cron]]: daily CEO-inbox card summarizing every held draft, linking to `/dashboard/tickets/<anchor>` — the same anchor the post-order handler stamps.
- **Shared nudge cron** — [[review-request-nudge-cron]]: 3-4d single-nudge cadence over the shared `review_requests` ladder; reads the anchor ticket the send handler stamped.

---

[[../README]] · [[../../CLAUDE]] · [[../specs/review-request-post-order-ask]] · [[post-order-review-ask-detector-cron]]
