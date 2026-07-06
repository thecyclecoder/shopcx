// Portal order-detail — reads via the commerce SDK
// (@/lib/commerce/order.getOrder), the single detail op for orders.
// Enriches with line-item images and the extra order-row fields the
// SDK view doesn't carry (tax, shipping protection, discount codes).
//
// AUTHZ: the returned order MUST belong to the logged-in customer's
// link group. A stranger's order id returns 404 (not 403) — never
// leak the existence of someone else's order.

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrder } from "@/lib/commerce/order";
import { enrichLineItemImages } from "@/lib/portal/helpers/image-fallback";
import { resolveOrderDelivery, type DeliveryResolverInput } from "@/lib/portal/helpers/delivery-resolver";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const orderDetail: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const idParam = (url.searchParams.get("id") || "").trim();
  if (!idParam || !UUID_RE.test(idParam)) return jsonErr({ error: "missing_id" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Expand to the caller's link group — the same customer-link ownership
  // check other portal reads use. A customer can only view their OWN
  // orders (self + any linked profile in the same group).
  let linkedIds = [customer.id];
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (link?.group_id) {
    const { data: group } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    linkedIds = (group || []).map((r) => r.customer_id as string);
    if (!linkedIds.includes(customer.id)) linkedIds.push(customer.id);
  }

  // Fetch through the commerce SDK — the single detail op for orders.
  let view;
  try {
    view = await getOrder(auth.workspaceId, idParam);
  } catch {
    return jsonErr({ error: "order_not_found" }, 404);
  }

  // Ownership check: order must belong to the caller's link group.
  // Return 404 (not 403) so we don't leak existence.
  if (!view.customer_id || !linkedIds.includes(view.customer_id)) {
    return jsonErr({ error: "order_not_found" }, 404);
  }

  // Row-level extras the SDK view doesn't carry — the raw line_items
  // (view strips variant_title / is_gift), tax (internal orders via
  // Avalara), shipping-protection line, discount codes, and the fields
  // the honest-status classifier keys on (shopify_order_id +
  // easypost_status). Kept in this handler so the SDK stays a pure
  // display op.
  const { data: row } = await admin
    .from("orders")
    .select(
      "shopify_order_id, easypost_status, easypost_checked_at, easypost_tracking, fulfillments, avalara_total_tax_cents, shipping_protection_added, shipping_protection_amount_cents, discount_codes, amplifier_tracking_number, amplifier_carrier, amplifier_status, amplifier_shipped_at, line_items",
    )
    .eq("workspace_id", auth.workspaceId)
    .eq("id", view.id)
    .maybeSingle();

  // Normalize the raw line_items to the shape the OrderDetailScreen
  // reads. Keep variant_title / is_gift (dropped by the SDK view) and
  // recompute line total from per-unit + qty when the row doesn't
  // carry a line_total_cents.
  interface RawLine {
    title?: string;
    variant_title?: string | null;
    variant_id?: string | number | null;
    product_id?: string | number | null;
    sku?: string | null;
    quantity?: number;
    price_cents?: number | null;
    unit_price_cents?: number | null;
    line_total_cents?: number | null;
    is_gift?: boolean;
    image_url?: string | null;
  }
  const rawLines: RawLine[] = Array.isArray(row?.line_items) ? (row!.line_items as RawLine[]) : [];
  const normalizedLines = rawLines.map((l) => {
    const qty = Number(l.quantity ?? 1);
    const unit = Number(l.price_cents ?? l.unit_price_cents ?? 0) || 0;
    const total = Number(l.line_total_cents ?? unit * qty) || 0;
    return {
      variant_id: l.variant_id != null ? String(l.variant_id) : null,
      product_id: l.product_id != null ? String(l.product_id) : null,
      title: l.title ?? "",
      variant_title: l.variant_title ?? null,
      sku: l.sku ?? null,
      quantity: qty,
      unit_cents: unit,
      total_cents: total,
      is_gift: !!l.is_gift,
      image_url: l.image_url ?? null,
    };
  });

  // Enrich line-item images from the products/variants catalog so the
  // detail cards never render gray placeholders when we have a Shopify
  // image available.
  const [enriched] = await enrichLineItemImages(
    admin,
    auth.workspaceId,
    [{ line_items: normalizedLines }],
  );
  const enrichedLineItems = (enriched.line_items ?? normalizedLines) as typeof normalizedLines;

  // Delivery / tracking resolver (Phase 2 of the tracking-widget spec).
  // Keyed per order on shopify_order_id — INTERNAL runs a paid EasyPost
  // Tracker lookup (throttled to once per UTC day, terminal on
  // delivered); SHOPIFY reads the synced fulfillments and refreshes them
  // via a free Shopify GraphQL fetch. Never calls EasyPost on the
  // Shopify branch. Persists any refresh on the orders row.
  const trackingNumber = (view.tracking_number || row?.amplifier_tracking_number || null) as
    | string
    | null;
  const carrier = (view.carrier || row?.amplifier_carrier || null) as string | null;
  const resolverInput: DeliveryResolverInput = {
    workspaceId: auth.workspaceId,
    orderId: view.id,
    shopifyOrderId: row?.shopify_order_id ?? null,
    trackingNumber,
    carrier,
    delivered_at: view.delivered_at ?? null,
    easypost_status: row?.easypost_status ?? null,
    easypost_checked_at: row?.easypost_checked_at ?? null,
    easypost_tracking: row?.easypost_tracking ?? null,
    fulfillments: row?.fulfillments ?? null,
  };
  const delivery = await resolveOrderDelivery(admin, resolverInput);

  const subtotalCents = enrichedLineItems.reduce((s, l) => s + (l.total_cents || 0), 0);
  const discountCodes = Array.isArray(row?.discount_codes)
    ? (row!.discount_codes as Array<Record<string, unknown>>)
    : [];
  const discountCents = discountCodes.reduce((s, d) => {
    const v = Number(d?.amount ?? d?.amount_cents ?? 0);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const taxCents = Number(row?.avalara_total_tax_cents ?? 0) || 0;
  const shippingProtectionCents = row?.shipping_protection_added
    ? Number(row?.shipping_protection_amount_cents ?? 0) || 0
    : 0;
  const shippingCents = Math.max(
    0,
    view.total_cents - subtotalCents + discountCents - taxCents - shippingProtectionCents,
  );

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    order: {
      id: view.id,
      order_number: view.order_number,
      created_at: view.created_at,
      // delivered_at reflects any refresh the delivery resolver just
      // stamped, not just the value the SDK view read pre-resolve.
      delivered_at: delivery.delivered_at,
      currency: view.currency,
      financial_status: view.financial_status,
      fulfillment_status: view.fulfillment_status,
      // Fields the honest status classifier keys on. shopify_order_id
      // (NULL = internal) + easypost_status live on the row, not the
      // SDK view — pull them inline so the classifier can tell internal
      // vs Shopify orders apart.
      shopify_order_id: row?.shopify_order_id ?? null,
      easypost_status: row?.easypost_status ?? null,
      total_cents: view.total_cents,
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      shipping_protection_added: !!row?.shipping_protection_added,
      shipping_protection_amount_cents: shippingProtectionCents,
      line_items: enrichedLineItems,
      tracking_number: trackingNumber,
      carrier,
      amplifier_status: row?.amplifier_status ?? null,
      amplifier_shipped_at: row?.amplifier_shipped_at ?? null,
      amplifier_tracking_number: row?.amplifier_tracking_number ?? null,
      shipping_address: view.shipping_address,
      discount_codes: discountCodes,
      // Delivery / tracking widget payload (Phase 2). Widget layer keys
      // off `delivery.kind` — 'internal' renders the EasyPost milestone
      // timeline from `delivery.easypost_tracking.events`, 'shopify'
      // renders the shipment status + trackingInfo from
      // `delivery.fulfillments`, 'none' renders no widget.
      delivery,
    },
  });
};
