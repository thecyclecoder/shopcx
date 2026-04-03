import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

function mapCouponError(mode: string, status: number): string {
  if (mode === "apply") {
    if (status === 409) return "coupon_conflict";
    if (status === 404) return "coupon_not_found";
    if (status === 422) return "coupon_invalid_or_expired";
    if (status === 400) return "coupon_invalid_request";
    return "coupon_apply_failed";
  }
  if (status === 404) return "discount_not_found";
  if (status === 422) return "discount_not_removable";
  return "coupon_remove_failed";
}

export const coupon: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  const mode = s(payload?.mode);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (mode !== "apply" && mode !== "remove") return jsonErr({ error: "invalid_mode" }, 400);

  const discountCode = s(payload?.discountCode);
  const discountId = s(payload?.discountId);
  if (mode === "apply" && !discountCode) return jsonErr({ error: "missing_discountCode" }, 400);
  if (mode === "remove" && !discountId) return jsonErr({ error: "missing_discountId" }, 400);

  try {
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    if (mode === "apply") {
      // Remove existing discounts first, then apply new one (only 1 coupon per subscription)
      const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
      const result = await applyDiscountWithReplace(apiKey, String(contractId), discountCode);
      if (!result.success) {
        const isExpected = result.status && [400, 404, 409, 422].includes(result.status);
        if (isExpected) {
          return jsonOk({ ok: false, route, contractId, mode, error: mapCouponError(mode, result.status!) });
        }
        throw new Error(result.error || "Appstle API error");
      }
    } else {
      const res = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(discountId)}`,
        { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" },
      );
      if (!res.ok) {
        const isExpected = [400, 404, 422].includes(res.status);
        if (isExpected) return jsonOk({ ok: false, route, contractId, mode, error: mapCouponError(mode, res.status) });
        throw new Error(`Appstle API error: ${res.status}`);
      }
    }
  } catch (e) {
    if ((e as Error).message?.startsWith("Appstle")) return handleAppstleError(e);
    throw e;
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    const eventType = mode === "apply" ? "portal.coupon.applied" : "portal.coupon.removed";
    const summary = mode === "apply"
      ? `Customer applied coupon "${discountCode}" via portal`
      : "Customer removed coupon via portal";
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id, eventType, summary,
      properties: { shopify_contract_id: String(contractId), mode, discountCode, discountId },
      createNote: false,
    });
  }

  return jsonOk({ ok: true, route, contractId, mode, discountCode, discountId, patch: {} });
};
