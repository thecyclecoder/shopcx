/**
 * Portal order-detail delivery/tracking resolver.
 *
 * (docs/brain/specs/portal-order-detail-tracking-widget.md, Phase 2.)
 *
 * Given ONE order the caller already fetched, decide whether to refresh
 * the delivery signal and — if so — do it against the right source, then
 * persist the result. Called from src/lib/portal/handlers/order-detail.ts
 * before returning the JSON to the customer, so a repeat visit to a
 * shipped-but-not-yet-delivered order picks up any progress since last
 * time.
 *
 * Two branches, keyed per order on shopify_order_id:
 *
 *   INTERNAL (shopify_order_id NULL). Delivery is a PAID EasyPost Tracker
 *   lookup. Order:
 *     1. delivered_at OR easypost_status='delivered' → nothing to do,
 *        return the stored easypost_tracking (delivered is terminal;
 *        never look up again).
 *     2. easypost_checked_at is the SAME UTC DAY as now → return the
 *        stored blob (daily throttle — repeat visits don't bill
 *        EasyPost).
 *     3. Otherwise → call lookupTracking, write events into
 *        easypost_tracking + easypost_status + easypost_checked_at=now
 *        (if status='delivered' ALSO set delivered_at, which stops all
 *        future lookups).
 *   EasyPost error → fail-open (return no widget rather than trap the
 *   page).
 *
 *   SHOPIFY (shopify_order_id present). Delivery already lives on the
 *   order (fulfillments.shipmentStatus + trackingInfo, synced by
 *   shopify-webhooks.ts). Shopify GraphQL refresh is FREE — no per-lookup
 *   cost, so no hard throttle. Order:
 *     1. delivered_at set → nothing to do (delivered is terminal).
 *     2. Otherwise → free live Shopify GraphQL fulfillment refresh; if
 *        it succeeds, persist the new fulfillments; if any
 *        shipmentStatus='delivered' also set delivered_at.
 *   Refresh failure → fail-open (keep the stored blob).
 *
 * Invariants (do not weaken):
 *   • NEVER call EasyPost on the Shopify branch.
 *   • Every mutation is compare-and-set (workspace_id + id + expected
 *     column state) with .select("id") so a stale async read cannot
 *     overwrite a fresher delivered_at from another request.
 *   • delivered_at, once set, is never overwritten.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import type { TrackingStatus } from "@/lib/easypost";
import type { StoredFulfillment } from "@/lib/shopify-sync";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface DeliveryResolverInput {
  workspaceId: string;
  orderId: string;
  shopifyOrderId: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  delivered_at: string | null;
  easypost_status: string | null;
  easypost_checked_at: string | null;
  easypost_tracking: unknown;
  fulfillments: unknown;
}

export interface DeliveryResolverOutput {
  /** 'internal' = EasyPost-tracked shipment. 'shopify' = Shopify fulfillment. 'none' = not shipped / no widget. */
  kind: "internal" | "shopify" | "none";
  /** ISO timestamp when the shipment was confirmed delivered (either source), or null. */
  delivered_at: string | null;
  /** INTERNAL only — the cached / refreshed EasyPost events blob (jsonb). Null on the Shopify branch. */
  easypost_tracking: unknown;
  /** SHOPIFY only — the cached / refreshed fulfillments blob. Null on the internal branch. */
  fulfillments: StoredFulfillment[] | unknown;
}

function sameUtcDay(a: Date, b: Date | null): boolean {
  if (!b) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Run the delivery resolver against ONE order. Mutates public.orders
 * when a fresh signal is fetched; the caller reads the returned shape
 * and hands it to the widget layer.
 */
export async function resolveOrderDelivery(
  admin: AdminClient,
  input: DeliveryResolverInput,
): Promise<DeliveryResolverOutput> {
  const { workspaceId, orderId, shopifyOrderId } = input;

  // ── SHOPIFY branch ────────────────────────────────────────────────
  // Delivery signal lives on the synced fulfillments. Shopify GraphQL
  // refresh is FREE — no EasyPost cost, no daily throttle. Delivered is
  // terminal (stop refreshing).
  if (shopifyOrderId) {
    const storedFulfillments = Array.isArray(input.fulfillments)
      ? (input.fulfillments as StoredFulfillment[])
      : [];
    // Not yet shipped — no fulfillments at all → no widget.
    if (storedFulfillments.length === 0) {
      return { kind: "none", delivered_at: input.delivered_at, easypost_tracking: null, fulfillments: null };
    }
    // Already delivered → nothing to refresh (delivered is terminal).
    if (input.delivered_at) {
      return {
        kind: "shopify",
        delivered_at: input.delivered_at,
        easypost_tracking: null,
        fulfillments: storedFulfillments,
      };
    }
    // Live free refresh.
    const { fetchShopifyOrderFulfillments } = await import("@/lib/shopify-sync");
    const fresh = await fetchShopifyOrderFulfillments(workspaceId, shopifyOrderId);
    if (!fresh || fresh.length === 0) {
      // Fail-open: keep the stored blob.
      return {
        kind: "shopify",
        delivered_at: input.delivered_at,
        easypost_tracking: null,
        fulfillments: storedFulfillments,
      };
    }
    const delivered = fresh.some((f) => (f.shipmentStatus || "").toLowerCase() === "delivered");
    const nextDeliveredAt = delivered && !input.delivered_at ? new Date().toISOString() : input.delivered_at;
    // Compare-and-set: workspace + id must still match, AND delivered_at
    // must still be null when we're writing one (never overwrite a
    // fresher delivered_at from a parallel request).
    const patch: Record<string, unknown> = { fulfillments: fresh };
    if (delivered && !input.delivered_at) patch.delivered_at = nextDeliveredAt;
    let q = admin
      .from("orders")
      .update(patch)
      .eq("workspace_id", workspaceId)
      .eq("id", orderId);
    if (delivered && !input.delivered_at) q = q.is("delivered_at", null);
    const { data: rows } = await q.select("id");
    // If the compare-and-set matched zero rows (delivered_at was set by
    // another request in the meantime), leave the returned state on
    // what we read — the caller will still render Delivered next visit.
    void rows;
    return {
      kind: "shopify",
      delivered_at: nextDeliveredAt,
      easypost_tracking: null,
      fulfillments: fresh,
    };
  }

  // ── INTERNAL branch ───────────────────────────────────────────────
  // Delivery signal comes from a PAID EasyPost Tracker lookup. Daily
  // throttle; delivered is terminal (never look up again).
  const tracking = input.trackingNumber || null;
  // Not yet shipped (no tracking number) → no widget.
  if (!tracking) {
    return { kind: "none", delivered_at: input.delivered_at, easypost_tracking: null, fulfillments: null };
  }
  const storedTracking = input.easypost_tracking ?? null;
  // Already delivered (either signal) → nothing to look up.
  const alreadyDelivered =
    !!input.delivered_at || (input.easypost_status || "").toLowerCase() === "delivered";
  if (alreadyDelivered) {
    return {
      kind: "internal",
      delivered_at: input.delivered_at,
      easypost_tracking: storedTracking,
      fulfillments: null,
    };
  }
  // Daily throttle — same-UTC-day cache hit skips the paid lookup.
  const now = new Date();
  const checkedAt = input.easypost_checked_at ? new Date(input.easypost_checked_at) : null;
  if (sameUtcDay(now, checkedAt) && storedTracking) {
    return {
      kind: "internal",
      delivered_at: input.delivered_at,
      easypost_tracking: storedTracking,
      fulfillments: null,
    };
  }
  // Miss the cache — paid lookup. Fail-open on EasyPost error.
  let fresh: TrackingStatus | null = null;
  try {
    const { lookupTracking } = await import("@/lib/easypost");
    fresh = await lookupTracking(workspaceId, tracking, input.carrier || undefined);
  } catch {
    fresh = null;
  }
  if (!fresh) {
    // Fail-open — return whatever we had cached (or null) with no side-effects.
    return {
      kind: "internal",
      delivered_at: input.delivered_at,
      easypost_tracking: storedTracking,
      fulfillments: null,
    };
  }
  const nowIso = now.toISOString();
  const isDelivered = (fresh.status || "").toLowerCase() === "delivered";
  const nextDeliveredAt = isDelivered && !input.delivered_at ? nowIso : input.delivered_at;
  const patch: Record<string, unknown> = {
    easypost_tracking: fresh,
    easypost_status: fresh.status,
    easypost_checked_at: nowIso,
  };
  if (isDelivered && !input.delivered_at) patch.delivered_at = nextDeliveredAt;
  let q = admin
    .from("orders")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("id", orderId);
  if (isDelivered && !input.delivered_at) q = q.is("delivered_at", null);
  const { data: rows } = await q.select("id");
  void rows;
  return {
    kind: "internal",
    delivered_at: nextDeliveredAt,
    easypost_tracking: fresh,
    fulfillments: null,
  };
}
