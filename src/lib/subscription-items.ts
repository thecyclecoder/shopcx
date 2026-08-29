// Unified subscription line item mutations via Appstle replaceVariants-v3
// All subscription item changes (add, remove, swap, quantity) go through this single module.

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { decrypt } from "@/lib/crypto";
import { normalizeCountryToIso2 } from "@/lib/country-iso2";
import { healOnTouch, resolveLineSnsPct, type AppstleLine } from "@/lib/appstle-pricing";
import { assertSwapDidNotRaise, type PriceGuardRefusal } from "@/lib/swap-price-assertion";
import { resolveSubscriptionPricing } from "@/lib/pricing";
import {
  isInternalSubscription,
  internalSubAddItem,
  internalSubRemoveItem,
  internalSubSwapVariant,
  internalSubUpdateLineItemPrice,
  internalSubApplyDiscount,
  internalSubRemoveDiscount,
} from "@/lib/internal-subscription";
import { resolveCoupon, ensureInternalLoyaltyCouponRow } from "@/lib/coupons";
import { applyDiscountWithReplace, removeExistingDiscounts } from "@/lib/appstle-discount";

/**
 * Coupon eligibility by subscription status — a discount is only ever valid on
 * an ACTIVE subscription. A paused/cancelled sub must not accept a new coupon:
 * a discount stored on it silently discounts a future renewal the customer
 * didn't earn (Cora rule_violation, ticket f9e28d57 double-payout).
 *
 * See docs/brain/tables/subscriptions.md — status is lowercase, values in use
 * are 'active' | 'paused' | 'cancelled'.
 */
export function couponApplicableToSubStatus(status: string | null | undefined): boolean {
  return status === "active";
}

/**
 * Look up product title + variant title + sku from our catalog by variant ID.
 *
 * Reads `product_variants` (the first-class variant table) rather than the
 * legacy `products.variants` jsonb blob, and matches BOTH rails: Appstle rows
 * carry the Shopify numeric variant id, internal rows carry our variant UUID.
 * Returns `sku` so a line the caller could not otherwise identify by SKU still
 * lands with one — see [[docs/brain/libraries/subscription-items]] § Lossless
 * item sync.
 */
export async function resolveVariantTitles(
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, { title: string; variant_title: string; product_id: string; sku: string | null; image_url: string | null }>> {
  const map = new Map<string, { title: string; variant_title: string; product_id: string; sku: string | null; image_url: string | null }>();
  const ids = [...new Set(variantIds.map((v) => String(v || "")).filter(Boolean))];
  if (!ids.length) return map;

  const admin = createAdminClient();
  // Match on the Shopify variant id (Appstle rail) or our own UUID (internal
  // rail). UUID-shaped ids only go in the `id` predicate — feeding a non-UUID
  // to a uuid column errors the whole query (22P02) instead of missing a row.
  const uuidIds = ids.filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  const query = admin
    .from("product_variants")
    .select("id, product_id, shopify_variant_id, sku, title, image_url, products(title)")
    .eq("workspace_id", workspaceId);
  const { data: variants } = uuidIds.length
    ? await query.or(`shopify_variant_id.in.(${ids.join(",")}),id.in.(${uuidIds.join(",")})`)
    : await query.in("shopify_variant_id", ids);

  for (const v of variants || []) {
    const productTitle = (v.products as { title?: string } | null)?.title || "";
    const entry = {
      title: productTitle,
      variant_title: v.title === "Default Title" ? "" : (v.title || ""),
      product_id: String(v.product_id || ""),
      sku: v.sku ?? null,
      image_url: v.image_url ?? null,
    };
    // Register under both keys so either rail's variant_id resolves.
    if (v.shopify_variant_id) map.set(String(v.shopify_variant_id), entry);
    if (v.id) map.set(String(v.id), entry);
  }
  return map;
}

/**
 * Enrich subscription items with titles + sku + our product UUID from the
 * catalog. Catalog IDs are the source of truth over payload titles.
 *
 * `sku` is only FILLED IN, never overwritten — a caller that already mapped a
 * sku off the Appstle payload keeps it, and an unresolvable variant (one
 * missing from `product_variants`) keeps whatever it arrived with instead of
 * being blanked.
 */
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
      return {
        ...i,
        title: resolved.title,
        variant_title: resolved.variant_title,
        product_id: resolved.product_id,
        sku: i.sku ?? resolved.sku ?? null,
        image_url: i.image_url ?? resolved.image_url ?? null,
      };
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

    // Phase 1 — a 200 from remove-line-item is not proof the line is gone. Re-read the live
    // contract and refuse to report success unless the variant is actually absent. syncContractItems
    // only fires on verified success — mirroring the sub back to the intended shape on an
    // unverified mutation would durable-store the lie.
    //
    // The variant id we verify on is the numeric variant behind the resolved `lineGid`. When the
    // caller only handed us a `lineGid` (no `variantId`), we resolve the numeric variant from the
    // just-resolved line so the predicate can classify "still-present". Skipping verification when
    // we cannot identify the variant is safer than a false success — bail as unverifiable.
    let verifyVariantId: string | null = variantOrLine.variantId ? String(variantOrLine.variantId) : null;
    if (!verifyVariantId && lineGid) {
      try {
        const detailRes = await fetch(
          `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${config.apiKey}`,
          { cache: "no-store" },
        );
        if (detailRes.ok) {
          const detail = await detailRes.json();
          const lines = (detail?.lines?.nodes || []) as Array<Record<string, unknown>>;
          // The line we just removed is gone by now — but a fresh read still tells us what remains,
          // and any pre-remove read of the same lineGid would have named its variant. We accept
          // that a lineGid-only remove without variantId can only verify by looking at the AFTER
          // state; if the caller never gave us a variantId and no line remains that maps to that
          // GID, verification succeeds by construction.
          const stillPresent = lines.find((l) => String(l.id || "") === String(lineGid));
          if (stillPresent) {
            return {
              success: false,
              error: `remove did not apply on contract ${contractId}: lineGid ${lineGid} still present on live contract`,
            };
          }
        }
      } catch (err) {
        console.warn("[appstleRemoveLineItem] verify fetch failed:", errText(err));
      }
    }
    if (verifyVariantId && /^\d+$/.test(verifyVariantId)) {
      const verdict = await verifyContractEndState(config.apiKey, contractId, {
        kind: "remove",
        variantId: verifyVariantId,
      });
      if (!verdict.ok) {
        return {
          success: false,
          error: `remove did not apply on contract ${contractId}: ${verdict.reason}`,
        };
      }
    }

    // Update local DB
    await syncContractItems(workspaceId, contractId, config.apiKey);

    return { success: true };
  } catch (err) {
    console.error("[appstleRemoveLineItem] failed:", err);
    return { success: false, error: errText(err) };
  }
}

/**
 * Merge a live Appstle `lines.nodes` snapshot over the stored items array.
 *
 * Appstle is authoritative for the fields it returns (which lines exist,
 * quantity, price, sku, selling plan, image); our DB is authoritative for
 * local-only enrichment it has never heard of (`is_gift`,
 * `price_override_cents`, `one_time_next_renewal`). Prior items are keyed by
 * `line_id`, never `variant_id` — a subscription can legitimately carry two
 * lines of the SAME variant, and a variant key would collapse them and copy
 * one line's local fields onto the other.
 *
 * Pure — unit-tested. See [[docs/brain/libraries/subscription-items]].
 */
export function mergeContractLineItems(
  priorItems: Record<string, unknown>[],
  lines: Record<string, unknown>[],
): Record<string, unknown>[] {
  const priorByLineId = new Map<string, Record<string, unknown>>();
  for (const p of priorItems || []) {
    const lid = String(p?.line_id || "");
    if (lid) priorByLineId.set(lid, p);
  }
  return (lines || []).map((node) => {
    const lineId = String(node.id || "").split("/").pop() || "";
    const appstleOwned = {
      variant_id: String(node.variantId || "").split("/").pop() || "",
      title: node.title || "",
      quantity: node.quantity || 1,
      price_cents: Math.round(parseFloat(String((node.currentPrice as Record<string, unknown>)?.amount || "0")) * 100),
      variant_title: node.variantTitle || "",
      product_id: String(node.productId || "").split("/").pop() || "",
      line_id: lineId,
      sku: (node.sku as string) || null,
      selling_plan: (node.sellingPlanName as string) || null,
      image_url: ((node.variantImage as Record<string, unknown> | null)?.url as string) || null,
    };
    // Local-only keys survive; Appstle-owned keys win.
    return { ...(lineId ? priorByLineId.get(lineId) || {} : {}), ...appstleOwned };
  });
}

/**
 * Refresh local DB items from Appstle contract state — MERGE, never replace.
 *
 * This function runs after every Appstle line mutation, so anything it fails
 * to carry forward is destroyed on the customer's subscription. Three rules:
 *
 * 1. **Map everything Appstle actually returns.** The contract-external line
 *    node carries `sku`, `sellingPlanName` and `variantImage.url` alongside the
 *    fields already mapped. Dropping `sku` here is what made a SKU-keyed sweep
 *    of ACV Gummies find 8 subscriptions instead of 307 (2026-08-11) — every
 *    sub touched by a prior mutation had silently lost its skus.
 * 2. **Preserve local-only fields.** `is_gift`, `price_override_cents` and
 *    `one_time_next_renewal` exist only in our DB; Appstle has never heard of
 *    them. Two of those decide what the customer is charged. Prior items are
 *    keyed by `line_id` (NOT variant_id — a sub can legitimately hold two
 *    lines of the same variant) and merged UNDER the Appstle-owned fields, so
 *    Appstle wins on what it owns and any local key survives by default.
 * 3. **Never write an empty item list over a non-empty one.** A 200 carrying
 *    zero lines is indistinguishable here from a contract Appstle has moved or
 *    dropped, and blanking `items` produces a subscription that renews billing
 *    shipping + protection with no product to ship (the SHOPCX171 empty-cart
 *    renewal, 2026-08-07). Bail instead and leave the last good snapshot.
 *
 * Scoped to `workspace_id` on the write — `shopify_contract_id` alone is not a
 * tenant-safe predicate in a multi-tenant table.
 */
async function syncContractItems(workspaceId: string, contractId: string, apiKey: string) {
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
    );
    if (!res.ok) return;
    const contract = await res.json();
    const lines = (contract.lines?.nodes || []) as Record<string, unknown>[];
    const admin = createAdminClient();

    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, items")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (!existing) return;

    const priorItems = (existing.items as Record<string, unknown>[] | null) || [];
    if (!lines.length) {
      if (priorItems.length) {
        console.warn(
          `[syncContractItems] contract ${contractId} returned 0 lines but local items has ${priorItems.length} — refusing to blank items`,
        );
      }
      return;
    }

    const items = await enrichItemTitles(workspaceId, mergeContractLineItems(priorItems, lines));
    await admin
      .from("subscriptions")
      .update({ items, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);
  } catch { /* non-fatal */ }
}

// ── Post-mutation end-state verification (Phase 1) ──────────────────
//
// Every subscription line mutation on the Appstle rail MUST re-read the LIVE
// contract and confirm the intended end state before it returns success. The
// upstream helper `callReplaceVariants` decides success purely from `res.ok`,
// but Appstle answers 200 on requests it then declines to apply — reproduced
// on contracts 27946909869 and 27871477933 (2026-07-30), where a swap reported
// success and the flavour never moved. A false success is worse than a
// failure: a failure retries, a false success is recorded as done and the
// customer ships the wrong thing. See docs/brain/specs/
// a-subscription-mutation-must-verify-it-happened-not-trust-http-200.md.
//
// The pure predicate `checkContractSatisfiesExpectation` decides
// verified/not-verified/unverifiable from a `lines.nodes` snapshot. The I/O
// wrapper `verifyContractEndState` fetches the live contract and
// polls with a bounded settle window (Appstle can apply asynchronously); a
// TIMEOUT ends as FAILURE — unverifiable is NOT the same as done.

/**
 * What the caller expected the subscription contract to look like after the
 * mutation. Kept as a discriminated union so `checkContractSatisfiesExpectation`
 * classifies each shape without any I/O.
 *
 * - `add` — variant present at ≥ requested quantity (Appstle merges into an
 *   existing line, so quantity is a lower bound not an equality).
 * - `remove` — variant absent from the contract.
 * - `swap` — the new variant present at ≥ requested quantity AND the old
 *   variant absent (a swap that added the new but left the old is a partial
 *   apply, not a success).
 * - `price` — the line for `variantId` carries `pricingPolicy.basePrice`
 *   matching `expectedBaseCents` (±$0.01 tolerance for float→cents rounding).
 */
export type MutationExpectation =
  | { kind: "add"; variantId: string; quantity: number }
  | { kind: "remove"; variantId: string }
  | { kind: "swap"; newVariantId: string; oldVariantId: string; quantity: number }
  | { kind: "price"; variantId: string; expectedBaseCents: number };

/** A verification verdict against a single live-contract snapshot. */
export interface EndStateVerdict {
  /** True when the snapshot satisfies the expectation. */
  ok: boolean;
  /** Present when `ok=false` — describes what was expected vs what is on the contract. */
  reason?: string;
}

/** Pull a numeric-string variant id out of an Appstle line's GID-shaped `variantId`. */
function lineVariantId(line: { variantId?: string }): string | null {
  const raw = line.variantId;
  if (!raw) return null;
  const tail = String(raw).split("/").pop() || String(raw);
  return tail || null;
}

/**
 * Pure predicate — does the live contract's line set satisfy the caller's
 * mutation expectation? Broken out of the mutation helpers so the classification
 * can be unit-tested without standing up a live Appstle contract; the I/O
 * wrapper `verifyContractEndState` polls this against the real contract.
 *
 * Returns `{ ok: true }` when satisfied; `{ ok: false, reason }` naming the
 * expectation and what the contract actually holds so the caller's error string
 * is diagnosable at a glance (e.g. "add expected variant 12345 present; contract
 * holds variants 67890, 24680").
 */
export function checkContractSatisfiesExpectation(
  lines: Array<{ variantId?: string; quantity?: number; pricingPolicy?: { basePrice?: { amount?: string } | null } | null }>,
  expected: MutationExpectation,
): EndStateVerdict {
  const present = lines
    .map((l) => ({ vid: lineVariantId(l), qty: Number(l.quantity ?? 0), line: l }))
    .filter((r): r is { vid: string; qty: number; line: typeof lines[number] } => !!r.vid);
  const holdList = present.map((r) => r.vid).join(", ") || "(none)";

  if (expected.kind === "add") {
    const match = present.find((r) => r.vid === String(expected.variantId));
    if (!match) {
      return {
        ok: false,
        reason: `add expected variant ${expected.variantId} present; contract holds variants ${holdList}`,
      };
    }
    if (match.qty < expected.quantity) {
      return {
        ok: false,
        reason: `add expected variant ${expected.variantId} at quantity ≥ ${expected.quantity}; contract has quantity ${match.qty}`,
      };
    }
    return { ok: true };
  }

  if (expected.kind === "remove") {
    const still = present.find((r) => r.vid === String(expected.variantId));
    if (still) {
      return {
        ok: false,
        reason: `remove expected variant ${expected.variantId} absent; contract still holds it at quantity ${still.qty}`,
      };
    }
    return { ok: true };
  }

  if (expected.kind === "swap") {
    const newMatch = present.find((r) => r.vid === String(expected.newVariantId));
    const oldStill = present.find((r) => r.vid === String(expected.oldVariantId));
    if (!newMatch) {
      return {
        ok: false,
        reason: `swap expected new variant ${expected.newVariantId} present; contract holds variants ${holdList}`,
      };
    }
    if (oldStill) {
      return {
        ok: false,
        reason: `swap expected old variant ${expected.oldVariantId} absent; contract still holds it at quantity ${oldStill.qty}`,
      };
    }
    if (newMatch.qty < expected.quantity) {
      return {
        ok: false,
        reason: `swap expected new variant ${expected.newVariantId} at quantity ≥ ${expected.quantity}; contract has quantity ${newMatch.qty}`,
      };
    }
    return { ok: true };
  }

  // price
  const match = present.find((r) => r.vid === String(expected.variantId));
  if (!match) {
    return {
      ok: false,
      reason: `price update expected variant ${expected.variantId} present; contract holds variants ${holdList}`,
    };
  }
  const basePriceAmt = match.line.pricingPolicy?.basePrice?.amount;
  const observedCents = basePriceAmt != null ? Math.round(parseFloat(String(basePriceAmt)) * 100) : null;
  if (observedCents == null) {
    return {
      ok: false,
      reason: `price update expected base ${expected.expectedBaseCents}¢ on variant ${expected.variantId}; contract line has no pricingPolicy.basePrice`,
    };
  }
  // ±$0.01 tolerance — float→cents rounding across the boundary can drift a penny.
  if (Math.abs(observedCents - expected.expectedBaseCents) > 1) {
    return {
      ok: false,
      reason: `price update expected base ${expected.expectedBaseCents}¢ on variant ${expected.variantId}; contract has ${observedCents}¢`,
    };
  }
  return { ok: true };
}

/**
 * Pick the right MutationExpectation for a `subSwapVariant` identity check. When
 * old === new (a self-swap, i.e. the shape `change_quantity` uses), the swap
 * post-condition "old is absent" can never hold, so the correct assertion is
 * `add` — the variant is present at the requested quantity. A genuine variant-
 * to-variant swap keeps the strict swap post-condition (new present AND old
 * absent) so the 2026-07-30 partial-apply still fails loudly.
 *
 * Broken out as a pure helper so the selection is unit-testable without
 * standing up a live Appstle contract.
 */
export function identityExpectationForSwap(
  oldVariantId: string,
  newVariantId: string,
  quantity: number,
): MutationExpectation {
  if (String(oldVariantId) === String(newVariantId)) {
    return { kind: "add", variantId: String(newVariantId), quantity };
  }
  return {
    kind: "swap",
    newVariantId: String(newVariantId),
    oldVariantId: String(oldVariantId),
    quantity,
  };
}

/**
 * Fetch the live Appstle contract and confirm it satisfies `expected`. Polls
 * with a small bounded settle window because Appstle applies asynchronously —
 * but a TIMEOUT ends as FAILURE, never an assumed success. A fetch error at
 * every attempt is also FAILURE (unverifiable is not done — the caller should
 * escalate or retry rather than record a lie).
 *
 * Defaults: 3 attempts, 400ms between (≈ 800ms worst-case wait). Overridable
 * via `APPSTLE_MUTATION_VERIFY_ATTEMPTS` / `APPSTLE_MUTATION_VERIFY_DELAY_MS`
 * or the `opts` arg (tests use `opts` to run synchronously).
 */
async function verifyContractEndState(
  apiKey: string,
  contractId: string,
  expected: MutationExpectation,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<EndStateVerdict> {
  const attempts = Math.max(1, opts.attempts ?? Number(process.env.APPSTLE_MUTATION_VERIFY_ATTEMPTS ?? 3));
  const delayMs = Math.max(0, opts.delayMs ?? Number(process.env.APPSTLE_MUTATION_VERIFY_DELAY_MS ?? 400));
  let lastReason: string | undefined;
  let lastFetchError: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      const res = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
        { headers: { "X-API-Key": apiKey }, cache: "no-store" },
      );
      if (!res.ok) {
        lastFetchError = `contract fetch failed: ${res.status}`;
        continue;
      }
      const detail = await res.json();
      const lines = (detail?.lines?.nodes || []) as AppstleLine[];
      const verdict = checkContractSatisfiesExpectation(lines, expected);
      if (verdict.ok) return verdict;
      lastReason = verdict.reason;
    } catch (err) {
      lastFetchError = errText(err);
    }
  }
  return {
    ok: false,
    reason: lastReason
      ?? `contract could not be verified (${lastFetchError || "no successful read"}) — treating as unverified, not success`,
  };
}

// ── Phase 2 — a 200 that declines the work is classified, not swallowed ─────
//
// Appstle answers 200 on requests it then declines to apply — reproduced on
// contracts 27946909869 and 27871477933 (2026-07-30), where the swap reported
// success and the flavour never moved. Separately, the same two contracts
// reject `replace-variants-v3` with `errorKey: "maxiterations"` ("Unable to
// complete variant replacement after multiple attempts") — an upstream that has
// given up retrying internally. Retrying reaches the same wall, so treating
// either shape as an ordinary transient wastes attempts and hides a
// subscription that genuinely needs hands.
//
// `classifyReplaceVariantsBody` is a pure predicate over `(status, body)` that
// returns whether Appstle actually applied the mutation and — when declined —
// whether the decline is permanent for that contract. `callReplaceVariants`
// gates its success return on this classifier so a 2xx-with-decline body
// returns FAILURE (with the `maxiterations` case tagged `permanent: true`)
// instead of silently reporting the work done.

/**
 * The classification for one `replace-variants-v3` response.
 *
 * - `declined: true` — the mutation did NOT land, regardless of HTTP status.
 *   Includes a 2xx whose body carries a decline (`errorKey`, `success: false`,
 *   `error` / `errorMessage` string) — the exact shape the 2026-07-30 incident
 *   surfaced — as well as any non-2xx response.
 * - `permanent: true` — retrying this contract will reach the same wall. Today
 *   only `errorKey: "maxiterations"` is classified permanent (survived every
 *   retry across two campaigns on 27946909869 and 27871477933). Any other
 *   decline is treated as non-permanent so callers may still retry.
 * - `errorKey` — the surfaced errorKey when present (for observability).
 * - `reason` — a diagnosable one-liner naming the classification path.
 */
export interface ReplaceVariantsClassification {
  declined: boolean;
  permanent: boolean;
  errorKey?: string;
  reason?: string;
}

/**
 * Pure predicate — did Appstle apply the `replace-variants-v3` mutation, and if
 * not, is the decline permanent for that contract? Broken out from
 * `callReplaceVariants` so the exact 2xx-with-decline shapes (the class of bug
 * this classifier exists to close) are unit-testable without a live HTTP call.
 *
 * The order matters: we look for an explicit decline shape in the body first
 * (so a 2xx-with-decline is classified as declined, not success). If no decline
 * signal is found, a non-2xx status is still a decline. Otherwise the mutation
 * is treated as applied.
 */
export function classifyReplaceVariantsBody(
  status: number,
  body: string,
): ReplaceVariantsClassification {
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const obj = asRecord(parsed);

  const readString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const errorKey =
    (obj && readString(obj.errorKey)) ||
    (obj && readString(asRecord(obj.error)?.errorKey)) ||
    null;
  const errorMessage =
    (obj && readString(obj.errorMessage)) ||
    (obj && readString(obj.message)) ||
    (obj && readString(asRecord(obj.error)?.message)) ||
    (obj && readString(obj.error)) ||
    null;
  const explicitSuccessFalse = !!obj && obj.success === false;
  const errorsArray = obj && Array.isArray(obj.errors) && obj.errors.length > 0;

  // Body-level decline overrides HTTP status — Appstle returns 200 with an
  // errorKey when it declines a request it accepted. Detect the string form as
  // a defensive fallback for future body shapes: `maxiterations` mentioned
  // anywhere in the raw text is a decline regardless of JSON parse success.
  const rawTextLooksMaxIterations = !errorKey && /maxiterations/i.test(body || "");

  if (errorKey || explicitSuccessFalse || errorMessage || errorsArray || rawTextLooksMaxIterations) {
    const effectiveKey = errorKey || (rawTextLooksMaxIterations ? "maxiterations" : null);
    const permanent = effectiveKey === "maxiterations";
    const reason = effectiveKey
      ? `Appstle declined (errorKey=${effectiveKey})${errorMessage ? `: ${errorMessage}` : ""}`
      : errorMessage
        ? `Appstle declined: ${errorMessage}`
        : explicitSuccessFalse
          ? "Appstle declined (success=false in body)"
          : "Appstle declined (errors[] present in body)";
    return {
      declined: true,
      permanent,
      errorKey: effectiveKey || undefined,
      reason,
    };
  }

  if (status < 200 || status >= 300) {
    const snippet = (body || "").slice(0, 400).replace(/\s+/g, " ").trim();
    return {
      declined: true,
      permanent: false,
      reason: `Appstle ${status}: ${snippet || "no body"}`,
    };
  }

  return { declined: false, permanent: false };
}

async function callReplaceVariants(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; permanent?: boolean; declineErrorKey?: string }> {
  const url = "https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details/replace-variants-v3";
  const t0 = Date.now();
  const { logAppstleCall } = await import("@/lib/appstle-call-log");
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store",
    });
    const text = await res.text();
    // Phase 2 — parse the body BEFORE deciding success. A 2xx with an errorKey
    // in the body is a decline, not success (this is the class of bug the
    // 2026-07-30 incident exposed). Log with the CLASSIFIED success value so
    // appstle_api_calls doesn't record a lie either.
    const classification = classifyReplaceVariantsBody(res.status, text);
    const trulyOk = !classification.declined;
    await logAppstleCall({
      url, method: "POST", body, endpoint: "replace-variants-v3",
      status: res.status, responseBody: text, success: trulyOk,
      durationMs: Date.now() - t0,
    });
    if (!trulyOk) {
      // A permanent per-contract failure (today: `maxiterations`) must not be
      // buried in a batch summary. The `permanent` flag on the return lets the
      // caller surface it for human repair instead of retrying into the same
      // upstream wall. Two subscriptions silently shipping the wrong flavour
      // is exactly the outcome this classification exists to prevent.
      console.error(
        "Appstle replaceVariants declined:",
        JSON.stringify({ status: res.status, classification, body }),
      );
      return {
        success: false,
        error: classification.reason || `Appstle ${res.status}: declined`,
        permanent: classification.permanent,
        declineErrorKey: classification.errorKey,
      };
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
    // ⭐ TENANT SCOPE (security). Both the read AND the write MUST filter on `workspace_id`.
    // `shopify_contract_id` is NOT globally unique — it is an identifier minted by an external system,
    // and two workspaces can legitimately hold rows carrying the same value (a shared/duplicated
    // storefront, a re-imported contract, a test tenant seeded from prod data). Filtering on it alone
    // meant this read could load ANOTHER tenant's items and the update could OVERWRITE another
    // tenant's `items` array with them — a cross-tenant write, from a path an AI agent reaches on an
    // ordinary swap/add/remove. `workspaceId` was already a parameter and used on the very next line
    // (`enrichItemTitles`), so the scope was available and simply not applied.
    //
    // Found by the pre-merge security review of `swap-variant-self-heal-…` (2026-08-10) and then LOST:
    // the finding was routed into a standalone fix spec (`scope-subscription-item-sync-by-workspace`)
    // by the retired fix-spec model, and that spec was deferred as a model artifact — which discarded
    // the finding with it. Re-verified present on main 2026-08-11 and fixed here.
    const { data: sub } = await admin.from("subscriptions")
      .select("items")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle(); // maybeSingle: a miss is a normal no-op here, not an exception
    if (!sub) {
      console.warn(
        `[subscription-items] syncItemsAfterMutation: no subscription for contract ${contractId} in workspace ${workspaceId} — skipping sync`,
      );
      return;
    }
    const currentItems = (sub.items as Record<string, unknown>[] | null) || [];
    const mutatedItems = mutate(currentItems);
    // Enrich with titles from our product catalog
    const updatedItems = await enrichItemTitles(workspaceId, mutatedItems);
    await admin.from("subscriptions")
      .update({ items: updatedItems, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
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
): Promise<{ success: boolean; error?: string; permanent?: boolean; declineErrorKey?: string }> {
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
  if (!result.success) return result;

  // Phase 1 — a 200 from callReplaceVariants is not proof the add happened. Re-read the live
  // contract and refuse to report success unless the variant is actually present. syncItems only
  // fires on verified success — writing the intended state on an unverified mutation is what
  // makes the lie durable.
  const verdict = await verifyContractEndState(config.apiKey, contractId, {
    kind: "add",
    variantId,
    quantity,
  });
  if (!verdict.ok) {
    return { success: false, error: `add did not apply on contract ${contractId}: ${verdict.reason}` };
  }

  await syncItemsAfterMutation(workspaceId, contractId, (items) => [
    ...items,
    { variant_id: variantId, quantity, title: "", variant_title: "", price_cents: 0, product_id: "" },
  ]);

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
    .from("subscriptions").select("id, customer_id").eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
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
  const { data: pv } = await admin.from("product_variants").select("product_id").eq("workspace_id", workspaceId).eq("shopify_variant_id", shopifyVariantId).maybeSingle();
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
): Promise<{ success: boolean; error?: string; permanent?: boolean; declineErrorKey?: string }> {
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
  if (!result.success) return result;

  // Phase 1 — verify the quantity change actually landed on the live contract. Same class of bug
  // as the 2026-07-30 swap incident: callReplaceVariants returns success on a 2xx even when
  // Appstle silently declines to apply. Sync only on verified success.
  const verdict = await verifyContractEndState(config.apiKey, contractId, {
    kind: "add",
    variantId: resolvedId,
    quantity,
  });
  if (!verdict.ok) {
    return { success: false, error: `quantity change did not apply on contract ${contractId}: ${verdict.reason}` };
  }

  await syncItemsAfterMutation(workspaceId, contractId, (items) =>
    items.map((item) =>
      String(item.variant_id) === resolvedId ? { ...item, quantity } : item,
    ),
  );

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
      .eq("workspace_id", workspaceId)
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

    // Phase 1 — a 200 from update-line-item-price is not proof the base moved. Re-read the live
    // contract and refuse to report success unless the line's pricingPolicy.basePrice matches
    // what we asked for. Only mirror our own DB on verified success — writing the intended
    // discounted_cents on an unverified update would make the price lie durable.
    const verdict = await verifyContractEndState(config.apiKey, contractId, {
      kind: "price",
      variantId: String(variantId),
      expectedBaseCents: basePriceCents,
    });
    if (!verdict.ok) {
      return {
        success: false,
        error: `price update did not apply on contract ${contractId}: ${verdict.reason}`,
      };
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
    }).eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId);

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

  // Resolve the sub's status BEFORE the internal/Appstle branch — a coupon is
  // only ever valid on an active sub. Refusing here closes the SC135320 class
  // (a $15 loyalty coupon applied to a PAUSED sub after a redeem+refund combo
  // silently discounted a renewal the customer never earned).
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("customer_id, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!couponApplicableToSubStatus(sub?.status as string | null | undefined)) {
    return { success: false, error: "subscription_not_active" };
  }

  if (await isInternalSubscription(workspaceId, contractId)) {
    // LOYALTY-* codes must be internal-native on internal subs so
    // renewal-time `resolveCoupon` step 1 (internal wins) can durably
    // re-resolve them — independent of the Shopify discount lifetime, which
    // is what `redeem_points` mints but which a delete/expiry in Shopify
    // silently zeroes on the internal renewal (ticket 46a7aa75; spec:
    // loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value).
    // Materialize the `loyalty_redemptions` row as an internal `coupons` row
    // scoped to the contract owner — NET-ZERO on points (points already
    // spent at redeem time; `ensureInternalLoyaltyCouponRow` never calls
    // spendPoints). Rails preserved: single-use + one loyalty coupon per
    // renewal ceiling.
    if (/^LOYALTY-/i.test(code) && sub?.customer_id) {
      await ensureInternalLoyaltyCouponRow(
        workspaceId,
        code,
        sub.customer_id as string,
      );
    }
    const resolved = await resolveCoupon(workspaceId, code, sub?.customer_id as string | null);
    if (!resolved) return { success: false, error: "coupon_not_found" };
    // Hand `internalSubApplyDiscount` the FULL resolved coupon so it writes
    // a self-sufficient applied_discounts entry (type + value + source), and
    // pass the contract owner so the post-write real-value verify uses the
    // same customerId `resolveRenewalDiscount` will pass at renewal.
    return internalSubApplyDiscount(workspaceId, contractId, resolved.code, {
      resolved: {
        code: resolved.code,
        type: resolved.type,
        value: resolved.value,
        recurring_cycle_limit: resolved.recurring_cycle_limit,
        source: resolved.source,
      },
      customerId: sub?.customer_id as string | null,
    });
  }

  await healOnTouch(workspaceId, contractId);
  const config = await getAppstleConfig(workspaceId);
  if (!config) return { success: false, error: "Appstle not configured" };
  const r = await applyDiscountWithReplace(workspaceId, config.apiKey, contractId, code);
  return { success: r.success, error: r.error };
}

/**
 * Remove a coupon from a subscription — internal-aware dispatcher.
 *
 * Internal subs: delegate to internalSubRemoveDiscount, which filters
 * subscriptions.applied_discounts case-insensitively across every stored
 * shape (bare string · `{title}` · `{code}` · `{id}`) — a coupon rewritten
 * as `{code}` by internal_subscription_renewal has to remove too, or the
 * remover silently no-ops on any sub that has billed once. Returns
 * `{success:false, error:'coupon_not_found'}` when the filter dropped
 * nothing so the caller does not report a false success.
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
  const r = await removeExistingDiscounts(workspaceId, config.apiKey, contractId);
  return { success: !r.error, error: r.error };
}

/**
 * Swap one variant for another (e.g., change flavor or swap product).
 *
 * Price preservation (2026-07-30 crisis → docs/brain/specs/swap-variant-preserves-the-line-price.md):
 * Appstle's variant replacement drops the outgoing line and creates a fresh one at catalog,
 * silently resetting any grandfathered lock. So we (a) read the outgoing line's realized per-unit
 * price BEFORE the replace, (b) refuse the swap if we can't read it (a swap we can't price is a
 * swap that must not happen unattended — a silent reset already refunded $245.40), and (c)
 * re-apply that captured realized price to the new line via subUpdateLineItemPrice. A swap can
 * LOWER a price (a cheaper variant) but can never RAISE it — if the captured realized would
 * exceed the new variant's catalog MSRP, we leave the cheaper new price in place.
 */
export async function subSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string; newLineGid?: string; permanent?: boolean; declineErrorKey?: string; priceGuardRefusal?: PriceGuardRefusal }> {
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

  // Already-landed short-circuit (spec: [[swap-variant-self-heal-must-not-refire-an-already-landed-swap]]).
  // The self-heal loop retries subSwapVariant when the first attempt didn't verify in the DB. If the
  // first swap DID succeed (target variant present on the LIVE contract, old absent), re-invoking
  // replace-variants would fire against an outgoing line that no longer exists —
  // captureOutgoingRealizedCents below correctly refuses with "Cannot read outgoing line price",
  // which reads to the customer as a scary price-reset danger even though the swap already landed.
  // Ticket 46a77d60 (Christine, 2026-08-05): crisis auto-swap-back to Mixed Berry succeeded on
  // contract 33827422381; the retry re-called subSwapVariant against the removed Peach Mango line
  // and surfaced "I ran into a small issue" to a customer who'd threatened non-payment.
  //
  // Only genuine variant-to-variant swaps (old !== new) can hit this class — a self-swap
  // (change_quantity) never loses its outgoing line because the line IS the target.
  if (String(resolvedOld) !== String(newVariantId)) {
    const preInvokeIdentity = await verifyContractEndState(
      config.apiKey,
      contractId,
      identityExpectationForSwap(String(resolvedOld), String(newVariantId), quantity),
      { attempts: 1, delayMs: 0 },
    );
    if (preInvokeIdentity.ok) {
      // Sync the DB mirror in case the first pass didn't reach syncItemsAfterMutation. Idempotent
      // — a no-op when the mirror already reflects the post-swap state. We deliberately do NOT
      // re-apply capturedUnitCents here: the first invocation's price-preservation branch already
      // ran on the live line, and re-invoking subUpdateLineItemPrice on a preserved line would
      // reset it to the current post-swap realized rather than the grandfathered base.
      await syncItemsAfterMutation(workspaceId, contractId, (items) =>
        items.map((item) =>
          String(item.variant_id) === String(resolvedOld)
            ? { ...item, variant_id: String(newVariantId), quantity }
            : item,
        ),
      );
      return { success: true };
    }
  }

  // Capture the outgoing line's realized per-unit price BEFORE the replace.
  // Prefer pricingPolicy.basePrice-derived realized (isolates the real base from any stacked
  // one-off discount); fall back to currentPrice.amount when policy is null.
  const captured = await captureOutgoingRealizedCents(config.apiKey, contractId, resolvedOld, workspaceId);
  const capturedUnitCents = captured.realizedCents;
  if (capturedUnitCents <= 0) {
    return {
      success: false,
      error: `Cannot read outgoing line price for contract ${contractId} (variant ${resolvedOld}) — swap refused to prevent a silent price reset`,
    };
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
    // Phase 1 — verify IDENTITY before anything else fires: the new variant is present AND the
    // old is absent on the LIVE contract. This is the exact defect the 2026-07-30 crisis exposed
    // (contracts 27946909869 + 27871477933 got success=true from callReplaceVariants; the flavour
    // never moved). The existing swap-price assertion downstream only catches a PRICE regression;
    // an identity no-op slips past it. syncItemsAfterMutation only runs on verified identity —
    // otherwise our own DB mirror durable-stores the lie.
    //
    // Self-swap = pure quantity change (`change_quantity` calls subSwapVariant(_, _, v, v, qty)).
    // The `swap` verdict asserts the OLD variant is absent, which can NEVER be true when old === new,
    // so a real success would always false-fail — skipping syncItemsAfterMutation AND the
    // capturedUnitCents re-apply below (that skip IS the grandfathered-price reset). See
    // identityExpectationForSwap: it returns `add` for a self-swap and keeps `swap` (new present
    // AND old absent) for a genuine variant-to-variant swap so the 2026-07-30 partial-apply still
    // fails loudly.
    const identityVerdict = await verifyContractEndState(
      config.apiKey,
      contractId,
      identityExpectationForSwap(String(resolvedOld), String(newVariantId), quantity),
    );
    if (!identityVerdict.ok) {
      return {
        success: false,
        error: `swap did not apply on contract ${contractId}: ${identityVerdict.reason}`,
      };
    }

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

    // Re-apply `capturedUnitCents`. Convert realized → base via (1 − sns) so the S&S cycle on the
    // new line lands back on the captured unit price. Passing the realized cents directly would
    // double-discount it — that exact mistake set 5 subscriptions 25% low during the 2026-07-30
    // cleanup.
    const admin = createAdminClient();
    const { data: newPv } = await admin
      .from("product_variants")
      .select("product_id, price_cents")
      .eq("workspace_id", workspaceId)
      .eq("shopify_variant_id", String(newVariantId))
      .maybeSingle();
    const newProductId = (newPv?.product_id as string | undefined) || null;
    const newVariantMsrpCents = (newPv?.price_cents as number | undefined) || 0;
    const snsPct = await resolveLineSnsPct(admin, workspaceId, newProductId);
    const frac = 1 - snsPct / 100;
    const basePriceCents = frac > 0 ? Math.round(capturedUnitCents / frac) : capturedUnitCents;

    // Never raise: if preserving would push the base above the new variant's own catalog MSRP,
    // leave the cheaper new price in place — a swap can lower a price but never raise it.
    const wouldRaise = newVariantMsrpCents > 0 && basePriceCents > newVariantMsrpCents;
    if (!wouldRaise) {
      const priceRes = await subUpdateLineItemPrice(
        workspaceId,
        contractId,
        String(newVariantId),
        basePriceCents,
        newLineGid,
      );
      if (!priceRes.success) {
        // Preservation failed after a successful replace — surface it, don't silently succeed.
        return {
          success: false,
          error: `Swap replaced on contract ${contractId} but price preservation failed: ${priceRes.error || "unknown"}`,
          newLineGid,
        };
      }
    }

    // Assert it — re-read the new line's realized from Appstle and fail loudly if the post-swap
    // realized moved ABOVE the rules-derived expectation. callReplaceVariants +
    // subUpdateLineItemPrice both already returned success on any 2xx without reading the body,
    // so this is the only gate that catches a silent regression in the preservation math on a
    // live contract.
    const observedRealizedCents = await readNewLineRealizedCents(
      config.apiKey,
      contractId,
      String(newVariantId),
    );
    if (observedRealizedCents <= 0) {
      return {
        success: false,
        error: `Swap on contract ${contractId} succeeded but post-swap realized price could not be verified — refusing to report success on an unverified swap`,
        newLineGid,
      };
    }

    // Compute the rules-derived expected per-unit price for the new variant AT THE NEW QUANTITY
    // via the same engine that will bill it (resolveSubscriptionPricing wraps priceSubscription).
    // The DB mirror was updated to the post-swap items by syncItemsAfterMutation above, so this
    // reflects what the customer is actually asking for — not what they had. Comparing observed
    // against this expectation lets a legitimate quantity-driven per-unit increase (buy-two break
    // forfeited when qty drops from 2 → 1) pass, while a silent catalog reset still fails loudly.
    const expectedRealizedCents = await readRulesExpectedForNewLineCents(
      workspaceId,
      contractId,
      String(newVariantId),
    );
    if (expectedRealizedCents <= 0) {
      return {
        success: false,
        error: `Swap on contract ${contractId} succeeded but rules-derived expected price could not be computed — refusing to report success on an unverified swap`,
        newLineGid,
      };
    }
    const raiseErr = assertSwapDidNotRaise({
      expectedRealizedCents,
      observedRealizedCents,
      quantity,
      contractId,
    });
    if (raiseErr) {
      // The message MUST contain the literal phrase `swap changed the price` so downstream logs +
      // the deterministic verifier can grep the failure state; assertSwapDidNotRaise stays a pure
      // predicate, so we wrap its message here at the caller boundary.
      // Also emit the distinct PriceGuardRefusal class — a guard refusal is US deliberately
      // declining, NOT an Appstle vendor error, so the portal surface can classify it correctly
      // instead of dressing it up as an appstle_error 502.
      const priceGuardRefusal: PriceGuardRefusal = {
        contractId,
        expectedRealizedCents,
        observedRealizedCents,
        quantity,
        reason: "swap_raises_over_rules",
      };
      return {
        success: false,
        error: `swap changed the price — ${raiseErr}`,
        newLineGid,
        priceGuardRefusal,
      };
    }
  }

  return { ...result, newLineGid };
}

/**
 * Compute the rules-derived expected per-unit price for the new line via the same pricing engine
 * that will bill it (`resolveSubscriptionPricing`). Reads the DB mirror of the subscription's
 * items — `subSwapVariant` calls `syncItemsAfterMutation` before this, so the mirror reflects the
 * post-swap variant + quantity the customer actually asked for. Returns 0 on any failure (sub
 * missing, engine couldn't price the line) so the caller refuses to report success rather than
 * asserting against a bogus expectation.
 */
async function readRulesExpectedForNewLineCents(
  workspaceId: string,
  contractId: string,
  newVariantId: string,
): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("items, delivery_price_cents, pricing_offer_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (!sub) return 0;
    const pricing = await resolveSubscriptionPricing(workspaceId, {
      items: sub.items as unknown[],
      delivery_price_cents: (sub.delivery_price_cents as number | null | undefined) ?? null,
      pricing_offer_id: (sub.pricing_offer_id as string | null | undefined) ?? null,
    });
    // PricedLine.variant_id preserves the shape stored on the item — Appstle-rail
    // syncItemsAfterMutation writes the numeric Shopify variant id, so the line's variant_id
    // matches `newVariantId` directly.
    const line = pricing.lines.find((l) => String(l.variant_id) === String(newVariantId));
    return line?.unit_cents ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Re-read the NEW line's realized per-unit price from a live Appstle contract. Returns 0 when
 * the read fails (network error, non-2xx, line missing, unparseable amount) — the caller MUST
 * treat 0 as an unverified swap and refuse to report success, per Phase 3 of
 * docs/brain/specs/swap-variant-preserves-the-line-price.md.
 */
async function readNewLineRealizedCents(
  apiKey: string,
  contractId: string,
  newVariantId: string,
): Promise<number> {
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
      { headers: { "X-API-Key": apiKey }, cache: "no-store" },
    );
    if (!res.ok) return 0;
    const detail = await res.json();
    const lines = (detail?.lines?.nodes || []) as AppstleLine[];
    const match = lines.find(l => {
      const vid = l.variantId?.split("/").pop() || l.variantId;
      return String(vid) === String(newVariantId);
    });
    const amt = match?.currentPrice?.amount;
    if (!amt) return 0;
    return Math.round(parseFloat(amt) * 100);
  } catch {
    return 0;
  }
}

/**
 * Read the outgoing line's realized per-unit price BEFORE a swap, so we can carry it forward.
 *
 * Prefers `pricingPolicy.basePrice * (1 − sns)` when the line has a structured policy — that
 * isolates the true base from any stacked one-off discount baked into currentPrice. Falls back to
 * `currentPrice.amount` when the policy is null (a legacy Appstle-migrated line). Returns
 * `{ realizedCents: 0 }` on any read failure — the caller MUST refuse the swap in that case.
 */
async function captureOutgoingRealizedCents(
  apiKey: string,
  contractId: string,
  resolvedOldVariantId: string,
  workspaceId: string,
): Promise<{ realizedCents: number; basePriceCents: number }> {
  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
      { headers: { "X-API-Key": apiKey }, cache: "no-store" },
    );
    if (!res.ok) return { realizedCents: 0, basePriceCents: 0 };
    const detail = await res.json();
    const lines = (detail?.lines?.nodes || []) as AppstleLine[];
    const outgoing = lines.find(l => {
      const vid = l.variantId?.split("/").pop() || l.variantId;
      return String(vid) === String(resolvedOldVariantId);
    });
    if (!outgoing) return { realizedCents: 0, basePriceCents: 0 };

    const currentAmt = outgoing.currentPrice?.amount;
    const realizedCents = currentAmt ? Math.round(parseFloat(currentAmt) * 100) : 0;

    const basePriceAmt = outgoing.pricingPolicy?.basePrice?.amount;
    const basePriceCents = basePriceAmt ? Math.round(parseFloat(basePriceAmt) * 100) : 0;

    // If we have basePrice, use it as the canonical base (isolates from any stacked discount).
    // Return the base's implied realized (`base * (1 − sns)`) so the caller preserves the true
    // structural price, not a coupon-inflated one.
    if (basePriceCents > 0) {
      const admin = createAdminClient();
      const { data: oldPv } = await admin
        .from("product_variants")
        .select("product_id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_variant_id", String(resolvedOldVariantId))
        .maybeSingle();
      const oldProductId = (oldPv?.product_id as string | undefined) || null;
      const snsPct = await resolveLineSnsPct(admin, workspaceId, oldProductId);
      const derivedRealized = Math.round(basePriceCents * (1 - snsPct / 100));
      return { realizedCents: derivedRealized, basePriceCents };
    }

    return { realizedCents, basePriceCents: 0 };
  } catch {
    return { realizedCents: 0, basePriceCents: 0 };
  }
}
