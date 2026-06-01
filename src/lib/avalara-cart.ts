/**
 * Cart → Avalara line-item bridge. Shared by the tax-quote endpoint
 * (commit=false) and the final checkout commit (commit=true). The
 * quote at order-review and the committed invoice MUST share the
 * same line shape and tax codes so the displayed tax equals the
 * charged tax (Avalara is deterministic for the same inputs).
 *
 * Tax-code resolution per line:
 *   1. product_variants.shopify_tax_code  (Shopify Plus / Avalara field)
 *   2. products.avalara_tax_code          (our classifier or manual override)
 *   3. workspaces.avalara_default_tax_code (the default at the call site)
 *   4. omit — let Avalara guess from description
 *
 * Variants with taxable=false are still sent as lines but with
 * tax_code OS010100 → which Avalara handles as exempt where the
 * jurisdiction rules apply. Cleanest is to flag them as exempt up
 * front. For our catalog only the "Two-Way Protection" SP variant
 * lands here today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AvalaraLineItem } from "@/lib/avalara";

export interface CartLineForTax {
  variant_id: string;
  product_id: string;
  shopify_variant_id?: string | null;
  sku?: string | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  is_gift?: boolean;
}

export interface BuildLinesArgs {
  admin: SupabaseClient;
  workspaceId: string;
  lines: CartLineForTax[];
  shippingCents: number;
  shippingMethodLabel?: string | null;     // for the freight line description
  protectionCents: number;
  protectionTitle?: string | null;
}

interface VariantTaxRow {
  id: string;
  product_id: string;
  shopify_tax_code: string | null;
  taxable: boolean;
}

interface ProductTaxRow {
  id: string;
  avalara_tax_code: string | null;
  taxable: boolean;
  title: string;
}

/**
 * Build the Avalara `lines` array from a cart. Each product line gets
 * its number = the cart-line index as a string. Shipping = number "SHIP".
 * Shipping protection = number "PROTECT". Free gifts (price=0) are
 * skipped because Avalara would otherwise warn about $0 lines.
 */
export async function buildAvalaraLines({
  admin,
  workspaceId,
  lines,
  shippingCents,
  shippingMethodLabel,
  protectionCents,
  protectionTitle,
}: BuildLinesArgs): Promise<AvalaraLineItem[]> {
  if (lines.length === 0) return [];

  const variantIds = [...new Set(lines.map((l) => l.variant_id).filter(Boolean))];
  const productIds = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];

  const [{ data: variants }, { data: products }] = await Promise.all([
    variantIds.length
      ? admin
          .from("product_variants")
          .select("id, product_id, shopify_tax_code, taxable")
          .eq("workspace_id", workspaceId)
          .in("id", variantIds)
      : Promise.resolve({ data: [] as VariantTaxRow[] }),
    productIds.length
      ? admin
          .from("products")
          .select("id, avalara_tax_code, taxable, title")
          .eq("workspace_id", workspaceId)
          .in("id", productIds)
      : Promise.resolve({ data: [] as ProductTaxRow[] }),
  ]);

  const variantById = new Map<string, VariantTaxRow>(
    ((variants as VariantTaxRow[]) || []).map((v) => [v.id, v]),
  );
  const productById = new Map<string, ProductTaxRow>(
    ((products as ProductTaxRow[]) || []).map((p) => [p.id, p]),
  );

  const out: AvalaraLineItem[] = [];

  lines.forEach((l, idx) => {
    // Skip free gifts — zero-amount lines confuse Avalara's nexus
    // logic and inflate the line count for no taxable effect.
    if (l.is_gift || l.unit_price_cents <= 0 || l.line_total_cents <= 0) return;

    const variant = variantById.get(l.variant_id);
    const product = productById.get(l.product_id);
    const taxCode =
      variant?.shopify_tax_code ||
      product?.avalara_tax_code ||
      undefined;

    out.push({
      number: String(idx + 1),
      amount: l.line_total_cents / 100,
      quantity: l.quantity,
      taxCode,
      description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
      itemCode: l.sku || undefined,
    });
  });

  // Shipping line — taxability varies by state. FR020000 is the
  // Avalara product code for freight/shipping common to handle these
  // rules in one place.
  if (shippingCents > 0) {
    out.push({
      number: "SHIP",
      amount: shippingCents / 100,
      quantity: 1,
      taxCode: "FR020000",
      description: shippingMethodLabel || "Shipping",
    });
  }

  // Shipping protection line — OS010100 covers shipping insurance
  // exemptions per state.
  if (protectionCents > 0) {
    out.push({
      number: "PROTECT",
      amount: protectionCents / 100,
      quantity: 1,
      taxCode: "OS010100",
      description: protectionTitle || "Shipping Protection",
    });
  }

  return out;
}
