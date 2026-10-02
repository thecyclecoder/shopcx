# libraries/portal/order-now-guard

Portal + dashboard guards that refuse an order-now / bill-now call before it can produce a duplicate charge. Two guards, one per billing engine:

- `guardAppstleOrderNow` — blocks a firing against a cancelled or otherwise non-active Appstle contract.
- `guardRecentOrderNow` (back-compat alias `guardInternalOrderNow`) — blocks a repeat immediate order for the SAME subscription, on ANY engine, while a charge is already in flight OR one just landed. It runs on every order-now surface: the portal (internal and ShopCX branches), dashboard bill-now, and every agent action (via `subscriptionOrderNow`). See [[../tables/subscription_cycle_charges]].

**File:** `src/lib/portal/order-now-guard.ts`

## Context

Ticket `183d28b9-18d0-403f-ba2e-1cb5e9abb5b8` (Ellyn): the portal 'order now' targeted Appstle contract `27803779245`, but that contract was cancelled — she had been migrated to internal sub `internal-9be4eda697684e34`. Appstle's `attempt-billing` endpoint returned `"All 1 products in this subscription are currently out of stock"`. ACV Gummies (Apple) is in stock; the OOS message is a stale-contract/variant artifact of the migration, not a real stockout. The customer got a confusing dead-end.

The internal branch of [[portal__handlers__order-now]] already gated on `status !== "active"` and returned a clean `not_active` message. The Appstle branch did not — it went straight from `resolveSub` → `appstleGetUpcomingOrders` → `appstleAttemptBilling` and let the vendor's response speak. On a cancelled contract that response is undefined, and the OOS false-positive is the shape that surfaced live.

This guard mirrors the internal-branch gate onto the Appstle branch. Same predicate is used by the dashboard's `POST /api/workspaces/[id]/subscriptions/[subId]/bill-now` route so an agent triggering bill_now on a cancelled sub sees the same clean 409 rather than a raw Appstle body.

## Exports

### `guardAppstleOrderNow(sub): OrderNowGuardVerdict` — function

```ts
export type OrderNowGuardVerdict =
  | { action: "proceed" }
  | { action: "block"; reason: "contract_cancelled" | "contract_not_active"; message: string };

export function guardAppstleOrderNow(sub: {
  is_internal: boolean | null;
  status: string | null;
}): OrderNowGuardVerdict
```

**Decision table:**

| `is_internal` | `status`      | Verdict                                       |
|---------------|---------------|-----------------------------------------------|
| `true`        | *any*         | `proceed` — internal branch owns its own gate |
| `false`       | `"cancelled"` | `block:contract_cancelled` (409)              |
| `false`       | `"paused"` / anything non-`active` non-`null` | `block:contract_not_active` (409) |
| `false`       | `"active"`    | `proceed`                                     |
| `false`       | `null`        | `proceed` (unknown ≠ cancelled — the vendor call is the source of truth) |

**Unit test:** `src/lib/portal/order-now-guard.test.ts` (Appstle: 5 cases including the Ellyn/`27803779245` shape; recent-order guard: cases pinning the ground-truth 2026-09-23 three-press burst plus the orders signal). Registered as `npm run test:order-now-guard`.

### `guardRecentOrderNow(admin, { subscription_id, workspace_id, now?, windowMs?, listRecentOrders? }): Promise<OrderNowGuardVerdict>` — async

Returns the SAME `OrderNowGuardVerdict` shape, with an additional `reason: "order_in_progress"` case.

**Decision table** (per-subscription, reads [[../tables/subscription_cycle_charges]]):

| Ledger state for this `subscription_id`                        | Verdict                                                |
|----------------------------------------------------------------|--------------------------------------------------------|
| Any `status='in_flight'` row (regardless of age)               | `block:order_in_progress` (409) — a charge is running  |
| `succeeded` or `failed` row `claimed_at` within window (15 min) | `block:order_in_progress` (409) — a charge just landed |
| Only rows outside the window                                    | `proceed` — deliberate repeat is allowed               |
| No rows                                                         | then the orders check below                            |

If the ledger is clear, a second check runs: the sub's **newest order** (via the [[commerce__order]] SDK `listOrders`, injectable as `listRecentOrders`). If that order was created within the window, the verdict is `block:order_in_progress`. This signal works on any engine. It is what covers the portal **ShopCX** branch, which bills Shopify directly and never writes a ledger row: after the first press advances `next_billing_date`, its `BILLED` pre-check only sees the *next* cycle, so without this check a second press charged that cycle unopposed.

Window default: `INTERNAL_ORDER_NOW_RECENT_WINDOW_MS = 15 * 60 * 1000`. Overridable in tests. The message on refusal is `"Your order is already being placed."` — a clear non-alarming rendering the portal shows instead of a silent no-op (the silent failure is what made the 2026-09-23 customer press again). A failed read of the ledger or the orders propagates: a service failure MUST NOT silently degrade into "no blocker, proceed to charge".

The pure predicate `pickInternalOrderNowBlock(rows, now, windowMs)` is exported for unit-testing without a DB.

## Callers

- `src/lib/portal/handlers/order-now.ts` — portal 'Order now' button. **Internal branch:** calls `guardInternalOrderNow` FIRST, before the `internal-subscription/renewal-attempt` event, returning `{ error: "order_in_progress", message: "Your order is already being placed." }` at HTTP 409 on a repeat press. **Appstle branch:** calls `guardAppstleOrderNow` and blocks with `{ error: "contract_cancelled", message: "This subscription is no longer active." }` at HTTP 409 instead of proxying the raw Appstle body.
  The **ShopCX branch** calls `guardRecentOrderNow` before its `BILLED` pre-check and returns the same 409.
- `src/lib/commerce/subscription.ts` `subscriptionOrderNow` — the chokepoint for every non-portal immediate order: the dashboard bill-now route and the agent actions `bill_now`, `order_now`, and `change_next_date`'s ship-today path. These also reach it through `subscriptionOrderNowVerified`, which the post-migration retry uses too. On the internal and ShopCX engines it refuses with `error: "order_in_progress: …"`; callers test that with `isOrderInProgressError`.
  - The **dashboard bill-now** route maps that refusal to the portal's 409 shape (`ORDER_IN_PROGRESS` / `ORDER_IN_PROGRESS_MESSAGE`); it also still calls `guardAppstleOrderNow`.
  - **`change_next_date`** must NOT fall through to its "bump the date to tomorrow" fallback on this refusal. That would schedule a second charge, so it returns the refusal instead.
  - A **replacement upcharge** blocked this way rolls the replacement back with a clear error. That fails safe.
  - A **post-migration retry** blocked this way means the sub was already charged. It records `fire_failed`, with no escalation.
- `src/app/api/portal/route.ts` — `order_in_progress` is listed in `VALIDATION_ERRORS`, so a refused press does **not** spawn a "Portal action needs help: ordernow" ticket. Such a ticket would be worse than noise: the agent that picks it up re-runs the action the customer "couldn't" complete, which is exactly the double charge the guard refused. On 2026-09-23 the same mechanism re-ran a failed loyalty apply.

## Out of scope

The other gap flagged by the same ticket — the $0.00 renewal price on the migrated internal ACV sub that would misbill on `2026-08-14` — belongs to the migration-fix (billing-integrity) path, not this guard. See [[migration-fix]] § pricing_preserved.

---

[[../README]] · [[../../CLAUDE]]
