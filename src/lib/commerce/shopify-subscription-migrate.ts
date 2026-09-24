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
import { fetchAppstleContract, normalizeAppstleContract } from "@/lib/appstle-snapshot";
import { appstleCancelContractVendorOnly } from "@/lib/appstle";
import {
  shopifyCreateContract,
  shopifySyncBillingSchedule,
  shopifyAddDraftDiscount,
  withDraft,
  getSubscriptionContract,
  type ManualDiscountInput,
} from "@/lib/commerce/shopify-subscription-client";

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
  /** Per-unit fixed-code allocation that WILL be re-applied to the new contract. */
  carriedCodeUnitCents: number;
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

/**
 * Reproduce Shopify's own discount arithmetic, per LINE, in cents.
 *
 * Measured on contract 35945218221 (the first multi-discount migration) rather than assumed:
 * discounts stack MULTIPLICATIVELY and SEQUENTIALLY, each allocation computed on the running
 * remainder of the LINE TOTAL and then TRUNCATED to cents — not rounded.
 *
 *   base 79.95 x1 -> S&S 25% = trunc(19.9875) = 19.98
 *                 -> vol 12% = trunc((79.95-19.98) x 0.12) = trunc(7.1964) = 7.19
 *                 -> line = 79.95 - 19.98 - 7.19 = 52.78
 *
 * Getting this exactly right is not pedantry: the grandfather lock is `standard - current`, so a
 * one-cent error in `standard` is a one-cent error in the price we promised to preserve. (An
 * additive model would have produced $50.37 against the real $52.78 — measured, not guessed.)
 */
export function shopifyLineMath(
  baseCents: number,
  quantity: number,
  snsPct: number,
  breakPct: number,
  grandfatherUnitCents = 0,
): { standardUnitCents: number; lineTotalCents: number } {
  const lineBase = baseCents * quantity;
  const sns = Math.trunc((lineBase * snsPct) / 100);
  const brk = Math.trunc(((lineBase - sns) * breakPct) / 100);
  const standardLine = lineBase - sns - brk;
  return {
    standardUnitCents: Math.trunc(standardLine / quantity),
    lineTotalCents: standardLine - grandfatherUnitCents * quantity,
  };
}

/**
 * Resolve the shipping address a migrated contract will use, and say whether it can actually ship.
 *
 * Shared by the planner and the executor ON PURPOSE. When only the executor validated, the planner
 * reported these contracts as migratable and they failed at write time — so the population count
 * was a lie and the failure surfaced at the worst moment.
 *
 * Falls back to the payment method's BILLING address: a subscription with no shipping address
 * ships to the billing address (CEO, 2026-09-10), which resolves 15 of the 20 contracts Appstle
 * returns no deliveryMethod for.
 */
export const REQUIRED_ADDRESS_FIELDS = ["address1", "city", "countryCode", "zip", "lastName"] as const;

export function resolveShippingAddress(raw: Record<string, any> | null): {
  address: Record<string, unknown> | null;
  missing: string[];
} {
  const dmAddr = raw?.deliveryMethod?.address as Record<string, unknown> | undefined;
  const billing = raw?.customerPaymentMethod?.instrument?.billingAddress as Record<string, unknown> | undefined;
  const src = dmAddr && Object.keys(dmAddr).length ? dmAddr : billing;
  if (!src) return { address: null, missing: [...REQUIRED_ADDRESS_FIELDS] };
  const missing = REQUIRED_ADDRESS_FIELDS.filter((k) => !src[k]);
  return { address: src, missing };
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
  /** Per-unit portion of the effective price that comes from a CUSTOMER CODE. */
  code_allocation_unit_cents?: number | null;
}

/**
 * Build the plan for one snapshot. Pure given a `PricingContext` — no I/O, so it can be unit
 * tested and re-run over the whole population for free.
 */
export function planMigration(
  snapshot: {
    appstle_contract_id: string;
    subscription_id: string | null;
    status?: string | null;
    payment_method_id: string | null;
    payment_method_revoked: boolean | null;
    lines: SnapshotLineIn[];
    /** The untouched Appstle payload — used to resolve the shipping address. */
    raw?: Record<string, unknown> | null;
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
    // ⭐ Grandfather against the price BEFORE customer codes. `effective_unit_cents` already has
    // the code baked in, and step 5 re-applies the code to the new contract — so comparing against
    // it counts the code TWICE, mints a permanently inflated grandfather, and then fails
    // verify-pricing (leaving an orphan contract whose marker blocks any retry). 133 contracts
    // carry such a code; every one would have failed exactly this way.
    const codeUnit = l.code_allocation_unit_cents ?? 0;
    const currentUnit = (l.effective_unit_cents ?? l.current_price_cents ?? 0) + codeUnit;
    const prot = isProtection(variant);
    const onRule = ctx.ruleProducts.has(variant.product_id) && !prot;

    // Protection: the customer's own price, no S&S, no break, qty clamped to 1.
    if (prot) {
      return {
        sku: l.sku, shopifyVariantId: String(variant.shopify_variant_id),
        remappedFrom: l.variant_id && l.variant_id !== variant.shopify_variant_id ? l.variant_id : null,
        quantity: 1, baseCents: currentUnit, currentUnitCents: currentUnit,
        standardUnitCents: currentUnit, grandfatherUnitCents: 0, finalUnitCents: currentUnit,
        isProtection: true, onRule: false, carriedCodeUnitCents: 0,
      };
    }

    const base = variant.price_cents;
    // ⭐ Shopify's arithmetic, not ours — see shopifyLineMath. A cent of drift here becomes a cent
    // of drift in the grandfathered price we promised to preserve exactly.
    const standard = onRule
      ? shopifyLineMath(base, qty, ctx.snsPct, breakPct).standardUnitCents
      : base;
    // Grandfather only ever REDUCES. Where standard is already cheaper the customer takes it.
    let grandfather = currentUnit > 0 && currentUnit < standard ? standard - currentUnit : 0;

    // ⭐ Absorb the per-line rounding remainder into the grandfather.
    //
    // `standardUnitCents` is `trunc(standardLine / qty)`, but Shopify charges the LINE TOTAL — so
    // `finalUnit x qty` understates the real charge by `standardLine mod qty`, and that remainder
    // lands on the customer. Measured: 42 contracts paying 1-6c more, invisible to every check
    // (the reporter compares unit x qty on both sides, and verify's tolerance is 1c per unit).
    // Rounding the grandfather UP by the shortfall makes the real line total <= what they pay
    // today, so "no customer pays more" is true of the amount Shopify actually charges.
    if (qty > 1) {
      const realLine = shopifyLineMath(base, qty, ctx.snsPct, onRule ? breakPct : 0, grandfather).lineTotalCents;
      const todayLine = currentUnit * qty;
      if (currentUnit > 0 && realLine > todayLine) {
        grandfather += Math.ceil((realLine - todayLine) / qty);
      }
    }
    return {
      sku: l.sku, shopifyVariantId: String(variant.shopify_variant_id),
      remappedFrom: l.variant_id && l.variant_id !== variant.shopify_variant_id ? l.variant_id : null,
      quantity: qty, baseCents: base, currentUnitCents: currentUnit,
      standardUnitCents: standard, grandfatherUnitCents: grandfather,
      finalUnitCents: standard - grandfather, isProtection: false, onRule,
      carriedCodeUnitCents: codeUnit,
    };
  });

  let blocked: string | null = null;
  // ⚠️ ACTIVE only. `executeMigration` hardcodes status ACTIVE on the new contract, so migrating a
  // PAUSED or CANCELLED one silently REACTIVATES it. Live population: 455 PAUSED, 2 CANCELLED —
  // and two rows already disagree with our mirror (35133620397 is CANCELLED in Appstle but
  // `active` locally with a 2026-09-19 billing date, so migrating it bills a cancelled customer).
  // Paused subs must migrate as create-then-pause; until that exists, refuse.
  // ACTIVE and PAUSED both migrate (status is carried, not forced). CANCELLED / EXPIRED / FAILED
  // have no schedule to move and must never be recreated as live contracts.
  if (snapshot.status && snapshot.status !== "ACTIVE" && snapshot.status !== "PAUSED") {
    blocked = `contract_${String(snapshot.status).toLowerCase()}`;
  }
  else if (!snapshot.payment_method_id) blocked = "no_payment_method";
  else if (snapshot.payment_method_revoked) blocked = "payment_method_revoked";
  else if (!lines.length) blocked = "no_lines_after_rules";
  else {
    // A contract that cannot ship must never be created. MailingAddressInput requires nothing, so
    // Shopify happily accepts a half-address and the customer's box has nowhere to go.
    const addr = resolveShippingAddress((snapshot.raw ?? null) as Record<string, any> | null);
    if (addr.missing.length) blocked = `incomplete_address:${addr.missing.join("+")}`;
  }

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

/**
 * Structural discounts for ONE line.
 *
 * ⭐ `SubscriptionAtomicLineInput` is `{ line, discounts }`, so discounts are scoped to their own
 * line implicitly and ride along on the atomic create. Strictly better than adding them afterwards
 * in a draft: there is no window where the contract exists at MSRP with discounts not yet applied,
 * and grandfathering is per-line by construction rather than by `entitledLines` bookkeeping — a
 * rate negotiated on one product cannot leak onto another.
 */
export function lineDiscounts(plan: MigrationPlan, l: PlannedLine): ManualDiscountInput[] {
  if (l.isProtection || !l.onRule) return [];   // protection: own price, no S&S, no break
  const out: ManualDiscountInput[] = [];
  if (plan.snsPct > 0) out.push({ title: SNS_DISCOUNT_TITLE, value: { percentage: plan.snsPct } });
  if (plan.breakPct > 0) out.push({ title: VOLUME_DISCOUNT_TITLE, value: { percentage: plan.breakPct } });
  if (l.grandfatherUnitCents > 0) {
    out.push({
      title: LEGACY_DISCOUNT_TITLE,
      value: { fixedAmount: { amount: l.grandfatherUnitCents / 100, appliesOnEachItem: true } },
    });
  }
  return out;
}


// ─── Execution ─────────────────────────────────────────────────────────────────────────────


/** Titles we own. The recompute may remove ONLY these; a customer code is never touched. */
export const SNS_DISCOUNT_TITLE = "Subscribe & Save";
export const VOLUME_DISCOUNT_TITLE = "Volume discount";
export const LEGACY_DISCOUNT_TITLE = "Legacy rate";
export const OWNED_DISCOUNT_TITLES = [SNS_DISCOUNT_TITLE, VOLUME_DISCOUNT_TITLE, LEGACY_DISCOUNT_TITLE];

export interface MigrationResult {
  ok: boolean;
  stage: string;
  error?: string;
  plan?: MigrationPlan;
  newContractId?: string;
  drift?: string[];
}

/**
 * Compare a fresh Appstle read against the snapshot the plan was built from.
 *
 * The snapshot drives PLANNING; it must never drive the WRITE. Between snapshot and migration a
 * customer can change quantity, skip, swap a product or update a card — migrating stale state
 * would silently undo their change. Any drift aborts rather than guesses.
 */
export function detectDrift(
  snapshotLines: SnapshotLineIn[],
  freshLines: SnapshotLineIn[],
  snapshotStatus: string | null,
  freshStatus: string | null,
): string[] {
  const drift: string[] = [];
  if (snapshotStatus !== freshStatus) drift.push(`status ${snapshotStatus} -> ${freshStatus}`);
  if (snapshotLines.length !== freshLines.length) {
    drift.push(`line count ${snapshotLines.length} -> ${freshLines.length}`);
    return drift;
  }
  const key = (l: SnapshotLineIn) => `${l.sku ?? l.variant_id}`;
  const snapBy = new Map(snapshotLines.map((l) => [key(l), l]));
  for (const f of freshLines) {
    const s = snapBy.get(key(f));
    if (!s) { drift.push(`new line ${key(f)}`); continue; }
    if (s.quantity !== f.quantity) drift.push(`${key(f)} qty ${s.quantity} -> ${f.quantity}`);
    if ((s.effective_unit_cents ?? 0) !== (f.effective_unit_cents ?? 0)) {
      drift.push(`${key(f)} price ${s.effective_unit_cents} -> ${f.effective_unit_cents}`);
    }
  }
  return drift;
}

/** Build the structural discounts for a plan, given the created contract's line ids. */
export function buildStructuralDiscounts(
  plan: MigrationPlan,
  lineIdByVariant: Map<string, string>,
): ManualDiscountInput[] {
  const out: ManualDiscountInput[] = [];
  const consumableLineIds = plan.lines
    .filter((l) => l.onRule)
    .map((l) => lineIdByVariant.get(l.shopifyVariantId))
    .filter((id): id is string => !!id);

  if (consumableLineIds.length) {
    if (plan.snsPct > 0) {
      out.push({
        title: SNS_DISCOUNT_TITLE,
        value: { percentage: plan.snsPct },
        entitledLines: { lines: { add: consumableLineIds } },
      });
    }
    if (plan.breakPct > 0) {
      out.push({
        title: VOLUME_DISCOUNT_TITLE,
        value: { percentage: plan.breakPct },
        entitledLines: { lines: { add: consumableLineIds } },
      });
    }
  }

  // ⭐ Grandfathering is PER LINE and PER UNIT — a rate negotiated on one product must not leak
  // onto the rest of the contract. `appliesOnEachItem: true` + a single entitled line is what
  // makes that true; an order-level discount cannot express two different per-variant amounts on
  // one contract (contract 27801911469 needs -$3.20 on one line and -$2.80 on the other).
  for (const l of plan.lines) {
    if (l.grandfatherUnitCents <= 0) continue;
    const lineId = lineIdByVariant.get(l.shopifyVariantId);
    if (!lineId) continue;
    out.push({
      title: LEGACY_DISCOUNT_TITLE,
      value: { fixedAmount: { amount: l.grandfatherUnitCents / 100, appliesOnEachItem: true } },
      entitledLines: { lines: { add: [lineId] } },
    });
  }
  return out;
}

/** Customer codes eligible to carry: recurring, or one-use not yet consumed. */
export interface CarriedCode {
  title: string;
  /** Fixed-amount codes only. */
  amount: number;
  appliesOnEachItem: boolean;
  recurringCycleLimit: number | null;
  /** Percentage codes only. */
  percentage?: number;
}

/**
 * The customer's own codes, carried forward. Structural discounts are NOT here — they are
 * recomputed, because copying a stored tier is how 386 contracts froze at the wrong quantity break.
 *
 * ⚠️ **Percentage codes are carried, but `Buy N Discount` ones are NOT.** Appstle stores a quantity
 * break as a percentage CODE_DISCOUNT titled "Buy 2 Discount_xxxxx" — 188 of the book's 229
 * percentage codes are exactly that, and carrying them would double the volume break on top of the
 * one the migration computes itself.
 *
 * The other 40 are real customer codes (SHOPCX-CR20, JULY4THVIP, VIPFreeShip, one at 50%). Those
 * used to be dropped silently by a `skip for now` branch: **4 customers were migrated with a 10–25%
 * discount quietly removed, $40.34/cycle**, and nothing failed or warned. Found 2026-09-24 only
 * because the CEO doubted the code count.
 */
export function carryableCodes(raw: Record<string, unknown> | null): CarriedCode[] {
  const nodes = (raw as { discounts?: { nodes?: Record<string, unknown>[] } } | null)?.discounts?.nodes ?? [];
  const out: CarriedCode[] = [];
  for (const d of nodes) {
    const type = String(d.type ?? "");
    // Structural discounts are RECOMPUTED, never copied — copying a stored tier is exactly how
    // 386 contracts ended up frozen at the wrong quantity break.
    if (type !== "CODE_DISCOUNT") continue;
    const limit = (d.recurringCycleLimit as number | null) ?? null;
    const used = Number(d.usageCount ?? 0);
    // ⚠️ usageCount resets to 0 on a NEW contract, so a consumed one-use code would be re-granted.
    if (limit != null && used >= limit) continue;
    const value = d.value as { amount?: { amount?: string }; appliesOnEachItem?: boolean; percentage?: number } | undefined;
    const title = String(d.title ?? "code");
    const amt = value?.amount?.amount != null ? parseFloat(String(value.amount.amount)) : NaN;
    const pct = value?.percentage != null ? Number(value.percentage) : NaN;

    // ⚠️ A quantity break wearing a code's clothes. Appstle titles them "Buy 2 Discount_xxxxx";
    // the migration recomputes the break from the pricing rule, so carrying this too would apply
    // it twice. 188 of 229 percentage codes in the book are these.
    if (Number.isFinite(pct) && /^buy\s*\d/i.test(title)) continue;

    if (!Number.isFinite(amt) && !Number.isFinite(pct)) continue;
    out.push({
      title,
      amount: Number.isFinite(amt) ? amt : 0,
      ...(Number.isFinite(pct) ? { percentage: pct } : {}),
      appliesOnEachItem: !!value?.appliesOnEachItem,
      // ⚠️ Carry the REMAINING cycles, not the original limit. `usageCount` resets to 0 on a new
      // contract, so copying `limit` verbatim re-grants the whole run: a code at 2 of 3 used would
      // give 3 more cycles instead of 1. 3 contracts are in that state today.
      recurringCycleLimit: limit != null ? Math.max(1, limit - used) : null,
    });
  }
  return out;
}

/**
 * Migrate ONE contract from Appstle to a ShopCX-owned Shopify contract.
 *
 * Ordering is chosen so that every partial failure leaves the customer BILLED BY APPSTLE rather
 * than billed twice or billed by nobody:
 *
 *   create → discounts → VERIFY → mark intent → cancel Appstle → flip billing_source
 *
 * A failure before `cancel` leaves an unused Shopify contract (billing_source is still 'appstle',
 * so our renewal cron ignores it) while Appstle keeps billing normally. The one dangerous window
 * is between `cancel` and the final flip — which is why `migrated_from_contract_id` is written
 * BEFORE the cancel, so a crashed swap is findable rather than silent.
 */

/**
 * The `billingPolicy.anchors` that make Shopify's cycle calendar land on the customer's own day.
 *
 * MONTH  → MONTHDAY anchored to their day-of-month. Day 29–31 is deliberately NOT anchored: an
 *          anchor of 31 has no meaning in a 30-day month and Shopify's handling of that is not
 *          something to discover in production. Those fall back to the createdAt calendar, which
 *          is the behaviour we already have rather than a new failure.
 * WEEK   → WEEKDAY anchored to their weekday (Shopify counts Monday = 1).
 * YEAR   → left unanchored; one cycle a year makes the phase question moot.
 *
 * Returns `{}` when no sane anchor exists, so the caller spreads it and gets today's behaviour.
 */
export function anchorsForSchedule(
  interval: string | null,
  nextBillingDateIso: string | null,
): { anchors?: { type: string; day: number }[] } {
  if (!interval || !nextBillingDateIso) return {};
  const d = new Date(nextBillingDateIso);
  if (Number.isNaN(d.getTime())) return {};
  const iv = String(interval).toUpperCase();
  if (iv === "MONTH") {
    const day = d.getUTCDate();
    return day >= 1 && day <= 28 ? { anchors: [{ type: "MONTHDAY", day }] } : {};
  }
  if (iv === "WEEK") {
    // JS: Sunday = 0. Shopify: Monday = 1 … Sunday = 7.
    const js = d.getUTCDay();
    return { anchors: [{ type: "WEEKDAY", day: js === 0 ? 7 : js }] };
  }
  return {};
}

export async function executeMigration(
  workspaceId: string,
  appstleContractId: string,
  ctx: PricingContext,
  opts: { dryRun?: boolean; nextBillingDateOverride?: string; completeSwap?: boolean; resume?: boolean } = {},
): Promise<MigrationResult> {
  const admin = createAdminClient();

  const { data: snap } = await admin
    .from("appstle_contract_snapshots").select("*")
    .eq("workspace_id", workspaceId).eq("appstle_contract_id", appstleContractId).maybeSingle();
  if (!snap) return { ok: false, stage: "snapshot", error: "no snapshot — run the snapshot puller first" };

  // 0. ⭐ Idempotency. Without this, a retry after a transient error creates a SECOND live
  //    contract for the same customer — observed on the first real run (35945087149 +
  //    35945054381). Nothing billed because billing_source was untouched, but at scale a duplicate
  //    contract is a double-charge waiting for whichever one gets activated.
  const already = (snap as { migrated_to_contract_id: string | null }).migrated_to_contract_id;
  const completedAt = (snap as { migration_completed_at: string | null }).migration_completed_at;
  // ⭐ RESUME. A contract created but not swapped is the NORMAL outcome of any failure after the
  // create — verify rejected it, the codes step failed, the process died. The marker then brands
  // the snapshot, so a plain re-run can only ever say "already migrated" and the customer is
  // stranded with a live inert contract nobody finishes.
  //
  // `resume` re-enters at the VERIFY step against the contract that already exists, skipping the
  // create. It is refused once `migration_completed_at` is stamped, so it can never re-run a
  // finished migration.
  if (already && opts.resume) {
    if (completedAt) {
      return { ok: false, stage: "already-migrated", error: `migration completed at ${completedAt}`, newContractId: already };
    }
  } else if (already) {
    return { ok: false, stage: "already-migrated", error: `already migrated to ${already} — pass resume:true to verify and finish it`, newContractId: already };
  }
  const resuming = Boolean(already && opts.resume);

  // 1. Fresh read. The snapshot plans; the source decides.
  const fresh = await fetchAppstleContract(workspaceId, appstleContractId);
  if (!fresh.ok) return { ok: false, stage: "fresh-read", error: fresh.error };
  const norm = normalizeAppstleContract(fresh.raw as Record<string, unknown> as Record<string, never>);

  const drift = detectDrift(
    (snap as { lines: SnapshotLineIn[] }).lines ?? [],
    norm.lines as unknown as SnapshotLineIn[],
    (snap as { status: string | null }).status,
    norm.status,
  );
  if (drift.length) return { ok: false, stage: "drift", error: "contract changed since snapshot", drift };

  // 2. Plan from the FRESH read.
  const plan = planMigration(
    {
      appstle_contract_id: appstleContractId,
      subscription_id: (snap as { subscription_id: string | null }).subscription_id,
      status: norm.status,
      payment_method_id: norm.payment_method_id,
      payment_method_revoked: norm.payment_method_revoked,
      lines: norm.lines as unknown as SnapshotLineIn[],
      raw: fresh.raw as Record<string, unknown>,
    },
    ctx,
  );
  if (plan.blocked) return { ok: false, stage: "blocked", error: plan.blocked, plan };
  if (opts.dryRun) return { ok: true, stage: "dry-run", plan };

  // 3. Create — atomically, WITH the structural discounts on each line.
  const customerId = (fresh.raw as { customer?: { id?: string } }).customer?.id;
  if (!customerId) return { ok: false, stage: "create", error: "no customer id on the Appstle contract", plan };

  // MailingAddressInput accepts only these fields; the Appstle payload also carries __typename,
  // country, countryCodeV2, name and province, every one of which is rejected.
  const dm = norm.delivery_method as { address?: Record<string, unknown>; shippingOption?: Record<string, unknown> } | null;
  const resolvedAddr = resolveShippingAddress(fresh.raw as Record<string, any>);
  // ⭐ 20 migratable contracts have NO deliveryMethod from Appstle and no shipping_address in our
  // mirror. They still ship — to the payment method's BILLING address, which is what Shopify falls
  // back to when a subscription has no shipping address (CEO, 2026-09-10). So use it rather than
  // blocking a live subscription over a missing field.
  const addrSource = resolvedAddr.address ?? undefined;
  const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => o?.[k] != null && o[k] !== "").map((k) => [k, (o as Record<string, unknown>)[k]]));

  // ⚠️ Shopify rejects a past next-billing-date outright ("Next billing date is invalid").
  // Measured across the migratable population: 0 are in the past, 96 due today, 2,381 future — so
  // this only bites a stale contract. A due-today date whose clock time has passed is nudged to
  // tomorrow (delaying one charge by a day is harmless); anything genuinely stale BLOCKS rather
  // than being guessed at, because inventing a billing date silently reschedules a customer.
  // ⭐ A paused contract keeps its own billing date, deliberately.
  //
  // 294 paused contracts have a billing date that falls BEFORE their resume date, and it is
  // tempting to "fix" that by pushing the date out to the resume. Don't: a pause DEFERS billing,
  // so when a 30/60/90-day pause carries the customer past their normal date, resuming is exactly
  // when the charge should happen — the renewal cron sees a due date and bills, which is the
  // behaviour customers expect from "resume my subscription". Aligning the date to the resume
  // instead makes an EARLY resume wait for no reason. (And it guards nothing: 0 paused contracts
  // carry a date in the past, so the create-time rejection never comes up.)
  const rawNext = opts.nextBillingDateOverride ?? norm.next_billing_date;
  let nextBillingDate = rawNext;
  if (!opts.nextBillingDateOverride) {
    const t = rawNext ? new Date(rawNext).getTime() : NaN;
    if (!Number.isFinite(t)) return { ok: false, stage: "next-billing-date", error: "no usable next billing date", plan };
    const daysPast = (Date.now() - t) / 86_400_000;
    if (daysPast > 1) {
      return { ok: false, stage: "next-billing-date", error: `next billing date is ${Math.floor(daysPast)}d in the past — needs review`, plan };
    }
    if (t <= Date.now()) nextBillingDate = new Date(Date.now() + 86_400_000).toISOString();
  }

  // ⭐ Stamp the attempt BEFORE the create, and on a retry go LOOKING rather than creating again.
  //
  // The marker is written after a REPORTED success, so a create Shopify committed whose response we
  // lost leaves no trace and a retry duplicates it — the 35945087149 + 35945054381 pair. With an
  // attempt timestamp we can tell "never tried" from "tried, outcome unknown" and adopt the
  // contract the previous attempt actually made.
  const attemptedAt = (snap as { migration_attempted_at: string | null }).migration_attempted_at;
  if (attemptedAt && !resuming) {
    const { getShopifyCredentials } = await import("@/lib/shopify-sync");
    const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($id:ID!){ customer(id:$id){ subscriptionContracts(first:25){ nodes{ id status createdAt } } } }`,
        variables: { id: customerId },
      }),
    });
    const j = await res.json().catch(() => null) as { data?: { customer?: { subscriptionContracts?: { nodes?: { id: string; status: string; createdAt: string }[] } } } } | null;
    const since = new Date(attemptedAt).getTime() - 60_000; // a minute of clock slack
    const candidates = (j?.data?.customer?.subscriptionContracts?.nodes ?? [])
      .filter((c) => new Date(c.createdAt).getTime() >= since && c.status !== "CANCELLED");
    if (candidates.length === 1) {
      const adopted = candidates[0].id;
      await admin.from("appstle_contract_snapshots")
        .update({ migrated_to_contract_id: adopted, migrated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId).eq("appstle_contract_id", appstleContractId);
      return { ok: false, stage: "adopted-orphan", error: `a previous attempt already created ${adopted} — adopted it rather than creating a duplicate; re-run to continue`, plan, newContractId: adopted };
    }
    if (candidates.length > 1) {
      return { ok: false, stage: "ambiguous-orphan", error: `${candidates.length} contracts created for this customer since the last attempt — needs a human before another is made`, plan };
    }
  }
  if (!resuming) {
    const { error: attErr } = await admin.from("appstle_contract_snapshots")
      .update({ migration_attempted_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId).eq("appstle_contract_id", appstleContractId);
    if (attErr) return { ok: false, stage: "attempt-marker", error: `could not stamp the attempt marker: ${attErr.message}`, plan };
  }

  // ⚠️ An incomplete address must BLOCK. MailingAddressInput requires nothing, and `pick()` simply
  // omits empty keys, so the create SUCCEEDS with a half-address and the customer's box has nowhere
  // to go. 6 contracts resolve this way even after the billing-address fallback (missing lastName,
  // city, address1 or provinceCode). The brain page already said these "need manual handling, not
  // a guess" — this is the guard that makes that true.
  {
    const missing = resolvedAddr.missing;
    if (missing.length) {
      return {
        ok: false,
        stage: "address",
        error: `shipping address is missing ${missing.join(", ")} — refusing to create a contract that cannot ship`,
        plan,
      };
    }
  }

  // On a resume the contract already exists; adopt it rather than making a second one.
  const created = resuming
    ? { success: true as const, contractId: already as string, error: undefined }
    : await shopifyCreateContract(workspaceId, {
    customerId,
    nextBillingDate: nextBillingDate ?? new Date().toISOString(),
    currencyCode: "USD",
    contract: {
      // ⭐ CARRY the source status — do not force ACTIVE. Hardcoding it silently REACTIVATED every
      // paused subscription (456 of them), billing customers who had deliberately stopped.
      // `SubscriptionContractSubscriptionStatus` is ACTIVE | PAUSED | CANCELLED | EXPIRED | FAILED,
      // and PAUSED is accepted at CREATE (probed) — so there is no create-then-pause window where
      // the contract is briefly active and billable.
      status: norm.status === "PAUSED" ? "PAUSED" : "ACTIVE",
      paymentMethodId: norm.payment_method_id,
      // The anchor phases a MONTH cadence correctly but CANNOT phase a WEEK/n one — an anchor
      // says "Mondays", not "starting the 21st", and 96% of this book is WEEK/4 or WEEK/8. It is
      // kept because it costs nothing and gets the weekday right beyond the pinned horizon; the
      // REAL sync is `shopifySyncBillingSchedule` immediately after the create.
      billingPolicy: {
        interval: norm.billing_interval,
        intervalCount: norm.billing_interval_count,
        ...anchorsForSchedule(norm.billing_interval, nextBillingDate),
      },
      deliveryPolicy: {
        interval: norm.billing_interval,
        intervalCount: norm.billing_interval_count,
        ...anchorsForSchedule(norm.billing_interval, nextBillingDate),
      },
      deliveryPrice: ((norm.delivery_price_cents ?? 0) / 100).toFixed(2),
      deliveryMethod: {
        shipping: {
          address: pick(addrSource, ["address1","address2","city","company","countryCode","firstName","lastName","phone","provinceCode","zip"]),
          shippingOption: pick(dm?.shippingOption, ["title","presentmentTitle","description","code"]),
        },
      },
    },
    lines: plan.lines.map((l) => ({
      line: {
        productVariantId: `gid://shopify/ProductVariant/${l.shopifyVariantId}`,
        quantity: l.quantity,
        currentPrice: (l.baseCents / 100).toFixed(2), // MSRP — the discounts do the rest
      },
      discounts: lineDiscounts(plan, l),
    })),
  });
  if (!created.success || !created.contractId) {
    return { ok: false, stage: "create", error: created.error, plan };
  }
  const newContractId = created.contractId;

  // ⭐ SYNC THE SCHEDULE to the customer's own dates.
  //
  // Shopify computes cycles as `createdAt + n × interval`, so a freshly migrated contract's
  // schedule sits on MIGRATION day, not the customer's anniversary. Verified on a real migration:
  // a WEEK/8 sub due 09-21 produced cycles `11-09 / 01-04 / 03-01` — 49 days out.
  //
  // `setNextBillingDate` cannot fix it (Shopify staff: it is "essentially a storage field for
  // apps, not actually tied to billing cycle recalculation"), and an anchor cannot phase a WEEK/n
  // cadence. Pinning each cycle can, and does: the same contract went to
  // `09-21 / 11-16 / 01-11 / 03-08`.
  //
  // Non-fatal by design. The customer is billed by explicit cycle selector, so an unsynced
  // schedule is a DISPLAY problem on Shopify's account page and emails — not a billing one. A
  // failure here must not undo a migration that otherwise succeeded.
  if (!opts.dryRun && nextBillingDate) {
    try {
      const sync = await shopifySyncBillingSchedule(workspaceId, newContractId, { firstDate: nextBillingDate });
      if (sync.stoppedAt) {
        console.log(`[migrate] ${newContractId}: pinned ${sync.pinned} cycle(s), stopped at ${sync.stoppedAt}`);
      }
    } catch (e) {
      console.error(`[migrate] ${newContractId}: schedule sync threw (non-fatal):`, e instanceof Error ? e.message : e);
    }
  }

  // Record the new contract IMMEDIATELY — before discounts, before anything else can fail — so a
  // crash from here on leaves a findable half-migration instead of an orphan nobody knows about.
  {
    // ⚠️ Never discard this. A silent failure here restores the duplicate-create hazard while the
    // run reports normally — the marker is the ONLY thing standing between a retry and a second
    // live contract.
    const { error: markErr } = await admin
      .from("appstle_contract_snapshots")
      .update({ migrated_to_contract_id: newContractId, migrated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("appstle_contract_id", appstleContractId);
    if (markErr) {
      return { ok: false, stage: "marker", error: `created ${newContractId} but could not record it: ${markErr.message} — DO NOT retry blind`, plan, newContractId };
    }
  }

  // 4. Line ids for entitledLines scoping.
  const readBack = await getSubscriptionContract(workspaceId, newContractId);
  if (!readBack.success || !readBack.contract) {
    return { ok: false, stage: "read-back", error: readBack.error, plan, newContractId };
  }

  // 5. Customer codes only — structural discounts already rode along on the atomic create.
  //
  // ⚠️ NEVER on a resume. These are FIXED-AMOUNT discounts; re-applying them to a contract that
  // already carries them doubles the customer's discount, silently and permanently. A resume
  // re-enters to verify what exists, not to re-apply anything.
  const codes = resuming ? [] : carryableCodes(fresh.raw as Record<string, unknown>);
  if (codes.length) {
    const applied = await withDraft(workspaceId, newContractId, async (draftId) => {
      for (const c of codes) {
        const r = await shopifyAddDraftDiscount(workspaceId, draftId, {
          title: c.title,
          value: c.percentage != null
            ? { percentage: c.percentage }
            : { fixedAmount: { amount: c.amount, appliesOnEachItem: c.appliesOnEachItem } },
          ...(c.recurringCycleLimit != null ? { recurringCycleLimit: c.recurringCycleLimit } : {}),
        });
        if (!r.success) return r;
      }
      return { success: true };
    });
    if (!applied.success) return { ok: false, stage: "codes", error: applied.error, plan, newContractId };
  }

  // 6. VERIFY before anything irreversible. Percentage stacking (multiplicative vs additive) is
  //    not documented anywhere we trust, so the contract is read back and every line's effective
  //    price compared to the plan. A mismatch aborts with Appstle still billing.
  const verify = await getSubscriptionContract(workspaceId, newContractId);
  if (!verify.success || !verify.contract) {
    return { ok: false, stage: "verify", error: verify.error, plan, newContractId };
  }
  const mismatches: string[] = [];
  // ⭐ Match by VARIANT with best-fit pairing — NOT by index, and not by first-variant-wins.
  //
  // Both naive strategies are wrong, in opposite directions:
  //
  //   - by index: assumes `subscriptionContractAtomicCreate` returns lines in submission order.
  //     ⚠️ IT DOES NOT. Measured 2026-09-18 on a 25-contract wave: 10 contracts came back with
  //     their lines permuted (every SKU present, every position different), and all 10 failed
  //     verify on a contract that was actually priced correctly.
  //   - by variant, first match wins: a contract can legitimately carry the SAME variant on two
  //     lines with DIFFERENT grandfathers — 45 contracts do — so every duplicate gets compared
  //     against the first live line and falsely fails.
  //
  // So: group the live lines by variant, and let each plan line CONSUME the unclaimed live line
  // for its variant whose effective unit price is closest to what the plan expects. That is
  // order-independent and still distinguishes two same-variant lines at different prices.
  // A carried customer code moves money off the lines in a way the per-line plan does not model —
  // a fixed amount spreads proportionally, a percentage applies to whatever Shopify decides is the
  // discounted base. Either way the per-line EFFECTIVE check cannot predict it. See below.
  const carriedCodes = carryableCodes(fresh.raw as Record<string, unknown>);
  const carriesFixedCode = plan.lines.some((l) => (l.carriedCodeUnitCents ?? 0) > 0)
    || carriedCodes.length > 0;

  const byVariant = new Map<string, typeof verify.contract.lines>();
  for (const live of verify.contract.lines) {
    const v = String(live.variantId ?? "").replace("gid://shopify/ProductVariant/", "");
    const bucket = byVariant.get(v);
    if (bucket) bucket.push(live);
    else byVariant.set(v, [live]);
  }
  const claimed = new Set<string>();

  for (let i = 0; i < plan.lines.length; i++) {
    const l = plan.lines[i];
    const candidates = (byVariant.get(l.shopifyVariantId) ?? []).filter((c) => !claimed.has(c.id));
    if (!candidates.length) {
      const present = [...byVariant.keys()].join(", ");
      mismatches.push(
        `${l.sku}: variant ${l.shopifyVariantId} is not on the created contract (it carries: ${present})`,
      );
      continue;
    }
    // Closest effective unit price wins, so two same-variant lines pair with the right grandfather.
    const wantEff = l.finalUnitCents - (l.carriedCodeUnitCents ?? 0);
    const live = candidates.reduce((best, c) => {
      const eff = (x: typeof c) => x.lineDiscountedPrice != null
        ? Math.round((parseFloat(x.lineDiscountedPrice) * 100) / (x.quantity || 1))
        : Number.MAX_SAFE_INTEGER;
      return Math.abs(eff(c) - wantEff) < Math.abs(eff(best) - wantEff) ? c : best;
    }, candidates[0]);
    claimed.add(live.id);
    const baseCents = Math.round(parseFloat(live.currentPrice ?? "0") * 100);
    if (baseCents !== l.baseCents) mismatches.push(`${l.sku}: base ${baseCents} != planned ${l.baseCents}`);

    // ⭐ The plan's finalUnitCents is PRE-code (that is what grandfathering is computed against),
    // but the live contract already has the carried code allocated — so the two differ by exactly
    // the code. Without this the 132 contracts carrying a fixed code ALL abort here, and an abort
    // brands them permanently via `migrated_to_contract_id`.
    if (live.lineDiscountedPrice != null && !carriesFixedCode) {
      const effUnit = Math.round((parseFloat(live.lineDiscountedPrice) * 100) / (live.quantity || 1));
      const expected = l.finalUnitCents - (l.carriedCodeUnitCents ?? 0);
      if (Math.abs(effUnit - expected) > 1) {
        mismatches.push(`${l.sku}: EFFECTIVE ${effUnit} != expected ${expected} (allocations: ${live.discountAllocationCount})`);
      }
    }
  }

  // ⭐ A FIXED-AMOUNT code is verified on the TOTAL, never per line.
  //
  // Shopify spreads an order-level fixed amount PROPORTIONALLY across every line, including ones
  // the pricing plan never modelled. Measured on 27947565229: a $10 LOYALTY code landed $9.49 on
  // the product and **$0.51 on the shipping-protection line**, which the plan expects at full
  // price. Per-line comparison called that a pricing error; it is not — the customer is charged
  // exactly $10 less, which is the whole contract of the discount. The same spread also shifts each
  // line by a cent or two of rounding, which used to trip the ±1c check.
  //
  // So when a fixed-amount code rides along, the per-line effective check above is skipped and the
  // CONTRACT TOTAL is checked instead: it nets out wherever Shopify chose to put the money, while
  // still catching a genuinely wrong price. Per-line BASE and the structural percentage discounts
  // are still verified line by line either way.
  if (carriesFixedCode && !mismatches.length) {
    // The structural price, before any customer code — what the plan models exactly.
    const structuralTotal = plan.lines.reduce((t, l) => t + l.finalUnitCents * l.quantity, 0);
    const liveTotal = verify.contract.lines.reduce(
      (t, l) => t + Math.round(parseFloat(l.lineDiscountedPrice ?? "0") * 100),
      0,
    );
    // One cent of rounding per line is the most a proportional spread can introduce.
    const tolerance = Math.max(2, verify.contract.lines.length);
    const hasPercentageCode = carriedCodes.some((c) => c.percentage != null);

    if (hasPercentageCode) {
      // ⚠️ A PERCENTAGE code cannot be predicted to the cent: Shopify chooses the base it applies
      // to, and stacking order with the structural percentages is not documented. So assert the two
      // things that actually matter and can be known:
      //   1. the customer is NEVER charged more than the structural price — a carried code can only
      //      ever reduce, so a live total above it means the code failed to apply or something
      //      worse happened;
      //   2. it did in fact reduce, i.e. the code is genuinely on the contract.
      // The exact amount is then whatever Shopify computes, which is the same figure the customer
      // was paying on Appstle.
      if (liveTotal > structuralTotal + tolerance) {
        mismatches.push(
          `CONTRACT TOTAL ${liveTotal} EXCEEDS the structural price ${structuralTotal} — a carried code must never increase the charge`,
        );
      } else if (liveTotal >= structuralTotal - tolerance) {
        mismatches.push(
          `carried percentage code(s) ${carriedCodes.filter((c) => c.percentage != null).map((c) => `${c.title} ${c.percentage}%`).join(", ")} did NOT reduce the contract total (${liveTotal} vs structural ${structuralTotal})`,
        );
      }
    } else {
      const plannedTotal = structuralTotal
        - plan.lines.reduce((t, l) => t + (l.carriedCodeUnitCents ?? 0) * l.quantity, 0);
      if (Math.abs(liveTotal - plannedTotal) > tolerance) {
        mismatches.push(
          `CONTRACT TOTAL ${liveTotal} != planned ${plannedTotal} (fixed-amount code spread across ${verify.contract.lines.length} line(s), tolerance ${tolerance})`,
        );
      }
    }
  }
  if (mismatches.length) {
    // Appstle is still billing; the created contract is inert because billing_source is untouched.
    return { ok: false, stage: "verify-pricing", error: mismatches.join("; "), plan, newContractId };
  }

  if (!opts.completeSwap) return { ok: true, stage: "verified", plan, newContractId };

  // ─── The swap. Everything above is reversible; from here it is not. ───────────────────────
  //
  // Ordering is chosen so that EVERY partial failure leaves the customer billed by SOMEONE:
  //
  //   (a) point our row at the new contract and flip billing_source  -> we bill it
  //   (b) cancel Appstle                                             -> they stop
  //
  // (a) before (b) deliberately. If we cancelled first and then failed to flip, the sub would be
  // billed by NOBODY — silent revenue loss, the exact failure this whole design exists to prevent.
  // Doing it this way, a failure between the two leaves BOTH engines believing they own it for a
  // few seconds. That is survivable because Shopify fires nothing on its own and our renewal cron
  // runs once daily, so a same-day double charge is not reachable; `migration_completed_at` stays
  // null and the sweeper finishes the cancel.
  // ⚠️ HARD ABORT, not an `if`. With no local row there is nothing to point at the new contract,
  // so cancelling Appstle below would leave the customer billed by NOBODY — the exact outcome this
  // ordering exists to prevent, and the table's own page names a null subscription_id as the
  // revenue-losing direction ("Appstle knows a contract we don't").
  const subId = (snap as { subscription_id: string | null }).subscription_id;
  if (!subId) {
    return { ok: false, stage: "swap-local", error: "snapshot has no subscription_id — refusing to cancel Appstle with nothing to bill it", plan, newContractId };
  }
  {
    const { data: swapped, error: subErr } = await admin
      .from("subscriptions")
      .update({
        shopify_contract_id: newContractId.replace("gid://shopify/SubscriptionContract/", ""),
        billing_source: "shopcx",
        migrated_from_contract_id: appstleContractId,
        // ⭐ Reconcile the date in the SAME write. The renewal cron selects and charges on OUR
        // mirror, and 61 active subs carry a local date over a day stale — diverging from Appstle
        // by up to 168 days. Left unreconciled they are selected immediately and (with the
        // first-cycle clamp) charged up to months early. This is the date actually written to the
        // contract, so mirror and contract agree from birth.
        next_billing_date: nextBillingDate,
        // ⭐ Reconcile status from the source in the same write. Appstle is authoritative until the
        // moment we take over, and a mirror that disagrees survives the migration otherwise — a
        // PAUSED contract with a local `active` row is selected by the renewal cron every day
        // forever (harmless, since the attempt re-checks the live contract, but permanent no-op
        // churn on a money cron). Measured before this: 2 of 2,478 rows disagreed.
        status: norm.status === "PAUSED" ? "paused" : "active",
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .eq("id", subId);
    // ⚠️ A PostgREST update that matches ZERO rows returns no error. Without this check a deleted
    // or moved subscription row produces the same outcome as the null-subId case: Appstle
    // cancelled, nothing pointing at the new contract, billed by nobody.
    if (subErr) {
      return { ok: false, stage: "swap-local", error: subErr.message, plan, newContractId };
    }
    if (!swapped?.length) {
      return { ok: false, stage: "swap-local", error: `subscription ${subId} matched zero rows — refusing to cancel Appstle`, plan, newContractId };
    }
  }

  const cancelled = await appstleCancelContractVendorOnly(workspaceId, appstleContractId);
  // ⚠️ VERIFY, do not trust. This uses `update-status?status=CANCELLED`; the proven cancel route in
  // appstle.ts is DELETE, and update-status is otherwise only ever called with PAUSED/ACTIVE. If
  // Appstle accepts the call and ignores an unsupported status we would stamp success and BOTH
  // engines would bill every migrated customer. A read-back is one metered call against that risk.
  if (cancelled.success) {
    const after = await fetchAppstleContract(workspaceId, appstleContractId);
    // ⚠️ FAIL CLOSED. This previously read `after.ok && status !== "CANCELLED"`, so a failed
    // VERIFICATION (rate limit, network, Appstle's HTML-for-unknown-route — all of which return
    // ok:false) made `stillActive` false and the run stamped completion. A verification we could
    // not perform is not a verification that passed: if Appstle ignored the status we would have
    // both engines billing the same customer, with the row dropped from the sweeper's view.
    if (!after.ok) {
      return {
        ok: false,
        stage: "appstle-cancel-unverified",
        error: `could not verify the Appstle cancel (${after.error}) — refusing to stamp complete; both engines may own this contract`,
        plan,
        newContractId,
      };
    }
    const stillActive = (after.raw as { status?: string }).status !== "CANCELLED";
    if (stillActive) {
      return {
        ok: false,
        stage: "appstle-cancel-unverified",
        error: `Appstle reported success but the contract still reads ${(after.raw as { status?: string }).status} — BOTH engines may bill; do not proceed`,
        plan,
        newContractId,
      };
    }
  }
  if (!cancelled.success) {
    // Local row already points at the new contract, so WE are billing it. Appstle may also still
    // think it owns the sub — flagged for the sweeper rather than silently left.
    return { ok: false, stage: "appstle-cancel", error: cancelled.error, plan, newContractId };
  }

  await admin
    .from("appstle_contract_snapshots")
    .update({ migration_completed_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("appstle_contract_id", appstleContractId);

  // ⭐ RE-MIRROR THE PRICING. The swap above repoints the row and flips the engine but leaves
  // `items` holding the APPSTLE-ERA prices — so the portal and CS keep quoting the old number
  // while the contract charges the new one. Measured on wave 1 before this existed: 13 of 25 rows
  // showed a price HIGHER than the contract would charge, by up to $43.13. It errs in the
  // customer's favour, which is exactly why nothing would ever have complained.
  //
  // Non-fatal: the migration itself is complete and correct at this point, and the drift
  // reconciler plus any later contract edit both re-mirror. A stale price is a display bug; a
  // thrown error here would look like a failed migration that actually succeeded.
  {
    const { mirrorContractPricing } = await import("@/lib/commerce/shopcx-contract-ingest");
    const m = await mirrorContractPricing(workspaceId, newContractId);
    if (!m.ok) {
      console.error(`[migrate] ${newContractId}: swapped, but the pricing mirror failed (portal will show pre-migration prices): ${m.error}`);
    }
  }

  return { ok: true, stage: "swapped", plan, newContractId };
}

export interface SweepRow {
  appstleContractId: string;
  newContractId: string;
  subscriptionId: string | null;
  billingSource: string | null;
  state: "orphan_contract" | "half_swapped" | "complete";
  action: string;
}

/**
 * Find and finish migrations that stopped part-way.
 *
 * A row with `migrated_to_contract_id` set but `migration_completed_at` null is unfinished. Two
 * very different shapes hide behind that, and conflating them would be dangerous:
 *
 *  - **orphan_contract** — a Shopify contract was created but the swap never started
 *    (`billing_source` still 'appstle'). Appstle is still billing normally, so nothing is broken;
 *    the new contract is inert. Reported, NEVER auto-cancelled: it may be a deliberate rehearsal,
 *    and cancelling someone's replacement contract on a guess is worse than leaving it.
 *  - **half_swapped** — our row already points at the new contract with `billing_source='shopcx'`,
 *    but the Appstle cancel did not land. BOTH engines think they own the sub. This is the one
 *    that must be finished promptly, because it is the only state where a double charge is
 *    reachable. Fixing it is idempotent: cancel Appstle again.
 */
export async function sweepIncompleteMigrations(
  workspaceId: string,
  opts: { apply?: boolean } = {},
): Promise<SweepRow[]> {
  const admin = createAdminClient();
  // ⭐ Paginate. This is the detector for `half_swapped` — the one state this module itself calls
  // "the only state where a double charge is reachable" — so a silent 1000-row truncation would
  // hide exactly the rows that must not be missed.
  type SnapRow = { appstle_contract_id: string; subscription_id: string | null; migrated_to_contract_id: string };
  const pending: SnapRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("appstle_contract_snapshots")
      .select("appstle_contract_id, subscription_id, migrated_to_contract_id")
      .eq("workspace_id", workspaceId)
      .not("migrated_to_contract_id", "is", null)
      .is("migration_completed_at", null)
      .order("appstle_contract_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`sweep select failed: ${error.message}`);
    if (!data?.length) break;
    pending.push(...(data as SnapRow[]));
    if (data.length < 1000) break;
  }

  const rows: SweepRow[] = [];
  for (const r of pending) {
    let billingSource: string | null = null;
    if (r.subscription_id) {
      const { data: sub } = await admin
        .from("subscriptions").select("billing_source").eq("id", r.subscription_id).maybeSingle();
      billingSource = (sub as { billing_source: string } | null)?.billing_source ?? null;
    }
    const halfSwapped = billingSource === "shopcx";
    const row: SweepRow = {
      appstleContractId: r.appstle_contract_id,
      newContractId: r.migrated_to_contract_id,
      subscriptionId: r.subscription_id,
      billingSource,
      state: halfSwapped ? "half_swapped" : "orphan_contract",
      action: halfSwapped ? "cancel Appstle + stamp complete" : "report only — swap never started",
    };

    if (halfSwapped && opts.apply) {
      const c = await appstleCancelContractVendorOnly(workspaceId, r.appstle_contract_id);
      // ⚠️ Verify, exactly as executeMigration does. Stamping on the bare vendor response would
      // clear the row on the SAME false success that produced the half-swap — and a stamped row
      // leaves this query forever, so the one state the module calls "double-charge reachable"
      // would become invisible.
      let verified = false;
      if (c.success) {
        const after = await fetchAppstleContract(workspaceId, r.appstle_contract_id);
        verified = after.ok && (after.raw as { status?: string }).status === "CANCELLED";
      }
      if (verified) {
        await admin
          .from("appstle_contract_snapshots")
          .update({ migration_completed_at: new Date().toISOString() })
          .eq("workspace_id", workspaceId)
          .eq("appstle_contract_id", r.appstle_contract_id);
        row.state = "complete";
        row.action = "cancelled Appstle (verified), stamped complete";
      } else {
        row.action = c.success
          ? "cancel reported success but could NOT be verified — left half_swapped"
          : `cancel FAILED: ${c.error}`;
      }
    }
    rows.push(row);
  }
  return rows;
}
