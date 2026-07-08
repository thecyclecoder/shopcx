# libraries/crisis-journey-builder

Per-tier crisis journey builders (Tier 1 flavor swap, Tier 2 product swap, Tier 3 pause/remove).

**File:** `src/lib/crisis-journey-builder.ts`

## File header

```
Crisis Journey Builder — builds steps for crisis tier journeys.
Tier 1: Flavor swap (single choice from available_flavor_swaps)
Tier 2: Product swap + coupon (single choice from available_product_swaps, then quantity)
Tier 3: Pause/remove (berry_only → pause vs cancel, berry_plus → remove vs cancel)
```

## Exports

### `buildCrisisTier1Steps` — function

```ts
async function buildCrisisTier1Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `buildCrisisTier2Steps` — function

```ts
async function buildCrisisTier2Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `buildCrisisTier3Steps` — function

```ts
async function buildCrisisTier3Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

## Crisis-swap-rejected — full refund + founder cancel-SMS

Sibling flow for the case a Tier-1 flavor swap has ALREADY CHARGED — the customer's renewal has run, the order that will ship carries the `default_swap` flavor because the ordered flavor is OOS, and the customer signals they reject the substitute (berry-only / "no substitutions" / "I'll wait"). This is NOT a `buildCrisisTier1Steps` case (no journey to run — the money already moved); Sol runs a supervised remedy sequence instead. Ships from [[../specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].

Three files carry the recognition → remedy flow. All pure at the boundary (no state mutation outside the sequencer's typed dependency calls):

| File | Purpose |
|---|---|
| `src/lib/commerce/crisis-swap-rejected.ts` | **Phase 1 — classifier.** `classifyCrisisSwap({crisis, order, message})` returns `'crisis_swap_rejected'` (active crisis + order carries the `default_swap` variant + rejection signal in the customer's message) / `'swap_accepted'` (accepts the substitute or asks for a different in-stock flavor) / `'overcharge_only'` (no active crisis / order does not carry the swap variant — defer to the sibling price-correction partial at [[subscription-overcharge]]) / `'no_match'`. On `crisis_swap_rejected`, emits a plan for a FULL refund of the remaining balance (`order.total_cents − prior_refunded_cents`, clamped ≥ 0) — NEVER a price-correction partial. Exports `detectSwapRejectionSignal` + `detectSwapAcceptanceSignal` for reuse. |
| `src/lib/commerce/founder-cancel-sms.ts` | **Phase 2 — founder Amplifier-cancel SMS emitter.** `sendFounderCancelAmplifierSMS(admin, {workspaceId, orderId})` — best-effort, idempotent, never-throws. Reads the order, short-circuits when `amplifier_status === 'Shipped'` (return path, not founder cancel), on an existing `customer_events` row of `event_type='order.founder_cancel_amplifier_sms_sent'` scoped by `(workspace_id, properties.order_id)` (durable idempotency ledger — same order never gets two cancel texts), on missing founder phone / twilio config. Reuses [[god-mode]] `resolveFounderPhone` and [[../integrations/twilio]] `sendSMS`. Ledger stamped ONLY on delivered SMS so a transient Twilio failure retries. |
| `src/lib/commerce/crisis-swap-rejected-sequencer.ts` | **Phase 3 — sequencer.** `executeCrisisSwapRejectedRemedy(admin, args)` composes the two above into the spec's sequence: (1) load order, (2) sum `order_refunds` prior-refund ledger (workspace-scoped, status ∈ `succeeded`/`settled`), (3) classify, short-circuit any non-rejected classification with a truthful `skipped_reason`, (4) fire the founder cancel-SMS FIRST — spec sequence: the founder's manual cancel is time-boxed to before Shipped, so it goes ahead of the refund; a Shipped order lands `sms.sent=false / reason:'…Shipped…'` and the refund STILL proceeds (return-on-receipt runs in parallel), (5) issue the full refund via [[commerce__refund]] `issueRefund` threading a stable action-scoped `requestKey` (via [[../refund]] `hashActionRefundKey`) so a same-shape retry short-circuits inside `refundOrder`'s pre-dispatch `order_refunds` guard — no second gateway call, no double refund, (6) emit `buildInternalNote` capturing both the refund amount AND the SMS disposition (`crisis-swap-rejected: full refund $X + founder texted to cancel {order_number}`, with honest variants for already-Shipped / already-texted / no-phone / failed), and (7) emit `buildCustomerReplyDraft` per [[../customer-voice]] — acknowledges OOS + refund + paused-until-restock without over-apologizing, no order numbers in customer-visible text, DIFFERENT copy on a failed refund ("getting the refund set up now" — never claims an action the system didn't perform). |

The Cheri case ($116.41 total, $26.89 already refunded → $89.52 remainder, NOT the full $116.41) is pinned by tests in [[../specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order#phase-4--brain--end-to-end-verification]] — the sequencer computes the remainder BEFORE the vendor call, and the classifier clamps to zero when prior refunds ≥ order_total.

Test files: `src/lib/commerce/crisis-swap-rejected.test.ts`, `src/lib/commerce/founder-cancel-sms.test.ts`, `src/lib/commerce/crisis-swap-rejected-sequencer.test.ts`, and the four-scenario end-to-end harness `src/lib/commerce/crisis-swap-rejected.e2e.test.ts` (not-shipped / already-shipped / swap-accepted / prior-partial).

---

[[../README]] · [[../../CLAUDE]]
