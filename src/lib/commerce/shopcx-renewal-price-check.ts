/**
 * Log-only pricing check for a ShopCX renewal — what the pricing rules say a contract should cost,
 * against what Shopify is about to charge.
 *
 * ⭐ A ShopCX renewal charges whatever the CONTRACT says; Shopify computes the price, we never pass
 * one. Correctness lives in the code that writes the contract (ingest normalization, migration,
 * the line-ops structural recompute). This is the tripwire behind those writes: it never blocks,
 * delays or alters a charge (CEO 2026-10-10, "log only"). A mismatch becomes one
 * `dashboard_notifications` card for a human.
 *
 * What counts:
 *   expected = MSRP (or a deliberately pinned base) → S&S → quantity tier, with Shopify's own
 *              sequential-truncating math (`shopifyLineMath`), minus the line's `Legacy rate`
 *   actual   = currentPrice × qty − OUR structural allocations − any checkout AUTOMATIC copy still on
 *              the contract (a leftover S&S / Buy 2-3 copy stacking on ours reads as an undercharge)
 *
 * A customer coupon is excluded from BOTH sides — it is something they were given, not drift.
 * A base below MSRP counts as a deliberate pin only when the line already carries our structural
 * discounts; below MSRP with none is the selling-plan-baked checkout shape, and is measured
 * against MSRP so a missing tier shows up.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSubscriptionContract } from "@/lib/commerce/shopify-subscription-client";
import { loadPricingContext, breakPctForQty, shopifyLineMath } from "@/lib/commerce/shopify-subscription-migrate";
import { activePricingRuleId } from "@/lib/commerce/shopcx-line-ops";
import { errText } from "@/lib/error-text";

/** $1 and 2% — below this a difference is rounding noise, the same bar subscription-overcharge uses. */
const MATERIAL_CENTS = 100;
const MATERIAL_PCT = 0.02;

export interface RenewalPriceLine {
  title: string;
  sku: string | null;
  quantity: number;
  expectedCents: number;
  actualCents: number;
}

export type RenewalPriceVerdict =
  | { status: "match"; expectedCents: number; actualCents: number }
  | { status: "overcharge" | "undercharge"; expectedCents: number; actualCents: number; lines: RenewalPriceLine[] }
  | { status: "unchecked"; reason: string };

/** Pure: is this gap worth a human's attention? */
export function isMaterialGap(expectedCents: number, actualCents: number): boolean {
  const gap = Math.abs(actualCents - expectedCents);
  return gap > Math.max(MATERIAL_CENTS, Math.round(expectedCents * MATERIAL_PCT));
}

/** Read-only. Never throws — a check that cannot run returns `unchecked`, it never blocks a charge. */
export async function checkShopcxRenewalPrice(workspaceId: string, contractId: string): Promise<RenewalPriceVerdict> {
  try {
    const ruleId = await activePricingRuleId(workspaceId);
    if (!ruleId) return { status: "unchecked", reason: "no active pricing rule" };
    const ctx = await loadPricingContext(workspaceId, ruleId);
    const live = await getSubscriptionContract(workspaceId, contractId);
    if (!live.success || !live.contract) return { status: "unchecked", reason: `contract unreadable: ${live.error}` };

    const isProtection = (productId: string) => /protection/i.test(ctx.productTitle.get(productId) ?? "");
    const resolved = live.contract.lines.map((l) => ({
      l, v: l.sku ? ctx.variantBySku.get(String(l.sku).toLowerCase()) : undefined,
    }));
    const rule = resolved.filter((r) => r.v && ctx.ruleProducts.has(r.v.product_id) && !isProtection(r.v.product_id));
    if (!rule.length) return { status: "unchecked", reason: "no rule lines" };
    const mixQty = rule.reduce((a, r) => a + (r.l.quantity || 1), 0);
    const breakPct = breakPctForQty(ctx.breaks, mixQty);

    const lines: RenewalPriceLine[] = [];
    for (const { l, v } of rule) {
      if (l.currentPrice == null) continue;
      const qty = l.quantity || 1;
      const current = Math.round(parseFloat(l.currentPrice) * 100);
      const msrp = v!.price_cents;
      const pinned = current < msrp && l.structuralDiscountCents > 0;
      const base = pinned ? current : msrp;
      const expected = shopifyLineMath(base, qty, ctx.snsPct, breakPct).lineTotalCents - l.legacyRateCents;
      const actual = current * qty - l.structuralDiscountCents - l.automaticDiscountCents;
      lines.push({ title: l.title, sku: l.sku, quantity: qty, expectedCents: expected, actualCents: actual });
    }
    const expectedCents = lines.reduce((a, x) => a + x.expectedCents, 0);
    const actualCents = lines.reduce((a, x) => a + x.actualCents, 0);
    if (!isMaterialGap(expectedCents, actualCents)) return { status: "match", expectedCents, actualCents };
    return {
      status: actualCents > expectedCents ? "overcharge" : "undercharge",
      expectedCents, actualCents,
      lines: lines.filter((x) => x.actualCents !== x.expectedCents),
    };
  } catch (err) {
    return { status: "unchecked", reason: errText(err) };
  }
}

/**
 * One card per subscription per cycle, deduped on `metadata->>dedupe_key` (the convention the
 * duplicate-renewal detector uses). Never throws: a failed alert must not fail a renewal.
 */
export async function surfaceRenewalPriceMismatch(
  admin: SupabaseClient,
  input: { workspaceId: string; subscriptionId: string; customerId: string | null; contractId: string; cycleKey: string; verdict: Extract<RenewalPriceVerdict, { lines: RenewalPriceLine[] }> },
): Promise<{ inserted: boolean }> {
  try {
    const dedupe_key = `shopcx-renewal-price:${input.subscriptionId}:${input.cycleKey}`;
    const { data: existing } = await admin
      .from("dashboard_notifications").select("id")
      .eq("workspace_id", input.workspaceId)
      .contains("metadata", { dedupe_key })
      .limit(1).maybeSingle();
    if (existing) return { inserted: false };

    const v = input.verdict;
    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
    const lineList = v.lines.map((x) => `${x.title} ×${x.quantity}: charging ${usd(x.actualCents)}, rules say ${usd(x.expectedCents)}`).join("; ");
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: "billing_alert",
      title: `ShopCX renewal ${v.status} — subscription ${input.subscriptionId.slice(0, 8)} ${usd(v.actualCents)} vs ${usd(v.expectedCents)}`,
      body:
        `The renewal for contract ${input.contractId} was charged as the contract says (this check never blocks). ` +
        `Products before coupons: ${usd(v.actualCents)}; the pricing rules say ${usd(v.expectedCents)}. ${lineList}. ` +
        `Fix the contract if it is wrong, so the next renewal is right.`,
      metadata: {
        kind: "shopcx_renewal_price_mismatch",
        dedupe_key,
        status: v.status,
        subscription_id: input.subscriptionId,
        customer_id: input.customerId,
        contract_id: input.contractId,
        expected_cents: v.expectedCents,
        actual_cents: v.actualCents,
        lines: v.lines,
      },
    });
    if (error) {
      console.error(`[shopcx-renewal-price] alert insert failed for ${input.subscriptionId}: ${error.message}`);
      return { inserted: false };
    }
    return { inserted: true };
  } catch (err) {
    console.error(`[shopcx-renewal-price] alert failed for ${input.subscriptionId}: ${errText(err)}`);
    return { inserted: false };
  }
}
