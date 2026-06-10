/**
 * First-delivery mutation gate.
 *
 * Customers can't modify a subscription (swap / qty / add / remove / change
 * date / frequency / pause / coupon / shipping protection) until the FIRST
 * order from that subscription has been delivered. This blocks "subscribe for
 * the intro deal, then immediately swap to something pricier / change the
 * schedule before the first box even ships."
 *
 * Delivery signal differs by sub type:
 *   - internal (Amplifier-fulfilled): we DON'T buy the EasyPost label, so we
 *     never get a delivered webhook from EasyPost, and Amplifier only ever
 *     sends us the tracking number — never a delivered event. So a LIVE
 *     EasyPost lookup on portal visit is the ONLY delivery signal. We cache the
 *     result back onto the order (so once delivered it's a cheap read forever,
 *     and repeat visits are throttled to avoid hammering EasyPost). No tracking
 *     number yet = not shipped = locked.
 *   - Appstle/Shopify: the order's `fulfillment_status` (Shopify orders get
 *     fulfillment via Shopify; NO EasyPost lookup). "fulfilled" = shipped.
 *
 * Fails OPEN (allows the mutation) on an EasyPost error — this is an
 * anti-gaming gate, not a security control, and we never want an API hiccup to
 * trap a legitimate customer whose order really did arrive.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Don't re-hit EasyPost more than once per this window per order. */
const LOOKUP_THROTTLE_MS = 30 * 60 * 1000;

export interface MutationGate {
  allowed: boolean;
  reason?: string;
  /** Coarse state for the UI: 'no_order' | 'not_shipped' | 'in_transit' | 'delivered'. */
  state?: string;
}

const DELIVERED_MESSAGE = "You'll be able to make changes to this subscription once your first order has been delivered.";

export async function canMutateSubscription(
  workspaceId: string,
  sub: { id: string; is_internal?: boolean | null },
): Promise<MutationGate> {
  const admin = createAdminClient();

  // First (oldest) order for this subscription.
  const { data: orders } = await admin
    .from("orders")
    .select("id, created_at, fulfillment_status, delivered_at, easypost_status, easypost_checked_at, amplifier_tracking_number, amplifier_carrier")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", sub.id)
    .order("created_at", { ascending: true })
    .limit(1);

  const first = orders?.[0];
  if (!first) {
    return { allowed: false, state: "no_order", reason: "Your subscription is being set up. " + DELIVERED_MESSAGE };
  }

  // Already known delivered → allow (cheap path, no API call).
  if (first.delivered_at || String(first.easypost_status || "").toLowerCase() === "delivered") {
    return { allowed: true, state: "delivered" };
  }

  const isInternal = sub.is_internal === true;

  if (isInternal) {
    const tracking = first.amplifier_tracking_number as string | null;
    // No tracking number yet → hasn't shipped.
    if (!tracking) {
      return { allowed: false, state: "not_shipped", reason: "Your first order hasn't shipped yet. " + DELIVERED_MESSAGE };
    }
    // Throttle: if we looked it up recently and it wasn't delivered, trust the
    // stored status rather than hitting EasyPost again this visit.
    const checkedAt = first.easypost_checked_at ? new Date(first.easypost_checked_at as string).getTime() : 0;
    if (checkedAt && Date.now() - checkedAt < LOOKUP_THROTTLE_MS) {
      return { allowed: false, state: "in_transit", reason: "Your first order is on its way. " + DELIVERED_MESSAGE };
    }
    // Live EasyPost lookup — the only delivery signal we get for Amplifier orders.
    try {
      const { lookupTracking } = await import("@/lib/easypost");
      const t = await lookupTracking(workspaceId, tracking, (first.amplifier_carrier as string | null) || undefined);
      const status = String(t.status || "").toLowerCase();
      if (status === "delivered") {
        // Sync the discovery back to the order so we don't re-lookup next time.
        await admin.from("orders")
          .update({ easypost_status: status, delivered_at: new Date().toISOString(), easypost_checked_at: new Date().toISOString() })
          .eq("id", first.id as string);
        return { allowed: true, state: "delivered" };
      }
      await admin.from("orders")
        .update({ easypost_status: status, easypost_checked_at: new Date().toISOString() })
        .eq("id", first.id as string);
      return { allowed: false, state: "in_transit", reason: "Your first order is on its way. " + DELIVERED_MESSAGE };
    } catch (e) {
      // Fail open — don't trap a legit customer on an EasyPost hiccup.
      console.warn("[mutation-guard] EasyPost lookup failed, allowing:", e instanceof Error ? e.message : e);
      return { allowed: true, state: "delivered" };
    }
  }

  // Appstle/Shopify — fulfillment status is the best delivery proxy we have.
  const ff = String(first.fulfillment_status || "").toLowerCase();
  if (ff === "fulfilled" || ff === "delivered" || ff === "partial" || ff === "partially_fulfilled") {
    return { allowed: true, state: "delivered" };
  }
  return { allowed: false, state: "not_shipped", reason: "Your first order hasn't shipped yet. " + DELIVERED_MESSAGE };
}
