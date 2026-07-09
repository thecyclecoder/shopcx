# required-outcomes-validator

`src/lib/required-outcomes-validator.ts` — Phase 1 of [[../specs/secure-sol-required-outcomes-dispatch]]. Runs **before** [[honor-required-outcomes]] dispatch and fails closed on any customer-influenced [[../tables/ticket_required_outcomes]] item that (a) names a disallowed action kind, (b) omits the target ids the kind requires, or (c) points at a `subscriptions` / `orders` / `products` row that doesn't belong to the ticket's `(workspace_id, customer_id)` scope. A prompt-injected item pointing at another customer's `contract_id` — the exact vulnerability [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] left open — is rejected here before the shared `directActionHandlers` dispatch is ever reached.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `ALLOWED_OUTCOME_KINDS` | `ReadonlySet<string>` | Static allowlist of the required-outcome kinds Sol may enqueue. Grouped by shape: subscription-scoped (`cancel`, `pause`, `resume`, `apply_coupon`, `swap_variant`, …), order-scoped (`partial_refund`, `create_return`, `create_replacement`, …), customer-scoped (`unsubscribe_*`), plus the Judy-canonical `add_bag_to_next_order`. A grep answers "what can Sol dispatch?" — no config table sleight-of-hand. |
| `requiredTargetIdsFor(kind)` | pure | Which target-id fields (`needs_contract`, `needs_order`, `needs_product`) an allowed kind requires. |
| `validateRequiredOutcomes(ctx)` | wire-in | The Phase-1 gate — walks items, checks allowlist, re-reads each target by `(workspace_id, customer_id)` via `.maybeSingle()`, returns `{ok:true}` when everything passes or `{ok:false, blocked[], reason}` when ANY item is disallowed. One bad item blocks the whole send. |

## Verdict shape

Every blocked item carries a typed `reason`:

- `unknown_kind` — kind not in `ALLOWED_OUTCOME_KINDS`.
- `missing_target_ids` — kind needs a `contract_id` / order-id but the item didn't emit one.
- `subscription_not_found` — target contract not present in `workspace_id`.
- `subscription_customer_mismatch` — target sub belongs to a different customer (the injection vector).
- `order_not_found` / `order_customer_mismatch` — same, for order-backed kinds.
- `product_not_found` — target product not present in `workspace_id`.

The caller (`scripts/builder-worker.ts` → `runTicketHandleJob`) treats any blocked verdict as *mark the job needs_attention / log_tail and skip the customer-facing send*. The [[../tables/ticket_directions]] row stays durable; a human re-drafts via the Improve tab.

## Callers

- **Sol's box session** (`scripts/builder-worker.ts` → `runTicketHandleJob`) — runs the validator right after [[ticket-required-outcomes]] `writeRequiredOutcomes` and before [[honor-required-outcomes]] `honorRequiredOutcomes`. A validator block also short-circuits the honor step (no dispatch attempted).

## Related

- [[honor-required-outcomes]] — the dispatch step this validator gates.
- [[ticket-required-outcomes]] — the SDK that stores the rows the validator scans.
- [[sol-outcome-claim-guard]] — the Phase-3 send guard that catches an unbacked CLAIM in the final reply text.
- [[outcome-completion-gate]] — the Phase-4 gate that keeps the ticket in-progress until every outcome verifies.
- [[../tables/subscriptions]] · [[../tables/orders]] · [[../tables/products]] — the ownership tables the validator re-reads.

## Invariants

- **The allowlist is the security boundary.** Adding a kind means auditing whether the handler in [[action-executor]] `directActionHandlers` (a) honors `ActionContext.customerId` when it mutates and (b) has a `verifyActionInDB` case. A kind without both is not safe to allow through Sol's model-authored JSON.
- **Re-reads use `.maybeSingle()`, not `.single()`.** A cross-customer or cross-workspace target legitimately returns zero rows — `.single()` would throw `PGRST116` which the caller would treat as a validator error (also blocking, but with a noisier signal). `.maybeSingle()` lands the miss as `subscription_not_found` / `subscription_customer_mismatch` with a typed reason.
- **The validator never mutates.** It only reads. Every write (mark failed, mark verified, escalate) happens downstream in [[honor-required-outcomes]] / [[outcome-completion-gate]] once the honor step runs.
