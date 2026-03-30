// Cancel journey endpoints for portal — returns journey steps and processes responses

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

async function createChatTicket(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  customerId: string,
  contractId: string,
  reason: string,
): Promise<string | null> {
  const { data: ticket } = await admin.from("tickets").insert({
    workspace_id: workspaceId,
    customer_id: customerId,
    subject: `Cancel chat: ${reason}`,
    status: "open",
    channel: "portal",
    tags: ["cancel:ai_chat"],
    journey_id: `cancel_chat_${contractId}`,
  }).select("id").single();

  return ticket?.id || null;
}

async function logChatMessage(
  admin: ReturnType<typeof createAdminClient>,
  ticketId: string,
  direction: "in" | "out",
  authorType: "customer" | "ai",
  body: string,
) {
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction,
    visibility: "external",
    author_type: authorType,
    body,
  });
}

export const cancelJourney: RouteHandler = async ({ auth, route, req, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

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
    const reason = String(payload?.reason || "");
    const startChat = !!payload?.startChat;

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

    // For open-ended reasons, create a ticket for chat logging and start AI conversation
    if (startChat) {
      const ticketId = await createChatTicket(admin, auth.workspaceId, customer.id, contractId, reason);

      // Get initial AI response
      try {
        const { generateOpenEndedResponse } = await import("@/lib/remedy-selector");
        const reply = await generateOpenEndedResponse(
          auth.workspaceId, reason, "",
          [], { ltv_cents: 0, retention_score: 0, subscription_age_days: 0, total_orders: 0, products: [], first_renewal: false }, [],
        );

        if (ticketId && reply) {
          await logChatMessage(admin, ticketId, "out", "ai", reply);
        }

        return jsonOk({
          ok: true, step: "reason", reason, type: "ai_chat",
          reply, turn: 1, maxTurns: 3, ticketId,
        });
      } catch {
        return jsonOk({
          ok: true, step: "reason", reason, type: "ai_chat",
          reply: null, turn: 1, maxTurns: 3, ticketId,
        });
      }
    }

    return jsonOk({ ok: true, step: "reason", reason });
  }

  if (step === "chat") {
    const message = String(payload?.message || "");
    const reason = String(payload?.reason || "");
    const turn = Number(payload?.turn) || 0;
    let ticketId = payload?.ticketId ? String(payload.ticketId) : null;

    // Create ticket if we don't have one yet
    if (!ticketId) {
      ticketId = await createChatTicket(admin, auth.workspaceId, customer.id, contractId, reason);
    }

    // Log customer message
    if (ticketId && message) {
      await logChatMessage(admin, ticketId, "in", "customer", message);
    }

    // Get AI response
    try {
      const { generateOpenEndedResponse } = await import("@/lib/remedy-selector");
      const reply = await generateOpenEndedResponse(
        auth.workspaceId, reason, message,
        [], { ltv_cents: 0, retention_score: 0, subscription_age_days: 0, total_orders: 0, products: [], first_renewal: false }, [],
      );

      // Log AI response
      if (ticketId && reply) {
        await logChatMessage(admin, ticketId, "out", "ai", reply);
      }

      return jsonOk({
        ok: true, step: "chat",
        reply: reply || "I understand. Would you like to keep your subscription?",
        turn: turn + 1,
        ticketId,
      });
    } catch {
      return jsonOk({
        ok: true, step: "chat",
        reply: "I understand. Would you like to keep your subscription?",
        turn: turn + 1,
        ticketId,
      });
    }
  }

  if (step === "remedy") {
    const remedyId = String(payload?.remedyId || "");
    const accepted = !!payload?.accepted;

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
    const reason = String(payload?.reason || "Customer cancelled via portal");
    const ticketId = payload?.ticketId ? String(payload.ticketId) : null;

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

    // Close the chat ticket if one was created
    if (ticketId) {
      await admin.from("tickets")
        .update({ status: "closed" })
        .eq("id", ticketId);
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
