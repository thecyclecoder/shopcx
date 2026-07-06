/**
 * First-delivery mutation gate.
 *
 * Customers can't modify a subscription (swap / qty / add / remove / change
 * date / frequency / pause / coupon / shipping protection) until the FIRST
 * order from that subscription has been delivered. This blocks "subscribe for
 * the intro deal, then immediately swap to something pricier / change the
 * schedule before the first box even ships."
 *
 * Renewal short-circuit: once a subscription has produced more than one order,
 * the first-order delivery question is moot — a second order only exists because
 * the first billing cycle already completed. So >1 order = past first delivery
 * = allowed. This is the fix for sub 2575ff54 (26 orders, migrated, is_internal
 * = true, SC-numbered Shopify orders) which used to fall through to the
 * EasyPost branch forever and never resolve.
 *
 * Delivery signal for the single-order case is determined by the ORDER, not the
 * subscription's is_internal flag (migrated subs carry is_internal=true even
 * though their orders are SC-numbered Shopify orders — keying on the sub flag
 * sent them down the wrong branch). The order-level signal:
 *   - shopify_order_id IS NULL → internal (Amplifier-fulfilled): we don't buy
 *     the EasyPost label so we never get a delivered webhook. If a tracking
 *     number exists we do a LIVE EasyPost lookup on portal visit (throttled,
 *     cached back onto the order). If no tracking number yet, we fall back to
 *     the fulfillment status + a 7-day grace: a fulfilled internal order older
 *     than 7 days counts as delivered.
 *   - shopify_order_id present → Shopify: the order's `fulfillment_status` is
 *     the delivery proxy. "fulfilled" = shipped/delivered enough for the gate.
 *
 * Fails OPEN (allows the mutation) on an EasyPost error — this is an
 * anti-gaming gate, not a security control, and we never want an API hiccup to
 * trap a legitimate customer whose order really did arrive.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Don't re-hit EasyPost more than once per this window per order. */
const LOOKUP_THROTTLE_MS = 30 * 60 * 1000;

/** Internal order with no tracking that's fulfilled + this old = delivered (grace). */
const INTERNAL_FULFILLED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MutationGate {
  allowed: boolean;
  reason?: string;
  /** Coarse state for the UI: 'no_order' | 'not_shipped' | 'in_transit' | 'delivered'. */
  state?: string;
}

const DELIVERED_MESSAGE = "You'll be able to make changes to this subscription once your first order has been delivered.";
const NO_ORDER_REASON = "Your subscription is being set up. " + DELIVERED_MESSAGE;
const NOT_SHIPPED_REASON = "Your first order hasn't shipped yet. " + DELIVERED_MESSAGE;
const IN_TRANSIT_REASON = "Your first order is on its way. " + DELIVERED_MESSAGE;

/** The order-level fields the gate decision looks at. */
export interface GateOrder {
  id: string;
  created_at: string;
  fulfillment_status: string | null;
  delivered_at: string | null;
  easypost_status: string | null;
  easypost_checked_at: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  shopify_order_id: string | null;
}

/**
 * Pure decision — the outer function does the DB read + optional EasyPost lookup
 * side effect. Split so the three-branch predicate (renewal short-circuit,
 * order-level shopify_order_id-null branch, 7-day grace) is unit-testable
 * without touching Supabase.
 */
export type GateDecision =
  | { kind: "allow"; state: "delivered" }
  | { kind: "deny"; state: "no_order" | "not_shipped" | "in_transit"; reason: string }
  | { kind: "easypost_lookup"; tracking: string; carrier: string | null; order: GateOrder };

const FULFILLED_STATUSES = new Set(["fulfilled", "delivered", "partial", "partially_fulfilled"]);

export function decideMutationGate(
  first: GateOrder | undefined,
  orderCount: number,
  now: number,
): GateDecision {
  if (!first) {
    return { kind: "deny", state: "no_order", reason: NO_ORDER_REASON };
  }

  // (a) Renewal short-circuit — a second order only exists because the first
  // billing cycle already completed. Past first delivery ⇒ allowed. Banner off.
  if (orderCount > 1) {
    return { kind: "allow", state: "delivered" };
  }

  // Already known delivered → allow (cheap path, no API call).
  if (first.delivered_at || String(first.easypost_status || "").toLowerCase() === "delivered") {
    return { kind: "allow", state: "delivered" };
  }

  // (b) Branch on the ORDER, not the subscription. shopify_order_id-null = internal.
  const isInternalOrder = first.shopify_order_id == null;

  if (isInternalOrder) {
    const tracking = first.amplifier_tracking_number;
    if (tracking) {
      // Throttle: if we looked it up recently and it wasn't delivered, trust the
      // stored status rather than hitting EasyPost again this visit.
      const checkedAt = first.easypost_checked_at ? new Date(first.easypost_checked_at).getTime() : 0;
      if (checkedAt && now - checkedAt < LOOKUP_THROTTLE_MS) {
        return { kind: "deny", state: "in_transit", reason: IN_TRANSIT_REASON };
      }
      return { kind: "easypost_lookup", tracking, carrier: first.amplifier_carrier, order: first };
    }
    // (c) No tracking yet — fall back to fulfilled + 7-day grace. A fulfilled
    // internal order older than 7 days counts as delivered (Amplifier will
    // never send us a delivered event and the customer shouldn't be trapped).
    const ff = String(first.fulfillment_status || "").toLowerCase();
    const isFulfilledLike = FULFILLED_STATUSES.has(ff);
    const createdAt = new Date(first.created_at).getTime();
    const ageMs = now - createdAt;
    if (isFulfilledLike && ageMs > INTERNAL_FULFILLED_GRACE_MS) {
      return { kind: "allow", state: "delivered" };
    }
    return { kind: "deny", state: "not_shipped", reason: NOT_SHIPPED_REASON };
  }

  // Shopify path — fulfillment status is the best delivery proxy we have.
  const ff = String(first.fulfillment_status || "").toLowerCase();
  if (FULFILLED_STATUSES.has(ff)) {
    return { kind: "allow", state: "delivered" };
  }
  return { kind: "deny", state: "not_shipped", reason: NOT_SHIPPED_REASON };
}

export async function canMutateSubscription(
  workspaceId: string,
  sub: { id: string; is_internal?: boolean | null },
): Promise<MutationGate> {
  const admin = createAdminClient();

  // Fetch the two OLDEST orders — one is enough for the delivery branches,
  // but a second row is the renewal-short-circuit signal (a sub with ≥2 orders
  // is past first delivery, no matter what the first order's state looks like).
  const { data: orders } = await admin
    .from("orders")
    .select("id, created_at, fulfillment_status, delivered_at, easypost_status, easypost_checked_at, amplifier_tracking_number, amplifier_carrier, shopify_order_id")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", sub.id)
    .order("created_at", { ascending: true })
    .limit(2);

  const first = (orders?.[0] as GateOrder | undefined) ?? undefined;
  const orderCount = orders?.length ?? 0;

  const decision = decideMutationGate(first, orderCount, Date.now());

  if (decision.kind === "allow") return { allowed: true, state: decision.state };
  if (decision.kind === "deny") return { allowed: false, state: decision.state, reason: decision.reason };

  // easypost_lookup — live check, then cache the result onto the order.
  try {
    const { lookupTracking } = await import("@/lib/easypost");
    const t = await lookupTracking(workspaceId, decision.tracking, decision.carrier || undefined);
    const status = String(t.status || "").toLowerCase();
    if (status === "delivered") {
      await admin.from("orders")
        .update({ easypost_status: status, delivered_at: new Date().toISOString(), easypost_checked_at: new Date().toISOString() })
        .eq("id", decision.order.id);
      return { allowed: true, state: "delivered" };
    }
    await admin.from("orders")
      .update({ easypost_status: status, easypost_checked_at: new Date().toISOString() })
      .eq("id", decision.order.id);
    return { allowed: false, state: "in_transit", reason: IN_TRANSIT_REASON };
  } catch (e) {
    // Fail open — don't trap a legit customer on an EasyPost hiccup.
    console.warn("[mutation-guard] EasyPost lookup failed, allowing:", e instanceof Error ? e.message : e);
    return { allowed: true, state: "delivered" };
  }
}
