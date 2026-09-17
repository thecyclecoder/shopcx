# libraries/order-holds

SDK for placing a reversible protective hold on an unshipped order the moment an
allergy/safety escalation is raised. Owned by [[../functions/logistics]] as the
DRI for fulfilment ops — "the parcel must not ship" is a fulfilment-path concern,
not a CX-conversation one.

**File:** `src/lib/order-holds.ts`

## Why this exists

Ground truth: order SC138523 was placed 2026-09-13T02:29, the customer emailed at
02:33 that she was allergic to hazelnuts, the warehouse received the order at 05:30
(three hours AFTER the report), and it shipped 2026-09-15T00:52 — a 46-hour window
nobody used. The agent told her twice on the ticket "we're stopping the parcel"
and nothing stopped it because holding depended on a human noticing. Once an
allergen ships, the only remedy left is money.

The existing `exchanges` policy escalates an allergy/medical report to a human for
the REMEDY decision (see [[../tables/policies]] § allergy override). This SDK owns
the ORTHOGONAL reversible protective action — stop the parcel now, before the
human decides what to do. Holding an order we later release costs a day; shipping
an allergen does not have a cheap undo, so the hold is attempted OPTIMISTICALLY
the moment the escalation is raised.

The hold state also feeds Phase 2 of the same spec: three distinguishable states
on every ticket surface (founder queue, director context, handling agent context)
so nobody can promise a stop that is not real.

## Exports

### `attemptAllergenHold(admin, args)` — the raise-time entry point

```ts
async function attemptAllergenHold(
  admin: Admin,
  args: { workspaceId: string; customerId: string; ticketId: string; reason: string },
): Promise<HoldAttemptOutcome>
```

Called by [[action-executor]] `escalateTicket` when the escalation reason matches
`isAllergyEscalation` (below). Finds the customer's most-recent order across their
[[customer-links]] group and:

- If none exists ⇒ returns `{ kind: 'no_unshipped_order' }`
- If the order has already shipped (`amplifier_shipped_at IS NOT NULL` or
  `fulfillment_status='fulfilled'`) ⇒ stamps `hold_status='refused'` with
  `hold_refused_reason='already_shipped'` AND raises a **loud**
  `dashboard_notifications` card of `type='fulfillment_alert'`,
  `metadata.kind='allergen_hold_refused'`. This is the "remedy space collapses to
  a refund" signal ticket handlers need to see.
- If the order is unshipped ⇒ stamps `hold_status='placed'` AND raises a
  `dashboard_notifications` card, `metadata.kind='allergen_hold_placed'`.
  When the order is already in the warehouse (`amplifier_order_id` set) the card
  body explicitly says the parcel must be physically stopped, because Amplifier
  has no update endpoint (see [[integrations__amplifier]]).
- If the order already carries an active hold ⇒ returns `{ kind: 'already_held' }`
  without re-stamping. Idempotent per order.

**Never throws.** All internal errors are captured and surfaced as
`{ kind: 'no_unshipped_order' }` so the outer escalation completes even when the
hold attempt itself fails — the escalation is the safety-critical artifact, the
hold is a best-effort protective attempt on top of it.

Writes use compare-and-set on `hold_status IS NULL` so a concurrent hold write
from a sibling ticket cannot be clobbered by a refusal path.

### `isAllergyEscalation(reason)` — the wire-up detector

```ts
function isAllergyEscalation(reason: string | null | undefined): boolean
```

Pure. Regex-matches the escalation reason string for `allerg`, `anaphyla`,
`safety report`, or `safety review` (case-insensitive). This is the check
[[action-executor]] `escalateTicket` uses to decide whether to fan out to
`attemptAllergenHold` after stamping `tickets.escalated_at`. Keeping detection in
one pure predicate makes the wire-up unit-testable and lets other escalate
call-sites (guard-block escalations, policy-driven escalations, orchestrator's
`action_type='escalate'`) share the same trigger.

### `isOrderOnAllergenHold(admin, workspaceId, orderId)` — the reconcile guard

```ts
async function isOrderOnAllergenHold(
  admin: Admin,
  workspaceId: string,
  orderId: string,
): Promise<boolean>
```

Read by [[../inngest/amplifier-import-reconcile]] `reconcileOne` alongside
`isFraudHeld`. An order under `hold_status='placed'` + `hold_kind='allergen'` MUST
NOT be handed off to the warehouse — the sweep returns `skipped-allergen-hold`
without incrementing the retry counter, so a released hold flips right back into
the eligible set on the next tick. A `refused` hold is a dead-letter (parcel
already gone) and does NOT block re-import — but there is nothing to import at
that point either.

### `getOrderHoldState(admin, workspaceId, orderId)` — the ticket-surface read

```ts
async function getOrderHoldState(
  admin: Admin,
  workspaceId: string,
  orderId: string,
): Promise<OrderHoldState>
```

The Phase-2 surface read — the shape the founder queue / director context /
handling-agent context render from. Returns the full hold state with all three
values `null | 'placed' | 'refused'` distinguishable, plus the reason, ticket id,
and (on refused) the refusal reason.

### `renderOrderHoldForContext(state, orderLabel, isLiveAllergyContext)` — the pure surface renderer

```ts
export function renderOrderHoldForContext(
  state: OrderHoldState | null,
  orderLabel: string,
  isLiveAllergyContext: boolean,
): string | null
```

Pure — the one renderer every ticket-context consumer uses so the three hold
states render **distinguishably** (the Phase-2 verification bullet). Returns:

- `state.status='placed'`  → `"⛔ allergen hold PLACED on SC138523 — parcel must not ship — reason: …"`
- `state.status='refused'` → `"🚨 allergen hold REFUSED on SC138523 (already_shipped) — the parcel has already shipped; the remedy space has collapsed to a refund…"`
- `state=null` on a live allergy escalation → `"🚨 NO allergen hold on SC138523 — no hold was ever attempted; the parcel is still moving. Do NOT promise a stop."`
- `state=null` on a non-allergy escalation  → `null` (the caller suppresses the line entirely)

"Live allergy context" is derived from `isAllergyEscalation(ticket.escalation_reason)`
so the null-state alert only fires when the ticket is a live allergy escalation
— otherwise every non-allergy order would print a spurious alert.

### `loadAllergenHoldForCard(admin, workspaceId, ticketId)` — the founder-card mint helper

```ts
export async function loadAllergenHoldForCard(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{
  status: "placed" | "refused" | null;
  kind: string | null;
  reason: string | null;
  refusedReason: string | null;
  orderLabel: string;
  isLiveAllergyContext: boolean;
} | null>
```

Called by the runner at CEO-card mint time
([[../../scripts/builder-worker]] `runCsDirectorCallJob`, escalate_founder branch)
right before `buildEscalateFounderCard`. Loads the ticket's `escalation_reason`,
customer_id, and most-recent order across the [[customer-links]] group and returns
the pre-composed shape the card body renders from. Returns `null` on a non-allergy
ticket with no hold row (nothing to say — the card body omits the fulfilment-hold
line). Read-only + swallowed on error — the card mint MUST NOT fail on this
helper (a card without a hold-context line is still a card the CEO can read).

## Phase 2 — ticket-context surfaces

The three surfaces that render an order for a ticket, all of which now render
the hold state distinguishably (per the spec's "Today all three look identical,
which is how 'we are doing everything we can to stop it' got sent about an order
with no hold on it" fault mode):

- **Founder queue** — [[cs-director-escalate-founder-card]] `buildEscalateFounderCard`
  prepends a labeled `Fulfilment hold: …` line on the CEO inbox card body when
  the runner loads a non-null allergen hold via `loadAllergenHoldForCard`. The
  three states (placed / refused / null-on-allergy) render as distinct strings
  and the `metadata.allergen_hold` field carries the structured shape for
  downstream approvers. This surface is the direct fix for "the CEO card gave
  no distinguishable signal the parcel was still moving" on ticket 0909ec6f.
- **Director's context** — [[tickets-read]] `LinkedOrderRow` / `getLinkedOrders`
  now carry the `hold_status` / `hold_kind` / `hold_reason` / `hold_placed_at`
  / `hold_refused_reason` columns off `orders`. Every June ticket-investigate
  read (`investigateTicket`, ticket-improve, cs-director-call tools) sees the
  hold state on the order row and the JSON schema its skill reads has the
  three states available.
- **Handling agent's context** — [[ai-context]] `assembleTicketContext`'s
  recent-orders block prints a `renderOrderHoldForContext` line under each
  order in the AI's system prompt. On a live allergy escalation with a null
  hold, this reads as the alert `"NO allergen hold — parcel is still moving.
  Do NOT promise a stop."` — the exact false-reassurance the AI wrote on
  2026-09-13 through -15 for ticket 0909ec6f.

## Callers

- [[action-executor]] `escalateTicket` — raise-time entry point
  (`isAllergyEscalation` gate + `attemptAllergenHold` fan-out).
- [[../inngest/amplifier-import-reconcile]] `reconcileOne` — the reconcile-sweep
  guard (`isOrderOnAllergenHold`).
- [[../../scripts/builder-worker]] `runCsDirectorCallJob` escalate_founder branch
  — the founder-card mint (`loadAllergenHoldForCard` → `buildEscalateFounderCard`).
- [[ai-context]] `assembleTicketContext` — the handling-agent system prompt's
  recent-orders block (`renderOrderHoldForContext`).

## Related state on `orders`

The columns [[../tables/orders]] adds (all nullable): `hold_status`, `hold_kind`,
`hold_reason`, `hold_ticket_id`, `hold_placed_at`, `hold_refused_reason`. Check
constraint `orders_hold_status_check` restricts `hold_status ∈ {NULL, 'placed',
'refused'}`. Partial index `orders_hold_status_placed_idx` covers the
`hold_status='placed'` lookups the reconcile guard makes.

## What happens when the hold is refused

A hold refusal (`already_shipped`) is not a quiet stamp — it is a **loud alert**.
The `dashboard_notifications` card of `metadata.kind='allergen_hold_refused'`
lands with a "REFUSED" title in the founder inbox so the human handling the
ticket cannot promise a stop that is not real. This is by design: the previous
world was "the parcel ships and the ticket handler learns about it from a
tracking notification."

## Where this stops (Phase 1 + Phase 2 scope)

- Amplifier has no order-update / cancel endpoint we integrate with; a "placed"
  hold is a DB flag + a loud alert, not a real-time warehouse API call. The
  reconcile-sweep guard prevents a not-yet-imported order from being handed off;
  a hold on an already-imported order relies on the alert to reach a human who
  can physically stop the parcel.
- The remedy decision (refund / replacement) stays with a human via the existing
  allergy override in [[../tables/policies]] `exchanges` — this SDK does NOT
  decide the customer outcome.
- Non-allergen hold kinds (fraud already uses `fraud_cases`; other classes may
  follow) are out of scope. `hold_kind` is bounded to keep future kinds
  key-able without a schema change.

---

[[../README]] · [[../../CLAUDE]]
