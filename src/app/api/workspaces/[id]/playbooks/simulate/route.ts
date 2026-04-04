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
  const { playbook_id, customer_id, message, sentiment } = body as {
    playbook_id: string; customer_id: string; message: string; sentiment: string;
  };

  if (!playbook_id || !customer_id || !message) {
    return NextResponse.json({ error: "playbook_id, customer_id, and message required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Load playbook with children
  const { data: playbook } = await admin.from("playbooks")
    .select("*").eq("id", playbook_id).single();
  if (!playbook) return NextResponse.json({ error: "Playbook not found" }, { status: 404 });

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

  // Simulate step by step
  const simSteps: SimStep[] = [];
  let currentMessage = message;
  const ctx: Record<string, unknown> = {};
  let exceptionsUsed = 0;
  const sentimentLabel = sentiment || "neutral";

  for (const step of steps) {
    const warnings: string[] = [];
    let dataFound = "";
    let conditionResult = "";
    let aiResponse = "";
    let mockReply = "";
    let skipped = false;

    // ── Data found for this step ──
    switch (step.type) {
      case "identify_order": {
        dataFound = `${(orders || []).length} orders found in last ${lookbackDays} days`;
        if ((orders || []).length === 0) warnings.push("Customer has no recent orders. The playbook will ask for an order number.");
        if ((orders || []).length === 1) {
          const o = (orders || [])[0];
          ctx.identified_orders = [o.order_number];
          dataFound += `\nAuto-identified: ${o.order_number} ($${(o.total_cents / 100).toFixed(2)}, ${new Date(o.created_at).toLocaleDateString()}, source: ${o.source_name || "unknown"})`;
        }
        if ((orders || []).length > 1) {
          dataFound += `\nOrders: ${(orders || []).slice(0, 5).map((o: { order_number: string; total_cents: number; created_at: string; source_name: string | null }) => `${o.order_number} ($${(o.total_cents / 100).toFixed(2)}, ${new Date(o.created_at).toLocaleDateString()}, ${o.source_name || "unknown"})`).join("; ")}`;
          // Simulate: AI would ask which order. Mock reply picks the most recent.
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
          warnings.push("No subscription found for this customer. Steps that reference subscription data may not work.");
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
        if (otherActive.length > 0) {
          dataFound += `: ${otherActive.map((s: { shopify_contract_id: string }) => `#${s.shopify_contract_id}`).join(", ")}`;
        }
        conditionResult = otherActive.length > 0 ? "AI will proactively mention other subs" : "No other subs to mention";
        skipped = true; // This step always auto-advances
        break;
      }
      case "apply_policy": {
        const policyId = step.config?.policy_id as string;
        const policy = (policies || []).find((p: { id: string }) => p.id === policyId);
        if (!policy) {
          warnings.push("No policy linked to this step. Configure a policy_id in the step config.");
          conditionResult = "ERROR: No policy configured";
          break;
        }
        const identifiedOrders = (ctx.identified_orders as string[]) || [];
        const orderObjs = (orders || []).filter((o: { order_number: string }) => identifiedOrders.includes(o.order_number));
        const inPolicy: string[] = [];
        const outOfPolicy: string[] = [];
        for (const o of orderObjs) {
          const eligible = evalConditions(policy.conditions, o);
          if (eligible.pass) inPolicy.push(o.order_number);
          else {
            outOfPolicy.push(o.order_number);
            warnings.push(`Order ${o.order_number} FAILS policy: ${eligible.reason}`);
          }
        }
        ctx.in_policy = inPolicy;
        ctx.out_of_policy = outOfPolicy;
        ctx.policy_applied = policy.name;
        dataFound = `Policy: "${policy.name}"\nConditions: ${JSON.stringify(policy.conditions)}`;
        conditionResult = `In policy: ${inPolicy.join(", ") || "none"} | Out of policy: ${outOfPolicy.join(", ") || "none"}`;
        break;
      }
      case "offer_exception": {
        const policyId = step.config?.policy_id as string;
        const polExceptions = (exceptions || []).filter((e: { policy_id: string }) => e.policy_id === policyId);
        const outOfPolicy = (ctx.out_of_policy as string[]) || [];
        if (outOfPolicy.length === 0) {
          conditionResult = "All orders in policy — no exception needed";
          skipped = true;
          break;
        }
        // Check auto-grants
        const autoGrants = polExceptions.filter((e: { auto_grant: boolean }) => e.auto_grant);
        if (autoGrants.length) {
          dataFound += `Auto-grant exceptions: ${autoGrants.map((e: { name: string; auto_grant_trigger: string | null }) => `${e.name} (${e.auto_grant_trigger})`).join(", ")}\n`;
          dataFound += `Note: Auto-grant detection is not yet fully implemented for triggers.`;
        }
        // Check tiered
        const tiered = polExceptions.filter((e: { auto_grant: boolean }) => !e.auto_grant).sort((a: { tier: number }, b: { tier: number }) => a.tier - b.tier);
        const eligible: string[] = [];
        const ineligible: string[] = [];
        for (const ex of tiered) {
          const result = evalCustomerConditions(ex.conditions, customer);
          if (result.pass) eligible.push(`Tier ${ex.tier}: ${ex.name} (${ex.resolution_type}) — ELIGIBLE`);
          else ineligible.push(`Tier ${ex.tier}: ${ex.name} — NOT eligible: ${result.reason}`);
        }
        dataFound += `Customer LTV: $${(customer.ltv_cents / 100).toFixed(2)}, Orders: ${customer.total_orders}\n`;
        dataFound += [...eligible, ...ineligible].join("\n");
        if (eligible.length > 0) {
          const firstEligible = tiered.find((_e: { auto_grant: boolean }, i: number) => {
            return evalCustomerConditions(polExceptions.filter((e: { auto_grant: boolean }) => !e.auto_grant).sort((a: { tier: number }, b: { tier: number }) => a.tier - b.tier)[i]?.conditions || {}, customer).pass;
          });
          if (firstEligible) {
            ctx.exception_offered = firstEligible.name;
            ctx.resolution_type = firstEligible.resolution_type;
            ctx.current_exception_tier = firstEligible.tier;
            exceptionsUsed++;
          }
          conditionResult = `Offering: ${eligible[0]}`;
        } else {
          conditionResult = "No exceptions match this customer";
          warnings.push("Customer doesn't qualify for any exception tier. They'll hit the stand_firm step.");
        }
        if (ineligible.length > 0) {
          for (const note of ineligible) warnings.push(note);
        }
        break;
      }
      case "initiate_return": {
        const inPolicy = (ctx.in_policy as string[]) || [];
        const exceptionOrders = ctx.exception_offered ? [(ctx.out_of_policy as string[] || []).slice(-1)[0]].filter(Boolean) : [];
        const returnable = [...new Set([...inPolicy, ...exceptionOrders])];
        dataFound = `Returnable orders: ${returnable.join(", ") || "none"}`;
        conditionResult = returnable.length > 0
          ? `Return will be initiated for: ${returnable.join(", ")} (${ctx.resolution_type || "store_credit_return"})`
          : "No orders eligible for return";
        if (returnable.length === 0) warnings.push("No orders are returnable at this point. The step will be skipped.");
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
        dataFound = `Best offer: ${wasOffered || "none"}. Max repetitions: ${playbook.stand_firm_max}`;
        conditionResult = `AI will restate offer up to ${playbook.stand_firm_max} times, then send final message and stop`;
        if (!wasOffered) warnings.push("No exception was offered before stand_firm. AI will have nothing specific to restate.");
        break;
      }
      default: {
        dataFound = `Step type: ${step.type}`;
        conditionResult = step.instructions ? "Has instructions" : "No instructions configured";
        if (!step.instructions) warnings.push("This step has no instructions. AI won't know what to do.");
      }
    }

    // Generate AI response for this step (dry run)
    if (!skipped) {
      aiResponse = await aiCall(
        [
          "You are simulating a customer support AI for a playbook dry-run. Generate the AI response for this step.",
          "Rules: max 2-3 sentences per paragraph. Plain text only, no markdown. Be empathetic.",
          step.instructions ? `Step instructions: ${step.instructions}` : "",
        ].filter(Boolean).join("\n"),
        `Customer data:\n${dataSummary}\n\nPlaybook context so far: ${JSON.stringify(ctx)}\nStep: "${step.name}" (${step.type})\nData found: ${dataFound}\nCondition result: ${conditionResult}\n\nCustomer message: "${currentMessage}"\n\nGenerate what the AI would say to the customer at this step. Keep it realistic.`,
        300,
      );
    }

    // Generate mock customer reply for next step (except last step and stand_firm)
    const isLast = step.step_order === steps[steps.length - 1].step_order;
    const isStandFirm = step.type === "stand_firm";
    if (!isLast && !skipped && !isStandFirm) {
      mockReply = await aiCall(
        [
          `You are simulating a ${sentimentLabel} customer replying to a support agent. Sentiment: ${sentimentLabel}.`,
          "Generate a realistic, brief customer reply (1-3 sentences). Match the sentiment exactly.",
          sentimentLabel === "angry" ? "Be hostile, use caps or exclamations. Demand resolution. Express outrage." : "",
          sentimentLabel === "frustrated" ? "Be exasperated, short-tempered. Show impatience but not abusive." : "",
          sentimentLabel === "confused" ? "Ask clarifying questions. Show uncertainty about what happened." : "",
          sentimentLabel === "polite" ? "Be cooperative and understanding. Thank them but still want resolution." : "",
          sentimentLabel === "neutral" ? "Be straightforward. Just answer the question or confirm." : "",
          "Do NOT include any metadata, just the customer's words.",
        ].filter(Boolean).join("\n"),
        `The AI just said:\n"${aiResponse}"\n\nPlaybook context: The customer originally said "${message}" about ${playbook.name.toLowerCase()}.\nStep just completed: ${step.name} (${step.type})\nCondition result: ${conditionResult}\n\nGenerate a realistic mock reply from the ${sentimentLabel} customer.`,
        150,
      );
      currentMessage = mockReply;
    } else if (isStandFirm) {
      mockReply = await aiCall(
        `You are simulating a ${sentimentLabel} customer who has REJECTED the offer. Generate a brief rejection reply.`,
        `AI offered: "${aiResponse}"\nSentiment: ${sentimentLabel}\n\nGenerate a 1-2 sentence rejection. The customer doesn't want this offer.`,
        100,
      );
    }

    simSteps.push({
      step_name: step.name,
      step_type: step.type,
      step_order: step.step_order,
      data_found: dataFound,
      condition_result: conditionResult,
      ai_response: aiResponse,
      mock_customer_reply: mockReply,
      warnings,
      skipped,
    });
  }

  const resultPayload = {
    playbook_name: playbook.name,
    customer_name: customerName,
    customer_email: customer.email,
    sentiment: sentimentLabel,
    initial_message: message,
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

  return NextResponse.json({ ...resultPayload, ref: saved?.id || null });
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
