import type { SupabaseClient } from "@supabase/supabase-js";

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
 *
 * Phase 1 of [[../../docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind]]:
 * `guardInternalOrderNow` mirrors this verdict shape for the INTERNAL branch of the
 * portal order-now handler. Ground truth (2026-09-23 for one customer): three portal
 * presses at 01:08:28 / 01:09:40 / 01:19:49 produced three charges 5s behind each
 * press ($117.24 × 3 = $351.71), because the internal branch had NO guard against a
 * second press while a charge for the same sub was still in flight or had just landed.
 * The `next_billing_date` staleness check that already existed is blind here — each
 * press re-reads that field AFTER the prior charge moved it, so the value always looks
 * current. The AUTHORITATIVE signal is the per-cycle claim ledger
 * ([[../../docs/brain/tables/subscription_cycle_charges]]) — a row claimed for this
 * subscription within a short window, or any unresolved claim. See
 * [[../../docs/brain/lifecycles/customer-portal]].
 */
export type OrderNowGuardVerdict =
  | { action: "proceed" }
  | {
      action: "block";
      reason: "contract_cancelled" | "contract_not_active" | "order_in_progress";
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

// ─── Phase 1 — the immediate-order button cannot bill twice ─────────
// [[../../docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind]]
//
// The INTERNAL branch of `handlers/order-now.ts` fires an
// `internal-subscription/renewal-attempt` event on every press. Nothing was stopping
// a second press from firing a second event that then produced a second charge —
// verified on 2026-09-23 where one customer pressed the button three times inside
// twelve minutes and was billed three cycles ($351.71 total, six boxes of coffee, a
// subscription paid up to April 2027). Auditing found 38 customers with two-plus
// presses inside half an hour.
//
// The staleness check on `next_billing_date` that WAS in place cannot help this
// class: each press re-reads that field AFTER the prior charge already moved it, so
// the value looks current. The AUTHORITATIVE signal is the per-cycle claim ledger
// (`subscription_cycle_charges`) — a row claimed for THIS subscription within a
// short window, OR any unresolved (`status='in_flight'`) claim.
//
// A recent SUCCEEDED claim also refuses: the sub was already billed for that cycle,
// so a repeat press would be the double-press failure mode. A recent FAILED claim
// also refuses: the customer just decoded a decline on their card, and letting them
// re-press immediately would send a second sale on a still-broken card. Genuine
// deliberate repeats are preserved — after the window expires, a second order-now
// press proceeds normally (explicit, not a double-press).

/**
 * How long a landed charge on this subscription counts as "already being placed" for
 * the purpose of blocking a repeat portal press. The three ground-truth presses on
 * 2026-09-23 were 72 seconds and ~10 minutes apart; 15 minutes clears both while
 * leaving a genuine second order (customer waits, re-decides) unblocked.
 */
export const INTERNAL_ORDER_NOW_RECENT_WINDOW_MS = 15 * 60 * 1000;

/** Minimal shape the pure predicate needs from a cycle-charge ledger row. */
export interface InternalOrderNowLedgerRow {
  status: "in_flight" | "succeeded" | "failed";
  claimed_at: string;
}

/**
 * Pure: given every recent cycle-charge ledger row for a subscription, decide whether
 * the immediate-order button must refuse. Refuses on:
 *   - ANY unresolved (`status='in_flight'`) row, regardless of age — a real charge
 *     for this sub is still in flight, so a second press would be the ground-truth
 *     double-press.
 *   - ANY row (succeeded or failed) `claimed_at` within `windowMs` of `now` — a
 *     charge for this sub just landed; a repeat press within the window is a
 *     double-press, not a deliberate re-order.
 *
 * A caller passes ledger rows fetched by `guardInternalOrderNow` below; the split
 * keeps this pure predicate cheap to exercise in unit tests without a DB.
 */
export function pickInternalOrderNowBlock(
  rows: readonly InternalOrderNowLedgerRow[],
  now: number,
  windowMs: number,
): { reason: "in_flight" | "recent_charge"; row: InternalOrderNowLedgerRow } | null {
  for (const row of rows) {
    if (row.status === "in_flight") return { reason: "in_flight", row };
    const claimedMs = new Date(row.claimed_at).getTime();
    if (!Number.isFinite(claimedMs)) continue;
    if (now - claimedMs <= windowMs) return { reason: "recent_charge", row };
  }
  return null;
}

/**
 * Async guard the internal branch of the portal order-now handler calls BEFORE
 * sending `internal-subscription/renewal-attempt`. Mirrors `guardAppstleOrderNow`'s
 * `OrderNowGuardVerdict` return shape — proceed on a clean subscription, block with
 * a distinct reason + rendered message when the ledger says a charge for this sub is
 * already being placed.
 *
 * The reason code `order_in_progress` is DISTINCT from the two Appstle reasons so
 * the portal can render "your order is already being placed" instead of a silent
 * no-op (the silent failure is what made the ground-truth customer press again).
 *
 * Errors on the DB read propagate — a service failure while reading the ledger must
 * NOT silently degrade into "no blocker, proceed to charge".
 */
export async function guardInternalOrderNow(
  admin: SupabaseClient,
  args: {
    subscription_id: string;
    now?: number;
    windowMs?: number;
  },
): Promise<OrderNowGuardVerdict> {
  const now = args.now ?? Date.now();
  const windowMs = args.windowMs ?? INTERNAL_ORDER_NOW_RECENT_WINDOW_MS;
  const cutoffIso = new Date(now - windowMs).toISOString();

  const { data, error } = await admin
    .from("subscription_cycle_charges")
    .select("status, claimed_at")
    .eq("subscription_id", args.subscription_id)
    .or(`status.eq.in_flight,claimed_at.gte.${cutoffIso}`)
    .order("claimed_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new Error(
      `guard_internal_order_now_read_failed: ${error.message} (sub=${args.subscription_id})`,
    );
  }

  const blocker = pickInternalOrderNowBlock(
    (data ?? []) as InternalOrderNowLedgerRow[],
    now,
    windowMs,
  );
  if (blocker) {
    return {
      action: "block",
      reason: "order_in_progress",
      message: "Your order is already being placed.",
    };
  }
  return { action: "proceed" };
}
