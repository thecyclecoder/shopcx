/**
 * Assemble the OrderForEmail payload sendOrderConfirmationEmail needs
 * for a synced Shopify order (Klaviyo replacement — transactional
 * order-confirmation sends). Three sources merge here:
 *
 *   1. `orders` row (webhook-stored — Phase 2 will start populating
 *      `payment_details.{subtotal,tax,shipping}_cents` + line
 *      `variant_title` at the orders/create webhook so the fast path
 *      is fully self-sufficient).
 *   2. `product_variants` join on `shopify_variant_id` (68/68 hit rate
 *      on real data — image_url + product_id + variant title). Falls
 *      back to the parent `products.image_url` when the variant has
 *      none.
 *   3. Shopify GraphQL `order(id:)` — best-effort backfill for the
 *      totals + line-level variantTitle / compareAtPrice that older
 *      synced rows (and every Appstle subscription renewal, whose
 *      `payment_details` is null) don't carry.
 *
 * GraphQL is best-effort: if it fails, still return with stored
 * totals plus a line-item subtotal fallback (the template already
 * degrades gracefully — gray image box, no strikethrough).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import type { OrderForEmail, OrderLineLike, AddressLike } from "@/lib/email-storefront";

interface OrderRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_order_id: string | null;
  order_number: string | null;
  email: string | null;
  total_cents: number | null;
  line_items: unknown;
  shipping_address: unknown;
  shipping_method_code: string | null;
  payment_details: unknown;
  subscription_id: string | null;
  shipping_protection_added: boolean | null;
  shipping_protection_amount_cents: number | null;
  source_name: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
}

interface StoredLineItem {
  title?: string | null;
  quantity?: number | null;
  price_cents?: number | null;
  sku?: string | null;
  variant_id?: string | null;
  variant_title?: string | null;
  product_id?: string | null;
  total_discount_cents?: number | null;
  is_gift?: boolean | null;
}

interface StoredPaymentDetails {
  subtotal_cents?: number | null;
  shipping_cents?: number | null;
  tax_cents?: number | null;
  discount_cents?: number | null;
  protection_cents?: number | null;
  [k: string]: unknown;
}

interface GraphQLMoney {
  shopMoney?: { amount?: string | null } | null;
}

interface GraphQLLine {
  id?: string;
  variantTitle?: string | null;
  quantity?: number | null;
  originalUnitPriceSet?: GraphQLMoney | null;
  discountedUnitPriceSet?: GraphQLMoney | null;
  variant?: {
    id?: string | null;
    compareAtPrice?: string | null;
  } | null;
}

interface GraphQLOrder {
  subtotalPriceSet?: GraphQLMoney | null;
  totalTaxSet?: GraphQLMoney | null;
  totalShippingPriceSet?: GraphQLMoney | null;
  currentTotalPriceSet?: GraphQLMoney | null;
  lineItems?: { nodes?: GraphQLLine[] } | null;
}

/** Whether the Shopify GraphQL fetch was actually used to fill totals.
 *  Exposed on the resolved object so Phase 4's sender + the Phase 2
 *  verification can log-assert the fast (stored-only) path. */
export type OrderConfirmationData = {
  order: OrderForEmail;
  isFirstOrder: boolean;
  subscribing: boolean;
  nextBillingDate: string | null;
  usedGraphQL: boolean;
};

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function moneyToCents(m: GraphQLMoney | null | undefined): number {
  return dollarsToCents(m?.shopMoney?.amount ?? null);
}

/** Numeric part of a Shopify variant/product GID (`gid://shopify/ProductVariant/12345` → `12345`). */
function gidTail(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = String(id);
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

async function fetchShopifyOrder(
  workspaceId: string,
  shopifyOrderId: string,
): Promise<GraphQLOrder | null> {
  try {
    const { getShopifyCredentials } = await import("@/lib/shopify-sync");
    const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const gid = shopifyOrderId.includes("gid://")
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;
    // Money is returned in shop currency (shopMoney) — matches the
    // stored orders.total_cents which is captured from `total_price`
    // at the same currency. presentmentMoney would be the buyer's
    // currency (not what we want to reconcile against).
    const query = `{
      order(id: "${gid}") {
        subtotalPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        lineItems(first: 100) {
          nodes {
            id
            variantTitle
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
            variant { id compareAtPrice }
          }
        }
      }
    }`;
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { order?: GraphQLOrder | null } };
    return json?.data?.order || null;
  } catch (err) {
    console.warn(
      "[order-confirmation-data] shopify order() GraphQL fetch failed",
      { workspaceId, shopifyOrderId, err: errText(err) },
    );
    return null;
  }
}

/**
 * Resolve an OrderForEmail (+ send inputs) for a synced Shopify order.
 * Pass either a full `orders` row or just the `orderId` — the loader
 * pulls the columns it needs.
 */
export async function getShopifyOrderEmailData(
  order: OrderRow,
): Promise<OrderConfirmationData> {
  const admin = createAdminClient();
  const storedPd = (order.payment_details && typeof order.payment_details === "object"
    ? (order.payment_details as StoredPaymentDetails)
    : {}) as StoredPaymentDetails;
  const storedLines: StoredLineItem[] = Array.isArray(order.line_items)
    ? (order.line_items as StoredLineItem[])
    : [];

  // Do we already have the totals? Phase 2 will make this the common
  // path; today it's rare (older webhook writes never captured them
  // and subscription-renewal rows have payment_details=null).
  const haveStoredTotals =
    typeof storedPd.subtotal_cents === "number"
    && typeof storedPd.shipping_cents === "number"
    && typeof storedPd.tax_cents === "number";

  // Do stored lines already carry variant_title? (Also Phase-2-added.)
  const haveStoredVariantTitles =
    storedLines.length > 0
    && storedLines.every((l) => typeof l.variant_title === "string" && l.variant_title.length > 0);

  // GraphQL only fires when we need something the row can't answer
  // (totals or per-line variantTitle / compareAtPrice). Subscription
  // renewals almost always land here; a Phase-2-webhook order almost
  // never does.
  const needsGraphQL = order.shopify_order_id
    && (!haveStoredTotals || !haveStoredVariantTitles);
  const graphqlOrder = needsGraphQL && order.shopify_order_id
    ? await fetchShopifyOrder(order.workspace_id, order.shopify_order_id)
    : null;
  const usedGraphQL = !!graphqlOrder;

  // Line-level GraphQL match: order by index (Shopify returns lines in
  // the same order they were placed, matching the webhook payload we
  // stored). Fall back to a variant-id map when a size mismatch shows
  // up (shouldn't happen but keeps us defensive).
  const gqlLines: GraphQLLine[] = graphqlOrder?.lineItems?.nodes || [];
  const gqlByVariant = new Map<string, GraphQLLine>();
  for (const l of gqlLines) {
    const vid = gidTail(l.variant?.id);
    if (vid) gqlByVariant.set(vid, l);
  }
  const sameShape = gqlLines.length === storedLines.length;
  function gqlLineFor(idx: number, variantId: string | null | undefined): GraphQLLine | null {
    if (sameShape && gqlLines[idx]) return gqlLines[idx];
    if (variantId) return gqlByVariant.get(String(variantId)) || null;
    return null;
  }

  // Batch-load product_variants for image_url + product_id + title.
  const variantIds = storedLines
    .map((l) => (l.variant_id ? String(l.variant_id) : null))
    .filter((v): v is string => !!v);
  type VariantRow = {
    shopify_variant_id: string | null;
    product_id: string | null;
    title: string | null;
    image_url: string | null;
  };
  let variantRows: VariantRow[] = [];
  if (variantIds.length > 0) {
    const { data } = await admin
      .from("product_variants")
      .select("shopify_variant_id, product_id, title, image_url")
      .eq("workspace_id", order.workspace_id)
      .in("shopify_variant_id", variantIds);
    variantRows = (data as VariantRow[] | null) || [];
  }
  const variantByShopifyId = new Map<string, VariantRow>();
  for (const v of variantRows) {
    if (v.shopify_variant_id) variantByShopifyId.set(v.shopify_variant_id, v);
  }
  // Fallback: parent product image for any variant with no image_url.
  const productIdsMissingImage = Array.from(
    new Set(
      variantRows
        .filter((v) => v.product_id && !v.image_url)
        .map((v) => v.product_id as string),
    ),
  );
  const productImageById = new Map<string, string>();
  if (productIdsMissingImage.length > 0) {
    const { data: prods } = await admin
      .from("products")
      .select("id, image_url")
      .in("id", productIdsMissingImage);
    for (const p of (prods as { id: string; image_url: string | null }[] | null) || []) {
      if (p.image_url) productImageById.set(p.id, p.image_url);
    }
  }

  // Build OrderLineLike[]. This is the single loop that reconciles
  // stored + GraphQL + product_variants; every downstream count/total
  // reads from what we assemble here.
  const outLines: OrderLineLike[] = storedLines.map((li, idx) => {
    const variant = li.variant_id ? variantByShopifyId.get(String(li.variant_id)) : undefined;
    const gql = gqlLineFor(idx, li.variant_id);
    const quantity = toNum(li.quantity);
    // Preferred order for the unit price: GraphQL discountedUnitPrice
    // (the customer-paid unit) → stored price_cents → 0.
    const discountedUnitCents = moneyToCents(gql?.discountedUnitPriceSet);
    const originalUnitCents = moneyToCents(gql?.originalUnitPriceSet);
    const unitPriceCents = discountedUnitCents > 0
      ? discountedUnitCents
      : toNum(li.price_cents);
    const lineDiscountCents = toNum(li.total_discount_cents);
    // Prefer the GraphQL discountedUnit × qty (that's what the customer
    // actually paid); stored fallback subtracts per-line discount.
    const lineTotalCents = discountedUnitCents > 0
      ? discountedUnitCents * quantity
      : Math.max(0, toNum(li.price_cents) * quantity - lineDiscountCents);
    // MSRP: prefer GraphQL compareAtPrice, then originalUnitPrice when
    // it's actually strictly greater than what was paid. Falls through
    // to the variant's stored compareAt only if neither is available.
    let unitMsrpCents: number | undefined = undefined;
    const compareAtCents = dollarsToCents(gql?.variant?.compareAtPrice ?? null);
    if (compareAtCents > unitPriceCents) unitMsrpCents = compareAtCents;
    else if (originalUnitCents > unitPriceCents) unitMsrpCents = originalUnitCents;
    const imageUrl = variant?.image_url
      || (variant?.product_id ? productImageById.get(variant.product_id) : undefined)
      || null;
    const variantTitle = gql?.variantTitle
      || li.variant_title
      || variant?.title
      || null;
    const line: OrderLineLike = {
      title: li.title || "",
      variant_title: variantTitle,
      quantity,
      unit_price_cents: unitPriceCents,
      line_total_cents: lineTotalCents,
      image_url: imageUrl,
      sku: li.sku ?? null,
      product_id: variant?.product_id ?? li.product_id ?? null,
      is_gift: li.is_gift ?? undefined,
    };
    if (unitMsrpCents) line.unit_msrp_cents = unitMsrpCents;
    return line;
  });

  // Totals: prefer stored; fill from GraphQL; last fallback is a
  // line-item subtotal (never let the email render a null total).
  const gqlSubtotalCents = moneyToCents(graphqlOrder?.subtotalPriceSet);
  const gqlTaxCents = moneyToCents(graphqlOrder?.totalTaxSet);
  const gqlShippingCents = moneyToCents(graphqlOrder?.totalShippingPriceSet);
  const gqlCurrentTotalCents = moneyToCents(graphqlOrder?.currentTotalPriceSet);
  const subtotalCents = typeof storedPd.subtotal_cents === "number"
    ? storedPd.subtotal_cents
    : gqlSubtotalCents > 0
      ? gqlSubtotalCents
      : outLines.reduce((s, l) => s + (l.line_total_cents ?? 0), 0);
  const taxCents = typeof storedPd.tax_cents === "number"
    ? storedPd.tax_cents
    : gqlTaxCents;
  const shippingCents = typeof storedPd.shipping_cents === "number"
    ? storedPd.shipping_cents
    : gqlShippingCents;
  // The stored order.total_cents is the customer-paid amount — trust
  // it. Only fall back to GraphQL's currentTotal (which reflects
  // post-adjustment total) when the row itself has none.
  const totalCents = typeof order.total_cents === "number" && order.total_cents > 0
    ? order.total_cents
    : gqlCurrentTotalCents > 0
      ? gqlCurrentTotalCents
      : subtotalCents + taxCents + shippingCents;

  const paymentDetails = {
    ...storedPd,
    subtotal_cents: subtotalCents,
    shipping_cents: shippingCents,
    tax_cents: taxCents,
    protection_cents: typeof storedPd.protection_cents === "number"
      ? storedPd.protection_cents
      : order.shipping_protection_amount_cents ?? undefined,
  } as OrderForEmail["payment_details"];

  const shippingAddress = (order.shipping_address && typeof order.shipping_address === "object"
    ? (order.shipping_address as AddressLike)
    : null);

  const outOrder: OrderForEmail = {
    id: order.id,
    order_number: order.order_number || "",
    email: order.email || "",
    total_cents: totalCents,
    line_items: outLines,
    shipping_address: shippingAddress,
    shipping_method_code: order.shipping_method_code,
    payment_details: paymentDetails,
    shipping_protection_added: order.shipping_protection_added ?? undefined,
    shipping_protection_amount_cents: order.shipping_protection_amount_cents,
    amplifier_tracking_number: order.amplifier_tracking_number,
    amplifier_carrier: order.amplifier_carrier,
    subscription_id: order.subscription_id,
  };

  // Send inputs the sender needs alongside the order object.
  // isFirstOrder: any prior order for this customer (same query as
  // /api/checkout/route.ts:1174). No customer_id → treat as first.
  let isFirstOrder = true;
  if (order.customer_id) {
    const { count } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", order.workspace_id)
      .eq("customer_id", order.customer_id)
      .neq("id", order.id);
    isFirstOrder = !count;
  }
  const subscribing = !!order.subscription_id;
  let nextBillingDate: string | null = null;
  if (order.subscription_id) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("next_billing_date")
      .eq("id", order.subscription_id)
      .maybeSingle();
    nextBillingDate = (sub?.next_billing_date as string | null) || null;
  }

  return { order: outOrder, isFirstOrder, subscribing, nextBillingDate, usedGraphQL };
}

/** The `orders` row columns getShopifyOrderEmailData reads.
 *  Exported so a caller (Phase 4 sender, verification script) can
 *  select exactly these — no more, no less. */
export const ORDER_EMAIL_ROW_COLS =
  "id, workspace_id, customer_id, shopify_order_id, order_number, email, total_cents, line_items, shipping_address, shipping_method_code, payment_details, subscription_id, shipping_protection_added, shipping_protection_amount_cents, source_name, amplifier_tracking_number, amplifier_carrier" as const;

/** Convenience loader used by the verification script — grabs the row
 *  by id then resolves. Callers that already hold the row should call
 *  `getShopifyOrderEmailData(row)` directly. */
export async function getShopifyOrderEmailDataById(
  workspaceId: string,
  orderId: string,
): Promise<OrderConfirmationData | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select(ORDER_EMAIL_ROW_COLS)
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  if (!data) return null;
  return getShopifyOrderEmailData(data as unknown as OrderRow);
}
