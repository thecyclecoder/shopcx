// Unified subscription line item mutations via Appstle replaceVariants-v3
// All subscription item changes (add, remove, swap, quantity) go through this single module.

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

/** Look up product title + variant title from our catalog by variant ID */
export async function resolveVariantTitles(
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, { title: string; variant_title: string; product_id: string }>> {
  const admin = createAdminClient();
  const { data: products } = await admin.from("products").select("id, shopify_product_id, title, variants").eq("workspace_id", workspaceId);
  const map = new Map<string, { title: string; variant_title: string; product_id: string }>();
  for (const p of products || []) {
    for (const v of (p.variants as { id?: string | number; title?: string }[]) || []) {
      const vid = String(v.id || "");
      if (variantIds.includes(vid)) {
        map.set(vid, {
          title: p.title || "",
          variant_title: v.title === "Default Title" ? "" : (v.title || ""),
          product_id: String(p.id || ""),
        });
      }
    }
  }
  return map;
}

/** Enrich subscription items array with titles from our product catalog */
export async function enrichItemTitles(
  workspaceId: string,
  items: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const variantIds = items.map(i => String(i.variant_id || "")).filter(Boolean);
  if (!variantIds.length) return items;
  const titleMap = await resolveVariantTitles(workspaceId, variantIds);
  return items.map(i => {
    const vid = String(i.variant_id || "");
    const resolved = titleMap.get(vid);
    if (resolved) {
      return { ...i, title: resolved.title, variant_title: resolved.variant_title, product_id: resolved.product_id };
    }
    return i;
  });
}

export async function getAppstleConfig(workspaceId: string): Promise<{ apiKey: string; shop: string } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();
  if (!ws?.appstle_api_key_encrypted) return null;
  return { apiKey: decrypt(ws.appstle_api_key_encrypted), shop: ws.shopify_myshopify_domain || "" };
}

/**
 * Remove a single line item from a subscription via Appstle's dedicated endpoint.
 *
 *   PUT /api/external/v2/subscription-contracts-remove-line-item
 *   body: { contractId: "123", lineId: "gid://shopify/SubscriptionLine/...", removeDiscount: true }
 *
 * Requirements (per Appstle docs):
 *   - contractId: numeric ID, no "gid://" prefix
 *   - lineId: full Shopify GID (gid://shopify/SubscriptionLine/...)
 *   - At least one recurring product must remain after removal
 *   - Products with unfulfilled minimum cycle commitments cannot be removed
 *   - removeDiscount: true (default) deletes line-only discounts; shared discounts kept
 *
 * NOTE: this is a separate operation from replaceVariants — they hit different endpoints.
 * Pass either lineGid (preferred — saves a contract fetch) or variantId (we'll resolve).
 */
export async function appstleRemoveLineItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: { variantId?: string; lineGid?: string },
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  try {
    let lineGid = variantOrLine.lineGid || null;

    // Resolve lineGid from variantId if needed by fetching the contract
    if (!lineGid && variantOrLine.variantId) {
      const contractRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
        { cache: "no-store" },
      );
      if (!contractRes.ok) return { success: false, error: `Contract fetch failed: ${contractRes.status}` };
      const contractData = await contractRes.json();
      const lines = contractData.lines?.nodes || [];
      const line = lines.find((l: Record<string, unknown>) => {
        const vid = String(l.variantId || "").split("/").pop();
        return vid === String(variantOrLine.variantId);
      });
      if (!line?.id) return { success: false, error: `Variant ${variantOrLine.variantId} not found on contract` };
      lineGid = String(line.id);
    }

    if (!lineGid) return { success: false, error: "Missing lineGid or variantId" };
    // Ensure lineGid has the full GID prefix (Appstle requires it)
    if (!lineGid.startsWith("gid://")) lineGid = `gid://shopify/SubscriptionLine/${lineGid}`;

    // Despite Appstle's docs example showing JSON body, the endpoint expects
    // contractId + lineId as query parameters (Spring @RequestParam). Confirmed
    // by trial: body-based requests return "Required request parameter X not present".
    // We omit removeDiscount (it's optional, not desired here).
    const numericContractId = String(contractId).replace(/^gid:\/\/.*\//, "");
    const qs = new URLSearchParams({
      contractId: numericContractId,
      lineId: lineGid,
    });
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-line-item?${qs.toString()}`,
      {
        method: "PUT",
        headers: { "X-API-Key": config.apiKey },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("[appstleRemoveLineItem] error:", res.status, text);
      return { success: false, error: `Appstle API error: ${res.status} — ${text.slice(0, 200)}` };
    }

    // Update local DB
    await syncContractItems(workspaceId, contractId, config.apiKey);

    return { success: true };
  } catch (err) {
    console.error("[appstleRemoveLineItem] failed:", err);
    return { success: false, error: String(err) };
  }
}

/** Refresh local DB items from Appstle contract state */
async function syncContractItems(workspaceId: string, contractId: string, apiKey: string) {
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
    );
    if (!res.ok) return;
    const contract = await res.json();
    const lines = contract.lines?.nodes || [];
    const rawItems = lines.map((node: Record<string, unknown>) => ({
      variant_id: String(node.variantId || "").split("/").pop() || "",
      title: node.title || "",
      quantity: node.quantity || 1,
      price_cents: Math.round(parseFloat(String((node.currentPrice as Record<string, unknown>)?.amount || "0")) * 100),
      variant_title: node.variantTitle || "",
      product_id: String(node.productId || "").split("/").pop() || "",
      line_id: String(node.id || "").split("/").pop() || "",
    }));
    const items = await enrichItemTitles(workspaceId, rawItems);
    const admin = createAdminClient();
    await admin.from("subscriptions")
      .update({ items, updated_at: new Date().toISOString() })
      .eq("shopify_contract_id", contractId);
  } catch { /* non-fatal */ }
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
    const mutatedItems = mutate(currentItems);
    // Enrich with titles from our product catalog
    const updatedItems = await enrichItemTitles(workspaceId, mutatedItems);
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
      { variant_id: variantId, quantity, title: "", variant_title: "", price_cents: 0, product_id: "" },
    ]);
  }

  return result;
}

/** Remove a product variant from a subscription */
export async function subRemoveItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: string | { variantId?: string; lineGid?: string },
): Promise<{ success: boolean; error?: string }> {
  // Use dedicated remove-line-item endpoint (not replaceVariants)
  const arg = typeof variantOrLine === "string" ? { variantId: variantOrLine } : variantOrLine;
  return appstleRemoveLineItem(workspaceId, contractId, arg);
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
        String(item.variant_id) === variantId ? { ...item, quantity } : item,
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
  lineGid?: string,
): Promise<{ success: boolean; error?: string }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  const priceDecimal = (basePriceCents / 100).toFixed(2);
  try {
    // Resolve lineId — always query Appstle for the authoritative GID.
    // DB line_ids go stale after swaps (swap creates a new line, old GID is dead).
    let lineId: string | null = lineGid || null;

    const admin = createAdminClient();
    const { data: sub } = await admin.from("subscriptions")
      .select("items")
      .eq("shopify_contract_id", contractId)
      .single();
    const items = (sub?.items as { variant_id?: string; line_id?: string }[]) || [];

    if (!lineId) {
      const detailRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
        { headers: { "X-API-Key": config.apiKey }, cache: "no-store" },
      );
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const lines = (detail?.lines?.nodes || []) as { id?: string; variantId?: string }[];
        const lineMatch = lines.find(l => {
          const vid = l.variantId?.split("/").pop() || l.variantId;
          return String(vid) === String(variantId);
        });
        if (lineMatch?.id) lineId = lineMatch.id;
      }
    }

    if (!lineId) {
      return { success: false, error: "Could not resolve lineId for variant " + variantId };
    }

    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-line-item-price?contractId=${contractId}&lineId=${encodeURIComponent(lineId)}&basePrice=${priceDecimal}`,
      {
        method: "PUT",
        headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("Appstle updateLineItemPrice error:", text);
      return { success: false, error: `Appstle API error: ${res.status} — ${text.slice(0, 200)}` };
    }

    // Update our DB with the new price
    const discountedCents = Math.round(basePriceCents * 0.75);
    await admin.from("subscriptions").update({
      items: items.map(i =>
        String(i.variant_id) === String(variantId)
          ? { ...i, price_cents: discountedCents }
          : i
      ),
      updated_at: new Date().toISOString(),
    }).eq("shopify_contract_id", contractId);

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
): Promise<{ success: boolean; error?: string; newLineGid?: string }> {
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

  let newLineGid: string | undefined;

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.map((item) =>
        String(item.variant_id) === oldVariantId
          ? { ...item, variant_id: newVariantId, quantity }
          : item,
      ),
    );

    // Query Appstle for the new line's GID (swap creates a new line, old GID is dead)
    try {
      const detailRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
        { headers: { "X-API-Key": config.apiKey }, cache: "no-store" },
      );
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const lines = (detail?.lines?.nodes || []) as { id?: string; variantId?: string }[];
        const lineMatch = lines.find(l => {
          const vid = l.variantId?.split("/").pop() || l.variantId;
          return String(vid) === String(newVariantId);
        });
        if (lineMatch?.id) newLineGid = lineMatch.id;
      }
    } catch { /* non-fatal — callers can still use subUpdateLineItemPrice without GID */ }
  }

  return { ...result, newLineGid };
}
