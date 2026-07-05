# Return pipeline

End-to-end trace from "agent / playbook / customer initiates a return" to "customer refunded + email sent." The pipeline was rewritten 2026-05-14 (see CLAUDE.md § Returns) to simplify around a stored-contract model: the refund amount is set at return-creation time and the pipeline trusts it forever.

## Cast

- Initiators: agent UI, [[../playbooks]] return-request playbook, customer portal, AI orchestrator (via `direct_action`).
- Brain: `src/lib/shopify-returns.ts` (`createFullReturn`, `closeReturn`, `partialRefundByAmount`, `issueStoreCredit`) + [[../inngest/returns]] (process-delivery, issue-refund).
- Label: [[../integrations/easypost]] (USPS-pinned).
- Refunds: [[../integrations/shopify]] (`refundCreate`) + [[../integrations/braintree]] (`transaction.refund`) when applicable.
- State: [[../tables/returns]] + [[../tables/orders]].
- Comms: [[../integrations/resend]] (return label email, confirmation email).

## Why this design

Past pain points the rewrite addressed:

1. **Shopify reverse-fulfillment "dispose"** used to gate the refund — wasted complexity since we don't use Shopify's inventory bookkeeping for returns. Removed.
2. **24-hour inspection wait** existed for the dispose call. Removed.
3. **Refund-amount drift** when the pipeline tried to re-derive cents at refund time from line items + tax + label cost. The current rule: the contract is set at creation; the pipeline trusts it.
4. **Label from/to swap** when the AI's improve-tab set `is_return: true` directly on the EasyPost shipment — USPS printed labels with addresses swapped, packages came back to *customers*. Fix: always go through `createFullReturn()`.

## Phase 1 — create the return

`createFullReturn()` in `src/lib/shopify-returns.ts` is the single entry point. Anyone wanting to create a return must call this — never poke [[../tables/returns]] / EasyPost directly.

**Internal orders (SHOPCX*, no Shopify order) — `shopifyOrderGid: null`** (`20260628120000`). An internal order has no Shopify return to mirror, so `createFullReturn` takes an internal branch: build the returnable items from the order's **own `line_items`** (per-unit `price_cents` × qty = the line total), insert a Shopify-less [[../tables/returns]] row (`shopify_order_gid=null`, `return_line_items` from the order lines, no `shopify_rfo_line_item_id`), and **skip** the Shopify `returnCreate` + `attachReturnTracking`. The label buy (step 3 — address-based, already Shopify-independent), `net_refund_cents` (step 4), DB update (step 6) and label email (step 7) are **identical**. The [[create_return]] action ([[../libraries/action-executor]]) passes `null` when `orders.shopify_order_id` is null instead of fabricating a `gid://shopify/Order/null`. **Downstream refund** ([[../inngest/returns]] `issue-refund`): an internal order refunds via **Braintree** (`refundBraintreeTransaction(ws, order.braintree_transaction_id, net_refund_cents)`) instead of Shopify `refundCreate`.

Steps:

1. **Validate inputs** — order id, line items to return (with quantities), reason, resolution type (`refund_return` / `store_credit_return` / `refund_no_return` / `store_credit_no_return`), `freeLabel` flag.
2. **Compute `order_total_cents`** — line items' subtotal, no tax/shipping included for line-level partial returns. For full returns it's the order's `total_cents`.
3. **Buy the EasyPost label** (`no_return` resolutions skip this):
   - Build the Shipment with the customer's shipping address as the FROM and our `workspaces.return_address` as the TO. Critical — never set `is_return: true` on the shipment; always build the address pair explicitly.
   - Select USPS rates first; fall back to other carriers only if USPS has none.
   - Buy the rate → returns `tracking_code`, `label_url`, `selected_rate.rate` (the cost we paid).
   - If `freeLabel=true`, we eat the cost → `label_cost_cents = 0`. Otherwise → `label_cost_cents = selected_rate.rate * 100`.
4. **Compute `net_refund_cents`**:
   - `refund_return` / `store_credit_return` → `order_total_cents - label_cost_cents`.
   - `refund_no_return` / `store_credit_no_return` → `order_total_cents` (no label, customer keeps the item).
5. **Call Shopify** `returnCreate` mutation → creates the Shopify-side return record. Stores the `returnGid` as `shopify_return_gid` on our row.
6. **Insert [[../tables/returns]]** with:
   - `status='label_created'` (or `'open'` if no label was bought)
   - `easypost_shipment_id`, `tracking_number`, `label_url`
   - `order_total_cents`, `label_cost_cents`, `net_refund_cents`
   - `resolution_type`, `source` (ai/agent/playbook/portal/system)
   - `return_line_items` (JSONB) with each item's `shopify_rfo_line_item_id` from the Shopify return record.
7. **Send the label email** via [[../integrations/resend]] with the label embedded as a CTA. See feedback_return_label_in_reply — labels go in the same reply, never "you'll get a separate email."
8. **Optional:** call `attachReturnTracking()` to create a Shopify ReverseDelivery — cosmetic only, doesn't gate our flow.

The customer now has a label and a tracking number.

## Phase 2 — in transit

The customer drops the package. EasyPost fires `tracker.updated` events as the carrier scans the label. Our webhook handler updates [[../tables/returns]]:

- `status='in_transit'` on first carrier scan.
- `easypost_status`, `easypost_detail`, `easypost_location`, `easypost_checked_at` for the activity timeline.
- Stuck-in-transit detection: if `easypost_status='in_transit'` and last update > N days, [[../inngest/delivery-audit]] surfaces a [[../tables/dashboard_notifications]] entry.

## Phase 3 — delivered

EasyPost fires `tracker.delivered`. Webhook handler:

- Updates [[../tables/returns]] `delivered_at = now()`, `status='delivered'`.
- Fires Inngest `returns/process-delivery`.

[[../inngest/returns]] `returns-process-delivery`:

1. Re-load the return from [[../tables/returns]].
2. Verify `status='delivered'`. Bail if changed under us.
3. Verify not already refunded (`refunded_at IS NULL AND refund_id IS NULL`).
4. **Fire `returns/issue-refund` instantly.** No 24h wait. No Shopify dispose call.

This step is intentionally thin — it exists so the webhook handler stays fast, and so the actual refund logic is independently retryable from the Inngest dashboard.

## Phase 4 — issue refund

> **Double-refund guard.** The pipeline skips the refund when the return already has `refunded_at` or `refund_id` set. A direct `partial_refund` on an order now stamps those onto any open return for that order, so a goodwill refund issued *now* + a `refund_return` on the same order can't both pay out (the refund-now path covers it; the return just brings the product back). See [[../operational-rules]] § Returns. (Sonia Stevens, SC132396.)

[[../inngest/returns]] `returns-issue-refund`:

1. Re-load the return. Re-verify state.
2. **Read `net_refund_cents`.** If missing or zero:
   - Insert [[../tables/dashboard_notifications]] "Return needs manual review — no refund amount stored."
   - Stop. Don't refund.
3. **Branch on `resolution_type`**:
   - `refund_return` → `partialRefundByAmount(orderId, net_refund_cents)`.
   - `store_credit_return` → `issueStoreCredit(customerId, net_refund_cents)`.
   - `*_no_return` → same as above (the difference is whether a label was bought).
4. **`partialRefundByAmount`** in `src/lib/shopify-returns.ts`:
   - Looks up the order's gateway. Most orders are Shopify Payments → Shopify `refundCreate` mutation refunds the exact amount.
   - Some orders are Braintree-paid (custom checkout) → [[../integrations/braintree]] `transaction.refund(txn_id, amount)` via `refundBraintreeTransaction()` in `src/lib/integrations/braintree.ts`. Optionally records on the Shopify order for reconciliation.
   - Returns `{ success, refund_id, method }`. On `success=false`, the error message determines next steps.
5. **`issueStoreCredit`** via [[../integrations/shopify]] `storeCreditAccountCredit` mutation → writes [[../tables/store_credit_log]].
6. **On success**:
   - Update [[../tables/returns]] `status='refunded'`, `refunded_at=now()`, `refund_id`, `refund_method`.
   - Send confirmation email via `sendReturnConfirmationEmail` ([[../integrations/resend]]).
   - Write [[../tables/customer_events]] event `return.refunded`.
7. **On failure**:
   - The most common failure is `Braintree::AuthenticationError` when Shopify-side refund hits a stale gateway connection.
   - Insert [[../tables/dashboard_notifications]] "Return refund failed — manual action needed" with the error detail and a link to the ticket.
   - Don't retry blindly — the issue usually needs admin attention (re-auth a gateway, manually refund via Shopify Admin).
   - Manual fix path: refund via Shopify Admin → set `returns.refund_id='manual-braintree'` → re-fire the email send (or it'll re-fire on next manual return state change).

## Free-label vs customer-pays-shipping

- **`freeLabel: true`** — `label_cost_cents = 0`, `net_refund_cents = order_total_cents`. Used by:
  - Crisis returns (we caused the problem).
  - Tenured-customer goodwill returns (admin discretion).
- **`freeLabel: false`** — `label_cost_cents = actual EasyPost rate`, `net_refund_cents = order_total_cents - label_cost_cents`. The customer eats the return shipping cost.

Partial returns of multi-item orders use items_subtotal-based math, not the full order total — see CLAUDE.md § Returns.

## Imported vs created-by-us returns

[[../tables/returns]] holds two classes:

- **Created by us** — `easypost_shipment_id IS NOT NULL`. We own the refund. Pipeline applies.
- **Imported / external** — `easypost_shipment_id IS NULL`. Returns that existed in Shopify before us, or were created by Shopify staff directly. We do NOT auto-refund these — Shopify staff handle them in the Shopify Admin UI.

Always filter with `.not("easypost_shipment_id", "is", null)` when finding refundable returns. See [[../tables/returns]] gotchas.

## Crisis return autopilot

When a crisis campaign issues a return (e.g. wrong item shipped during an OOS event), the Sonnet orchestrator owns the entire flow. No agent intervention, no escalation. See feedback_crisis_return_auto. The orchestrator picks the return-from order, calls `createFullReturn()` with `freeLabel=true`, and tells the customer "your refund will land in X days." The pipeline takes care of the rest.

## 30-day flow regression (fixed 2026-06-08)

The 30-day money-back-guarantee flow (Refund playbook → `handle30DayFlow` in [[../libraries/playbook-executor]]) had its own return-creation code that **bypassed `createFullReturn()`** — exactly the thing Phase 1 forbids. On customer confirmation it did a raw `returns` insert with `status:"pending_label"` and `resolution_type:"refund"` (both invalid enum values), which Postgres rejected and the code swallowed, then told the customer "we're generating your label and will email it to you shortly."

Net effect: **no return, no label, no email — just a false promise.** `pending_label` was a dead-end status no code ever processed.

Fixed by routing `confirm_return` through `createFullReturn()` and delivering the label inline in the same reply (per feedback_return_label_in_reply). Failures now `escalate_api_failure` (ticket stays open, agent To-Do) instead of promising a label. Lesson reinforced: **there is exactly one way to create a return — `createFullReturn()`.** Any flow with its own returns-table insert is a bug.

## After the label is delivered — re-deliver only, never troubleshoot

Once a return/replacement label has been created and sent, that is the full extent of what we can do — printing + drop-off is the customer's responsibility. If the customer follows up (can't print, no printer, "where do I drop it off", "again?", "USPS won't take it"), the AI must NOT troubleshoot, offer alternatives (print shops, QR codes — we have no Label Broker/QR support anyway, pickups, paperless), add explanations, or create a new return. The only move is to re-deliver the **exact same** label link in one short sentence. Enforced by the `sonnet_prompts` rule "Once a label is delivered, only re-deliver it…", and the orchestrator's `get_returns` tool now surfaces `label_url` so the AI has the link to re-send. Dylan's directive 2026-06-09 (a crisis-return customer got babied through three conflicting printer answers). Applies to refunds, replacements, and crisis returns alike.

## Tags + escalation

If `createFullReturn()` itself fails (Shopify return mutation rejected, EasyPost can't find a rate, etc.):

- Don't close the ticket.
- Escalate to agent with a clear note: "Couldn't create return — manual action needed."
- See feedback_return_failure_escalation. Returns / API failures leave the ticket OPEN.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/refund.ts` | `refundOrder()` — the ONLY refund entry point (Phase-3 dispatcher). Reads `orders`, routes internal orders to Braintree and Shopify orders to `partialRefundByAmount` (with the Braintree-gateway fallback for Shopify orders paid via Braintree). Stamps `refunded_at` on any open return for the order (double-refund guard). Logs `order.refunded` on `customer_events`. |
| `src/lib/shopify-returns.ts` | `createFullReturn()`, `closeReturn()`, `issueStoreCredit()`, `attachReturnTracking()` |
| `src/lib/shopify-order-actions.ts` | `partialRefundByAmount()` (Shopify REST refund + Braintree-fallback signal), `recordManualRefund()` — internal helpers of `refundOrder` |
| `src/lib/easypost.ts` | Address validation, rate selection, Shipment.buy |
| `src/lib/easypost-order-sync.ts` | Per-order shipment + tracker creation |
| `src/lib/easypost-email.ts` | Label email send |
| `src/lib/integrations/braintree.ts` | `refundBraintreeTransaction()` — called ONLY from `src/lib/refund.ts` |
| `src/lib/inngest/returns.ts` | process-delivery + issue-refund (delegates to `refundOrder`) |
| `src/lib/inngest/delivery-audit.ts` | Stuck-in-transit detection |
| `src/lib/store-credit.ts` | Store credit helper |
| `src/lib/email.ts` | sendReturnConfirmationEmail |
| `src/lib/customer-events.ts` | Log return.* + order.refunded events |
| `src/app/api/webhooks/easypost/route.ts` | EasyPost tracker webhook handler |

## Status / open work

**Shipped:** `createFullReturn()` single entry-point (2026-05-14 rewrite). EasyPost label with USPS preference + carrier fallback. `net_refund_cents` stored at creation. Instant refund on EasyPost `delivered` (no 24h wait, no Shopify dispose). Shopify partial refund OR Braintree direct refund (with email+amount+date fallback). Return confirmation email. Crisis-return auto-handling.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- Defect #1 (phantom refund on internal orders) **closed by the Phase-3 refund dispatcher.** Every refund entry point in the codebase — returns Inngest issue-refund, AI `partial_refund` + `redeem_points_as_refund`, ticket-detail Improve-tab refund, manual return-refund route, fraud-case `cancel_refund_orders` step — now routes through `src/lib/refund.ts` `refundOrder()`, which reads the order's gateway and can never fire a Shopify refund mutation on a Braintree-paid order. `refundBraintreeTransaction` is called from ONE file (`src/lib/refund.ts`); the Shopify-side refund REST + `refundCreate` mutations are constrained to `src/lib/shopify-order-actions.ts`. See [[../reference/commerce-sdk-inventory]] § Defect register. (2026-07-05)
- 30-day MBG flow (`handle30DayFlow.confirm_return`) now routes through `createFullReturn()` + inline label instead of a bare `pending_label` insert that silently failed. See § "30-day flow regression". (2026-06-08)
- `2bce67a4` Returns: refund instantly on delivered using stored net_refund_cents
- `5be66e2b` Returns: advance status to label_created when EasyPost label is bought
- `c3e03c16` Returns: fix Improve-tab labels delivering to customer instead of warehouse

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[ai-multi-turn]] · [[crisis-campaign]] · [[../integrations/easypost]] · [[../integrations/shopify]] · [[../integrations/braintree]] · [[../integrations/resend]] · [[../tables/returns]] · [[../tables/orders]] · [[../tables/store_credit_log]] · [[../inngest/returns]] · [[../inngest/delivery-audit]]
