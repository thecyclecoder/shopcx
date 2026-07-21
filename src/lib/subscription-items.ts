// Unified subscription line item mutations via Appstle replaceVariants-v3
// All subscription item changes (add, remove, swap, quantity) go through this single module.

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { decrypt } from "@/lib/crypto";
import { normalizeCountryToIso2 } from "@/lib/country-iso2";
import { healOnTouch } from "@/lib/appstle-pricing";
import {
  isInternalSubscription,
  internalSubAddItem,
  internalSubRemoveItem,
  internalSubSwapVariant,
  internalSubUpdateLineItemPrice,
  internalSubApplyDiscount,
  internalSubRemoveDiscount,
} from "@/lib/internal-subscription";
import { resolveCoupon } from "@/lib/coupons";
import { applyDiscountWithReplace, removeExistingDiscounts } from "@/lib/appstle-discount";

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

/**
 * Resolve an "id-or-title" string to the numeric variant id on a
 * specific contract. The orchestrator occasionally passes a
 * human-readable title (e.g. "ACV Gummies (Apple)") into actions
 * that expect a numeric variant id; this helper rescues those calls
 * by matching against the live Appstle contract's lines.
 *
 * Returns null when no match — callers should error with a useful
 * message that lists what IS on the contract.
 */
export async function resolveContractVariantId(
  workspaceId: string,
  contractId: string,
  idOrTitle: string,
): Promise<{ numericId: string | null; available: string[]; titles: string[] }> {
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { numericId: null, available: [], titles: [] };
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
      { cache: "no-store" },
    );
    if (!res.ok) return { numericId: null, available: [], titles: [] };
    const data = await res.json();
    const lines = (data.lines?.nodes || []) as Array<Record<string, unknown>>;
    const isNumeric = /^\d+$/.test(String(idOrTitle));
    const target = String(idOrTitle).toLowerCase().trim();
    const available: string[] = [];
    const titles: string[] = [];
    for (const l of lines) {
      const vid = String(l.variantId || "").split("/").pop();
      const title = String(l.title || l.productTitle || "");
      if (vid) available.push(vid);
      if (title) titles.push(title);
    }
    // Primary: exact numeric variant id match
    let line = lines.find((l) => {
      const vid = String(l.variantId || "").split("/").pop();
      return vid === String(idOrTitle);
    });
    // Fallback: title match (only when the caller passed text)
    if (!line && !isNumeric) {
      line = lines.find((l) => {
        const t = String((l.title || l.productTitle || "")).toLowerCase().trim();
        if (!t) return false;
        return t === target || t.includes(target) || target.includes(t);
      });
    }
    const numericId = line ? String(line.variantId || "").split("/").pop() || null : null;
    return { numericId, available, titles };
  } catch {
    return { numericId: null, available: [], titles: [] };
  }
}

export async function appstleRemoveLineItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: { variantId?: string; lineGid?: string },
): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }> {
  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  try {
    let lineGid = variantOrLine.lineGid || null;

    // Resolve lineGid from variantId if needed by fetching the contract.
    // The orchestrator sometimes passes a human-readable title
    // ("ACV Gummies (Apple)") instead of the numeric ID — when that
    // happens we fall back to matching against line title /
    // productTitle so the remove still goes through.
    if (!lineGid && variantOrLine.variantId) {
      const contractRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
        { cache: "no-store" },
      );
      if (!contractRes.ok) return { success: false, error: `Contract fetch failed: ${contractRes.status}` };
      const contractData = await contractRes.json();
      const lines = (contractData.lines?.nodes || []) as Array<Record<string, unknown>>;
      const isNumeric = /^\d+$/.test(String(variantOrLine.variantId));
      const target = String(variantOrLine.variantId).toLowerCase().trim();

      // Primary: exact numeric variant id match
      let line = lines.find((l) => {
        const vid = String(l.variantId || "").split("/").pop();
        return vid === String(variantOrLine.variantId);
      });

      // Fallback: title match (only when the caller passed text, not a number)
      if (!line && !isNumeric) {
        line = lines.find((l) => {
          const t = String((l.title || l.productTitle || "")).toLowerCase().trim();
          if (!t) return false;
          // Match if the passed text matches title, productTitle, or
          // either contains the other (handles "ACV Gummies" vs "ACV
          // Gummies (Apple)" cases).
          return t === target || t.includes(target) || target.includes(t);
        });
      }

      if (!line?.id) {
        // A *numeric* variant id that isn't on the live contract means the line
        // is already gone — the removal goal is satisfied. Report idempotent
        // success (alreadyAbsent) so the portal self-serves instead of surfacing
        // a raw GID error and escalating a ticket. Title-based orchestrator calls
        // (non-numeric) keep the descriptive error so a genuine mismatch stays visible.
        if (isNumeric) {
          return { success: true, alreadyAbsent: true };
        }
        const available = lines.map((l) => String(l.variantId || "").split("/").pop()).join(", ");
        return { success: false, error: `Variant "${variantOrLine.variantId}" not found on contract. Available variants: ${available || "(none)"}` };
      }
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
      // Appstle's own authoritative guardrail: it refuses to remove the last
      // recurring product with a 400 UserGeneratedError ("Cannot remove line
      // item. Atleast one subscription product must be present in a
      // subscription"). Our local pre-check (remove-line-item.ts) catches this
      // first when the items snapshot is accurate, but a stale-high snapshot
      // lets the removal through and Appstle rejects it. This is an expected,
      // user-generated outcome — NOT a server error — so log at warn and fold
      // it into the friendly would_remove_last_item path instead of flooding
      // the error feed with a 502.
      const lower = text.toLowerCase();
      if (
        res.status === 400 &&
        (lower.includes("must be present in a subscription") || lower.includes("usergeneratederror"))
      ) {
        console.warn("[appstleRemoveLineItem] last-item guardrail:", res.status, text.slice(0, 200));
        return { success: false, error: "would_remove_last_item" };
      }
      console.error("[appstleRemoveLineItem] error:", res.status, text);
      return { success: false, error: `Appstle API error: ${res.status} — ${text.slice(0, 200)}` };
    }

    // Update local DB
    await syncContractItems(workspaceId, contractId, config.apiKey);

    return { success: true };
  } catch (err) {
    console.error("[appstleRemoveLineItem] failed:", err);
    return { success: false, error: errText(err) };
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
  const url = "https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details/replace-variants-v3";
  const t0 = Date.now();
  const { logAppstleCall } = await import("@/lib/appstle-call-log");
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store",
    });
    const text = await res.text();
    await logAppstleCall({
      url, method: "POST", body, endpoint: "replace-variants-v3",
      status: res.status, responseBody: text, success: res.ok,
      durationMs: Date.now() - t0,
    });
    if (!res.ok) {
      console.error("Appstle replaceVariants error:", text, "body sent:", JSON.stringify(body));
      const snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
      return { success: false, error: `Appstle ${res.status}: ${snippet || "no body"}` };
    }
    return { success: true };
  } catch (err) {
    console.error("Appstle replaceVariants failed:", err);
    await logAppstleCall({
      url, method: "POST", body, endpoint: "replace-variants-v3",
      status: 0, responseBody: errText(err), success: false,
      durationMs: Date.now() - t0,
    });
    return { success: false, error: errText(err) };
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
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubAddItem(workspaceId, contractId, variantId, quantity);
  }
  await healOnTouch(workspaceId, contractId);
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

/**
 * Resolve an incoming variant id to the numeric Shopify variant id an Appstle
 * contract expects. Passthrough when already numeric; otherwise treat it as our
 * `product_variants.id` UUID and look up its `shopify_variant_id`. Returns null
 * when neither resolves — the Appstle one-time add can't proceed without it.
 */
async function resolveShopifyVariantId(variantId: string): Promise<string | null> {
  const raw = String(variantId || "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const admin = createAdminClient();
  const { data: v } = await admin
    .from("product_variants")
    .select("shopify_variant_id")
    .eq("id", raw)
    .maybeSingle();
  const sid = v?.shopify_variant_id ? String(v.shopify_variant_id) : null;
  return sid && /^\d+$/.test(sid) ? sid : null;
}

/**
 * Add a ONE-TIME gift (or paid add-on) to a subscription's NEXT renewal —
 * internal-aware. The item rides exactly one order then drops off; it does NOT
 * recur. This is the "add a frother as a gift with my next order" mechanism.
 *
 *   INTERNAL sub → native: append a one-time line to `subscriptions.items[]`
 *     ([[internal-subscription]] `internalSubAddOneTimeGift`). A FREE gift is
 *     `is_gift: true` (pricing engine forces $0); the renewal engine drops the
 *     line after it ships. Fully owned by our DB — reliable + verified.
 *
 *   APPSTLE sub → a standalone $0 GIFT ORDER via `issueReplacement` (FREE only).
 *     Appstle's true one-off endpoint is on membership-admin.appstle.com and 401s
 *     our Subscriptions key; `replace-variants-v3` `newOneTimeVariants` adds a
 *     RECURRING $0 line (the ticket 6a8ddfd9 double-frother incident). So the gift
 *     ships as its own $0 order — never recurs, never charges. Idempotent (skips if
 *     a gift order for the variant/sub landed in the last hour) so a retry can't
 *     double-order.
 *
 * `opts.free` defaults true (the gift case). `opts.priceCents` sets an explicit
 * price for a PAID add-on (INTERNAL only — paid add-ons aren't supported on Appstle
 * subs, which return an error).
 *
 * Returns `free_confirmed` so the caller only tells the customer "free" when the
 * $0 actually landed. `backend` is `"internal" | "appstle"`.
 */
export async function subAddOneTimeGift(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
  opts: { free?: boolean; priceCents?: number | null } = {},
): Promise<{ success: boolean; error?: string; free_confirmed?: boolean; backend?: "internal" | "appstle" }> {
  const free = opts.free !== false;
  const qty = Math.max(1, Math.floor(quantity || 1));

  // Internal sub → native one-time line in our DB.
  if (await isInternalSubscription(workspaceId, contractId)) {
    const { internalSubAddOneTimeGift } = await import("@/lib/internal-subscription");
    const r = await internalSubAddOneTimeGift(workspaceId, contractId, variantId, qty, opts);
    return { ...r, free_confirmed: r.success && free, backend: "internal" };
  }

  // Appstle sub → a standalone $0 GIFT ORDER (issueReplacement). Appstle's true
  // one-off endpoint lives on membership-admin.appstle.com and 401s our Subscriptions
  // API key, and replace-variants-v3 `newOneTimeVariants` adds a RECURRING $0 line
  // (the ticket 6a8ddfd9 double-frother incident). So an Appstle sub's one-time gift
  // ships as its OWN $0 order — reliable, never recurs, never charges. FREE only.
  if (!free) {
    return { success: false, error: "Paid one-time add-ons aren't supported on Appstle subs — use an internal sub or a charged order.", backend: "appstle" };
  }
  const shopifyVariantId = await resolveShopifyVariantId(variantId);
  if (!shopifyVariantId) {
    return { success: false, error: `Could not resolve a Shopify variant id for "${variantId}"`, backend: "appstle" };
  }
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions").select("id, customer_id").eq("shopify_contract_id", contractId).maybeSingle();
  if (!sub?.customer_id) return { success: false, error: "Could not resolve the customer for this subscription", backend: "appstle" };
  const { data: cust } = await admin
    .from("customers").select("shopify_customer_id, first_name, last_name, default_address").eq("id", sub.customer_id).maybeSingle();
  if (!cust?.shopify_customer_id) return { success: false, error: "Customer has no Shopify id — can't create a gift order", backend: "appstle" };

  // IDEMPOTENCY — a self-heal retry must NOT create a SECOND gift order. A successful
  // gift lands as `status='created'` with `replacement_order_id` STILL NULL (that UUID
  // is stamped later on order sync), so we key on STATUS, not the order id: any
  // NON-FAILED goodwill-gift replacement for this variant on this sub in the last hour
  // means the gift already went out — skip. (A `failed` row must NOT block a retry.)
  const { data: priorGifts } = await admin
    .from("replacements").select("id, items, status, created_at")
    .eq("subscription_id", sub.id).eq("reason", ONE_TIME_GIFT_REASON)
    .neq("status", "failed")
    .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const alreadyGifted = (priorGifts || []).some((g) =>
    Array.isArray(g.items) && (g.items as Array<Record<string, unknown>>).some((it) => String(it.variantId ?? it.variant_id) === shopifyVariantId));
  if (alreadyGifted) return { success: true, free_confirmed: true, backend: "appstle" };

  const resolvedAddr = await (await import("@/lib/customer-shipping-address")).resolveCustomerShippingAddress(admin, workspaceId, sub.customer_id, {});
  const a = resolvedAddr?.address;
  if (!a?.address1) return { success: false, error: "No shipping address on file — can't create a gift order", backend: "appstle" };

  // Gift line title (product name) for the order + note.
  const { data: pv } = await admin.from("product_variants").select("product_id").eq("shopify_variant_id", shopifyVariantId).maybeSingle();
  let giftTitle = "Gift";
  if (pv?.product_id) {
    const { data: p } = await admin.from("products").select("title").eq("id", pv.product_id).maybeSingle();
    if (p?.title) giftTitle = String(p.title);
  }

  // Country: the shared resolver can hand back a truncated "UN" (from "United
  // States") which Shopify rejects — and normalizeCountryToIso2 lets "UN" pass (it
  // matches the 2-letter shape). Derive from the customer's authoritative Shopify
  // countryCodeV2 / country name instead, normalized to a real ISO2.
  const da = (cust.default_address as Record<string, unknown> | null) || {};
  const countryCode = normalizeCountryToIso2(String(da.countryCodeV2 || da.country || a.countryCode || "US"));

  const { issueReplacement } = await import("@/lib/commerce/replacement");
  const r = await issueReplacement(workspaceId, {
    customerId: sub.customer_id,
    shopifyCustomerId: String(cust.shopify_customer_id),
    items: [{ variantId: shopifyVariantId, quantity: qty, title: giftTitle }],
    shippingAddress: {
      firstName: a.firstName || cust.first_name || "",
      lastName: (a as { lastName?: string }).lastName || cust.last_name || "",
      address1: a.address1,
      address2: (a as { address2?: string }).address2,
      city: a.city,
      provinceCode: a.provinceCode,
      zip: a.zip,
      countryCode,
    },
    reason: ONE_TIME_GIFT_REASON,
    subscriptionId: sub.id,
    initiatedBy: "script",
    shopifyNote: `Complimentary one-time gift (${giftTitle} × ${qty}) — goodwill, $0, ships as its own order alongside the next renewal.`,
  });
  if (!r.success) return { success: false, error: r.error, backend: "appstle" };
  return { success: true, free_confirmed: true, backend: "appstle" };
}

/** Short reason tag for a one-time goodwill gift order (Shopify draft-order tags cap at 40 chars). */
const ONE_TIME_GIFT_REASON = "goodwill gift";

/** Remove a product variant from a subscription */
export async function subRemoveItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: string | { variantId?: string; lineGid?: string },
): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }> {
  const arg = typeof variantOrLine === "string" ? { variantId: variantOrLine } : variantOrLine;
  // Internal subs are matched by variant_id (no Appstle line gids). Check
  // internal FIRST so a lineId-only call can't silently fall through to the
  // Appstle endpoint with an internal contract id.
  if (await isInternalSubscription(workspaceId, contractId)) {
    if (!arg.variantId) {
      return { success: false, error: "Internal subscription requires a variantId to remove a line item" };
    }
    return internalSubRemoveItem(workspaceId, contractId, arg.variantId);
  }
  // Use dedicated remove-line-item endpoint (not replaceVariants)
  return appstleRemoveLineItem(workspaceId, contractId, arg);
}

/** Change quantity of a variant on a subscription (remove + re-add with new qty) */
export async function subChangeQuantity(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    // Internal path: rewrite the line's quantity directly.
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, items")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (!sub) return { success: false, error: "Internal subscription not found" };
    type Item = { variant_id?: string | number; quantity?: number };
    const items = ((sub.items as Item[]) || []).map((i) =>
      String(i.variant_id) === String(variantId) ? { ...i, quantity } : i,
    );
    await admin.from("subscriptions").update({ items, updated_at: new Date().toISOString() }).eq("id", sub.id);
    return { success: true };
  }
  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  // If the caller passed a title instead of a numeric id, resolve it.
  let resolvedId = variantId;
  if (!/^\d+$/.test(String(variantId))) {
    const r = await resolveContractVariantId(workspaceId, contractId, variantId);
    if (!r.numericId) {
      return { success: false, error: `Variant "${variantId}" not found on contract. Available variants: ${r.available.join(", ") || "(none)"}` };
    }
    resolvedId = r.numericId;
  }

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    oldVariants: [Number(resolvedId)],
    newVariants: { [resolvedId]: quantity },
    carryForwardDiscount: "EXISTING_PLAN",
    stopSwapEmails: true,
  });

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.map((item) =>
        String(item.variant_id) === resolvedId ? { ...item, quantity } : item,
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
  if (await isInternalSubscription(workspaceId, contractId)) {
    // lineGid only matters for Appstle's contract.line GID indirection;
    // our DB items array is keyed by variant_id directly.
    return internalSubUpdateLineItemPrice(workspaceId, contractId, variantId, basePriceCents);
  }
  await healOnTouch(workspaceId, contractId);
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
    return { success: false, error: errText(err) };
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

/**
 * Decide the Appstle `basePrice` (cents) to set on the NEW line after a single-item portal swap so the
 * swapped-in product carries the subscriber S&S discount — NOT a flat MSRP. Returns null to leave
 * Appstle's own value untouched (when we can't safely price the new line).
 *
 * Derived from ticket d19c2192 (2026-07-10): a swap to a DIFFERENT-priced product left the new line at
 * full MSRP because the old grandfathered-preservation branch only fired when the new variant's catalog
 * price EQUALLED the old one (`newStandardCents === oldStandardCents`). A customer who swapped
 * Creatine Prime → Amazing Creamer saw/was-quoted $69.95 (0% off) instead of $52.46 (25% subscriber).
 *
 * Two cases (base is pre-discount; the Appstle 25% S&S cycle brings the charge to base × (1 − sns)):
 *   1. GRANDFATHERED PRESERVE — the old line was priced BELOW its own catalog standard AND the new
 *      variant shares that catalog price (a like-for-like swap): keep the grandfathered charge by
 *      returning the reverse-engineered old base (`round(oldItemPriceCents / (1 − sns))`).
 *   2. STANDARD SUBSCRIBER — any other single swap with a known new catalog price: return the new
 *      variant's catalog MSRP as the base, so the S&S cycle discounts it to the subscriber price.
 *
 * `snsPct` defaults to 25 — the same assumption the surrounding portal/heal code already hardcodes.
 * Per-product `subscribe_discount_pct` awareness ([[appstle-pricing]] `resolveLineSnsPct`) is a
 * follow-up; this keeps parity with the existing behavior it generalizes. Pure.
 */
export function decideSwapNewLineBaseCents(input: {
  oldItemPriceCents: number | null | undefined;
  oldStandardCents: number | null | undefined;
  newStandardCents: number | null | undefined;
  snsPct?: number;
}): number | null {
  const sns = input.snsPct ?? 25;
  const newStandard = input.newStandardCents;
  // No catalog price for the swapped-in variant → don't guess; leave Appstle's value.
  if (!newStandard || newStandard <= 0) return null;
  const frac = 1 - sns / 100;
  if (frac <= 0) return newStandard;

  const oldPrice = input.oldItemPriceCents;
  const oldStandard = input.oldStandardCents;
  if (oldPrice && oldPrice > 0 && oldStandard && oldStandard > 0) {
    const effectiveOldBase = Math.round(oldPrice / frac);
    // Like-for-like swap of a grandfathered line → preserve the grandfathered base.
    if (effectiveOldBase < oldStandard && newStandard === oldStandard) return effectiveOldBase;
  }
  // Otherwise price the new line at its own catalog MSRP (the S&S cycle discounts it).
  return newStandard;
}

/**
 * Apply a coupon to a subscription — internal-aware dispatcher.
 *
 * Internal subs: resolve the code through resolveCoupon (internal-wins →
 * Shopify fallback) so we never write an unresolvable code onto
 * subscriptions.applied_discounts, then delegate to internalSubApplyDiscount.
 * Appstle subs: healOnTouch first (so any null-policy line is structured
 * before the mutation), then applyDiscountWithReplace which enforces the
 * 1-coupon-per-sub invariant on Appstle's side.
 */
export async function subscriptionApplyCoupon(
  workspaceId: string,
  contractId: string,
  code: string,
): Promise<{ success: boolean; error?: string }> {
  if (!code) return { success: false, error: "Missing coupon code" };

  if (await isInternalSubscription(workspaceId, contractId)) {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("customer_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    const resolved = await resolveCoupon(workspaceId, code, sub?.customer_id as string | null);
    if (!resolved) return { success: false, error: "coupon_not_found" };
    return internalSubApplyDiscount(workspaceId, contractId, resolved.code);
  }

  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };
  const r = await applyDiscountWithReplace(config.apiKey, contractId, code);
  return { success: r.success, error: r.error };
}

/**
 * Remove a coupon from a subscription — internal-aware dispatcher.
 *
 * Internal subs: delegate to internalSubRemoveDiscount, which filters
 * subscriptions.applied_discounts by title or id.
 * Appstle subs: healOnTouch, then removeExistingDiscounts (which clears the
 * whole applied_discounts set — matches the 1-coupon-per-sub invariant, so
 * the discountIdOrCode argument is retained for API symmetry only).
 */
export async function subscriptionRemoveCoupon(
  workspaceId: string,
  contractId: string,
  discountIdOrCode: string,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubRemoveDiscount(workspaceId, contractId, discountIdOrCode);
  }

  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };
  const r = await removeExistingDiscounts(config.apiKey, contractId);
  return { success: !r.error, error: r.error };
}

/** Swap one variant for another (e.g., change flavor or swap product) */
export async function subSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string; newLineGid?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubSwapVariant(workspaceId, contractId, oldVariantId, newVariantId, quantity);
  }
  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };

  // Old variant id might come in as a title (orchestrator hallucination
  // protection) — resolve to numeric. The NEW variant id is expected
  // to be numeric since it's a fresh variant Opus picks from the
  // catalog, but we accept either form via the same helper for safety.
  let resolvedOld = oldVariantId;
  if (!/^\d+$/.test(String(oldVariantId))) {
    const r = await resolveContractVariantId(workspaceId, contractId, oldVariantId);
    if (!r.numericId) {
      return { success: false, error: `Old variant "${oldVariantId}" not found on contract. Available: ${r.available.join(", ") || "(none)"}` };
    }
    resolvedOld = r.numericId;
  }

  const result = await callReplaceVariants(config.apiKey, {
    shop: config.shop,
    contractId: Number(contractId),
    eventSource: "CUSTOMER_PORTAL",
    oldVariants: [Number(resolvedOld)],
    newVariants: { [newVariantId]: quantity },
    carryForwardDiscount: "EXISTING_PLAN",
    stopSwapEmails: true,
  });

  let newLineGid: string | undefined;

  if (result.success) {
    await syncItemsAfterMutation(workspaceId, contractId, (items) =>
      items.map((item) =>
        String(item.variant_id) === resolvedOld
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
