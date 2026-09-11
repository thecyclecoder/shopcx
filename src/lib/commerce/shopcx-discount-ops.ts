/**
 * Coupon apply/remove for ShopCX-billed subscriptions.
 *
 * ⭐ A coupon is minted as a MANUAL discount from our OWN resolution of the code — never handed
 * to Shopify as a redeem code, even though `subscriptionDraftDiscountCodeApply` exists and would
 * take one. Two reasons, both load-bearing:
 *
 *   1. Most of our codes have no Shopify existence at all. Loyalty codes are internal-native by
 *      design (ticket 46a7aa75 — a Shopify-minted loyalty code was deleted upstream and silently
 *      zeroed the discount at renewal), so `resolveCoupon` is the only authority that can price
 *      them. Routing Shopify-native codes through a second path would give promo and loyalty
 *      different semantics on the same contract.
 *   2. `resolveCoupon` carries the internal-wins precedence, the derived-code owner check, and
 *      the single-use ceiling. A redeem code handed to Shopify bypasses every one of them.
 *
 * ⚠️ The engine's OTHER half must leave these alone, and does: the structural rewrite in
 * `shopcx-line-ops.ts` only touches MANUAL discounts whose title is in
 * `STRUCTURAL_DISCOUNT_TITLES`, and a coupon is titled with its own code. The reverse also holds
 * — the removals here never touch a structural title, so clearing a coupon cannot strip a
 * customer's grandfathered rate.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  withDraft,
  shopifyAddDraftDiscount,
  shopifyRemoveDraftDiscount,
  STRUCTURAL_DISCOUNT_TITLES,
  type ManualDiscountInput,
} from "@/lib/commerce/shopify-subscription-client";
import type { ResolvedCoupon, AppliedDiscount } from "@/lib/coupons";
import { errText } from "@/lib/error-text";

export interface DiscountOpResult { success: boolean; error?: string }

/**
 * The contract's discounts as Shopify holds them, split into ours and the customer's.
 *
 * A CODE discount (`SubscriptionAppliedCodeDiscount`) can only ever be the customer's — we mint
 * manual discounts exclusively — so it counts as a coupon for removal purposes even though we
 * did not create it. That matters for migrated contracts: Appstle left code discounts on some.
 */
async function splitDiscounts(
  workspaceId: string,
  contractId: string,
): Promise<{ structural: { id: string }[]; coupons: { id: string; title: string | null }[] }> {
  const { getShopifyCredentials } = await import("@/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const gid = String(contractId).startsWith("gid://")
    ? contractId : `gid://shopify/SubscriptionContract/${contractId}`;
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:ID!){ subscriptionContract(id:$id){ discounts(first:25){ nodes{ id type title } } } }`,
      variables: { id: gid },
    }),
  });
  const j = (await res.json().catch(() => null)) as
    | { data?: { subscriptionContract?: { discounts?: { nodes?: { id: string; type: string | null; title: string | null }[] } } } }
    | null;
  const nodes = j?.data?.subscriptionContract?.discounts?.nodes ?? [];
  const isStructural = (d: { type: string | null; title: string | null }) =>
    d.type === "MANUAL" && STRUCTURAL_DISCOUNT_TITLES.includes(String(d.title ?? ""));
  return {
    structural: nodes.filter(isStructural).map((d) => ({ id: d.id })),
    coupons: nodes.filter((d) => !isStructural(d)).map((d) => ({ id: d.id, title: d.title })),
  };
}

/** Mirror what we just did onto `subscriptions.applied_discounts`, preserving our own rows. */
async function writeMirror(
  workspaceId: string,
  contractId: string,
  coupon: AppliedDiscount | null,
): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions").select("applied_discounts")
    .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
  const existing = ((data?.applied_discounts as AppliedDiscount[] | null) ?? []).filter(
    (d) => STRUCTURAL_DISCOUNT_TITLES.includes(String(d.title ?? "")),
  );
  await admin.from("subscriptions")
    .update({
      applied_discounts: coupon ? [...existing, coupon] : existing,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId);
}

/**
 * Apply a coupon, replacing any coupon already on the contract — one code per subscription, the
 * same invariant the Appstle and internal engines hold.
 *
 * Takes an ALREADY-RESOLVED coupon so the loyalty materialization, the derived-code owner check
 * and the internal-wins precedence stay in the one dispatcher that does them for every engine
 * (`subscriptionApplyCoupon`), rather than being reimplemented per engine and drifting.
 */
export async function shopcxApplyCoupon(
  workspaceId: string,
  contractId: string,
  resolved: ResolvedCoupon,
): Promise<DiscountOpResult> {
  try {
    // A code that collides with one of our own titles would be stripped by the next structural
    // rewrite — or worse, survive it and be read back as a grandfathered rate. Refuse instead.
    if (STRUCTURAL_DISCOUNT_TITLES.includes(resolved.code)) {
      return { success: false, error: "coupon_code_reserved" };
    }
    if (!(resolved.value > 0)) return { success: false, error: "coupon_has_no_value" };

    const { coupons } = await splitDiscounts(workspaceId, contractId);

    // `null` means forever; every other shape is a finite run of cycles. Loyalty is 1 by
    // construction — Shopify expires it on its own, so nothing has to sweep it off later.
    const cycles = resolved.recurring_cycle_limit;
    const input: ManualDiscountInput = {
      title: resolved.code,
      value: resolved.type === "percentage"
        ? { percentage: resolved.value }
        : { fixedAmount: { amount: resolved.value / 100, appliesOnEachItem: false } },
      ...(cycles != null && cycles > 0 ? { recurringCycleLimit: cycles } : {}),
      // Order-wide, like a code at checkout. A coupon is not variant-scoped — that is what
      // distinguishes it from the grandfathered rate, which is deliberately per-line.
      entitledLines: { all: true },
    };

    const r = await withDraft(workspaceId, contractId, async (draftId) => {
      // Replace, in the SAME draft. Split across two commits there is a window in which the
      // contract carries both codes, and a charge landing in it stacks them.
      for (const c of coupons) {
        const rm = await shopifyRemoveDraftDiscount(workspaceId, draftId, c.id);
        if (!rm.success) return rm;
      }
      return shopifyAddDraftDiscount(workspaceId, draftId, input);
    });
    if (!r.success) return { success: false, error: r.error };

    await writeMirror(workspaceId, contractId, {
      code: resolved.code,
      title: resolved.code,
      type: resolved.type,
      value: resolved.value,
      recurring_cycle_limit: cycles,
      remaining_cycles: cycles,
      source: resolved.source,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

/**
 * Remove the coupon(s) from a ShopCX contract.
 *
 * Clears every non-structural discount rather than matching on the passed code: the invariant is
 * one coupon per subscription, so "the coupon" is unambiguous, and a migrated contract carrying a
 * code discount Appstle left behind has to be removable even though its title never matched what
 * the caller asked for. Structural discounts are never in scope.
 */
export async function shopcxRemoveCoupon(
  workspaceId: string,
  contractId: string,
): Promise<DiscountOpResult> {
  try {
    const { coupons } = await splitDiscounts(workspaceId, contractId);
    if (coupons.length === 0) return { success: false, error: "coupon_not_found" };
    const r = await withDraft(workspaceId, contractId, async (draftId) => {
      for (const c of coupons) {
        const rm = await shopifyRemoveDraftDiscount(workspaceId, draftId, c.id);
        if (!rm.success) return rm;
      }
      return { success: true };
    });
    if (!r.success) return { success: false, error: r.error };
    await writeMirror(workspaceId, contractId, null);
    return { success: true };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}
