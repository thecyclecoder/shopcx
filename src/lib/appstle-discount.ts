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
  workspaceId: string,
  apiKey: string,
  contractId: string,
): Promise<{
  removed: string[];
  removedRows: StoredDiscount[];
  preserved: StoredDiscount[];
  snapshot: StoredDiscount[];
  error?: string;
}> {
  const removed: string[] = [];
  const removedRows: StoredDiscount[] = [];
  const admin = createAdminClient();

  const { data: sub } = await admin.from("subscriptions")
    .select("applied_discounts")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .single();

  const snapshot = (sub?.applied_discounts as StoredDiscount[]) || [];
  const codeDiscounts = snapshot.filter(d => d.type === "CODE_DISCOUNT");
  const preserved = snapshot.filter(d => d.type !== "CODE_DISCOUNT");

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
        removedRows.push(disc);
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
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);
  }

  return { removed, removedRows, preserved, snapshot };
}

/**
 * Apply a discount code to a subscription, removing any existing discounts first.
 * This is the ONLY function that should be used to apply coupons.
 * Updates local DB immediately after successful apply.
 */
export async function applyDiscountWithReplace(
  workspaceId: string,
  apiKey: string,
  contractId: string,
  discountCode: string,
): Promise<{
  success: boolean;
  removed: string[];
  error?: string;
  status?: number;
  rolledBack?: boolean;
}> {
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
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (sub?.is_internal && sub.workspace_id) {
      const { internalSubApplyDiscount } = await import("@/lib/internal-subscription");
      // Clear only the CODE_DISCOUNT rows before adding — AUTOMATIC_DISCOUNT
      // and MANUAL rows stack on top of a code and must survive the replace.
      const { data: existingSub } = await admin
        .from("subscriptions")
        .select("applied_discounts")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();
      const existing = (existingSub?.applied_discounts as StoredDiscount[]) || [];
      const preserved = existing.filter(d => d.type !== "CODE_DISCOUNT");
      if (existing.length !== preserved.length) {
        await admin
          .from("subscriptions")
          .update({ applied_discounts: preserved, updated_at: new Date().toISOString() })
          .eq("workspace_id", workspaceId)
          .eq("shopify_contract_id", contractId);
      }
      const r = await internalSubApplyDiscount(sub.workspace_id, contractId, discountCode);
      return { success: r.success, removed: [], error: r.error };
    }
  }

  // Step 1: Remove existing CODE_DISCOUNT rows. `snapshot` is the exact
  // pre-call applied_discounts array; `removedRows` are the CODE rows the
  // remove PUT was issued for. Both feed the failure-branch rollback below.
  const { removed, removedRows, snapshot } = await removeExistingDiscounts(workspaceId, apiKey, contractId);

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
    // Rollback: re-apply every removed CODE_DISCOUNT by its code and restore
    // the local applied_discounts snapshot so the contract ends the call in
    // the exact state it started in. On ticket 2b7ea029 the apply 400'd
    // after the remove succeeded; the pre-fix code returned here with the
    // discount stripped and no restoration path. A rollback that itself
    // fails MUST NOT throw over the original error — the caller still gets
    // the apply's status/error but with `rolledBack: false` so the loss is
    // visible and can be alerted on. `rolledBack: true` means the contract
    // is back to its pre-call state; `rolledBack: false` means it is NOT.
    let rolledBack = true;
    if (removedRows.length > 0) {
      for (const disc of removedRows) {
        if (!disc.title) { rolledBack = false; continue; }
        const rollbackUrl = `${APPSTLE_BASE}/api/external/v2/subscription-contracts-apply-discount?contractId=${contractId}&discountCode=${encodeURIComponent(disc.title)}&api_key=${apiKey}`;
        const r0 = Date.now();
        try {
          const rres = await fetch(rollbackUrl, { method: "PUT", headers: { "X-API-Key": apiKey } });
          const rtext = await rres.text().catch(() => "");
          await logAppstleCall({
            url: rollbackUrl, method: "PUT", body: { contractId, discountCode: disc.title, rollback: true },
            endpoint: "apply-discount", status: rres.status, responseBody: rtext,
            success: rres.ok || rres.status === 204, durationMs: Date.now() - r0,
          });
          if (!rres.ok && rres.status !== 204) rolledBack = false;
        } catch (err) {
          await logAppstleCall({
            url: rollbackUrl, method: "PUT", body: { contractId, discountCode: disc.title, rollback: true },
            endpoint: "apply-discount", status: 0, responseBody: errText(err),
            success: false, durationMs: Date.now() - r0,
          });
          rolledBack = false;
        }
      }
      // Restore the local applied_discounts to its pre-call value ONLY when
      // every re-apply succeeded. On partial success we deliberately leave
      // the DB reflecting the truncated Appstle state so the discrepancy
      // surfaces on the next read instead of masking a real loss.
      if (rolledBack) {
        try {
          const admin = createAdminClient();
          await admin.from("subscriptions")
            .update({ applied_discounts: snapshot, updated_at: new Date().toISOString() })
            .eq("workspace_id", workspaceId)
            .eq("shopify_contract_id", contractId);
        } catch {
          rolledBack = false;
        }
      }
    }
    return {
      success: false,
      removed,
      error: `Appstle API error: ${res.status}`,
      status: res.status,
      rolledBack,
    };
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
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId);

  return { success: true, removed };
}
