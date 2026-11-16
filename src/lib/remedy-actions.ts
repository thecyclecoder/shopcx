/**
 * Save-offer (remedy) execution — the ONE place a cancel-flow save is applied.
 *
 * ⭐ Why this file exists (2026-11-16). The portal cancel flow
 * (src/lib/portal/handlers/cancel-journey.ts) and the journey / mini-site cancel flow
 * (src/app/api/journey/[token]/complete/route.ts) each applied accepted save offers with their
 * own code, and they drifted. The journey copy handled only pause / skip / coupon and a
 * frequency change HARDCODED to every 2 months; `free_product` and `line_item_modifier` fell
 * through and did nothing, while the customer was told "We've updated your subscription". A
 * "Monthly Frequency" offer set them to every 2 months. Both surfaces now call these functions,
 * so a save behaves identically wherever the customer accepts it.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type RemedyConfig = Record<string, unknown>;

/**
 * Apply ONE accepted save offer (a `remedies` row's type + config) to a subscription.
 * The single implementation for every surface that offers save offers.
 */
export async function executeRemedyAction(
  workspaceId: string,
  contractId: string,
  remedyType: string,
  config: RemedyConfig,
): Promise<{ success: boolean; error?: string; patch?: Record<string, unknown>; savedAction?: string }> {
  const { subscriptionAction, subscriptionSkipNextOrder, subscriptionUpdateBillingInterval, subscriptionAddFreeProduct, applyCoupon } = await import("@/lib/commerce/subscription");
  const admin = createAdminClient();

  switch (remedyType) {
    case "coupon": {
      const couponMappingId = config.coupon_mapping_id as string | undefined;
      if (!couponMappingId) return { success: false, error: "No coupon configured for this remedy" };

      const { data: mapping } = await admin.from("coupon_mappings")
        .select("code").eq("id", couponMappingId).single();
      if (!mapping?.code) return { success: false, error: "Coupon not found" };

      // Through the SDK: the save offer has to land whichever engine bills this sub. The old
      // path refused with "Appstle not configured" for anything else, which on a migrated
      // contract turns an accepted save offer into a cancellation.
      const result = await applyCoupon(workspaceId, contractId, mapping.code);
      if (!result.success) return { success: false, error: result.error };

      return { success: true, savedAction: `saved with coupon ${mapping.code}`, patch: {} };
    }

    case "pause": {
      const pauseDays = Number(config.pause_days) || 30;
      const result = await subscriptionAction(workspaceId, contractId, "pause");
      if (!result.success) return { success: false, error: result.error };

      const resumeAt = new Date(Date.now() + pauseDays * 86400000).toISOString();

      // Update DB with resume date
      await admin.from("subscriptions")
        .update({ pause_resume_at: resumeAt, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);

      // Auto-resume handled by hourly cron (portal-auto-resume-cron)

      return {
        success: true,
        savedAction: `paused your subscription for ${pauseDays} days`,
        patch: { status: "PAUSED", pauseResumeAt: resumeAt },
      };
    }

    case "skip": {
      const result = await subscriptionSkipNextOrder(workspaceId, contractId);
      if (!result.success) return { success: false, error: result.error };
      return { success: true, savedAction: "skipped your next order", patch: {} };
    }

    case "frequency_change": {
      const freqMap: Record<string, { interval: "MONTH"; count: number }> = {
        monthly: { interval: "MONTH", count: 1 },
        bimonthly: { interval: "MONTH", count: 2 },
        quarterly: { interval: "MONTH", count: 3 },
      };
      const freq = freqMap[config.frequency_interval as string] || { interval: "MONTH" as const, count: 2 };
      const result = await subscriptionUpdateBillingInterval(workspaceId, contractId, freq.interval, freq.count);
      if (!result.success) return { success: false, error: result.error };
      const label = config.frequency_interval === "monthly" ? "monthly" : config.frequency_interval === "bimonthly" ? "every 2 months" : "every 3 months";
      return { success: true, savedAction: `changed your delivery to ${label}`, patch: {} };
    }

    case "free_product": {
      const variantId = config.product_variant_id as string;
      if (!variantId) return { success: false, error: "No product configured for this remedy" };
      const result = await subscriptionAddFreeProduct(workspaceId, contractId, variantId, 1);
      if (!result.success) return { success: false, error: result.error };
      const title = (config.product_title as string) || "a free product";
      return { success: true, savedAction: `added ${title} free to your next order`, patch: {} };
    }

    case "line_item_modifier": {
      // Line item modifier is handled by the multi-step frontend flow
      // This just signals the frontend to open the inline flow
      return { success: true, savedAction: "", patch: {} };
    }

    default:
      return { success: false, error: `Unknown remedy type: ${remedyType}` };
  }
}


export type LineItemActionInput = {
  action: string;
  variantId?: string;
  oldVariantId?: string;
  newVariantId?: string;
  quantity?: number;
};

/**
 * Apply one item edit from the "change items" save offer: swap_variant | change_quantity |
 * remove | swap_product. `validationError` is set (and nothing is written) on a bad input.
 */
export async function executeLineItemAction(
  workspaceId: string,
  contractId: string,
  input: LineItemActionInput,
): Promise<{ success: boolean; error?: string; validationError?: string; savedAction: string }> {
  const { subRemoveItem, subChangeQuantity, subSwapVariant } = await import("@/lib/subscription-items");
  const { action } = input;
  const variantId = input.variantId || "";

  if (!action) return { success: false, validationError: "missing_action", savedAction: "" };

  if (action === "swap_variant") {
    const oldVariantId = input.oldVariantId || "";
    const newVariantId = input.newVariantId || "";
    if (!oldVariantId || !newVariantId) return { success: false, validationError: "missing_variant_ids", savedAction: "" };
    const r = await subSwapVariant(workspaceId, contractId, oldVariantId, newVariantId);
    return { ...r, savedAction: "changed your product variant" };
  }
  if (action === "change_quantity") {
    const quantity = Number(input.quantity);
    if (!variantId || !quantity || quantity < 1) return { success: false, validationError: "invalid_quantity", savedAction: "" };
    const r = await subChangeQuantity(workspaceId, contractId, variantId, quantity);
    return { ...r, savedAction: `updated your quantity to ${quantity}` };
  }
  if (action === "remove") {
    if (!variantId) return { success: false, validationError: "missing_variantId", savedAction: "" };
    const r = await subRemoveItem(workspaceId, contractId, variantId);
    return { ...r, savedAction: "removed an item from your subscription" };
  }
  if (action === "swap_product") {
    const newVariantId = input.newVariantId || "";
    const quantity = Number(input.quantity) || 1;
    if (!variantId || !newVariantId) return { success: false, validationError: "missing_params", savedAction: "" };
    const r = await subSwapVariant(workspaceId, contractId, variantId, newVariantId, quantity);
    return { ...r, savedAction: "swapped a product in your subscription" };
  }
  return { success: false, validationError: "invalid_action", savedAction: "" };
}
