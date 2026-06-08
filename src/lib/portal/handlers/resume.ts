import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleSubscriptionAction } from "@/lib/appstle";

export const resume: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Route through the internal-aware wrapper (handles is_internal vs Appstle).
  const resumeResult = await appstleSubscriptionAction(auth.workspaceId, String(contractId), "resume");
  if (!resumeResult.success) return handleAppstleError(new Error(resumeResult.error || "Resume failed"));

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
