/**
 * Avalara helpers for internal subscriptions:
 *
 *   • quoteSubscriptionTax(workspaceId, subscriptionId)
 *       Calls Avalara `SalesOrder` (commit=false) — non-filing — and
 *       saves the result to subscriptions.avalara_quote_*. Used by
 *       the customer portal to show the actual renewal total.
 *
 *   • commitSubscriptionRenewalTax(workspaceId, subscriptionId, args)
 *       Calls Avalara `SalesInvoice` (commit=true) using the renewal
 *       order_number as the code. The returned tax_cents is the
 *       authoritative tax the renewal will charge.
 *
 * Both reuse `buildAvalaraLines` so the customer-displayed portal
 * tax and the renewal-charged tax stay in sync (Avalara is
 * deterministic for the same inputs).
 *
 * Both gracefully no-op (return null tax) when Avalara isn't enabled
 * for the workspace — same convention as the checkout tax-quote
 * endpoint.
 */
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTransaction } from "@/lib/avalara";
import { buildAvalaraLines, type CartLineForTax } from "@/lib/avalara-cart";

interface SubAddress {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  provinceCode?: string;
  province_code?: string;
  zip?: string;
  country?: string;
  countryCode?: string;
  country_code?: string;
  // Some sources nest as { address: {...} }
}

function normalizeAddress(raw: unknown): {
  line1: string; line2: string; city: string; region: string; postalCode: string; country: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  const a: SubAddress = r.address || r;
  const line1 = a.address1 || "";
  const city = a.city || "";
  const region = (a.provinceCode || a.province_code || a.province || "").toUpperCase();
  const postalCode = a.zip || "";
  const country = (a.countryCode || a.country_code || a.country || "US").toUpperCase();
  if (!line1 || !city || !region || !postalCode) return null;
  return {
    line1,
    line2: a.address2 || "",
    city,
    region: region.length > 2 ? region.slice(0, 2) : region,
    postalCode,
    country: country.length > 2 ? country.slice(0, 2) : country,
  };
}

interface RenewalSubFields {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  items: unknown;
  shipping_address: unknown;
  delivery_price_cents: number | null;
  shipping_protection_added: boolean | null;
  shipping_protection_amount_cents: number | null;
  email?: string | null;
}

async function resolveSubAddress(
  workspaceId: string,
  sub: RenewalSubFields,
): Promise<ReturnType<typeof normalizeAddress>> {
  const fromSub = normalizeAddress(sub.shipping_address);
  if (fromSub) return fromSub;
  // Fall back to the customer's most recent order shipping address.
  if (!sub.customer_id) return null;
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("shipping_address")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", sub.customer_id)
    .not("shipping_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return normalizeAddress(order?.shipping_address);
}

interface SubItem extends CartLineForTax {
  delivery_price_cents?: number;
}

function subItemsToCartLines(items: unknown): CartLineForTax[] {
  if (!Array.isArray(items)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (items as any[]).map((i) => ({
    variant_id: i.variant_id,
    product_id: i.product_id,
    shopify_variant_id: i.shopify_variant_id || null,
    sku: i.sku || null,
    title: i.title || "",
    variant_title: i.variant_title || null,
    quantity: Number(i.quantity || 0),
    unit_price_cents: Number(i.price_cents || i.unit_price_cents || 0),
    line_total_cents: Number(i.price_cents || i.unit_price_cents || 0) * Number(i.quantity || 0),
    is_gift: !!i.is_gift,
  } as SubItem));
}

interface PricedTaxItem {
  variant_id: string; product_id: string | null; sku: string | null;
  title: string; variant_title: string; quantity: number; price_cents: number;
}
interface TaxInputs {
  pricedItems: PricedTaxItem[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  protectionCents: number;
  shipTo: NonNullable<Awaited<ReturnType<typeof resolveSubAddress>>>;
}

/**
 * Build the tax-determining inputs for an internal sub: engine-priced product
 * lines + rule-decided shipping + protection column + resolved ship-to. Pure of
 * Avalara — used both to compute a quote and to detect staleness. Returns null
 * when the sub can't be quoted (wrong status / no items / no address).
 *
 * Entire-order coupons on the sub are applied to the Avalara-facing line prices
 * by the same ratio the renewal uses (internal-subscription-renewals.ts:519-524)
 * so the portal-quoted tax matches the actual renewal charge on a coupon'd sub.
 * subtotalCents on the return stays the FULL pre-coupon subtotal — the caller
 * subtracts discountCents for the post-coupon total.
 */
async function buildTaxInputs(
  workspaceId: string,
  sub: Record<string, unknown>,
): Promise<TaxInputs | null> {
  if (!["active", "paused"].includes(sub.status as string)) return null;
  const { resolveSubscriptionPricing } = await import("@/lib/pricing");
  const pricing = await resolveSubscriptionPricing(workspaceId, sub as { items?: unknown; delivery_price_cents?: number | null });
  const enginePriced = pricing.lines
    .filter((l) => l.kind === "product")
    .map((l) => ({ variant_id: l.variant_id, product_id: l.product_id, sku: l.sku, title: l.title, variant_title: l.variant_title, quantity: l.quantity, price_cents: l.unit_cents }));
  if (enginePriced.length === 0) return null;
  const subtotalCents = pricing.product_subtotal_cents;
  if (subtotalCents <= 0) return null;
  const shippingCents = pricing.shipping_cents;
  const protectionCents = sub.shipping_protection_added ? Number(sub.shipping_protection_amount_cents || 0) : 0;
  const shipTo = await resolveSubAddress(workspaceId, sub as unknown as RenewalSubFields);
  if (!shipTo) return null;

  const { resolveRenewalDiscount } = await import("@/lib/coupons");
  const { discountCents } = await resolveRenewalDiscount(
    workspaceId,
    (sub.applied_discounts as Array<Record<string, unknown>> | null) ?? null,
    subtotalCents,
    (sub.customer_id as string | null) ?? null,
  );

  const pricedItems: PricedTaxItem[] = discountCents > 0 && subtotalCents > 0
    ? enginePriced.map((i) => ({
        ...i,
        price_cents: Math.round(i.price_cents * (subtotalCents - discountCents) / subtotalCents),
      }))
    : enginePriced;

  return { pricedItems, subtotalCents, discountCents, shippingCents, protectionCents, shipTo };
}

/**
 * Deterministic hash of the inputs that determine tax. A change here (items,
 * quantities, engine-derived prices from a catalog/rule edit, shipping,
 * protection, or ship-to) invalidates the cached quote — robust to DYNAMIC
 * pricing where the sub row's updated_at would NOT change.
 */
function hashTaxInputs(inputs: TaxInputs): string {
  const items = inputs.pricedItems
    .map((l) => `${l.variant_id}:${l.quantity}:${l.price_cents}`)
    .sort();
  const payload = JSON.stringify({ items, s: inputs.shippingCents, p: inputs.protectionCents, a: inputs.shipTo });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * Quote tax for a sub's next renewal (SalesOrder, no filing). Saves
 * to subscriptions.avalara_quote_* (incl. the input hash). Returns
 * { tax_cents, total_cents } or null when Avalara isn't enabled / the
 * sub can't be quoted yet.
 */
export async function quoteSubscriptionTax(
  workspaceId: string,
  subscriptionId: string,
): Promise<{ tax_cents: number; total_cents: number } | null> {
  const admin = createAdminClient();

  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_enabled, shipping_protection_title")
    .eq("id", workspaceId)
    .single();
  if (!ws?.avalara_enabled) return null;

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, workspace_id, customer_id, items, applied_discounts, shipping_address, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents, shipping_method_code, status, is_internal, comp")
    .eq("id", subscriptionId)
    .single();
  if (!sub || !sub.is_internal) return null;
  // A comp (free) sub owes $0 tax — resolve to a concrete $0 quote so the portal
  // shows "$0.00" instead of a permanent "Calculating…". No Avalara call: a comp
  // renewal charges nothing (internal-subscription-renewals.ts prices comp lines
  // at $0), so there's nothing to tax and nothing to file.
  if (sub.comp) return { tax_cents: 0, total_cents: 0 };

  // Engine-priced inputs (catalog + rules) — internal sub items carry no baked
  // price. Mirrors the renewal: tax quoted on the engine subtotal + rule-decided
  // shipping, with entire-order coupons applied to the taxable base (buildTaxInputs
  // scales the Avalara-facing line prices by the coupon ratio, same as
  // internal-subscription-renewals.ts:519-524).
  const inputs = await buildTaxInputs(workspaceId, sub);
  if (!inputs) return null;
  const { pricedItems, subtotalCents, discountCents, shippingCents, protectionCents, shipTo } = inputs;
  const inputHash = hashTaxInputs(inputs);
  const cartLines = subItemsToCartLines(pricedItems);
  if (cartLines.length === 0) return null;

  // Customer email for the Avalara customerCode field
  const { data: customer } = await admin
    .from("customers")
    .select("email")
    .eq("id", sub.customer_id as string)
    .single();
  const customerCode = customer?.email || sub.customer_id || `sub-${subscriptionId}`;

  const avalaraLines = await buildAvalaraLines({
    admin,
    workspaceId,
    lines: cartLines,
    shippingCents,
    shippingMethodLabel: (sub as { shipping_method_code?: string }).shipping_method_code || "Shipping",
    protectionCents,
    protectionTitle: (ws?.shipping_protection_title as string | null) || "Shipping Protection",
  });
  if (avalaraLines.length === 0) return null;

  const result = await createTransaction(workspaceId, {
    code: `sub-${subscriptionId}`,
    customerCode,
    date: new Date().toISOString().slice(0, 10),
    commit: false,
    type: "SalesOrder",
    lines: avalaraLines,
    shipTo,
  });

  if (!result.success) {
    console.warn(`[avalara-subscription] quote failed for sub ${subscriptionId}:`, result.error);
    return null;
  }

  const taxCents = result.totalTaxCents ?? 0;
  const totalCents = Math.max(0, subtotalCents - discountCents) + shippingCents + protectionCents + taxCents;

  await admin
    .from("subscriptions")
    .update({
      avalara_quote_tax_cents: taxCents,
      avalara_quote_total_cents: totalCents,
      avalara_quote_at: new Date().toISOString(),
      avalara_quote_address: shipTo,
      avalara_quote_hash: inputHash,
    })
    .eq("id", subscriptionId);

  return { tax_cents: taxCents, total_cents: totalCents };
}

/**
 * Ensure a fresh quote exists. Returns the cached quote when the sub's current
 * tax inputs still hash to `avalara_quote_hash`; otherwise re-quotes. The hash is
 * robust to DYNAMIC pricing: a catalog price change or a pricing-rule edit
 * re-prices the sub without touching the row (so `updated_at` wouldn't move), but
 * the engine-derived prices in the hash change → we re-quote. Likewise any sub
 * mutation (items, quantity, address, protection) changes the hash.
 */
export async function ensureFreshSubscriptionTaxQuote(
  workspaceId: string,
  subscriptionId: string,
): Promise<{ tax_cents: number; total_cents: number } | null> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, customer_id, items, applied_discounts, shipping_address, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents, shipping_method_code, status, is_internal, comp, avalara_quote_hash, avalara_quote_tax_cents, avalara_quote_total_cents")
    .eq("id", subscriptionId)
    .single();
  if (!sub) return null;
  // Internal subs only. Appstle handles its own tax pipeline via Shopify.
  if (!sub.is_internal) return null;
  // A comp (free) sub owes $0 tax — resolve to a concrete $0 quote so the portal
  // shows "$0.00" instead of a permanent "Calculating…" (the taxable subtotal is
  // $0, which otherwise makes buildTaxInputs bail to null). No Avalara call.
  if (sub.comp) return { tax_cents: 0, total_cents: 0 };

  const inputs = await buildTaxInputs(workspaceId, sub);
  if (!inputs) return null; // not quotable yet (no items / no address)

  // Cached quote still valid? (tax inputs unchanged since it was computed)
  if (sub.avalara_quote_hash && sub.avalara_quote_hash === hashTaxInputs(inputs) && sub.avalara_quote_tax_cents != null) {
    return {
      tax_cents: sub.avalara_quote_tax_cents,
      total_cents: sub.avalara_quote_total_cents ?? sub.avalara_quote_tax_cents,
    };
  }
  return quoteSubscriptionTax(workspaceId, subscriptionId);
}

/**
 * Commit a renewal's tax to Avalara for filing. Called from the
 * subscription billing-tick before charging Braintree, using the
 * about-to-be-created order_number as the doc code.
 *
 * Returns { tax_cents, transaction_code } on success. Returns null
 * when Avalara isn't enabled / inputs are insufficient — caller
 * falls back to $0 tax in that case (and logs).
 */
export async function commitSubscriptionRenewalTax(
  workspaceId: string,
  args: {
    subscriptionId: string;
    orderNumber: string;
    items: unknown;
    shippingAddress: unknown;
    shippingCents: number;
    shippingMethodLabel?: string;
    protectionCents: number;
    customerEmail: string | null;
  },
): Promise<{ tax_cents: number; transaction_code: string } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_enabled, shipping_protection_title")
    .eq("id", workspaceId)
    .single();
  if (!ws?.avalara_enabled) return null;

  const shipTo = normalizeAddress(args.shippingAddress);
  if (!shipTo) return null;

  const cartLines = subItemsToCartLines(args.items);
  if (cartLines.length === 0) return null;

  const avalaraLines = await buildAvalaraLines({
    admin,
    workspaceId,
    lines: cartLines,
    shippingCents: args.shippingCents,
    shippingMethodLabel: args.shippingMethodLabel,
    protectionCents: args.protectionCents,
    protectionTitle: (ws?.shipping_protection_title as string | null) || "Shipping Protection",
  });
  if (avalaraLines.length === 0) return null;

  const result = await createTransaction(workspaceId, {
    code: args.orderNumber,
    customerCode: args.customerEmail || `sub-${args.subscriptionId}`,
    date: new Date().toISOString().slice(0, 10),
    commit: true,
    type: "SalesInvoice",
    lines: avalaraLines,
    shipTo,
  });
  if (!result.success) {
    console.warn(`[avalara-subscription] commit failed for renewal ${args.orderNumber}:`, result.error);
    return null;
  }
  return {
    tax_cents: result.totalTaxCents ?? 0,
    transaction_code: result.transactionCode || args.orderNumber,
  };
}
