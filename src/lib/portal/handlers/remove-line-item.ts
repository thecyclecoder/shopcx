import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
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

  const contractId = payload?.contractId != null ? String(payload.contractId) : "";
  const lineId = typeof payload?.lineId === "string" ? payload.lineId : null;
  const variantId = payload?.variantId != null ? String(payload.variantId) : null;

  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (!lineId && !variantId) return jsonErr({ error: "missing_lineId_or_variantId" }, 400);

  // Pre-check: subscription must have >1 real item so we don't strand the customer with an empty contract
  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("items").eq("workspace_id", auth.workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
  const items = (sub?.items as { variant_id?: string; line_id?: string; title?: string }[]) || [];
  const realItems = items.filter(i => !(i.title || "").toLowerCase().includes("shipping protection"));
  if (realItems.length <= 1) {
    return jsonErr({ error: "would_remove_last_item", detail: "At least one recurring item must remain on the subscription. Cancel the subscription instead." }, 400);
  }

  // Execute removal
  let result: { success: boolean; error?: string };
  try {
    result = await subRemoveItem(auth.workspaceId, contractId, lineId ? { lineGid: lineId } : { variantId: variantId! });
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
