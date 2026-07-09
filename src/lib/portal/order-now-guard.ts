/**
 * Portal order-now guard for Appstle bill_now — blocks the vendor call when
 * the target Appstle contract is already cancelled or otherwise non-active.
 *
 * The bug this fixes (ticket 183d28b9): Ellyn's portal 'order now' targeted
 * Appstle contract 27803779245, but that contract is cancelled (she was
 * migrated to internal sub internal-9be4eda697684e34). The Appstle branch of
 * the order-now handler had NO status gate — it went straight to
 * `appstleGetUpcomingOrders` → `appstleAttemptBilling`, and Appstle returned
 * "All 1 products in this subscription are currently out of stock". That OOS
 * message is a stale-contract/variant artifact of the migration, not a real
 * stockout, so the customer got a confusing dead-end.
 *
 * The internal branch already gates on `status !== "active"` (order-now.ts:23).
 * This predicate mirrors that gate on the Appstle branch — a cancelled or
 * paused Appstle contract must not fire `attempt-billing`, because the vendor's
 * response is undefined and often surfaces the false OOS above.
 *
 * Kept pure so `handlers/order-now.ts` and the dashboard bill-now route share
 * the same decision table and it can be unit-tested without a DB.
 */
export type OrderNowGuardVerdict =
  | { action: "proceed" }
  | {
      action: "block";
      reason: "contract_cancelled" | "contract_not_active";
      message: string;
    };

export function guardAppstleOrderNow(sub: {
  is_internal: boolean | null;
  status: string | null;
}): OrderNowGuardVerdict {
  if (sub.is_internal) return { action: "proceed" };

  if (sub.status === "cancelled") {
    return {
      action: "block",
      reason: "contract_cancelled",
      message: "This subscription is no longer active.",
    };
  }

  if (sub.status && sub.status !== "active") {
    return {
      action: "block",
      reason: "contract_not_active",
      message: "This subscription isn't active.",
    };
  }

  return { action: "proceed" };
}
