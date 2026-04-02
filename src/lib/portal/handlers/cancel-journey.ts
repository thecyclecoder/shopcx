// Cancel journey endpoints for portal — returns journey steps and processes responses

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

async function createChatTicket(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  customerId: string,
  contractId: string,
  reason: string,
): Promise<string | null> {
  const { data: ticket, error } = await admin.from("tickets").insert({
    workspace_id: workspaceId,
    customer_id: customerId,
    subject: `Cancel chat: ${reason}`,
    status: "open",
    channel: "portal",
    tags: ["cancel:ai_chat"],
  }).select("id").single();

  if (error) {
    console.error("Failed to create cancel chat ticket:", error.message, { workspaceId, customerId, contractId });
  }

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

// ── Remedy action execution ──

type RemedyConfig = Record<string, unknown>;

async function executeRemedyAction(
  workspaceId: string,
  contractId: string,
  remedyType: string,
  config: RemedyConfig,
): Promise<{ success: boolean; error?: string; patch?: Record<string, unknown>; savedAction?: string }> {
  const { appstleSubscriptionAction, appstleSkipNextOrder, appstleUpdateBillingInterval, appstleAddFreeProduct } =
    await import("@/lib/appstle");
  const admin = createAdminClient();

  switch (remedyType) {
    case "coupon": {
      const couponMappingId = config.coupon_mapping_id as string | undefined;
      if (!couponMappingId) return { success: false, error: "No coupon configured for this remedy" };

      const { data: mapping } = await admin.from("coupon_mappings")
        .select("code").eq("id", couponMappingId).single();
      if (!mapping?.code) return { success: false, error: "Coupon not found" };

      const { data: wsData } = await admin.from("workspaces")
        .select("appstle_api_key_encrypted").eq("id", workspaceId).single();
      if (!wsData?.appstle_api_key_encrypted) return { success: false, error: "Appstle not configured" };

      const { decrypt } = await import("@/lib/crypto");
      const apiKey = decrypt(wsData.appstle_api_key_encrypted);

      // Remove existing discounts first
      try {
        const rawRes = await fetch(
          `https://subscription-admin.appstle.com/api/external/v2/contract-raw-response?contractId=${contractId}&api_key=${apiKey}`,
          { headers: { "X-API-Key": apiKey } },
        );
        if (rawRes.ok) {
          const rawText = await rawRes.text();
          const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);
          if (nodesMatch && nodesMatch[1].trim()) {
            try {
              const nodes = JSON.parse(`[${nodesMatch[1]}]`);
              for (const node of nodes) {
                if (node.id) {
                  await fetch(
                    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(node.id)}&api_key=${apiKey}`,
                    { method: "PUT", headers: { "X-API-Key": apiKey } },
                  );
                }
              }
            } catch {}
          }
        }
      } catch {}

      // Apply new coupon
      await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${contractId}&discountCode=${mapping.code}&api_key=${apiKey}`,
        { method: "PUT", headers: { "X-API-Key": apiKey } },
      );

      return { success: true, savedAction: `saved with coupon ${mapping.code}`, patch: {} };
    }

    case "pause": {
      const pauseDays = Number(config.pause_days) || 30;
      const result = await appstleSubscriptionAction(workspaceId, contractId, "pause");
      if (!result.success) return { success: false, error: result.error };

      const resumeAt = new Date(Date.now() + pauseDays * 86400000).toISOString();

      // Update DB with resume date
      await admin.from("subscriptions")
        .update({ pause_resume_at: resumeAt, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);

      // Schedule auto-resume via Inngest
      await inngest.send({
        name: "portal/subscription-paused",
        data: { workspaceId, contractId, pauseDays, resumeAt },
      });

      return {
        success: true,
        savedAction: `paused your subscription for ${pauseDays} days`,
        patch: { status: "PAUSED", pauseResumeAt: resumeAt },
      };
    }

    case "skip": {
      const result = await appstleSkipNextOrder(workspaceId, contractId);
      if (!result.success) return { success: false, error: result.error };
      return { success: true, savedAction: "skipped your next order", patch: {} };
    }

    case "frequency_change": {
      const freqMap: Record<string, { interval: "MONTH"; count: number }> = {
        monthly: { interval: "MONTH", count: 1 },
        bimonthly: { interval: "MONTH", count: 2 },
        quarterly: { interval: "MONTH", count: 3 },
      };
      const freq = freqMap[config.frequency_interval as string] || { interval: "MONTH" as const, count: 2 };
      const result = await appstleUpdateBillingInterval(workspaceId, contractId, freq.interval, freq.count);
      if (!result.success) return { success: false, error: result.error };
      const label = config.frequency_interval === "monthly" ? "monthly" : config.frequency_interval === "bimonthly" ? "every 2 months" : "every 3 months";
      return { success: true, savedAction: `changed your delivery to ${label}`, patch: {} };
    }

    case "free_product": {
      const variantId = config.product_variant_id as string;
      if (!variantId) return { success: false, error: "No product configured for this remedy" };
      const result = await appstleAddFreeProduct(workspaceId, contractId, variantId, 1);
      if (!result.success) return { success: false, error: result.error };
      const title = (config.product_title as string) || "a free product";
      return { success: true, savedAction: `added ${title} free to your next order`, patch: {} };
    }

    case "line_item_modifier": {
      // Line item modifier is handled by the multi-step frontend flow
      // This just signals the frontend to open the inline flow
      return { success: true, savedAction: "", patch: {} };
    }

    default:
      return { success: false, error: `Unknown remedy type: ${remedyType}` };
  }
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
      .select("id, type, name, description, config")
      .eq("workspace_id", auth.workspaceId)
      .eq("enabled", true)
      .order("priority", { ascending: true });

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

    // Load cancel reasons from workspace portal_config
    const { data: ws } = await admin.from("workspaces")
      .select("portal_config")
      .eq("id", auth.workspaceId)
      .single();

    const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
    const cancelConfig = (portalConfig.cancel_flow || {}) as Record<string, unknown>;
    const configuredReasons = Array.isArray(cancelConfig.reasons) ? cancelConfig.reasons : [];

    const cancelReasons = configuredReasons.length > 0
      ? configuredReasons
          .filter((r: { enabled?: boolean }) => r.enabled !== false)
          .sort((a: { sort_order?: number }, b: { sort_order?: number }) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
          .map((r: { slug?: string; label?: string; type?: string; suggested_remedy_id?: string }) => ({
            id: r.slug, label: r.label, type: r.type || "remedy", suggested_remedy_id: r.suggested_remedy_id || null,
          }))
      : [
          { id: "too_expensive", label: "Too expensive", type: "remedy", suggested_remedy_id: null },
          { id: "too_much_product", label: "I have too much product", type: "remedy", suggested_remedy_id: null },
          { id: "not_seeing_results", label: "Not seeing results", type: "remedy", suggested_remedy_id: null },
          { id: "reached_goals", label: "I've reached my goals", type: "ai_conversation", suggested_remedy_id: null },
          { id: "just_need_a_break", label: "Just need a break", type: "ai_conversation", suggested_remedy_id: null },
          { id: "something_else", label: "Something else", type: "ai_conversation", suggested_remedy_id: null },
        ];

    const subAgeDays = sub.created_at
      ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / 86400000)
      : 0;

    return jsonOk({
      ok: true, route,
      subscription: sub,
      cancel_reasons: cancelReasons,
      remedies: remedies || [],
      reviews,
      customerFirstName: customer.first_name || "",
      subscriptionAgeDays: subAgeDays,
    });
  }

  // POST: Process cancel journey response
  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const step = String(payload?.step || "");
  const journeySessionId = String(payload?.journeySessionId || "");

  if (step === "reason") {
    const reason = String(payload?.reason || "");
    const suggestedRemedyId = payload?.suggested_remedy_id ? String(payload.suggested_remedy_id) : null;

    // Determine reason type from config or payload
    const reasonType = String(payload?.reasonType || "remedy");

    if (journeySessionId) {
      await admin.from("journey_sessions")
        .update({ responses: { reason }, updated_at: new Date().toISOString() })
        .eq("id", journeySessionId);
    }

    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.cancel_reason",
      summary: `Cancel reason selected: ${reason}`,
      properties: { shopify_contract_id: contractId, reason, reasonType },
    });

    // For ai_conversation type reasons, get initial AI reply (no ticket yet — created on first customer reply)
    if (reasonType === "ai_conversation") {
      // Fetch real customer context for AI
      const { data: custData } = await admin.from("customers")
        .select("ltv_cents, retention_score, total_orders")
        .eq("id", customer.id).single();
      const { data: subData } = await admin.from("subscriptions")
        .select("items, created_at, billing_interval, billing_interval_count")
        .eq("workspace_id", auth.workspaceId)
        .eq("shopify_contract_id", contractId).single();
      const subAgeDays = subData?.created_at ? Math.floor((Date.now() - new Date(subData.created_at).getTime()) / 86400000) : 0;
      const productIds = ((subData?.items as { product_id?: string }[]) || []).map(i => i.product_id).filter(Boolean) as string[];

      const customerCtx = {
        ltv_cents: custData?.ltv_cents || 0,
        retention_score: custData?.retention_score || 0,
        subscription_age_days: subAgeDays,
        total_orders: custData?.total_orders || 0,
        products: productIds,
        first_renewal: false,
      };

      // Use human-readable reason label for AI context (not the slug)
      const reasonLabel = String(payload?.reasonLabel || reason);

      // Get initial AI response (no ticket created yet)
      try {
        const { generateOpenEndedResponse } = await import("@/lib/remedy-selector");
        const reply = await generateOpenEndedResponse(
          auth.workspaceId, reasonLabel, "",
          [], customerCtx, productIds,
        );

        return jsonOk({
          ok: true, step: "reason", reason, type: "ai_chat",
          reply, turn: 1, maxTurns: 3,
          // Pass initial AI reply back so chat step can backfill it into ticket
          initialAiReply: reply,
        });
      } catch (err) {
        console.error("AI chat initial response failed:", err);
        return jsonOk({
          ok: true, step: "reason", reason, type: "ai_chat",
          reply: null, turn: 1, maxTurns: 3,
        });
      }
    }

    // Select top 3 remedies for this reason using AI
    let selectedRemedies: unknown[] = [];
    let reasonReviews: unknown[] = [];
    let sessionId: string | null = null;
    try {
      const { data: custData } = await admin.from("customers")
        .select("ltv_cents, retention_score, total_orders")
        .eq("id", customer.id)
        .single();

      const { data: subData } = await admin.from("subscriptions")
        .select("items, created_at, billing_interval, billing_interval_count")
        .eq("workspace_id", auth.workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();

      const subAgeDays = subData?.created_at ? Math.floor((Date.now() - new Date(subData.created_at).getTime()) / 86400000) : 0;
      const billingDays = (subData?.billing_interval_count || 1) * (subData?.billing_interval === "MONTH" ? 30 : subData?.billing_interval === "WEEK" ? 7 : 30);
      const productIds = ((subData?.items as { product_id?: string }[]) || []).map(i => i.product_id).filter(Boolean) as string[];

      const customerCtx = {
        ltv_cents: custData?.ltv_cents || 0,
        retention_score: custData?.retention_score || 0,
        subscription_age_days: subAgeDays,
        total_orders: custData?.total_orders || 0,
        products: productIds,
        first_renewal: subAgeDays < billingDays,
      };

      const { selectRemedies } = await import("@/lib/remedy-selector");
      const result = await selectRemedies(auth.workspaceId, reason, customerCtx, productIds, suggestedRemedyId);
      selectedRemedies = (result?.remedies || []).map((r: { remedy_id: string; name: string; type: string; pitch: string; coupon_code?: string; confidence: number }) => ({
        id: r.remedy_id,
        type: r.type,
        label: r.name,
        description: r.pitch,
      }));
      if (result?.review) reasonReviews = [result.review];

      // Record all shown remedies with a shared session_id
      if (selectedRemedies.length > 0) {
        sessionId = crypto.randomUUID();
        const shownRows = (selectedRemedies as { id: string; type: string }[]).map((r) => ({
          workspace_id: auth.workspaceId,
          customer_id: customer.id,
          remedy_id: r.id,
          remedy_type: r.type,
          cancel_reason: reason,
          shown: true,
          outcome: null,
          session_id: sessionId,
          accepted: false,
        }));
        await admin.from("remedy_outcomes").insert(shownRows);
      }
    } catch {
      try {
        const { data: allRemedies } = await admin.from("remedies")
          .select("id, type, name, description")
          .eq("workspace_id", auth.workspaceId)
          .eq("enabled", true)
          .limit(3);
        selectedRemedies = (allRemedies || []).map((r) => ({
          id: r.id, type: r.type, label: r.name || r.type, description: r.description || "",
        }));
      } catch {}
    }

    return jsonOk({ ok: true, step: "reason", reason, remedies: selectedRemedies, reviews: reasonReviews, sessionId });
  }

  if (step === "chat") {
    const message = String(payload?.message || "");
    const reason = String(payload?.reason || "");
    const reasonLabel = String(payload?.reasonLabel || reason);
    const turn = Number(payload?.turn) || 0;
    let ticketId = payload?.ticketId ? String(payload.ticketId) : null;
    const initialAiReply = payload?.initialAiReply ? String(payload.initialAiReply) : null;

    // First customer reply — create ticket and backfill conversation history
    if (!ticketId) {
      ticketId = await createChatTicket(admin, auth.workspaceId, customer.id, contractId, reasonLabel);

      if (ticketId) {
        // 1: System message — cancel flow started
        const customerEmail = customer.email || "";
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId,
          direction: "out",
          visibility: "internal",
          author_type: "system",
          body: `${customerEmail} started cancel flow for contract #${contractId} with cancel reason "${reasonLabel}"`,
        });

        // 2: Backfill initial AI message
        if (initialAiReply) {
          await logChatMessage(admin, ticketId, "out", "ai", initialAiReply);
        }
      }
    } else {
      // Subsequent replies — reopen the ticket
      await admin.from("tickets")
        .update({ status: "open" })
        .eq("id", ticketId);
    }

    // 3: Log customer message
    if (ticketId && message) {
      await logChatMessage(admin, ticketId, "in", "customer", message);
    }

    // Load conversation history from ticket messages for AI context
    const conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (ticketId) {
      const { data: messages } = await admin.from("ticket_messages")
        .select("direction, author_type, body")
        .eq("ticket_id", ticketId)
        .neq("author_type", "system")
        .order("created_at", { ascending: true });

      for (const m of messages || []) {
        if (m.author_type === "customer") {
          conversationHistory.push({ role: "user", content: m.body || "" });
        } else if (m.author_type === "ai") {
          conversationHistory.push({ role: "assistant", content: m.body || "" });
        }
      }
    }

    // Fetch real customer context for AI
    const { data: custData } = await admin.from("customers")
      .select("ltv_cents, retention_score, total_orders")
      .eq("id", customer.id).single();
    const { data: subData } = await admin.from("subscriptions")
      .select("items, created_at")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_contract_id", contractId).single();
    const subAgeDays = subData?.created_at ? Math.floor((Date.now() - new Date(subData.created_at).getTime()) / 86400000) : 0;
    const productIds = ((subData?.items as { product_id?: string }[]) || []).map(i => i.product_id).filter(Boolean) as string[];

    const customerCtx = {
      ltv_cents: custData?.ltv_cents || 0,
      retention_score: custData?.retention_score || 0,
      subscription_age_days: subAgeDays,
      total_orders: custData?.total_orders || 0,
      products: productIds,
      first_renewal: false,
    };

    // 4: Get AI response with full conversation history
    try {
      const { generateOpenEndedResponse } = await import("@/lib/remedy-selector");
      const reply = await generateOpenEndedResponse(
        auth.workspaceId, reasonLabel, message,
        conversationHistory, customerCtx, productIds,
      );

      // Log AI response + close ticket (reopens on next customer reply)
      if (ticketId && reply) {
        await logChatMessage(admin, ticketId, "out", "ai", reply);
        await admin.from("tickets")
          .update({ status: "closed" })
          .eq("id", ticketId);
      }

      return jsonOk({
        ok: true, step: "chat",
        reply: reply || "I understand. You can complete your cancellation using the cancel button below.",
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
    const sessionId = payload?.sessionId ? String(payload.sessionId) : null;

    if (accepted && remedyId) {
      // Fetch remedy details for action execution
      const { data: remedy } = await admin.from("remedies")
        .select("type, config")
        .eq("id", remedyId)
        .single();

      if (!remedy) {
        return jsonErr({ error: "remedy_not_found" }, 404);
      }

      // For line_item_modifier, signal frontend to show multi-step flow
      if (remedy.type === "line_item_modifier") {
        // Update outcome tracking
        if (sessionId) {
          await admin.from("remedy_outcomes")
            .update({ outcome: "accepted", accepted: true })
            .eq("session_id", sessionId)
            .eq("remedy_id", remedyId);
          await admin.from("remedy_outcomes")
            .update({ outcome: "passed_over" })
            .eq("session_id", sessionId)
            .neq("remedy_id", remedyId)
            .is("outcome", null);
        }

        return jsonOk({ ok: true, step: "line_item_modify", remedyId, remedyType: "line_item_modifier" });
      }

      // Execute the remedy action
      const actionResult = await executeRemedyAction(
        auth.workspaceId, contractId, remedy.type, remedy.config as RemedyConfig,
      );

      if (!actionResult.success) {
        return jsonErr({ error: "remedy_action_failed", message: actionResult.error }, 500);
      }

      // Update outcome tracking: accepted for this remedy, passed_over for others
      if (sessionId) {
        await admin.from("remedy_outcomes")
          .update({ outcome: "accepted", accepted: true })
          .eq("session_id", sessionId)
          .eq("remedy_id", remedyId);
        await admin.from("remedy_outcomes")
          .update({ outcome: "passed_over" })
          .eq("session_id", sessionId)
          .neq("remedy_id", remedyId)
          .is("outcome", null);
      }

      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.subscription.saved",
        summary: `Customer saved by ${remedy.type} remedy via portal`,
        properties: { shopify_contract_id: contractId, remedyId, remedyType: remedy.type, savedAction: actionResult.savedAction },
        createNote: true,
      });

      return jsonOk({
        ok: true, step: "remedy", accepted: true, remedyId,
        patch: actionResult.patch,
        savedAction: actionResult.savedAction,
      });
    }

    // Declined — shouldn't normally happen (customer goes to confirm_cancel instead)
    return jsonOk({ ok: true, step: "remedy", accepted: false, remedyId });
  }

  if (step === "line_item_action") {
    const action = String(payload?.action || "");
    const variantId = String(payload?.variantId || "");

    if (!action) return jsonErr({ error: "missing_action" }, 400);

    const { subAddItem, subRemoveItem, subChangeQuantity, subSwapVariant } = await import("@/lib/subscription-items");

    let result: { success: boolean; error?: string };
    let savedAction = "";

    if (action === "swap_variant") {
      const oldVariantId = String(payload?.oldVariantId || "");
      const newVariantId = String(payload?.newVariantId || "");
      if (!oldVariantId || !newVariantId) return jsonErr({ error: "missing_variant_ids" }, 400);
      result = await subSwapVariant(auth.workspaceId, contractId, oldVariantId, newVariantId);
      savedAction = "changed your product variant";
    } else if (action === "change_quantity") {
      const quantity = Number(payload?.quantity);
      if (!variantId || !quantity || quantity < 1) return jsonErr({ error: "invalid_quantity" }, 400);
      result = await subChangeQuantity(auth.workspaceId, contractId, variantId, quantity);
      savedAction = `updated your quantity to ${quantity}`;
    } else if (action === "remove") {
      if (!variantId) return jsonErr({ error: "missing_variantId" }, 400);
      result = await subRemoveItem(auth.workspaceId, contractId, variantId);
      savedAction = "removed an item from your subscription";
    } else if (action === "swap_product") {
      const newVariantId = String(payload?.newVariantId || "");
      const quantity = Number(payload?.quantity) || 1;
      if (!variantId || !newVariantId) return jsonErr({ error: "missing_params" }, 400);
      result = await subSwapVariant(auth.workspaceId, contractId, variantId, newVariantId, quantity);
      savedAction = "swapped a product in your subscription";
    } else {
      return jsonErr({ error: "invalid_action" }, 400);
    }

    if (!result.success) {
      return jsonErr({ error: "action_failed", message: result.error }, 500);
    }

    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.item_modified",
      summary: `Customer ${savedAction} via cancel flow`,
      properties: { shopify_contract_id: contractId, action },
      createNote: true,
    });

    return jsonOk({ ok: true, step: "line_item_action", savedAction, patch: {} });
  }

  if (step === "confirm_cancel") {
    const reason = String(payload?.reason || "Customer cancelled via portal");
    const ticketId = payload?.ticketId ? String(payload.ticketId) : null;
    const sessionId = payload?.sessionId ? String(payload.sessionId) : null;

    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    const result = await appstleSubscriptionAction(
      auth.workspaceId, contractId, "cancel", reason, "Portal"
    );

    if (!result.success) {
      return jsonErr({ error: "cancel_failed", message: result.error }, 500);
    }

    // Mark all shown remedies in this session as rejected (customer cancelled anyway)
    if (sessionId) {
      await admin.from("remedy_outcomes")
        .update({ outcome: "rejected" })
        .eq("session_id", sessionId)
        .is("outcome", null);
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
