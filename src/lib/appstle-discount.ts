/**
 * Shared Appstle discount helpers — single source of truth for coupon apply/remove.
 * RULE: Only ONE CODE discount per subscription. AUTOMATIC_DISCOUNT and MANUAL
 * discounts stack on top of a code discount and are never touched. Two CODE
 * discounts (two loyalty, two promo, or one of each) is the only illegal
 * combination — replace-on-apply only clears the code half.
 *
 * Reads discount IDs from local DB (synced via webhook), not from Appstle API.
 * Writes to both Appstle (mutation) and local DB (immediate update, don't wait for webhook).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

const APPSTLE_BASE = "https://subscription-admin.appstle.com";

interface StoredDiscount {
  id: string;
  title: string;
  type: string;
  value: number;
  valueType: string;
}

/**
 * Remove the CODE_DISCOUNT rows from a subscription contract's applied_discounts.
 *
 * AUTOMATIC_DISCOUNT ('Free Shipping on Subscriptions', 'Buy 2 Discount', …),
 * MANUAL (cancel-flow retention), and any unknown/missing type are PRESERVED
 * — never issued to `subscription-contracts-remove-discount` and never dropped
 * from the local `applied_discounts` write-back. Only two CODE discounts are
 * mutually exclusive; automatics + manuals stack on top of a code and must
 * survive an apply-with-replace.
 *
 * Reads discount IDs from local DB (not Appstle API).
 */
export async function removeExistingDiscounts(
  apiKey: string,
  contractId: string,
): Promise<{ removed: string[]; preserved: StoredDiscount[]; error?: string }> {
  const removed: string[] = [];
  const admin = createAdminClient();

  const { data: sub } = await admin.from("subscriptions")
    .select("applied_discounts")
    .eq("shopify_contract_id", contractId)
    .single();

  const discounts = (sub?.applied_discounts as StoredDiscount[]) || [];
  const codeDiscounts = discounts.filter(d => d.type === "CODE_DISCOUNT");
  const preserved = discounts.filter(d => d.type !== "CODE_DISCOUNT");

  const { logAppstleCall } = await import("@/lib/appstle-call-log");
  for (const disc of codeDiscounts) {
    if (disc.id) {
      const url = `${APPSTLE_BASE}/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(disc.id)}&api_key=${apiKey}`;
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: "PUT", headers: { "X-API-Key": apiKey } });
        const text = await res.text().catch(() => "");
        await logAppstleCall({
          url, method: "PUT", body: { contractId, discountId: disc.id }, endpoint: "remove-discount",
          status: res.status, responseBody: text, success: res.ok, durationMs: Date.now() - t0,
        });
        removed.push(disc.id);
      } catch (err) {
        await logAppstleCall({
          url, method: "PUT", body: { contractId, discountId: disc.id }, endpoint: "remove-discount",
          status: 0, responseBody: errText(err), success: false, durationMs: Date.now() - t0,
        });
      }
    }
  }

  if (removed.length > 0) {
    await admin.from("subscriptions")
      .update({ applied_discounts: preserved, updated_at: new Date().toISOString() })
      .eq("shopify_contract_id", contractId);
  }

  return { removed, preserved };
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
  const { logAppstleCall } = await import("@/lib/appstle-call-log");
  // Internal sub fast path — skip Appstle entirely. We look up the
  // workspace from the contract since this helper takes apiKey, not
  // workspaceId. Mirrors the "remove existing then apply new" semantics
  // via applied_discounts JSONB mutations.
  {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("workspace_id, is_internal")
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (sub?.is_internal && sub.workspace_id) {
      const { internalSubApplyDiscount } = await import("@/lib/internal-subscription");
      // Clear only the CODE_DISCOUNT rows before adding — AUTOMATIC_DISCOUNT
      // and MANUAL rows stack on top of a code and must survive the replace.
      const { data: existingSub } = await admin
        .from("subscriptions")
        .select("applied_discounts")
        .eq("shopify_contract_id", contractId)
        .single();
      const existing = (existingSub?.applied_discounts as StoredDiscount[]) || [];
      const preserved = existing.filter(d => d.type !== "CODE_DISCOUNT");
      if (existing.length !== preserved.length) {
        await admin
          .from("subscriptions")
          .update({ applied_discounts: preserved, updated_at: new Date().toISOString() })
          .eq("shopify_contract_id", contractId);
      }
      const r = await internalSubApplyDiscount(sub.workspace_id, contractId, discountCode);
      return { success: r.success, removed: [], error: r.error };
    }
  }

  // Step 1: Remove existing discounts
  const { removed } = await removeExistingDiscounts(apiKey, contractId);

  // Step 2: Apply new discount
  const applyUrl = `${APPSTLE_BASE}/api/external/v2/subscription-contracts-apply-discount?contractId=${contractId}&discountCode=${encodeURIComponent(discountCode)}&api_key=${apiKey}`;
  const t0 = Date.now();
  const res = await fetch(applyUrl, { method: "PUT", headers: { "X-API-Key": apiKey } });
  const text = await res.clone().text().catch(() => "");
  await logAppstleCall({
    url: applyUrl, method: "PUT", body: { contractId, discountCode },
    endpoint: "apply-discount", status: res.status, responseBody: text,
    success: res.ok || res.status === 204, durationMs: Date.now() - t0,
  });

  if (!res.ok && res.status !== 204) {
    return { success: false, removed, error: `Appstle API error: ${res.status}`, status: res.status };
  }

  // Step 3: Parse the response to get the real discount ID and details
  const admin = createAdminClient();
  let appliedDiscounts: StoredDiscount[] = [];

  try {
    const data = await res.json();
    const discountEdges = (data?.discounts?.edges || data?.discounts?.nodes || []) as { node?: Record<string, unknown> }[];
    const nodes = discountEdges.map(e => e.node || e).filter(Boolean);

    appliedDiscounts = (nodes as Record<string, unknown>[]).map(node => {
      const val = node.value as Record<string, unknown> | undefined;
      return {
        id: (node.id as string) || "",
        title: (node.title as string) || discountCode,
        type: (node.type as string) || "CODE_DISCOUNT",
        value: val?.percentage ? Number(val.percentage) : val?.amount ? Number(val.amount) : 0,
        valueType: val?.percentage ? "PERCENTAGE" : "FIXED_AMOUNT",
      };
    });
  } catch {
    // Fallback if response isn't JSON (204 no content)
    appliedDiscounts = [{ id: "", title: discountCode, type: "CODE_DISCOUNT", value: 0, valueType: "UNKNOWN" }];
  }

  await admin.from("subscriptions")
    .update({ applied_discounts: appliedDiscounts, updated_at: new Date().toISOString() })
    .eq("shopify_contract_id", contractId);

  return { success: true, removed };
}
