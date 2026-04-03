/**
 * Shared Appstle discount helpers — single source of truth for coupon apply/remove.
 * RULE: Only 1 coupon per subscription. Always remove existing before applying new.
 */

const APPSTLE_BASE = "https://subscription-admin.appstle.com";

/**
 * Remove all existing discounts from a subscription contract.
 * Fetches the raw contract to find discount node IDs, then removes each.
 */
export async function removeExistingDiscounts(
  apiKey: string,
  contractId: string,
): Promise<{ removed: string[]; error?: string }> {
  const removed: string[] = [];

  try {
    const rawRes = await fetch(
      `${APPSTLE_BASE}/api/external/v2/contract-raw-response?contractId=${contractId}&api_key=${apiKey}`,
      { headers: { "X-API-Key": apiKey } },
    );

    if (!rawRes.ok) return { removed };

    const rawText = await rawRes.text();
    const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);

    if (nodesMatch && nodesMatch[1].trim()) {
      try {
        const nodes = JSON.parse(`[${nodesMatch[1]}]`);
        for (const node of nodes) {
          if (node.id) {
            await fetch(
              `${APPSTLE_BASE}/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(node.id)}&api_key=${apiKey}`,
              { method: "PUT", headers: { "X-API-Key": apiKey } },
            );
            removed.push(node.id);
          }
        }
      } catch {}
    }
  } catch {}

  return { removed };
}

/**
 * Apply a discount code to a subscription, removing any existing discounts first.
 * This is the ONLY function that should be used to apply coupons.
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

  return { success: true, removed };
}
