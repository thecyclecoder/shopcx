// UPGRADED: Cancel now triggers cancel journey instead of hard cancel.
// Only falls through to hard cancel if journey is completed with cancellation outcome.

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export const cancel: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Look up subscription
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, items, customer_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();

  if (!sub) return jsonErr({ error: "subscription_not_found" }, 404);

  // Check if there's an active cancel journey definition
  const { data: journeyDef } = await admin.from("journey_definitions")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("trigger_intent", "cancel")
    .eq("is_active", true)
    .limit(1)
    .single();

  if (journeyDef) {
    // Create a journey session for the portal cancel flow
    const token = crypto.randomUUID();
    const { data: session } = await admin.from("journey_sessions").insert({
      workspace_id: auth.workspaceId,
      journey_definition_id: journeyDef.id,
      customer_id: customer.id,
      token,
      channel: "portal",
      status: "in_progress",
      config_snapshot: {
        contractId: String(contractId),
        subscriptionId: sub.id,
        source: "portal",
      },
      responses: {},
    }).select("id, token").single();

    // Log that cancel journey was triggered
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.cancel_started",
      summary: "Customer initiated cancel via portal — cancel journey triggered",
      properties: { shopify_contract_id: String(contractId), journey_session_id: session?.id },
      createNote: true,
    });

    return jsonOk({
      ok: true,
      route,
      contractId,
      journey: true,
      journeyToken: session?.token || token,
      journeySessionId: session?.id,
    });
  }

  // No cancel journey configured — fall back to hard cancel
  const { appstleSubscriptionAction } = await import("@/lib/appstle");
  const result = await appstleSubscriptionAction(
    auth.workspaceId, String(contractId), "cancel", "Customer cancelled via portal", "Portal"
  );

  if (!result.success) {
    return jsonErr({ error: "cancel_failed", message: result.error }, 500);
  }

  await logPortalAction({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    eventType: "portal.subscription.cancelled",
    summary: "Customer cancelled subscription via portal (no journey configured)",
    properties: { shopify_contract_id: String(contractId) },
    createNote: true,
  });

  return jsonOk({
    ok: true, route, contractId, journey: false,
    patch: { status: "CANCELLED", portalCancelledAt: new Date().toISOString() },
  });
};
