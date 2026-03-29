// Cancel journey endpoints for portal — returns journey steps and processes responses

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const cancelJourney: RouteHandler = async ({ auth, route, req, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const contractId = url.searchParams.get("contractId") || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  if (req.method === "GET") {
    // Return cancel journey steps for this subscription
    const { data: sub } = await admin.from("subscriptions")
      .select("id, shopify_contract_id, items, billing_interval, billing_interval_count, next_billing_date, created_at")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_contract_id", contractId)
      .single();

    if (!sub) return jsonErr({ error: "subscription_not_found" }, 404);

    // Load remedies
    const { data: remedies } = await admin.from("remedies")
      .select("id, type, label, description, config, success_rate")
      .eq("workspace_id", auth.workspaceId)
      .eq("is_active", true)
      .order("success_rate", { ascending: false });

    // Load reviews for subscription products
    const productIds = (sub.items as { product_id?: string }[] || [])
      .map(i => i.product_id).filter(Boolean) as string[];

    let reviews: unknown[] = [];
    if (productIds.length) {
      const { data: revs } = await admin.from("product_reviews")
        .select("shopify_product_id, author, rating, title, body, summary, smart_featured")
        .eq("workspace_id", auth.workspaceId)
        .in("shopify_product_id", productIds)
        .gte("rating", 4)
        .eq("smart_featured", true)
        .limit(6);
      reviews = revs || [];
    }

    return jsonOk({
      ok: true, route,
      subscription: sub,
      cancel_reasons: [
        { id: "too_expensive", label: "Too expensive" },
        { id: "too_much_product", label: "I have too much product" },
        { id: "not_seeing_results", label: "Not seeing results" },
        { id: "reached_goals", label: "I've reached my goals" },
        { id: "just_need_a_break", label: "Just need a break" },
        { id: "something_else", label: "Something else" },
      ],
      remedies: remedies || [],
      reviews,
    });
  }

  // POST: Process cancel journey response
  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const step = String(payload?.step || "");
  const journeySessionId = String(payload?.journeySessionId || "");

  if (step === "reason") {
    // Log the selected reason
    const reason = String(payload?.reason || "");
    if (journeySessionId) {
      await admin.from("journey_sessions")
        .update({ responses: { reason }, updated_at: new Date().toISOString() })
        .eq("id", journeySessionId);
    }

    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.cancel_reason",
      summary: `Cancel reason selected: ${reason}`,
      properties: { shopify_contract_id: contractId, reason },
    });

    return jsonOk({ ok: true, step: "reason", reason });
  }

  if (step === "remedy") {
    // Customer accepted or declined a remedy
    const remedyId = String(payload?.remedyId || "");
    const accepted = !!payload?.accepted;

    // Log remedy outcome
    await admin.from("remedy_outcomes").insert({
      workspace_id: auth.workspaceId,
      customer_id: customer.id,
      remedy_id: remedyId || null,
      shopify_contract_id: contractId,
      cancel_reason: String(payload?.reason || ""),
      outcome: accepted ? "accepted" : "declined",
      source: "portal",
    });

    if (accepted) {
      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.subscription.saved",
        summary: `Customer saved by remedy via portal`,
        properties: { shopify_contract_id: contractId, remedyId },
        createNote: true,
      });
    }

    return jsonOk({ ok: true, step: "remedy", accepted, remedyId });
  }

  if (step === "confirm_cancel") {
    // Customer confirmed final cancellation after going through journey
    const reason = String(payload?.reason || "Customer cancelled via portal");

    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    const result = await appstleSubscriptionAction(
      auth.workspaceId, contractId, "cancel", reason, "Portal"
    );

    if (!result.success) {
      return jsonErr({ error: "cancel_failed", message: result.error }, 500);
    }

    // Complete journey session
    if (journeySessionId) {
      await admin.from("journey_sessions")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", journeySessionId);
    }

    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.cancelled",
      summary: `Customer cancelled subscription via portal after journey`,
      properties: { shopify_contract_id: contractId, reason },
      createNote: true,
    });

    return jsonOk({
      ok: true, step: "confirm_cancel", contractId,
      patch: { status: "CANCELLED", portalCancelledAt: new Date().toISOString() },
    });
  }

  return jsonErr({ error: "invalid_step" }, 400);
};
