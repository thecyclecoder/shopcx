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
  // lineGid. Fall back to the matched line's variant_id when the client omitted it.
  const internalVariantId = variantId || (target?.variant_id ? String(target.variant_id) : null);
  if (resolved.is_internal && !internalVariantId) {
    return jsonErr({ error: "missing_variantId_for_internal_remove" }, 400);
  }
  const removeArg = resolved.is_internal
    ? { variantId: internalVariantId! }
    : lineId ? { lineGid: lineId } : { variantId: variantId! };

  let result: { success: boolean; error?: string };
  try {
    result = await subRemoveItem(auth.workspaceId, contractId, removeArg);
  } catch (e) {
    return handleAppstleError(e, { route: "removeLineItem", payload });
  }

  if (!result.success) {
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
      summary: "Customer removed item from subscription via portal",
      properties: { shopify_contract_id: contractId, line_id: lineId, variant_id: variantId },
      createNote: true,
    });
  }

  return jsonOk({ ok: true, route, contractId });
};
