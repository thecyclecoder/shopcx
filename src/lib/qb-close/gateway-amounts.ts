/**
 * qb-close/gateway-amounts — resolve the ACTUAL captured amount per gateway for split-payment
 * Shopify orders, so the journal entry's clearing debits land on the accounts that really
 * received the money.
 *
 * ⭐ `payment_gateway_names` lists every gateway ATTEMPTED, not those that captured. Dividing an
 * order's total equally among them credits clearing accounts that received nothing. Measured
 * across July 2026's 12 split-payment orders: **$1,540.23 of absolute misallocation** — Braintree
 * was credited $214.63 having captured $0.00, Shopify Payments was short $311.98, and one order
 * (SC134526) listed three gateways while a single one took the entire $263.51.
 *
 * Only orders with MORE THAN ONE gateway need this: 12 of 2,048 in July. A single-gateway order's
 * total already belongs entirely to that gateway, so it is left alone and costs no API call.
 *
 * See docs/brain/libraries/qb-close-gateway-amounts.md.
 */
import type { ShopifyOrder } from "./journal-entry";

/** Transaction kinds that MOVE money in. Authorizations and voids must not count. */
const CAPTURING_KINDS = new Set(["sale", "capture"]);

export interface GatewayAmountsResult {
  /** orders that were annotated (i.e. had >1 gateway and resolved) */
  resolved: number;
  /** orders with >1 gateway whose transactions could not be read — left on the equal-split */
  failed: number;
  /** total absolute difference between the actual split and what an equal split would have given */
  correction: number;
}

interface ShopifyTxn {
  kind?: string;
  status?: string;
  gateway?: string;
  amount?: string | number;
}

/**
 * Annotate `gateway_amounts` in place on every split-payment order.
 *
 * Mutates the passed orders (they are request-scoped) and returns what changed, so a caller can
 * log the correction rather than applying a silent adjustment to the books.
 */
export async function annotateGatewayAmounts(
  orders: (ShopifyOrder & { id?: number | string })[],
  shopDomain: string,
  accessToken: string,
): Promise<GatewayAmountsResult> {
  let resolved = 0;
  let failed = 0;
  let correction = 0;

  for (const order of orders) {
    const gateways = order.payment_gateway_names ?? [];
    if (gateways.length <= 1 || !order.id) continue;

    try {
      const res = await fetch(`https://${shopDomain}/admin/api/2024-01/orders/${order.id}/transactions.json`, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) throw new Error(`transactions ${res.status}`);
      const txns = ((await res.json()).transactions ?? []) as ShopifyTxn[];

      const byGateway: Record<string, number> = {};
      for (const t of txns) {
        if (!CAPTURING_KINDS.has(String(t.kind)) || t.status !== "success" || !t.gateway) continue;
        byGateway[t.gateway] = (byGateway[t.gateway] ?? 0) + Number(t.amount ?? 0);
      }

      // If nothing captured, leave the order alone rather than zeroing its clearing debits —
      // an empty map would silently drop the order's gross from every clearing account.
      const captured = Object.values(byGateway).reduce((a, b) => a + b, 0);
      if (captured <= 0) {
        failed++;
        continue;
      }

      const equalShare = Number(order.total_price ?? 0) / gateways.length;
      for (const gw of new Set([...gateways, ...Object.keys(byGateway)])) {
        correction += Math.abs((byGateway[gw] ?? 0) - (gateways.includes(gw) ? equalShare : 0));
      }

      order.gateway_amounts = byGateway;
      resolved++;
    } catch {
      // Leave the order on the equal-split fallback. Wrong, but survivable and visible in the
      // returned `failed` count — better than dropping the order's gross entirely.
      failed++;
    }
  }

  return { resolved, failed, correction: Math.round(correction * 100) / 100 };
}
