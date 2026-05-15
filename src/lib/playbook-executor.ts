/**
 * Playbook Executor — runs playbook steps against live customer data.
 *
 * Called from the unified ticket handler when a playbook is active or matched.
 * Each step fetches live data, evaluates conditions, generates AI response,
 * and advances (or waits for customer reply).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { HAIKU_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

interface ShippingAddr {
  address1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  name: string | null;
  phone: string | null;
}

/**
 * Resolve a usable shipping address for an order. Tries (in order):
 *   1. order.shipping_address (most reliable for synced orders)
 *   2. fulfillments[0].destination (legacy fallback)
 * Returns null if no usable address is found.
 */
async function resolveOrderShippingAddress(admin: Admin, orderId: string): Promise<ShippingAddr | null> {
  const { data } = await admin.from("orders")
    .select("shipping_address, fulfillments")
    .eq("id", orderId).single();
  if (!data) return null;

  const ship = (data.shipping_address || null) as Record<string, unknown> | null;
  if (ship?.address1 && ship.city && (ship.zip || ship.postal_code)) {
    return {
      address1: ship.address1 as string,
      city: ship.city as string,
      state: (ship.province_code || ship.provinceCode || ship.province || "") as string,
      zip: (ship.zip || ship.postal_code) as string,
      country: (ship.country_code || ship.countryCodeV2 || ship.country_code_v2 || ship.country || "US") as string,
      name: (ship.name || [ship.first_name, ship.last_name].filter(Boolean).join(" ") || null) as string | null,
      phone: (ship.phone || null) as string | null,
    };
  }

  const fulfillments = (data.fulfillments || []) as { destination?: Record<string, unknown> }[];
  const dest = fulfillments[0]?.destination;
  if (dest?.address1 && dest.city && dest.zip) {
    return {
      address1: dest.address1 as string,
      city: dest.city as string,
      state: (dest.state || dest.province_code || dest.province || "") as string,
      zip: dest.zip as string,
      country: (dest.country || dest.country_code || "US") as string,
      name: (dest.name || null) as string | null,
      phone: (dest.phone || null) as string | null,
    };
  }

  return null;
}

/** Translate raw billing intervals to customer-friendly labels */
function translateIntervals(text: string): string {
  return text
    .replace(/WEEK\s*\/?\s*4/gi, "Monthly")
    .replace(/WEEK\s*\/?\s*8/gi, "Every 2 Months")
    .replace(/WEEK\s*\/?\s*12/gi, "Every 3 Months")
    .replace(/WEEK\s*\/?\s*2/gi, "Every 2 Weeks")
    .replace(/WEEK\s*\/?\s*1/gi, "Weekly")
    .replace(/MONTH\s*\/?\s*1/gi, "Monthly")
    .replace(/MONTH\s*\/?\s*2/gi, "Every 2 Months")
    .replace(/MONTH\s*\/?\s*3/gi, "Every 3 Months")
    .replace(/MONTH\s*\/?\s*6/gi, "Every 6 Months")
    .replace(/every\s+(\d+)\s+weeks?/gi, (_, n) => {
      const w = parseInt(n);
      if (w === 4) return "Monthly";
      if (w === 8) return "Every 2 Months";
      if (w === 12) return "Every 3 Months";
      if (w === 2) return "Every 2 Weeks";
      if (w === 1) return "Weekly";
      return `Every ${w} Weeks`;
    });
}

interface PlaybookStep {
  id: string;
  step_order: number;
  type: string;
  name: string;
  instructions: string | null;
  data_access: string[];
  resolved_condition: string | null;
  config: Record<string, unknown>;
  skippable: boolean;
}

interface PlaybookException {
  id: string;
  tier: number;
  name: string;
  conditions: Record<string, unknown>;
  resolution_type: string;
  instructions: string | null;
  auto_grant: boolean;
  auto_grant_trigger: string | null;
}

interface PlaybookPolicy {
  id: string;
  name: string;
  description: string | null;
  conditions: Record<string, unknown>;
  ai_talking_points: string | null;
  policy_url: string | null;
}

interface CustomerData {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  ltv_cents: number;
  total_orders: number;
  retention_score: number;
  subscription_status: string | null;
}

interface OrderData {
  id: string;
  order_number: string;
  shopify_order_id: string | null;
  created_at: string;
  total_cents: number;
  financial_status: string;
  fulfillment_status: string | null;
  delivery_status: string | null;
  line_items: unknown[];
  fulfillments: unknown[];
  source_name: string | null;
  subscription_id: string | null;
}

interface SubscriptionData {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: unknown[];
  billing_interval: string;
  billing_interval_count: number;
  next_billing_date: string | null;
  created_at: string;
  subscription_created_at: string | null;
}

export interface PlaybookExecResult {
  action: "respond" | "advance" | "complete" | "stand_firm" | "escalate_api_failure";
  response?: string;
  systemNote?: string;
  newStep?: number;
  context?: Record<string, unknown>;
  error?: string;
}

// ── Main executor ──

export async function executePlaybookStep(
  workspaceId: string,
  ticketId: string,
  customerMessage: string,
  personality: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  const admin = createAdminClient();

  // Load ticket state
  const { data: ticket } = await admin.from("tickets")
    .select("active_playbook_id, playbook_step, playbook_context, playbook_exceptions_used, customer_id, created_at, channel")
    .eq("id", ticketId).single();

  if (!ticket?.active_playbook_id || !ticket.customer_id) {
    return { action: "complete", systemNote: "No active playbook or customer." };
  }

  // Load playbook + steps
  const { data: playbook } = await admin.from("playbooks")
    .select("id, name, exception_limit, stand_firm_max, stand_firm_before_exceptions, stand_firm_between_tiers, exception_disqualifiers, disqualifier_behavior")
    .eq("id", ticket.active_playbook_id).single();

  if (!playbook) return { action: "complete", systemNote: "Playbook not found." };

  const { data: steps } = await admin.from("playbook_steps")
    .select("*")
    .eq("playbook_id", playbook.id)
    .order("step_order", { ascending: true });

  if (!steps?.length) return { action: "complete", systemNote: "No steps in playbook." };

  const currentStepIdx = ticket.playbook_step;
  const currentStep = steps[currentStepIdx];
  if (!currentStep) return { action: "complete", systemNote: "All playbook steps completed." };

  const ctx = (ticket.playbook_context || {}) as Record<string, unknown>;
  ctx._channel = ticket.channel || "email"; // Pass channel to handlers for formatting

  // Fetch live customer data
  const customer = await fetchCustomerData(admin, workspaceId, ticket.customer_id);
  if (!customer) return { action: "complete", systemNote: "Customer not found." };

  const orders = await fetchOrders(admin, workspaceId, ticket.customer_id, currentStep.config);
  const subs = await fetchSubscriptions(admin, workspaceId, ticket.customer_id);

  // Check for timeline changes since ticket creation
  const { data: recentEvents } = await admin.from("customer_events")
    .select("event_type, summary, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", ticket.customer_id)
    .gte("created_at", ticket.created_at)
    .order("created_at", { ascending: false })
    .limit(5);

  const timelineChanges = (recentEvents || [])
    .map(e => `${e.event_type}: ${e.summary} (${new Date(e.created_at).toLocaleDateString()})`)
    .join("\n");

  // Fetch subscription activity (interval changes, pauses, resumes, cancellations)
  // Goes back 90 days — not just since ticket creation
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: subEvents } = await admin.from("customer_events")
    .select("event_type, summary, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", ticket.customer_id)
    .gte("created_at", since90d)
    .or("event_type.ilike.subscription%,event_type.ilike.portal.subscription%")
    .order("created_at", { ascending: false })
    .limit(15);
  if (subEvents?.length) {
    ctx._subscription_activity = subEvents
      .map(e => `${new Date(e.created_at).toLocaleDateString()}: ${e.summary}`)
      .join("\n");
  }

  // Execute the step
  const stepResult = await executeStep(
    admin, workspaceId, ticketId, playbook, currentStep, steps,
    customer, orders, subs, ctx, customerMessage, personality,
    ticket.playbook_exceptions_used, timelineChanges,
  );

  // Wrap response with intro (first message) and sign-off
  if (stepResult.response) {
    const isFirstMessage = !ctx.playbook_intro_sent;
    stepResult.response = wrapResponse(stepResult.response, personality, isFirstMessage);
    if (isFirstMessage) {
      stepResult.context = { ...stepResult.context, playbook_intro_sent: true };
    }
  }

  // Update ticket context
  if (stepResult.context) {
    const updatedCtx = { ...ctx, ...stepResult.context };

    // Auto-resolve identified_order_id from identified_orders if missing
    if (updatedCtx.identified_orders && !updatedCtx.identified_order_id) {
      const orderNumbers = updatedCtx.identified_orders as string[];
      if (orderNumbers.length > 0) {
        const { data: matched } = await admin.from("orders")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("order_number", orderNumbers[0])
          .limit(1).single();
        if (matched) updatedCtx.identified_order_id = matched.id;
      }
    }

    await admin.from("tickets").update({ playbook_context: updatedCtx }).eq("id", ticketId);
  }

  // Advance step if needed
  if (stepResult.action === "advance" && stepResult.newStep !== undefined) {
    const nextStepIdx = stepResult.newStep;
    if (nextStepIdx >= steps.length) {
      // All steps done — build summary and complete
      const summary = buildPlaybookSummary(playbook.name, { ...ctx, ...stepResult.context }, customer, ticket.playbook_exceptions_used);
      const updatedCtx = { ...ctx, ...stepResult.context, summary };
      await admin.from("tickets").update({ playbook_context: updatedCtx }).eq("id", ticketId);
      return {
        ...stepResult, action: "complete",
        systemNote: `[Playbook Complete] ${playbook.name}\n${summary}`,
        context: { ...stepResult.context, summary },
      };
    }
    await admin.from("tickets").update({ playbook_step: nextStepIdx }).eq("id", ticketId);
  }

  // If stand_firm final or other explicit complete, also build summary
  if (stepResult.action === "complete" && !((stepResult.context || {}) as Record<string, unknown>).summary) {
    const mergedCtx = { ...ctx, ...stepResult.context };
    const summary = buildPlaybookSummary(playbook.name, mergedCtx, customer, ticket.playbook_exceptions_used);
    const updatedCtx = { ...mergedCtx, summary };
    await admin.from("tickets").update({ playbook_context: updatedCtx }).eq("id", ticketId);
    return {
      ...stepResult,
      systemNote: `[Playbook Complete] ${playbook.name}\n${summary}`,
      context: { ...stepResult.context, summary },
    };
  }

  return stepResult;
}

// ── Step dispatcher ──

async function executeStep(
  admin: Admin, wsId: string, tid: string,
  playbook: { id: string; name: string; exception_limit: number; stand_firm_max: number; stand_firm_before_exceptions: number; stand_firm_between_tiers: number; exception_disqualifiers: { type: string; source?: string }[]; disqualifier_behavior: string },
  step: PlaybookStep, allSteps: PlaybookStep[],
  customer: CustomerData, orders: OrderData[], subs: SubscriptionData[],
  ctx: Record<string, unknown>, msg: string,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
  exceptionsUsed: number, timelineChanges: string,
): Promise<PlaybookExecResult> {

  const dataContext = buildDataContext(customer, orders, subs, ctx, timelineChanges);

  // Load the playbook's policy once — used by apply_policy, offer_exception, initiate_return, stand_firm
  let policy: PlaybookPolicy | null = null;
  const policyStep = allSteps.find(s => s.type === "apply_policy" || s.type === "offer_exception");
  const policyId = (step.config.policy_id || policyStep?.config?.policy_id) as string | undefined;
  if (policyId) {
    const { data } = await admin.from("playbook_policies").select("*").eq("id", policyId).single();
    policy = data as PlaybookPolicy | null;
  }

  // Build policy rules string from the policy's description + talking points
  const policyRules = policy
    ? [policy.description, policy.ai_talking_points].filter(Boolean).join("\n")
    : (ctx.policy_rules as string) || "";

  // Store policy rules in context so downstream steps (stand_firm) can access them
  if (policyRules && !ctx.policy_rules) {
    ctx.policy_rules = policyRules;
  }

  // ── Global cancel detection ──
  // After step 2 (identify_subscription), if customer mentions "cancel" at any point,
  // pause the playbook and handle the cancel flow.
  const cancelPatterns = /\b(cancel|stop charging|stop my subscription|don't want.*subscription|end.*subscription)\b/i;
  const pastStep2 = step.step_order >= 2 || ctx.identified_subscription;
  if (pastStep2 && !ctx.paused_for_cancel && !ctx.cancel_handled && cancelPatterns.test(msg) && step.type !== "cancel_subscription") {
    // Check subscription status. The cancel journey is a "save attempt"
    // step — we only launch it if there's something ACTIVELY billing
    // the customer that we could pause/skip/change to save them.
    //
    // If their only sub(s) are already paused (customer self-paused) or
    // cancelled, the cancel journey is a wasted step — there's nothing
    // to save. Skip to the next playbook step (typically apply_policy +
    // refund handling).
    const identifiedSub = ctx.identified_subscription as string | undefined;
    const trulyActiveSubs = subs.filter(s => s.status === "active");
    const pausedOrCancelledSubs = subs.filter(s => s.status === "paused" || s.status === "cancelled");
    const identifiedSubObj = identifiedSub ? subs.find(s => s.shopify_contract_id === identifiedSub) : null;
    const isAlreadyCancelled = identifiedSubObj?.status === "cancelled";
    const isAlreadyPaused = identifiedSubObj?.status === "paused";

    if (isAlreadyCancelled && trulyActiveSubs.length === 0) {
      // Sub already cancelled, nothing else active — mark handled and
      // fall through to apply_policy which shows the timeline explaining
      // the charges.
      ctx.cancel_handled = true;
      ctx.subscription_cancelled = true;
    }

    if (isAlreadyPaused && trulyActiveSubs.length === 0) {
      // Customer already self-paused their only sub. Launching the
      // cancel journey is wrong — they've already done the "save
      // action" themselves. But we shouldn't silently skip either —
      // we want to CONFIRM that pause is what they want, since some
      // customers pause when they actually meant to cancel.
      //
      // Send a confirmation message + wait for their reply. Their
      // response routes the playbook from there.
      const pauseTarget = identifiedSubObj || pausedOrCancelledSubs.find(s => s.status === "paused");
      const resumeDate = (pauseTarget as { pause_resume_at?: string | null })?.pause_resume_at;
      const items = (pauseTarget?.items as { title?: string }[] || []).map(i => i.title || "item").join(", ");

      // Single-statement confirmation. Do NOT bait the negative
      // outcome by offering "or cancel it entirely?" — that primes the
      // customer to escalate beyond what they originally asked for. If
      // they want full cancel or a refund, they'll bring it up; we
      // handle that ask per policy when it comes.
      let pauseMessage = `I see you've already paused your ${items || "subscription"}`;
      if (resumeDate) {
        const d = new Date(resumeDate);
        const formatted = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        pauseMessage += ` — it's set to resume on ${formatted}. Let me know if there's anything else I can help with.`;
      } else {
        pauseMessage += `. Let me know if there's anything else I can help with.`;
      }

      // Mark cancel_handled — the customer's self-pause IS the save
      // outcome. The playbook should advance on next inbound message
      // based on what the customer actually says, not be paused waiting
      // for a forked answer to a question we shouldn't have asked.
      ctx.cancel_handled = true;
      ctx.subscription_already_paused = true;

      return {
        action: "respond",
        response: pauseMessage,
        context: {
          cancel_handled: true,
          subscription_already_paused: true,
          pause_target_sub: pauseTarget?.shopify_contract_id,
        },
        systemNote: `[Playbook] Subscription #${pauseTarget?.shopify_contract_id} already paused — confirming pause to customer without baiting a forked "keep it or cancel" question. Marking cancel_handled; customer drives the next ask.`,
      };
    }

    if (trulyActiveSubs.length > 0) {
      // Has active subs — launch cancel journey
      const targetSub = identifiedSubObj?.status === "active" ? identifiedSubObj : trulyActiveSubs[0];
      const targetItems = (targetSub.items as { title?: string }[] || []).map(i => i.title || "item").join(", ");

      // Launch the cancel journey
      try {
        const { data: journeyDef } = await admin.from("journey_definitions")
          .select("id, name")
          .eq("workspace_id", wsId)
          .eq("journey_type", "cancellation")
          .eq("is_active", true)
          .limit(1).single();

        if (journeyDef) {
          const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
          await launchJourneyForTicket({
            workspaceId: wsId, ticketId: tid, customerId: customer.id,
            journeyId: journeyDef.id, journeyName: journeyDef.name,
            triggerIntent: "cancel_subscription",
            channel: (ctx._channel as string) || "email",
            leadIn: `I can help you with that — I've sent you a link to manage your subscription for ${targetItems}. You can cancel, pause, or adjust your delivery schedule there.`,
            ctaText: "Manage Subscription",
          });

          ctx.paused_for_cancel = true;
          ctx.cancel_target_sub = targetSub.shopify_contract_id;

          // Don't send a separate response — the journey launcher already sent the email
          // Use "respond" (not "advance") to prevent auto-advance loop from re-entering
          return {
            action: "respond",
            context: { paused_for_cancel: true, cancel_target_sub: targetSub.shopify_contract_id, cancel_journey_launched: true },
            systemNote: `[Playbook] Cancel detected — launching cancel journey for subscription #${targetSub.shopify_contract_id}. Playbook paused.`,
          };
        }
      } catch (err) {
        console.error("Failed to launch cancel journey:", err);
      }
    }
  }

  // If playbook is paused for cancel, don't run normal steps — wait for journey completion
  if (ctx.paused_for_cancel && !ctx.cancel_journey_completed) {
    // Check if the journey has completed
    const { data: sessions } = await admin.from("journey_sessions")
      .select("status, outcome")
      .eq("ticket_id", tid)
      .eq("workspace_id", wsId)
      .order("created_at", { ascending: false })
      .limit(1);

    const latest = sessions?.[0];
    if (latest?.status === "completed") {
      ctx.cancel_journey_completed = true;
      ctx.paused_for_cancel = false;
      const cancelled = latest.outcome === "cancelled";

      // Confirm the result
      let response: string;
      if (cancelled) {
        response = `Your subscription is now cancelled and no future orders will be sent.`;
        ctx.subscription_cancelled = true;
      } else {
        response = `Your subscription has been updated based on your selections.`;
      }

      // Check for other active subs
      const remainingActive = subs.filter(s => s.status === "active" && s.shopify_contract_id !== ctx.cancel_target_sub);
      if (remainingActive.length > 0) {
        const subItems = (remainingActive[0].items as { title?: string }[] || []).map(i => i.title || "item").join(", ");
        response += ` I also noticed you have another active subscription for ${subItems}. Would you like to keep that one running?`;
      }

      // Reset playbook step to apply_policy so if customer brings up refund, it resumes there
      const applyPolicyStep = allSteps.find(s => s.type === "apply_policy");
      if (applyPolicyStep) {
        await admin.from("tickets").update({ playbook_step: applyPolicyStep.step_order }).eq("id", tid);
      }

      return {
        action: "respond", response,
        context: { cancel_journey_completed: true, paused_for_cancel: false, subscription_cancelled: cancelled, cancel_handled: true },
        systemNote: `[Playbook] Cancel journey completed. Outcome: ${latest.outcome}. ${cancelled ? "Subscription cancelled." : "Subscription saved."} Not mentioning refund. Playbook reset to apply_policy.`,
      };
    }

    // Journey not yet completed
    // Only send a nudge if the customer sent a NEW message (not the auto-advance after launch)
    if (ctx.cancel_journey_launched) {
      // Customer messaged again while journey is pending — nudge them
      const response = `I've sent you a link to manage your subscription. Please complete the steps there and I'll be here to help with anything else afterward.`;
      return {
        action: "respond", response,
        systemNote: `[Playbook] Waiting for cancel journey completion. Nudging customer.`,
      };
    }
    // First entry after launch — just mark as launched, don't send anything
    return {
      action: "advance", newStep: step.step_order,
      context: { cancel_journey_launched: true },
      systemNote: `[Playbook] Cancel journey launched. Waiting for completion. No message sent.`,
    };
  }

  // ── Global acceptance detection ──
  // If an offer has been made and not yet accepted, check every incoming message for acceptance.
  // If accepted, jump directly to initiate_return regardless of current step.
  if (ctx.exception_offered && !ctx.offer_accepted && step.type !== "offer_exception") {
    const accepted = detectAcceptance(msg);
    if (accepted) {
      ctx.offer_accepted = true;
      // Find the initiate_return step and jump to it
      const returnStep = allSteps.find(s => s.type === "initiate_return");
      if (returnStep) {
        await admin.from("tickets").update({
          playbook_step: returnStep.step_order,
          playbook_context: { ...ctx, offer_accepted: true },
        }).eq("id", tid);
        return handleInitiateReturn(admin, wsId, tid, customer, orders, ctx, returnStep, dataContext, pers, msg, policyRules);
      }
    }
  }

  switch (step.type) {
    case "identify_order": {
      // For replacement playbook: filter orders based on clarify_issue response
      let filteredOrders = orders;
      if (ctx.received_order === true) {
        // Customer received it but items missing/damaged — only show DELIVERED orders
        filteredOrders = orders.filter(o => (o.delivery_status || "") === "delivered");
      } else if (ctx.received_order === false) {
        // Customer didn't receive it — show all fulfilled orders (in-transit + delivered)
        filteredOrders = orders.filter(o => (o.fulfillment_status || "").toUpperCase() === "FULFILLED");
      }
      // Limit to 3 most recent for cleaner display
      if (ctx.received_order !== undefined) {
        filteredOrders = filteredOrders.slice(0, 3);
      }
      return handleIdentifyOrder(filteredOrders, msg, step, dataContext, pers, policyRules, ctx);
    }

    case "identify_subscription":
      return handleIdentifySubscription(subs, orders, ctx, step, dataContext, pers, policyRules);

    case "check_other_subscriptions":
      return handleCheckOtherSubs(subs, ctx, step, dataContext, pers);

    case "apply_policy": {
      if (!policy) return { action: "advance", newStep: step.step_order + 1, systemNote: "No policy configured." };
      return handleApplyPolicy(admin, wsId, policy, orders, subs, ctx, step, dataContext, pers, policyRules, msg);
    }

    case "offer_exception": {
      if (!policyId) return { action: "advance", newStep: step.step_order + 1, systemNote: "No policy for exception." };
      const { data: exceptions } = await admin.from("playbook_exceptions")
        .select("*").eq("policy_id", policyId).order("tier");
      return handleOfferException(
        exceptions || [], customer, orders, ctx, step, dataContext, pers,
        exceptionsUsed, playbook, tid, admin, msg, policyRules, wsId,
      );
    }

    case "initiate_return":
      return handleInitiateReturn(admin, wsId, tid, customer, orders, ctx, step, dataContext, pers, msg, policyRules);

    case "cancel_subscription":
      return handleCancelSubscription(admin, wsId, subs, ctx, step, dataContext, pers, policyRules);

    case "issue_store_credit":
      return handleIssueStoreCredit(admin, wsId, customer, orders, ctx, step, tid);

    case "stand_firm":
      return handleStandFirm(ctx, step, playbook.stand_firm_max, msg, dataContext, pers, policyRules);

    case "clarify_issue":
      return handleClarifyIssue(msg, ctx, step, pers);

    case "check_tracking":
      return handleCheckTracking(admin, wsId, tid, orders, ctx, step, pers);

    case "classify_issue":
      return handleClassifyIssue(admin, tid, msg, ctx, step, pers);

    case "select_missing_items":
      return handleSelectMissingItems(admin, wsId, tid, orders, ctx, step, pers, msg);

    case "confirm_shipping_address":
      return handleConfirmShippingAddress(admin, wsId, tid, customer, ctx, step, pers);

    case "create_replacement":
      return handleCreateReplacement(admin, wsId, tid, customer, orders, ctx, step, pers);

    case "adjust_subscription":
      return handleAdjustSubscription(admin, wsId, subs, ctx, step, pers);

    case "ask_return_reason":
      return handleAskReturnReason(ctx, step, pers);

    case "save_with_review":
      return handleSaveWithReview(admin, wsId, orders, ctx, step, msg, pers);

    case "confirm_return":
      return handleConfirmReturn(admin, wsId, orders, ctx, step, msg, pers);

    case "process_return":
      return handleProcessReturn(admin, wsId, tid, customer, orders, ctx, step, msg, pers);

    case "explain":
    case "custom":
      return handleGenericStep(step, dataContext, msg, pers, policyRules);

    default:
      return { action: "advance", newStep: step.step_order + 1, systemNote: `Unknown step type: ${step.type}` };
  }
}

// ── Data fetchers ──

async function fetchCustomerData(admin: Admin, wsId: string, custId: string): Promise<CustomerData | null> {
  // Include linked profiles for combined data
  const linkedIds = [custId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", custId).single();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data: c } = await admin.from("customers")
    .select("id, email, first_name, last_name, retention_score, subscription_status")
    .eq("id", custId).single();
  if (!c) return null;

  // LTV + order count come live from the orders table — the denormalized columns
  // on `customers` keep drifting (cleared by Shopify customer/update webhooks
  // that arrive without orders_count/total_spent). getCustomerStats covers
  // linked accounts too.
  const { getCustomerStats } = await import("@/lib/customer-stats");
  const stats = await getCustomerStats(custId);

  return {
    ...c,
    ltv_cents: stats.ltv_cents,
    total_orders: stats.total_orders,
  } as CustomerData;
}

async function fetchOrders(admin: Admin, wsId: string, custId: string, config: Record<string, unknown>): Promise<OrderData[]> {
  // Floor at 180 days so the orchestrator has full visibility into the
  // customer's order history — not just the policy window. Surfaced on
  // ticket 6e732303 (Veronica, May 8): customer's two orders were 25
  // and 53 days old; the old 21-day lookback hid both and the playbook
  // kept saying "no recent orders found" while the customer kept giving
  // us order numbers. Even with a 35-day floor we'd still miss anything
  // older. The policy check later correctly classifies each order as
  // in/out of policy, so fetching more is safe — we just want Sonnet
  // to see the full picture.
  const lookbackDays = Math.max(Number(config.lookback_days) || 180, 180);
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  // Include linked customer orders
  const linkedIds = [custId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", custId).single();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data } = await admin.from("orders")
    .select("id, order_number, shopify_order_id, created_at, total_cents, financial_status, fulfillment_status, delivery_status, line_items, fulfillments, source_name, subscription_id")
    .eq("workspace_id", wsId)
    .in("customer_id", linkedIds)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  return (data || []) as OrderData[];
}

async function fetchSubscriptions(admin: Admin, wsId: string, custId: string): Promise<SubscriptionData[]> {
  const linkedIds = [custId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", custId).single();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at, subscription_created_at")
    .eq("workspace_id", wsId)
    .in("customer_id", linkedIds)
    .order("created_at", { ascending: false });

  return (data || []) as SubscriptionData[];
}

// ── Data context builder ──

function buildDataContext(
  customer: CustomerData, orders: OrderData[], subs: SubscriptionData[],
  ctx: Record<string, unknown>, timelineChanges: string,
): string {
  const parts: string[] = [];
  parts.push(`Customer: ${customer.first_name || ""} ${customer.last_name || ""} (${customer.email})`);
  parts.push(`LTV: $${(customer.ltv_cents / 100).toFixed(2)} | Orders: ${customer.total_orders} | Retention: ${customer.retention_score}/100`);

  if (orders.length) {
    parts.push(`\nRecent orders (${orders.length}):`);
    for (const o of orders.slice(0, 5)) {
      const items = (o.line_items as { title?: string }[] || []).map(i => i.title || "item").join(", ");
      parts.push(`  ${o.order_number} — $${(o.total_cents / 100).toFixed(2)} — ${o.financial_status} — ${new Date(o.created_at).toLocaleDateString()} — ${items}`);
    }
  }

  if (subs.length) {
    parts.push(`\nSubscriptions (${subs.length}):`);
    for (const s of subs) {
      const items = (s.items as { title?: string }[] || []).map(i => i.title || "item").join(", ");
      const subCreated = s.subscription_created_at || s.created_at;
      parts.push(`  #${s.shopify_contract_id} — ${s.status} — ${s.billing_interval}/${s.billing_interval_count} — ${items} — created ${new Date(subCreated).toLocaleDateString()}`);
    }
  }

  // Include subscription activity from customer_events (interval changes, pauses, etc.)
  // This is injected by the caller — stored in ctx._subscription_activity
  const subActivity = ctx._subscription_activity as string | undefined;
  if (subActivity) {
    parts.push(`\nSubscription activity (recent changes):\n${subActivity}`);
    if (subActivity.includes("Billing interval changed")) {
      parts.push(`\nIMPORTANT: The billing interval was changed recently. If the charge happened BEFORE the interval change, the charge was correct under the OLD interval. Appstle does not make billing mistakes — check timestamps carefully before concluding a charge was incorrect.`);
    }
  }

  if (timelineChanges) {
    parts.push(`\nRecent account changes (since ticket opened):\n${timelineChanges}`);
  }

  const identified = ctx.identified_orders as string[] | undefined;
  if (identified?.length) parts.push(`\nIdentified order(s) for this issue: ${identified.join(", ")}`);

  const identifiedSub = ctx.identified_subscription as string | undefined;
  if (identifiedSub) parts.push(`Related subscription: #${identifiedSub}`);

  return parts.join("\n");
}

// ── AI helper ──

async function aiGenerate(systemPrompt: string, userPrompt: string, model = HAIKU_MODEL): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 300, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

function basePrompt(step: PlaybookStep, pers: { name?: string; tone?: string; sign_off?: string | null } | null, policyRules?: string): string {
  return [
    `You are a customer support agent${pers?.name ? ` named ${pers.name}` : ""}.`,
    pers?.tone ? `Tone: ${pers.tone}` : "Be empathetic and professional.",
    `FORMATTING RULES:
- Use HTML for formatting (<p>, <b>, <ul>, <li>). Do NOT use markdown.
- Max 2-3 sentences per paragraph.
- NEVER include order numbers (like SC127106) or subscription contract numbers in your response. Refer to orders by date and amount: "your April 4th order for $5.87". Log IDs in system notes only.
- NEVER introduce yourself or re-greet the customer. No "Hi [name]," or "I'm [name]" — introductions are handled separately.
- NEVER repeat context already covered (order details, subscription timeline, product lists). The customer already knows — just talk about the current offer.
- Messages should get SHORTER as the conversation progresses.
- NEVER promise to connect with a specialist or escalate to a supervisor — you handle the full resolution.
- Only apologize if there is concrete evidence of an error on our part.`,
    pers?.sign_off ? `SIGN-OFF: End every response with:\n${pers.sign_off}` : "",
    policyRules ? `Store policy rules:\n${policyRules}` : "",
    step.instructions ? `Step instructions: ${step.instructions}` : "",
  ].filter(Boolean).join("\n");
}

/** Wrap AI response with intro (first message only) and sign-off */
function wrapResponse(response: string, pers: { name?: string; sign_off?: string | null } | null, isFirstMessage: boolean): string {
  let result = response;

  // Add intro on first message (skip if AI already introduced itself)
  if (isFirstMessage && pers?.name) {
    const alreadyIntros = new RegExp(`I'm ${pers.name}|I am ${pers.name}|my name is ${pers.name}`, "i").test(result);
    if (!alreadyIntros) {
      const hasGreeting = /^(hi|hey|hello|dear)\b/i.test(result.trim());
      if (!hasGreeting) {
        result = `Hi, I'm ${pers.name} and I'm here to help you with this.\n\n${result}`;
      }
    }
  }

  // Add sign-off if not already present
  if (pers?.sign_off && !result.includes(pers.sign_off)) {
    result = `${result}\n\n${pers.sign_off}`;
  }

  return result;
}

// ── Step handlers ──

async function handleIdentifyOrder(
  orders: OrderData[], msg: string, step: PlaybookStep,
  dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
  ctx: Record<string, unknown>,
): Promise<PlaybookExecResult> {
  if (orders.length === 0) {
    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\nThe customer has no recent orders. Acknowledge their concern and ask for an order number or more details.`,
    );
    return { action: "respond", response, systemNote: "[Playbook] No recent orders found." };
  }

  if (orders.length === 1) {
    // Single order — skip confirmation and auto-advance
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[0].order_number] },
      systemNote: `[Playbook] Single order auto-identified: ${orders[0].order_number}. Skipping confirmation.`,
    };
  }

  // Recency shortcut: if exactly one order in the last 14 days, that's
  // overwhelmingly the one the customer is talking about. The 180-day
  // lookback gives Sonnet visibility into history but presenting orders
  // back to December for a "my recent order" question creates needless
  // confusion (ticket 36f7664d: customer talking about an order from 11
  // days ago, playbook listed orders going back ~5 months).
  const RECENT_DAYS = 14;
  const recentCutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const recentOrders = orders.filter(o => new Date(o.created_at).getTime() >= recentCutoff);
  if (recentOrders.length === 1) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [recentOrders[0].order_number] },
      systemNote: `[Playbook] Single order in last ${RECENT_DAYS} days: ${recentOrders[0].order_number}. Auto-identified.`,
    };
  }
  // If 2+ orders are within 14 days, narrow disambiguation to that set
  // — older orders aren't viable candidates for a "my recent" query.
  if (recentOrders.length >= 2) {
    orders = recentOrders;
  }

  // Multiple orders — try to match customer's message to an order
  const msgLower = msg.toLowerCase().replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ");

  // Match by order number (if customer somehow knows it)
  const matchedByNumber = orders.filter(o => {
    const num = o.order_number.replace(/^[^0-9]*/, "");
    return msgLower.includes(o.order_number.toLowerCase()) || msgLower.includes(num);
  });
  if (matchedByNumber.length > 0) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: matchedByNumber.map(o => o.order_number) },
      systemNote: `[Playbook] Customer specified order(s): ${matchedByNumber.map(o => o.order_number).join(", ")}`,
    };
  }

  // Match by date reference ("the April 4 one", "april 4th", "4/4")
  const matchedByDate = orders.filter(o => {
    const d = new Date(o.created_at);
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const monthShort = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const month = monthNames[d.getMonth()];
    const mShort = monthShort[d.getMonth()];
    const day = d.getDate();
    const dayStr = String(day);
    const monthNum = String(d.getMonth() + 1);

    // "April 4", "april 4th", "Apr 4", "4/4", "the 4th"
    return msgLower.includes(`${month} ${dayStr}`) ||
      msgLower.includes(`${month} ${day}th`) ||
      msgLower.includes(`${month} ${day}st`) ||
      msgLower.includes(`${month} ${day}nd`) ||
      msgLower.includes(`${month} ${day}rd`) ||
      msgLower.includes(`${mShort} ${dayStr}`) ||
      msgLower.includes(`${monthNum}/${dayStr}`) ||
      msgLower.includes(`${monthNum}-${dayStr}`);
  });
  if (matchedByDate.length > 0) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: matchedByDate.map(o => o.order_number) },
      systemNote: `[Playbook] Customer identified order by date: ${matchedByDate.map(o => o.order_number).join(", ")}`,
    };
  }

  // Match by product name — full title OR a distinctive token from the
  // title (so "creamer" matches "Amazing Creamer", "tabs" matches
  // "Superfood Tabs"). Common brand/filler words are stripped so we
  // don't false-match on words like "amazing" that appear across SKUs.
  const STOPWORDS = new Set([
    "amazing", "superfoods", "superfood", "the", "and", "with", "for",
    "shipping", "protection", "mystery", "item", "free", "gift", "bamboo",
  ]);
  const matchedByProduct = orders.filter(o => {
    const items = (o.line_items as { title?: string }[] || []);
    return items.some(i => {
      if (!i.title) return false;
      const titleLower = i.title.toLowerCase();
      if (msgLower.includes(titleLower)) return true;
      const tokens = titleLower
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length >= 4 && !STOPWORDS.has(t));
      return tokens.some(t => new RegExp(`\\b${t}\\b`, "i").test(msgLower));
    });
  });
  if (matchedByProduct.length === 1) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [matchedByProduct[0].order_number] },
      systemNote: `[Playbook] Customer identified order by product name: ${matchedByProduct[0].order_number}`,
    };
  }

  // Match by dollar amount ("the $5.87 one")
  const amountMatch = msgLower.match(/\$(\d+(?:\.\d{2})?)/);
  if (amountMatch) {
    const amountCents = Math.round(parseFloat(amountMatch[1]) * 100);
    const matchedByAmount = orders.filter(o => o.total_cents === amountCents);
    if (matchedByAmount.length === 1) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { identified_orders: [matchedByAmount[0].order_number] },
        systemNote: `[Playbook] Customer identified order by amount: ${matchedByAmount[0].order_number}`,
      };
    }
  }

  // "All orders" / "all of them"
  if (/all (of )?(them|my orders|orders)|every order|each order|both/i.test(msg)) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: orders.map(o => o.order_number) },
      systemNote: `[Playbook] Customer wants all ${orders.length} orders addressed.`,
    };
  }

  // Positional: "the first one", "the last one", "the most recent", "the second one"
  if (/\b(last|most recent|latest|recent)\b/i.test(msg)) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[0].order_number] },
      systemNote: `[Playbook] Customer referenced most recent order: ${orders[0].order_number}.`,
    };
  }
  if (/\b(first one|first order|the first)\b/i.test(msg)) {
    // "First one" = first in the displayed list = most recent
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[0].order_number] },
      systemNote: `[Playbook] Customer referenced "first one" (first in list = most recent): ${orders[0].order_number}.`,
    };
  }
  if (/\b(oldest|earliest)\b/i.test(msg)) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[orders.length - 1].order_number] },
      systemNote: `[Playbook] Customer referenced oldest order: ${orders[orders.length - 1].order_number}.`,
    };
  }
  if (/\bsecond\b/i.test(msg) && orders.length >= 2) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[1].order_number] },
      systemNote: `[Playbook] Customer referenced second order: ${orders[1].order_number}.`,
    };
  }
  if (/\bthird\b/i.test(msg) && orders.length >= 3) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[2].order_number] },
      systemNote: `[Playbook] Customer referenced third order: ${orders[2].order_number}.`,
    };
  }

  // If we already asked and customer replied but we couldn't match — default to most recent
  if (ctx.order_list_shown) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[0].order_number] },
      systemNote: `[Playbook] Could not match customer reply to specific order. Defaulting to most recent: ${orders[0].order_number}.`,
    };
  }

  // Time-distance shortcut — when the two most recent orders are more
  // than 10 days apart, the customer is overwhelmingly talking about
  // the most recent one (e.g. "my last order didn't arrive"). Asking
  // creates needless friction. Only ask when orders are close enough
  // in time (within 10 days) that the customer could genuinely be
  // referring to either.
  if (orders.length >= 2) {
    const newestMs = new Date(orders[0].created_at).getTime();
    const nextMs = new Date(orders[1].created_at).getTime();
    const daysApart = Math.abs(newestMs - nextMs) / 86_400_000;
    if (daysApart > 10) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { identified_orders: [orders[0].order_number] },
        systemNote: `[Playbook] Auto-identified most recent order (${orders[0].order_number}) — next order is ${Math.round(daysApart)} days older, outside the 10-day disambiguation window.`,
      };
    }
  }

  // First time — show the order list and ask
  const channel = (ctx._channel as string) || "email";
  const useHtml = ["email", "chat", "help_center"].includes(channel);

  // We need admin + wsId to enrich variant titles, but they're not passed to this function
  // Use a simple fallback: load variant map inline if we can detect workspace from orders
  const admin2 = createAdminClient();
  let variantTitleMap: Map<string, string> | null = null;
  if (orders[0]?.id) {
    const { data: o } = await admin2.from("orders").select("workspace_id").eq("id", orders[0].id).limit(1).single();
    if (o) {
      const { idToTitle } = await loadVariantMap(admin2, o.workspace_id);
      variantTitleMap = idToTitle;
    }
  }

  const orderListFormatted = orders.slice(0, 5).map(o => {
    const date = new Date(o.created_at);
    const monthDay = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const rawItems = (o.line_items as { title?: string; variant_id?: string }[] || []);
    const items = rawItems.map(i => {
      const base = i.title || "item";
      const vTitle = i.variant_id && variantTitleMap ? variantTitleMap.get(i.variant_id) : null;
      return vTitle ? `${base} — ${vTitle}` : base;
    });
    if (useHtml) {
      return `<p><b>${monthDay}</b> - $${(o.total_cents / 100).toFixed(2)}</p><ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>`;
    }
    return `${monthDay} - $${(o.total_cents / 100).toFixed(2)}\n  ${items.join(", ")}`;
  }).join(useHtml ? "" : "\n\n");

  const response = `I can see you have several recent orders on your account. Which one are you referring to?\n\n${orderListFormatted}`;

  const orderIdsForNote = orders.slice(0, 5).map(o => o.order_number).join(", ");
  return { action: "respond", response, context: { order_list_shown: true }, systemNote: `[Playbook] ${orders.length} orders found (${orderIdsForNote}). Asking customer to identify.` };
}

async function handleIdentifySubscription(
  subs: SubscriptionData[], orders: OrderData[], ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  const identifiedOrders = (ctx.identified_orders as string[]) || [];
  if (!identifiedOrders.length) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] No identified orders, skipping sub lookup." };
  }

  // Find subscription that generated the identified order(s)
  // Match by checking if subscription items overlap with order line items
  const identifiedOrder = orders.find(o => identifiedOrders.includes(o.order_number));
  const orderItems = (identifiedOrder?.line_items as { title?: string; sku?: string; product_id?: string }[] || []);
  const orderSkus = new Set(orderItems.map(i => (i.sku || "").toUpperCase()).filter(Boolean));
  const orderTitles = new Set(orderItems.map(i => (i.title || "").toLowerCase()).filter(Boolean));

  // Also check subscription_id on the order directly
  let matchedSub: SubscriptionData | undefined;
  if (identifiedOrder?.subscription_id) {
    matchedSub = subs.find(s => s.id === identifiedOrder.subscription_id);
  }

  // Fall back to item matching
  if (!matchedSub) {
    const allSubs = [...subs.filter(s => s.status === "active" || s.status === "paused"), ...subs.filter(s => s.status === "cancelled")];
    for (const sub of allSubs) {
      const subItems = (sub.items as { title?: string; sku?: string }[] || []);
      const hasMatch = subItems.some(si => {
        if (si.sku && orderSkus.has(si.sku.toUpperCase())) return true;
        if (si.title && orderTitles.has(si.title.toLowerCase())) return true;
        return false;
      });
      if (hasMatch) { matchedSub = sub; break; }
    }
  }

  // Last resort: first active sub
  if (!matchedSub) matchedSub = subs.filter(s => s.status === "active")[0] || subs[0];

  if (matchedSub) {
    const subCreated = (matchedSub as SubscriptionData & { subscription_created_at?: string }).subscription_created_at || matchedSub.created_at;
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_subscription: matchedSub.shopify_contract_id, subscription_status: matchedSub.status, subscription_created: subCreated },
      systemNote: `[Playbook] Matched subscription #${matchedSub.shopify_contract_id} (${matchedSub.status}, created ${new Date(subCreated).toLocaleDateString()}).`,
    };
  }

  return {
    action: "advance", newStep: step.step_order + 1,
    context: { identified_subscription: null },
    systemNote: "[Playbook] No matching subscription found.",
  };
}

async function handleCheckOtherSubs(
  subs: SubscriptionData[], ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null,
): Promise<PlaybookExecResult> {
  const identifiedSub = ctx.identified_subscription as string | undefined;
  const otherActive = subs.filter(s => s.status === "active" && s.shopify_contract_id !== identifiedSub);

  return {
    action: "advance", newStep: step.step_order + 1,
    context: { other_active_subs: otherActive.map(s => s.shopify_contract_id), other_active_count: otherActive.length },
    systemNote: `[Playbook] ${otherActive.length} other active subscription(s) found.`,
  };
}

async function handleApplyPolicy(
  admin: Admin, wsId: string,
  policy: PlaybookPolicy, orders: OrderData[], subs: SubscriptionData[],
  ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
  customerMessage = "",
): Promise<PlaybookExecResult> {
  const identifiedOrders = (ctx.identified_orders as string[]) || [];
  const orderObjs = orders.filter(o => identifiedOrders.includes(o.order_number));
  const identifiedSub = ctx.identified_subscription as string | undefined;
  const subCreated = ctx.subscription_created as string | undefined;
  const subStatus = ctx.subscription_status as string | undefined;

  // ── Handle 30-day money back flow continuation ──
  if (ctx._30day_eligible && ctx._30day_phase) {
    return handle30DayFlow(admin, wsId, orders, ctx, step, customerMessage, pers);
  }

  // Evaluate each order against policy conditions
  const inPolicy: string[] = [];
  const outOfPolicy: string[] = [];
  const failureReasons: string[] = [];

  for (const o of orderObjs) {
    const eligible = evaluateConditions(policy.conditions, o);
    if (eligible) {
      inPolicy.push(o.order_number);
    } else {
      outOfPolicy.push(o.order_number);
      const reasons: string[] = [];
      const daysSince = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000);
      const src = o.source_name || "";
      for (const [key, rule] of Object.entries(policy.conditions)) {
        const r = rule as Record<string, unknown>;
        if ((key === "days_since_order" || key === "days_since_fulfillment" || key === "days_since_delivery") && r["<="] && daysSince > Number(r["<="])) {
          reasons.push(`outside ${r["<="]}‑day return window (${daysSince} days ago)`);
        }
        if (key === "source_name" && r["not_contains"] && src.toLowerCase().includes(String(r["not_contains"]).toLowerCase())) {
          reasons.push(`recurring subscription order`);
        }
      }
      failureReasons.push(`${o.order_number}: ${reasons.join("; ") || "does not meet policy conditions"}`);
    }
  }

  // ── 30-day money back guarantee flow ──
  // If ANY identified orders are in-policy checkout orders ≤30 days, use the save-first flow for those
  // Out-of-policy renewal orders are denied with no exception offers
  const inPolicyObjs = orderObjs.filter(o => inPolicy.includes(o.order_number));
  const checkoutInPolicy = inPolicyObjs.filter(o => {
    const src = (o.source_name || "").toLowerCase();
    const isCheckout = !src.includes("subscription") || src.includes("checkout");
    const days = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000);
    return isCheckout && days <= 30;
  });

  if (checkoutInPolicy.length > 0 && !ctx._30day_flow_skipped) {
    // If there are also out-of-policy renewals, note that they don't qualify
    if (outOfPolicy.length > 0) {
      ctx._renewal_orders_denied = outOfPolicy;
      ctx._no_exception_for_renewals = true; // firm rule: no escalation on renewals when first order gets 30-day return
    }
    // Use the in-policy checkout orders for the 30-day flow
    ctx.identified_orders = checkoutInPolicy.map(o => o.order_number);
    const allCheckout = true;
    const allWithin30 = true;

    if (allCheckout && allWithin30) {
      // Get product IDs from the order for review matching
      // Resolve product IDs from variant IDs (line items may not have product_id)
      const variantIds = orderObjs.flatMap(o =>
        ((o.line_items as { variant_id?: string; product_id?: string }[]) || [])
          .map(i => i.product_id || i.variant_id).filter(Boolean)
      );
      const productIds: string[] = [];
      if (variantIds.length) {
        const { data: prods } = await admin.from("products").select("shopify_product_id, variants").eq("workspace_id", wsId);
        for (const p of prods || []) {
          for (const v of (p.variants as { id?: string }[]) || []) {
            if (variantIds.includes(String(v.id))) {
              productIds.push(p.shopify_product_id);
              break;
            }
          }
        }
      }

      const renewalDeniedNote = (ctx._renewal_orders_denied as string[] | undefined)?.length
        ? `</p><p>Regarding your renewal order${(ctx._renewal_orders_denied as string[]).length > 1 ? "s" : ""} — subscription renewal orders are not eligible for return under our policy, so I won't be able to process a refund on ${(ctx._renewal_orders_denied as string[]).length > 1 ? "those" : "that one"}.`
        : "";

      return {
        action: "respond",
        context: {
          _30day_eligible: true,
          _30day_order_numbers: checkoutInPolicy.map(o => o.order_number),
          _30day_product_ids: productIds,
          _30day_phase: "ask_reason",
          _renewal_orders_denied: ctx._renewal_orders_denied,
          _no_exception_for_renewals: ctx._no_exception_for_renewals,
        },
        response: wrapResponse(
          `<p>I'm here to help! I see your first order qualifies for our 30-day money back guarantee. Before I set that up, can you share what isn't working for you? I'd love to see if there's anything we can do to help.${renewalDeniedNote}</p>`,
          pers, !ctx.playbook_intro_sent,
        ),
        systemNote: `[Playbook] Order(s) ${inPolicy.join(", ")} qualify for 30-day money back guarantee. Asking for reason before processing.`,
      };
    }
  }

  // Check if playbook was resumed after cancel journey (brief format with link)
  if (ctx.cancel_journey_completed) {
    const policyLink = policy.policy_url ? ` Our policies (${policy.policy_url}) state that` : " Our policies state that";
    const isRecurring = failureReasons.some(r => r.includes("recurring"));
    const isExpired = failureReasons.some(r => r.includes("return window"));

    let briefReason = "this order does not qualify for return.";
    if (isRecurring) briefReason = "renewal orders are not eligible for return.";
    else if (isExpired) briefReason = "this order is outside the return window.";

    const cancelConfirm = subStatus === "cancelled" || ctx.subscription_cancelled
      ? " I can confirm that your subscription is cancelled and no more orders will be shipped."
      : "";

    const response = `I'm looking at your account and the order you are having an issue with.${policyLink} ${briefReason} I won't be able to approve a return request since the order you mentioned is a recurring order.${cancelConfirm}`;

    return {
      action: "advance", newStep: step.step_order + 1, response,
      context: { in_policy: inPolicy, out_of_policy: outOfPolicy, policy_applied: policy.name, failure_reasons: failureReasons, policy_explained_post_cancel: true },
      systemNote: `[Playbook] Policy "${policy.name}" (brief, post-cancel): ${inPolicy.length} in-policy, ${outOfPolicy.length} out-of-policy. Advancing to exception flow.`,
    };
  }

  // ── Build deterministic timeline ──
  const timelineEvents: { date: Date; label: string }[] = [];

  // Resolve customer ID for event queries
  const customerId = orderObjs[0] ? await (async () => {
    const { data: o } = await admin.from("orders").select("customer_id").eq("order_number", orderObjs[0].order_number).eq("workspace_id", wsId).single();
    return o?.customer_id;
  })() : null;

  // Find the billing interval that was active BEFORE the most recent order
  // Check for interval changes — the current interval might not be what was used for the charge
  let originalInterval = "";
  const sub = subs.find(s => s.shopify_contract_id === identifiedSub);
  if (sub) {
    originalInterval = `${sub.billing_interval_count} ${sub.billing_interval}${sub.billing_interval_count > 1 ? "s" : ""}`;
  }

  // Check if interval was changed AFTER the order date
  const lastOrderDate = orderObjs[0] ? new Date(orderObjs[0].created_at) : null;
  let intervalChangedAfterOrder = false;
  if (customerId && lastOrderDate) {
    const { data: intervalChanges } = await admin.from("customer_events")
      .select("summary, created_at")
      .eq("workspace_id", wsId).eq("customer_id", customerId)
      .eq("event_type", "subscription.billing-interval-changed")
      .gte("created_at", lastOrderDate.toISOString())
      .order("created_at", { ascending: true }).limit(1);

    if (intervalChanges?.length) {
      // The current interval was set AFTER the order — find what it was before
      // Parse the old interval from the change: "Billing interval changed to WEEK / 8"
      const changeSummary = intervalChanges[0].summary || "";
      const currentMatch = changeSummary.match(/changed to (\w+)\s*\/\s*(\d+)/i);
      if (currentMatch) {
        const currentCount = parseInt(currentMatch[2]);
        const currentUnit = currentMatch[1].toLowerCase();
        // The order was billed under the PREVIOUS interval, not this one
        // We know the current interval from the sub, so the old one was different
        // Use a reasonable guess based on common patterns
        if (currentCount !== sub?.billing_interval_count) {
          // The interval changed — describe using the original (pre-change) interval
          // For the timeline description, note it was different
          intervalChangedAfterOrder = true;
        }
      }
    }
  }

  // Subscription created
  if (subCreated) {
    const items = sub ? (sub.items as { title?: string }[] || []).map(i => i.title || "item").join(" and ") : "your products";
    // If interval was changed after the order, we note the original interval in the subscription description
    // Use the current interval as the description (it's what the customer has now)
    const intervalDesc = originalInterval || "a recurring schedule";
    timelineEvents.push({
      date: new Date(subCreated),
      label: `You checked out on our website and selected the subscribe and save option. That created your first order and set up a recurring subscription for ${items}. You can always cancel a subscription anytime, but if you cancel after an order is made, it will stop future orders but can't stop an order that's already processed.`,
    });
  }

  // Summarize renewal orders (don't list each one individually)
  if (customerId && identifiedSub) {
    const { data: allOrders } = await admin.from("orders")
      .select("created_at")
      .eq("workspace_id", wsId)
      .eq("customer_id", customerId)
      .eq("subscription_id", sub?.id || "___")
      .order("created_at", { ascending: true });
    // First order is the checkout, rest are renewals
    const renewals = (allOrders || []).slice(1);
    if (renewals.length > 0) {
      const lastRenewal = renewals[renewals.length - 1];
      const lastDate = new Date(lastRenewal.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric" });
      timelineEvents.push({
        date: new Date(lastRenewal.created_at),
        label: renewals.length === 1
          ? `Your renewal order processed.`
          : `Since then, you've had ${renewals.length} renewal orders, with the most recent on ${lastDate}.`,
      });
    }
  } else {
    // Fallback: just show the identified order
    for (const o of orderObjs) {
      timelineEvents.push({ date: new Date(o.created_at), label: "Your renewal order processed." });
    }
  }

  // Key subscription status changes (paused, frequency changes — NOT cancel reasons or portal internals)
  if (customerId) {
    const { data: events } = await admin.from("customer_events")
      .select("event_type, summary, created_at")
      .eq("workspace_id", wsId)
      .eq("customer_id", customerId)
      .in("event_type", ["subscription.paused", "subscription.activated", "subscription.billing-interval-changed"])
      .order("created_at", { ascending: true })
      .limit(10);

    for (const ev of events || []) {
      const type = ev.event_type;
      let label = "";
      if (type === "subscription.paused") label = "Your subscription was paused.";
      else if (type === "subscription.activated") label = "Your subscription was resumed.";
      else if (type === "subscription.billing-interval-changed") label = translateIntervals(ev.summary || "Delivery frequency changed.");
      if (label) timelineEvents.push({ date: new Date(ev.created_at), label });
    }
  }

  // Subscription cancelled (single clean line)
  if (subStatus === "cancelled") {
    if (customerId) {
      const { data: cancelEvent } = await admin.from("customer_events")
        .select("created_at")
        .eq("workspace_id", wsId)
        .eq("customer_id", customerId)
        .eq("event_type", "subscription.cancelled")
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();

      timelineEvents.push({
        date: cancelEvent ? new Date(cancelEvent.created_at) : new Date(),
        label: "You cancelled your subscription. No more future orders will be sent.",
      });
    }
  }

  // Sort by date, deduplicate same-day same-label events
  timelineEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
  const deduped: typeof timelineEvents = [];
  for (const ev of timelineEvents) {
    const dateKey = ev.date.toISOString().split("T")[0];
    const exists = deduped.some(d => d.date.toISOString().split("T")[0] === dateKey && d.label === ev.label);
    if (!exists) deduped.push(ev);
  }
  const finalEvents = deduped;

  const channel = (ctx._channel as string) || "email";
  const useHtml = ["email", "chat", "help_center"].includes(channel);

  let timeline: string;
  if (useHtml) {
    timeline = finalEvents.map(e => {
      const dateStr = e.date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      return `<p><b>${dateStr}</b><br>${e.label}</p>`;
    }).join("");
  } else {
    timeline = finalEvents.map(e => {
      const dateStr = e.date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      return `${dateStr}\n${e.label}`;
    }).join("\n\n");
  }

  // Build the response: intro + timeline + other subs note
  const otherSubs = Number(ctx.other_active_count) || 0;
  let response = `I've reviewed your account and want to walk you through what's going on with your recent order.\n\n${timeline}`;

  if (subStatus !== "cancelled" && identifiedSub) {
    response += `\n\nIf you'd like to stop receiving these orders, I'm able to help you cancel or modify that subscription.`;
  }

  if (otherSubs > 0) {
    response += `\n\nI also noticed you have ${otherSubs} other active subscription${otherSubs > 1 ? "s" : ""} on your account.`;
  }

  // ── In-policy orders: offer return directly (no exception needed) ──
  // BUT check if in-policy return is blocked (e.g. chargeback on this specific order)
  if (inPolicy.length > 0 && outOfPolicy.length === 0 && ctx.in_policy_blocked) {
    response += `\n\nWe are unable to process a return for this order at this time.`;
    return {
      action: "respond", response,
      context: { in_policy: inPolicy, out_of_policy: outOfPolicy, policy_applied: policy.name, in_policy_blocked: true },
      systemNote: `[Playbook] In-policy return blocked: ${ctx.in_policy_block_reason}. Not offering return.`,
    };
  }

  if (inPolicy.length > 0 && outOfPolicy.length === 0) {
    // All identified orders qualify — offer return with rate quote
    const order = orderObjs.find(o => inPolicy.includes(o.order_number));
    let rateInfo = "";
    let rateCtx: Record<string, unknown> = {};

    if (order) {
      try {
        const { getReturnShippingRate, isTestMode } = await import("@/lib/easypost");
        const testMode = await isTestMode(wsId);
        const addr = await resolveOrderShippingAddress(admin, order.id);

        if (addr) {
          const lineItems = (order.line_items as { sku?: string; quantity?: number }[]) || [];
          const { data: products } = await admin.from("products").select("variants").eq("workspace_id", wsId);
          const weightItems = lineItems.map(li => {
            for (const p of products || []) {
              const variants = (p.variants || []) as { sku?: string; weight?: number }[];
              const v = variants.find(v => v.sku === li.sku);
              if (v?.weight) return { title: li.sku || "item", weight: v.weight, weightUnit: "POUNDS" as const, quantity: li.quantity || 1 };
            }
            return { title: li.sku || "item", weight: 0, weightUnit: "OUNCES" as const, quantity: li.quantity || 1 };
          });

          const rate = await getReturnShippingRate(wsId, {
            customerAddress: { name: addr.name || "Customer", street1: addr.address1, city: addr.city, state: addr.state, zip: addr.zip, country: addr.country, phone: addr.phone || undefined },
            lineItems: weightItems,
          });

          const netCents = order.total_cents - rate.rate.costCents;
          rateInfo = ` I can send you a prepaid return label, and once we receive the product back, your refund will be $${(netCents / 100).toFixed(2)} ($${(order.total_cents / 100).toFixed(2)} minus $${(rate.rate.costCents / 100).toFixed(2)} shipping label). Would you like me to get that started?`;
          rateCtx = { easypost_shipment_id: rate.shipmentId, easypost_rate_id: rate.rate.id, label_cost_cents: rate.rate.costCents, net_refund_cents: netCents, order_total_cents: order.total_cents };
          if (testMode) rateInfo += " (test mode)";
        }
      } catch (err) {
        console.error("Rate quote for in-policy order failed (non-fatal):", err);
        rateInfo = " I can process a return for you — the shipping label cost will be deducted from your refund. Would you like me to get that started?";
      }
    }

    if (!rateInfo) {
      rateInfo = " I can process a return for you. Would you like me to get that started?";
    }

    response += `\n\nYour order qualifies for a return under our 30-day policy.${rateInfo}`;

    return {
      action: "respond", response,
      context: {
        in_policy: inPolicy, out_of_policy: outOfPolicy, policy_applied: policy.name, failure_reasons: failureReasons,
        in_policy_offer_made: true, resolution_type: "refund_return", exception_offered: "In-Policy Return",
        ...rateCtx,
      },
      systemNote: `[Playbook] Policy "${policy.name}": ${inPolicy.length} in-policy. Offered return directly.${rateCtx.label_cost_cents ? ` Estimated shipping: $${((rateCtx.label_cost_cents as number) / 100).toFixed(2)}` : ""}`,
    };
  }

  response += `\n\nLet me know if I can help with anything.`;

  return {
    action: "advance", newStep: step.step_order + 1, response,
    context: { in_policy: inPolicy, out_of_policy: outOfPolicy, policy_applied: policy.name, failure_reasons: failureReasons },
    systemNote: `[Playbook] Policy "${policy.name}": ${inPolicy.length} in-policy, ${outOfPolicy.length} out-of-policy. Reasons: ${failureReasons.join("; ")}. Advancing to next step.`,
  };
}

async function handleOfferException(
  exceptions: PlaybookException[], customer: CustomerData, orders: OrderData[],
  ctx: Record<string, unknown>, step: PlaybookStep, dataCtx: string,
  pers: { name?: string; tone?: string } | null,
  exceptionsUsed: number,
  playbook: { id: string; name: string; exception_limit: number; stand_firm_max: number; stand_firm_before_exceptions: number; stand_firm_between_tiers: number; exception_disqualifiers: { type: string; source?: string }[]; disqualifier_behavior: string },
  tid: string, admin: Admin,
  msg: string, policyRules: string, wsId: string,
): Promise<PlaybookExecResult> {
  const outOfPolicy = (ctx.out_of_policy as string[]) || [];
  if (outOfPolicy.length === 0) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] All orders in policy, no exception needed." };
  }

  // Rule: one return per subscription — if 30-day guarantee was used on the checkout order,
  // no exceptions allowed on renewal orders from the same subscription
  if (ctx._30day_eligible || ctx._30day_phase) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { exception_blocked_reason: "30_day_return_active" },
      systemNote: "[Playbook] Exception blocked — 30-day money back guarantee already applies to this subscription. One return per subscription.",
    };
  }

  // Check auto-grant exceptions first
  for (const ex of exceptions.filter(e => e.auto_grant)) {
    const autoGranted = checkAutoGrant(ex.auto_grant_trigger, orders, ctx);
    if (autoGranted) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { exception_granted: ex.name, exception_tier: 0, resolution_type: ex.resolution_type, auto_granted: true, offer_accepted: true },
        systemNote: `[Playbook] Auto-granted exception: ${ex.name} (${ex.auto_grant_trigger}).`,
      };
    }
  }

  // ── Check disqualifiers (silent or explicit) ──
  // Disqualifiers have a "blocks" field:
  //   "exceptions_only" — blocks exception tiers but allows in-policy returns
  //   "in_policy_return" — blocks in-policy return for the specific order (e.g. chargeback on that order)
  if (!ctx.disqualifier_checked) {
    const disqualifiers = (playbook.exception_disqualifiers || []) as { type: string; source?: string; blocks?: string }[];
    let exceptionsBlocked = false;
    let exceptionsBlockReason = "";
    let inPolicyBlocked = false;
    let inPolicyBlockReason = "";

    const identifiedOrders = (ctx.identified_orders as string[]) || [];

    for (const dq of disqualifiers) {
      const blocksTarget = dq.blocks || "exceptions_only";

      if (dq.type === "previous_exception") {
        const { count } = await admin.from("returns")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", wsId)
          .eq("customer_id", customer.id)
          .eq("source", dq.source || "playbook")
          .not("status", "eq", "cancelled");
        if ((count || 0) > 0) {
          if (blocksTarget === "in_policy_return") {
            inPolicyBlocked = true;
            inPolicyBlockReason = "Customer has a previous playbook exception.";
          } else {
            exceptionsBlocked = true;
            exceptionsBlockReason = "Customer has a previous playbook exception on record.";
          }
        }
      }

      if (dq.type === "has_chargeback") {
        const { count } = await admin.from("chargeback_events")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", wsId)
          .eq("customer_id", customer.id);
        if ((count || 0) > 0) {
          if (blocksTarget === "in_policy_return") {
            inPolicyBlocked = true;
            inPolicyBlockReason = "Customer has filed a chargeback.";
          } else {
            exceptionsBlocked = true;
            exceptionsBlockReason = "Customer has filed a chargeback.";
          }
        }
      }

      if (dq.type === "has_chargeback_on_order" && identifiedOrders.length > 0) {
        // Check if any of the identified orders have a chargeback
        for (const orderNum of identifiedOrders) {
          const { data: order } = await admin.from("orders")
            .select("shopify_order_id")
            .eq("order_number", orderNum)
            .eq("workspace_id", wsId).single();
          if (order) {
            const { count } = await admin.from("chargeback_events")
              .select("id", { count: "exact", head: true })
              .eq("workspace_id", wsId)
              .eq("shopify_order_id", order.shopify_order_id);
            if ((count || 0) > 0) {
              inPolicyBlocked = true;
              inPolicyBlockReason = `Chargeback filed on order ${orderNum}.`;
              break;
            }
          }
        }
      }
    }

    ctx.disqualifier_checked = true;
    ctx.exceptions_blocked = exceptionsBlocked;
    ctx.exceptions_block_reason = exceptionsBlockReason;
    ctx.in_policy_blocked = inPolicyBlocked;
    ctx.in_policy_block_reason = inPolicyBlockReason;

    if (exceptionsBlocked) {
      ctx.disqualified = true;
      ctx.exception_exhausted = true;
    }
  }

  // If exceptions are blocked, skip to stand firm (but in-policy returns may still work via handleApplyPolicy)
  if (ctx.disqualified && !ctx.in_policy_offer_made) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { exception_exhausted: true },
      systemNote: `[Playbook] Customer disqualified from exceptions: ${ctx.exceptions_block_reason}. In-policy returns ${ctx.in_policy_blocked ? "also blocked" : "still allowed"}. Stand firm.`,
    };
  }

  const currentTier = Number(ctx.current_exception_tier) || 0;

  // ── If we already offered an exception, check acceptance ──
  if (currentTier > 0 && ctx.exception_offered) {
    const accepted = detectAcceptance(msg);
    if (accepted) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { offer_accepted: true },
        systemNote: `[Playbook] Customer accepted exception: ${ctx.exception_offered} (${ctx.resolution_type}).`,
      };
    }
    // Customer rejected — need stand firm rounds before next tier
  }

  // ── Stand firm rounds before offering exception ──
  const preExceptionRounds = playbook.stand_firm_before_exceptions || 0;
  const betweenTierRounds = playbook.stand_firm_between_tiers || 0;
  const sfCount = Number(ctx.exception_stand_firm_count) || 0;

  // Determine required stand firm rounds for current phase
  const requiredRounds = currentTier === 0 ? preExceptionRounds : betweenTierRounds;

  if (sfCount < requiredRounds) {
    // Need more stand firm rounds before escalating
    const bestOffer = ctx.exception_offered as string || "policy";
    const resType = ctx.resolution_type as string || "";
    const resLabel = resType.includes("refund") ? "refund" : resType.includes("credit") ? "store credit" : "policy";

    // Get policy URL for stand firm messages
    const sfPolicyId = step.config?.policy_id as string | undefined;
    let sfPolicyUrl = "";
    if (sfPolicyId) {
      const { data: pol } = await admin.from("playbook_policies").select("policy_url").eq("id", sfPolicyId).single();
      if (pol?.policy_url) sfPolicyUrl = `\nInclude this policy link in your response: ${pol.policy_url}`;
    }

    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer message: "${msg}"\n\n${currentTier === 0
        ? `CRITICAL: The customer's order is out of policy. You have NOT offered any exception. Restate ONLY that the order does not qualify under the store policy. Keep it to 2-3 sentences. Use different wording than previous messages.${sfPolicyUrl}`
        : `CRITICAL: The customer rejected the ${bestOffer} offer (${resLabel}). Restate ONLY the ${bestOffer} offer with different wording. Do NOT mention any other option.`
      } Acknowledge frustration briefly (one sentence max), then restate the current position. Do not argue or get defensive.`,
    );

    return {
      action: "respond", response,
      context: { exception_stand_firm_count: sfCount + 1 },
      systemNote: `[Playbook] Pre-exception stand firm ${sfCount + 1}/${requiredRounds} (tier ${currentTier}).`,
    };
  }

  // Reset stand firm counter for next phase
  ctx.exception_stand_firm_count = 0;

  // ── Find next eligible tier ──
  const tieredExceptions = exceptions.filter(e => !e.auto_grant && e.tier > currentTier);

  if (tieredExceptions.length === 0 || exceptionsUsed >= playbook.exception_limit) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { exception_exhausted: true, exception_stand_firm_count: 0 },
      systemNote: `[Playbook] ${tieredExceptions.length === 0 ? "All exception tiers exhausted" : `Exception limit reached (${exceptionsUsed}/${playbook.exception_limit})`}. Moving to stand firm.`,
    };
  }

  // Find first eligible tier
  for (const ex of tieredExceptions) {
    if (evaluateCustomerConditions(ex.conditions, customer)) {
      return offerException(ex, outOfPolicy, step, dataCtx, pers, exceptionsUsed, playbook.exception_limit, tid, admin, policyRules, wsId, orders);
    }
  }

  // No eligible tiers
  return {
    action: "advance", newStep: step.step_order + 1,
    context: { exception_exhausted: true, exception_stand_firm_count: 0 },
    systemNote: `[Playbook] Customer doesn't meet conditions for any remaining exception tier.`,
  };
}

async function offerException(
  ex: PlaybookException, outOfPolicy: string[], step: PlaybookStep, dataCtx: string,
  pers: { name?: string; tone?: string } | null,
  exceptionsUsed: number, exceptionLimit: number, tid: string, admin: Admin, policyRules: string,
  wsId: string, orders: OrderData[],
): Promise<PlaybookExecResult> {
  const mostRecentOutOfPolicy = outOfPolicy[outOfPolicy.length - 1];
  const isEscalation = Number(ex.tier) > 1;

  // Get shipping rate quote if this is a return-type resolution
  let rateQuoteInfo = "";
  let rateContext: Record<string, unknown> = {};
  const requiresReturn = ex.resolution_type.includes("return");

  if (requiresReturn) {
    const order = orders.find(o => o.order_number === mostRecentOutOfPolicy);
    if (order) {
      try {
        const { getReturnShippingRate, isTestMode } = await import("@/lib/easypost");
        const testMode = await isTestMode(wsId);

        const addr = await resolveOrderShippingAddress(admin, order.id);

        if (addr) {
          const lineItems = (order.line_items as { sku?: string; quantity?: number }[]) || [];
          const { data: products } = await admin.from("products").select("variants").eq("workspace_id", wsId);

          const weightItems = lineItems.map(li => {
            for (const p of products || []) {
              const variants = (p.variants || []) as { sku?: string; weight?: number }[];
              const v = variants.find(v => v.sku === li.sku);
              if (v?.weight) return { title: li.sku || "item", weight: v.weight, weightUnit: "POUNDS" as const, quantity: li.quantity || 1 };
            }
            return { title: li.sku || "item", weight: 0, weightUnit: "OUNCES" as const, quantity: li.quantity || 1 };
          });

          const rate = await getReturnShippingRate(wsId, {
            customerAddress: {
              name: addr.name || "Customer",
              street1: addr.address1,
              city: addr.city,
              state: addr.state,
              zip: addr.zip,
              country: addr.country,
              phone: addr.phone || undefined,
            },
            lineItems: weightItems,
          });

          const orderTotalCents = order.total_cents;
          const netCents = orderTotalCents - rate.rate.costCents;
          const resLabel = ex.resolution_type.includes("refund") ? "refund" : "store credit";

          rateQuoteInfo = `\n\nShipping rate quote: $${(rate.rate.costCents / 100).toFixed(2)} (${rate.rate.carrier} ${rate.rate.service}).
Order total: $${(orderTotalCents / 100).toFixed(2)}. Estimated shipping deduction: $${(rate.rate.costCents / 100).toFixed(2)}. Estimated net ${resLabel}: $${(netCents / 100).toFixed(2)}.
Tell the customer the EXACT breakdown with these numbers. Say "approximately" since the final shipping cost may vary slightly.${testMode ? "\n(NOTE: Using EasyPost test mode — rates are simulated)" : ""}`;

          rateContext = {
            easypost_shipment_id: rate.shipmentId,
            easypost_rate_id: rate.rate.id,
            label_cost_cents: rate.rate.costCents,
            net_refund_cents: netCents,
            order_total_cents: orderTotalCents,
          };
        }
      } catch (err) {
        console.error("Rate quote failed (non-fatal):", err);
        rateQuoteInfo = "\n\nShipping rate quote unavailable. Tell the customer a return shipping label will be provided and the cost will be deducted from their refund/credit.";
      }
    }
  }

  const resLabel = ex.resolution_type.includes("refund") ? "refund" : "store credit";
  const netAmount = rateContext.net_refund_cents ? `$${((rateContext.net_refund_cents as number) / 100).toFixed(2)}` : "";
  const orderAmount = rateContext.order_total_cents ? `$${((rateContext.order_total_cents as number) / 100).toFixed(2)}` : "";
  const labelAmount = rateContext.label_cost_cents ? `$${((rateContext.label_cost_cents as number) / 100).toFixed(2)}` : "";
  const mathBreakdown = netAmount && orderAmount && labelAmount ? `${netAmount} (${orderAmount} - ${labelAmount} shipping label)` : "";

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nException: "${ex.name}" (${resLabel})\n${ex.instructions || ""}\n\n${isEscalation
      ? `FRAMING: Say "I was able to get this upgraded" — present as an escalated offer. Do NOT mention any other options exist.`
      : `FRAMING: Say "I was able to get a one-time return exception approved" for their specific situation. Do NOT hint that better alternatives exist.`
    }\n\nFORMAT: Write ONE paragraph only. Include these key phrases: "in your situation", "one-time", "exception". ${mathBreakdown ? `Include the exact breakdown: ${mathBreakdown}.` : ""} End with a direct yes/no question: "Would you like me to get that setup for you now?"${rateQuoteInfo}`,
  );

  await admin.from("tickets").update({ playbook_exceptions_used: exceptionsUsed + 1 }).eq("id", tid);

  return {
    action: "respond", response,
    context: { current_exception_tier: ex.tier, exception_offered: ex.name, resolution_type: ex.resolution_type, ...rateContext },
    systemNote: `[Playbook] Offered tier ${ex.tier} exception: ${ex.name} for ${mostRecentOutOfPolicy}.${rateContext.label_cost_cents ? ` Estimated shipping: $${((rateContext.label_cost_cents as number) / 100).toFixed(2)}` : ""}`,
  };
}

function detectAcceptance(msg: string): boolean {
  const lower = msg.toLowerCase();
  const acceptPatterns = /\b(yes|yeah|yep|ok|okay|sure|fine|sounds good|i('ll| will) (take|accept|do)|go ahead|let('s| us) do|that works|proceed|i('d| would) like that|deal)\b/i;
  const rejectPatterns = /\b(no|nope|not acceptable|refuse|ridiculous|unacceptable|won't|don't want|i want my money|real money|cash refund|full refund|not good enough|hell no|absolutely not|are you kidding|bs|bullshit)\b/i;
  if (rejectPatterns.test(lower)) return false;
  if (acceptPatterns.test(lower)) return true;
  return false; // Ambiguous — treat as rejection to escalate
}

async function handleInitiateReturn(
  admin: Admin, wsId: string, tid: string, customer: CustomerData,
  orders: OrderData[], ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null,
  msg: string, policyRules: string,
): Promise<PlaybookExecResult> {
  const inPolicy = (ctx.in_policy as string[]) || [];
  const exceptionOrder = ctx.exception_offered ? [(ctx.out_of_policy as string[] || []).slice(-1)[0]] : [];
  const returnable = [...new Set([...inPolicy, ...exceptionOrder])];

  if (returnable.length === 0) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] No returnable orders." };
  }

  // Gate: only proceed if customer accepted the offer
  if (!ctx.offer_accepted) {
    const accepted = detectAcceptance(msg);
    if (!accepted) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { offer_accepted: false },
        systemNote: "[Playbook] Customer hasn't accepted return offer. Skipping initiate_return.",
      };
    }
    ctx.offer_accepted = true;
  }

  const resolution = ctx.resolution_type as string || "store_credit_return";
  const resLabel = resolution.includes("refund") ? "refund" : "store credit";

  // Create returns in Shopify + buy label for each returnable order
  const { createShopifyReturn, getReturnableItems, attachReturnTracking } = await import("@/lib/shopify-returns");
  const created: string[] = [];
  const failed: string[] = [];
  let labelInfo = "";

  for (const orderNum of returnable) {
    const order = orders.find(o => o.order_number === orderNum);
    if (!order?.shopify_order_id) {
      failed.push(orderNum);
      continue;
    }

    const shopifyOrderGid = `gid://shopify/Order/${order.shopify_order_id}`;

    try {
      const items = await getReturnableItems(wsId, shopifyOrderGid);
      if (items.length === 0) {
        failed.push(orderNum);
        continue;
      }

      const returnResult = await createShopifyReturn(wsId, {
        orderId: order.id,
        orderNumber: order.order_number,
        shopifyOrderGid,
        customerId: customer.id,
        ticketId: tid,
        resolutionType: resolution as "store_credit_return" | "refund_return" | "store_credit_no_return" | "refund_no_return",
        returnLineItems: items.map(i => ({
          fulfillmentLineItemId: i.fulfillmentLineItemId,
          quantity: i.remainingQuantity,
          title: i.title,
        })),
        source: "playbook",
      });
      created.push(orderNum);

      // Buy the return label via EasyPost
      try {
        const shipmentId = ctx.easypost_shipment_id as string | undefined;
        if (shipmentId) {
          const { purchaseReturnLabel } = await import("@/lib/easypost");
          const rateId = ctx.easypost_rate_id as string | undefined;
          const label = await purchaseReturnLabel(wsId, shipmentId, rateId);

          // Update the return record with tracking + label
          await admin.from("returns").update({
            tracking_number: label.trackingNumber,
            carrier: label.carrier,
            label_url: label.labelUrl,
            label_cost_cents: label.costCents,
            net_refund_cents: (ctx.order_total_cents as number || order.total_cents) - label.costCents,
            easypost_shipment_id: shipmentId,
            status: "label_created",
            updated_at: new Date().toISOString(),
          }).eq("id", returnResult.returnId);

          // Attach tracking to Shopify
          await attachReturnTracking(wsId, {
            returnId: returnResult.returnId,
            trackingNumber: label.trackingNumber,
            carrier: label.carrier,
            labelUrl: label.labelUrl,
          });

          // Label is delivered inline in this same conversation (chat or email reply).
          // No separate label email — the customer is talking to us right now, so the
          // link goes directly in the response below.
          labelInfo = `\nReturn label purchased: ${label.carrier} tracking ${label.trackingNumber}. Cost: $${(label.costCents / 100).toFixed(2)}.`;
          ctx.label_url = label.labelUrl;
          ctx.label_tracking_number = label.trackingNumber;
          ctx.label_carrier = label.carrier;
        }
      } catch (labelErr) {
        console.error("Label purchase failed (non-fatal, return still created):", labelErr);
        labelInfo = "\nNote: Return created but label purchase failed. Agent may need to generate label manually.";
      }
    } catch (err) {
      console.error(`Failed to create Shopify return for ${orderNum}:`, err);
      failed.push(orderNum);
    }
  }

  if (created.length === 0) {
    return {
      action: "escalate_api_failure",
      error: `Failed to create return(s) in Shopify for: ${failed.join(", ")}`,
      systemNote: `[Playbook] All return creations failed: ${failed.join(", ")}.`,
    };
  }

  const netRefundCents = ctx.net_refund_cents as number | undefined;
  const labelCostCents = ctx.label_cost_cents as number | undefined;
  const labelUrl = ctx.label_url as string | undefined;
  const breakdownInfo = netRefundCents && labelCostCents
    ? `\nApproximate breakdown: order $${((ctx.order_total_cents as number) / 100).toFixed(2)} minus ~$${(labelCostCents / 100).toFixed(2)} shipping = ~$${(netRefundCents / 100).toFixed(2)} ${resLabel}.`
    : "";
  const labelLinkInfo = labelUrl
    ? `\nA return shipping label has been generated. Include this exact download link in your response so the customer can click it directly: ${labelUrl}\nDO NOT say "I emailed you the label" or "check your inbox" — the link is right here in this reply.`
    : "\nNote: a label could not be generated automatically. Tell the customer an agent will follow up with the label shortly. Do NOT claim a label was emailed.";

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nOrders with return created: ${created.join(", ")}\n${failed.length ? `Orders that failed: ${failed.join(", ")}\n` : ""}Resolution: ${resLabel}${breakdownInfo}${labelLinkInfo}\n\nThe customer has accepted the ${resLabel} offer. Confirm the return is set up. Provide the label link inline. Tell them to print the label, attach it to the package, and drop it off. Once we receive the item, their ${resLabel} will be processed. Follow the store policy rules.`,
  );

  return {
    action: "advance", newStep: step.step_order + 1, response,
    context: { return_initiated: true, return_orders: created, return_failed: failed, offer_accepted: true },
    systemNote: `[Playbook] Return created in Shopify for: ${created.join(", ")}.${labelInfo} ${failed.length ? `Failed: ${failed.join(", ")}.` : ""} Resolution: ${resolution}.`,
  };
}

async function handleCancelSubscription(
  admin: Admin, wsId: string, subs: SubscriptionData[], ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  const identifiedSub = ctx.identified_subscription as string | undefined;
  const otherActive = (ctx.other_active_subs as string[]) || [];
  const allToCancel = identifiedSub ? [identifiedSub, ...otherActive] : otherActive;

  if (allToCancel.length === 0) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] No subscriptions to cancel." };
  }

  // Cancel via Appstle
  const { appstleSubscriptionAction } = await import("@/lib/appstle");
  const cancelled: string[] = [];
  const failed: string[] = [];

  for (const contractId of allToCancel) {
    const result = await appstleSubscriptionAction(wsId, contractId, "cancel", "Customer requested via playbook", "AI Playbook");
    if (result.success) cancelled.push(contractId);
    else failed.push(contractId);
  }

  if (failed.length) {
    return {
      action: "escalate_api_failure",
      error: `Failed to cancel subscription(s): ${failed.join(", ")}`,
      systemNote: `[Playbook] Cancelled: ${cancelled.join(", ")}. Failed: ${failed.join(", ")}.`,
      context: { subs_cancelled: cancelled, subs_failed: failed },
    };
  }

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nCancelled subscriptions: ${cancelled.join(", ")}\n\nConfirm the cancellation. If there were multiple, list them all. Reassure them they won't be charged again.`,
  );

  return {
    action: "advance", newStep: step.step_order + 1, response,
    context: { subs_cancelled: cancelled },
    systemNote: `[Playbook] Cancelled ${cancelled.length} subscription(s): ${cancelled.join(", ")}.`,
  };
}

async function handleIssueStoreCredit(
  admin: Admin, wsId: string, customer: CustomerData, orders: OrderData[],
  ctx: Record<string, unknown>, step: PlaybookStep, tid: string,
): Promise<PlaybookExecResult> {
  // Store credit amount from the return orders
  const returnOrders = (ctx.return_orders as string[]) || [];
  const orderObjs = orders.filter(o => returnOrders.includes(o.order_number));
  const totalCents = orderObjs.reduce((s, o) => s + o.total_cents, 0);

  // This will be automated via returns tracking — for now, log intent
  return {
    action: "advance", newStep: step.step_order + 1,
    context: { store_credit_pending: totalCents },
    systemNote: `[Playbook] Store credit of $${(totalCents / 100).toFixed(2)} pending return receipt for orders: ${returnOrders.join(", ")}.`,
  };
}

async function handleStandFirm(
  ctx: Record<string, unknown>, step: PlaybookStep, maxReps: number,
  msg: string, dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  const reps = Number(ctx.stand_firm_count) || 0;

  const bestOffer = ctx.exception_offered as string | undefined;
  const resType = ctx.resolution_type as string || "";
  const resLabel = resType.includes("refund") ? "full refund" : resType.includes("credit") ? "store credit" : "";
  const netAmount = ctx.net_refund_cents ? `$${((ctx.net_refund_cents as number) / 100).toFixed(2)}` : "";
  const orderAmount = ctx.order_total_cents ? `$${((ctx.order_total_cents as number) / 100).toFixed(2)}` : "";
  const labelAmount = ctx.label_cost_cents ? `$${((ctx.label_cost_cents as number) / 100).toFixed(2)}` : "";
  const mathBreakdown = netAmount && orderAmount && labelAmount ? `${netAmount} (${orderAmount} - ${labelAmount} shipping label)` : "";

  if (reps >= maxReps) {
    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer message: "${msg}"\n\nThis is the FINAL message (${maxReps} attempts reached).\n\nFORMAT: ONE sentence about the offer + ONE sentence leaving the door open. Example: "This is the best I'm able to offer for your situation. Your ${resLabel} would be ${mathBreakdown || "processed"} once we receive the product back. If you change your mind, just reply and I'll get it started for you."`,
    );
    return {
      action: "complete", response,
      context: { stand_firm_count: reps + 1, stand_firm_final: true },
      systemNote: `[Playbook] Stand firm max reached (${maxReps}). Final message sent.`,
    };
  }

  // Build the right stand firm prompt based on whether an exception has been offered
  let standFirmPrompt: string;
  if (!bestOffer) {
    // Pre-exception: just restate policy
    standFirmPrompt = `Customer message: "${msg}"\n\nCRITICAL: No exception has been offered. You CANNOT offer anything. Restate ONLY the policy position. Do NOT mention store credit, refund, exception, or any future options. Do NOT say "let me check" or "let me review." Keep to 2-3 sentences max.`;
  } else {
    // Post-exception: restate current offer with policy contrast
    standFirmPrompt = `Customer message: "${msg}"\n\nFORMAT: ONE paragraph. Start with policy contrast: "While it's not in our policy to allow returns on recurring orders, I was able to get a one-time exception approved in your situation." Then restate the offer: ${resLabel} for ${mathBreakdown || "the order amount minus shipping"}. End with: "Would you like me to get that setup for you now?" Do NOT mention any other option. Do NOT repeat order details or subscription info.`;
  }

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    standFirmPrompt,
  );

  return {
    action: "respond", response,
    context: { stand_firm_count: reps + 1 },
    systemNote: `[Playbook] Stand firm ${reps + 1}/${maxReps}. ${bestOffer ? `Restating: ${bestOffer}` : "Policy only."}`,
  };
}

async function handleGenericStep(
  step: PlaybookStep, dataCtx: string, msg: string,
  pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\n${step.instructions || "Respond to the customer."}`,
  );
  return {
    action: "advance", newStep: step.step_order + 1, response,
    systemNote: `[Playbook] Step "${step.name}" completed.`,
  };
}

// ── Condition evaluators ──

function evaluateConditions(conditions: Record<string, unknown>, order: OrderData): boolean {
  for (const [key, rule] of Object.entries(conditions)) {
    const ruleObj = rule as Record<string, unknown>;

    if (key === "days_since_fulfillment" || key === "days_since_delivery") {
      const daysSince = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000);
      if (ruleObj["<="] && daysSince > Number(ruleObj["<="])) return false;
      if (ruleObj[">="] && daysSince < Number(ruleObj[">="])) return false;
    }

    if (key === "financial_status") {
      if (ruleObj["eq"] && order.financial_status !== ruleObj["eq"]) return false;
      if (ruleObj["in"] && !(ruleObj["in"] as string[]).includes(order.financial_status)) return false;
    }

    if (key === "source_name") {
      const src = order.source_name || "";
      if (ruleObj["not_contains"] && src.toLowerCase().includes(String(ruleObj["not_contains"]).toLowerCase())) return false;
      if (ruleObj["contains"] && !src.toLowerCase().includes(String(ruleObj["contains"]).toLowerCase())) return false;
      if (ruleObj["eq"] && src !== ruleObj["eq"]) return false;
      if (ruleObj["in"] && !(ruleObj["in"] as string[]).includes(src)) return false;
    }

    if (key === "days_since_order") {
      const daysSince = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000);
      if (ruleObj["<="] && daysSince > Number(ruleObj["<="])) return false;
      if (ruleObj[">="] && daysSince < Number(ruleObj[">="])) return false;
    }
  }
  return true;
}

function evaluateCustomerConditions(conditions: Record<string, unknown>, customer: CustomerData): boolean {
  // Handle OR conditions
  if (conditions.or && Array.isArray(conditions.or)) {
    return (conditions.or as Record<string, unknown>[]).some(c => evaluateCustomerConditions(c, customer));
  }

  for (const [key, rule] of Object.entries(conditions)) {
    if (key === "or") continue;
    const ruleObj = rule as Record<string, unknown>;

    if (key === "ltv_cents") {
      if (ruleObj[">="] && customer.ltv_cents < Number(ruleObj[">="])) return false;
      if (ruleObj["<="] && customer.ltv_cents > Number(ruleObj["<="])) return false;
    }

    if (key === "total_orders") {
      if (ruleObj[">="] && customer.total_orders < Number(ruleObj[">="])) return false;
      if (ruleObj["<="] && customer.total_orders > Number(ruleObj["<="])) return false;
    }

    if (key === "retention_score") {
      if (ruleObj[">="] && customer.retention_score < Number(ruleObj[">="])) return false;
    }
  }
  return true;
}

function checkAutoGrant(trigger: string | null, orders: OrderData[], ctx: Record<string, unknown>): boolean {
  if (!trigger) return false;
  // Auto-grant triggers are checked against order/system data
  // These would be detected earlier in the pipeline, but check here as safety
  if (trigger === "duplicate_charge") return false; // Needs separate detection
  if (trigger === "cancelled_but_charged") return false; // Needs sub cancellation date vs order date check
  if (trigger === "never_delivered") return false; // Needs fulfillment/tracking check
  return false;
}

// ── Summary builder ──

function buildPlaybookSummary(
  playbookName: string, ctx: Record<string, unknown>,
  customer: CustomerData, exceptionsUsed: number,
): string {
  const lines: string[] = [];

  // Orders
  const orders = (ctx.identified_orders as string[]) || [];
  if (orders.length) lines.push(`Orders: ${orders.join(", ")}`);

  // Policy
  if (ctx.policy_applied) {
    const inPolicy = (ctx.in_policy as string[]) || [];
    const outOfPolicy = (ctx.out_of_policy as string[]) || [];
    lines.push(`Policy: ${ctx.policy_applied}`);
    if (inPolicy.length) lines.push(`  In policy: ${inPolicy.join(", ")}`);
    if (outOfPolicy.length) lines.push(`  Out of policy: ${outOfPolicy.join(", ")}`);
    if (ctx.failure_reasons) lines.push(`  Reasons: ${(ctx.failure_reasons as string[]).join("; ")}`);
  }

  // Exception
  if (ctx.exception_offered) {
    const accepted = ctx.offer_accepted ? "ACCEPTED" : ctx.exception_exhausted ? "ALL REJECTED" : "OFFERED";
    lines.push(`Exception: ${ctx.exception_offered} (Tier ${ctx.current_exception_tier}) — ${accepted}`);
    lines.push(`  Resolution: ${ctx.resolution_type || "none"}`);
    lines.push(`  Exceptions used: ${exceptionsUsed}`);
  }

  // Return
  if (ctx.return_initiated) {
    lines.push(`Return: Initiated for ${(ctx.return_orders as string[] || []).join(", ")}`);
  }

  // Subscription
  if (ctx.subs_cancelled) {
    lines.push(`Subscriptions cancelled: ${(ctx.subs_cancelled as string[]).join(", ")}`);
  } else if (ctx.identified_subscription) {
    lines.push(`Subscription: #${ctx.identified_subscription} (${ctx.subscription_status || "unknown"})`);
  }

  // Stand firm
  if (ctx.stand_firm_count) {
    lines.push(`Stand firm: ${ctx.stand_firm_count} rounds${ctx.stand_firm_final ? " (reached max, ticket left pending)" : ""}`);
  }

  // Customer
  lines.push(`Customer: ${customer.first_name || ""} ${customer.last_name || ""} (${customer.email})`);
  lines.push(`LTV: $${(customer.ltv_cents / 100).toFixed(2)} | Orders: ${customer.total_orders}`);

  return lines.join("\n");
}

// ── Playbook matcher ──

export async function matchPlaybook(
  admin: Admin, wsId: string, intent: string, msg: string,
): Promise<{ id: string; name: string } | null> {
  const { data: playbooks } = await admin.from("playbooks")
    .select("id, name, trigger_intents, trigger_patterns")
    .eq("workspace_id", wsId)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  for (const pb of playbooks || []) {
    // Check intent match
    if ((pb.trigger_intents as string[]).some(ti => intent.toLowerCase().includes(ti.toLowerCase()))) {
      return { id: pb.id, name: pb.name };
    }
    // Check pattern match
    if ((pb.trigger_patterns as string[]).some(p => msg.toLowerCase().includes(p.toLowerCase()))) {
      return { id: pb.id, name: pb.name };
    }
  }
  return null;
}

// ── Start a playbook on a ticket ──

export async function startPlaybook(
  admin: Admin, ticketId: string, playbookId: string,
): Promise<void> {
  const [{ data: ticket }, { data: playbook }] = await Promise.all([
    admin.from("tickets").select("tags").eq("id", ticketId).single(),
    admin.from("playbooks").select("name").eq("id", playbookId).single(),
  ]);
  const tags = (ticket?.tags as string[]) || [];
  const slug = (playbook?.name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const pbTag = `pb:${slug}`;
  const newTags = [...tags];
  if (!newTags.includes("pb")) newTags.push("pb");
  if (!newTags.includes(pbTag)) newTags.push(pbTag);

  await admin.from("tickets").update({
    active_playbook_id: playbookId,
    playbook_step: 0,
    playbook_context: {},
    playbook_exceptions_used: 0,
    tags: newTags,
  }).eq("id", ticketId);
}

// ══════════════════════════════════════════════════════════════════
// ── Replacement Helpers ──
// ══════════════════════════════════════════════════════════════════

/** Load variant data (id + title) from products table, keyed by SKU and variant ID */
async function loadVariantMap(admin: Admin, wsId: string): Promise<{ skuToId: Map<string, string>; idToTitle: Map<string, string> }> {
  const { data: products } = await admin.from("products")
    .select("variants")
    .eq("workspace_id", wsId);

  const skuToId = new Map<string, string>();
  const idToTitle = new Map<string, string>();
  for (const p of products || []) {
    for (const v of (p.variants as { id: string; sku: string; title: string }[]) || []) {
      if (v.sku) skuToId.set(v.sku, String(v.id));
      if (v.title && v.title !== "Default Title") idToTitle.set(String(v.id), v.title);
    }
  }
  return { skuToId, idToTitle };
}

/**
 * Resolve variant IDs from the products table for line items that don't have them.
 * Matches by SKU against product variants.
 */
async function resolveVariantIds(
  admin: Admin, wsId: string,
  items: { title: string; quantity: number; sku?: string; variant_id?: string }[],
): Promise<{ title: string; quantity: number; sku?: string; variant_id: string }[]> {
  const { skuToId } = await loadVariantMap(admin, wsId);

  return items.map(item => ({
    ...item,
    variant_id: item.variant_id || (item.sku ? skuToId.get(item.sku) || "" : ""),
  }));
}

/** Enrich line item titles with variant names (e.g. "Amazing Coffee" → "Amazing Coffee — Hazelnut") */
async function enrichItemTitles(
  admin: Admin, wsId: string,
  items: { title?: string; variant_id?: string }[],
): Promise<string[]> {
  const { idToTitle } = await loadVariantMap(admin, wsId);
  return items.map(i => {
    const variantTitle = i.variant_id ? idToTitle.get(i.variant_id) : null;
    const base = i.title || "item";
    return variantTitle ? `${base} — ${variantTitle}` : base;
  });
}

// ══════════════════════════════════════════════════════════════════
// ── Replacement Playbook Step Handlers ──
// ══════════════════════════════════════════════════════════════════

/**
 * clarify_issue — First question: "Did you receive your order (missing/damaged items)?
 * Or did you not receive your order at all?"
 * Sets ctx.received_order = true/false to control downstream flow.
 * If pre-populated from workflow/cron, auto-advances.
 */
async function handleClarifyIssue(
  msg: string, ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  // Pre-populated from tracking workflow/cron — skip clarification
  if (ctx.replacement_reason) {
    if (ctx.replacement_reason === "missing_items" || ctx.replacement_reason === "damaged_items") {
      ctx.received_order = true;
    } else {
      ctx.received_order = false;
    }
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Already clarified
  if (ctx.received_order !== undefined) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // First time — ask the clarification question
  if (!ctx.clarify_asked) {
    ctx.clarify_asked = true;
    return {
      action: "respond", context: ctx,
      response: "I'd like to help get this resolved for you. Could you let me know — did you receive your order and something was missing or damaged? Or did you not receive your order at all?",
    };
  }

  // Use AI to classify the response
  const classification = await aiGenerate(
    `You are classifying a customer's response about an order issue.
The customer was asked: "Did you receive your order and something was missing or damaged? Or did you not receive your order at all?"

Respond with EXACTLY one word:
- "received" — if the customer received the package but items are missing, damaged, wrong, or incomplete
- "not_received" — if the customer did not receive the package at all, it never arrived, it's lost
- "unclear" — if you truly cannot determine which scenario from their response`,
    `Customer's response: "${msg}"`,
  );

  const result = (classification || "").toLowerCase().trim();

  if (result.includes("not_received")) {
    ctx.received_order = false;
    ctx.replacement_reason = "not_received";
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  if (result.includes("received")) {
    ctx.received_order = true;
    ctx.needs_item_selection = true;
    ctx.replacement_reason = "missing_items";
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // AI couldn't determine — ask again more specifically. But cap the
  // number of clarify retries: after 2 unsuccessful asks, escalate
  // instead of looping. Without this, the same clarifying question can
  // fire 5+ times back-to-back when the customer keeps responding with
  // free-text that the classifier can't bucket — this surfaced on
  // Alelie's chat ticket where the AI repeated the same question across
  // multiple customer messages over hours, ending with the customer
  // pleading "Are you still there?" while the AI kept asking.
  const retries = Number(ctx.clarify_retries || 0);
  if (retries >= 2) {
    return {
      action: "escalate_api_failure" as const,
      systemNote: `[Playbook] clarify_issue stuck — ${retries + 1} unsuccessful asks, escalating instead of looping.`,
    };
  }
  ctx.clarify_retries = retries + 1;
  return {
    action: "respond",
    context: ctx,
    response: "Just to make sure I understand — did the package arrive and something inside was missing or damaged? Or did the package itself not arrive?",
  };
}

/**
 * check_tracking — Look up EasyPost tracking for the identified order.
 * If context already has tracking data (from workflow/cron), auto-advance.
 */
async function handleCheckTracking(
  admin: Admin, wsId: string, tid: string,
  orders: OrderData[], ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  // If pre-populated from tracking workflow/cron, skip the lookup
  if (ctx.easypost_status && ctx.replacement_reason) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Customer received the order — no tracking lookup needed, skip to item selection
  if (ctx.received_order === true) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Find the order — either from context or most recent
  const orderId = ctx.identified_order_id as string | undefined;
  const order = orderId
    ? orders.find(o => o.id === orderId)
    : orders[0];

  if (!order) {
    return { action: "respond", response: "I wasn't able to find a recent order to check tracking on. Could you provide your order number?" };
  }

  // Get tracking number from fulfillments
  const fulfillments = (order.fulfillments || []) as { trackingInfo?: { number: string; company?: string }[] }[];
  const tracking = fulfillments[0]?.trackingInfo?.[0];

  if (!tracking?.number) {
    ctx.easypost_status = "no_tracking";
    ctx.replacement_reason = "delivery_error";
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { ...ctx, easypost_status: "no_tracking", replacement_reason: "delivery_error" },
      systemNote: `Order ${order.order_number}: no tracking number available.`,
    };
  }

  // EasyPost lookup
  try {
    const { lookupTracking } = await import("@/lib/easypost");
    const result = await lookupTracking(wsId, tracking.number, tracking.company || undefined);

    const reasonEvent = result.status === "return_to_sender"
      ? result.events.find(e => e.status === "return_to_sender")
      : null;
    const lastEvent = result.events[result.events.length - 1];

    ctx.easypost_status = result.status;
    ctx.easypost_detail = reasonEvent?.message || lastEvent?.message || "";
    ctx.easypost_location = [
      (reasonEvent || lastEvent)?.city,
      (reasonEvent || lastEvent)?.state,
    ].filter(Boolean).join(", ");
    ctx.tracking_number = tracking.number;
    ctx.carrier = tracking.company || "USPS";

    // Auto-classify based on tracking
    if (result.status === "delivered") {
      // Package delivered — need to ask customer what's wrong
      ctx.replacement_reason = null; // Will be classified in next step
    } else if (result.status === "return_to_sender") {
      const isRefused = (reasonEvent?.message || "").toLowerCase().includes("refused");
      ctx.replacement_reason = isRefused ? "refused" : "delivery_error";
      ctx.customer_error = !isRefused && (reasonEvent?.message || "").toLowerCase().includes("address");
    } else if (result.status === "failure" || result.status === "error") {
      ctx.replacement_reason = "carrier_lost";
    } else if (result.status === "in_transit") {
      // Still moving — tell customer to wait
      const response = `I checked the tracking on your order and it's currently in transit. The last update was ${ctx.easypost_location ? `in ${ctx.easypost_location}` : "recently"}. Deliveries can sometimes take a few extra days. If it doesn't arrive within the next few days, please let us know and we'll get it sorted out for you.`;
      return { action: "respond", response, context: ctx };
    }

    // Sync EasyPost data to order + post note on Shopify
    if (order) {
      const { syncEasyPostToOrder } = await import("@/lib/easypost-order-sync");
      await syncEasyPostToOrder({
        workspaceId: wsId,
        orderId: order.id,
        shopifyOrderId: order.shopify_order_id,
        trackingResult: result,
      });
    }

    await admin.from("ticket_messages").insert({
      ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "system",
      body: `EasyPost tracking: ${result.status} — "${ctx.easypost_detail}" at ${ctx.easypost_location || "unknown"}. Carrier: ${ctx.carrier}. Tracking: ${tracking.number}.`,
    });

    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  } catch (err) {
    // EasyPost failed — proceed without tracking data
    ctx.easypost_status = "unknown";
    return {
      action: "advance", newStep: step.step_order + 1, context: ctx,
      systemNote: `EasyPost lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/**
 * classify_issue — Determine what happened.
 * If pre-classified (from tracking/cron), auto-advance.
 * If delivered, ask customer what happened.
 */
async function handleClassifyIssue(
  admin: Admin, tid: string,
  msg: string, ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  // Customer received the order + needs item selection — skip classify, go to item selection
  if (ctx.received_order === true && ctx.needs_item_selection) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Already classified from tracking check
  if (ctx.replacement_reason && ctx.replacement_reason !== null) {
    // Refused — escalate, never replace
    if (ctx.replacement_reason === "refused") {
      await admin.from("tickets").update({
        status: "open",
        active_playbook_id: null,
        playbook_step: 0,
        escalation_reason: "refused_replacement",
        updated_at: new Date().toISOString(),
      }).eq("id", tid);

      await admin.from("ticket_messages").insert({
        ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "system",
        body: `[Escalation] Customer requesting replacement on a refused order. Needs admin review.`,
      });

      return {
        action: "respond",
        response: "I've flagged this for our team to review. Someone will be in touch with you shortly.",
        systemNote: "Refused order — escalated to admin, no replacement.",
      };
    }
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Package was delivered — ask what happened
  if (!ctx.issue_question_asked) {
    ctx.issue_question_asked = true;
    return {
      action: "respond", context: ctx,
      response: "I can see your order was delivered. Could you let me know what happened? For example, were items missing from the package, or was something damaged?",
    };
  }

  // Parse customer's response
  const lower = msg.toLowerCase();
  if (lower.includes("missing") || lower.includes("not in") || lower.includes("wasn't there") || lower.includes("didn't receive") || lower.includes("empty")) {
    ctx.replacement_reason = "missing_items";
    ctx.needs_item_selection = true;
  } else if (lower.includes("damaged") || lower.includes("broken") || lower.includes("crushed") || lower.includes("leak")) {
    ctx.replacement_reason = "damaged_items";
    ctx.needs_item_selection = true;
  } else if (lower.includes("wrong") || lower.includes("not what i ordered") || lower.includes("different")) {
    ctx.replacement_reason = "missing_items";
    ctx.needs_item_selection = true;
  } else if (lower.includes("never") || lower.includes("didn't get") || lower.includes("not received") || lower.includes("didn't arrive")) {
    ctx.replacement_reason = "not_received";
    ctx.customer_error = false;
  } else {
    // Couldn't classify — ask again
    return {
      action: "respond",
      response: "I want to make sure I help you correctly. Were any items missing from the package, or was something damaged? Or did you not receive the package at all?",
    };
  }

  return { action: "advance", newStep: step.step_order + 1, context: ctx };
}

/**
 * select_missing_items — Only fires when needs_item_selection is true.
 * Launches the missing items journey. If not needed (delivery error), auto-advance
 * and set items to ALL items from the order.
 */
async function handleSelectMissingItems(
  admin: Admin, wsId: string, tid: string,
  orders: OrderData[], ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
  msg: string = "",
): Promise<PlaybookExecResult> {
  // Delivery error / carrier lost / not received — replace ALL items, skip selection
  if (!ctx.needs_item_selection) {
    const orderId = ctx.identified_order_id as string | undefined;
    const order = orderId ? orders.find(o => o.id === orderId) : orders[0];
    if (order) {
      const lineItems = ((order.line_items || []) as { title: string; quantity: number; sku?: string; variant_id?: string }[])
        .filter(item => !item.title.toLowerCase().includes("shipping protection") && !item.title.toLowerCase().includes("insure"));

      // Resolve variant IDs from products table if missing
      const resolvedItems = await resolveVariantIds(admin, wsId, lineItems);
      ctx.replacement_items = resolvedItems.map(item => ({
        title: item.title,
        quantity: item.quantity,
        variantId: item.variant_id || "",
        type: "all",
      }));
    }
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Items already selected (from journey completion)
  if (ctx.replacement_items && !ctx.all_items_received) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // Customer marked everything as received — confirm with them
  if (ctx.all_items_received) {
    if (!ctx.all_received_confirm_asked) {
      ctx.all_received_confirm_asked = true;
      return {
        action: "respond", context: ctx,
        response: "You indicated that you received everything in your order and nothing was damaged. In that case, it seems like there is nothing for us to fix. Was that correct?",
      };
    }

    // Parse their response
    const lower = msg.toLowerCase().replace(/<[^>]*>/g, " ");
    const saysCorrect = /\b(yes|correct|right|that's right|yep|yeah)\b/i.test(lower);

    if (saysCorrect) {
      return {
        action: "complete",
        response: "Got it! If anything comes up in the future, don't hesitate to reach out.",
      };
    }

    // They said no — relaunch the journey
    ctx.all_items_received = false;
    ctx.all_received_confirm_asked = false;
    ctx.replacement_items = undefined;
    ctx.awaiting_item_selection = true;
    // Fall through to journey launch below
  }

  // Launch missing items journey
  try {
    // Find journey by slug or name (trigger_intent may be null if playbook owns routing)
    const { data: journeyDef } = await admin.from("journey_definitions")
      .select("id, name")
      .eq("workspace_id", wsId)
      .eq("slug", "missing-items")
      .eq("is_active", true)
      .limit(1).single();

    if (journeyDef) {
      const { data: ticket } = await admin.from("tickets")
        .select("channel, customer_id").eq("id", tid).single();
      const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
      await launchJourneyForTicket({
        workspaceId: wsId, ticketId: tid, customerId: ticket?.customer_id || "",
        journeyId: journeyDef.id, journeyName: journeyDef.name,
        triggerIntent: "missing_items", channel: ticket?.channel || "email",
        leadIn: "I'd like to find out exactly which items were affected. Here's a quick form where you can let us know what happened with each item.",
        ctaText: "Report Missing/Damaged Items",
      });
      return { action: "respond", response: "", context: { ...ctx, awaiting_item_selection: true } };
    }
  } catch (err) {
    console.error("[playbook] Failed to launch missing items journey:", err);
  }

  // Fallback if journey not found
  return { action: "respond", response: "I'd like to find out exactly which items were affected. Could you let me know which items were missing or damaged?", context: { ...ctx, awaiting_item_selection: true } };
}

/**
 * confirm_shipping_address — Launch address confirmation journey.
 * If address already validated (from journey), auto-advance.
 */
async function handleConfirmShippingAddress(
  admin: Admin, wsId: string, tid: string,
  customer: CustomerData, ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  // Address already confirmed (from journey completion)
  if (ctx.validated_address) {
    return { action: "advance", newStep: step.step_order + 1, context: ctx };
  }

  // For damaged / missing items: the original order arrived at the
  // customer's address — we know it works. Pull the address straight
  // from the original order and skip the form. Asking would be
  // unnecessary friction.
  // For NOT_RECEIVED (lost in shipping): the original address may have
  // been wrong, so we DO ask via the journey form below.
  const reason = ctx.replacement_reason as string | undefined;
  if (reason === "damaged_items" || reason === "missing_items") {
    const orderId = ctx.identified_order_id as string | undefined;
    if (orderId) {
      const { data: order } = await admin.from("orders")
        .select("shipping_address").eq("id", orderId).maybeSingle();
      const addr = order?.shipping_address as Record<string, string> | null;
      if (addr?.address1) {
        ctx.validated_address = addr;
        return { action: "advance", newStep: step.step_order + 1, context: ctx };
      }
    }
    // Fallback: most recent order with an address
    const { data: orders } = await admin.from("orders")
      .select("shipping_address")
      .eq("workspace_id", wsId)
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const o of orders || []) {
      const a = o.shipping_address as Record<string, string> | null;
      if (a?.address1) {
        ctx.validated_address = a;
        return { action: "advance", newStep: step.step_order + 1, context: ctx };
      }
    }
    // No address anywhere — fall through to the form as a last resort
  }

  // Lost-in-shipping or no order address found → ask via journey
  if (!ctx.address_question_asked) {
    ctx.address_question_asked = true;

    try {
      const { data: journeyDef } = await admin.from("journey_definitions")
        .select("id, name")
        .eq("workspace_id", wsId)
        .eq("slug", "shipping-address")
        .eq("is_active", true)
        .limit(1).single();

      if (journeyDef) {
        const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: customer.id,
          journeyId: journeyDef.id, journeyName: journeyDef.name,
          triggerIntent: "shipping_address", channel: ctx._channel as string || "email",
          leadIn: "Almost there! We just need to confirm your shipping address before we can send the replacement.",
          ctaText: "Confirm Address",
        });
        return { action: "respond", response: "", context: ctx };
      }
    } catch { /* non-fatal */ }

    return {
      action: "respond", context: ctx,
      response: "We need to confirm where to send the replacement. Could you provide your shipping address?",
    };
  }

  // Waiting for journey to complete
  return { action: "respond", response: "Please complete the address form so we can get your replacement shipped out." };
}

/**
 * create_replacement — Create the $0 draft order in Shopify and record in replacements table.
 * Auto-advances (no customer interaction needed).
 */
async function handleCreateReplacement(
  admin: Admin, wsId: string, tid: string,
  customer: CustomerData, orders: OrderData[],
  ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  const orderId = ctx.identified_order_id as string | undefined;
  const order = orderId ? orders.find(o => o.id === orderId) : orders[0];
  const items = ctx.replacement_items as { title: string; quantity: number; variantId?: string; type?: string }[] | undefined;

  if (!items?.length) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "No items to replace." };
  }

  // Check replacement limit for customer errors
  const isCustomerError = !!ctx.customer_error;
  if (isCustomerError) {
    const { count } = await admin.from("replacements")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", wsId)
      .eq("customer_id", customer.id)
      .eq("customer_error", true)
      .neq("status", "denied");

    if ((count || 0) >= 1) {
      // Escalate to admin — leave ticket open
      await admin.from("tickets").update({
        status: "open",
        active_playbook_id: null,
        playbook_step: 0,
        escalation_reason: "replacement_limit",
        updated_at: new Date().toISOString(),
      }).eq("id", tid);

      await admin.from("ticket_messages").insert({
        ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "system",
        body: `[Escalation] Replacement denied — customer already has a prior customer-error replacement. Needs admin review.`,
      });

      return {
        action: "respond",
        response: "I've escalated this to our team for further review. Someone will be in touch with you shortly.",
        systemNote: "Customer error replacement limit reached (1 per customer). Escalated to admin.",
      };
    }
  }

  const reason = (ctx.replacement_reason as string) || "delivery_error";
  const address = ctx.validated_address as { street1: string; street2?: string; city: string; state: string; zip: string; country: string; phone?: string } | undefined;

  // Create replacement record
  const { data: replacement } = await admin.from("replacements").insert({
    workspace_id: wsId,
    customer_id: customer.id,
    original_order_id: order?.id || null,
    original_order_number: order?.order_number || null,
    reason,
    reason_detail: ctx.easypost_detail as string || null,
    items,
    status: address ? "address_confirmed" : "pending",
    customer_error: isCustomerError,
    ticket_id: tid,
    subscription_id: order?.subscription_id || null,
    address_validated: !!address,
    validated_address: address || null,
  }).select("id").single();

  if (!replacement) {
    return { action: "respond", response: "We encountered an issue creating your replacement. Our team has been notified and will follow up with you.", systemNote: "Failed to create replacement record." };
  }

  ctx.replacement_id = replacement.id;

  // Resolve any missing variant IDs before creating draft order
  if (items.some(i => !i.variantId)) {
    const resolved = await resolveVariantIds(admin, wsId, items.map(i => ({
      title: i.title, quantity: i.quantity, sku: (i as unknown as { sku?: string }).sku, variant_id: i.variantId,
    })));
    for (let idx = 0; idx < items.length; idx++) {
      if (!items[idx].variantId && resolved[idx].variant_id) {
        items[idx].variantId = resolved[idx].variant_id;
      }
    }
  }

  // Try to create the draft order if we have address + variant IDs
  if (address && items.every(i => i.variantId)) {
    try {
      const { createAndCompleteReplacement } = await import("@/lib/shopify-draft-orders");
      const result = await createAndCompleteReplacement(wsId, {
        lineItems: items.map(i => ({ variantId: i.variantId!, title: i.title, quantity: i.quantity })),
        shippingAddress: {
          firstName: customer.first_name || "",
          lastName: customer.last_name || "",
          address1: address.street1,
          address2: address.street2,
          city: address.city,
          province: address.state,
          zip: address.zip,
          country: address.country,
          phone: address.phone,
        },
        customerEmail: customer.email || "",
        originalOrderNumber: order?.order_number || "",
        reason,
      });

      await admin.from("replacements").update({
        shopify_draft_order_id: result.draftOrderId,
        shopify_replacement_order_id: result.shopifyOrderId,
        shopify_replacement_order_name: result.orderName,
        status: "created",
        updated_at: new Date().toISOString(),
      }).eq("id", replacement.id);

      ctx.replacement_order_name = result.orderName;
      ctx.replacement_created = true;

      // Mark original order with replacement reference
      if (order) {
        await admin.from("orders").update({
          sync_resolved_note: `Replacement order ${result.orderName} created (${reason})`,
          sync_resolved_at: new Date().toISOString(),
        }).eq("id", order.id);

        // Tag + note on Shopify order
        if (order.shopify_order_id) {
          const { addOrderTags } = await import("@/lib/shopify-order-tags");
          await addOrderTags(wsId, order.shopify_order_id, ["replacement:created", `replacement:${result.orderName}`]);

          try {
            const { getShopifyCredentials } = await import("@/lib/shopify-sync");
            const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
            const { shop, accessToken } = await getShopifyCredentials(wsId);
            await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
              method: "POST",
              headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({
                query: `mutation { orderUpdate(input: { id: "gid://shopify/Order/${order.shopify_order_id}", note: "Replacement order ${result.orderName} created — ${reason}" }) { userErrors { message } } }`,
              }),
            });
          } catch { /* non-fatal */ }
        }
      }
    } catch (err) {
      // Draft order failed — escalate to agent, don't tell customer it succeeded
      await admin.from("ticket_messages").insert({
        ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "system",
        body: `Replacement draft order creation failed: ${err instanceof Error ? err.message : "unknown error"}. Manual creation needed.`,
      });

      await admin.from("tickets").update({
        status: "open",
        active_playbook_id: null,
        playbook_step: 0,
        escalation_reason: "replacement_creation_failed",
        updated_at: new Date().toISOString(),
      }).eq("id", tid);

      return {
        action: "respond",
        response: "We're processing your replacement and our team will follow up with the details shortly.",
        systemNote: "Replacement draft order creation failed. Escalated to agent.",
      };
    }
  }

  return { action: "advance", newStep: step.step_order + 1, context: ctx };
}

/**
 * adjust_subscription — Move next billing date relative to today.
 * Auto-advances after adjustment.
 */
async function handleAdjustSubscription(
  admin: Admin, wsId: string,
  subs: SubscriptionData[], ctx: Record<string, unknown>,
  step: PlaybookStep,
  pers: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<PlaybookExecResult> {
  // Find the subscription linked to this order
  const orderId = ctx.identified_order_id as string;
  let sub = subs.find(s => s.status === "active");

  // If we have a specific subscription from context, use that
  if (ctx.identified_subscription) {
    sub = subs.find(s => s.shopify_contract_id === ctx.identified_subscription) || sub;
  }

  // Only adjust subscription date if replacing ALL items (full order replacement)
  // Partial replacements (missing/damaged specific items) don't change the subscription
  const isFullReplacement = (ctx.replacement_items as { type?: string }[] | undefined)
    ?.every(i => i.type === "all") ?? false;

  if (!sub || sub.status !== "active" || !isFullReplacement) {
    const replacementName = ctx.replacement_order_name ? `${ctx.replacement_order_name} ` : "";
    const response = `Your replacement order ${replacementName}has been created and will ship within 2-3 business days.`;
    return { action: "complete", response, context: ctx };
  }

  // Calculate new date
  const interval = sub.billing_interval_count || 4;
  const intervalType = (sub.billing_interval || "WEEK").toUpperCase();
  const now = new Date();
  let newDate: Date;

  if (intervalType === "MONTH") {
    newDate = new Date(now); newDate.setMonth(newDate.getMonth() + interval);
  } else if (intervalType === "DAY") {
    newDate = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
  } else {
    newDate = new Date(now.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
  }

  const newDateStr = newDate.toISOString().split("T")[0];
  const newDateFormatted = newDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  try {
    const { appstleUpdateNextBillingDate } = await import("@/lib/appstle");
    await appstleUpdateNextBillingDate(wsId, sub.shopify_contract_id, newDateStr);

    // Update local
    await admin.from("subscriptions").update({
      next_billing_date: newDate.toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("workspace_id", wsId).eq("shopify_contract_id", sub.shopify_contract_id);

    // Update replacement record
    if (ctx.replacement_id) {
      await admin.from("replacements").update({
        subscription_adjusted: true,
        new_next_billing_date: newDate.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", ctx.replacement_id as string);
    }

    ctx.subscription_adjusted = true;
    ctx.new_next_billing_date = newDateFormatted;
  } catch (err) {
    await admin.from("ticket_messages").insert({
      ticket_id: "", direction: "outbound", visibility: "internal", author_type: "system",
      body: `Subscription date adjustment failed: ${err instanceof Error ? err.message : "unknown"}. Manual adjustment needed.`,
    });
  }

  // Final confirmation
  const orderRef = ctx.replacement_order_name ? ` ${ctx.replacement_order_name}` : "";
  const subNote = ctx.subscription_adjusted ? ` Your next subscription shipment has been adjusted to ${ctx.new_next_billing_date}.` : "";
  const response = `Your replacement order${orderRef} has been created and will ship within 2-3 business days.${subNote}`;

  return { action: "complete", response, context: ctx };
}

// ══════════════════════════════════════════════════════════════════
// ── 30-Day Money Back Guarantee Flow ──
// ══════════════════════════════════════════════════════════════════

async function handle30DayFlow(
  admin: Admin, wsId: string, orders: OrderData[],
  ctx: Record<string, unknown>, step: PlaybookStep,
  customerMessage: string, pers: { name?: string; tone?: string } | null,
): Promise<PlaybookExecResult> {
  const phase = ctx._30day_phase as string;
  const orderNumbers = (ctx._30day_order_numbers as string[]) || [];
  const orderObjs = orders.filter(o => orderNumbers.includes(o.order_number));

  switch (phase) {
    case "ask_reason": {
      // Customer replied with their reason — now try to save with a review
      const reason = customerMessage.replace(/<[^>]*>/g, " ").trim();
      ctx._30day_return_reason = reason;
      ctx._30day_phase = "save_attempt";

      // Fetch featured reviews for products in the order
      let productIds = (ctx._30day_product_ids as string[]) || [];
      // Resolve product IDs if not yet populated (from variant IDs on the order)
      if (!productIds.length && orderObjs.length) {
        const variantIds = orderObjs.flatMap(o =>
          ((o.line_items as { variant_id?: string }[]) || []).map(i => i.variant_id).filter(Boolean)
        );
        if (variantIds.length) {
          const { data: prods } = await admin.from("products").select("shopify_product_id, variants").eq("workspace_id", wsId);
          for (const p of prods || []) {
            for (const v of (p.variants as { id?: string }[]) || []) {
              if (variantIds.includes(String(v.id))) { productIds.push(p.shopify_product_id); break; }
            }
          }
          ctx._30day_product_ids = productIds;
        }
      }
      let reviewBlock = "";
      if (productIds.length) {
        try {
          const { getReviewsForProducts } = await import("@/lib/klaviyo");
          const reviews = await getReviewsForProducts(wsId, productIds);
          const best = reviews.find(r => r.rating >= 4 && r.summary);
          if (best) {
            const reviewer = best.reviewer_name || "a customer";
            const quote = best.summary || best.body?.slice(0, 100) || "";
            reviewBlock = `</p><p><b>${reviewer} says: "${quote}"</b></p><p>`;
          }
        } catch { /* no reviews available */ }
      }

      const saveMsg = `<p>I completely understand your concern. Most customers see the best results when they stay consistent for 2-3 months.${reviewBlock}Would you like to give it a bit more time, or would you prefer I go ahead and process your return?</p>`;

      return {
        action: "respond",
        response: wrapResponse(saveMsg, pers, false),
        context: ctx,
        systemNote: `[Playbook] 30-day flow: customer reason: "${reason.slice(0, 80)}". Showing save attempt with review.`,
      };
    }

    case "save_attempt": {
      // Customer replied to save attempt — check if they want to continue or return
      const msg = customerMessage.toLowerCase().replace(/<[^>]*>/g, " ").trim();
      const wantsReturn = msg.includes("return") || msg.includes("refund") || msg.includes("money back") ||
        msg.includes("process") || msg.includes("go ahead") || msg.includes("prefer") ||
        msg.includes("no") || msg.includes("cancel");
      const wantsToStay = msg.includes("try") || msg.includes("keep") || msg.includes("stay") ||
        msg.includes("give it") || msg.includes("more time") || msg.includes("ok") || msg.includes("sure");

      if (wantsToStay && !wantsReturn) {
        // Saved!
        return {
          action: "complete",
          response: wrapResponse(
            `<p>That's great to hear! I think you'll really love the results. If you have any questions along the way, don't hesitate to reach out. We're here for you!</p>`,
            pers, false,
          ),
          context: { ...ctx, _30day_outcome: "saved" },
          systemNote: `[Playbook] 30-day flow: customer decided to keep product. Saved!`,
        };
      }

      // Customer wants to proceed with return — estimate label cost
      ctx._30day_phase = "confirm_return";

      // Estimate label cost — use $7.95 default (actual cost calculated at purchase)
      const labelCostCents = 795;

      const orderTotal = orderObjs.reduce((sum, o) => sum + (o.total_cents || 0), 0);
      const netRefund = orderTotal - labelCostCents;
      ctx._30day_label_cost_cents = labelCostCents;
      ctx._30day_net_refund_cents = netRefund;

      return {
        action: "respond",
        response: wrapResponse(
          `<p>No problem at all. Here's what the return looks like:</p><p>Order total: <b>$${(orderTotal / 100).toFixed(2)}</b><br/>Return shipping label: <b>-$${(labelCostCents / 100).toFixed(2)}</b><br/>Your refund: <b>$${(netRefund / 100).toFixed(2)}</b></p><p>The label cost is deducted from your refund. Would you like me to go ahead and process this?</p>`,
          pers, false,
        ),
        context: ctx,
        systemNote: `[Playbook] 30-day flow: customer wants return. Label ~$${(labelCostCents / 100).toFixed(2)}, net refund $${(netRefund / 100).toFixed(2)}.`,
      };
    }

    case "confirm_return": {
      const msg = customerMessage.toLowerCase().replace(/<[^>]*>/g, " ").trim();
      const confirmed = msg.includes("yes") || msg.includes("go ahead") || msg.includes("process") ||
        msg.includes("proceed") || msg.includes("sure") || msg.includes("ok") || msg.includes("please");
      const pushback = msg.includes("no") || msg.includes("too much") || msg.includes("expensive") ||
        msg.includes("why do i") || msg.includes("shouldn't have to");

      if (pushback) {
        // Stand firm on label cost
        const labelCost = (ctx._30day_label_cost_cents as number) || 795;
        const netRefund = (ctx._30day_net_refund_cents as number) || 0;
        return {
          action: "respond",
          response: wrapResponse(
            `<p>I understand that's frustrating. The return shipping label cost of $${(labelCost / 100).toFixed(2)} is standard for all returns and is deducted from your refund of $${(netRefund / 100).toFixed(2)}. This is the best we can offer for the return. Would you like me to go ahead?</p>`,
            pers, false,
          ),
          context: ctx,
          systemNote: `[Playbook] 30-day flow: customer pushed back on label cost. Standing firm.`,
        };
      }

      if (!confirmed) {
        // Unclear response — ask again
        return {
          action: "respond",
          response: wrapResponse(
            `<p>Just to confirm — would you like me to process the return? I'll send you a prepaid shipping label right away.</p>`,
            pers, false,
          ),
          context: ctx,
          systemNote: `[Playbook] 30-day flow: unclear confirmation response.`,
        };
      }

      // Confirmed — create return record (pending label generation by agent/Inngest)
      ctx._30day_phase = "processing";

      const orderTotal = orderObjs[0]?.total_cents || 0;
      const estLabelCost = (ctx._30day_label_cost_cents as number) || 795;
      const netRefund = orderTotal - estLabelCost;

      const customerId = await (async () => {
        const { data: o } = await admin.from("orders").select("customer_id").eq("order_number", orderObjs[0]?.order_number).eq("workspace_id", wsId).single();
        return o?.customer_id;
      })();

      await admin.from("returns").insert({
        workspace_id: wsId,
        order_id: orderObjs[0]?.id,
        order_number: orderObjs[0]?.order_number,
        shopify_order_gid: orderObjs[0]?.shopify_order_id ? `gid://shopify/Order/${orderObjs[0].shopify_order_id}` : null,
        customer_id: customerId || null,
        status: "pending_label",
        resolution_type: "refund",
        source: "playbook",
        order_total_cents: orderTotal,
        label_cost_cents: estLabelCost,
        net_refund_cents: netRefund,
      });

      return {
        action: "complete",
        response: wrapResponse(
          `<p>Your return has been approved! We're generating your prepaid shipping label now and will email it to you shortly.</p><p>Your refund of <b>$${(netRefund / 100).toFixed(2)}</b> will be processed once we receive the package back.</p><p>If you have any questions in the meantime, just reply to this email!</p>`,
          pers, false,
        ),
        context: { ...ctx, _30day_outcome: "returned" },
        systemNote: `[Playbook] 30-day flow: return approved. Pending label. Est. refund: $${(netRefund / 100).toFixed(2)}.`,
      };
    }

    default:
      return { action: "advance", newStep: step.step_order + 1, systemNote: `[Playbook] Unknown 30-day phase: ${phase}` };
  }
}

// Stub handlers for the step types (delegated to handle30DayFlow via apply_policy)
async function handleAskReturnReason(ctx: Record<string, unknown>, step: PlaybookStep, pers: { name?: string; tone?: string } | null): Promise<PlaybookExecResult> {
  return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] ask_return_reason handled via 30-day flow." };
}

async function handleSaveWithReview(admin: Admin, wsId: string, orders: OrderData[], ctx: Record<string, unknown>, step: PlaybookStep, msg: string, pers: { name?: string; tone?: string } | null): Promise<PlaybookExecResult> {
  return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] save_with_review handled via 30-day flow." };
}

async function handleConfirmReturn(admin: Admin, wsId: string, orders: OrderData[], ctx: Record<string, unknown>, step: PlaybookStep, msg: string, pers: { name?: string; tone?: string } | null): Promise<PlaybookExecResult> {
  return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] confirm_return handled via 30-day flow." };
}

async function handleProcessReturn(admin: Admin, wsId: string, tid: string, customer: CustomerData, orders: OrderData[], ctx: Record<string, unknown>, step: PlaybookStep, msg: string, pers: { name?: string; tone?: string } | null): Promise<PlaybookExecResult> {
  return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] process_return handled via 30-day flow." };
}
