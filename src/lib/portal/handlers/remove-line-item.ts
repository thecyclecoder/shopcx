import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { subRemoveItem } from "@/lib/subscription-items";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Portal route: remove a single line item from a subscription.
 *
 * Hits Appstle's dedicated /subscription-contracts-remove-line-item endpoint
 * (separate from replace-variants). Caller must pass either:
 *   - lineId: full Shopify GID or raw uuid (preferred — no contract fetch needed)
 *   - variantId: variant id; we'll look up the line on the contract
 *
 * Guardrails (Appstle enforces too, but we check up front for better errors):
 *   - At least one recurring item must remain on the contract after removal.
 */
export const removeLineItem: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const lineId = typeof payload?.lineId === "string" ? payload.lineId : null;
  const variantId = payload?.variantId != null ? String(payload.variantId) : null;
  if (!lineId && !variantId) return jsonErr({ error: "missing_lineId_or_variantId" }, 400);

  const admin = createAdminClient();
  const resolved = await resolveSub(admin, auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  if (!resolved?.shopify_contract_id) return jsonErr({ error: "missing_contractId" }, 400);
  const contractId = resolved.shopify_contract_id;

  // Pre-check: at least one *real* (non-shipping-protection) item must remain
  // AFTER this removal — so we don't strand the customer with an empty contract.
  // Removing the shipping-protection add-on itself is always allowed as long as a
  // real product stays; it isn't a real item, so the old "≤1 real item" check
  // wrongly blocked toggling it off on a single-product sub.
  const isShipProt = (i: { title?: string }) => (i.title || "").toLowerCase().includes("shipping protection");
  const items = (resolved.items as { variant_id?: string; line_id?: string; title?: string }[]) || [];
  const rawLineId = lineId && lineId.includes("/") ? lineId.split("/").pop() : lineId;
  // For internal subs the portal sends the line's `id` (= variant_id) as lineId,
  // so match it against variant_id too — not just line_id (Appstle).
  const target = items.find(i =>
    (lineId && (i.line_id === lineId || i.line_id === rawLineId || String(i.variant_id) === lineId || String(i.variant_id) === rawLineId)) ||
    (variantId && String(i.variant_id) === variantId),
  );
  const removingRealItem = target ? !isShipProt(target) : true; // unknown target → conservative
  const realItemsAfter = items.filter(i => !isShipProt(i) && i !== target).length;
  if (removingRealItem && realItemsAfter < 1) {
    return jsonErr({ error: "would_remove_last_item", detail: "At least one recurring item must remain on the subscription. Cancel the subscription instead." }, 400);
  }

  // Execute removal. Internal subs remove by variantId (internalSubRemoveItem
  // keys on it — passing only a lineGid would fall through to the Appstle path,
  // which has no contract for a migrated sub). Appstle subs prefer the precise
  // lineGid — but ONLY when the sent lineId is a *real* Appstle SubscriptionLine
  // id. transform-subscription sets a line's portal `id` to `line_id || variant_id`,
  // so an Appstle line that surfaced without a real line_id arrives here with
  // id === variant_id; trusting that as a lineGid makes Appstle 400 with
  // "Couldn't find LineId=gid://shopify/SubscriptionLine/<variantId>" (unrecoverable).
  // When lineId doesn't match a real line_id on the resolved items, fall back to
  // variantId resolution — appstleRemoveLineItem re-fetches the live contract and
  // matches by variant id (src/lib/subscription-items.ts).
  const effectiveVariantId = variantId || (target?.variant_id ? String(target.variant_id) : null);
  if (resolved.is_internal && !effectiveVariantId) {
    return jsonErr({ error: "missing_variantId_for_internal_remove" }, 400);
  }
  const isRealLineGid = !!lineId && items.some(i =>
    i.line_id && (String(i.line_id) === lineId || String(i.line_id) === rawLineId),
  );
  let removeArg: { variantId: string } | { lineGid: string };
  if (resolved.is_internal) {
    removeArg = { variantId: effectiveVariantId! };
  } else if (isRealLineGid) {
    removeArg = { lineGid: lineId! };
  } else if (effectiveVariantId) {
    removeArg = { variantId: effectiveVariantId };
  } else {
    // No real Appstle line id and no variant to resolve against — nothing to target.
    return jsonErr({ error: "missing_variantId_for_remove" }, 400);
  }

  let result: { success: boolean; error?: string; alreadyAbsent?: boolean };
  try {
    result = await subRemoveItem(auth.workspaceId, contractId, removeArg);
  } catch (e) {
    return handleAppstleError(e, { route: "removeLineItem", payload });
  }

  if (!result.success) {
    // Appstle's live last-item guardrail (surfaced as would_remove_last_item by
    // appstleRemoveLineItem when our local pre-check passed on a stale-high
    // snapshot) is a benign, user-generated outcome — return the same friendly
    // 400 the pre-check above does, not an opaque 502.
    if (result.error === "would_remove_last_item") {
      return jsonErr({ error: "would_remove_last_item", detail: "At least one recurring item must remain on the subscription. Cancel the subscription instead." }, 400);
    }
    return handleAppstleError(
      Object.assign(new Error(result.error || "Remove failed"), { details: "" }),
      { route: "removeLineItem", payload },
    );
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.items.removed",
      summary: result.alreadyAbsent
        ? "Customer removed an item already absent from the subscription (idempotent)"
        : "Customer removed item from subscription via portal",
      properties: { shopify_contract_id: contractId, line_id: lineId, variant_id: variantId, already_absent: !!result.alreadyAbsent },
      createNote: true,
    });
  }

  return jsonOk({ ok: true, route, contractId, alreadyRemoved: !!result.alreadyAbsent });
};
