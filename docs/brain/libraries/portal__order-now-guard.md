# libraries/portal/order-now-guard

Portal + dashboard guard that blocks a bill_now / order-now call from firing against a cancelled or otherwise non-active Appstle contract.

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

**Unit test:** `src/lib/portal/order-now-guard.test.ts` (5 cases including the exact Ellyn/`27803779245` shape).

## Callers

- `src/lib/portal/handlers/order-now.ts` — portal 'Order now' button; blocks with `{ error: "contract_cancelled", message: "This subscription is no longer active." }` at HTTP 409 instead of proxying the raw Appstle body.
- `src/app/api/workspaces/[id]/subscriptions/[subId]/bill-now/route.ts` — dashboard "Bill now" (agent action); same 409 shape.

## Out of scope

The other gap flagged by the same ticket — the $0.00 renewal price on the migrated internal ACV sub that would misbill on `2026-08-14` — belongs to the migration-fix (billing-integrity) path, not this guard. See [[migration-fix]] § pricing_preserved.

---

[[../README]] · [[../../CLAUDE]]
