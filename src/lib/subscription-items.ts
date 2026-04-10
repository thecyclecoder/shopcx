// Unified subscription line item mutations via Appstle replaceVariants-v3
// All subscription item changes (add, remove, swap, quantity) go through this single module.

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export async function getAppstleConfig(workspaceId: string): Promise<{ apiKey: string; shop: string } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();
  if (!ws?.appstle_api_key_encrypted) return null;
  return { apiKey: decrypt(ws.appstle_api_key_encrypted), shop: ws.shopify_myshopify_domain || "" };
}

async function callReplaceVariants(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(
      "https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details/replace-variants-v3",
      { method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("Appstle replaceVariants error:", text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    console.error("Appstle replaceVariants failed:", err);
    return { success: false, error: String(err) };
  }
}

/**
 * After a successful replaceVariants call, update the local items array in the DB.
 * Uses a simple read-modify approach since the Appstle replaceVariants-v3 call
 * doesn't return useful line item data consistently.
 */
async function syncItemsAfterMutation(
  workspaceId: string,
  contractId: string,
  mutate: (items: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: sub } = await admin.from("subscriptions")
      .select("items")
      .eq("shopify_contract_id", contractId)
      .single();
    const currentItems = (sub?.items as Record<string, unknown>[] | null) || [];
    const updatedItems = mutate(currentItems);
    await admin.from("subscriptions")
      .update({ items: updatedItems, updated_at: new Date().toISOString() })
      .eq("shopify_contract_id", contractId);
  } catch (err) {
    console.error("Failed to sync subscription items after mutation:", err);
  }
}

/** Add a product variant to a subscription */
export async function subAddItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    newVariants: { [variantId]: quantity },
    stopSwapEmails: true,
  });

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) => [
      ...items,
      { variantId, quantity, title: "", variantTitle: "", price: "0", productId: "" },
    ]);
  }

  return result;
}

/** Remove a product variant from a subscription */
export async function subRemoveItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    oldVariants: [Number(variantId)],
    allowRemoveWithoutAdd: true,
    stopSwapEmails: true,
  });

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.filter((item) => String(item.variantId) !== variantId),
    );
  }

  return result;
}

/** Change quantity of a variant on a subscription (remove + re-add with new qty) */
export async function subChangeQuantity(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    oldVariants: [Number(variantId)],
    newVariants: { [variantId]: quantity },
    carryForwardDiscount: "EXISTING_PLAN",
    stopSwapEmails: true,
  });

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.map((item) =>
        String(item.variantId) === variantId ? { ...item, quantity } : item,
      ),
    );
  }

  return result;
}

/**
 * Update the base price of a line item on a subscription via Appstle.
 * Used after crisis swaps to preserve the customer's original pricing.
 */
export async function subUpdateLineItemPrice(
  workspaceId: string,
  contractId: string,
  variantId: string,
  basePriceCents: number,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  // Use the update-line-item endpoint to set variantId + price in one call
  const priceDecimal = (basePriceCents / 100).toFixed(2);
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-line-item?contractId=${contractId}&variantId=${variantId}&price=${priceDecimal}&isPricePerUnit=true`,
      {
        method: "PUT",
        headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("Appstle updateLineItemPrice error:", text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    console.error("Appstle updateLineItemPrice failed:", err);
    return { success: false, error: String(err) };
  }
}

/**
 * Get the price the customer was paying for an item from their most recent order.
 * Returns price_cents from the matching line item.
 */
export async function getLastOrderPrice(
  workspaceId: string,
  customerId: string,
  sku: string | null,
  variantId: string | null,
): Promise<number | null> {
  const admin = createAdminClient();
  const { data: orders } = await admin.from("orders")
    .select("line_items")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(3);

  for (const order of orders || []) {
    const items = (order.line_items as { sku?: string; variant_id?: string; price_cents?: number }[]) || [];
    const match = items.find(i =>
      (sku && i.sku && i.sku.toUpperCase() === sku.toUpperCase()) ||
      (variantId && i.variant_id && String(i.variant_id) === String(variantId)),
    );
    if (match?.price_cents) return match.price_cents;
  }
  return null;
}

/**
 * Calculate the base price to set so that after a percentage discount,
 * the customer pays the target price.
 * E.g., targetPriceCents=2996, discountPercent=25 → basePriceCents=3995
 */
export function calcBasePrice(targetPriceCents: number, discountPercent: number): number {
  if (discountPercent <= 0 || discountPercent >= 100) return targetPriceCents;
  return Math.round(targetPriceCents / (1 - discountPercent / 100));
}

/** Swap one variant for another (e.g., change flavor or swap product) */
export async function subSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    oldVariants: [Number(oldVariantId)],
    newVariants: { [newVariantId]: quantity },
    carryForwardDiscount: "EXISTING_PLAN",
    stopSwapEmails: true,
  });

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.map((item) =>
        String(item.variantId) === oldVariantId
          ? { ...item, variantId: newVariantId, quantity }
          : item,
      ),
    );
  }

  return result;
}
