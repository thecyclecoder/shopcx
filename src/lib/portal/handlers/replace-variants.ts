import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

function asIntArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    // Support both number format [123] and object format [{ variantId: "123" }]
    if (typeof item === "object" && item !== null) {
      const id = (item as Record<string, unknown>).variantId ?? (item as Record<string, unknown>).id;
      return Number(id);
    }
    return Number(item);
  }).filter(n => Number.isFinite(n) && n > 0).map(Math.trunc);
}

function asQtyMap(v: unknown): Record<string, number> | null {
  // Support both object format { "123": 2 } and array format [{ variantId: "123", quantity: 2 }]
  if (!v) return null;

  const out: Record<string, number> = {};

  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const id = clampInt(obj.variantId ?? obj.id, 0);
        const qty = clampInt(obj.quantity ?? 1, 0);
        if (id > 0 && qty > 0) out[String(id)] = qty;
      }
    }
  } else if (typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const id = clampInt(k, 0);
      const qty = clampInt((v as Record<string, unknown>)[k], 0);
      if (id > 0 && qty > 0) out[String(id)] = qty;
    }
  }

  return Object.keys(out).length ? out : null;
}

export const replaceVariants: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const shop = s(payload?.shop) || auth.shop;
  if (!shop) return jsonErr({ error: "missing_shop" }, 400);

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const oldVariants = asIntArray(payload?.oldVariants);
  const oldOneTimeVariants = asIntArray(payload?.oldOneTimeVariants);
  const newVariants = asQtyMap(payload?.newVariants);
  const newOneTimeVariants = asQtyMap(payload?.newOneTimeVariants);
  const oldLineId = s(payload?.oldLineId);
  const stopSwapEmails = !!payload?.stopSwapEmails;
  const carryForwardDiscount = s(payload?.carryForwardDiscount);
  const allowRemoveWithoutAdd = !!payload?.allowRemoveWithoutAdd;

  if (oldLineId && oldVariants.length) return jsonErr({ error: "invalid_oldLineId_and_oldVariants" }, 400);

  const hasAnyChange = !!oldLineId || oldVariants.length > 0 || oldOneTimeVariants.length > 0 || !!newVariants || !!newOneTimeVariants;
  if (!hasAnyChange) return jsonErr({ error: "no_changes" }, 400);

  // Guardrail: prevent removing all regular products
  const looksLikeRegularRemoval = !!oldLineId || oldVariants.length > 0;
  if (looksLikeRegularRemoval && !newVariants && !allowRemoveWithoutAdd) {
    return jsonErr({ error: "would_remove_all_regular_products" }, 400);
  }

  const body: Record<string, unknown> = { shop, contractId, eventSource: "CUSTOMER_PORTAL", stopSwapEmails };
  if (carryForwardDiscount) body.carryForwardDiscount = carryForwardDiscount;
  if (oldLineId) body.oldLineId = oldLineId;
  if (oldVariants.length) body.oldVariants = oldVariants;
  if (oldOneTimeVariants.length) body.oldOneTimeVariants = oldOneTimeVariants;
  if (newVariants) body.newVariants = newVariants;
  if (newOneTimeVariants) body.newOneTimeVariants = newOneTimeVariants;

  let updated: Record<string, unknown> | null = null;
  try {
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    const res = await fetch(`https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details/replace-variants-v3`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Appstle API error: ${res.status}`);
    updated = await res.json().catch(() => null);
  } catch (e) {
    return handleAppstleError(e);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.items.swapped",
      summary: "Customer swapped subscription items via portal",
      properties: { shopify_contract_id: String(contractId), oldVariants, newVariants },
      createNote: true,
    });
  }

  const patch: Record<string, unknown> = {};
  if (updated) {
    const lines = (updated as Record<string, unknown>).lines;
    if (lines && typeof lines === "object") {
      const nodes = (lines as Record<string, unknown>).nodes;
      patch.lines = Array.isArray(nodes) ? nodes : lines;
    }
    if ((updated as Record<string, unknown>).deliveryPrice) patch.deliveryPrice = (updated as Record<string, unknown>).deliveryPrice;
  }

  return jsonOk({ ok: true, route, contractId, patch });
};
