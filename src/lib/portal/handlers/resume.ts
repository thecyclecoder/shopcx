import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

async function appstlePut(workspaceId: string, path: string) {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
  const apiKey = decrypt(ws.appstle_api_key_encrypted);
  const res = await fetch(`https://subscription-admin.appstle.com${path}`, {
    method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store",
  });
  if (!res.ok) throw new Error(`Appstle API error: ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const resume: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  try {
    // Resume in Appstle (sets status back to ACTIVE)
    await appstlePut(auth.workspaceId,
      `/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=ACTIVE`
    );
  } catch (e) {
    return handleAppstleError(e);
  }

  // Update our DB: clear pause, set active
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({
      status: "active",
      pause_resume_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId));

  // Log customer event
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.resumed",
      summary: `Subscription #${contractId} resumed early by customer`,
      properties: { shopify_contract_id: String(contractId) },
      createNote: false,
    });
  }

  // The Inngest auto-resume function will wake up later and no-op
  // since the subscription is already active

  return jsonOk({
    ok: true, route, contractId,
    patch: { status: "ACTIVE", pauseResumeAt: null },
  });
};
