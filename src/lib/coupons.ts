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

type Admin = ReturnType<typeof createAdminClient>;

export type CouponType = "percentage" | "fixed_amount";

export interface ResolvedCoupon {
  code: string;
  type: CouponType;
  value: number; // percentage: 0-100 · fixed_amount: cents
  recurring_cycle_limit: number | null; // 1 | N | null (forever)
  source: "internal" | "shopify";
  coupon_id?: string; // internal row id (source = internal)
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

  // 1. Internal table (internal wins).
  const { data: rows } = await admin
    .from("coupons")
    .select("id, code, type, value, recurring_cycle_limit, customer_id, single_use, used_at")
    .eq("workspace_id", workspaceId)
    .ilike("code", code)
    .limit(1);
  const row = rows?.[0];
  if (row) {
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

  // 2. Real-time Shopify lookup (transitional — legacy codes).
  return resolveShopifyCoupon(admin, workspaceId, code);
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
          query: `{ codeDiscountNodeByCode(code: ${JSON.stringify(code)}) { codeDiscount { ... on DiscountCodeBasic { recurringCycleLimit customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } } } } } }`,
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
    if (val?.percentage != null) {
      return { code, type: "percentage", value: Math.round(Number(val.percentage) * 100), recurring_cycle_limit, source: "shopify" };
    }
    if (val?.amount?.amount != null) {
      return { code, type: "fixed_amount", value: Math.round(parseFloat(val.amount.amount) * 100), recurring_cycle_limit, source: "shopify" };
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
    .select("id, applied_discounts")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();
  if (!sub) return { success: false, error: "subscription_not_found" };

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

  // Burn a single-use internal coupon.
  if (resolved.source === "internal" && resolved.coupon_id) {
    await admin
      .from("coupons")
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", resolved.coupon_id)
      .is("used_at", null);
  }
  return { success: true };
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
