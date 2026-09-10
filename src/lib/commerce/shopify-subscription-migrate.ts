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
        isProtection: true, onRule: false,
      };
    }

    const base = variant.price_cents;
    // ⭐ Shopify's arithmetic, not ours — see shopifyLineMath. A cent of drift here becomes a cent
    // of drift in the grandfathered price we promised to preserve exactly.
    const standard = onRule
      ? shopifyLineMath(base, qty, ctx.snsPct, breakPct).standardUnitCents
      : base;
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
export function carryableCodes(raw: Record<string, unknown> | null): { title: string; amount: number; appliesOnEachItem: boolean; recurringCycleLimit: number | null }[] {
  const nodes = (raw as { discounts?: { nodes?: Record<string, unknown>[] } } | null)?.discounts?.nodes ?? [];
  const out: { title: string; amount: number; appliesOnEachItem: boolean; recurringCycleLimit: number | null }[] = [];
  for (const d of nodes) {
    const type = String(d.type ?? "");
    // Structural discounts are RECOMPUTED, never copied — copying a stored tier is exactly how
    // 386 contracts ended up frozen at the wrong quantity break.
    if (type !== "CODE_DISCOUNT") continue;
    const limit = (d.recurringCycleLimit as number | null) ?? null;
    const used = Number(d.usageCount ?? 0);
    // ⚠️ usageCount resets to 0 on a NEW contract, so a consumed one-use code would be re-granted.
    if (limit != null && used >= limit) continue;
    const value = d.value as { amount?: { amount?: string }; appliesOnEachItem?: boolean } | undefined;
    const amt = value?.amount?.amount != null ? parseFloat(String(value.amount.amount)) : NaN;
    if (!Number.isFinite(amt)) continue; // percentage-valued codes need a separate shape; skip for now
    out.push({
      title: String(d.title ?? "code"),
      amount: amt,
      appliesOnEachItem: !!value?.appliesOnEachItem,
      recurringCycleLimit: limit,
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
export async function executeMigration(
  workspaceId: string,
  appstleContractId: string,
  ctx: PricingContext,
  opts: { dryRun?: boolean; nextBillingDateOverride?: string; completeSwap?: boolean } = {},
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
  if (already) {
    return { ok: false, stage: "already-migrated", error: `already migrated to ${already}`, newContractId: already };
  }

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
  // ⭐ 20 migratable contracts have NO deliveryMethod from Appstle and no shipping_address in our
  // mirror. They still ship — to the payment method's BILLING address, which is what Shopify falls
  // back to when a subscription has no shipping address (CEO, 2026-09-10). So use it rather than
  // blocking a live subscription over a missing field.
  const billingAddr = (fresh.raw as {
    customerPaymentMethod?: { instrument?: { billingAddress?: Record<string, unknown> } };
  }).customerPaymentMethod?.instrument?.billingAddress;
  const addrSource = dm?.address && Object.keys(dm.address).length ? dm.address : billingAddr;
  const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => o?.[k] != null && o[k] !== "").map((k) => [k, (o as Record<string, unknown>)[k]]));

  // ⚠️ Shopify rejects a past next-billing-date outright ("Next billing date is invalid").
  // Measured across the migratable population: 0 are in the past, 96 due today, 2,381 future — so
  // this only bites a stale contract. A due-today date whose clock time has passed is nudged to
  // tomorrow (delaying one charge by a day is harmless); anything genuinely stale BLOCKS rather
  // than being guessed at, because inventing a billing date silently reschedules a customer.
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

  const created = await shopifyCreateContract(workspaceId, {
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
      billingPolicy: { interval: norm.billing_interval, intervalCount: norm.billing_interval_count },
      deliveryPolicy: { interval: norm.billing_interval, intervalCount: norm.billing_interval_count },
      // ⭐ CARRY the customer's existing shipping charge — do NOT zero it.
      //
      // The pricing rule grants free shipping, but that rule governs NEW subscriptions. 1,620
      // active contracts pay $4.95 from a period when free shipping was not offered on all subs
      // (CEO, 2026-09-10), and a legacy shipping term is a term of their subscription exactly like
      // a legacy unit price — which this migration preserves in 1,916 places. Zeroing it here
      // would hand those customers an unrequested ~$8,019/cycle upgrade on a migration that is
      // supposed to be structural, and would be inconsistent with how every other legacy term is
      // treated. New subscriptions still get free shipping from the rule; migrated ones keep what
      // they have.
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

  // Record the new contract IMMEDIATELY — before discounts, before anything else can fail — so a
  // crash from here on leaves a findable half-migration instead of an orphan nobody knows about.
  await admin
    .from("appstle_contract_snapshots")
    .update({ migrated_to_contract_id: newContractId, migrated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("appstle_contract_id", appstleContractId);

  // 4. Line ids for entitledLines scoping.
  const readBack = await getSubscriptionContract(workspaceId, newContractId);
  if (!readBack.success || !readBack.contract) {
    return { ok: false, stage: "read-back", error: readBack.error, plan, newContractId };
  }

  // 5. Customer codes only — structural discounts already rode along on the atomic create.
  const codes = carryableCodes(fresh.raw as Record<string, unknown>);
  if (codes.length) {
    const applied = await withDraft(workspaceId, newContractId, async (draftId) => {
      for (const c of codes) {
        const r = await shopifyAddDraftDiscount(workspaceId, draftId, {
          title: c.title,
          value: { fixedAmount: { amount: c.amount, appliesOnEachItem: c.appliesOnEachItem } },
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
  for (const l of plan.lines) {
    const live = verify.contract.lines.find(
      (x) => String(x.variantId).replace("gid://shopify/ProductVariant/", "") === l.shopifyVariantId,
    );
    if (!live) { mismatches.push(`${l.sku}: missing on the created contract`); continue; }
    const baseCents = Math.round(parseFloat(live.currentPrice ?? "0") * 100);
    if (baseCents !== l.baseCents) mismatches.push(`${l.sku}: base ${baseCents} != planned ${l.baseCents}`);
    // ⭐ The real check. `lineDiscountedPrice` is a LINE TOTAL, so divide by quantity. This is what
    // settles whether Shopify stacks two percentage discounts multiplicatively (0.75 x 0.92, what
    // we planned) or additively (0.67) — undocumented, so it is measured, never assumed.
    if (live.lineDiscountedPrice != null) {
      const effUnit = Math.round((parseFloat(live.lineDiscountedPrice) * 100) / (live.quantity || 1));
      if (Math.abs(effUnit - l.finalUnitCents) > 1) {
        mismatches.push(`${l.sku}: EFFECTIVE ${effUnit} != planned ${l.finalUnitCents} (allocations: ${live.discountAllocationCount})`);
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
    const stillActive = after.ok && (after.raw as { status?: string }).status !== "CANCELLED";
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
      if (c.success) {
        await admin
          .from("appstle_contract_snapshots")
          .update({ migration_completed_at: new Date().toISOString() })
          .eq("workspace_id", workspaceId)
          .eq("appstle_contract_id", r.appstle_contract_id);
        row.state = "complete";
        row.action = "cancelled Appstle, stamped complete";
      } else {
        row.action = `cancel FAILED: ${c.error}`;
      }
    }
    rows.push(row);
  }
  return rows;
}
