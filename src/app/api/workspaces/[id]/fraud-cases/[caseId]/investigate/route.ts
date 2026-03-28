import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Deep investigation of a fraud case — surfaces all related data
export async function GET(
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

  // Load the fraud case
  const { data: fraudCase } = await admin
    .from("fraud_cases")
    .select("id, customer_ids, evidence, rule_type")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!fraudCase) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get all customer IDs from the case
  const caseCustomerIds: string[] = fraudCase.customer_ids || [];

  // Also extract customer IDs from evidence
  const evidence = fraudCase.evidence as Record<string, unknown>;
  if (evidence?.customer_id && !caseCustomerIds.includes(evidence.customer_id as string)) {
    caseCustomerIds.push(evidence.customer_id as string);
  }
  if (Array.isArray(evidence?.customers)) {
    for (const c of evidence.customers as { customer_id?: string }[]) {
      if (c.customer_id && !caseCustomerIds.includes(c.customer_id)) {
        caseCustomerIds.push(c.customer_id);
      }
    }
  }

  // Expand to include all linked accounts
  const allCustomerIds = new Set(caseCustomerIds);
  if (caseCustomerIds.length > 0) {
    const { data: links } = await admin
      .from("customer_links")
      .select("customer_id, group_id")
      .in("customer_id", caseCustomerIds);

    if (links && links.length > 0) {
      const groupIds = [...new Set(links.map(l => l.group_id))];
      const { data: groupMembers } = await admin
        .from("customer_links")
        .select("customer_id")
        .in("group_id", groupIds);
      for (const m of groupMembers || []) {
        allCustomerIds.add(m.customer_id);
      }
    }
  }

  const customerIdArray = [...allCustomerIds];

  // Load all customer profiles
  const { data: customers } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, phone, retention_score, subscription_status, total_orders, ltv_cents, default_address, shopify_customer_id")
    .eq("workspace_id", workspaceId)
    .in("id", customerIdArray.length > 0 ? customerIdArray : ["__none__"]);

  // Determine which customers are linked vs just in the case
  const linkedIds = new Set(customerIdArray.filter(id => !caseCustomerIds.includes(id)));

  // Load fraud rules + check which rules each customer triggers
  const { data: rules } = await admin
    .from("fraud_rules")
    .select("id, name, rule_type, config, severity, is_active")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  const triggeredRules: { rule_name: string; rule_type: string; severity: string; details: string }[] = [];

  for (const rule of rules || []) {
    const config = rule.config as Record<string, number | boolean>;

    if (rule.rule_type === "shared_address") {
      // Check if any customers share addresses with different names
      const addresses = new Map<string, { name: string; email: string; id: string }[]>();
      for (const c of customers || []) {
        const addr = c.default_address as { address1?: string; city?: string; zip?: string } | null;
        if (!addr?.address1) continue;
        const key = `${addr.address1} ${addr.city || ""} ${addr.zip || ""}`.toLowerCase().trim();
        const arr = addresses.get(key) || [];
        arr.push({ name: `${c.first_name || ""} ${c.last_name || ""}`.trim(), email: c.email, id: c.id });
        addresses.set(key, arr);
      }

      for (const [addr, custs] of addresses) {
        const uniqueNames = new Set(custs.map(c => c.name.toLowerCase()));
        const minCust = (config.min_customers as number) || 3;
        if (custs.length >= minCust && uniqueNames.size > 1) {
          triggeredRules.push({
            rule_name: rule.name,
            rule_type: rule.rule_type,
            severity: rule.severity,
            details: `${custs.length} customers with different names at "${addr.slice(0, 50)}"`,
          });
        }
      }
    }

    if (rule.rule_type === "high_velocity") {
      const windowDays = (config.window_days as number) || 60;
      const minOrders = (config.min_qualifying_orders as number) || 3;
      const minQty = (config.min_quantity_per_order as number) || 4;
      const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString();

      for (const c of customers || []) {
        const { data: orders } = await admin
          .from("orders")
          .select("id, line_items, created_at, total_price_cents")
          .eq("workspace_id", workspaceId)
          .eq("customer_id", c.id)
          .gte("created_at", windowStart)
          .order("created_at", { ascending: false });

        const qualifying = (orders || []).filter(o => {
          const items = o.line_items as { quantity?: number }[] | null;
          const totalQty = (items || []).reduce((s, i) => s + (i.quantity || 1), 0);
          return totalQty >= minQty;
        });

        if (qualifying.length >= minOrders) {
          triggeredRules.push({
            rule_name: rule.name,
            rule_type: rule.rule_type,
            severity: rule.severity,
            details: `${c.email}: ${qualifying.length} orders with ${minQty}+ items in ${windowDays} days`,
          });
        }
      }
    }
  }

  // Load orders for all customers
  const { data: orders } = await admin
    .from("orders")
    .select("id, shopify_order_id, order_number, customer_id, total_price_cents, line_items, fulfillments, created_at, source_name")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIdArray.length > 0 ? customerIdArray : ["__none__"])
    .order("created_at", { ascending: false })
    .limit(50);

  // Load active subscriptions for all customers
  const { data: subscriptions } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, customer_id, status, items, next_billing_date, billing_interval")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIdArray.length > 0 ? customerIdArray : ["__none__"])
    .in("status", ["active", "paused"]);

  // Load link suggestions for the primary customer
  const primaryCustomerId = caseCustomerIds[0];
  let linkSuggestions: { id: string; email: string; first_name: string | null; last_name: string | null; match_reason: string }[] = [];

  if (primaryCustomerId) {
    const primaryCust = (customers || []).find(c => c.id === primaryCustomerId);
    if (primaryCust) {
      // Name match
      if (primaryCust.first_name && primaryCust.last_name) {
        const { data: nameMatches } = await admin
          .from("customers")
          .select("id, email, first_name, last_name")
          .eq("workspace_id", workspaceId)
          .ilike("first_name", primaryCust.first_name)
          .ilike("last_name", primaryCust.last_name)
          .not("id", "in", `(${customerIdArray.join(",")})`)
          .limit(5);
        for (const m of nameMatches || []) {
          linkSuggestions.push({ ...m, match_reason: "Same name" });
        }
      }
      // Phone match
      if (primaryCust.phone) {
        const { data: phoneMatches } = await admin
          .from("customers")
          .select("id, email, first_name, last_name")
          .eq("workspace_id", workspaceId)
          .eq("phone", primaryCust.phone)
          .not("id", "in", `(${customerIdArray.join(",")})`)
          .limit(5);
        for (const m of phoneMatches || []) {
          if (!linkSuggestions.some(s => s.id === m.id)) {
            linkSuggestions.push({ ...m, match_reason: "Same phone" });
          }
        }
      }
    }
  }

  // Load chargebacks for these customers
  const { data: chargebacks } = await admin
    .from("chargeback_events")
    .select("id, shopify_dispute_id, shopify_order_id, customer_id, reason, amount_cents, currency, status, initiated_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIdArray.length > 0 ? customerIdArray : ["__none__"])
    .order("initiated_at", { ascending: false });

  return NextResponse.json({
    customers: (customers || []).map(c => ({
      ...c,
      is_case_customer: caseCustomerIds.includes(c.id),
      is_linked: linkedIds.has(c.id),
    })),
    triggered_rules: triggeredRules,
    orders: orders || [],
    subscriptions: subscriptions || [],
    chargebacks: chargebacks || [],
    link_suggestions: linkSuggestions,
  });
}
