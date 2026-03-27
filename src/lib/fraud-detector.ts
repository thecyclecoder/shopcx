import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// ── Types ──

interface FraudRule {
  id: string;
  workspace_id: string;
  rule_type: string;
  name: string;
  is_active: boolean;
  config: Record<string, unknown>;
  severity: string;
  created_at: string;
}

interface FraudDetectionResult {
  rule_id: string;
  rule_type: string;
  new_cases: number;
  updated_cases: number;
}

interface SharedAddressConfig {
  min_customers: number;
  min_orders_total: number;
  ignore_same_last_name: boolean;
  lookback_days: number;
}

interface HighVelocityConfig {
  min_quantity_per_order: number;
  min_qualifying_orders: number;
  window_days: number;
  lookback_days: number;
}

// ── Coordinator ──

export async function runAllFraudRules(workspaceId: string): Promise<FraudDetectionResult[]> {
  const admin = createAdminClient();
  const { data: rules } = await admin
    .from("fraud_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  if (!rules?.length) return [];

  // Load suppressed addresses
  const { data: workspace } = await admin
    .from("workspaces")
    .select("fraud_suppressed_addresses")
    .eq("id", workspaceId)
    .single();
  const suppressedAddresses = new Set<string>((workspace?.fraud_suppressed_addresses || []) as string[]);

  // Only analyze orders created after the fraud rules were enabled.
  // This prevents a flood of historical cases on first run.
  // Real-time triggers handle new orders as they arrive.

  const results: FraudDetectionResult[] = [];

  for (const rule of rules) {
    try {
      let result: FraudDetectionResult;
      switch (rule.rule_type) {
        case "shared_address":
          result = await detectSharedAddress(rule, workspaceId, suppressedAddresses);
          break;
        case "high_velocity":
          result = await detectHighVelocity(rule, workspaceId);
          break;
        default:
          continue;
      }
      results.push(result);
    } catch (err) {
      console.error(`Fraud detection error for rule ${rule.id} (${rule.rule_type}):`, err);
    }
  }

  return results;
}

// ── Shared Address Detector ──

async function detectSharedAddress(
  rule: FraudRule,
  workspaceId: string,
  suppressedAddresses: Set<string>
): Promise<FraudDetectionResult> {
  const admin = createAdminClient();
  const config = rule.config as unknown as SharedAddressConfig;
  let newCases = 0;
  let updatedCases = 0;

  // Query address groups that meet thresholds
  // Use the later of: lookback_days ago, or rule created_at (so we don't flag historical orders)
  const lookbackCutoff = new Date();
  lookbackCutoff.setDate(lookbackCutoff.getDate() - (config.lookback_days || 365));
  const ruleCreatedAt = new Date(rule.created_at);
  const cutoff = lookbackCutoff > ruleCreatedAt ? lookbackCutoff : ruleCreatedAt;

  const { data: addressGroups } = await admin.rpc("fraud_detect_shared_addresses", {
    p_workspace_id: workspaceId,
    p_min_customers: config.min_customers || 3,
    p_min_orders: config.min_orders_total || 5,
    p_cutoff: cutoff.toISOString(),
  });

  if (!addressGroups?.length) return { rule_id: rule.id, rule_type: rule.rule_type, new_cases: 0, updated_cases: 0 };

  for (const group of addressGroups) {
    const normalizedAddress = group.normalized_shipping_address as string;

    // Skip suppressed addresses
    if (suppressedAddresses.has(normalizedAddress)) continue;

    const customerIds = group.customer_ids as string[];
    const lastNames = (group.last_names as string[]).filter(Boolean);

    // Determine name variance
    const uniqueLastNames = [...new Set(lastNames.map((n: string) => n.toLowerCase()))];
    let nameVariance: string;
    if (uniqueLastNames.length <= 1 && uniqueLastNames.length > 0) {
      // Check if all names are truly identical (same first + last) or just same last name
      const uniqueFullNames = [...new Set((group.full_names as string[]).map((n: string) => n.toLowerCase()))];
      nameVariance = uniqueFullNames.length <= 1 ? "identical" : "same_last_name";
    } else if (uniqueLastNames.length === customerIds.length) {
      nameVariance = "all_different";
    } else {
      nameVariance = "mixed";
    }

    // Skip if identical (same person)
    if (nameVariance === "identical") continue;

    // Skip if same last name and config says to ignore
    if (nameVariance === "same_last_name" && config.ignore_same_last_name) continue;

    // Build evidence with customer details
    const { data: customerDetails } = await admin
      .from("customers")
      .select("id, first_name, last_name, email")
      .in("id", customerIds);

    const { data: orderDetails } = await admin
      .from("orders")
      .select("id, shopify_order_id, customer_id, total_cents, created_at, order_number")
      .eq("workspace_id", workspaceId)
      .eq("normalized_shipping_address", normalizedAddress)
      .gte("created_at", cutoff.toISOString())
      .order("created_at", { ascending: false });

    const customerMap = new Map(customerDetails?.map((c) => [c.id, c]) || []);
    const ordersByCustomer = new Map<string, typeof orderDetails>();
    for (const order of orderDetails || []) {
      if (!order.customer_id) continue;
      if (!ordersByCustomer.has(order.customer_id)) ordersByCustomer.set(order.customer_id, []);
      ordersByCustomer.get(order.customer_id)!.push(order);
    }

    const totalOrderValue = (orderDetails || []).reduce((sum, o) => sum + (o.total_cents || 0), 0);

    const evidence = {
      address: normalizedAddress,
      customer_count: customerIds.length,
      total_order_count: orderDetails?.length || 0,
      total_order_value_cents: totalOrderValue,
      customers: customerIds.map((cid) => {
        const c = customerMap.get(cid);
        const orders = ordersByCustomer.get(cid) || [];
        return {
          customer_id: cid,
          name: c ? `${c.first_name || ""} ${c.last_name || ""}`.trim() : "Unknown",
          email: c?.email || "",
          order_count: orders.length,
          first_order_date: orders.length ? orders[orders.length - 1].created_at : null,
          last_order_date: orders.length ? orders[0].created_at : null,
        };
      }),
      name_variance: nameVariance,
    };

    // Determine severity based on name variance
    let severity = rule.severity;
    if (nameVariance === "all_different" && (orderDetails?.length || 0) > 5) severity = "high";
    else if (nameVariance === "same_last_name") severity = "low";
    else if (nameVariance === "mixed") severity = "medium";

    const title = `${customerIds.length} customer accounts share ${(group.display_address as string) || normalizedAddress}`;

    // Check for existing case
    const { data: existing } = await admin
      .from("fraud_cases")
      .select("id, evidence")
      .eq("rule_id", rule.id)
      .eq("workspace_id", workspaceId)
      .not("status", "in", '("confirmed_fraud","dismissed")')
      .filter("evidence->>address", "eq", normalizedAddress)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await admin
        .from("fraud_cases")
        .update({
          evidence,
          severity,
          title,
          customer_ids: customerIds,
          order_ids: (orderDetails || []).map((o) => o.shopify_order_id),
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      updatedCases++;
    } else {
      const orderIds = (orderDetails || []).map((o) => o.shopify_order_id);
      const { data: newCase } = await admin
        .from("fraud_cases")
        .insert({
          workspace_id: workspaceId,
          rule_id: rule.id,
          rule_type: rule.rule_type,
          status: "open",
          severity,
          title,
          evidence,
          customer_ids: customerIds,
          order_ids: orderIds,
          first_detected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (newCase) {
        // Insert match rows
        const matchRows = [
          ...customerIds.map((cid) => ({
            case_id: newCase.id,
            workspace_id: workspaceId,
            match_type: "customer_at_address",
            match_value: normalizedAddress,
            customer_id: cid,
          })),
          ...(orderDetails || []).map((o) => ({
            case_id: newCase.id,
            workspace_id: workspaceId,
            match_type: "order_at_address",
            match_value: normalizedAddress,
            customer_id: o.customer_id,
            order_id: o.shopify_order_id,
            order_amount_cents: o.total_cents,
            order_date: o.created_at,
          })),
        ];
        if (matchRows.length) {
          await admin.from("fraud_rule_matches").insert(matchRows);
        }

        // Fire Inngest event for AI summary
        await inngest.send({
          name: "fraud/case.created",
          data: { caseId: newCase.id, workspaceId },
        });

        newCases++;
      }
    }
  }

  return { rule_id: rule.id, rule_type: rule.rule_type, new_cases: newCases, updated_cases: updatedCases };
}

// ── High Velocity Detector ──

async function detectHighVelocity(
  rule: FraudRule,
  workspaceId: string
): Promise<FraudDetectionResult> {
  const admin = createAdminClient();
  const config = rule.config as unknown as HighVelocityConfig;
  let newCases = 0;
  let updatedCases = 0;

  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - (config.lookback_days || 365));
  // Use the later of: lookback_days ago, or rule created_at
  const ruleCreatedAt = new Date(rule.created_at);
  const lookbackCutoff = lookbackDate > ruleCreatedAt ? lookbackDate : ruleCreatedAt;

  const windowCutoff = new Date();
  windowCutoff.setDate(windowCutoff.getDate() - (config.window_days || 60));

  // Find customers with high-quantity orders
  const { data: velocityHits } = await admin.rpc("fraud_detect_high_velocity", {
    p_workspace_id: workspaceId,
    p_min_quantity: config.min_quantity_per_order || 4,
    p_min_orders: config.min_qualifying_orders || 3,
    p_window_cutoff: windowCutoff.toISOString(),
    p_lookback_cutoff: lookbackCutoff.toISOString(),
  });

  if (!velocityHits?.length) return { rule_id: rule.id, rule_type: rule.rule_type, new_cases: 0, updated_cases: 0 };

  for (const hit of velocityHits) {
    const customerId = hit.customer_id as string;
    const orderIds = hit.order_ids as string[];

    // Load full order details
    const { data: orders } = await admin
      .from("orders")
      .select("id, shopify_order_id, total_cents, line_items, created_at, subscription_id, tags")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("id", orderIds)
      .order("created_at", { ascending: true });

    if (!orders?.length) continue;

    // Suppress if all orders are subscription renewals
    const allSubscription = orders.every((o) => !!o.subscription_id);
    if (allSubscription) continue;

    // Load customer
    const { data: customer } = await admin
      .from("customers")
      .select("id, first_name, last_name, email, subscription_status, retention_score")
      .eq("id", customerId)
      .single();

    if (!customer) continue;

    const qualifyingOrders = orders.map((o) => ({
      order_id: o.shopify_order_id,
      order_date: o.created_at,
      items: ((o.line_items as { title: string; quantity: number; price_cents: number }[]) || []).map((li) => ({
        product_title: li.title,
        quantity: li.quantity,
        unit_price_cents: li.price_cents,
      })),
      order_total_cents: o.total_cents || 0,
    }));

    const totalUnits = qualifyingOrders.reduce(
      (sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0),
      0
    );
    const totalSpend = qualifyingOrders.reduce((sum, o) => sum + o.order_total_cents, 0);

    const evidence = {
      customer_id: customerId,
      customer_name: `${customer.first_name || ""} ${customer.last_name || ""}`.trim(),
      customer_email: customer.email,
      window_start: orders[0].created_at,
      window_end: orders[orders.length - 1].created_at,
      qualifying_orders: qualifyingOrders,
      total_units_in_window: totalUnits,
      total_spend_in_window_cents: totalSpend,
    };

    const title = `${customer.first_name || customer.email} placed ${orders.length} high-quantity orders in ${config.window_days} days`;

    // Check for existing case
    const { data: existing } = await admin
      .from("fraud_cases")
      .select("id")
      .eq("rule_id", rule.id)
      .eq("workspace_id", workspaceId)
      .not("status", "in", '("confirmed_fraud","dismissed")')
      .filter("evidence->>customer_id", "eq", customerId)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await admin
        .from("fraud_cases")
        .update({
          evidence,
          title,
          order_ids: orders.map((o) => o.shopify_order_id),
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      updatedCases++;
    } else {
      const { data: newCase } = await admin
        .from("fraud_cases")
        .insert({
          workspace_id: workspaceId,
          rule_id: rule.id,
          rule_type: rule.rule_type,
          status: "open",
          severity: rule.severity,
          title,
          evidence,
          customer_ids: [customerId],
          order_ids: orders.map((o) => o.shopify_order_id),
          first_detected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (newCase) {
        const matchRows = orders.map((o) => ({
          case_id: newCase.id,
          workspace_id: workspaceId,
          match_type: "high_velocity_order",
          match_value: customerId,
          customer_id: customerId,
          order_id: o.shopify_order_id,
          order_amount_cents: o.total_cents,
          order_date: o.created_at,
        }));
        if (matchRows.length) {
          await admin.from("fraud_rule_matches").insert(matchRows);
        }

        await inngest.send({
          name: "fraud/case.created",
          data: { caseId: newCase.id, workspaceId },
        });

        newCases++;
      }
    }
  }

  return { rule_id: rule.id, rule_type: rule.rule_type, new_cases: newCases, updated_cases: updatedCases };
}

// ── Targeted checks for real-time triggers ──

export async function checkOrderForFraud(
  workspaceId: string,
  orderId: string,
  customerId: string | null
): Promise<void> {
  const admin = createAdminClient();
  const { data: rules } = await admin
    .from("fraud_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  if (!rules?.length) return;

  const { data: workspace } = await admin
    .from("workspaces")
    .select("fraud_suppressed_addresses")
    .eq("id", workspaceId)
    .single();
  const suppressedAddresses = new Set<string>((workspace?.fraud_suppressed_addresses || []) as string[]);

  // Load the order
  const { data: order } = await admin
    .from("orders")
    .select("id, normalized_shipping_address, customer_id, subscription_id")
    .eq("id", orderId)
    .single();

  if (!order) return;

  for (const rule of rules) {
    try {
      if (rule.rule_type === "shared_address" && order.normalized_shipping_address) {
        await checkAddressForOrder(rule, workspaceId, order.normalized_shipping_address, suppressedAddresses);
      }
      if (rule.rule_type === "high_velocity" && (order.customer_id || customerId)) {
        await checkVelocityForCustomer(rule, workspaceId, order.customer_id || customerId!);
      }
    } catch (err) {
      console.error(`Real-time fraud check error for rule ${rule.id}:`, err);
    }
  }
}

async function checkAddressForOrder(
  rule: FraudRule,
  workspaceId: string,
  normalizedAddress: string,
  suppressedAddresses: Set<string>
): Promise<void> {
  if (suppressedAddresses.has(normalizedAddress)) return;

  const admin = createAdminClient();
  const config = rule.config as unknown as SharedAddressConfig;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (config.lookback_days || 365));

  // Count distinct customers at this address
  const { data: addressOrders } = await admin
    .from("orders")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .eq("normalized_shipping_address", normalizedAddress)
    .gte("created_at", cutoff.toISOString());

  if (!addressOrders?.length) return;

  const uniqueCustomers = [...new Set(addressOrders.map((o) => o.customer_id).filter(Boolean))];
  if (uniqueCustomers.length < (config.min_customers || 3)) return;
  if (addressOrders.length < (config.min_orders_total || 5)) return;

  // Threshold met — run full detection for this rule
  await detectSharedAddress(rule, workspaceId, suppressedAddresses);
}

async function checkVelocityForCustomer(
  rule: FraudRule,
  workspaceId: string,
  customerId: string
): Promise<void> {
  const admin = createAdminClient();
  const config = rule.config as unknown as HighVelocityConfig;

  const windowCutoff = new Date();
  windowCutoff.setDate(windowCutoff.getDate() - (config.window_days || 60));

  // Count qualifying orders for this customer in the window
  const { data: recentOrders } = await admin
    .from("orders")
    .select("id, line_items, subscription_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .gte("created_at", windowCutoff.toISOString());

  if (!recentOrders?.length) return;

  const qualifying = recentOrders.filter((o) => {
    if (o.subscription_id) return false; // Skip subscription renewals
    const items = (o.line_items as { quantity: number }[]) || [];
    const totalQty = items.reduce((sum, li) => sum + (li.quantity || 0), 0);
    return totalQty >= (config.min_quantity_per_order || 4);
  });

  if (qualifying.length < (config.min_qualifying_orders || 3)) return;

  // Threshold met — run full detection for this rule
  await detectHighVelocity(rule, workspaceId);
}

export async function checkCustomerForFraud(
  workspaceId: string,
  customerId: string
): Promise<void> {
  const admin = createAdminClient();

  // Get customer's address from their orders
  const { data: orders } = await admin
    .from("orders")
    .select("normalized_shipping_address")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .not("normalized_shipping_address", "is", null)
    .limit(1);

  if (!orders?.length) return;

  const { data: rules } = await admin
    .from("fraud_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .eq("rule_type", "shared_address");

  if (!rules?.length) return;

  const { data: workspace } = await admin
    .from("workspaces")
    .select("fraud_suppressed_addresses")
    .eq("id", workspaceId)
    .single();
  const suppressedAddresses = new Set<string>((workspace?.fraud_suppressed_addresses || []) as string[]);

  for (const rule of rules) {
    await checkAddressForOrder(rule, workspaceId, orders[0].normalized_shipping_address!, suppressedAddresses);
  }
}
