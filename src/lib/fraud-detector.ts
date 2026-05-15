import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { addOrderTags } from "@/lib/shopify-order-tags";
import { zipDistance, extractZip } from "@/lib/geo-distance";
import { normalizeReseller } from "@/lib/known-resellers";
import { HAIKU_MODEL } from "@/lib/ai-models";

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

interface AddressDistanceConfig {
  distance_threshold_miles: number;
}

interface NameMismatchConfig {
  ignore_last_name_match: boolean;
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
        case "address_distance":
        case "name_mismatch":
          // These are real-time only (triggered per-order), not batch
          continue;
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
          orders_held: true,
          first_detected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      // Tag all orders as suspicious
      for (const oid of orderIds) {
        if (oid) addOrderTags(workspaceId, oid, ["suspicious"]).catch(() => {});
      }

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
          orders_held: true,
          first_detected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      // Tag all orders as suspicious
      for (const o of orders) {
        if (o.shopify_order_id) addOrderTags(workspaceId, o.shopify_order_id, ["suspicious"]).catch(() => {});
      }

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

  // Load the order with address details
  const { data: order } = await admin
    .from("orders")
    .select("id, shopify_order_id, normalized_shipping_address, customer_id, subscription_id, billing_address, shipping_address, source_name, email, order_number, line_items, total_cents")
    .eq("id", orderId)
    .single();

  if (!order) return;

  // Fetch billing address + payment details from Shopify if not stored
  if (!order.billing_address && order.shopify_order_id) {
    try {
      const { getShopifyCredentials } = await import("@/lib/shopify-sync");
      const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
      const { shop, accessToken } = await getShopifyCredentials(workspaceId);
      const gid = order.shopify_order_id.includes("gid://") ? order.shopify_order_id : `gid://shopify/Order/${order.shopify_order_id}`;
      const query = `{ order(id: "${gid}") { billingAddress { firstName lastName address1 address2 city province provinceCode zip country countryCode } transactions(first: 1) { id gateway paymentDetails { ... on CardPaymentDetails { name number bin company expirationMonth expirationYear avsResultCode cvvResultCode } } } } }`;
      const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const data = await res.json();
        const billingAddr = data?.data?.order?.billingAddress;
        const txn = data?.data?.order?.transactions?.[0];
        const updates: Record<string, unknown> = {};
        if (billingAddr) {
          order.billing_address = billingAddr;
          updates.billing_address = billingAddr;
        }
        if (txn?.paymentDetails && Object.keys(txn.paymentDetails).length > 0) {
          updates.payment_details = { gateway: txn.gateway, ...txn.paymentDetails };
        }
        if (Object.keys(updates).length) {
          await admin.from("orders").update(updates).eq("id", orderId);
        }
      }
    } catch (e) {
      console.error("[fraud] Failed to fetch billing/payment details from Shopify:", e);
    }
  }

  // Load customer for name comparison
  const effectiveCustomerId = order.customer_id || customerId;
  let customer: { id: string; first_name: string | null; last_name: string | null } | null = null;
  if (effectiveCustomerId) {
    const { data: c } = await admin.from("customers").select("id, first_name, last_name")
      .eq("id", effectiveCustomerId).single();
    customer = c;
  }

  let flagged = false;

  for (const rule of rules) {
    try {
      if (rule.rule_type === "shared_address" && order.normalized_shipping_address) {
        await checkAddressForOrder(rule, workspaceId, order.normalized_shipping_address, suppressedAddresses);
      }
      if (rule.rule_type === "high_velocity" && effectiveCustomerId) {
        await checkVelocityForCustomer(rule, workspaceId, effectiveCustomerId);
      }
      if (rule.rule_type === "address_distance") {
        const result = await checkAddressDistance(rule, workspaceId, order, effectiveCustomerId);
        if (result) flagged = true;
      }
      if (rule.rule_type === "name_mismatch" && customer) {
        const result = await checkNameMismatch(rule, workspaceId, order, customer);
        if (result) flagged = true;
      }
      if (rule.rule_type === "amazon_reseller") {
        const result = await checkAmazonResellerMatch(rule, workspaceId, order, effectiveCustomerId);
        if (result) flagged = true;
      }
    } catch (err) {
      console.error(`Real-time fraud check error for rule ${rule.id}:`, err);
    }
  }

  // AI fraud screen — analyze web checkout orders for suspicious patterns
  if (!flagged && order.source_name === "web") {
    const { data: ws } = await admin.from("workspaces").select("fraud_ai_enabled").eq("id", workspaceId).single();
    if (ws?.fraud_ai_enabled) {
      try {
        const shipping = order.shipping_address as Record<string, string> | null;
        const billing = order.billing_address as Record<string, string> | null;
        const email = order.email || "";
        const custName = customer ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim() : "";
        const shippingName = shipping ? `${shipping.firstName || shipping.first_name || ""} ${shipping.lastName || shipping.last_name || ""}`.trim() : "";
        const billingName = billing ? `${billing.firstName || billing.first_name || ""} ${billing.lastName || billing.last_name || ""}`.trim() : "";

        const prompt = `Analyze this e-commerce order for fraud indicators. Return ONLY "FRAUD" or "OK".

Order: ${order.order_number}
Email: ${email}
Customer name: ${custName}
Shipping name: ${shippingName}
Shipping address: ${shipping ? `${shipping.address1 || ""} ${shipping.address2 || ""}, ${shipping.city || ""} ${shipping.provinceCode || shipping.province_code || ""} ${shipping.zip || ""}` : "unknown"}
Billing name: ${billingName}
Billing address: ${billing ? `${billing.address1 || ""} ${billing.address2 || ""}, ${billing.city || ""} ${billing.provinceCode || billing.province_code || ""} ${billing.zip || ""}` : "unknown"}
Amount: $${((order.total_cents || 0) / 100).toFixed(2)}

Look for:
- Gibberish/random names (e.g. "Wzavallone Jzchristian")
- Email name doesn't match order name
- Disposable/suspicious email domains
- Random characters in address fields (e.g. "bcv1524" in address2)
- Gmail+ aliases (e.g. user+abc123@gmail.com)
- Name/address combinations that look auto-generated

Respond with EXACTLY "FRAUD" or "OK".`;

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("No API key");
        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 10, messages: [{ role: "user", content: prompt }] }),
        });
        if (!aiRes.ok) throw new Error(`AI API error: ${aiRes.status}`);
        const aiData = await aiRes.json();
        const answer = ((aiData.content?.[0] as { text: string })?.text || "").trim().toUpperCase();

        if (answer.includes("FRAUD")) {
          flagged = true;
          // Create fraud case
          const orderNum = order.order_number || order.shopify_order_id;
          const { data: existing } = await admin.from("fraud_cases")
            .select("id").eq("workspace_id", workspaceId).contains("customer_ids", [effectiveCustomerId || ""]).eq("status", "open").limit(1);
          if (!existing?.length) {
            await admin.from("fraud_cases").insert({
              workspace_id: workspaceId,
              rule_type: "ai_screen",
              severity: "high",
              status: "open",
              title: `AI flagged suspicious order ${orderNum}`,
              summary: `AI detected fraud indicators: ${shippingName} (${email})`,
              evidence: { ai_decision: "FRAUD", email, shipping_name: shippingName, billing_name: billingName, order_number: orderNum },
              customer_ids: effectiveCustomerId ? [effectiveCustomerId] : [],
              order_ids: [order.id],
              first_detected_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
            });
          } else {
            // Update existing case with latest activity
            await admin.from("fraud_cases").update({ last_seen_at: new Date().toISOString() }).eq("id", existing[0].id);
          }
          // Slack notification
          const { dispatchSlackNotification } = await import("@/lib/slack-notify");
          dispatchSlackNotification(workspaceId, "fraud_case", {
            customer: { name: shippingName, email },
            severity: "high",
            reason: "AI flagged as suspicious",
            orderId: order.order_number || order.shopify_order_id,
          }).catch(() => {});
        }
      } catch (e) {
        console.error("[fraud] AI screen error:", e);
      }
    }
  }

  // ── Confirmed fraud similarity check ──
  // Compare this order against all confirmed_fraud cases for address/name/email overlap
  if (!flagged) {
    try {
      const { data: confirmedCases } = await admin
        .from("fraud_cases")
        .select("id, title, order_ids, customer_ids, evidence")
        .eq("workspace_id", workspaceId)
        .eq("status", "confirmed_fraud");

      if (confirmedCases?.length) {
        // Gather order IDs from confirmed cases
        const fraudOrderIds = confirmedCases.flatMap(c => c.order_ids || []);
        // Fetch fraud orders in batches of 100
        const fraudOrders: Array<{
          id: string; order_number: string; email: string | null;
          shipping_address: Record<string, string> | null;
          billing_address: Record<string, string> | null;
          normalized_shipping_address: string | null;
        }> = [];
        for (let i = 0; i < fraudOrderIds.length; i += 100) {
          const batch = fraudOrderIds.slice(i, i + 100);
          const { data: batchOrders } = await admin
            .from("orders")
            .select("id, order_number, email, shipping_address, billing_address, normalized_shipping_address")
            .in("id", batch);
          if (batchOrders) fraudOrders.push(...batchOrders);
        }

        if (fraudOrders.length) {
          const matches: Array<{ type: string; this_value: string; fraud_value: string; fraud_order: string; fraud_case_id: string }> = [];
          const shipping = order.shipping_address as Record<string, string> | null;
          const billing = order.billing_address as Record<string, string> | null;
          const email = (order.email || "").toLowerCase().trim();
          const emailBase = email.replace(/\+[^@]*@/, "@"); // strip gmail alias
          const shipFirst = (shipping?.firstName || shipping?.first_name || "").toLowerCase().trim();
          const shipLast = (shipping?.lastName || shipping?.last_name || "").toLowerCase().trim();
          const billFirst = (billing?.firstName || billing?.first_name || "").toLowerCase().trim();
          const billLast = (billing?.lastName || billing?.last_name || "").toLowerCase().trim();
          const shipAddr1 = (shipping?.address1 || "").toLowerCase().replace(/[.,#]/g, "").trim();
          const billAddr1 = (billing?.address1 || "").toLowerCase().replace(/[.,#]/g, "").trim();
          const shipZip = (shipping?.zip || "").trim();
          const billZip = (billing?.zip || "").trim();

          for (const fo of fraudOrders) {
            const fraudCase = confirmedCases.find(c => c.order_ids?.includes(fo.id));
            const caseId = fraudCase?.id || "";
            const foShip = fo.shipping_address as Record<string, string> | null;
            const foBill = fo.billing_address as Record<string, string> | null;
            const foEmail = (fo.email || "").toLowerCase().trim();
            const foEmailBase = foEmail.replace(/\+[^@]*@/, "@");
            const foShipFirst = (foShip?.firstName || foShip?.first_name || "").toLowerCase().trim();
            const foShipLast = (foShip?.lastName || foShip?.last_name || "").toLowerCase().trim();
            const foBillFirst = (foBill?.firstName || foBill?.first_name || "").toLowerCase().trim();
            const foBillLast = (foBill?.lastName || foBill?.last_name || "").toLowerCase().trim();
            const foShipAddr1 = (foShip?.address1 || "").toLowerCase().replace(/[.,#]/g, "").trim();
            const foBillAddr1 = (foBill?.address1 || "").toLowerCase().replace(/[.,#]/g, "").trim();
            const foShipZip = (foShip?.zip || "").trim();
            const foBillZip = (foBill?.zip || "").trim();

            // 1. Gmail alias match (same base email)
            if (emailBase && foEmailBase && emailBase === foEmailBase && email !== foEmail) {
              matches.push({ type: "gmail_alias", this_value: email, fraud_value: foEmail, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 2. Exact email match
            if (email && foEmail && email === foEmail) {
              matches.push({ type: "exact_email", this_value: email, fraud_value: foEmail, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 3. Shipping address match (same street + zip)
            if (shipAddr1 && shipZip && foShipAddr1 && foShipZip && shipAddr1 === foShipAddr1 && shipZip === foShipZip) {
              matches.push({ type: "shipping_address", this_value: `${shipAddr1}, ${shipZip}`, fraud_value: `${foShipAddr1}, ${foShipZip}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 4. Billing address match
            if (billAddr1 && billZip && foBillAddr1 && foBillZip && billAddr1 === foBillAddr1 && billZip === foBillZip) {
              matches.push({ type: "billing_address", this_value: `${billAddr1}, ${billZip}`, fraud_value: `${foBillAddr1}, ${foBillZip}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 5. Cross-match: this shipping = fraud billing or vice versa
            if (shipAddr1 && shipZip && foBillAddr1 && foBillZip && shipAddr1 === foBillAddr1 && shipZip === foBillZip) {
              matches.push({ type: "ship_to_fraud_billing", this_value: `${shipAddr1}, ${shipZip}`, fraud_value: `${foBillAddr1}, ${foBillZip}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }
            if (billAddr1 && billZip && foShipAddr1 && foShipZip && billAddr1 === foShipAddr1 && billZip === foShipZip) {
              matches.push({ type: "bill_to_fraud_shipping", this_value: `${billAddr1}, ${billZip}`, fraud_value: `${foShipAddr1}, ${foShipZip}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 6. Same last name + same address (different first name = likely same fraudster)
            if (shipLast && foShipLast && shipLast === foShipLast && shipAddr1 && foShipAddr1 && shipAddr1 === foShipAddr1) {
              matches.push({ type: "same_lastname_same_address", this_value: `${shipFirst} ${shipLast} @ ${shipAddr1}`, fraud_value: `${foShipFirst} ${foShipLast} @ ${foShipAddr1}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 7. Same first+last name (different middle or different address = repeat offender)
            if (shipFirst && shipLast && foShipFirst && foShipLast && shipFirst === foShipFirst && shipLast === foShipLast) {
              matches.push({ type: "same_name", this_value: `${shipFirst} ${shipLast}`, fraud_value: `${foShipFirst} ${foShipLast}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }
          }

          // Dedupe matches by type+fraud_order
          const seen = new Set<string>();
          const uniqueMatches = matches.filter(m => {
            const key = `${m.type}:${m.fraud_order}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          if (uniqueMatches.length > 0) {
            flagged = true;
            const orderNum = order.order_number || order.shopify_order_id;
            const matchSummary = uniqueMatches.map(m => `${m.type}: "${m.this_value}" matches fraud order ${m.fraud_order} ("${m.fraud_value}")`).join("; ");
            const linkedCaseIds = [...new Set(uniqueMatches.map(m => m.fraud_case_id).filter(Boolean))];

            // Check for existing open case for this customer
            const { data: existing } = await admin.from("fraud_cases")
              .select("id").eq("workspace_id", workspaceId)
              .contains("customer_ids", [effectiveCustomerId || ""])
              .eq("status", "open").limit(1);

            if (!existing?.length) {
              const shipping = order.shipping_address as Record<string, string> | null;
              const shippingName = shipping ? `${shipping.firstName || shipping.first_name || ""} ${shipping.lastName || shipping.last_name || ""}`.trim() : "";

              await admin.from("fraud_cases").insert({
                workspace_id: workspaceId,
                rule_type: "confirmed_fraud_match",
                severity: "high",
                status: "open",
                title: `Order ${orderNum} matches confirmed fraud`,
                summary: `Order linked to ${linkedCaseIds.length} confirmed fraud case(s): ${matchSummary}`,
                evidence: {
                  order_number: orderNum,
                  email: order.email,
                  shipping_name: shippingName,
                  matches: uniqueMatches,
                  linked_fraud_case_ids: linkedCaseIds,
                },
                customer_ids: effectiveCustomerId ? [effectiveCustomerId] : [],
                order_ids: [order.id],
                first_detected_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
              });

              // Fire case.created for AI summary + notifications
              await inngest.send({
                name: "fraud/case.created",
                data: { workspace_id: workspaceId },
              });
            }
          }
        }
      }
    } catch (e) {
      console.error("[fraud] Confirmed fraud similarity check error:", e);
    }
  }

  // Tag the Shopify order as "suspicious" if any rule flagged it
  if (flagged && order.shopify_order_id) {
    await addOrderTags(workspaceId, order.shopify_order_id, ["suspicious"]);
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

// ── Address Distance Detector (real-time only) ──

async function checkAddressDistance(
  rule: FraudRule,
  workspaceId: string,
  order: { id: string; shopify_order_id: string; billing_address: unknown; shipping_address: unknown; customer_id: string | null },
  customerId: string | null,
): Promise<boolean> {
  const config = rule.config as unknown as AddressDistanceConfig;
  const threshold = config.distance_threshold_miles || 100;

  const billing = order.billing_address as { zip?: string; first_name?: string; last_name?: string; city?: string; province?: string } | null;
  const shipping = order.shipping_address as { zip?: string; first_name?: string; last_name?: string; city?: string; province?: string } | null;

  const billingZip = extractZip(billing);
  const shippingZip = extractZip(shipping);

  if (!billingZip || !shippingZip) return false;
  if (billingZip === shippingZip) return false;

  const distance = zipDistance(billingZip, shippingZip);
  if (distance === null || distance < threshold) return false;

  // Distance exceeds threshold — create fraud case
  const admin = createAdminClient();

  const evidence = {
    billing_zip: billingZip,
    shipping_zip: shippingZip,
    billing_address: billing ? `${billing.city || ""}, ${billing.province || ""}`.trim() : billingZip,
    shipping_address: shipping ? `${shipping.city || ""}, ${shipping.province || ""}`.trim() : shippingZip,
    distance_miles: Math.round(distance),
    threshold_miles: threshold,
    order_id: order.shopify_order_id,
  };

  const title = `Billing/shipping ${Math.round(distance)} miles apart on order #${order.shopify_order_id}`;

  // Check for existing case for this order
  const { data: existing } = await admin
    .from("fraud_cases")
    .select("id")
    .eq("rule_id", rule.id)
    .eq("workspace_id", workspaceId)
    .not("status", "in", '("confirmed_fraud","dismissed")')
    .filter("evidence->>order_id", "eq", order.shopify_order_id)
    .limit(1)
    .maybeSingle();

  if (existing) return true; // Already flagged

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
      customer_ids: customerId ? [customerId] : [],
      order_ids: [order.shopify_order_id],
      orders_held: true,
      first_detected_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (newCase) {
    await inngest.send({
      name: "fraud/case.created",
      data: { caseId: newCase.id, workspaceId },
    });
  }

  return true;
}

// ── Name Mismatch Detector (real-time only) ──

async function checkNameMismatch(
  rule: FraudRule,
  workspaceId: string,
  order: { id: string; shopify_order_id: string; billing_address: unknown; customer_id: string | null },
  customer: { id: string; first_name: string | null; last_name: string | null },
): Promise<boolean> {
  const config = rule.config as unknown as NameMismatchConfig;

  const billing = order.billing_address as { first_name?: string; last_name?: string } | null;
  if (!billing?.first_name && !billing?.last_name) return false;
  if (!customer.first_name && !customer.last_name) return false;

  const billingFirst = (billing?.first_name || "").toLowerCase().trim();
  const billingLast = (billing?.last_name || "").toLowerCase().trim();
  const customerFirst = (customer.first_name || "").toLowerCase().trim();
  const customerLast = (customer.last_name || "").toLowerCase().trim();

  // If names match, no flag
  if (billingFirst === customerFirst && billingLast === customerLast) return false;

  // If last names match and config says to ignore, no flag (could be spouse/family)
  if (config.ignore_last_name_match && billingLast === customerLast && billingLast.length > 0) return false;

  // Names don't match — create fraud case
  const admin = createAdminClient();

  const billingName = `${billing?.first_name || ""} ${billing?.last_name || ""}`.trim();
  const customerName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim();

  const evidence = {
    billing_name: billingName,
    customer_name: customerName,
    billing_first: billing?.first_name || "",
    billing_last: billing?.last_name || "",
    customer_first: customer.first_name || "",
    customer_last: customer.last_name || "",
    last_names_match: billingLast === customerLast,
    order_id: order.shopify_order_id,
  };

  const title = `Billing name "${billingName}" ≠ customer "${customerName}" on order #${order.shopify_order_id}`;

  // Check for existing case for this order
  const { data: existing } = await admin
    .from("fraud_cases")
    .select("id")
    .eq("rule_id", rule.id)
    .eq("workspace_id", workspaceId)
    .not("status", "in", '("confirmed_fraud","dismissed")')
    .filter("evidence->>order_id", "eq", order.shopify_order_id)
    .limit(1)
    .maybeSingle();

  if (existing) return true;

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
      customer_ids: [customer.id],
      order_ids: [order.shopify_order_id],
      orders_held: true,
      first_detected_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (newCase) {
    await inngest.send({
      name: "fraud/case.created",
      data: { caseId: newCase.id, workspaceId },
    });
  }

  return true;
}

// ── Amazon Reseller Address Match ──
//
// Compares the order's shipping AND billing addresses to every active
// known_resellers row. Two-pass match:
//   1. Fast path: SQL-equality on the normalized form (handles
//      "10083 Lynden Oval, 44130" vs "10083 lynden ovl|44130" — same
//      after normalize).
//   2. Slow path: when zip matches and the street starts with the same
//      number, ask Haiku whether the addresses are the same physical
//      location (handles deliberate obfuscation like "010083 Lynden
//      Ova.l, Apt1").
//
// On match we create a fraud_case with rule_type='amazon_reseller'.
// That signal is what the Sonnet/Opus orchestrator reads to refuse all
// actions for the customer once the case status is 'confirmed_fraud'.

interface AddressLite {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
}

function pickAddressFromOrder(
  order: { shipping_address: unknown; billing_address: unknown }
): { ship: AddressLite | null; bill: AddressLite | null } {
  const ship = (order.shipping_address as AddressLite | null) || null;
  const bill = (order.billing_address as AddressLite | null) || null;
  return { ship, bill };
}

async function haikuAddressesMatch(a: AddressLite, b: AddressLite): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return false;
  const fmt = (x: AddressLite) =>
    [x.address1, x.address2, x.city, x.state || x.province, x.zip].filter(Boolean).join(", ");
  const prompt = `You are detecting whether two addresses point to the same physical mailbox. Resellers deliberately mangle their address to evade filters — your job is to see through the obfuscation.

Address A (incoming order): ${fmt(a)}
Address B (known reseller):  ${fmt(b)}

Reply EXACTLY one word: "MATCH" or "DIFFERENT".

These count as MATCH (same physical location):
- Different formatting: "St" vs "Street", "Ave" vs "Avenue", "Apt 1" vs "Unit 1"
- Extra leading zeros on the street number: "010083" vs "10083"
- Punctuation injected mid-word: "Ova.l" vs "Oval", "Roma.ine" vs "Romaine"
- Missing or extra street type: "7704 Romaine" vs "7704 Romaine St"
- Random trailing tokens: "7040 N Olin Ave ave44" vs "7040 N Olin Ave"
- Different unit/apt numbers within the same building (still same building)
- Capitalization, extra spaces, comma vs no-comma

These count as DIFFERENT:
- Different street number (after removing leading zeros)
- Different zip code
- Different street name (when not just a typo/obfuscation of the same name)`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 5,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return false;
    const j = await res.json();
    const ans = ((j.content?.[0] as { text: string })?.text || "").trim().toUpperCase();
    return ans.startsWith("MATCH");
  } catch {
    return false;
  }
}

async function checkAmazonResellerMatch(
  rule: FraudRule,
  workspaceId: string,
  order: { id: string; shopify_order_id: string; shipping_address: unknown; billing_address: unknown; order_number?: string | null; email?: string | null },
  customerId: string | null,
): Promise<boolean> {
  const admin = createAdminClient();

  const { data: resellers } = await admin
    .from("known_resellers")
    .select("id, business_name, address1, address2, city, state, zip, normalized_address, amazon_seller_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  if (!resellers?.length) return false;

  const { ship, bill } = pickAddressFromOrder(order);
  type Hit = { reseller: typeof resellers[number]; matchedOn: "shipping" | "billing"; method: "exact" | "haiku" };
  const hits: Hit[] = [];

  for (const addr of [
    ship ? { side: "shipping" as const, addr: ship } : null,
    bill ? { side: "billing" as const, addr: bill } : null,
  ].filter((x): x is { side: "shipping" | "billing"; addr: AddressLite } => !!x)) {
    const orderNorm = normalizeReseller({ address1: addr.addr.address1, zip: addr.addr.zip });
    for (const r of resellers) {
      // Fast path
      if (r.normalized_address && r.normalized_address === orderNorm) {
        hits.push({ reseller: r, matchedOn: addr.side, method: "exact" });
        continue;
      }
      // Slow path: same zip + plausibly similar street → ask Haiku
      const orderZip = (addr.addr.zip || "").slice(0, 5);
      const resellerZip = (r.zip || "").slice(0, 5);
      if (!orderZip || orderZip !== resellerZip) continue;
      const orderNum = (addr.addr.address1 || "").match(/\d+/)?.[0] || "";
      const resellerNum = (r.address1 || "").match(/\d+/)?.[0] || "";
      if (!orderNum || orderNum.replace(/^0+/, "") !== resellerNum.replace(/^0+/, "")) continue;
      // Worth asking Haiku — same zip + same street number
      const matched = await haikuAddressesMatch(addr.addr, {
        address1: r.address1, address2: r.address2, city: r.city, state: r.state, zip: r.zip,
      });
      if (matched) hits.push({ reseller: r, matchedOn: addr.side, method: "haiku" });
    }
  }

  if (!hits.length) return false;

  // Dedupe (same reseller may match on both ship + bill)
  const uniqueResellers = new Map<string, Hit>();
  for (const h of hits) if (!uniqueResellers.has(h.reseller.id)) uniqueResellers.set(h.reseller.id, h);
  const primary = [...uniqueResellers.values()][0];

  // Avoid duplicate cases for the same order + reseller
  const { data: existing } = await admin
    .from("fraud_cases")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("rule_type", "amazon_reseller")
    .filter("evidence->>order_id", "eq", order.shopify_order_id)
    .limit(1)
    .maybeSingle();
  if (existing) return true;

  const evidence = {
    order_id: order.shopify_order_id,
    order_number: order.order_number || null,
    matched_resellers: [...uniqueResellers.values()].map(h => ({
      reseller_id: h.reseller.id,
      business_name: h.reseller.business_name,
      amazon_seller_id: h.reseller.amazon_seller_id,
      matched_on: h.matchedOn,
      method: h.method,
    })),
    shipping_address: ship,
    billing_address: bill,
    email: order.email || null,
  };

  const title = `Amazon reseller address match: ${primary.reseller.business_name || primary.reseller.amazon_seller_id} on order ${order.order_number || order.shopify_order_id}`;

  const { data: newCase } = await admin
    .from("fraud_cases")
    .insert({
      workspace_id: workspaceId,
      rule_id: rule.id,
      rule_type: "amazon_reseller",
      status: "open",
      severity: rule.severity || "high",
      title,
      evidence,
      customer_ids: customerId ? [customerId] : [],
      order_ids: [order.shopify_order_id],
      orders_held: true,
      first_detected_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (newCase) {
    await admin.from("fraud_action_log").insert({
      workspace_id: workspaceId,
      fraud_case_id: newCase.id,
      customer_id: customerId,
      reseller_id: primary.reseller.id,
      action: "address_match_flagged",
      metadata: { order_number: order.order_number, matched_on: primary.matchedOn, method: primary.method },
    });
    await inngest.send({
      name: "fraud/case.created",
      data: { caseId: newCase.id, workspaceId },
    });
  }

  return true;
}
