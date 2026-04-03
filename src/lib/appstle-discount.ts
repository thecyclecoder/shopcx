/**
 * Shared Appstle discount helpers — single source of truth for coupon apply/remove.
 * RULE: Only 1 coupon per subscription. Always remove existing before applying new.
 *
 * Reads discount IDs from local DB (synced via webhook), not from Appstle API.
 * Writes to both Appstle (mutation) and local DB (immediate update, don't wait for webhook).
 */

import { createAdminClient } from "@/lib/supabase/admin";

const APPSTLE_BASE = "https://subscription-admin.appstle.com";

interface StoredDiscount {
  id: string;
  title: string;
  type: string;
  value: number;
  valueType: string;
}

/**
 * Remove all existing discounts from a subscription contract.
 * Reads discount IDs from local DB (not Appstle API).
 */
export async function removeExistingDiscounts(
  apiKey: string,
  contractId: string,
): Promise<{ removed: string[]; error?: string }> {
  const removed: string[] = [];
  const admin = createAdminClient();

  // Read from local DB
  const { data: sub } = await admin.from("subscriptions")
    .select("applied_discounts")
    .eq("shopify_contract_id", contractId)
    .single();

  const discounts = (sub?.applied_discounts as StoredDiscount[]) || [];

  for (const disc of discounts) {
    if (disc.id) {
      try {
        await fetch(
          `${APPSTLE_BASE}/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(disc.id)}&api_key=${apiKey}`,
          { method: "PUT", headers: { "X-API-Key": apiKey } },
        );
        removed.push(disc.id);
      } catch {}
    }
  }

  // Update local DB immediately (don't wait for webhook)
  if (removed.length > 0) {
    await admin.from("subscriptions")
      .update({ applied_discounts: [], updated_at: new Date().toISOString() })
      .eq("shopify_contract_id", contractId);
  }

  return { removed };
}

/**
 * Apply a discount code to a subscription, removing any existing discounts first.
 * This is the ONLY function that should be used to apply coupons.
 * Updates local DB immediately after successful apply.
 */
export async function applyDiscountWithReplace(
  apiKey: string,
  contractId: string,
  discountCode: string,
): Promise<{ success: boolean; removed: string[]; error?: string; status?: number }> {
  // Step 1: Remove existing discounts
  const { removed } = await removeExistingDiscounts(apiKey, contractId);

  // Step 2: Apply new discount
  const res = await fetch(
    `${APPSTLE_BASE}/api/external/v2/subscription-contracts-apply-discount?contractId=${contractId}&discountCode=${encodeURIComponent(discountCode)}&api_key=${apiKey}`,
    { method: "PUT", headers: { "X-API-Key": apiKey } },
  );

  if (!res.ok && res.status !== 204) {
    return { success: false, removed, error: `Appstle API error: ${res.status}`, status: res.status };
  }

  // Step 3: Update local DB immediately with the new discount
  // We store what we know — the webhook will reconcile with full details later
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({
      applied_discounts: [{ id: "", title: discountCode, type: "CODE_DISCOUNT", value: 0, valueType: "UNKNOWN" }],
      updated_at: new Date().toISOString(),
    })
    .eq("shopify_contract_id", contractId);

  return { success: true, removed };
}
