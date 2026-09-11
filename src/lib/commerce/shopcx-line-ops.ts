/**
 * Line mutations for ShopCX-billed subscriptions — quantity, swap, add, remove.
 *
 * ⭐ Every mutation RECOMPUTES the whole structural discount set, in the SAME draft.
 *
 * A quantity change from 2 to 3 moves the customer from the 8% tier to 12%, and a pinned
 * percentage does not follow on its own — nothing in Shopify re-evaluates a contract's discounts.
 * (Appstle's "Buy 2 Discount" entries look automatic but are stored manual discounts frozen at
 * contract creation, which is exactly why 386 contracts sit on the wrong tier today.) Recomputing
 * from scratch is idempotent and cannot drift.
 *
 * ⚠️ Same draft, or there is a window. If the quantity commits in one draft and the discount in
 * another, a charge landing between them bills the new quantity at the old tier.
 *
 * ⚠️ Customer codes are NEVER touched. A loyalty or promo code is something the customer applied,
 * is one-use by design, and falling off after its cycle is correct behaviour — wiping it on a
 * quantity change would silently take back something they were given. Only titles we own are
 * rewritten, and a customer can never apply an S&S or a quantity break, so anything carrying those
 * titles is ours by construction.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  withDraft,
  getSubscriptionContract,
  shopifyAddDraftDiscount,
  shopifyRemoveDraftLine,
  shopifyUpdateDraftLine,
  shopifyAddDraftLine,
  shopifyRemoveStructuralDiscounts,
  type ManualDiscountInput,
} from "@/lib/commerce/shopify-subscription-client";
import { loadPricingContext, breakPctForQty, shopifyLineMath } from "@/lib/commerce/shopify-subscription-migrate";
import { errText } from "@/lib/error-text";

export interface LineOpResult { success: boolean; error?: string; alreadyAbsent?: boolean }

/** The pricing rule every consumable is on. Read from the DB, never hardcoded per product. */
async function activePricingRuleId(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pricing_rules").select("id").eq("workspace_id", workspaceId).eq("is_active", true).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Read the contract's current discounts so we can tell ours from the customer's. */
async function currentDiscounts(
  workspaceId: string,
  contractId: string,
): Promise<{ id: string; title: string | null; type: string | null }[]> {
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
  const j = await res.json().catch(() => null) as
    | { data?: { subscriptionContract?: { discounts?: { nodes?: { id: string; type: string | null; title: string | null }[] } } } }
    | null;
  return j?.data?.subscriptionContract?.discounts?.nodes ?? [];
}

/**
 * Recompute the structural discounts for the contract's CURRENT lines, inside an open draft.
 *
 * Grandfathering is preserved: each line's existing effective rate is compared against what the
 * rules now say, and the shortfall is re-minted as a per-unit line discount. Without this a
 * quantity change would quietly promote a grandfathered customer to standard pricing.
 */
async function rewriteStructuralDiscounts(
  workspaceId: string,
  contractId: string,
  draftId: string,
): Promise<LineOpResult> {
  const ruleId = await activePricingRuleId(workspaceId);
  if (!ruleId) return { success: false, error: "no active pricing rule" };
  const ctx = await loadPricingContext(workspaceId, ruleId);

  const live = await getSubscriptionContract(workspaceId, contractId);
  if (!live.success || !live.contract) return { success: false, error: live.error ?? "contract unreadable" };

  const existing = await currentDiscounts(workspaceId, contractId);
  const cleared = await shopifyRemoveStructuralDiscounts(workspaceId, draftId, existing);
  if (!cleared.success) return cleared;

  // Mix-and-match tier over rule lines only — protection never counts toward it.
  const resolved = live.contract.lines.map((l) => ({
    l,
    v: l.sku ? ctx.variantBySku.get(String(l.sku).toLowerCase()) : undefined,
  }));
  const isProt = (pid?: string) => /protection/i.test(ctx.productTitle.get(pid ?? "") ?? "");
  const mixQty = resolved
    .filter((r) => r.v && ctx.ruleProducts.has(r.v.product_id) && !isProt(r.v.product_id))
    .reduce((a, r) => a + (r.l.quantity || 1), 0);
  const breakPct = breakPctForQty(ctx.breaks, mixQty);

  for (const { l, v } of resolved) {
    if (!v || !ctx.ruleProducts.has(v.product_id) || isProt(v.product_id)) continue;
    const qty = l.quantity || 1;
    const effectiveNow = l.lineDiscountedPrice != null
      ? Math.round((parseFloat(l.lineDiscountedPrice) * 100) / qty)
      : null;
    const standard = shopifyLineMath(v.price_cents, qty, ctx.snsPct, breakPct).standardUnitCents;
    const grandfather = effectiveNow != null && effectiveNow > 0 && effectiveNow < standard
      ? standard - effectiveNow
      : 0;

    const discounts: ManualDiscountInput[] = [];
    if (ctx.snsPct > 0) discounts.push({ title: "Subscribe & Save", value: { percentage: ctx.snsPct }, entitledLines: { lines: { add: [l.id] } } });
    if (breakPct > 0) discounts.push({ title: "Volume discount", value: { percentage: breakPct }, entitledLines: { lines: { add: [l.id] } } });
    if (grandfather > 0) {
      discounts.push({
        title: "Legacy rate",
        value: { fixedAmount: { amount: grandfather / 100, appliesOnEachItem: true } },
        entitledLines: { lines: { add: [l.id] } },
      });
    }
    for (const d of discounts) {
      const r = await shopifyAddDraftDiscount(workspaceId, draftId, d);
      if (!r.success) return r;
    }
  }
  return { success: true };
}

/** Find a line on the contract by variant id. */
async function findLine(workspaceId: string, contractId: string, variantId: string) {
  const c = await getSubscriptionContract(workspaceId, contractId);
  if (!c.success || !c.contract) return { error: c.error ?? "contract unreadable" as string };
  const bare = String(variantId).replace("gid://shopify/ProductVariant/", "");
  const line = c.contract.lines.find(
    (l) => String(l.variantId ?? "").replace("gid://shopify/ProductVariant/", "") === bare,
  );
  return { line, contract: c.contract };
}

export async function shopcxChangeQuantity(
  workspaceId: string, contractId: string, variantId: string, quantity: number,
): Promise<LineOpResult> {
  try {
    const { line, error } = await findLine(workspaceId, contractId, variantId);
    if (error) return { success: false, error };
    if (!line) return { success: false, error: "variant not on this contract" };
    return withDraft(workspaceId, contractId, async (draftId) => {
      const { shopifyUpdateLineQuantityInDraft } = await import("@/lib/commerce/shopify-subscription-client");
      const q = await shopifyUpdateLineQuantityInDraft(workspaceId, draftId, line.id, quantity);
      if (!q.success) return q;
      // SAME draft — a separate commit would leave a window at the old tier.
      return rewriteStructuralDiscounts(workspaceId, contractId, draftId);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

export async function shopcxRemoveItem(
  workspaceId: string, contractId: string, variantId: string,
): Promise<LineOpResult> {
  try {
    const { line, contract, error } = await findLine(workspaceId, contractId, variantId);
    if (error) return { success: false, error };
    if (!line) return { success: true, alreadyAbsent: true };
    if ((contract?.lines.length ?? 0) <= 1) {
      return { success: false, error: "refusing to remove the last line — cancel the subscription instead" };
    }
    return withDraft(workspaceId, contractId, async (draftId) => {
      const r = await shopifyRemoveDraftLine(workspaceId, draftId, line.id);
      if (!r.success) return r;
      return rewriteStructuralDiscounts(workspaceId, contractId, draftId);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

/**
 * Swap a line's variant — a flavour change.
 *
 * ⭐ Done as a DRAFT line update rather than `subscriptionContractProductChange`, so the swap and
 * the discount recompute commit together. Split across two operations there is a window where the
 * new variant is priced on the old line's discounts.
 *
 * The new line is created at the new variant's catalog MSRP; `rewriteStructuralDiscounts` then
 * applies S&S and the tier. A grandfathered rate does NOT carry across a swap — it was negotiated
 * on a specific product, which is exactly why it is stored per-line and variant-scoped.
 */
export async function shopcxSwapVariant(
  workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity?: number,
): Promise<LineOpResult> {
  try {
    const { line, error } = await findLine(workspaceId, contractId, oldVariantId);
    if (error) return { success: false, error };
    if (!line) return { success: false, error: "variant not on this contract" };

    const ruleId = await activePricingRuleId(workspaceId);
    if (!ruleId) return { success: false, error: "no active pricing rule" };
    const ctx = await loadPricingContext(workspaceId, ruleId);
    const bare = String(newVariantId).replace("gid://shopify/ProductVariant/", "");
    const target = ctx.variantByShopifyId.get(bare);
    if (!target) return { success: false, error: `variant ${bare} is not in the catalog` };

    return withDraft(workspaceId, contractId, async (draftId) => {
      const u = await shopifyUpdateDraftLine(workspaceId, draftId, line.id, {
        productVariantId: bare,
        ...(quantity != null ? { quantity } : {}),
        currentPrice: (target.price_cents / 100).toFixed(2),   // MSRP; discounts do the rest
      });
      if (!u.success) return u;
      return rewriteStructuralDiscounts(workspaceId, contractId, draftId);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

/** Add a line at catalog MSRP, then recompute — a new line can change the quantity tier. */
export async function shopcxAddItem(
  workspaceId: string, contractId: string, variantId: string, quantity = 1,
): Promise<LineOpResult> {
  try {
    const ruleId = await activePricingRuleId(workspaceId);
    if (!ruleId) return { success: false, error: "no active pricing rule" };
    const ctx = await loadPricingContext(workspaceId, ruleId);
    const bare = String(variantId).replace("gid://shopify/ProductVariant/", "");
    const target = ctx.variantByShopifyId.get(bare);
    if (!target) return { success: false, error: `variant ${bare} is not in the catalog` };

    const { line } = await findLine(workspaceId, contractId, bare);
    if (line) {
      // Already present — adding a second line for the same variant would split the quantity
      // across two lines and make every by-variant lookup ambiguous. Raise the quantity instead.
      return shopcxChangeQuantity(workspaceId, contractId, bare, (line.quantity || 1) + quantity);
    }
    return withDraft(workspaceId, contractId, async (draftId) => {
      const a = await shopifyAddDraftLine(workspaceId, draftId, bare, quantity, (target.price_cents / 100).toFixed(2));
      if (!a.success) return a;
      // A new line changes the mix-and-match total, so every line's tier may move.
      return rewriteStructuralDiscounts(workspaceId, contractId, draftId);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

/**
 * Pin a line's pre-discount BASE price — the grandfathering primitive.
 *
 * `basePriceCents` is the strikethrough base, not the charged amount: S&S and the quantity break
 * still apply on top, matching `price_override_cents` on the internal path. The recompute then
 * re-derives the grandfather against it.
 */
export async function shopcxUpdateLineItemPrice(
  workspaceId: string, contractId: string, variantId: string, basePriceCents: number,
): Promise<LineOpResult> {
  try {
    const { line, error } = await findLine(workspaceId, contractId, variantId);
    if (error) return { success: false, error };
    if (!line) return { success: false, error: "variant not on this contract" };
    if (!Number.isFinite(basePriceCents) || basePriceCents < 0) {
      return { success: false, error: `invalid base price ${basePriceCents}` };
    }
    return withDraft(workspaceId, contractId, async (draftId) => {
      const u = await shopifyUpdateDraftLine(workspaceId, draftId, line.id, {
        currentPrice: (basePriceCents / 100).toFixed(2),
      });
      if (!u.success) return u;
      return rewriteStructuralDiscounts(workspaceId, contractId, draftId);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}
