# recipes/checkout-stuck-concierge-flow

The reflex playbook: any checkout issue → we concierge the sale. Never dead-end the customer with "try another card / try PayPal / try Shop Pay". Recorded failure mode is Latrina C. (ticket aa0b6697) — Shop Pay OTP never arrived, orchestrator dead-ended her, we lost the sale. This recipe is the fast default, integrated across five phases: classification → routing → Sol's Direction blueprint → playbook placement → analytics measurement.

## The path

```
CHECKOUT-STUCK ticket
  → Sonnet stays on Sonnet (never Opus) + Sol RE-SESSIONED               ← Phase 2
  → Sol authors the assisted-purchase Direction                          ← Phase 3
      turn 1: chosen_path='journey', plan.journey_slug='add-payment-method'
              first_reply = ASSISTED_PURCHASE_LEAD_IN
      turn 2 (on payment_method_added signal): confirm WHICH items
      turn 3: ask one-time (higher price) vs discounted S&S
      turn 4: chosen_path='playbook', plan.playbook_slug = one of the two
              session-chosen-only assisted-purchase slugs               ← Phase 4
              executor: check_vaulted_pm → create_order|create_subscription
              on success only → customer told "your order is placed"    (execute-then-confirm)
  → funnel row on the analytics slice                                    ← Phase 5
```

## The four pure-code seams (grep-able acceptance tokens)

Every seam is a named export in a real `src/lib/*.ts` file, unit-tested by a matching `.test.ts`.

| Seam | File | Purpose |
|---|---|---|
| `classifyCheckoutStuck` | `src/lib/checkout-stuck-intent.ts` | The Phase-1 predicate. Recognizes the CHECKOUT-STUCK intent from the newest inbound message (OTP not arriving / stuck at payment / can't check out / how do I finish my order). |
| `isCheckoutStuck` signal on `pickModelFromSignals` | `src/lib/model-picker.ts` | Phase-2 belt: earliest-gate short-circuit to `sonnet` with `reason='checkout-stuck'`. Even if a future rule reintroduces Opus, this gate protects the ticket. |
| `stage1_checkout_stuck` inflection cue | `src/lib/inflection-detector.ts` | Phase-2 re-session: a checkout-stuck message returns `kind:'drift'` from Stage 1, which flows through `applyInflectionGate → reSessionSol` unchanged (supersede the live Direction + enqueue a fresh `ticket-handle` job so Sol authors a real assisted-purchase Direction). |
| `buildAssistedPurchaseFirstTurnDirection` + `assertSolAssistedPurchaseReplyNeverClaimsPlaced` + `assertSolFastDefaultToConcierge` | `src/lib/assisted-purchase-direction.ts` | Phase-3 blueprint + the Phase-3 never-claim-placed guard + the Phase-5 fast-default guard. The blueprint is what Sol's ticket-handle skill authors verbatim; the two guards machine-enforce the invariants in the worker's pre-send chain. |
| `isSessionChosenOnlyPlaybook` + `interpretAssistedCreateResult` | `src/lib/playbook-executor.ts` | Phase-4 wrapper-level exclusion (the OLD signal matcher can NEVER dispatch the assisted-purchase playbooks — only Sol's session-chosen selection can) + the pure interpreter that pins the execute-then-confirm invariant on the terminal `create_order` / `create_subscription` step. |
| `buildAssistedPurchaseFunnelSql` + `buildAssistedPurchaseFunnelParams` | `src/lib/assisted-purchase-analytics.ts` | Phase-5 analytics slice — pure SQL builder + params vector for the funnel row (checkout-stuck → assisted-purchase started → order placed + recovered revenue). |

## The three send guards (in order)

The worker's `runTicketHandleJob` chain runs Sol's DRAFT reply through pure predicates before the customer-facing send fires. A block on any of them means: Direction stays durable, reply is NOT delivered, ticket escalates to June.

1. **`assessSolReplyBaitRisk`** — [[../libraries/sol-policy-bait-guard]]. Out-of-policy promise mismatch or multiple stacked remedies.
2. **`assessSolMoveDeadEndRisk`** — [[../libraries/sol-move-dead-end-guard]]. A move signal (`I moved`) must never dead-end as cancel.
3. **`assertSolAssistedPurchaseReplyNeverClaimsPlaced`** — [[../libraries/assisted-purchase-direction]]. A checkout-stuck Direction's reply must never claim `placed` before the placement handler returns `ok:true`.
4. **`assertSolFastDefaultToConcierge`** — [[../libraries/assisted-purchase-direction]]. Phase 5. A checkout-stuck ticket's reply must never suggest "try another card / try PayPal / try Shop Pay" — the founder directive is to concierge the purchase, not dead-end.

## Migration

`supabase/migrations/20261011120000_reenable_assisted_purchase_playbooks.sql` — idempotent compare-and-set on `is_active=false`, flips both `assisted-order-purchase` and `assisted-subscription-purchase` to `is_active=true`. Safe because the Phase-4 exclusion (`isSessionChosenOnlyPlaybook`) makes over-fire impossible via code — the OLD signal matcher will never dispatch these playbooks even at `is_active=true`.

## Storefront reality check

The storefront is NOT card-only. Braintree Drop-in supports PayPal Vault — [[../libraries/braintree-customer]] `paypalEmail` proves it (a vaulted PM row carries `payment_type='paypal_account'` + `paypal_email`). When Sol references what a customer already tried on Shopify's Shop Pay checkout, that's fine; when Sol PROPOSES the failing rails as the fix, the Phase-5 guard blocks the reply. See [[../lifecycles/storefront-checkout]] § Phase 4 — checkout page.

## Analytics slice — how to query

The pure builder returns a SQL string and a params vector. Bind via any parameterized-query transport (an RPC, a direct pg driver, an analytics-tile helper). Returns one row:

```ts
import { buildAssistedPurchaseFunnelSql, buildAssistedPurchaseFunnelParams } from "@/lib/assisted-purchase-analytics";
const sql = buildAssistedPurchaseFunnelSql({ workspaceId, windowStart, windowEnd });
const params = buildAssistedPurchaseFunnelParams({ workspaceId, windowStart, windowEnd });
// Bind $1..$4 = params and execute. One row back:
// { workspace_id, window_start, window_end,
//   checkout_stuck_tickets, assisted_purchase_started, orders_placed,
//   recovered_revenue_cents, start_rate, placement_rate, end_to_end_conversion }
```

Signal predicates the CTEs join on:
- **checkout-stuck**: a `ticket_resolution_events` row with `reasoning='sol:inflection-drift'` AND `chosen->>'reason'='stage1_checkout_stuck'` (Phase-2 stamp), OR a `ticket_directions` row with `chosen_path='journey'` + `plan->>'journey_slug'='add-payment-method'` (Phase-3 blueprint).
- **assisted-purchase started**: the ticket has a live Direction pointing at the `add-payment-method` journey OR at one of the two session-chosen-only playbook slugs.
- **order placed**: `tickets.playbook_context->>'assisted_purchase_completed' = 'true'` (Phase-4 execute-then-confirm signal from `interpretAssistedCreateResult`).

Ratios (`start_rate`, `placement_rate`, `end_to_end_conversion`) are ROUND'd to 4 decimals and guarded against divide-by-zero via `NULLIF`. Recovered revenue is the sum of `$NN.NN` amounts extracted from the `assisted_purchase_result_summary` context string (Braintree charge summary), converted to integer cents.

## When Sol should NOT take this path

- The customer is asking about an ALREADY-PLACED order (post-purchase question) — that's an order-status / shipping intent, not checkout-stuck. `classifyCheckoutStuck` returns `matched:false` for order-status questions (pinned by the Phase-1 negatives).
- The customer's `plan.launch_journey_slug` was set to a different journey (e.g. `shipping-address` for a move signal). The Phase-1 predicate can co-exist with an address-update intent — a move is not checkout-stuck.
- The customer has explicit LEGAL contact / manager escalation — the `escalate_if` guardrail on the Phase-3 blueprint routes those to June per [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]].

## Related

- [[../libraries/checkout-stuck-intent]] — classification.
- [[../libraries/model-picker]] + [[../libraries/inflection-detector]] — routing to Sonnet + Sol re-session.
- [[../libraries/assisted-purchase-direction]] — blueprint + guards (Phase 3–5).
- [[../libraries/assisted-purchase-analytics]] — funnel instrumentation (Phase 5).
- [[../libraries/assisted-purchase-analytics]] — the funnel SQL builder (Phase 5).
- [[../libraries/checkout-stuck-intent]] — the intent predicate (Phase 1).
- [[../libraries/model-picker]] · [[../libraries/inflection-detector]] — the Phase-2 routing.
- [[../libraries/playbook-executor]] — the terminal `create_order`/`create_subscription` handlers + the Phase-4 exclusion.
- [[../lifecycles/storefront-checkout]] — the storefront path this concierge flow routes around.
- [[../journeys/add-payment-method]] — the ACTIVE journey Turn 1 launches.
