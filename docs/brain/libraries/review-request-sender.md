# libraries/review-request-sender

The trigger-agnostic apply-path — the shared pipeline both the ticket-trigger and the post-order-trigger route through so their draft/validator/ladder/canary/nudge behaviour cannot diverge. This is the "exactly the same code" that Phase 2 of [[../specs/review-request-post-order-ask]] pins as the reuse contract.

**File:** `src/lib/review-request-sender.ts`

## Exports

### `applyReviewRequest(admin, input)`
The trigger-agnostic apply pipeline. Returns a discriminated `ApplyReviewRequestResult` naming the exact step that decided (`skipped_journey_inactive` · `skipped_ladder_dedup` · `skipped_customer_missing` · `skipped_product_missing` · `skipped_unreachable` · `skipped_no_rubric` · `blocked_by_validator` · `queued`).

**Input shape:**
```
{
  workspaceId, customerId, productId,
  angle: 'defend' | 'fence-sitter',   // the validator's unapproved_pretext set
  includeCoupon: boolean,
  context:
    | { type: 'ticket',    ticketId: string }
    | { type: 'post-order', window: 'first-time'|'repeat'|null, orderId?: string|null }
}
```

**Pipeline steps** — each step's precondition is re-asserted at write-time (guard-before-mutation, per the coaching learnings):

1. **Reachability probe** — `assertProductReviewJourneyActive(admin, workspaceId)` from [[journey-definition-probe]]. Inactive/missing ⇒ `skipped_journey_inactive`.
2. **Shared ladder dedup** — read `review_requests` for `(workspace, customer, product)`. Exists ⇒ `skipped_ladder_dedup`. This chokepoint is what makes the one-ladder invariant hold across both triggers; a race between the two detectors cannot both slip past because the write in step 9 also collides.
3. **Workspace-scoped customer + product loads** — a cross-workspace id in the input cannot leak because each read carries `.eq('workspace_id', workspaceId)`.
4. **Channel pick** — `pickReviewRequestChannel` from [[review-request-delivery]] on the customer's marketing status. Neither channel reachable ⇒ `skipped_unreachable`.
5. **Rubric load** — `getActiveReviewRubric` from [[review-message-rubric]]. Missing ⇒ `skipped_no_rubric`. The spec's "the rubric with its self-score and revise-once" reuse contract fails at THIS SDK if the rubric row is missing.
6. **Body compose** — `composeReviewRequestFirstTouchBody` from [[review-request-compose]] with the trigger label so the copy shapes differ (post-order has no thread to lean on) while the rubric, validator, and downstream pipeline stay identical.
7. **Pre-send validator** — `validateReviewRequest` from [[review-request-validator]] — the deterministic hard-block rails.
8. **Draft persist** — `saveReviewMessageDraft` from [[review-message-drafts]]. Every ask lands here even if the validator BLOCKED, so the block is auditable (`outcome='blocked_by_validator'`).
9. **Shared ladder row** — `insertReviewRequestRow` from [[review-request-delivery]] only when the validator allowed. The ladder-row angle carries the trigger prefix `post-order:<angle>` (or the raw angle for ticket) so a later analyze can split repeat/first-time asks against ticket asks without a schema change — the validator's `unapproved_pretext` rail reads `draft.angle`, not the ladder-row's label.
10. **Canary-held send** — `queueReviewRequestAsPendingTicketMessage` from [[review-request-delivery]] with `holdMs = REVIEW_REQUEST_CANARY_HOLD_MS (18h)` onto the trigger-supplied anchor ticket. Ticket trigger uses its own ticket; post-order trigger creates a portal-channel synthetic ticket via `createPostOrderAnchorTicket` — the deliver-pending-sends outbox ships either identically.

### `createPostOrderAnchorTicket(admin, { workspaceId, customerId, productTitle })`
Creates a lightweight portal-channel ticket that anchors the pending outbound review message. Subject: `Review request — <productTitle>`. Tags: `['review_request:post_order']`. The canary-digest cron links to `/dashboard/tickets/<id>`; the nudge cron looks up the customer's most recent ticket and replies into it.

## Why this module exists

Every step above pre-existed in the review-request SDKs; what did NOT exist was the ORDER + guard predicates + result discriminant. The spec's Phase-2 reuse contract is "exactly the same code" — a per-trigger inline pipeline would silently drift the first time one trigger's grader added a new rail. Centralizing the pipeline here is what makes the contract enforceable at the module boundary rather than at review time.

## Callers

- [[../inngest/post-order-review-ask-send]] — the post-order reactive handler ([[../specs/review-request-post-order-ask]] Phase 2).
- **Ticket-side Phase-2 apply-path** — future; will call `applyReviewRequest` with `context.type='ticket'` off Sol's box-session verdict.

---

[[../README]] · [[../../CLAUDE]] · [[../specs/review-request-post-order-ask]] · [[review-request-delivery]] · [[review-request-compose]]
