import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { enrichItemTitles } from "@/lib/subscription-items";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

function extractNumericId(val: unknown): number {
  const s = String(val || "");
  // Strip GID prefix: "gid://shopify/ProductVariant/123" → "123"
  const numeric = s.includes("/") ? s.split("/").pop() || s : s;
  return Number(numeric);
}

function asIntArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    // Support both number format [123] and object format [{ variantId: "123" }]
    if (typeof item === "object" && item !== null) {
      const id = (item as Record<string, unknown>).variantId ?? (item as Record<string, unknown>).id;
      return extractNumericId(id);
    }
    return extractNumericId(item);
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
        const id = extractNumericId(obj.variantId ?? obj.id);
        const qty = clampInt(obj.quantity ?? 1, 0);
        if (id > 0 && qty > 0) out[String(Math.trunc(id))] = qty;
      }
    }
  } else if (typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const id = extractNumericId(k);
      const qty = clampInt((v as Record<string, unknown>)[k], 0);
      if (id > 0 && qty > 0) out[String(Math.trunc(id))] = qty;
    }
  }

  return Object.keys(out).length ? out : null;
}

/** Parse Appstle contract response into our DB items format */
function parseAppstleLineItems(contract: Record<string, unknown>): Record<string, unknown>[] {
  const lines = contract.lines as Record<string, unknown> | undefined;
  if (!lines) return [];
  const rawNodes = (lines.nodes ?? lines.edges ?? lines) as unknown;
  if (!Array.isArray(rawNodes)) return [];
  return rawNodes.map((n: unknown) => {
    const node = ((n as Record<string, unknown>).node ?? n) as Record<string, unknown>;
    const extractId = (gid: unknown) => typeof gid === "string" && gid.includes("/") ? gid.split("/").pop() || String(gid) : String(gid || "");
    return {
      variant_id: extractId(node.variantId ?? node.id),
      title: node.title ?? "",
      quantity: node.quantity ?? 1,
      price_cents: Math.round(parseFloat(String((node.currentPrice as Record<string, unknown> | undefined)?.amount ?? node.price ?? (node.lineDiscountedPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100),
      variant_title: node.variantTitle ?? "",
      product_id: extractId(node.productId ?? ""),
    };
  });
}

export const replaceVariants: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  let shop = s(payload?.shop) || auth.shop;
  if (!shop) {
    // Resolve shop from workspace for cookie/magic-link sessions
    const adminDb = createAdminClient();
    const { data: ws } = await adminDb.from("workspaces").select("shopify_myshopify_domain").eq("id", auth.workspaceId).single();
    shop = ws?.shopify_myshopify_domain || "";
  }
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
  if (oldLineId) body.oldLineId = oldLineId.startsWith("gid://") ? oldLineId : `gid://shopify/SubscriptionLine/${oldLineId}`;
  if (oldVariants.length) body.oldVariants = oldVariants;
  if (oldOneTimeVariants.length) body.oldOneTimeVariants = oldOneTimeVariants;
  if (newVariants) body.newVariants = newVariants;
  if (newOneTimeVariants) body.newOneTimeVariants = newOneTimeVariants;

  // PRE-SWAP: Capture old item pricing for grandfathered price preservation
  // Must read BEFORE the Appstle swap call replaces the old line
  const isSingleSwap = (oldVariants.length === 1 || !!oldLineId) && newVariants && Object.keys(newVariants).length === 1;
  let grandfatheredBase: number | null = null;
  let newVariantIdForPrice: string | null = null;
  if (isSingleSwap) {
    try {
      const adminDb = createAdminClient();
      newVariantIdForPrice = Object.keys(newVariants!)[0];

      // Resolve old variant ID
      let oldVariantId: string | null = oldVariants.length === 1 ? String(oldVariants[0]) : null;
      if (!oldVariantId && oldLineId) {
        const { data: subData } = await adminDb.from("subscriptions")
          .select("items").eq("shopify_contract_id", String(contractId)).single();
        const items = (subData?.items as { variant_id?: string; line_id?: string }[]) || [];
        const rawLineId = oldLineId.startsWith("gid://") ? oldLineId.split("/").pop() : oldLineId;
        const lineItem = items.find(i => i.line_id === rawLineId || i.line_id === oldLineId);
        oldVariantId = lineItem?.variant_id ? String(lineItem.variant_id) : null;
      }

      if (oldVariantId) {
        // Get the sub's current item pricing (BEFORE swap)
        const { data: subData } = await adminDb.from("subscriptions")
          .select("items").eq("shopify_contract_id", String(contractId)).single();
        const items = (subData?.items as { variant_id?: string; price_cents?: number }[]) || [];
        const oldItem = items.find(i => String(i.variant_id) === oldVariantId);

        if (oldItem?.price_cents) {
          const { data: products } = await adminDb.from("products").select("variants").eq("workspace_id", auth.workspaceId);
          const priceMap = new Map<string, number>();
          for (const p of products || []) {
            for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
              if (v.id && v.price_cents) priceMap.set(String(v.id), v.price_cents);
            }
          }
          const standardPrice = priceMap.get(oldVariantId);
          const effectiveBase = Math.round(oldItem.price_cents / 0.75);
          const newStandardPrice = priceMap.get(newVariantIdForPrice);
          if (standardPrice && effectiveBase < standardPrice && newStandardPrice === standardPrice) {
            grandfatheredBase = effectiveBase;
          }
        }
      }
    } catch (e) { console.error("[replaceVariants] grandfathered pricing pre-check error:", e); }
  }
  console.log("[replaceVariants] grandfathered check:", { isSingleSwap, grandfatheredBase, newVariantIdForPrice, oldLineId, oldVariantsLen: oldVariants.length });

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
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw Object.assign(new Error(`Appstle API error: ${res.status}`), { details: errText });
    }
    updated = await res.json().catch(() => null);
  } catch (e) {
    return handleAppstleError(e, { route: "replaceVariants", payload: body });
  }

  // POST-SWAP: Apply grandfathered base price if detected
  if (grandfatheredBase && newVariantIdForPrice) {
    try {
      const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
      await subUpdateLineItemPrice(auth.workspaceId, String(contractId), newVariantIdForPrice, grandfatheredBase);
    } catch { /* non-fatal */ }
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

    // Update local DB items array from the Appstle response, enriched with catalog titles
    const rawDbItems = parseAppstleLineItems(updated);
    if (rawDbItems.length > 0) {
      const adminDb = createAdminClient();
      const dbItems = await enrichItemTitles(auth.workspaceId, rawDbItems);
      await adminDb.from("subscriptions")
        .update({ items: dbItems, updated_at: new Date().toISOString() })
        .eq("shopify_contract_id", String(contractId));
    }
  }

  return jsonOk({ ok: true, route, contractId, patch });
};
