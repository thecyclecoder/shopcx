/**
 * Coupon engine — resolves a code from our internal `coupons` table first
 * ("internal wins"), then falls back to a real-time Shopify discount-code
 * lookup, normalizing both into one entire-order discount model. The internal
 * subscription renewal scheduler applies the discount at charge time and
 * consumes `recurring_cycle_limit` per charge.
 *
 * Scope is always "order" — we ignore Shopify product scope for internal subs.
 * Discounts stack on subscribe-and-save + the quantity break (those are pricing
 * tiers, not coupons). One coupon per subscription.
 *
 * See docs/brain/specs/storefront-mvp.md § Phase 1b.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { couponApplicableToSubStatus } from "@/lib/subscription-items";

type Admin = ReturnType<typeof createAdminClient>;

export type CouponType = "percentage" | "fixed_amount";

export interface ResolvedCoupon {
  code: string;
  type: CouponType;
  value: number; // percentage: 0-100 · fixed_amount: cents
  recurring_cycle_limit: number | null; // 1 | N | null (forever)
  /** Shopify appliesOncePerCustomer OR usageLimit===1 → at most one redemption per customer. */
  one_time?: boolean;
  source: "internal" | "shopify";
  coupon_id?: string; // internal row id — the MASTER row for derived codes
  /** Derived from a master ("WELCOME-GSXN")? Redemption → ledger, not used_at. */
  is_derived?: boolean;
  /** The customer the derived code resolves to (its rightful owner). */
  customer_id?: string;
}

/** An entry stored in subscriptions.applied_discounts. */
export interface AppliedDiscount {
  code?: string;
  type?: CouponType;
  value?: number;
  recurring_cycle_limit?: number | null;
  remaining_cycles?: number | null; // decremented per charge; null = forever
  source?: "internal" | "shopify";
  // Legacy entries may only carry { id, title } — handled defensively.
  id?: string;
  title?: string;
}

/** Resolve a code → normalized discount. Internal table wins; else Shopify. */
export async function resolveCoupon(
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null> {
  const admin = createAdminClient();

  // 1. Internal table exact match (internal wins). A MASTER row is never
  //    directly usable on its own — it's only redeemed via a derived
  //    "{PREFIX}-{short_code}" code (handled in step 2), so skip masters here.
  const { data: rows } = await admin
    .from("coupons")
    .select("id, code, type, value, recurring_cycle_limit, customer_id, single_use, used_at, is_master")
    .eq("workspace_id", workspaceId)
    .ilike("code", code)
    .limit(1);
  const row = rows?.[0];
  if (row && !row.is_master) {
    // Customer-scoped coupons only resolve for that customer, and only once.
    if (row.customer_id && (!customerId || String(row.customer_id) !== String(customerId))) return null;
    if (row.single_use && row.used_at) return null;
    return {
      code: row.code,
      type: row.type as CouponType,
      value: row.value,
      recurring_cycle_limit: row.recurring_cycle_limit,
      source: "internal",
      coupon_id: row.id,
    };
  }

  // 2. Derived master code — "{PREFIX}-{short_code}" (e.g. WELCOME-GSXN).
  const derived = await resolveDerivedCoupon(admin, workspaceId, code, customerId);
  if (derived) return derived;

  // 3. Real-time Shopify lookup (transitional — legacy codes).
  return resolveShopifyCoupon(admin, workspaceId, code);
}

/**
 * Resolve a derived master code — "{PREFIX}-{short_code}" (e.g. WELCOME-GSXN).
 * The master holds the terms; the suffix is a customer's permanent short_code.
 * No coupon row exists per customer — the code is virtual until redeemed, and
 * single-use is enforced by the coupon_redemptions ledger.
 *
 * Returns null (silently falls through) when: the format doesn't split, no
 * master matches the prefix, the master is expired, the suffix doesn't resolve
 * to a customer, the redeeming customer isn't the code's owner, or the
 * per-customer redemption limit for the current cycle is already reached.
 */
async function resolveDerivedCoupon(
  admin: Admin,
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null> {
  // Split on the LAST hyphen so master prefixes may themselves contain hyphens.
  const idx = code.lastIndexOf("-");
  if (idx <= 0 || idx === code.length - 1) return null;
  const prefix = code.slice(0, idx);
  const suffix = code.slice(idx + 1).toUpperCase();

  // Master by prefix (case-insensitive).
  const { data: masters } = await admin
    .from("coupons")
    .select("id, code, type, value, recurring_cycle_limit, per_customer_limit, redemption_cycle_started_at, valid_until")
    .eq("workspace_id", workspaceId)
    .eq("is_master", true)
    .ilike("code", prefix)
    .limit(1);
  const master = masters?.[0];
  if (!master) return null;

  // Offer expiry.
  if (master.valid_until && new Date(master.valid_until as string) < new Date()) return null;

  // Suffix → the owning customer (short_code is unique per workspace).
  const { data: owner } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("short_code", suffix)
    .maybeSingle();
  if (!owner) return null;

  // Bind: only the rightful owner may redeem their own derived code. The suffix
  // is a guessable 5-char code, so this check is what prevents abuse — we never
  // apply WELCOME-GSXN to anyone but the customer GSXN resolves to.
  if (!customerId || String(owner.id) !== String(customerId)) return null;

  // Per-customer redemption limit within the CURRENT cycle. WELCOME's cycle
  // starts at the epoch (counts forever → one use). A reissuable campaign bumps
  // redemption_cycle_started_at on each launch, so prior redemptions stop
  // counting and the customer is eligible again.
  const limit = (master.per_customer_limit as number | null) ?? 1;
  const cycleStart = (master.redemption_cycle_started_at as string | null) || "1970-01-01T00:00:00Z";
  const { count } = await admin
    .from("coupon_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("coupon_id", master.id)
    .eq("customer_id", owner.id)
    .gte("redeemed_at", cycleStart);
  if ((count || 0) >= limit) return null;

  return {
    code: `${master.code}-${suffix}`,
    type: master.type as CouponType,
    value: master.value,
    recurring_cycle_limit: master.recurring_cycle_limit,
    source: "internal",
    coupon_id: master.id,
    is_derived: true,
    customer_id: owner.id,
  };
}

async function resolveShopifyCoupon(admin: Admin, workspaceId: string, code: string): Promise<ResolvedCoupon | null> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.shopify_access_token_encrypted || !ws?.shopify_myshopify_domain) return null;
  try {
    const token = decrypt(ws.shopify_access_token_encrypted);
    const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
    const res = await fetch(
      `https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{ codeDiscountNodeByCode(code: ${JSON.stringify(code)}) { codeDiscount { ... on DiscountCodeBasic { recurringCycleLimit appliesOncePerCustomer usageLimit customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } } } } } }`,
        }),
        cache: "no-store",
      },
    );
    const gql = await res.json();
    const cd = gql?.data?.codeDiscountNodeByCode?.codeDiscount;
    if (!cd) return null;
    const val = cd.customerGets?.value;
    // recurringCycleLimit: 0/null = forever, 1 = one charge, N = N charges.
    const rawLimit = cd.recurringCycleLimit;
    const recurring_cycle_limit = rawLimit && Number(rawLimit) > 0 ? Number(rawLimit) : null;
    // One-time PER CUSTOMER: appliesOncePerCustomer, or a global usageLimit of 1.
    const one_time = !!cd.appliesOncePerCustomer || Number(cd.usageLimit) === 1;
    if (val?.percentage != null) {
      return { code, type: "percentage", value: Math.round(Number(val.percentage) * 100), recurring_cycle_limit, one_time, source: "shopify" };
    }
    if (val?.amount?.amount != null) {
      return { code, type: "fixed_amount", value: Math.round(parseFloat(val.amount.amount) * 100), recurring_cycle_limit, one_time, source: "shopify" };
    }
    return null;
  } catch (e) {
    console.error("[coupons] Shopify resolve failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Apply a coupon to an internal sub's applied_discounts (one coupon per sub). */
export async function applyCouponToSub(
  workspaceId: string,
  contractId: string,
  code: string,
  customerId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const resolved = await resolveCoupon(workspaceId, code, customerId);
  if (!resolved) return { success: false, error: "coupon_not_found" };

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, applied_discounts, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();
  if (!sub) return { success: false, error: "subscription_not_found" };
  if (!couponApplicableToSubStatus(sub.status as string | null | undefined)) {
    return { success: false, error: "subscription_not_active" };
  }

  const existing = (sub.applied_discounts as AppliedDiscount[]) || [];
  const kept = existing.filter((d) => (d.code || d.title) !== resolved.code);
  const entry: AppliedDiscount = {
    code: resolved.code,
    type: resolved.type,
    value: resolved.value,
    recurring_cycle_limit: resolved.recurring_cycle_limit,
    remaining_cycles: resolved.recurring_cycle_limit,
    source: resolved.source,
  };
  await admin
    .from("subscriptions")
    .update({ applied_discounts: [...kept, entry], updated_at: new Date().toISOString() })
    .eq("id", sub.id);

  // Record the redemption (derived → ledger row; legacy one-off → burn used_at).
  await recordCouponRedemption(workspaceId, resolved, customerId, { subscriptionId: sub.id });
  return { success: true };
}

/**
 * Record a coupon redemption at the moment it's actually consumed.
 *
 * - Derived master codes (WELCOME-GSXN): append a coupon_redemptions row. This
 *   is the only place a row is written for the master flow — so we never
 *   pre-generate per-customer coupon rows, only per-redemption ledger rows.
 * - Legacy explicit single-use coupons: burn the row's used_at (unchanged).
 *
 * Idempotency is best-effort: callers should invoke this once per successful
 * application. The ledger is also the redemption-analytics source.
 */
export async function recordCouponRedemption(
  workspaceId: string,
  resolved: ResolvedCoupon,
  customerId?: string | null,
  ctx?: { subscriptionId?: string | null; orderId?: string | null },
): Promise<void> {
  const admin = createAdminClient();
  if (resolved.is_derived && resolved.coupon_id) {
    const cid = customerId || resolved.customer_id;
    if (!cid) return;
    await admin
      .from("coupon_redemptions")
      .insert({
        workspace_id: workspaceId,
        coupon_id: resolved.coupon_id,
        customer_id: cid,
        derived_code: resolved.code,
        order_id: ctx?.orderId || null,
        subscription_id: ctx?.subscriptionId || null,
      })
      .then(() => undefined, (e) => {
        console.warn("[coupons] redemption ledger insert failed:", e?.message || e);
      });
    return;
  }
  if (resolved.source === "internal" && resolved.coupon_id) {
    await admin
      .from("coupons")
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", resolved.coupon_id)
      .is("used_at", null);
    return;
  }
  // Shopify-sourced coupon (no row in our coupons table) — record by code so a
  // one-time/limited code can't be re-granted to the same customer on a later
  // renewal. coupon_id is null; derived_code carries the code.
  if (resolved.source === "shopify" && customerId) {
    await admin
      .from("coupon_redemptions")
      .insert({
        workspace_id: workspaceId,
        coupon_id: null,
        customer_id: customerId,
        derived_code: resolved.code,
        order_id: ctx?.orderId || null,
        subscription_id: ctx?.subscriptionId || null,
      })
      .then(() => undefined, (e) => {
        console.warn("[coupons] shopify redemption insert failed:", e?.message || e);
      });
  }
}

/** How many times this customer has already redeemed `code` (any source). */
export async function countCouponRedemptions(
  workspaceId: string,
  code: string,
  customerId: string,
): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("coupon_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .ilike("derived_code", code);
  return count || 0;
}

/**
 * Renewal-time coupon resolution. The sub stores coupon CODES (references), not
 * frozen values. For each code we live-read the current Shopify/internal coupon,
 * check this customer's prior redemptions, apply the discount if still valid, and
 * report which codes to KEEP vs DROP (a one-time or cycle-exhausted code is
 * dropped after this charge). Appstle automatic discounts + unresolvable codes
 * are dropped silently — our pricing rules own quantity breaks / free shipping.
 *
 * Returns the discount to subtract NOW, the codes to keep on the sub, and the
 * resolved coupons that should be recorded as redeemed AFTER a successful charge.
 */
export async function resolveRenewalDiscount(
  workspaceId: string,
  appliedDiscounts: Array<Record<string, unknown>> | null,
  subtotalCents: number,
  customerId: string | null,
): Promise<{ discountCents: number; keepCodes: string[]; toRedeem: ResolvedCoupon[] }> {
  const list = ((appliedDiscounts as AppliedDiscount[] | null) || []).filter(Boolean);
  let remaining = subtotalCents;
  let discountCents = 0;
  const keepCodes: string[] = [];
  const toRedeem: ResolvedCoupon[] = [];
  const seen = new Set<string>();

  for (const d of list) {
    const code = (d.code || d.title || "").trim();
    // Drop entries with no usable code (Appstle AUTOMATIC discounts have only a
    // title like "Buy 3 Discount" but resolve to nothing — our pricing rules
    // already apply those). Dedup repeated codes.
    if (!code || seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());

    const resolved = await resolveCoupon(workspaceId, code, customerId);
    if (!resolved) continue; // unresolvable / Appstle automatic → drop

    // Per-customer cap: one_time → 1; else recurring_cycle_limit (null = forever).
    const limit = resolved.one_time ? 1 : resolved.recurring_cycle_limit;
    const usedCount = customerId ? await countCouponRedemptions(workspaceId, code, customerId) : 0;
    if (limit != null && usedCount >= limit) continue; // already exhausted → drop

    const amt = resolved.type === "percentage"
      ? Math.round(remaining * (resolved.value / 100))
      : Math.min(resolved.value, remaining);
    const applied = Math.max(0, Math.min(amt, remaining));
    discountCents += applied;
    remaining -= applied;
    toRedeem.push(resolved);

    // Keep the code only if it has cycles left AFTER recording this redemption.
    if (limit == null || usedCount + 1 < limit) keepCodes.push(resolved.code);
  }

  return { discountCents, keepCodes, toRedeem };
}

/**
 * Derive a customer's code for a master coupon ("WELCOME-GSXN"). No row is
 * written — the coupon is virtual until redeemed (see recordCouponRedemption).
 * Returns null if the master doesn't exist or the customer has no short_code
 * (the BEFORE-INSERT trigger assigns one to every new customer, so this is
 * effectively always present).
 */
export async function deriveCustomerCoupon(
  workspaceId: string,
  customerId: string,
  masterCode: string,
): Promise<{ code: string } | null> {
  const admin = createAdminClient();
  const { data: master } = await admin
    .from("coupons")
    .select("code")
    .eq("workspace_id", workspaceId)
    .eq("is_master", true)
    .ilike("code", masterCode)
    .maybeSingle();
  if (!master?.code) return null;
  const sc = await ensureCustomerShortCode(admin, customerId);
  if (!sc) return null;
  return { code: `${master.code}-${sc}` };
}

// Crockford base32 (no I/L/O/U) — mirrors the customers_assign_short_code
// trigger so a code generated here is indistinguishable from a trigger one.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Return the customer's short_code, assigning one if it's missing. New
 * customers get a short_code from a BEFORE INSERT trigger, but a customer
 * MATCHED (not inserted) without one — e.g. a pre-trigger record — would
 * otherwise force the caller into the legacy `WELCOME-{custid}-{rand}` mint.
 * Assigning here guarantees a clean derived `{MASTER}-{short_code}` code.
 */
export async function ensureCustomerShortCode(admin: Admin, customerId: string): Promise<string | null> {
  const { data: cust } = await admin
    .from("customers")
    .select("short_code, workspace_id")
    .eq("id", customerId)
    .maybeSingle();
  if (cust?.short_code) return cust.short_code as string;
  if (!cust) return null;

  for (let attempt = 0; attempt < 12; attempt++) {
    let candidate = "";
    for (let i = 0; i < 5; i++) candidate += CROCKFORD[Math.floor(Math.random() * 32)];
    // Guard on short_code IS NULL so a concurrent assignment never gets
    // clobbered; unique (workspace_id, short_code) rejects collisions → retry.
    const { error } = await admin
      .from("customers")
      .update({ short_code: candidate })
      .eq("id", customerId)
      .is("short_code", null);
    if (!error) {
      const { data: re } = await admin.from("customers").select("short_code").eq("id", customerId).maybeSingle();
      if (re?.short_code) return re.short_code as string;
    }
  }
  return null;
}

/** Remove a coupon from an internal sub's applied_discounts. */
export async function removeCouponFromSub(
  workspaceId: string,
  contractId: string,
  codeOrId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, applied_discounts")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();
  if (!sub) return { success: false, error: "subscription_not_found" };
  const existing = (sub.applied_discounts as AppliedDiscount[]) || [];
  const remaining = existing.filter((d) => d.code !== codeOrId && d.title !== codeOrId && d.id !== codeOrId);
  await admin
    .from("subscriptions")
    .update({ applied_discounts: remaining, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

/**
 * The discount (cents) a single resolved coupon takes off a subtotal.
 * Percentage off the subtotal, or a fixed cents amount (capped at the subtotal).
 */
export function couponDiscountCents(
  resolved: Pick<ResolvedCoupon, "type" | "value">,
  subtotalCents: number,
): number {
  if (subtotalCents <= 0) return 0;
  const d = resolved.type === "percentage"
    ? Math.round(subtotalCents * (Math.max(0, Math.min(100, resolved.value)) / 100))
    : Math.max(0, resolved.value);
  return Math.max(0, Math.min(d, subtotalCents));
}

/** Mint a customer-scoped, single-use coupon (used by the smart popup). */
export async function mintCustomerCoupon(
  workspaceId: string,
  customerId: string,
  opts: { type: CouponType; value: number; recurring_cycle_limit?: number | null; codePrefix?: string },
): Promise<{ code: string } | null> {
  const admin = createAdminClient();
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const cust = customerId.replace(/-/g, "").slice(0, 6).toUpperCase();
  const code = `${opts.codePrefix || "SAVE"}-${cust}-${rand}`;
  const { error } = await admin.from("coupons").insert({
    workspace_id: workspaceId,
    code,
    type: opts.type,
    value: opts.value,
    scope: "order",
    recurring_cycle_limit: opts.recurring_cycle_limit ?? 1,
    customer_id: customerId,
    single_use: true,
  });
  if (error) {
    console.error("[coupons] mint failed:", error.message);
    return null;
  }
  return { code };
}

/**
 * Compute the entire-order discount for a renewal from applied_discounts, and
 * return the consumed list (cycles decremented, auto-expired entries dropped).
 * The scheduler uses `discountCents` for the charge and persists
 * `nextAppliedDiscounts` ONLY after a successful charge (don't burn a cycle on
 * a failed charge). Stacks multiple discounts on the running subtotal.
 */
export function computeAppliedDiscountCents(
  appliedDiscounts: Array<Record<string, unknown>> | null,
  subtotalCents: number,
): { discountCents: number; nextAppliedDiscounts: Array<Record<string, unknown>> } {
  const list = (appliedDiscounts as AppliedDiscount[] | null) || [];
  let remainingSubtotal = subtotalCents;
  let discountCents = 0;
  const next: AppliedDiscount[] = [];

  for (const d of list) {
    // Legacy/code-only entries (no type) can't be computed — keep, no discount.
    if (d.type !== "percentage" && d.type !== "fixed_amount") {
      next.push(d);
      continue;
    }
    // Already exhausted (shouldn't be present) — drop.
    if (d.remaining_cycles != null && d.remaining_cycles <= 0) continue;

    let amt = d.type === "percentage"
      ? Math.round(remainingSubtotal * ((d.value || 0) / 100))
      : Math.min(d.value || 0, remainingSubtotal);
    amt = Math.max(0, Math.min(amt, remainingSubtotal));
    discountCents += amt;
    remainingSubtotal -= amt;

    // Consume a cycle (forever = null → keep).
    if (d.remaining_cycles == null) {
      next.push(d);
    } else {
      const rem = d.remaining_cycles - 1;
      if (rem > 0) next.push({ ...d, remaining_cycles: rem });
      // rem <= 0 → drop (auto-expire after this charge)
    }
  }

  return { discountCents, nextAppliedDiscounts: next as Array<Record<string, unknown>> };
}
