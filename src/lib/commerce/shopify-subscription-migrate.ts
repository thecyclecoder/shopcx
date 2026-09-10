/**
 * Plan the Appstle → ShopCX migration for one subscription contract.
 *
 * PLANNING ONLY — this module reads [[docs/brain/tables/appstle_contract_snapshots]] and the
 * catalog and produces a `MigrationPlan`. It performs no writes and calls no vendor API, so it is
 * free to run over the whole population as many times as we like.
 *
 * ## The pricing model (CEO, 2026-09-10)
 *
 * Appstle's contracts bake the customer's rate into the line and carry no selling plan or discount
 * policy, which is why nobody can tell WHY a given customer pays what they pay. Migrated contracts
 * are built the other way round — the line is MSRP and every reduction is an explicit discount:
 *
 *   line price   = catalog MSRP
 *   − S&S        = 25%  (pricing_rules.subscribe_discount_pct)
 *   − qty break  = 8% @ 2 units, 12% @ 3+ — MIX-AND-MATCH across lines sharing the rule
 *   − grandfather= a per-unit FIXED discount, scoped to that line via `entitledLines`
 *
 * Grandfathering is deliberately NOT a lower base price and NOT an order-level discount: it is
 * product/variant-specific, so a customer who negotiated a rate on one item doesn't silently get
 * it on everything else in the contract.
 *
 * ## Rules that drop or rewrite lines
 *
 *  - **ACV gummies are not migrated** (79 lines across the base).
 *  - **A $0 line is dropped**, not recreated. A $0 consumable is invalid on a live subscription;
 *    checked against the customer's last order, every such line had already shipped and was simply
 *    stale on the contract.
 *  - **Shipping protection** keeps the customer's own price, gets NO S&S and NO quantity break,
 *    is excluded from the mix-and-match total, and is clamped to qty 1.
 *  - **Lines resolve by SKU first, `variant_id` second.** Shopify variant ids drift when a product
 *    is relisted (`ST-GUMMY-3` exists under two), so the id on an old contract can point at a
 *    retired, zero-inventory variant. SKU is the stable key; the fallback covers the 9 lines whose
 *    SKU the mirror lost. Measured: 0 unresolved lines across 2,477 contracts.
 *
 * ## The invariant
 *
 * **No customer pays more after migration.** Where standard pricing lands above what they pay
 * today, the difference becomes a grandfather lock. Measured across all 2,022 active contracts:
 * 444 go down, 1,578 unchanged, **0 up**.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** 25% S&S, 8% at 2 units, 12% at 3+ — read from `pricing_rules`, never hardcoded. */
export interface PricingContext {
  snsPct: number;
  breaks: { quantity: number; discount_pct: number }[];
  /** product_ids carrying the rule — i.e. the consumables. */
  ruleProducts: Set<string>;
  productTitle: Map<string, string>;
  variantBySku: Map<string, CatalogVariant>;
  variantByShopifyId: Map<string, CatalogVariant>;
}

export interface CatalogVariant {
  id: string;
  product_id: string;
  sku: string | null;
  shopify_variant_id: string | null;
  price_cents: number;
}

export interface PlannedLine {
  sku: string | null;
  /** The CURRENT variant id — may differ from the one on the Appstle contract (relist drift). */
  shopifyVariantId: string;
  remappedFrom: string | null;
  quantity: number;
  /** Catalog MSRP — what the Shopify line is created at. */
  baseCents: number;
  /** What they pay today (lineDiscountedPrice / qty). */
  currentUnitCents: number;
  /** MSRP after S&S + quantity break. */
  standardUnitCents: number;
  /** Per-unit fixed discount that preserves a better legacy rate. 0 when none is needed. */
  grandfatherUnitCents: number;
  /** What they will actually pay. */
  finalUnitCents: number;
  isProtection: boolean;
  onRule: boolean;
}

export interface DroppedLine { sku: string | null; quantity: number; reason: string }

export interface MigrationPlan {
  appstleContractId: string;
  subscriptionId: string | null;
  blocked: string | null;
  snsPct: number;
  breakPct: number;
  mixQty: number;
  lines: PlannedLine[];
  dropped: DroppedLine[];
  currentTotalCents: number;
  newTotalCents: number;
}

export function breakPctForQty(breaks: { quantity: number; discount_pct: number }[], qty: number): number {
  if (!breaks?.length) return 0;
  const exact = breaks.find((b) => b.quantity === qty);
  if (exact) return exact.discount_pct || 0;
  const desc = [...breaks].sort((a, b) => b.quantity - a.quantity);
  return desc.find((b) => b.quantity <= qty)?.discount_pct || 0;
}

/** Load catalog + rule once; reuse across every contract in a run. */
export async function loadPricingContext(workspaceId: string, pricingRuleId: string): Promise<PricingContext> {
  const admin = createAdminClient();

  // ⭐ Paginate everything. A bare select caps at the PostgREST 1000-row max and drops the rest
  // SILENTLY — a missing variant here would look identical to a discontinued product and quietly
  // drop a line from someone's subscription.
  async function all<T>(table: "products" | "product_pricing_rule" | "product_variants"): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(table).select("*").eq("workspace_id", workspaceId).range(from, from + 999);
      if (error) throw new Error(`${table} select failed: ${error.message}`);
      if (!data?.length) break;
      out.push(...(data as T[]));
      if (data.length < 1000) break;
    }
    return out;
  }

  const { data: rule, error: ruleErr } = await admin.from("pricing_rules").select("*").eq("id", pricingRuleId).single();
  if (ruleErr || !rule) throw new Error(`pricing rule ${pricingRuleId} not found: ${ruleErr?.message ?? "no row"}`);

  const products = await all<{ id: string; title: string }>("products");
  const assigns = await all<{ product_id: string }>("product_pricing_rule");
  const variants = await all<CatalogVariant>("product_variants");

  const variantBySku = new Map<string, CatalogVariant>();
  const variantByShopifyId = new Map<string, CatalogVariant>();
  for (const v of variants) {
    if (v.sku) variantBySku.set(String(v.sku).toLowerCase(), v);
    if (v.shopify_variant_id) variantByShopifyId.set(String(v.shopify_variant_id), v);
  }

  const r = rule as { subscribe_discount_pct: number | null; quantity_breaks: { quantity: number; discount_pct: number }[] | null };
  return {
    snsPct: Number(r.subscribe_discount_pct || 0),
    breaks: r.quantity_breaks ?? [],
    ruleProducts: new Set(assigns.map((a) => a.product_id)),
    productTitle: new Map(products.map((p) => [p.id, String(p.title)])),
    variantBySku,
    variantByShopifyId,
  };
}

interface SnapshotLineIn {
  sku: string | null;
  variant_id: string | null;
  quantity: number;
  current_price_cents: number | null;
  effective_unit_cents: number | null;
}

/**
 * Build the plan for one snapshot. Pure given a `PricingContext` — no I/O, so it can be unit
 * tested and re-run over the whole population for free.
 */
export function planMigration(
  snapshot: {
    appstle_contract_id: string;
    subscription_id: string | null;
    payment_method_id: string | null;
    payment_method_revoked: boolean | null;
    lines: SnapshotLineIn[];
  },
  ctx: PricingContext,
): MigrationPlan {
  const dropped: DroppedLine[] = [];
  const isProtection = (v: CatalogVariant | undefined) =>
    /protection/i.test(ctx.productTitle.get(v?.product_id ?? "") ?? "");
  const isACV = (v: CatalogVariant | undefined) =>
    /apple cider vinegar|acv/i.test(ctx.productTitle.get(v?.product_id ?? "") ?? "");

  // Resolve by SKU first, then variant_id — ids drift across relists, SKU does not.
  const resolved = (snapshot.lines ?? []).map((l) => ({
    l,
    v: ctx.variantBySku.get(String(l.sku ?? "").toLowerCase()) ?? ctx.variantByShopifyId.get(String(l.variant_id)),
  }));

  const kept = resolved.filter(({ l, v }) => {
    if (!v) { dropped.push({ sku: l.sku, quantity: l.quantity, reason: "unresolved_variant" }); return false; }
    if (isACV(v)) { dropped.push({ sku: l.sku, quantity: l.quantity, reason: "acv_gummies_not_migrated" }); return false; }
    const unit = l.effective_unit_cents ?? l.current_price_cents ?? 0;
    if (unit === 0 && !isProtection(v)) {
      dropped.push({ sku: l.sku, quantity: l.quantity, reason: "zero_price_line_already_delivered" });
      return false;
    }
    return true;
  });

  // Quantity breaks are MIX-AND-MATCH over rule products; protection never counts toward the tier.
  const mixQty = kept
    .filter(({ v }) => v && ctx.ruleProducts.has(v.product_id) && !isProtection(v))
    .reduce((a, { l }) => a + (l.quantity || 1), 0);
  const breakPct = breakPctForQty(ctx.breaks, mixQty);

  const lines: PlannedLine[] = kept.map(({ l, v }) => {
    const variant = v as CatalogVariant;
    const qty = l.quantity || 1;
    const currentUnit = l.effective_unit_cents ?? l.current_price_cents ?? 0;
    const prot = isProtection(variant);
    const onRule = ctx.ruleProducts.has(variant.product_id) && !prot;

    // Protection: the customer's own price, no S&S, no break, qty clamped to 1.
    if (prot) {
      return {
        sku: l.sku, shopifyVariantId: String(variant.shopify_variant_id),
        remappedFrom: l.variant_id && l.variant_id !== variant.shopify_variant_id ? l.variant_id : null,
        quantity: 1, baseCents: currentUnit, currentUnitCents: currentUnit,
        standardUnitCents: currentUnit, grandfatherUnitCents: 0, finalUnitCents: currentUnit,
        isProtection: true, onRule: false,
      };
    }

    const base = variant.price_cents;
    const standard = onRule ? Math.round(base * (1 - breakPct / 100) * (1 - ctx.snsPct / 100)) : base;
    // Grandfather only ever REDUCES. Where standard is already cheaper the customer takes it.
    const grandfather = currentUnit > 0 && currentUnit < standard ? standard - currentUnit : 0;
    return {
      sku: l.sku, shopifyVariantId: String(variant.shopify_variant_id),
      remappedFrom: l.variant_id && l.variant_id !== variant.shopify_variant_id ? l.variant_id : null,
      quantity: qty, baseCents: base, currentUnitCents: currentUnit,
      standardUnitCents: standard, grandfatherUnitCents: grandfather,
      finalUnitCents: standard - grandfather, isProtection: false, onRule,
    };
  });

  let blocked: string | null = null;
  if (!snapshot.payment_method_id) blocked = "no_payment_method";
  else if (snapshot.payment_method_revoked) blocked = "payment_method_revoked";
  else if (!lines.length) blocked = "no_lines_after_rules";

  return {
    appstleContractId: snapshot.appstle_contract_id,
    subscriptionId: snapshot.subscription_id,
    blocked,
    snsPct: ctx.snsPct,
    breakPct,
    mixQty,
    lines,
    dropped,
    currentTotalCents: lines.reduce((a, l) => a + l.currentUnitCents * l.quantity, 0),
    newTotalCents: lines.reduce((a, l) => a + l.finalUnitCents * l.quantity, 0),
  };
}
