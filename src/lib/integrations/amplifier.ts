/**
 * Amplifier 3PL — order creation helper.
 *
 * Reference: amplifier-api.md (POST /orders).
 *
 *   - Base URL:    https://api.amplifier.com
 *   - Auth:        HTTP Basic with the workspace's amplifier API key as
 *                  username, blank password. We use the auth_token query
 *                  param form to keep header surface small.
 *   - Order body:  order_source_code (workspace-configured), order_id (our
 *                  order_number), order_date, billing_info, shipping_info,
 *                  shipping_method, line_items.
 *
 * Address policy from the user spec: Amplifier requires BOTH billing
 * and shipping. If we only have one we mirror to the other.
 *
 * Return shape: `{ id }` on success — that's the Amplifier order
 * UUID, which we store on `orders.amplifier_order_id` so the
 * existing order.received webhook flow stays consistent.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { decrypt } from "@/lib/crypto";

const AMPLIFIER_BASE = "https://api.amplifier.com";

interface Address {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  province_code?: string | null;
  province?: string | null;
  postal_code?: string | null;
  zip?: string | null;
  country_code?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface LineItem {
  sku?: string | null;
  title?: string | null;
  description?: string | null;
  quantity?: number;
  unit_price_cents?: number;
  reference_id?: string | null;
}

export interface CreateAmplifierOrderInput {
  workspaceId: string;
  orderNumber: string;          // our order_number, used as the Amplifier order_id
  orderDate?: string;           // ISO 8601; defaults to now
  shippingAddress?: Address | null;
  billingAddress?: Address | null;
  email?: string | null;
  phone?: string | null;
  shippingMethod?: string;      // default "UPS Ground" — Amplifier picks automatically anyway
  lineItems: LineItem[];
  totalCents?: number;
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  discountCents?: number;
  /**
   * Custom message printed on the Amplifier packing slip. Max 2000
   * chars, Latin-only (Amplifier strips Unicode upstream so emojis +
   * accents won't survive). Use sparingly — every printed slip costs
   * a few cents of ink + a real second of pick-pack time.
   */
  packingSlipMessage?: string | null;
}

export interface CreateAmplifierOrderResult {
  success: boolean;
  amplifier_order_id?: string;
  error?: string;
  details?: string;
}

/**
 * Get the workspace's Amplifier creds. Throws if missing — callers
 * should surface a clear error to the operator.
 */
export interface AmplifierInventoryItem { sku: string; quantity_available: number; quantity_on_hand: number; safety_stock?: number }

/**
 * Fetch current 3PL warehouse on-hand from Amplifier. Endpoint + shape confirmed against
 * Shoptics' working sync: GET /reports/inventory/current → { inventory: [{ sku,
 * quantity_available, quantity_on_hand, safety_stock }] }. HTTP Basic auth (apiKey as
 * username, blank password), matching Amplifier's GET convention. Read-only.
 */
export async function fetchAmplifierInventory(workspaceId: string): Promise<AmplifierInventoryItem[]> {
  const { apiKey } = await getAmplifierConfig(workspaceId);
  const res = await fetch(`${AMPLIFIER_BASE}/reports/inventory/current`, {
    headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Amplifier inventory fetch failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  const data = await res.json();
  const rows = data?.inventory ?? data?.data ?? [];
  return rows.map((r: Record<string, unknown>) => ({
    sku: String(r.sku ?? ""),
    quantity_available: Number(r.quantity_available ?? 0),
    quantity_on_hand: Number(r.quantity_on_hand ?? r.quantity_available ?? 0),
    safety_stock: r.safety_stock != null ? Number(r.safety_stock) : undefined,
  })).filter((r: AmplifierInventoryItem) => r.sku);
}

async function getAmplifierConfig(workspaceId: string): Promise<{ apiKey: string; orderSourceCode: string }> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("amplifier_api_key_encrypted, amplifier_order_source_code")
    .eq("id", workspaceId)
    .single();
  if (!ws?.amplifier_api_key_encrypted) throw new Error("Amplifier API key not configured");
  if (!ws?.amplifier_order_source_code) throw new Error("Amplifier order_source_code not configured");
  return {
    apiKey: decrypt(ws.amplifier_api_key_encrypted as string),
    orderSourceCode: ws.amplifier_order_source_code as string,
  };
}

/**
 * Normalize one of our address shapes into Amplifier's expected
 * billing/shipping shape. Amplifier wants `state` (not province_code),
 * `postal_code` (not zip), `country_code` (not country).
 */
function normalizeAddress(addr: Address): Record<string, unknown> {
  // Addresses reach us in BOTH shapes: snake_case (older order rows) and camelCase
  // (portal address handler + checkout — firstName/provinceCode/countryCode).
  // Accept either, or name/country would silently empty out (Amplifier rejects
  // those) and country_code would become "UN" from slicing "United States".
  const a = addr as Record<string, unknown>;
  const str = (...keys: string[]): string => {
    for (const k of keys) { const v = a[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return "";
  };
  const name = str("name");
  const first = str("first_name", "firstName") || (name ? name.split(" ").slice(0, -1).join(" ") : "");
  const last = str("last_name", "lastName") || (name ? name.split(" ").slice(-1).join(" ") : "");
  // country_code ONLY from an actual code field (2-letter), never sliced from a
  // country name. Default US.
  const rawCountry = str("country_code", "countryCode");
  const country_code = /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : "US";
  return {
    first_name: first.slice(0, 30),
    last_name: last.slice(0, 30),
    address1: str("address1", "street1").slice(0, 80),
    address2: (str("address2", "street2").slice(0, 80)) || undefined,
    city: str("city").slice(0, 50),
    state: str("province_code", "provinceCode", "province", "state").toUpperCase().slice(0, 2),
    postal_code: str("postal_code", "zip").slice(0, 50),
    country_code,
    phone: str("phone") || undefined,
    email: str("email") || undefined,
  };
}

/**
 * Address policy for the 3PL import: ALWAYS prefer the SHIPPING address — the package destination, and
 * the reliably-complete one — for BOTH ship-to and bill-to. Fall back to the billing address only when
 * shipping is unusable.
 *
 * (Reversed 2026-06-28: previously an incomplete billing could win for bill-to — Jill Robinson's billing
 * carried no state, so Amplifier rejected the import with "billing_info.state must not be empty". A usable
 * address now also requires a state, since Amplifier 400s on an empty state on either side.)
 */
function reconcileAddresses(input: CreateAmplifierOrderInput): {
  shipping: Address;
  billing: Address;
} {
  const ship = input.shippingAddress;
  const bill = input.billingAddress;
  const stateOf = (a?: Address | null) => a?.province_code || a?.province || a?.state || "";
  const usable = (a?: Address | null) => !!(a?.address1 && a?.city && (a?.zip || a?.postal_code) && stateOf(a));
  if (usable(ship)) return { shipping: ship!, billing: ship! };
  if (usable(bill)) return { shipping: bill!, billing: bill! };
  throw new Error("Order has no usable shipping or billing address (need street, city, postal code, and state)");
}

/**
 * Pure core: given a variant-id → SKU map, set each line's SKU from its
 * `reference_id` (variant_id) whenever the variant resolves to a SKU —
 * ALWAYS overriding whatever value was baked onto the line. The baked line SKU
 * is only a fallback for a line whose reference_id has no product_variants row
 * (a genuinely non-fulfillable line — digital good, fee — which then stays
 * SKU-less and is dropped downstream). Split out so the mapping is unit-testable
 * without Supabase.
 */
export function applyVariantSkus(lineItems: LineItem[], skuById: Map<string, string>): LineItem[] {
  if (skuById.size === 0) return lineItems;
  return lineItems.map((li) => {
    const vsku = li.reference_id ? skuById.get(String(li.reference_id)) : undefined;
    return vsku ? { ...li, sku: vsku } : li;
  });
}

/**
 * The product_variants table is the SOURCE OF TRUTH for a line's SKU at import
 * time — NEVER the baked value snapshotted onto the order/subscription line.
 *
 * Amplifier requires a SKU on every fulfillable line, and `createAmplifierOrder`
 * DROPS any SKU-less line — so a line whose baked SKU is missing (or stale)
 * silently vanishes and the whole order fails with `no_skus`, never shipping.
 * Internal subscription lines persist exactly this shape (the coffee line carries
 * a variant_id but no baked SKU), which dropped 8+ paid coffee renewals.
 *
 * So at this single 3PL chokepoint — every caller (checkout / renewals /
 * fraud-dismiss) funnels through here — we re-resolve the SKU for EVERY line
 * that carries a variant reference against product_variants, overriding the
 * baked value. A line whose reference_id has no variant row keeps its baked SKU
 * as a fallback (and if that's empty, it's correctly dropped as non-fulfillable).
 * (CEO 2026-07-23: always check the variant table; don't trust baked SKUs.)
 */
async function resolveSkusFromVariants(workspaceId: string, lineItems: LineItem[]): Promise<LineItem[]> {
  const withVariant = lineItems.filter((li) => li.reference_id);
  if (withVariant.length === 0) return lineItems;
  const variantIds = Array.from(new Set(withVariant.map((li) => String(li.reference_id))));
  const admin = createAdminClient();
  const { data: variants } = await admin
    .from("product_variants")
    .select("id, sku")
    .eq("workspace_id", workspaceId)
    .in("id", variantIds);
  const skuById = new Map<string, string>();
  for (const v of variants ?? []) {
    if (v.sku) skuById.set(String(v.id), String(v.sku));
  }
  return applyVariantSkus(lineItems, skuById);
}

export async function createAmplifierOrder(input: CreateAmplifierOrderInput): Promise<CreateAmplifierOrderResult> {
  let cfg;
  try {
    cfg = await getAmplifierConfig(input.workspaceId);
  } catch (err) {
    return { success: false, error: "amplifier_not_configured", details: errText(err) };
  }

  let shipping: Address;
  let billing: Address;
  try {
    ({ shipping, billing } = reconcileAddresses(input));
  } catch (err) {
    return { success: false, error: "missing_address", details: errText(err) };
  }

  // Amplifier requires SKU on every line item. Re-resolve each line's SKU from
  // the variant table (source of truth) FIRST — overriding baked values — then
  // drop anything still SKU-less (shipping protection, fees, digital goods),
  // which don't fulfill anyway.
  const resolvedLineItems = await resolveSkusFromVariants(input.workspaceId, input.lineItems);
  const lineItems = resolvedLineItems
    .filter((li) => li.sku && (li.quantity ?? 0) > 0)
    .map((li) => ({
      sku: li.sku || "",
      description: (li.description || li.title || li.sku || "").slice(0, 255),
      quantity: li.quantity || 1,
      unit_price: typeof li.unit_price_cents === "number" ? (li.unit_price_cents / 100).toFixed(2) : undefined,
      reference_id: li.reference_id || undefined,
    }));
  if (lineItems.length === 0) {
    return { success: false, error: "no_skus", details: "Cart contains no fulfillable SKUs" };
  }

  // Amplifier rejects Unicode — strip to Latin range so a stray emoji
  // in a product title doesn't tank the order.
  const stripUnicode = (s: string) => s.replace(/[^\x00-\x7F]/g, "");
  for (const li of lineItems) li.description = stripUnicode(li.description);

  const body: Record<string, unknown> = {
    order_source_code: cfg.orderSourceCode,
    order_id: input.orderNumber,
    order_date: input.orderDate || new Date().toISOString(),
    billing_info: { ...normalizeAddress(billing), email: input.email || billing.email || undefined, phone: input.phone || billing.phone || undefined },
    shipping_info: { ...normalizeAddress(shipping), email: input.email || shipping.email || undefined, phone: input.phone || shipping.phone || undefined, residential: true },
    shipping_method: input.shippingMethod || "UPS Ground",
    line_items: lineItems,
  };
  if (input.totalCents != null) body.total_amount = (input.totalCents / 100).toFixed(2);
  if (input.subtotalCents != null) body.subtotal_amount = (input.subtotalCents / 100).toFixed(2);
  if (input.shippingCents != null) body.shipping_amount = (input.shippingCents / 100).toFixed(2);
  if (input.taxCents != null) body.tax_amount = (input.taxCents / 100).toFixed(2);
  if (input.discountCents != null) body.discount_amount = (input.discountCents / 100).toFixed(2);
  if (input.packingSlipMessage) {
    // Strip Unicode (same as line descriptions) + cap at 225 chars.
    // Amplifier rejects emoji / accents at validation AND silently
    // truncates the packing-slip note past ~225-250 chars, so we keep
    // the pipeline clean here rather than shipping a cut-off note.
    // buildPackingSlipMessage already enforces this ceiling; this is a
    // backstop for any other caller.
    body.packing_slip_message = stripUnicode(input.packingSlipMessage).slice(0, 225);
  }

  // Auth via query string keeps the header surface small; HTTP Basic
  // would also work.
  const url = `${AMPLIFIER_BASE}/orders?auth_token=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `amplifier_${res.status}`,
        details: respText.slice(0, 600),
      };
    }
    let parsed: { id?: string } = {};
    try { parsed = JSON.parse(respText); } catch { /* ignore */ }
    if (!parsed.id) {
      return { success: false, error: "amplifier_no_id", details: respText.slice(0, 600) };
    }
    return { success: true, amplifier_order_id: parsed.id };
  } catch (err) {
    return { success: false, error: "amplifier_fetch_failed", details: errText(err) };
  }
}
