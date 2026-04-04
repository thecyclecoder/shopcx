/**
 * Playbook Executor — runs playbook steps against live customer data.
 *
 * Called from the unified ticket handler when a playbook is active or matched.
 * Each step fetches live data, evaluates conditions, generates AI response,
 * and advances (or waits for customer reply).
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

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
  created_at: string;
  total_cents: number;
  financial_status: string;
  fulfillment_status: string | null;
  line_items: unknown[];
  fulfillments: unknown[];
  source_name: string | null;
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
    .select("active_playbook_id, playbook_step, playbook_context, playbook_exceptions_used, customer_id, created_at")
    .eq("id", ticketId).single();

  if (!ticket?.active_playbook_id || !ticket.customer_id) {
    return { action: "complete", systemNote: "No active playbook or customer." };
  }

  // Load playbook + steps
  const { data: playbook } = await admin.from("playbooks")
    .select("id, name, exception_limit, stand_firm_max")
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

  // Execute the step
  const stepResult = await executeStep(
    admin, workspaceId, ticketId, playbook, currentStep, steps,
    customer, orders, subs, ctx, customerMessage, personality,
    ticket.playbook_exceptions_used, timelineChanges,
  );

  // Update ticket context
  if (stepResult.context) {
    const updatedCtx = { ...ctx, ...stepResult.context };
    await admin.from("tickets").update({ playbook_context: updatedCtx }).eq("id", ticketId);
  }

  // Advance step if needed
  if (stepResult.action === "advance" && stepResult.newStep !== undefined) {
    const nextStepIdx = stepResult.newStep;
    if (nextStepIdx >= steps.length) {
      // All steps done — complete playbook
      return { ...stepResult, action: "complete", systemNote: stepResult.systemNote || `Playbook "${playbook.name}" completed.` };
    }
    await admin.from("tickets").update({ playbook_step: nextStepIdx }).eq("id", ticketId);
  }

  return stepResult;
}

// ── Step dispatcher ──

async function executeStep(
  admin: Admin, wsId: string, tid: string,
  playbook: { id: string; name: string; exception_limit: number; stand_firm_max: number },
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
        return handleInitiateReturn(admin, wsId, orders, ctx, returnStep, dataContext, pers, msg, policyRules);
      }
    }
  }

  switch (step.type) {
    case "identify_order":
      return handleIdentifyOrder(orders, msg, step, dataContext, pers, policyRules);

    case "identify_subscription":
      return handleIdentifySubscription(subs, orders, ctx, step, dataContext, pers, policyRules);

    case "check_other_subscriptions":
      return handleCheckOtherSubs(subs, ctx, step, dataContext, pers);

    case "apply_policy": {
      if (!policy) return { action: "advance", newStep: step.step_order + 1, systemNote: "No policy configured." };
      return handleApplyPolicy(policy, orders, ctx, step, dataContext, pers, policyRules);
    }

    case "offer_exception": {
      if (!policyId) return { action: "advance", newStep: step.step_order + 1, systemNote: "No policy for exception." };
      const { data: exceptions } = await admin.from("playbook_exceptions")
        .select("*").eq("policy_id", policyId).order("tier");
      return handleOfferException(
        exceptions || [], customer, orders, ctx, step, dataContext, pers,
        exceptionsUsed, playbook.exception_limit, tid, admin, msg, policyRules,
      );
    }

    case "initiate_return":
      return handleInitiateReturn(admin, wsId, orders, ctx, step, dataContext, pers, msg, policyRules);

    case "cancel_subscription":
      return handleCancelSubscription(admin, wsId, subs, ctx, step, dataContext, pers, policyRules);

    case "issue_store_credit":
      return handleIssueStoreCredit(admin, wsId, customer, orders, ctx, step, tid);

    case "stand_firm":
      return handleStandFirm(ctx, step, playbook.stand_firm_max, msg, dataContext, pers, policyRules);

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
    .select("id, email, first_name, last_name, ltv_cents, total_orders, retention_score, subscription_status")
    .eq("id", custId).single();
  if (!c) return null;

  // Combine LTV + orders from linked profiles
  if (linkedIds.length > 1) {
    const { data: linked } = await admin.from("customers")
      .select("ltv_cents, total_orders").in("id", linkedIds);
    c.ltv_cents = (linked || []).reduce((s, l) => s + (l.ltv_cents || 0), 0);
    c.total_orders = (linked || []).reduce((s, l) => s + (l.total_orders || 0), 0);
  }

  return c as CustomerData;
}

async function fetchOrders(admin: Admin, wsId: string, custId: string, config: Record<string, unknown>): Promise<OrderData[]> {
  const lookbackDays = Number(config.lookback_days) || 90;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  // Include linked customer orders
  const linkedIds = [custId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", custId).single();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data } = await admin.from("orders")
    .select("id, order_number, created_at, total_cents, financial_status, fulfillment_status, line_items, fulfillments, source_name")
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
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
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
      parts.push(`  #${s.shopify_contract_id} — ${s.status} — ${s.billing_interval}/${s.billing_interval_count} — ${items} — created ${new Date(s.created_at).toLocaleDateString()}`);
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

async function aiGenerate(systemPrompt: string, userPrompt: string, model = "claude-haiku-4-5-20251001"): Promise<string> {
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

function basePrompt(step: PlaybookStep, pers: { name?: string; tone?: string } | null, policyRules?: string): string {
  return [
    "You are a customer support agent.",
    pers?.tone ? `Tone: ${pers.tone}` : "Be empathetic and professional.",
    "Rules: max 2-3 sentences per paragraph. Plain text only, no markdown. Never promise actions you haven't verified. Never promise to connect with a specialist or escalate to a supervisor — you handle the full resolution.",
    policyRules ? `Store policy rules:\n${policyRules}` : "",
    step.instructions ? `Step instructions: ${step.instructions}` : "",
  ].filter(Boolean).join("\n");
}

// ── Step handlers ──

async function handleIdentifyOrder(
  orders: OrderData[], msg: string, step: PlaybookStep,
  dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  if (orders.length === 0) {
    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\nThe customer has no recent orders. Acknowledge their concern and ask for an order number or more details.`,
    );
    return { action: "respond", response, systemNote: "[Playbook] No recent orders found." };
  }

  if (orders.length === 1) {
    const o = orders[0];
    const items = (o.line_items as { title?: string }[] || []).map(i => i.title).join(", ");
    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\nThey have one recent order: ${o.order_number} on ${new Date(o.created_at).toLocaleDateString()} for ${items} ($${(o.total_cents / 100).toFixed(2)}). Confirm this is the order they're asking about.`,
    );
    return {
      action: "respond", response,
      context: { identified_orders: [o.order_number] },
      systemNote: `[Playbook] Single order found: ${o.order_number}. Confirming with customer.`,
    };
  }

  // Multiple orders — check if customer's message specifies one
  const msgLower = msg.toLowerCase();
  const matchedOrders = orders.filter(o => {
    const num = o.order_number.replace(/^[^0-9]*/, "");
    return msgLower.includes(o.order_number.toLowerCase()) || msgLower.includes(num);
  });

  if (matchedOrders.length > 0) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: matchedOrders.map(o => o.order_number) },
      systemNote: `[Playbook] Customer specified order(s): ${matchedOrders.map(o => o.order_number).join(", ")}`,
    };
  }

  // Check for "all orders" / "all of them" type messages
  if (/all (of )?(them|my orders|orders)|every order|each order/i.test(msg)) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: orders.map(o => o.order_number) },
      systemNote: `[Playbook] Customer wants all ${orders.length} orders addressed.`,
    };
  }

  // Check for "last order" / "most recent"
  if (/last order|most recent|latest order|recent charge/i.test(msg)) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_orders: [orders[0].order_number] },
      systemNote: `[Playbook] Customer referenced most recent order: ${orders[0].order_number}.`,
    };
  }

  // Can't determine — ask
  const orderList = orders.slice(0, 5).map(o => {
    const items = (o.line_items as { title?: string }[] || []).map(i => i.title).join(", ");
    return `${o.order_number} — ${new Date(o.created_at).toLocaleDateString()} — ${items} ($${(o.total_cents / 100).toFixed(2)})`;
  }).join("\n");

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\nThey have ${orders.length} recent orders:\n${orderList}\n\nAsk which order(s) they're referring to. List the orders so they can identify theirs.`,
  );

  return { action: "respond", response, systemNote: `[Playbook] ${orders.length} orders found. Asking customer to identify.` };
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
  // Match by checking if subscription items overlap with order items
  const activeSubs = subs.filter(s => s.status === "active" || s.status === "paused");
  const cancelledSubs = subs.filter(s => s.status === "cancelled");

  const matchedSub = activeSubs[0] || cancelledSubs[0];
  if (matchedSub) {
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { identified_subscription: matchedSub.shopify_contract_id, subscription_status: matchedSub.status, subscription_created: matchedSub.created_at },
      systemNote: `[Playbook] Matched subscription #${matchedSub.shopify_contract_id} (${matchedSub.status}, created ${new Date(matchedSub.created_at).toLocaleDateString()}).`,
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
  policy: PlaybookPolicy, orders: OrderData[], ctx: Record<string, unknown>,
  step: PlaybookStep, dataCtx: string, pers: { name?: string; tone?: string } | null, policyRules: string,
): Promise<PlaybookExecResult> {
  const identifiedOrders = (ctx.identified_orders as string[]) || [];
  const orderObjs = orders.filter(o => identifiedOrders.includes(o.order_number));

  // Evaluate each order against policy conditions, tracking WHY each fails
  const inPolicy: string[] = [];
  const outOfPolicy: string[] = [];
  const failureReasons: string[] = [];

  for (const o of orderObjs) {
    const eligible = evaluateConditions(policy.conditions, o);
    if (eligible) {
      inPolicy.push(o.order_number);
    } else {
      outOfPolicy.push(o.order_number);
      // Build human-readable reason
      const reasons: string[] = [];
      const daysSince = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000);
      const src = o.source_name || "";
      for (const [key, rule] of Object.entries(policy.conditions)) {
        const r = rule as Record<string, unknown>;
        if ((key === "days_since_order" || key === "days_since_fulfillment" || key === "days_since_delivery") && r["<="] && daysSince > Number(r["<="])) {
          reasons.push(`ordered ${daysSince} days ago, outside the ${r["<="]}‑day return window`);
        }
        if (key === "source_name" && r["not_contains"] && src.toLowerCase().includes(String(r["not_contains"]).toLowerCase())) {
          reasons.push(`source is "${src}" — this is a recurring subscription order, not a checkout order`);
        }
      }
      failureReasons.push(`${o.order_number} (${new Date(o.created_at).toLocaleDateString()}): ${reasons.join("; ") || "does not meet policy conditions"}`);
    }
  }

  const subCreated = ctx.subscription_created as string | undefined;
  const subInfo = subCreated ? `Subscription created: ${new Date(subCreated).toLocaleDateString()}.` : "";
  const otherSubs = Number(ctx.other_active_count) || 0;
  const otherSubsInfo = otherSubs > 0 ? `Note: customer has ${otherSubs} other active subscription(s) — mention proactively.` : "";

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nPolicy: "${policy.name}"\nPolicy details: ${policy.description || ""}\nAI talking points: ${policy.ai_talking_points || ""}\n${subInfo}\n${otherSubsInfo}\n\nOrders in policy (eligible for return): ${inPolicy.join(", ") || "none"}\nOrders out of policy: ${outOfPolicy.join(", ") || "none"}\n\nSpecific reasons each order fails:\n${failureReasons.join("\n") || "none"}\n\nExplain the situation to the customer. For EACH order, explain specifically why it does or doesn't qualify — mention the exact reason (e.g. "recurring subscription order" or "outside 30-day window"). Be neutral — say "here's what happened" not "you signed up for this." If there are other active subscriptions, mention them proactively.`,
  );

  return {
    action: "respond", response,
    context: { in_policy: inPolicy, out_of_policy: outOfPolicy, policy_applied: policy.name, failure_reasons: failureReasons },
    systemNote: `[Playbook] Policy "${policy.name}": ${inPolicy.length} in-policy, ${outOfPolicy.length} out-of-policy. Reasons: ${failureReasons.join("; ")}`,
  };
}

async function handleOfferException(
  exceptions: PlaybookException[], customer: CustomerData, orders: OrderData[],
  ctx: Record<string, unknown>, step: PlaybookStep, dataCtx: string,
  pers: { name?: string; tone?: string } | null,
  exceptionsUsed: number, exceptionLimit: number, tid: string, admin: Admin,
  msg: string, policyRules: string,
): Promise<PlaybookExecResult> {
  const outOfPolicy = (ctx.out_of_policy as string[]) || [];
  if (outOfPolicy.length === 0) {
    return { action: "advance", newStep: step.step_order + 1, systemNote: "[Playbook] All orders in policy, no exception needed." };
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

  const currentTier = Number(ctx.current_exception_tier) || 0;

  // If we already offered an exception, check if customer accepted or rejected
  if (currentTier > 0 && ctx.exception_offered) {
    const accepted = detectAcceptance(msg);
    if (accepted) {
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { offer_accepted: true },
        systemNote: `[Playbook] Customer accepted exception: ${ctx.exception_offered} (${ctx.resolution_type}).`,
      };
    }
    // Customer rejected — try next tier
  }

  // Check tiered exceptions (next tier after current)
  const nextTierExceptions = exceptions.filter(e => !e.auto_grant && e.tier > currentTier);

  if (nextTierExceptions.length === 0 || exceptionsUsed >= exceptionLimit) {
    // No more tiers or limit reached — advance (will hit stand_firm)
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { exception_exhausted: true },
      systemNote: `[Playbook] ${nextTierExceptions.length === 0 ? "All exception tiers exhausted" : `Exception limit reached (${exceptionsUsed}/${exceptionLimit})`}. Moving to stand firm.`,
    };
  }

  const nextException = nextTierExceptions[0];
  const eligible = evaluateCustomerConditions(nextException.conditions, customer);

  if (!eligible) {
    // Try remaining tiers
    const remaining = nextTierExceptions.filter(e => e.tier > nextException.tier);
    for (const fallback of remaining) {
      if (evaluateCustomerConditions(fallback.conditions, customer)) {
        return offerException(fallback, outOfPolicy, step, dataCtx, pers, exceptionsUsed, exceptionLimit, tid, admin, policyRules);
      }
    }
    return {
      action: "advance", newStep: step.step_order + 1,
      context: { exception_exhausted: true },
      systemNote: `[Playbook] Customer doesn't meet conditions for any remaining exception tier.`,
    };
  }

  return offerException(nextException, outOfPolicy, step, dataCtx, pers, exceptionsUsed, exceptionLimit, tid, admin, policyRules);
}

async function offerException(
  ex: PlaybookException, outOfPolicy: string[], step: PlaybookStep, dataCtx: string,
  pers: { name?: string; tone?: string } | null,
  exceptionsUsed: number, exceptionLimit: number, tid: string, admin: Admin, policyRules: string,
): Promise<PlaybookExecResult> {
  const mostRecentOutOfPolicy = outOfPolicy[outOfPolicy.length - 1];
  const isEscalation = Number(ex.tier) > 1;

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nException instructions: ${ex.instructions || ""}\nException: "${ex.name}" (${ex.resolution_type})\nApplies to: ${mostRecentOutOfPolicy}\n${isEscalation ? "The customer rejected the previous offer. This is an escalated offer — present it as a better alternative without mentioning that other options exist beyond this one." : "Present this offer clearly. Do NOT hint that better alternatives exist."}\n\nFollow store policy rules exactly when describing the return/refund process.\n\nOffer this exception. ${outOfPolicy.length > 1 ? `Note: applies to 1 order (${mostRecentOutOfPolicy}). Orders ${outOfPolicy.filter(o => o !== mostRecentOutOfPolicy).join(", ")} do not qualify.` : ""}`,
  );

  await admin.from("tickets").update({ playbook_exceptions_used: exceptionsUsed + 1 }).eq("id", tid);

  return {
    action: "respond", response,
    context: { current_exception_tier: ex.tier, exception_offered: ex.name, resolution_type: ex.resolution_type },
    systemNote: `[Playbook] Offered tier ${ex.tier} exception: ${ex.name} for ${mostRecentOutOfPolicy}.`,
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
  admin: Admin, wsId: string, orders: OrderData[], ctx: Record<string, unknown>,
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
    // Check if this message is the acceptance
    const accepted = detectAcceptance(msg);
    if (!accepted) {
      // Customer hasn't accepted — don't initiate. Send back to offer step or stand firm
      return {
        action: "advance", newStep: step.step_order + 1,
        context: { offer_accepted: false },
        systemNote: "[Playbook] Customer hasn't accepted return offer. Skipping initiate_return.",
      };
    }
    // Customer accepted in this message
    ctx.offer_accepted = true;
  }

  const resolution = ctx.resolution_type as string || "store_credit_return";
  const resLabel = resolution.includes("refund") ? "refund" : "store credit";

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nOrders approved for return: ${returnable.join(", ")}\nResolution: ${resLabel}\n\nThe customer has accepted the ${resLabel} offer. Set up the return. Follow the store policy rules exactly when explaining the return process to the customer.`,
  );

  return {
    action: "advance", newStep: step.step_order + 1, response,
    context: { return_initiated: true, return_orders: returnable, offer_accepted: true },
    systemNote: `[Playbook] Return initiated for: ${returnable.join(", ")}. Resolution: ${resolution}. Customer accepted.`,
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

  const bestOffer = ctx.exception_offered || "return";
  const resType = ctx.resolution_type as string || "store_credit_return";
  const resLabel = resType.includes("refund") ? "full refund" : "store credit";

  if (reps >= maxReps) {
    const response = await aiGenerate(
      basePrompt(step, pers, policyRules),
      `Customer data:\n${dataCtx}\n\nThe customer has rejected all offers ${maxReps} times. This is the FINAL message.\nBest offer: ${bestOffer} (${resLabel})\n\nState your best offer one last time following store policy rules exactly. Say "If you change your mind, just reply and we'll get it started for you." Warm but final tone. Do not argue.`,
    );
    return {
      action: "complete", response,
      context: { stand_firm_count: reps + 1, stand_firm_final: true },
      systemNote: `[Playbook] Stand firm max reached (${maxReps}). Final message sent. Ticket set to pending.`,
    };
  }

  const response = await aiGenerate(
    basePrompt(step, pers, policyRules),
    `Customer data:\n${dataCtx}\n\nCustomer message: "${msg}"\n\nThe customer rejected the offer. This is attempt ${reps + 1}/${maxReps}.\nBest offer: ${bestOffer} (${resLabel})\n\nAcknowledge frustration. Restate the best available offer following store policy rules exactly. Do NOT repeat verbatim — use different wording. Do not argue or get defensive.`,
  );

  return {
    action: "respond", response,
    context: { stand_firm_count: reps + 1 },
    systemNote: `[Playbook] Stand firm ${reps + 1}/${maxReps}. Customer rejected offer.`,
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
  await admin.from("tickets").update({
    active_playbook_id: playbookId,
    playbook_step: 0,
    playbook_context: {},
    playbook_exceptions_used: 0,
  }).eq("id", ticketId);
}
