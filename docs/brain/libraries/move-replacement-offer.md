# libraries/move-replacement-offer

Phase 2 of [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] — When Sol's Phase-1 move-triggered address-update journey completes and a customer's shipping address is written to the active subscription, decide whether to ALSO offer a $0 replacement of a recent order that shipped to the OLD address, reusing the validated new address so the customer is never re-asked.

**File:** `src/lib/move-replacement-offer.ts`

## Design guardrails

- **The offer is EXPLICIT, never auto-granted.** An outbound customer-visible message asks the customer; the offer state is stashed on `tickets.playbook_context` under `pending_move_replacement_offer` — acceptance is a downstream turn calling `acceptMoveReplacementOffer` (which validates the offer is still pending before dispatching through the shared replacement path).
- **Eligibility mirrors the [[../playbooks/refund]] Tier-1 threshold** (LTV ≥ $100 OR total_orders ≥ 3) — a save-worthy customer, not a first-purchase-and-abscond risk.
- **Recent-order gate:** an order created in the last 21 days with a Shopify id (has been through fulfillment) — no offer against a stale ledger.
- **Confirming predicate at the mutation point** — `acceptMoveReplacementOffer` re-reads the pending offer AND asserts the ticket still owns it before firing `issueReplacement`; a raced/stale offer bails without a duplicate replacement.

Pure — no filesystem, no network. `admin` is injected by the caller (the journey completion route). `issueReplacement` on the accept path is dep-injected so the tests can drive it deterministically without standing up Supabase + Shopify.

## Exports

### Constants

- **`MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS`** = 10000 (cents) — LTV threshold that satisfies the eligibility gate on its own. Mirrors the refund playbook's Tier-1 "long-tenured" bar. A customer whose lifetime revenue clears $100 is worth the save gesture of a $0 replacement shipment when they've moved.
- **`MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT`** = 3 — Total-orders threshold that satisfies the eligibility gate on its own. Mirrors the refund playbook's Tier-1 bar. LTV OR total_orders — either one clears.
- **`MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS`** = 21 — Recent-order window (days). An order created within this window with a Shopify id is eligible for a $0 replacement offer.

### `evaluateMoveReplacementEligibility` — function

```ts
function evaluateMoveReplacementEligibility(stats: MoveReplacementCustomerStats): EligibilityVerdict
```

Evaluates whether a customer with the given stats (lifetime_value_cents, order_count, has_active_subscription) is eligible for a move-replacement offer — LTV ≥ 10000 OR order_count ≥ 3. Returns `{eligible: true}` or `{eligible: false, reason}`.

### `findRecentEligibleOrderForMoveReplacement` — async function

```ts
async function findRecentEligibleOrderForMoveReplacement(
  admin: Admin, 
  customerId: string
): Promise<RecentOrderForReplacement | null>
```

Finds the most recent order created within the last 21 days with a Shopify id (has been through fulfillment). Returns the order record (id, created_at, shopify_order_id, items, shipping_address_old) or null if no eligible order exists.

### `composeMoveReplacementOfferMessage` — function

```ts
function composeMoveReplacementOfferMessage(
  customerName: string, 
  order: RecentOrderForReplacement
): string
```

Composes the outbound customer-visible message offering a $0 replacement shipped to the newly-validated address. Returns the message text.

### `offerMoveReplacementIfEligible` — async function

```ts
async function offerMoveReplacementIfEligible(
  params: OfferParams
): Promise<OfferResult>
```

Main entry point — called by the journey completion route right after the address update lands. Evaluates eligibility, finds a recent eligible order, composes the offer message, and stashes the pending state on `tickets.playbook_context`. Returns `{offered: true, offerMessage}` or `{offered: false, reason}`. Route failure is best-effort logged and does NOT roll back the address update.

### `looksLikeMoveReplacementAcceptance` — function

```ts
function looksLikeMoveReplacementAcceptance(message: string): boolean
```

Heuristic check — does the customer's message signal acceptance of the replacement offer? Used by the ticket handler to detect when `acceptMoveReplacementOffer` should fire.

### `acceptMoveReplacementOffer` — async function

```ts
async function acceptMoveReplacementOffer(
  params: AcceptParams
): Promise<AcceptResult>
```

Accepts a pending move-replacement offer after confirming it is still pending on the ticket. Re-asserts the pending state (confirming-predicate pattern learning #6) and dispatches through the shared `commerce/replacement.issueReplacement` path against the validated new address (never re-asked). Returns `{accepted: true}` or `{accepted: false, reason}` — e.g., the offer expired, the ticket no longer owns it, or the replacement dispatch failed.

## Tests

`src/lib/move-replacement-offer.test.ts` — unit tests covering eligibility evaluation (LTV gate, order-count gate), recent-order lookup, offer composition, acceptance flow, and the confirming-predicate guard against race conditions.

Run: `npx tsx --test src/lib/move-replacement-offer.test.ts`

## Called by

- `src/app/api/journey/[token]/complete/route.ts` — the standalone Confirm Shipping Address journey's completion route calls `offerMoveReplacementIfEligible` right after the address update lands.
- Ticket handler — when a customer's reply signals acceptance, `acceptMoveReplacementOffer` is dispatched.

---

[[../README]] · [[./ticket-directions]] · [[./sol-move-dead-end-guard]] · [[../lifecycles/ticket-lifecycle]] · [[../playbooks/refund]] · [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] · [[../functions/cs]] · [[../../CLAUDE]]
