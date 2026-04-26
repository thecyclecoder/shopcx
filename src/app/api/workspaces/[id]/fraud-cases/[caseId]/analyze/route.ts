import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST: Run (or re-run) AI analysis on a fraud case.
 * Stores result in fraud_cases.ai_analysis JSONB column.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Load the case
  const { data: fraudCase } = await admin
    .from("fraud_cases")
    .select("id, evidence, rule_type, severity, title, customer_ids, order_ids")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!fraudCase) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Load extra context for better analysis
  const customerIds = (fraudCase.customer_ids || []) as string[];
  let customerContext = "";
  if (customerIds.length) {
    const { data: customers } = await admin.from("customers")
      .select("id, email, first_name, last_name, subscription_status, created_at")
      .in("id", customerIds);
    if (customers?.length) {
      const { getCustomerStats } = await import("@/lib/customer-stats");
      const lines = await Promise.all(customers.map(async c => {
        const s = await getCustomerStats(c.id);
        return `- ${c.first_name || ""} ${c.last_name || ""} (${c.email}): ${s.total_orders} orders, LTV $${(s.ltv_cents / 100).toFixed(2)}, sub: ${c.subscription_status || "none"}, created: ${c.created_at}`;
      }));
      customerContext = `\nCustomers:\n${lines.join("\n")}`;
    }
  }

  const orderIds = (fraudCase.order_ids || []) as string[];
  let orderContext = "";
  if (orderIds.length) {
    const { data: orders } = await admin.from("orders")
      .select("order_number, total_cents, line_items, billing_address, shipping_address, payment_details, created_at")
      .eq("workspace_id", workspaceId)
      .in("shopify_order_id", orderIds);
    if (orders?.length) {
      orderContext = `\nOrders:\n${orders.map(o =>
        `- #${o.order_number}: $${((o.total_cents || 0) / 100).toFixed(2)}, ${(o.line_items as unknown[])?.length || 0} items, billing: ${JSON.stringify(o.billing_address)?.slice(0, 100)}, shipping: ${JSON.stringify(o.shipping_address)?.slice(0, 100)}, payment: ${JSON.stringify(o.payment_details)?.slice(0, 80)}, date: ${o.created_at}`
      ).join("\n")}`;
    }
  }

  // Generate analysis
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 500 });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are a fraud analyst. Analyze this fraud case and provide:
1. A risk assessment (high/medium/low) with reasoning
2. Key suspicious indicators
3. Recommended actions

Be specific and factual. Do not use legal language.

Rule type: ${fraudCase.rule_type}
Severity: ${fraudCase.severity}
Evidence: ${JSON.stringify(fraudCase.evidence)}${customerContext}${orderContext}

Return JSON: { "risk_level": "high|medium|low", "summary": "2-3 sentence summary", "indicators": ["indicator 1", "indicator 2", ...], "recommended_actions": ["action 1", "action 2", ...] }`,
      }],
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "AI analysis failed" }, { status: 502 });
  }

  const result = await response.json();
  const raw = (result.content?.[0]?.text as string) || "";

  let analysis;
  try {
    analysis = JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
  } catch {
    analysis = { risk_level: "unknown", summary: raw, indicators: [], recommended_actions: [] };
  }

  analysis.analyzed_at = new Date().toISOString();

  // Store in ai_analysis column
  await admin.from("fraud_cases")
    .update({ ai_analysis: analysis })
    .eq("id", caseId);

  return NextResponse.json({ ok: true, ai_analysis: analysis });
}
