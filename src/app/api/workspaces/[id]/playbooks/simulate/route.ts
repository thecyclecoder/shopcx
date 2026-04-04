import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const SONNET = "claude-sonnet-4-20250514";

interface SimStep {
  step_name: string;
  step_type: string;
  step_order: number;
  data_found: string;
  condition_result: string;
  ai_response: string;
  mock_customer_reply: string;
  warnings: string[];
  skipped: boolean;
}

async function aiCall(system: string, user: string, maxTokens = 400): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "(AI unavailable)";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: SONNET, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return `(AI error: ${res.status})`;
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { playbook_id, customer_id, message, sentiment, clarification_response } = body as {
    playbook_id: string; customer_id: string; message: string; sentiment: string;
    clarification_response?: string;
  };

  if (!playbook_id || !customer_id || !message) {
    return NextResponse.json({ error: "playbook_id, customer_id, and message required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Load playbook with children
  const { data: playbook } = await admin.from("playbooks")
    .select("*").eq("id", playbook_id).single();
  if (!playbook) return NextResponse.json({ error: "Playbook not found" }, { status: 404 });

  // Load all active playbooks/journeys/workflows to build handler list for classification
  const { data: allPlaybooks } = await admin.from("playbooks")
    .select("trigger_intents").eq("workspace_id", workspaceId).eq("is_active", true);
  const allIntents = (allPlaybooks || []).flatMap((p: { trigger_intents: string[] }) => p.trigger_intents);
  const handlerList = [...new Set(allIntents)].map(i => `- ${i}`).join("\n");

  // ── Confidence classification ──
  const classifyMessage = clarification_response
    ? `Original: "${message}"\nClarification response: "${clarification_response}"`
    : message;

  const classifyResult = await aiCall(
    `You are an intent classifier for customer support. Match the customer's message to one of the available handler intents below. Do NOT invent intents.

Available handler intents:
${handlerList || "None configured"}

Rules:
- "intent" must be an exact intent from the list above, or "unknown"
- "confidence" is 0-100 how sure you are
- If vague/emotional without clear actionable request, return "unknown" with low confidence
- Trigger patterns for this playbook: ${(playbook.trigger_patterns || []).join(", ")}

Return JSON only: { "intent": "...", "confidence": 0-100, "reasoning": "one sentence" }`,
    `Customer message: "${classifyMessage}"`,
    150,
  );

  let classification = { intent: "unknown", confidence: 0, reasoning: "parse error" };
  try {
    classification = JSON.parse(classifyResult.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
  } catch {}

  // Also check pattern match (keyword matching against trigger_patterns)
  const msgLower = (clarification_response || message).toLowerCase();
  const patternMatch = (playbook.trigger_patterns || []).some((p: string) => msgLower.includes(p.toLowerCase()));
  if (patternMatch && classification.confidence < 80) {
    classification.confidence = Math.max(classification.confidence, 85);
    classification.reasoning += " (boosted by pattern match)";
    classification.intent = playbook.trigger_intents?.[0] || classification.intent;
  }

  // Get channel threshold (default 70)
  const { data: channelCfg } = await admin.from("ai_channel_config")
    .select("confidence_threshold").eq("workspace_id", workspaceId).eq("channel", "email").single();
  const threshold = channelCfg?.confidence_threshold
    ? (channelCfg.confidence_threshold <= 1 ? Math.round(channelCfg.confidence_threshold * 100) : channelCfg.confidence_threshold)
    : 70;

  // If below threshold and no clarification provided yet, return clarification needed
  if (classification.confidence < threshold && !clarification_response) {
    const clarifyQuestion = await aiCall(
      "You are a friendly support agent. The customer's message wasn't clear enough to route. Ask ONE specific clarifying question to understand what they need. Max 30 words. Only the question.",
      `Customer said: "${message}"\nBest guess: "${classification.intent}" (${classification.confidence}% confidence)\nPlaybook this might match: "${playbook.name}"`,
      80,
    );

    return NextResponse.json({
      needs_clarification: true,
      confidence: classification.confidence,
      threshold,
      detected_intent: classification.intent,
      reasoning: classification.reasoning,
      clarification_question: clarifyQuestion,
      playbook_name: playbook.name,
    });
  }

  const { data: steps } = await admin.from("playbook_steps")
    .select("*").eq("playbook_id", playbook_id).order("step_order");
  const { data: policies } = await admin.from("playbook_policies")
    .select("*").eq("playbook_id", playbook_id);
  const { data: exceptions } = await admin.from("playbook_exceptions")
    .select("*").eq("playbook_id", playbook_id).order("tier");

  if (!steps?.length) return NextResponse.json({ error: "No steps in playbook" }, { status: 400 });

  // Load customer data
  const { data: customer } = await admin.from("customers")
    .select("id, email, first_name, last_name, ltv_cents, total_orders, retention_score, subscription_status")
    .eq("id", customer_id).single();
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  // Load customer's orders and subscriptions
  const lookbackDays = 90;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  // Include linked profiles
  const linkedIds = [customer_id];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customer_id).single();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data: orders } = await admin.from("orders")
    .select("id, order_number, created_at, total_cents, financial_status, fulfillment_status, line_items, fulfillments, source_name")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .order("created_at", { ascending: false });

  // Build data summary
  const customerName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || customer.email;
  const dataSummary = buildDataSummary(customer, orders || [], subs || []);
  const sentimentLabel = sentiment || "neutral";

  // Stream response — each step sent as it completes
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));

      // Send metadata first
      send({
        type: "meta",
        playbook_name: playbook.name,
        customer_name: customerName,
        customer_email: customer.email,
        sentiment: sentimentLabel,
        initial_message: message,
        clarification_response: clarification_response || null,
        confidence: classification.confidence,
        detected_intent: classification.intent,
        classification_reasoning: classification.reasoning,
        threshold,
        total_steps: steps.length,
      });

      const simSteps: SimStep[] = [];
      let currentMessage = message;
      const ctx: Record<string, unknown> = {};
      let exceptionsUsed = 0;

      // Helper: generate AI response for a step
      async function genAI(step: { name: string; type: string; instructions?: string | null }, dataFound: string, condResult: string, custMsg: string) {
        return aiCall(
          ["You are simulating a customer support AI for a playbook dry-run. Generate the AI response for this step.",
           "Rules: max 2-3 sentences per paragraph. Plain text only, no markdown.",
           step.instructions ? `Step instructions: ${step.instructions}` : ""].filter(Boolean).join("\n"),
          `Customer data:\n${dataSummary}\n\nPlaybook context: ${JSON.stringify(ctx)}\nStep: "${step.name}" (${step.type})\nData found: ${dataFound}\nCondition result: ${condResult}\n\nCustomer message: "${custMsg}"\n\nGenerate what the AI would say. Keep it realistic.`, 300);
      }

      // Helper: generate mock customer reply
      async function genMock(aiSaid: string, stepName: string, reject = false) {
        if (reject) {
          return aiCall(
            `You are simulating a ${sentimentLabel} customer who has REJECTED the offer. Generate a brief rejection reply (1-2 sentences). Sentiment: ${sentimentLabel}.`,
            `AI offered: "${aiSaid}"\nGenerate a rejection. The customer doesn't want this offer.`, 100);
        }
        return aiCall(
          [`You are simulating a ${sentimentLabel} customer replying to a support agent. Sentiment: ${sentimentLabel}.`,
           "Generate a realistic, brief customer reply (1-3 sentences). Match the sentiment exactly.",
           sentimentLabel === "angry" ? "Be hostile, use caps or exclamations. Demand resolution." : "",
           sentimentLabel === "frustrated" ? "Be exasperated, short-tempered." : "",
           sentimentLabel === "confused" ? "Ask clarifying questions." : "",
           sentimentLabel === "polite" ? "Be cooperative and understanding." : "",
           sentimentLabel === "neutral" ? "Be straightforward." : "",
           "Do NOT include any metadata, just the customer's words."].filter(Boolean).join("\n"),
          `AI said:\n"${aiSaid}"\n\nContext: customer originally said "${message}" about ${playbook.name.toLowerCase()}.\nStep: ${stepName}\n\nGenerate a realistic reply from the ${sentimentLabel} customer.`, 150);
      }

      // Helper: push + stream a step
      function emitStep(s: SimStep) {
        simSteps.push(s);
        // Calculate total including projected stand_firm rounds
        const totalProjected = (steps?.length || 0) + Math.max(0, (playbook.stand_firm_max || 3) - 1) + eligibleTierCount - 1;
        send({ type: "step", step_index: simSteps.length - 1, total_steps: Math.max(totalProjected, simSteps.length), ...s });
      }

      // Pre-calculate eligible tiers for progress bar
      const policyStepCfg = steps.find((s: { type: string }) => s.type === "offer_exception")?.config;
      const polExAll = policyStepCfg?.policy_id
        ? (exceptions || []).filter((e: { policy_id: string; auto_grant: boolean }) => e.policy_id === (policyStepCfg as { policy_id: string }).policy_id && !e.auto_grant)
        : [];
      const eligibleTierCount = polExAll.filter((e: { conditions: Record<string, unknown> }) => evalCustomerConditions(e.conditions, customer).pass).length;

      for (const step of steps) {
        const warnings: string[] = [];
        let dataFound = "";
        let conditionResult = "";
        let aiResponse = "";
        let mockReply = "";
        let skipped = false;

        switch (step.type) {
          case "identify_order": {
            dataFound = `${(orders || []).length} orders found in last ${lookbackDays} days`;
            if ((orders || []).length === 0) warnings.push("Customer has no recent orders.");
            if ((orders || []).length === 1) {
              const o = (orders || [])[0];
              ctx.identified_orders = [o.order_number];
              dataFound += `\nAuto-identified: ${o.order_number} ($${(o.total_cents / 100).toFixed(2)}, ${new Date(o.created_at).toLocaleDateString()}, source: ${o.source_name || "unknown"})`;
            }
            if ((orders || []).length > 1) {
              dataFound += `\nOrders: ${(orders || []).slice(0, 5).map((o: { order_number: string; total_cents: number; created_at: string; source_name: string | null }) => `${o.order_number} ($${(o.total_cents / 100).toFixed(2)}, ${new Date(o.created_at).toLocaleDateString()}, ${o.source_name || "unknown"})`).join("; ")}`;
              ctx.identified_orders = [(orders || [])[0].order_number];
            }
            conditionResult = `Identified: ${(ctx.identified_orders as string[] || []).join(", ") || "none"}`;
            break;
          }
          case "identify_subscription": {
            const activeSubs = (subs || []).filter((s: { status: string }) => s.status === "active" || s.status === "paused");
            const cancelledSubs = (subs || []).filter((s: { status: string }) => s.status === "cancelled");
            const matched = activeSubs[0] || cancelledSubs[0];
            if (matched) {
              ctx.identified_subscription = matched.shopify_contract_id;
              ctx.subscription_status = matched.status;
              ctx.subscription_created = matched.created_at;
              dataFound = `Matched subscription #${matched.shopify_contract_id} (${matched.status}, created ${new Date(matched.created_at).toLocaleDateString()})`;
            } else {
              dataFound = "No matching subscription found";
              warnings.push("No subscription found for this customer.");
            }
            conditionResult = matched ? `Linked to order(s): ${(ctx.identified_orders as string[] || []).join(", ")}` : "No subscription match";
            skipped = !matched && step.skippable;
            break;
          }
          case "check_other_subscriptions": {
            const identifiedSub = ctx.identified_subscription as string | undefined;
            const otherActive = (subs || []).filter((s: { status: string; shopify_contract_id: string }) => s.status === "active" && s.shopify_contract_id !== identifiedSub);
            ctx.other_active_subs = otherActive.map((s: { shopify_contract_id: string }) => s.shopify_contract_id);
            ctx.other_active_count = otherActive.length;
            dataFound = `${otherActive.length} other active subscription(s)`;
            conditionResult = otherActive.length > 0 ? "AI will proactively mention other subs" : "No other subs to mention";
            skipped = true;
            break;
          }
          case "apply_policy": {
            const policyId = step.config?.policy_id as string;
            const policy = (policies || []).find((p: { id: string }) => p.id === policyId);
            if (!policy) { warnings.push("No policy linked to this step."); conditionResult = "ERROR: No policy configured"; break; }
            const identifiedOrders = (ctx.identified_orders as string[]) || [];
            const orderObjs = (orders || []).filter((o: { order_number: string }) => identifiedOrders.includes(o.order_number));
            const inPolicy: string[] = []; const outOfPolicy: string[] = [];
            for (const o of orderObjs) {
              const eligible = evalConditions(policy.conditions, o);
              if (eligible.pass) inPolicy.push(o.order_number);
              else { outOfPolicy.push(o.order_number); warnings.push(`Order ${o.order_number} FAILS policy: ${eligible.reason}`); }
            }
            ctx.in_policy = inPolicy; ctx.out_of_policy = outOfPolicy; ctx.policy_applied = policy.name;
            dataFound = `Policy: "${policy.name}"\nConditions: ${JSON.stringify(policy.conditions)}`;
            conditionResult = `In policy: ${inPolicy.join(", ") || "none"} | Out of policy: ${outOfPolicy.join(", ") || "none"}`;
            break;
          }
          case "offer_exception": {
            const policyId = step.config?.policy_id as string;
            const polExceptions = (exceptions || []).filter((e: { policy_id: string }) => e.policy_id === policyId);
            const outOfPolicy = (ctx.out_of_policy as string[]) || [];
            if (outOfPolicy.length === 0) { conditionResult = "All orders in policy — no exception needed"; skipped = true; break; }

            // Set a consistent mock shipping rate for the entire simulation
            if (!ctx.label_cost_cents) {
              const identifiedOrders = (ctx.identified_orders as string[]) || [];
              const orderObj = (orders || []).find((o: { order_number: string }) => identifiedOrders.includes(o.order_number));
              const mockLabelCost = 795; // $7.95 consistent mock rate
              const orderTotal = orderObj?.total_cents || 7481;
              ctx.label_cost_cents = mockLabelCost;
              ctx.order_total_cents = orderTotal;
              ctx.net_refund_cents = orderTotal - mockLabelCost;
            }

            const autoGrants = polExceptions.filter((e: { auto_grant: boolean }) => e.auto_grant);
            if (autoGrants.length) {
              dataFound += `Auto-grant exceptions: ${autoGrants.map((e: { name: string; auto_grant_trigger: string | null }) => `${e.name} (${e.auto_grant_trigger})`).join(", ")}\nNote: Auto-grant detection not yet fully implemented.\n`;
            }

            const tiered = polExceptions.filter((e: { auto_grant: boolean }) => !e.auto_grant).sort((a: { tier: number }, b: { tier: number }) => a.tier - b.tier);
            const eligibleTiers = tiered.filter((ex: { conditions: Record<string, unknown> }) => evalCustomerConditions(ex.conditions, customer).pass);
            const ineligibleTiers = tiered.filter((ex: { conditions: Record<string, unknown> }) => !evalCustomerConditions(ex.conditions, customer).pass);

            const preExRounds = playbook.stand_firm_before_exceptions || 2;
            const betweenRounds = playbook.stand_firm_between_tiers || 2;
            const disqualifiers = (playbook.exception_disqualifiers || []) as { type: string; source?: string }[];

            dataFound += `Customer LTV: $${(customer.ltv_cents / 100).toFixed(2)}, Orders: ${customer.total_orders}\n`;
            dataFound += `Stand firm before exceptions: ${preExRounds}, between tiers: ${betweenRounds}\n`;
            dataFound += eligibleTiers.map((e: { tier: number; name: string; resolution_type: string }) => `Tier ${e.tier}: ${e.name} (${e.resolution_type}) — ELIGIBLE`).join("\n");
            if (ineligibleTiers.length) dataFound += "\n" + ineligibleTiers.map((e: { tier: number; name: string }) => `Tier ${e.tier}: ${e.name} — NOT eligible`).join("\n");
            if (disqualifiers.length) dataFound += `\nDisqualifiers: ${disqualifiers.map(d => d.type).join(", ")}`;

            // ── Check disqualifiers ──
            let disqualified = false;
            let dqReason = "";
            for (const dq of disqualifiers) {
              if (dq.type === "previous_exception") {
                const { count } = await admin.from("returns").select("id", { count: "exact", head: true })
                  .eq("workspace_id", workspaceId).eq("customer_id", customer_id).eq("source", dq.source || "playbook").not("status", "eq", "cancelled");
                if ((count || 0) > 0) { disqualified = true; dqReason = `Previous ${dq.source || "playbook"} exception found`; break; }
              }
              if (dq.type === "has_chargeback") {
                const { count } = await admin.from("chargeback_events").select("id", { count: "exact", head: true })
                  .eq("workspace_id", workspaceId).eq("customer_id", customer_id);
                if ((count || 0) > 0) { disqualified = true; dqReason = "Customer has filed a chargeback"; break; }
              }
            }

            if (disqualified) {
              emitStep({
                step_name: `${step.name} — DISQUALIFIED`, step_type: "offer_exception", step_order: step.step_order,
                data_found: dataFound, condition_result: `Disqualified: ${dqReason}. No exceptions will be offered (${playbook.disqualifier_behavior || "silent"}).`,
                ai_response: "", mock_customer_reply: "",
                warnings: [`Customer disqualified from exceptions: ${dqReason}`], skipped: true,
              });
              ctx.disqualified = true;
              ctx.exception_exhausted = true;
              continue;
            }

            if (eligibleTiers.length === 0) {
              conditionResult = "No exceptions match this customer";
              warnings.push("Customer doesn't qualify for any exception tier.");
              break;
            }

            // ── Simulate: pre-exception stand firm → tier → between-tier stand firm → tier ──
            for (let t = 0; t < eligibleTiers.length; t++) {
              const ex = eligibleTiers[t] as { tier: number; name: string; resolution_type: string; instructions: string | null };
              const roundsNeeded = t === 0 ? preExRounds : betweenRounds;

              // Stand firm rounds before this tier
              for (let sf = 0; sf < roundsNeeded; sf++) {
                const sfPosition = t === 0 ? "before any exception" : `before Tier ${ex.tier}`;
                const sfAI = await genAI(
                  { name: `Stand Firm (${sfPosition})`, type: "stand_firm", instructions: step.instructions },
                  `Stand firm ${sf + 1}/${roundsNeeded} ${sfPosition}`,
                  `Stand firm round ${sf + 1}/${roundsNeeded} ${sfPosition}. No exception offered yet at this point.`,
                  currentMessage,
                );
                const sfMock = await genMock(sfAI, `Stand firm ${sfPosition}`, true);
                currentMessage = sfMock;

                emitStep({
                  step_name: `Stand Firm ${sf + 1}/${roundsNeeded} (${sfPosition})`,
                  step_type: "stand_firm", step_order: step.step_order,
                  data_found: `Pre-exception stand firm. ${t === 0 ? "Policy only, no exception yet." : `Customer rejected Tier ${eligibleTiers[t - 1].tier}.`}`,
                  condition_result: `Stand firm ${sf + 1}/${roundsNeeded} ${sfPosition}`,
                  ai_response: sfAI, mock_customer_reply: sfMock,
                  warnings: [], skipped: false,
                });
              }

              // Now offer the tier
              ctx.current_exception_tier = ex.tier;
              ctx.exception_offered = ex.name;
              ctx.resolution_type = ex.resolution_type;
              exceptionsUsed++;

              const tierCondResult = `Offering Tier ${ex.tier}: ${ex.name} (${ex.resolution_type})${t > 0 ? " — escalated after stand firm" : ""}`;
              const mockBreakdown = `\nShipping rate: $${((ctx.label_cost_cents as number) / 100).toFixed(2)}. Order: $${((ctx.order_total_cents as number) / 100).toFixed(2)}. Net ${ex.resolution_type.includes("refund") ? "refund" : "store credit"}: $${((ctx.net_refund_cents as number) / 100).toFixed(2)}. Tell the customer this exact breakdown. Say "approximately" since final cost may vary slightly.`;
              const tierAI = await genAI(
                { name: step.name, type: step.type, instructions: (ex.instructions || step.instructions) + mockBreakdown },
                dataFound, tierCondResult, currentMessage,
              );
              const tierMock = await genMock(tierAI, `${step.name} — Tier ${ex.tier}`, true);
              currentMessage = tierMock;

              emitStep({
                step_name: t === 0 ? step.name : `${step.name} — Tier ${ex.tier} (escalated)`,
                step_type: "offer_exception", step_order: step.step_order,
                data_found: t === 0 ? dataFound : `Escalated after ${roundsNeeded} stand firm rounds`,
                condition_result: tierCondResult, ai_response: tierAI,
                mock_customer_reply: tierMock, warnings: t === 0 ? warnings : [], skipped: false,
              });
            }

            conditionResult = `All ${eligibleTiers.length} eligible tiers offered (with stand firm rounds) and rejected`;
            ctx.exception_exhausted = true;
            continue;
          }
          case "initiate_return": {
            // Gate: customer must have accepted
            if (!ctx.offer_accepted) {
              dataFound = "Customer has NOT accepted any offer";
              conditionResult = "SKIPPED — no acceptance detected. Customer rejected all tiers.";
              skipped = true;
              break;
            }
            const inPolicy = (ctx.in_policy as string[]) || [];
            const exceptionOrders = ctx.exception_offered ? [(ctx.out_of_policy as string[] || []).slice(-1)[0]].filter(Boolean) : [];
            const returnable = [...new Set([...inPolicy, ...exceptionOrders])];
            const resType = ctx.resolution_type as string || "store_credit_return";
            const labelCost = ctx.label_cost_cents as number | undefined;
            const netRefund = ctx.net_refund_cents as number | undefined;
            const orderTotal = ctx.order_total_cents as number | undefined;
            const breakdownStr = labelCost && netRefund && orderTotal
              ? `\nBreakdown: $${(orderTotal / 100).toFixed(2)} minus ~$${(labelCost / 100).toFixed(2)} shipping = ~$${(netRefund / 100).toFixed(2)}`
              : "";
            dataFound = `Returnable orders: ${returnable.join(", ") || "none"}${breakdownStr}\nLabel generated + emailed to customer + link in response`;
            conditionResult = returnable.length > 0
              ? `Return created, label purchased for: ${returnable.join(", ")} (${resType})`
              : "No orders eligible for return";
            ctx.return_initiated = returnable.length > 0;
            ctx.return_orders = returnable;
            break;
          }
          case "cancel_subscription": {
            const identifiedSub = ctx.identified_subscription as string | undefined;
            const otherActive = (ctx.other_active_subs as string[]) || [];
            const allToCancel = identifiedSub ? [identifiedSub, ...otherActive] : otherActive;
            dataFound = `Subscriptions to cancel: ${allToCancel.map(s => `#${s}`).join(", ") || "none"}`;
            conditionResult = allToCancel.length > 0 ? `Will cancel ${allToCancel.length} subscription(s)` : "No subscriptions to cancel";
            if (allToCancel.length === 0) warnings.push("No subscriptions found to cancel.");
            break;
          }
          case "issue_store_credit": {
            const returnOrders = (ctx.return_orders as string[]) || [];
            const orderObjs = (orders || []).filter((o: { order_number: string }) => returnOrders.includes(o.order_number));
            const totalCents = orderObjs.reduce((s: number, o: { total_cents: number }) => s + o.total_cents, 0);
            dataFound = `Store credit amount: $${(totalCents / 100).toFixed(2)} from orders: ${returnOrders.join(", ")}`;
            conditionResult = totalCents > 0 ? `$${(totalCents / 100).toFixed(2)} pending return receipt` : "No amount to credit";
            break;
          }
          case "stand_firm": {
            const wasOffered = ctx.exception_offered as string | undefined;
            const currentTier = Number(ctx.current_exception_tier) || 0;
            const maxReps = playbook.stand_firm_max || 3;
            dataFound = `Best offer: ${wasOffered || "none"} (Tier ${currentTier}, ${ctx.resolution_type || "none"}). Max repetitions: ${maxReps}`;
            if (!wasOffered) warnings.push("No exception was offered before stand_firm.");

            // Simulate stand_firm loop — customer accepts after 2nd round (or all rejections if maxReps <= 2)
            const acceptAfterRound = Math.min(2, maxReps); // Accept after round 2

            for (let rep = 0; rep < maxReps; rep++) {
              const repCondResult = `Stand firm ${rep + 1}/${maxReps}. Restating offer with different wording.`;

              const sfInstructions = `${step.instructions || ""}\n\nThis is attempt ${rep + 1}/${maxReps}.\n\nAcknowledge frustration. Restate the best available offer (${wasOffered || "return"}) following store policy rules. Use DIFFERENT wording than previous attempts. Do not argue or get defensive.`;

              const sfAI = await genAI(
                { name: step.name, type: step.type, instructions: sfInstructions },
                dataFound, repCondResult, currentMessage,
              );

              // After acceptAfterRound, mock customer accepts
              if (rep + 1 >= acceptAfterRound) {
                const acceptMock = await aiCall(
                  `You are simulating a ${sentimentLabel} customer who has been going back and forth but is now RELUCTANTLY accepting the offer. Generate a brief acceptance (1-2 sentences). Still ${sentimentLabel} but agreeing. Say something like "fine" or "ok whatever just do it."`,
                  `AI offered: "${sfAI}"\nSentiment: ${sentimentLabel}\nThe customer has rejected ${rep + 1} times but is now giving in.`, 100);
                currentMessage = acceptMock;

                emitStep({
                  step_name: `${step.name} (${rep + 1}/${maxReps})`,
                  step_type: "stand_firm", step_order: step.step_order,
                  data_found: rep === 0 ? dataFound : `Stand firm round ${rep + 1}.`,
                  condition_result: repCondResult, ai_response: sfAI,
                  mock_customer_reply: acceptMock,
                  warnings: rep === 0 ? warnings : [], skipped: false,
                });

                // Customer accepted — emit initiate_return
                ctx.offer_accepted = true;
                const returnStep = steps.find((s: { type: string }) => s.type === "initiate_return");
                const inPolicy = (ctx.in_policy as string[]) || [];
                const exceptionOrders = ctx.exception_offered ? [(ctx.out_of_policy as string[] || []).slice(-1)[0]].filter(Boolean) : [];
                const returnable = [...new Set([...inPolicy, ...exceptionOrders])];
                const resType = ctx.resolution_type as string || "store_credit_return";
                const resLabel = resType.includes("refund") ? "full refund" : "store credit";

                const labelCostCents = ctx.label_cost_cents as number | undefined;
                const netRefundCents = ctx.net_refund_cents as number | undefined;
                const orderTotalCents = ctx.order_total_cents as number | undefined;
                const breakdownSim = labelCostCents && netRefundCents && orderTotalCents
                  ? `\nApproximate breakdown: order $${(orderTotalCents / 100).toFixed(2)} minus ~$${(labelCostCents / 100).toFixed(2)} shipping = ~$${(netRefundCents / 100).toFixed(2)} ${resLabel}.`
                  : "";
                const fakeLabelUrl = "https://easypost-files.s3.amazonaws.com/files/postage_label/EXAMPLE_LABEL.pdf";

                const returnAI = await genAI(
                  { name: returnStep?.name || "Initiate Return", type: "initiate_return", instructions: `${returnStep?.instructions || ""}\n\nA return shipping label has been generated. Include this download link in your response: ${fakeLabelUrl}\nAlso mention the label was sent to their email as a backup. Follow the store policy rules.` },
                  `Returnable orders: ${returnable.join(", ")}. Resolution: ${resLabel}${breakdownSim}\nLabel URL: ${fakeLabelUrl}`,
                  `Customer accepted the ${resLabel} offer. Return created, label purchased, emailed to customer.`,
                  acceptMock,
                );

                // Generate a sassy parting shot from the customer after the return is set up
                const sassyReply = await aiCall(
                  `You are simulating a ${sentimentLabel} customer who just reluctantly accepted a return offer after a heated exchange. Generate a final parting shot (1-2 sentences). They're accepting but making it clear they're unhappy about the whole experience. Sassy, bitter, threatening to never shop again. Sentiment: ${sentimentLabel}.`,
                  `AI just said: "${returnAI}"\nThe customer agreed to the ${resLabel} but is still furious about the whole ordeal.`, 100);

                emitStep({
                  step_name: "Initiate Return (accepted mid-stand-firm)",
                  step_type: "initiate_return", step_order: returnStep?.step_order || step.step_order,
                  data_found: `Customer accepted after ${rep + 1} stand firm rounds.\nReturnable orders: ${returnable.join(", ")}\nResolution: ${resLabel}${breakdownSim}\nLabel generated: ${fakeLabelUrl}\nLabel emailed to customer + link included in response`,
                  condition_result: `Acceptance detected — return created, label purchased, initiating for ${returnable.join(", ")}`,
                  ai_response: returnAI, mock_customer_reply: sassyReply,
                  warnings: [], skipped: false,
                });

                // Final AI response handling the sassy parting shot
                // Pull next-steps from the accepted exception's instructions (tenant-specific, not hardcoded)
                const acceptedTier = Number(ctx.current_exception_tier) || 1;
                const acceptedEx = (exceptions || []).find((e: { tier: number; auto_grant: boolean }) => !e.auto_grant && e.tier === acceptedTier);
                const exNextSteps = (acceptedEx as { instructions?: string } | undefined)?.instructions || "";

                const closingBreakdown = `Order: $${((ctx.order_total_cents as number) / 100).toFixed(2)}, label: ~$${((ctx.label_cost_cents as number) / 100).toFixed(2)}, net ${resLabel}: ~$${((ctx.net_refund_cents as number) / 100).toFixed(2)}.`;
                const closingAI = await genAI(
                  { name: "Closing Response", type: "custom", instructions: `The customer accepted but left a sassy/rude parting shot. Be completely unfazed — do NOT acknowledge the negativity, do NOT apologize, do NOT empathize with their frustration. Just be positive and forward-looking. Briefly restate what they need to do next based on the store policy rules and the return process: ${exNextSteps}\n\nUse these EXACT numbers: ${closingBreakdown}\n\nKeep it to 2-3 sentences max. Warm but unbothered. When saying "prepaid label," always mention the cost is deducted from the refund/credit.` },
                  `Customer accepted ${resLabel} for ${returnable.join(", ")}. Return being processed. ${closingBreakdown}`,
                  `Customer accepted but is upset about the experience.`,
                  sassyReply,
                );

                emitStep({
                  step_name: "Closing Response",
                  step_type: "custom", step_order: (returnStep?.step_order || step.step_order) + 1,
                  data_found: "Customer accepted but left a sassy parting shot.",
                  condition_result: "AI sends professional closing with next steps.",
                  ai_response: closingAI, mock_customer_reply: "",
                  warnings: [], skipped: false,
                });

                // Simulate post-acceptance loop: customer replies again with sass
                const postAcceptMock = await aiCall(
                  `You are simulating a ${sentimentLabel} customer who already accepted a return but is sending one more angry/sassy message. 1-2 sentences. Complaining about the experience, threatening to leave a bad review, or just venting.`,
                  `The return was processed. Customer is ${sentimentLabel}. Generate one more parting shot.`, 80);

                const postAcceptAI = await genAI(
                  { name: "Post-Acceptance Loop", type: "custom", instructions: `The customer already accepted the return and we already told them next steps. They're just venting now. Do NOT re-negotiate, do NOT offer anything new, do NOT apologize. Just be positive, briefly restate what they need to do next based on store policy rules and the return process: ${exNextSteps}\n\nUse these EXACT numbers: ${closingBreakdown}\n\nBe unfazed. 1-2 sentences max. When saying "prepaid label," always mention the cost is deducted from the refund/credit.` },
                  `Post-acceptance: customer venting. ${closingBreakdown}`,
                  `Customer already accepted. Return initiated. Restate next steps with exact numbers.`,
                  postAcceptMock,
                );

                emitStep({
                  step_name: "Post-Acceptance Loop (customer replies again)",
                  step_type: "custom", step_order: (returnStep?.step_order || step.step_order) + 2,
                  data_found: "Customer sent another message after accepting. Executor stays in post-acceptance loop.",
                  condition_result: "AI restates next steps without re-negotiating. This loops indefinitely.",
                  ai_response: postAcceptAI, mock_customer_reply: postAcceptMock,
                  warnings: [], skipped: false,
                });

                break; // Exit stand_firm loop
              }

              // Still rejecting
              const sfMock = await genMock(sfAI, `${step.name} (${rep + 1}/${maxReps})`, true);
              currentMessage = sfMock;

              emitStep({
                step_name: `${step.name} (${rep + 1}/${maxReps})`,
                step_type: "stand_firm", step_order: step.step_order,
                data_found: rep === 0 ? dataFound : `Rejection ${rep + 1}. Customer still refusing.`,
                condition_result: repCondResult, ai_response: sfAI,
                mock_customer_reply: sfMock,
                warnings: rep === 0 ? warnings : [], skipped: false,
              });
            }
            conditionResult = ctx.offer_accepted ? `Customer accepted after stand firm.` : `All ${maxReps} stand firm rounds completed.`;
            continue; // Skip default emit
          }
          default: {
            dataFound = `Step type: ${step.type}`;
            conditionResult = step.instructions ? "Has instructions" : "No instructions configured";
            if (!step.instructions) warnings.push("This step has no instructions.");
          }
        }

        // Generate AI response (for non-looping steps)
        if (!skipped) {
          aiResponse = await genAI(step, dataFound, conditionResult, currentMessage);
        }

        // Generate mock customer reply (for non-looping, non-last steps)
        const isLast = step.step_order === steps[steps.length - 1].step_order;
        if (!isLast && !skipped) {
          mockReply = await genMock(aiResponse, step.name);
          currentMessage = mockReply;
        }

        emitStep({
          step_name: step.name, step_type: step.type, step_order: step.step_order,
          data_found: dataFound, condition_result: conditionResult, ai_response: aiResponse,
          mock_customer_reply: mockReply, warnings, skipped,
        });
      }

  const resultPayload = {
    playbook_name: playbook.name,
    customer_name: customerName,
    customer_email: customer.email,
    sentiment: sentimentLabel,
    initial_message: message,
    clarification_response: clarification_response || null,
    confidence: classification.confidence,
    detected_intent: classification.intent,
    classification_reasoning: classification.reasoning,
    threshold,
    steps: simSteps,
  };

  // Save to DB for reference
  const { data: saved } = await admin.from("playbook_simulations").insert({
    workspace_id: workspaceId,
    playbook_id,
    customer_id,
    customer_name: customerName,
    customer_email: customer.email,
    message,
    sentiment: sentimentLabel,
    result: resultPayload,
  }).select("id").single();

  send({ type: "complete", ref: saved?.id || null });
  controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}

// GET: Retrieve simulation by reference ID
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  if (!ref) return NextResponse.json({ error: "ref required" }, { status: 400 });

  const admin = createAdminClient();
  const { data } = await admin.from("playbook_simulations")
    .select("*")
    .eq("id", ref)
    .eq("workspace_id", workspaceId)
    .single();

  if (!data) return NextResponse.json({ error: "Simulation not found" }, { status: 404 });

  return NextResponse.json(data.result);
}

// ── Helpers ──

function buildDataSummary(
  customer: { first_name: string | null; last_name: string | null; email: string; ltv_cents: number; total_orders: number; retention_score: number },
  orders: { order_number: string; total_cents: number; created_at: string; source_name: string | null; line_items: unknown[]; financial_status: string }[],
  subs: { shopify_contract_id: string; status: string; billing_interval: string; billing_interval_count: number; items: unknown[]; created_at: string }[],
): string {
  const parts: string[] = [];
  parts.push(`Customer: ${customer.first_name || ""} ${customer.last_name || ""} (${customer.email})`);
  parts.push(`LTV: $${(customer.ltv_cents / 100).toFixed(2)} | Orders: ${customer.total_orders} | Retention: ${customer.retention_score}/100`);
  if (orders.length) {
    parts.push(`\nOrders (${orders.length}):`);
    for (const o of orders.slice(0, 5)) {
      const items = (o.line_items as { title?: string }[] || []).map(i => i.title || "item").join(", ");
      parts.push(`  ${o.order_number} — $${(o.total_cents / 100).toFixed(2)} — ${o.financial_status} — ${new Date(o.created_at).toLocaleDateString()} — source: ${o.source_name || "?"} — ${items}`);
    }
  }
  if (subs.length) {
    parts.push(`\nSubscriptions (${subs.length}):`);
    for (const s of subs) {
      const items = (s.items as { title?: string }[] || []).map(i => i.title || "item").join(", ");
      parts.push(`  #${s.shopify_contract_id} — ${s.status} — every ${s.billing_interval_count} ${s.billing_interval} — ${items}`);
    }
  }
  return parts.join("\n");
}

function evalConditions(conditions: Record<string, unknown>, order: { created_at: string; source_name: string | null; financial_status: string }): { pass: boolean; reason: string } {
  for (const [key, rule] of Object.entries(conditions)) {
    const r = rule as Record<string, unknown>;
    if (key === "days_since_fulfillment" || key === "days_since_delivery" || key === "days_since_order") {
      const daysSince = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000);
      if (r["<="] && daysSince > Number(r["<="])) return { pass: false, reason: `${key}: ${daysSince} days > ${r["<="]} max` };
      if (r[">="] && daysSince < Number(r[">="])) return { pass: false, reason: `${key}: ${daysSince} days < ${r[">="]} min` };
    }
    if (key === "source_name") {
      const src = order.source_name || "";
      if (r["not_contains"] && src.toLowerCase().includes(String(r["not_contains"]).toLowerCase())) return { pass: false, reason: `source_name "${src}" contains "${r["not_contains"]}" (excluded)` };
      if (r["contains"] && !src.toLowerCase().includes(String(r["contains"]).toLowerCase())) return { pass: false, reason: `source_name "${src}" missing "${r["contains"]}"` };
      if (r["eq"] && src !== r["eq"]) return { pass: false, reason: `source_name "${src}" != "${r["eq"]}"` };
    }
    if (key === "financial_status") {
      if (r["eq"] && order.financial_status !== r["eq"]) return { pass: false, reason: `financial_status "${order.financial_status}" != "${r["eq"]}"` };
    }
  }
  return { pass: true, reason: "All conditions met" };
}

function evalCustomerConditions(conditions: Record<string, unknown>, customer: { ltv_cents: number; total_orders: number; retention_score: number }): { pass: boolean; reason: string } {
  if (conditions.or && Array.isArray(conditions.or)) {
    const results = (conditions.or as Record<string, unknown>[]).map(c => evalCustomerConditions(c, customer));
    if (results.some(r => r.pass)) return { pass: true, reason: "OR condition met" };
    return { pass: false, reason: `None of OR conditions met: ${results.map(r => r.reason).join("; ")}` };
  }
  for (const [key, rule] of Object.entries(conditions)) {
    if (key === "or") continue;
    const r = rule as Record<string, unknown>;
    if (key === "ltv_cents") {
      if (r[">="] && customer.ltv_cents < Number(r[">="])) return { pass: false, reason: `LTV $${(customer.ltv_cents / 100).toFixed(2)} < $${(Number(r[">="]) / 100).toFixed(2)} required` };
    }
    if (key === "total_orders") {
      if (r[">="] && customer.total_orders < Number(r[">="])) return { pass: false, reason: `${customer.total_orders} orders < ${r[">="]} required` };
    }
    if (key === "retention_score") {
      if (r[">="] && customer.retention_score < Number(r[">="])) return { pass: false, reason: `Retention ${customer.retention_score} < ${r[">="]} required` };
    }
  }
  return { pass: true, reason: "All conditions met" };
}
