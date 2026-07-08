import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub, portalFetch, safeStartsWith } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { enrichItemTitles, subSwapVariant, subAddItem, subChangeQuantity, subRemoveItem } from "@/lib/subscription-items";
import { isInternalSubscription } from "@/lib/internal-subscription";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

/**
 * Resolve a variant reference to a STRING id, preserving BOTH shapes:
 *   - Appstle subs use numeric Shopify variant ids ("123", or a
 *     "gid://shopify/ProductVariant/123" we strip to "123").
 *   - Internal subs use catalog UUIDs ("01eab80d-…").
 * The old `extractNumericId` ran everything through Number(), turning a
 * UUID into NaN → the item was silently dropped → every internal-sub
 * modify failed with `no_changes`. We keep the ref as-is.
 */
function extractVariantRef(val: unknown): string {
  const str = String(val ?? "").trim();
  if (!str) return "";
  // Strip a GID prefix: "gid://shopify/ProductVariant/123" → "123".
  return str.includes("/") ? (str.split("/").pop() || str) : str;
}

function asRefArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    // Support both ["123"] and [{ variantId: "123" }] shapes.
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      return extractVariantRef(o.variantId ?? o.id);
    }
    return extractVariantRef(item);
  }).filter(Boolean);
}

function asQtyMap(v: unknown): Record<string, number> | null {
  // Support both { "123": 2 } and [{ variantId: "123", quantity: 2 }] shapes.
  if (!v) return null;

  const out: Record<string, number> = {};

  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const id = extractVariantRef(obj.variantId ?? obj.id);
        const qty = clampInt(obj.quantity ?? 1, 0);
        if (id && qty > 0) out[id] = qty;
      }
    }
  } else if (typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const id = extractVariantRef(k);
      const qty = clampInt((v as Record<string, unknown>)[k], 0);
      if (id && qty > 0) out[id] = qty;
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

  // Resolve by UUID (our canonical key); accept the legacy contract-id shape too.
  // Downstream logic keys on shopify_contract_id (numeric for Appstle, internal-…
  // for migrated subs) — switch to it only here.
  const sub = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  if (!sub?.shopify_contract_id) return jsonErr({ error: "missing_contractId" }, 400);
  const contractId = sub.shopify_contract_id;

  const oldVariants = asRefArray(payload?.oldVariants);
  const oldOneTimeVariants = asRefArray(payload?.oldOneTimeVariants);
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

  const isInternal = await isInternalSubscription(auth.workspaceId, String(contractId));

  const body: Record<string, unknown> = { shop, contractId, eventSource: "CUSTOMER_PORTAL", stopSwapEmails };
  if (carryForwardDiscount) body.carryForwardDiscount = carryForwardDiscount;

  // oldLineId → oldVariants for Appstle subs.
  //
  // The portal sends oldLineId = the line's `id`, which transform-subscription
  // sets to `line_id || variant_id`. Appstle sub lines often carry no real
  // Shopify SubscriptionLine id, so this is actually the variant id (or a
  // catalog UUID). Wrapping it as gid://shopify/SubscriptionLine/<x> and
  // sending it as oldLineId makes Appstle reject the swap with a 400 (the
  // Jessica Ollet ticket). Resolve it to the line's variant_id from
  // subscriptions.items and send the reliable oldVariants path instead — the
  // same approach subSwapVariant already uses successfully. Fall back to the
  // synthesized line GID only when we genuinely can't resolve a variant id.
  if (oldLineId && !isInternal) {
    if (safeStartsWith(oldLineId, "gid://shopify/SubscriptionLine/")) {
      // Already a real Shopify line GID — trust it.
      body.oldLineId = oldLineId;
    } else {
      const adminDb = createAdminClient();
      const { data: subData } = await adminDb.from("subscriptions")
        .select("items").eq("shopify_contract_id", String(contractId)).single();
      const items = (subData?.items as { variant_id?: string; line_id?: string }[]) || [];
      const li = items.find(i => i.line_id === oldLineId || String(i.variant_id) === oldLineId);
      const resolvedVariant = Number(li?.variant_id);
      if (li?.variant_id && Number.isFinite(resolvedVariant)) {
        body.oldVariants = [resolvedVariant];
      } else {
        // Last resort — preserve the legacy synthesized-GID behavior.
        body.oldLineId = `gid://shopify/SubscriptionLine/${oldLineId}`;
      }
    }
  } else if (oldLineId) {
    // Internal subs don't use this body for an API call (they take the internal
    // branch below), but keep the legacy shape so logging stays consistent.
    body.oldLineId = safeStartsWith(oldLineId, "gid://") ? oldLineId : `gid://shopify/SubscriptionLine/${oldLineId}`;
  }

  // Pure removals (without replacement) belong in the dedicated removeLineItem
  // route — separate Appstle endpoint, separate handler. Reject here.
  if (oldVariants.length && !newVariants && allowRemoveWithoutAdd) {
    return jsonErr({
      error: "use_remove_line_item_route",
      detail: "Pure removals must call the removeLineItem portal route, not replaceVariants.",
    }, 400);
  }

  // The Appstle body wants NUMERIC variant ids (Appstle subs are always
  // numeric). Internal subs (UUID refs) never use this body — they take the
  // internal branch below — so coercing to Number here is safe (UUIDs drop out).
  if (oldVariants.length) body.oldVariants = oldVariants.map(Number).filter(Number.isFinite);
  if (oldOneTimeVariants.length) body.oldOneTimeVariants = oldOneTimeVariants.map(Number).filter(Number.isFinite);
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
        const rawLineId = safeStartsWith(oldLineId, "gid://") ? oldLineId.split("/").pop() : oldLineId;
        const lineItem = items.find(i => i.line_id === rawLineId || i.line_id === oldLineId || String(i.variant_id) === rawLineId || String(i.variant_id) === oldLineId);
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
  if (isInternal) {
    // Internal sub — no Appstle. Decompose the replace into internal-aware
    // item mutations (each writes subscriptions.items, which the internal
    // scheduler bills from). Covers the portal UI's swap / quantity / add.
    let oldVarIds = oldVariants.map(String);
    if (!oldVarIds.length && oldLineId) {
      // The portal sends the line's `id` as oldLineId. For internal subs that
      // id IS the variant_id (transform-subscription), so match on EITHER
      // line_id or variant_id. (Appstle items match line_id; internal match
      // variant_id.)
      const adminDb = createAdminClient();
      const { data: subData } = await adminDb.from("subscriptions").select("items").eq("shopify_contract_id", String(contractId)).single();
      const items = (subData?.items as { variant_id?: string; line_id?: string }[]) || [];
      const rawLineId = safeStartsWith(oldLineId, "gid://") ? oldLineId.split("/").pop() : oldLineId;
      const li = items.find((i) => i.line_id === rawLineId || i.line_id === oldLineId || String(i.variant_id) === rawLineId || String(i.variant_id) === oldLineId);
      if (li?.variant_id) oldVarIds = [String(li.variant_id)];
    }
    const newEntries: Array<[string, number]> = newVariants ? Object.entries(newVariants).map(([k, v]) => [String(k), Number(v)]) : [];
    const oneTimeEntries: Array<[string, number]> = newOneTimeVariants ? Object.entries(newOneTimeVariants).map(([k, v]) => [String(k), Number(v)]) : [];

    const adminDb = createAdminClient();
    const { data: cur } = await adminDb.from("subscriptions").select("items").eq("shopify_contract_id", String(contractId)).single();
    const curVars = new Set(((cur?.items as { variant_id?: string }[]) || []).map((i) => String(i.variant_id)));

    let r: { success: boolean; error?: string } = { success: true };
    if (oldVarIds.length === 1 && newEntries.length === 1) {
      r = await subSwapVariant(auth.workspaceId, String(contractId), oldVarIds[0], newEntries[0][0], newEntries[0][1] || 1);
    } else {
      for (const ov of oldVarIds) {
        r = await subRemoveItem(auth.workspaceId, String(contractId), ov);
        if (!r.success) break;
      }
      if (r.success) for (const [nv, nq] of newEntries) {
        r = curVars.has(nv) && !oldVarIds.includes(nv)
          ? await subChangeQuantity(auth.workspaceId, String(contractId), nv, nq)
          : await subAddItem(auth.workspaceId, String(contractId), nv, nq);
        if (!r.success) break;
      }
    }
    if (r.success) for (const [nv, nq] of oneTimeEntries) {
      r = await subAddItem(auth.workspaceId, String(contractId), nv, nq);
      if (!r.success) break;
    }
    if (!r.success) return handleAppstleError(new Error(r.error || "Internal item update failed"), { route: "replaceVariants", payload: body });
  } else {
    try {
      const { healOnTouch } = await import("@/lib/appstle-pricing");
      await healOnTouch(auth.workspaceId, String(contractId));
      const admin = createAdminClient();
      const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
      if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
      const apiKey = decrypt(ws.appstle_api_key_encrypted);

      const res = await portalFetch(`https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details/replace-variants-v3`, {
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
  }

  // POST-SWAP: Apply grandfathered base price if detected
  if (grandfatheredBase && newVariantIdForPrice) {
    try {
      const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
      const priceResult = await subUpdateLineItemPrice(auth.workspaceId, String(contractId), newVariantIdForPrice, grandfatheredBase);

      // Patch the response so the UI shows the corrected price
      if (priceResult.success && updated) {
        const priceDecimal = (grandfatheredBase / 100).toFixed(2);
        const discountedDecimal = (Math.round(grandfatheredBase * 0.75) / 100).toFixed(2);
        const respLines = (updated as Record<string, unknown>).lines;
        const nodes = respLines && typeof respLines === "object"
          ? (respLines as Record<string, unknown>).nodes || respLines
          : null;
        if (Array.isArray(nodes)) {
          for (const n of nodes) {
            const node = (n as Record<string, unknown>).node || n;
            const vid = String((node as Record<string, unknown>).variantId || "").split("/").pop();
            if (vid === newVariantIdForPrice) {
              (node as Record<string, unknown>).currentPrice = { __typename: "MoneyV2", amount: discountedDecimal, currencyCode: "USD" };
              (node as Record<string, unknown>).pricingPolicy = {
                __typename: "SubscriptionPricingPolicy",
                basePrice: { __typename: "MoneyV2", amount: priceDecimal, currencyCode: "USD" },
                cycleDiscounts: [{ __typename: "SubscriptionCyclePriceAdjustment", afterCycle: 0, adjustmentType: "PERCENTAGE", adjustmentValue: { __typename: "SellingPlanPricingPolicyPercentageValue", percentage: 25 }, computedPrice: { __typename: "MoneyV2", amount: discountedDecimal, currencyCode: "USD" } }],
              };
              break;
            }
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Resolve oldVariants from the subscription's pre-swap state if the
  // client only sent oldLineId (or if oldVariants was empty). Without
  // this, the customer_event has newVariants but no record of what was
  // swapped FROM — and downstream timeline/anomaly detectors can't
  // describe the change without joining to earlier events.
  let resolvedOldVariants: Array<{ variant_id: string; sku?: string | null; title?: string | null; variant_title?: string | null; quantity?: number }> = [];
  if (oldVariants.length || oldLineId) {
    try {
      const adminDb = createAdminClient();
      const { data: subData } = await adminDb.from("subscriptions")
        .select("items").eq("shopify_contract_id", String(contractId)).single();
      const items = (subData?.items as Array<{ variant_id?: string; line_id?: string; sku?: string; title?: string; variant_title?: string; quantity?: number }>) || [];

      if (oldVariants.length) {
        const wanted = new Set(oldVariants.map(String));
        for (const it of items) {
          if (it.variant_id && wanted.has(String(it.variant_id))) {
            resolvedOldVariants.push({ variant_id: String(it.variant_id), sku: it.sku || null, title: it.title || null, variant_title: it.variant_title || null, quantity: it.quantity || 1 });
          }
        }
      } else if (oldLineId) {
        const rawLineId = safeStartsWith(oldLineId, "gid://") ? oldLineId.split("/").pop() : oldLineId;
        const lineItem = items.find(i => i.line_id === rawLineId || i.line_id === oldLineId || String(i.variant_id) === rawLineId || String(i.variant_id) === oldLineId);
        if (lineItem?.variant_id) {
          resolvedOldVariants.push({ variant_id: String(lineItem.variant_id), sku: lineItem.sku || null, title: lineItem.title || null, variant_title: lineItem.variant_title || null, quantity: lineItem.quantity || 1 });
        }
      }
    } catch { /* non-fatal — event still logs with the legacy shape */ }
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.items.swapped",
      summary: "Customer swapped subscription items via portal",
      properties: {
        shopify_contract_id: String(contractId),
        oldVariants,
        newVariants,
        // Enriched detail for timeline / anomaly detection. `oldVariants`
        // stays for back-compat; `oldVariantDetails` is the rich shape.
        oldVariantDetails: resolvedOldVariants,
      },
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
  } else if (isInternal) {
    // Internal mutations already wrote subscriptions.items — surface the fresh lines.
    const adminDb = createAdminClient();
    const { data: fresh } = await adminDb.from("subscriptions").select("items").eq("shopify_contract_id", String(contractId)).single();
    patch.lines = (fresh?.items as unknown[]) || [];
  }

  return jsonOk({ ok: true, route, contractId, patch });
};
