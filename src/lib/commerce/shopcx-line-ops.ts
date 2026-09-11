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
  getSubscriptionDraft,
  STRUCTURAL_DISCOUNT_TITLES,
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

/**
 * The grandfathered per-unit concession each line carries TODAY, measured against what the rules
 * say that line should cost at its CURRENT quantity.
 *
 * Captured from the committed contract BEFORE the draft opens, because it is a property of the
 * rate the customer already has — not of the edit being made. Measured after the edit it would be
 * compared against a tier the line has only just moved to, and the concession would grow or
 * vanish with every quantity change.
 *
 * Only OUR allocations are subtracted: a customer's coupon sits on the same line, and inferring a
 * rate from a price their one-use code reduced would re-mint that code as a permanent discount.
 */
async function captureGrandfatherByLine(
  workspaceId: string,
  contractId: string,
  ctx: Awaited<ReturnType<typeof loadPricingContext>>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const live = await getSubscriptionContract(workspaceId, contractId);
  if (!live.success || !live.contract) return out;

  const resolved = live.contract.lines.map((l) => ({
    l, v: l.sku ? ctx.variantBySku.get(String(l.sku).toLowerCase()) : undefined,
  }));
  const mixQty = resolved
    .filter((r) => r.v && ctx.ruleProducts.has(r.v.product_id) && !isProtection(ctx, r.v.product_id))
    .reduce((a, r) => a + (r.l.quantity || 1), 0);
  const breakPct = breakPctForQty(ctx.breaks, mixQty);

  for (const { l, v } of resolved) {
    if (!v || !ctx.ruleProducts.has(v.product_id) || isProtection(ctx, v.product_id)) continue;
    const qty = l.quantity || 1;
    if (l.currentPrice == null) continue;
    const unitBase = Math.round(parseFloat(l.currentPrice) * 100);

    // ⚠️ Measure against what the rules make of THIS LINE'S OWN base, not catalog MSRP. The
    // recompute applies its percentages to the line's `currentPrice`, so a line already pinned
    // BELOW MSRP (`shopcxUpdateLineItemPrice`, the internal `price_override_cents` equivalent)
    // would otherwise look like it carried a concession equal to the whole MSRP gap — and the
    // rewrite would take that off a base that already reflected it, discounting twice.
    const standardLine = shopifyLineMath(unitBase, qty, ctx.snsPct, breakPct).lineTotalCents;
    const effectiveLine = unitBase * qty - l.structuralDiscountCents;
    const shortfall = standardLine - effectiveLine;
    if (effectiveLine > 0 && shortfall > 0) out.set(l.id, Math.round(shortfall / qty));
  }
  return out;
}

function isProtection(ctx: Awaited<ReturnType<typeof loadPricingContext>>, productId?: string): boolean {
  return /protection/i.test(ctx.productTitle.get(productId ?? "") ?? "");
}

/**
 * Recompute the structural discounts for the draft's POST-EDIT lines, inside that same draft.
 *
 * ⭐ Reads the DRAFT, not the contract. Mid-edit the contract still holds the old quantities, and
 * recomputing from it prices the new state on the old tier — then prices the next edit's old
 * state on the new tier. Both halves were observed live on 35945087149.
 *
 * `grandfather` is the per-unit concession captured before the edit; it is re-applied at the new
 * quantity so the tier follows the line while the negotiated rate follows the customer.
 */
async function rewriteStructuralDiscounts(
  workspaceId: string,
  draftId: string,
  ctx: Awaited<ReturnType<typeof loadPricingContext>>,
  grandfather: Map<string, number>,
): Promise<LineOpResult> {
  const draft = await getSubscriptionDraft(workspaceId, draftId);
  if (!draft.success || !draft.lines) return { success: false, error: draft.error ?? "draft unreadable" };

  const structural = (draft.discounts ?? []).filter(
    (d) => d.type === "MANUAL" && STRUCTURAL_DISCOUNT_TITLES.includes(String(d.title ?? "")),
  );
  const cleared = await shopifyRemoveStructuralDiscounts(workspaceId, draftId, structural);
  if (!cleared.success) return cleared;

  // Mix-and-match tier over rule lines only — protection never counts toward it.
  const resolved = draft.lines.map((l) => ({
    l, v: l.sku ? ctx.variantBySku.get(String(l.sku).toLowerCase()) : undefined,
  }));
  const mixQty = resolved
    .filter((r) => r.v && ctx.ruleProducts.has(r.v.product_id) && !isProtection(ctx, r.v.product_id))
    .reduce((a, r) => a + (r.l.quantity || 1), 0);
  const breakPct = breakPctForQty(ctx.breaks, mixQty);

  for (const { l, v } of resolved) {
    if (!v || !ctx.ruleProducts.has(v.product_id) || isProtection(ctx, v.product_id)) continue;
    const grandfatherUnit = grandfather.get(l.id) ?? 0;

    const discounts: ManualDiscountInput[] = [];
    if (ctx.snsPct > 0) discounts.push({ title: "Subscribe & Save", value: { percentage: ctx.snsPct }, entitledLines: { lines: { add: [l.id] } } });
    if (breakPct > 0) discounts.push({ title: "Volume discount", value: { percentage: breakPct }, entitledLines: { lines: { add: [l.id] } } });
    if (grandfatherUnit > 0) {
      discounts.push({
        title: "Legacy rate",
        value: { fixedAmount: { amount: grandfatherUnit / 100, appliesOnEachItem: true } },
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

/** Load the pricing rule + each line's existing concession, before anything is edited. */
async function preparePricing(
  workspaceId: string,
  contractId: string,
): Promise<{ ctx: Awaited<ReturnType<typeof loadPricingContext>>; grandfather: Map<string, number> } | { error: string }> {
  const ruleId = await activePricingRuleId(workspaceId);
  if (!ruleId) return { error: "no active pricing rule" };
  const ctx = await loadPricingContext(workspaceId, ruleId);
  return { ctx, grandfather: await captureGrandfatherByLine(workspaceId, contractId, ctx) };
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
    const prep = await preparePricing(workspaceId, contractId);
    if ("error" in prep) return { success: false, error: prep.error };
    return withDraft(workspaceId, contractId, async (draftId) => {
      const { shopifyUpdateLineQuantityInDraft } = await import("@/lib/commerce/shopify-subscription-client");
      const q = await shopifyUpdateLineQuantityInDraft(workspaceId, draftId, line.id, quantity);
      if (!q.success) return q;
      // SAME draft — a separate commit would leave a window at the old tier.
      return rewriteStructuralDiscounts(workspaceId, draftId, prep.ctx, prep.grandfather);
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
    const prep = await preparePricing(workspaceId, contractId);
    if ("error" in prep) return { success: false, error: prep.error };
    return withDraft(workspaceId, contractId, async (draftId) => {
      const r = await shopifyRemoveDraftLine(workspaceId, draftId, line.id);
      if (!r.success) return r;
      return rewriteStructuralDiscounts(workspaceId, draftId, prep.ctx, prep.grandfather);
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

    const prep = await preparePricing(workspaceId, contractId);
    if ("error" in prep) return { success: false, error: prep.error };
    const { ctx } = prep;
    // A swap does NOT carry the concession — it was negotiated on the outgoing product.
    prep.grandfather.delete(line.id);
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
      return rewriteStructuralDiscounts(workspaceId, draftId, prep.ctx, prep.grandfather);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

/** Add a line at catalog MSRP, then recompute — a new line can change the quantity tier. */
export async function shopcxAddItem(
  workspaceId: string, contractId: string, variantId: string, quantity = 1,
): Promise<LineOpResult> {
  try {
    const prep = await preparePricing(workspaceId, contractId);
    if ("error" in prep) return { success: false, error: prep.error };
    const { ctx } = prep;
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
      return rewriteStructuralDiscounts(workspaceId, draftId, prep.ctx, prep.grandfather);
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
    const prep = await preparePricing(workspaceId, contractId);
    if ("error" in prep) return { success: false, error: prep.error };
    // The caller is REDEFINING this line's base, so the concession is re-derived from the new
    // base by the recompute below — carrying the old one forward would double-count it.
    prep.grandfather.delete(line.id);
    return withDraft(workspaceId, contractId, async (draftId) => {
      const u = await shopifyUpdateDraftLine(workspaceId, draftId, line.id, {
        currentPrice: (basePriceCents / 100).toFixed(2),
      });
      if (!u.success) return u;
      return rewriteStructuralDiscounts(workspaceId, draftId, prep.ctx, prep.grandfather);
    });
  } catch (err) { return { success: false, error: errText(err) }; }
}

/**
 * Add a ONE-TIME line — the retention gift.
 *
 * ⭐ Scoped to a single billing cycle, never to the contract. `shopcxAddItem` would make the gift
 * RECURRING: free on every renewal, forever. That is the whole reason this is a separate function
 * rather than `shopcxAddItem(…, price 0)`.
 *
 * Targets the cycle the customer's NEXT charge falls in, which is when the gift ships. The
 * structural recompute deliberately does NOT run: a gift is not a rule line, it must not move
 * anyone into a quantity tier, and being cycle-scoped it never appears among the contract's lines
 * to be counted anyway — which is also why it does not violate the no-$0-consumable-lines rule.
 */
export async function shopcxAddOneTimeLine(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity = 1,
  priceCents = 0,
): Promise<LineOpResult> {
  try {
    const live = await getSubscriptionContract(workspaceId, contractId);
    if (!live.success || !live.contract) return { success: false, error: live.error ?? "contract unreadable" };
    if (live.contract.status !== "ACTIVE") {
      return { success: false, error: `contract is ${live.contract.status.toLowerCase()}` };
    }
    const due = live.contract.nextBillingDate;
    if (!due) return { success: false, error: "contract has no next billing date" };

    // ⚠️ Shopify rejects a selector date before the contract's createdAt ("Billing cycle start
    // date out of range"), and a MIGRATED contract is created today while its next billing date
    // may already be past. Clamp into the first cycle — that is the cycle the charge belongs to.
    // Same clamp the renewal worker applies; see shopify-subscription-renewals.ts.
    const created = live.contract.createdAt ? new Date(live.contract.createdAt).getTime() : 0;
    const date = created && new Date(due).getTime() < created
      ? new Date(created + 1000).toISOString()
      : new Date(due).toISOString();

    // ⚠️ Refuse LOUDLY on a cycle that cannot ship the gift. Shopify accepts an edit to an
    // already-BILLED or skipped cycle and reports success, but that order has shipped (or won't),
    // so the customer never receives what a retention flow just promised them — the worst shape of
    // failure: the save offer is recorded as honoured and silently isn't.
    const { withBillingCycleDraft, getBillingCycleForDate } = await import("@/lib/commerce/shopify-subscription-client");
    const cyc = await getBillingCycleForDate(workspaceId, contractId, date);
    if (!cyc.success || !cyc.cycle) return { success: false, error: cyc.error ?? "cycle_unresolvable" };
    if (cyc.cycle.status === "BILLED") return { success: false, error: "next cycle already billed — gift would never ship" };
    if (cyc.cycle.skipped) return { success: false, error: "next cycle is skipped — gift would never ship" };

    const bare = String(variantId).replace("gid://shopify/ProductVariant/", "");
    return withBillingCycleDraft(workspaceId, contractId, { date }, (draftId) =>
      shopifyAddDraftLine(workspaceId, draftId, bare, quantity, (priceCents / 100).toFixed(2)),
    );
  } catch (err) { return { success: false, error: errText(err) }; }
}
