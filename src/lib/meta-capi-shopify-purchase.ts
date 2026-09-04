/**
 * Shopify `orders/create` → Meta CAPI Purchase.
 *
 * The server half of the Shopify pixel pair. The web pixel
 * ([[../../shopify-extension/extensions/meta-pixel]]) fires a browser Purchase on
 * `checkout_completed`; this fires the server copy off the order webhook. Both
 * derive the SAME `shopify_purchase_{checkout_token}` event id, so Meta collapses
 * them into one conversion and keeps the richer copy — which is this one, because
 * the order record carries hashed email, phone, name and address that the browser
 * never sees.
 *
 * ⚠️ THE KEY IS THE CHECKOUT TOKEN, NOT THE ORDER ID. The web pixel's
 * `checkout.order.id` does NOT return a Shopify order id at runtime — it returns an
 * opaque Meta-style token (`EII1|AQAA…|…`), so keying on the order id produced two
 * DIFFERENT ids and every purchase was counted twice. `checkout.token` (pixel) and
 * `checkout_token` (webhook) are the same value on both sides. Verified against a
 * live order 2026-09-04.
 *
 * ⚠️ RENEWALS NEVER SEND. Founder rule 2026-09-02: subscription renewals must not
 * reach CAPI. Crediting a renewal as an ad conversion would inflate acquisition
 * ROAS and steer Meta's optimiser toward audiences that were already customers.
 * Of ~435 weekly orders only ~45 are new web checkouts — so this filter is the
 * difference between a truthful signal and a ~10x inflated one. The allowlist is
 * deliberately POSITIVE (`web` only): a new Shopify `source_name` we've never
 * seen defaults to NOT sending, rather than silently leaking renewals.
 */
import { getActiveMetaSink, sendCapiEvents, deriveFbc, type CapiEvent } from "@/lib/meta-capi";
import { errText } from "@/lib/error-text";

/** The only `orders.source_name` we treat as an ad-attributable new purchase. */
export const CAPI_ALLOWED_SOURCE_NAMES = new Set(["web"]);

/** Why a given order was not forwarded — surfaced for logging, never thrown. */
export type PurchaseSkipReason =
  | "not_web_source"
  | "no_order_id"
  | "zero_value"
  | "test_order";

export interface ShopifyPurchaseDecision {
  send: boolean;
  reason?: PurchaseSkipReason;
  event?: CapiEvent;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Read one Shopify order note_attribute by name. The storefront writes _fbp/_fbc
 *  there at checkout because a webhook cannot see cookies. */
function noteAttr(payload: Record<string, unknown>, name: string): string | null {
  const arr = Array.isArray(payload.note_attributes) ? payload.note_attributes : [];
  for (const a of arr as Array<Record<string, unknown>>) {
    if (str(a?.name) === name) return str(a?.value);
  }
  return null;
}

/**
 * PURE. Decide whether a Shopify order webhook payload should produce a CAPI
 * Purchase, and build it if so. Separated from the send so the renewal filter —
 * the rule with real money behind it — is unit-testable without Supabase or Meta.
 */
export function buildShopifyPurchaseEvent(
  payload: Record<string, unknown>,
  opts?: { fbp?: string | null; fbc?: string | null; fbclid?: string | null; clientIp?: string | null; clientUserAgent?: string | null; nowMs?: number },
): ShopifyPurchaseDecision {
  const orderId = payload.id != null ? String(payload.id) : null;
  if (!orderId) return { send: false, reason: "no_order_id" };
  // The dedup key. Falls back to the order id only so a payload without a checkout
  // token still sends (it simply won't dedup) rather than being dropped.
  const dedupKey = str(payload.checkout_token) ?? orderId;

  // Positive allowlist — see the renewals note above.
  const source = str(payload.source_name);
  if (!source || !CAPI_ALLOWED_SOURCE_NAMES.has(source)) {
    return { send: false, reason: "not_web_source" };
  }

  if (payload.test === true) return { send: false, reason: "test_order" };

  const value = Number(payload.total_price ?? 0);
  if (!Number.isFinite(value) || value <= 0) return { send: false, reason: "zero_value" };

  const customer = (payload.customer ?? {}) as Record<string, unknown>;
  const client = (payload.client_details ?? {}) as Record<string, unknown>;
  const shipping = (payload.shipping_address ?? payload.billing_address ?? {}) as Record<string, unknown>;
  const lineItems = Array.isArray(payload.line_items) ? (payload.line_items as Record<string, unknown>[]) : [];
  const nowMs = opts?.nowMs ?? Date.now();

  const createdAt = str(payload.created_at);
  const eventTimeSec = Math.floor((createdAt ? Date.parse(createdAt) : nowMs) / 1000);

  return {
    send: true,
    event: {
      eventName: "Purchase",
      // MUST match the web pixel's `shopify_purchase_${checkout.token}`.
      eventId: `shopify_purchase_${dedupKey}`,
      eventTimeSec,
      eventSourceUrl: str(payload.order_status_url),
      userData: {
        email: str(payload.email) ?? str(customer.email),
        phone: str(payload.phone) ?? str(customer.phone) ?? str(shipping.phone),
        firstName: str(shipping.first_name) ?? str(customer.first_name),
        lastName: str(shipping.last_name) ?? str(customer.last_name),
        city: str(shipping.city),
        state: str(shipping.province_code) ?? str(shipping.province),
        zip: str(shipping.zip),
        country: str(shipping.country_code) ?? str(shipping.country),
        externalId: customer.id != null ? String(customer.id) : null,
        // A webhook is server-to-server: no cookies, no shopper IP. Without these the
        // event carries perfect PII but nothing tying it to an ad click, which is
        // most of what Meta matches on. Shopify records the real browser IP + UA on
        // the order, and the theme stashes _fbp/_fbc into note_attributes at checkout.
        fbp: opts?.fbp ?? noteAttr(payload, "_fbp"),
        fbc: deriveFbc(opts?.fbc ?? noteAttr(payload, "_fbc"), opts?.fbclid ?? noteAttr(payload, "_fbclid"), nowMs),
        clientIp: opts?.clientIp ?? str(payload.browser_ip) ?? str(client.browser_ip),
        clientUserAgent: opts?.clientUserAgent ?? str(client.user_agent),
      },
      customData: {
        currency: str(payload.currency) ?? "USD",
        value,
        content_type: "product",
        content_ids: lineItems.map((li) => str(li.sku) ?? String(li.product_id ?? "")).filter(Boolean),
        num_items: lineItems.reduce((n, li) => n + Number(li.quantity ?? 0), 0),
        order_id: orderId,
      },
    },
  };
}

/**
 * Send the Purchase for one Shopify order. Never throws — a tracking failure
 * must not fail the webhook, or Shopify will retry the whole order ingest.
 * Returns the decision so the caller can log why an order was skipped.
 */
export async function sendShopifyPurchase(
  workspaceId: string,
  payload: Record<string, unknown>,
  opts?: { fbp?: string | null; fbc?: string | null; fbclid?: string | null; clientIp?: string | null; clientUserAgent?: string | null },
): Promise<{ sent: boolean; reason?: PurchaseSkipReason; status?: number }> {
  const decision = buildShopifyPurchaseEvent(payload, opts);
  if (!decision.send || !decision.event) return { sent: false, reason: decision.reason };

  try {
    const sink = await getActiveMetaSink(workspaceId);
    if (!sink) return { sent: false };
    const res = await sendCapiEvents(sink, [decision.event]);
    if (!res.ok) {
      console.warn(`[capi-purchase] ${res.status} order=${decision.event.eventId}: ${res.body.slice(0, 300)}`);
    }
    return { sent: res.ok, status: res.status };
  } catch (err) {
    console.warn(`[capi-purchase] threw for ${decision.event.eventId}: ${errText(err)}`);
    return { sent: false };
  }
}
