import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import { addOrderTags } from "@/lib/shopify-order-tags";
import { zipDistance, extractZip } from "@/lib/geo-distance";
import { normalizeReseller } from "@/lib/known-resellers";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { emitInlineAgentHeartbeat } from "@/lib/control-tower/heartbeat";
import { INLINE_AGENT_IDS } from "@/lib/control-tower/registry";
import freemailDomains from "@/lib/freemail-domains.json";

// Public / shared email providers — freemail, ISP, and disposable domains that
// *unrelated strangers legitimately share*. Used as an EXCLUSION set: a domain
// here is NOT treated as a ring signal. A *custom* domain (anything not here)
// reused against a confirmed-fraud order, or spun up across many fresh accounts,
// is the real signal — rings register fresh local parts on a throwaway domain
// they control (e.g. @safelywater.com) to beat exact-email matching.
//
// Sourced from the `free-email-domains` list (~12.3k domains, includes legacy
// providers like netscape.net that a hand-seeded set missed and that caused a
// false-positive ring on 4 unrelated @netscape.net customers — see
// docs/brain/lifecycles/fraud-detection.md). Vendored as JSON (no runtime dep);
// refresh by re-downloading domains.json and re-running the build step. The small
// inline supplement covers anything the upstream list lacks.
const FREEMAIL_DOMAINS = new Set<string>([
  ...(freemailDomains as string[]),
  // Supplement — keep additions the upstream list may miss:
  "netscape.com",
]);

/** Two names overlap if one's first-name token contains the other's (≥4 chars),
 *  catching padding like "stephen" → "benstephen"/"estephen". */
function firstNameOverlap(a: string, b: string): boolean {
  return !!a && !!b && (a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b)));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep only values that look like an internal order UUID. Used to guard
 *  `.in('id', <fraud_cases.order_ids>)` readers so a stray legacy Shopify
 *  numeric id (from before this spec) can never crash a `uuid` column with
 *  Postgres 22P02 and silently drop the whole batch of fraud orders. */
export function orderUuids(ids: unknown[]): string[] {
  const out: string[] = [];
  for (const v of ids) {
    if (typeof v === "string" && UUID_RE.test(v)) out.push(v);
  }
  return out;
}

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

    // A reviewed (confirmed/dismissed) case for this address is final unless
    // NEW orders landed there since. Without this the nightly scan re-opened the
    // same Romaine St case every night on 4 already-refunded orders.
    if (!existing) {
      const currentOrderIds = (orderDetails || []).map((o) => o.id);
      const { data: closedCases } = await admin
        .from("fraud_cases")
        .select("order_ids")
        .eq("rule_id", rule.id)
        .eq("workspace_id", workspaceId)
        .in("status", ["confirmed_fraud", "dismissed"])
        .filter("evidence->>address", "eq", normalizedAddress);
      const reviewedOrderIds = new Set((closedCases || []).flatMap((c) => (c.order_ids as string[]) || []));
      if (currentOrderIds.length && currentOrderIds.every((id) => reviewedOrderIds.has(id))) continue;
    }

    if (existing) {
      await admin
        .from("fraud_cases")
        .update({
          evidence,
          severity,
          title,
          customer_ids: customerIds,
          order_ids: (orderDetails || []).map((o) => o.id),
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      updatedCases++;
    } else {
      const orderIds = (orderDetails || []).map((o) => o.id);
      const shopIdsForTag = (orderDetails || [])
        .map((o) => o.shopify_order_id)
        .filter((s): s is string => !!s);
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

      // Tag all orders as suspicious (Shopify API needs numeric shopify_order_id)
      for (const oid of shopIdsForTag) {
        addOrderTags(workspaceId, oid, ["suspicious"]).catch(() => {});
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
    // Guard: only feed valid UUIDs to `.in('id', …)` — the `orders.id` column
    // is a uuid, so a legacy Shopify numeric id would throw Postgres 22P02 and
    // drop the whole hit. See orderUuids() and [[../tables/fraud_cases]].
    const orderIds = orderUuids(hit.order_ids as unknown[]);
    if (!orderIds.length) continue;

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
          order_ids: orders.map((o) => o.id),
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
          order_ids: orders.map((o) => o.id),
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

/**
 * Public entry — the inline per-order fraud-screen AI agent (`ai:fraud-detector` in the
 * Control Tower registry). Runs checkOrderForFraudInner and emits ONE loop_heartbeats beat at
 * the END of the run in a try/finally (control-tower-agent-coverage spec): ok:true on a clean
 * screen (whether or not it flagged), ok:false only when the screen threw. produced carries
 * the order id + whether a fraud case fired.
 */
export async function checkOrderForFraud(
  workspaceId: string,
  orderId: string,
  customerId: string | null
): Promise<void> {
  const startedAt = Date.now();
  let flagged: boolean | null = null;
  let threw: unknown = null;
  try {
    flagged = await checkOrderForFraudInner(workspaceId, orderId, customerId);
  } catch (e) {
    threw = e;
    throw e;
  } finally {
    await emitInlineAgentHeartbeat(INLINE_AGENT_IDS.fraudDetector, {
      ok: !threw,
      produced: threw ? { error: "exception", order: orderId } : { order: orderId, flagged: flagged === true },
      detail: threw ? `threw: ${errText(threw)}` : flagged ? "flagged" : "clean",
      durationMs: Date.now() - startedAt,
    });
  }
}

async function checkOrderForFraudInner(
  workspaceId: string,
  orderId: string,
  customerId: string | null
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: rules } = await admin
    .from("fraud_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  if (!rules?.length) return false;

  const { data: workspace } = await admin
    .from("workspaces")
    .select("fraud_suppressed_addresses")
    .eq("id", workspaceId)
    .single();
  const suppressedAddresses = new Set<string>((workspace?.fraud_suppressed_addresses || []) as string[]);

  // Load the order with address details
  const { data: order } = await admin
    .from("orders")
    .select("id, shopify_order_id, normalized_shipping_address, customer_id, subscription_id, billing_address, shipping_address, source_name, email, order_number, line_items, total_cents, payment_details")
    .eq("id", orderId)
    .single();

  if (!order) return false;

  // Fetch billing address + card details from Shopify when missing. We need the
  // card BIN for bin-velocity, so fetch whenever it isn't captured yet — not just
  // when billing is absent. Skip subscription renewals (the card never rotates).
  const existingPd = (order.payment_details && typeof order.payment_details === "object")
    ? (order.payment_details as Record<string, unknown>) : null;
  const haveCardBin = !!existingPd?.card_bin;
  if ((!order.billing_address || !haveCardBin) && order.shopify_order_id && !order.subscription_id) {
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
        if (billingAddr && !order.billing_address) {
          order.billing_address = billingAddr;
          updates.billing_address = billingAddr;
        }
        // Capture the card fingerprint into payment_details — MERGE, never clobber
        // (the column also holds the checkout breakdown: tax/discount/shipping).
        const card = txn?.paymentDetails as Record<string, unknown> | undefined;
        if (card?.bin) {
          const card_bin = String(card.bin).replace(/\D/g, "");
          const card_last4 = String(card.number || "").replace(/\D/g, "").slice(-4);
          const merged = {
            ...(existingPd || {}),
            gateway: txn.gateway,
            card_bin,
            card_last4,
            card_company: card.company || null,
            card_name: card.name || null,
            card_exp: `${card.expirationMonth || ""}/${card.expirationYear || ""}`,
            // Persist AVS/CVV results so the BIN-velocity order-level suspicion
            // check (evaluateBinCluster) can read them without a new API call.
            avs_result_code: card.avsResultCode || null,
            cvv_result_code: card.cvvResultCode || null,
          };
          updates.payment_details = merged;
          order.payment_details = merged;
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
        // Gather order IDs from confirmed cases. Guard: filter to valid UUIDs so
        // a stray legacy Shopify numeric id (from before all writers were fixed
        // to store `orders.id`) can never crash the `uuid` column with Postgres
        // 22P02 and silently drop the whole batch. See [[../tables/fraud_cases]].
        const fraudOrderIds = orderUuids(confirmedCases.flatMap(c => c.order_ids || []));
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

            // 8. Same custom (non-freemail) email DOMAIN — the ring reuses a
            // throwaway domain (e.g. @safelywater.com) with fresh local parts to
            // beat exact-email matching. Different local part, same custom domain
            // as a confirmed-fraud order ⇒ flag.
            const dom = email.split("@")[1] || "";
            const foDom = foEmail.split("@")[1] || "";
            if (dom && dom === foDom && email !== foEmail && !FREEMAIL_DOMAINS.has(dom)) {
              matches.push({ type: "same_email_domain", this_value: email, fraud_value: foEmail, fraud_order: fo.order_number, fraud_case_id: caseId });
            }

            // 9. Fuzzy name — same last name + overlapping first name catches name
            // padding ("stephen" → "benstephen"/"estephen") that beats exact match
            // even when the address is fresh.
            if (shipLast && foShipLast && shipLast === foShipLast && firstNameOverlap(shipFirst, foShipFirst)) {
              matches.push({ type: "fuzzy_name", this_value: `${shipFirst} ${shipLast}`, fraud_value: `${foShipFirst} ${foShipLast}`, fraud_order: fo.order_number, fraud_case_id: caseId });
            }
            if (billLast && foBillLast && billLast === foBillLast && firstNameOverlap(billFirst, foBillFirst)) {
              matches.push({ type: "fuzzy_name", this_value: `${billFirst} ${billLast}`, fraud_value: `${foBillFirst} ${foBillLast}`, fraud_order: fo.order_number, fraud_case_id: caseId });
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

  // ── Velocity signals (BIN / email-domain / surname) ──
  // Rule-independent, defense-in-depth: catches rings that rotate identity but
  // reuse a stolen-card batch, a throwaway domain, or one surname.
  try {
    if (await checkVelocitySignals(workspaceId, order, customer)) flagged = true;
  } catch (e) {
    console.error("[fraud] Velocity signal check error:", e);
  }

  // Tag the Shopify order as "suspicious" if any rule flagged it
  if (flagged && order.shopify_order_id) {
    await addOrderTags(workspaceId, order.shopify_order_id, ["suspicious"]);
  }

  return flagged;
}

// ── Velocity signals (real-time, rule-independent) ──────────────────────────
// Card-testing / stolen-batch rings rotate names, emails and addresses but leak
// three things that survive the disguise:
//   • BIN        — the same card BIN (issuer batch) across many orders + buyers
//   • domain     — the same throwaway custom email domain across fresh accounts
//   • surname    — the same surname across fresh accounts on custom domains
// Each fires an OPEN case (Dylan confirms in the UI — that path cancels subs +
// refunds to head off chargebacks) and tags the ring's orders "suspicious".
const VELOCITY_WINDOW_DAYS = 30;
// A shared BIN alone is NEVER fraud — a card BIN only identifies the issuing
// bank, and popular consumer banks (e.g. Visa 414740 = a common Chase range)
// issue to millions, so thousands of unrelated legit customers share one BIN
// with fully diverse names/addresses/cards. The Sep-2026 false-positive case
// (bin:414740) proved an account-blind corroborator sweeps in innocents: one
// fraudster reusing HER OWN card on HER OWN account satisfied the old "one card
// reused 4–5 times" test and pulled 8 unrelated subscribers into the case. The
// BIN branch now opens a case ONLY on a genuine CROSS-ACCOUNT link (the same
// card / shipping address / phone / browser IP used by ≥2 DISTINCT accounts, or
// a tiny set of surnames across ≥3 accounts) or an order-level independent
// suspicion signal — and scopes the case to ONLY the linked accounts.
const CROSS_ACCOUNT_MIN_ACCOUNTS = 2; // a cross-account link must touch ≥2 distinct accounts
const BIN_SURNAME_MIN_ACCOUNTS = 3; // the surname corroborator requires ≥3 distinct accounts…
const BIN_MAX_SURNAMES = 2; // …narrowing to ≤2 distinct cardholder surnames
const ESTABLISHED_MIN_PRIOR_ORDERS = 3; // ≥3 prior paid orders = an established customer
// Phase 2 — a dismissal on a velocity key suppresses re-flagging the SAME
// customers on that key for this many days (the bin:414740 case re-opened 6×
// in Sep-2026 because openCase ignored dismissed cases).
const BIN_DISMISS_SUPPRESS_DAYS = VELOCITY_WINDOW_DAYS;
const DOMAIN_MIN_CUSTOMERS = 4; // ≥4 distinct accounts on one custom domain
const SURNAME_MIN_CUSTOMERS = 4; // ≥4 new accounts sharing a surname…
const SURNAME_MIN_CUSTOM_DOMAIN = 2; // …with ≥2 on non-freemail domains

function emailDomain(email: string | null | undefined): string {
  const e = (email || "").toLowerCase().trim();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

// ── BIN-velocity cluster evaluation (pure, unit-tested) ─────────────────────
// Factored out of checkVelocitySignals so the concentration logic is testable
// without a DB. A BIN cluster (all window orders sharing one card BIN) only
// opens a case on genuine CROSS-ACCOUNT evidence or order-level suspicion, and
// the case is scoped to ONLY the linked accounts.
export type BinClusterRow = {
  orderId: string; // internal orders.id (uuid) → fraud_cases.order_ids
  shopOrderId: string | null; // numeric Shopify id for the tagsAdd call
  customerId: string | null;
  email: string | null;
  cardLast4: string;
  cardExp: string;
  cardName: string;
  billingName: string;
  shipAddress1: string;
  shipZip5: string;
  phone: string; // digits only
  browserIp: string;
  avsResultCode: string;
  cvvResultCode: string;
  riskRecommendation: string; // Shopify risk: 'cancel' | 'investigate' | …
};

// Per-customer PRIOR (pre-cluster) history for the established-customer exclusion.
export type BinCustomerHistory = {
  priorPaidOrders: number;
  hasChargeback: boolean;
  priorCardKeys: Set<string>; // card keys (last4|exp) from this customer's prior orders
};

export type BinClusterResult = {
  fired: boolean;
  corroborator: string | null; // primary corroborator label
  corroborators: string[]; // every corroborator that fired
  reason: string; // human phrase for the title/summary
  crossAccountCardReuse: number; // max distinct accounts sharing a single card
  distinctSurnames: number;
  linkedCustomerIds: string[];
  linkedOrderIds: string[]; // internal uuids
  linkedShopOrderIds: string[];
  excludedEstablishedCustomerCount: number;
  title: string;
  summary: string;
};

// A linked member of a velocity case: one order and the account that placed it.
export type VelocityCaseMember = { customerId: string | null; orderId: string; shopOrderId: string | null };

// Phase 2 — drop members whose account was on a previously-dismissed case for
// this same velocity key, so a dismissal stays dismissed for those customers.
// Pure + unit-tested; `openCase` passes the most-recent dismissed case's
// customer_ids. `suppressedPresent` is the subset of dismissed customers that
// actually reappeared (recorded as evidence.suppressed_dismissed_customer_ids).
export function applyDismissalSuppression<T extends { customerId: string | null }>(
  members: T[],
  dismissedCustomerIds: string[],
): { kept: T[]; suppressedPresent: string[] } {
  const dismissed = new Set(dismissedCustomerIds.filter(Boolean));
  const kept = members.filter((m) => !(m.customerId && dismissed.has(m.customerId)));
  const suppressedPresent = [
    ...new Set(members.map((m) => m.customerId).filter((c): c is string => !!c && dismissed.has(c))),
  ];
  return { kept, suppressedPresent };
}

function normalizeNameTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ") // drop punctuation + apostrophes
    .split(/\s+/)
    .filter(Boolean);
}

// First + last token agree (case, punctuation, apostrophes, middle names ignored).
// Missing data on either side is NOT treated as a mismatch.
function cardBillingNamesAgree(cardName: string, billingName: string): boolean {
  const a = normalizeNameTokens(cardName);
  const b = normalizeNameTokens(billingName);
  if (!a.length || !b.length) return true;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

function surnameOf(cardName: string): string {
  const t = normalizeNameTokens(cardName);
  return t.length ? t[t.length - 1] : "";
}

// Shopify returns single-letter AVS/CVV codes; 'N' = no match / failure. Only an
// explicit 'N' counts so unknown/unsupported codes never false-positive.
function isAvsOrCvvFailure(avs: string, cvv: string): boolean {
  return avs.trim().toUpperCase() === "N" || cvv.trim().toUpperCase() === "N";
}

const BIN_CORROBORATOR_PRIORITY = [
  "cross_account_card",
  "shared_shipping_address",
  "shared_phone",
  "shared_ip",
  "few_surnames",
  "order_level_suspicion",
] as const;

export function evaluateBinCluster(
  bin: string,
  rows: BinClusterRow[],
  history: Map<string, BinCustomerHistory>,
): BinClusterResult {
  const cardKey = (r: BinClusterRow) => (r.cardLast4 && r.cardExp ? `${r.cardLast4}|${r.cardExp}` : "");
  const addrKey = (r: BinClusterRow) =>
    r.shipAddress1 && r.shipZip5 ? `${r.shipAddress1.toLowerCase().trim()}|${r.shipZip5}` : "";

  // Group DISTINCT accounts per linkable key. One account repeating on its own
  // card/address never inflates a count — the value is a Set of customer_ids.
  const accountsByCard = new Map<string, Set<string>>();
  const accountsByAddress = new Map<string, Set<string>>();
  const accountsByPhone = new Map<string, Set<string>>();
  const accountsByIp = new Map<string, Set<string>>();
  const surnameAccounts = new Map<string, Set<string>>();

  const add = (m: Map<string, Set<string>>, k: string, cust: string) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(cust);
  };

  for (const r of rows) {
    const cust = r.customerId;
    if (!cust) continue;
    add(accountsByCard, cardKey(r), cust);
    add(accountsByAddress, addrKey(r), cust);
    add(accountsByPhone, r.phone, cust);
    add(accountsByIp, r.browserIp, cust);
    add(surnameAccounts, surnameOf(r.cardName), cust);
  }

  const hardLinkedCustomers = new Set<string>(); // (a)–(d) + order-level — resist the exclusion
  const linkedCustomers = new Set<string>();
  const linkedOrders = new Set<string>();
  const linkedShopOrders = new Set<string>();
  const corroborators = new Set<string>();

  const linkOrder = (r: BinClusterRow) => {
    linkedOrders.add(r.orderId);
    if (r.shopOrderId) linkedShopOrders.add(r.shopOrderId);
    if (r.customerId) linkedCustomers.add(r.customerId);
  };

  const sharedKeys = (m: Map<string, Set<string>>) =>
    new Set([...m].filter(([, a]) => a.size >= CROSS_ACCOUNT_MIN_ACCOUNTS).map(([k]) => k));

  // crossAccountCardReuse: the max number of DISTINCT accounts on any single
  // card. ≥2 is the stolen-card-batch fingerprint; 1 (an account reusing its own
  // card) never corroborates. This REPLACES the account-blind maxCardReuse.
  let crossAccountCardReuse = 0;
  for (const a of accountsByCard.values()) crossAccountCardReuse = Math.max(crossAccountCardReuse, a.size);

  // (a) same card on ≥2 accounts.
  const sharedCards = sharedKeys(accountsByCard);
  if (sharedCards.size) {
    corroborators.add("cross_account_card");
    for (const r of rows)
      if (r.customerId && sharedCards.has(cardKey(r))) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (b) same shipping address on ≥2 accounts.
  const sharedAddresses = sharedKeys(accountsByAddress);
  if (sharedAddresses.size) {
    corroborators.add("shared_shipping_address");
    for (const r of rows)
      if (r.customerId && sharedAddresses.has(addrKey(r))) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (c) same phone on ≥2 accounts.
  const sharedPhones = sharedKeys(accountsByPhone);
  if (sharedPhones.size) {
    corroborators.add("shared_phone");
    for (const r of rows)
      if (r.customerId && r.phone && sharedPhones.has(r.phone)) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (d) same browser IP on ≥2 accounts.
  const sharedIps = sharedKeys(accountsByIp);
  if (sharedIps.size) {
    corroborators.add("shared_ip");
    for (const r of rows)
      if (r.customerId && r.browserIp && sharedIps.has(r.browserIp)) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }

  // Order-level independent suspicion qualifies THAT one order + its account.
  for (const r of rows) {
    if (!r.customerId) continue;
    const nameMismatch = !!r.cardName && !!r.billingName && !cardBillingNamesAgree(r.cardName, r.billingName);
    const avsCvvFail = isAvsOrCvvFailure(r.avsResultCode, r.cvvResultCode);
    const risky = ["cancel", "investigate"].includes(r.riskRecommendation.trim().toLowerCase());
    if (nameMismatch || avsCvvFail || risky) {
      corroborators.add("order_level_suspicion");
      hardLinkedCustomers.add(r.customerId);
      linkOrder(r);
    }
  }

  // (e) ≤2 distinct cardholder surnames across ≥3 distinct accounts. This is a
  // soft signal, so an established clean customer swept in by it alone is excluded.
  const distinctSurnames = surnameAccounts.size;
  const surnameAccountSet = new Set<string>();
  for (const accts of surnameAccounts.values()) for (const c of accts) surnameAccountSet.add(c);
  const surnameLinkedCustomers = new Set<string>();
  if (distinctSurnames > 0 && distinctSurnames <= BIN_MAX_SURNAMES && surnameAccountSet.size >= BIN_SURNAME_MIN_ACCOUNTS) {
    corroborators.add("few_surnames");
    for (const c of surnameAccountSet) surnameLinkedCustomers.add(c);
  }

  // Established-customer exclusion: a customer with ≥3 prior paid orders, no
  // chargebacks, and the same card as their prior orders is NEVER added to a BIN
  // case on BIN (surname) grounds alone. A hard cross-account link keeps them in.
  const isEstablishedClean = (cust: string): boolean => {
    const h = history.get(cust);
    if (!h || h.priorPaidOrders < ESTABLISHED_MIN_PRIOR_ORDERS || h.hasChargeback) return false;
    return rows.some((r) => r.customerId === cust && cardKey(r) && h.priorCardKeys.has(cardKey(r)));
  };

  let excludedEstablishedCustomerCount = 0;
  for (const cust of surnameLinkedCustomers) {
    if (hardLinkedCustomers.has(cust)) {
      linkedCustomers.add(cust);
      continue;
    }
    if (isEstablishedClean(cust)) {
      excludedEstablishedCustomerCount++;
      continue;
    }
    linkedCustomers.add(cust);
  }
  if (corroborators.has("few_surnames")) {
    for (const r of rows) if (r.customerId && linkedCustomers.has(r.customerId) && surnameOf(r.cardName)) linkOrder(r);
  }

  const linkedCustomerIds = [...linkedCustomers];
  const linkedOrderIds = [...linkedOrders];
  const linkedShopOrderIds = [...linkedShopOrders];
  const fired = corroborators.size > 0 && linkedCustomerIds.length > 0;
  const primary = BIN_CORROBORATOR_PRIORITY.find((c) => corroborators.has(c)) || null;

  const reasonMap: Record<string, string> = {
    cross_account_card: `the same card used across ${crossAccountCardReuse} distinct accounts`,
    shared_shipping_address: "the same shipping address shared across ≥2 accounts",
    shared_phone: "the same phone shared across ≥2 accounts",
    shared_ip: "the same browser IP shared across ≥2 accounts",
    few_surnames: `only ${distinctSurnames} distinct cardholder surname(s) across ≥${BIN_SURNAME_MIN_ACCOUNTS} accounts`,
    order_level_suspicion: "an order with an independent suspicion signal (card/billing name mismatch, AVS/CVV failure, or a Shopify cancel/investigate risk)",
  };
  const reason = primary ? reasonMap[primary] : "";

  // Only claim the "stolen-card batch" fingerprint when corroborator (a) fired.
  const title = `Card BIN ${bin} — ${linkedCustomerIds.length} linked account(s): ${reason} (30d)`;
  const summary =
    primary === "cross_account_card"
      ? `${linkedOrderIds.length} orders across ${linkedCustomerIds.length} distinct accounts share card BIN ${bin} and ${reason} — the fingerprint of a stolen-card batch being run through different identities.`
      : `${linkedOrderIds.length} order(s) across ${linkedCustomerIds.length} account(s) on card BIN ${bin} were linked by ${reason}. Only the linked accounts are held; other customers who merely share this BIN are not implicated.`;

  return {
    fired,
    corroborator: primary,
    corroborators: [...corroborators],
    reason,
    crossAccountCardReuse,
    distinctSurnames,
    linkedCustomerIds,
    linkedOrderIds,
    linkedShopOrderIds,
    excludedEstablishedCustomerCount,
    title,
    summary,
  };
}

async function checkVelocitySignals(
  workspaceId: string,
  order: { id: string; shopify_order_id: string | null; email: string | null; payment_details: unknown; subscription_id: string | null },
  customer: { id: string; first_name: string | null; last_name: string | null } | null,
): Promise<boolean> {
  if (order.subscription_id) return false; // subscription renewals are legit repeat billing
  const admin = createAdminClient();
  const since = new Date(Date.now() - VELOCITY_WINDOW_DAYS * 86_400_000).toISOString();
  let fired = false;

  // Open (or refresh) one case per distinct velocity key, hold every linked order.
  // `members` carry the internal order UUID (persisted to fraud_cases.order_ids),
  // the numeric Shopify id the tagsAdd API needs, and the owning account.
  const openCase = async (
    ruleType: string,
    velocityKey: string,
    title: string,
    summary: string,
    evidence: Record<string, unknown>,
    members: VelocityCaseMember[],
  ): Promise<void> => {
    // Phase 2 — a dismissal on this velocity key stays dismissed for the SAME
    // customers. Load the most recent dismissed case for this key within the
    // window, drop its customers from the linked set, and only open a case for
    // genuinely-new customers. If nothing new remains, do nothing (no hold/tag).
    const dismissSince = new Date(Date.now() - BIN_DISMISS_SUPPRESS_DAYS * 86_400_000).toISOString();
    const { data: lastDismissed } = await admin
      .from("fraud_cases")
      .select("customer_ids")
      .eq("workspace_id", workspaceId)
      .eq("rule_type", ruleType)
      .eq("status", "dismissed")
      .gte("last_seen_at", dismissSince)
      .filter("evidence->>velocity_key", "eq", velocityKey)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { kept, suppressedPresent } = applyDismissalSuppression(
      members,
      (lastDismissed?.customer_ids || []) as string[],
    );
    const customerIds = [...new Set(kept.map((m) => m.customerId).filter((c): c is string => !!c))];
    const orderIds = [...new Set(kept.map((m) => m.orderId).filter(Boolean))];
    const shopOrderIdsForTag = [...new Set(kept.map((m) => m.shopOrderId).filter((s): s is string => !!s))];
    // Every linked customer was previously dismissed on this key → re-flag nothing.
    if (!customerIds.length) return;

    const fullEvidence = {
      ...evidence,
      velocity_key: velocityKey,
      linked_customer_ids: customerIds,
      linked_order_ids: orderIds,
      ...(suppressedPresent.length ? { suppressed_dismissed_customer_ids: suppressedPresent } : {}),
    };
    const { data: existing } = await admin
      .from("fraud_cases")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("rule_type", ruleType)
      .not("status", "in", '("confirmed_fraud","dismissed")')
      .filter("evidence->>velocity_key", "eq", velocityKey)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await admin
        .from("fraud_cases")
        .update({ evidence: fullEvidence, title, summary, customer_ids: customerIds, order_ids: orderIds, last_seen_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      const { data: nc } = await admin
        .from("fraud_cases")
        .insert({
          workspace_id: workspaceId,
          rule_type: ruleType,
          status: "open",
          severity: "high",
          title,
          summary,
          evidence: fullEvidence,
          customer_ids: customerIds,
          order_ids: orderIds,
          orders_held: true,
          first_detected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (nc) await inngest.send({ name: "fraud/case.created", data: { caseId: nc.id, workspaceId } });
    }
    for (const sid of shopOrderIdsForTag) if (sid) addOrderTags(workspaceId, sid, ["suspicious"]).catch(() => {});
    fired = true;
  };

  // 1) BIN velocity — a stolen-card batch run through different identities.
  // A shared BIN alone identifies only the issuing bank and is NEVER enough; the
  // BIN case opens ONLY on a genuine CROSS-ACCOUNT link or an order-level
  // independent suspicion signal, and is scoped to ONLY the linked accounts.
  // See evaluateBinCluster for the (account-aware) corroborator logic.
  const pd = (order.payment_details && typeof order.payment_details === "object") ? (order.payment_details as Record<string, unknown>) : null;
  const bin = pd?.card_bin ? String(pd.card_bin) : "";
  if (/^\d{6,}$/.test(bin)) {
    const { data: binOrders } = await admin
      .from("orders")
      .select("id, shopify_order_id, customer_id, email, shipping_address, billing_address, payment_details")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .filter("payment_details->>card_bin", "eq", bin)
      .limit(200);
    const rows = binOrders || [];
    const custIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean) as string[])];

    const str = (v: unknown) => (v == null ? "" : String(v));
    const asObj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
    const clusterRows: BinClusterRow[] = rows.map((r) => {
      const rpd = asObj(r.payment_details);
      const sa = asObj(r.shipping_address);
      const ba = asObj(r.billing_address);
      const billingName = ba
        ? `${str(ba.firstName ?? ba.first_name)} ${str(ba.lastName ?? ba.last_name)}`.trim()
        : "";
      return {
        orderId: r.id,
        shopOrderId: r.shopify_order_id,
        customerId: r.customer_id,
        email: r.email,
        cardLast4: str(rpd?.card_last4),
        cardExp: str(rpd?.card_exp),
        cardName: str(rpd?.card_name),
        billingName,
        shipAddress1: str(sa?.address1),
        shipZip5: str(sa?.zip).slice(0, 5),
        phone: str(sa?.phone).replace(/\D/g, ""),
        browserIp: str(rpd?.browser_ip),
        avsResultCode: str(rpd?.avs_result_code),
        cvvResultCode: str(rpd?.cvv_result_code),
        riskRecommendation: str(rpd?.risk_recommendation),
      };
    });

    // Per-customer PRIOR history (orders OUTSIDE this cluster) for the
    // established-customer exclusion: ≥3 prior paid orders, no active chargeback,
    // same card as before → never swept in on BIN (surname) grounds alone.
    const history = new Map<string, BinCustomerHistory>();
    if (custIds.length) {
      const clusterOrderIds = new Set(rows.map((r) => r.id));
      const [{ data: priorOrders }, { data: cbRows }] = await Promise.all([
        admin
          .from("orders")
          .select("id, customer_id, financial_status, payment_details")
          .eq("workspace_id", workspaceId)
          .in("customer_id", custIds)
          .limit(2000),
        admin
          .from("chargeback_events")
          .select("customer_id")
          .eq("workspace_id", workspaceId)
          .in("customer_id", custIds)
          .in("status", ["open", "under_review", "lost", "pending"]),
      ]);
      const cbSet = new Set((cbRows || []).map((c) => c.customer_id).filter(Boolean) as string[]);
      for (const c of custIds) history.set(c, { priorPaidOrders: 0, hasChargeback: cbSet.has(c), priorCardKeys: new Set() });
      for (const po of priorOrders || []) {
        const c = po.customer_id as string | null;
        if (!c || clusterOrderIds.has(po.id)) continue; // PRIOR orders only
        const h = history.get(c);
        if (!h) continue;
        if (["paid", "partially_refunded", "refunded"].includes(String(po.financial_status || "").toLowerCase())) h.priorPaidOrders++;
        const rpd = asObj(po.payment_details);
        const last4 = str(rpd?.card_last4);
        const exp = str(rpd?.card_exp);
        if (last4 && exp) h.priorCardKeys.add(`${last4}|${exp}`);
      }
    }

    const result = evaluateBinCluster(bin, clusterRows, history);
    if (result.fired) {
      const linkedSet = new Set(result.linkedCustomerIds);
      const linkedOrderSet = new Set(result.linkedOrderIds);
      const members: VelocityCaseMember[] = clusterRows
        .filter((r) => linkedOrderSet.has(r.orderId))
        .map((r) => ({ customerId: r.customerId, orderId: r.orderId, shopOrderId: r.shopOrderId }));
      await openCase(
        "bin_velocity",
        `bin:${bin}`,
        result.title,
        result.summary,
        {
          card_bin: bin,
          corroborator: result.corroborator,
          corroborators: result.corroborators,
          cross_account_card_reuse: result.crossAccountCardReuse,
          distinct_surnames: result.distinctSurnames,
          excluded_established_customer_count: result.excludedEstablishedCustomerCount,
          bin_cluster_order_count: rows.length,
          bin_cluster_customer_count: custIds.length,
          window_days: VELOCITY_WINDOW_DAYS,
          emails: rows.filter((r) => r.customer_id && linkedSet.has(r.customer_id)).map((r) => r.email).filter(Boolean).slice(0, 40),
        },
        members,
      );
    }
  }

  // 2) Email-domain velocity — many fresh accounts on one custom (non-freemail) domain.
  const domain = emailDomain(order.email);
  if (domain && !FREEMAIL_DOMAINS.has(domain)) {
    const { data: domOrders } = await admin
      .from("orders")
      .select("id, shopify_order_id, customer_id, email")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .ilike("email", `%@${domain}`)
      .limit(200);
    const rows = domOrders || [];
    const custs = new Set(rows.map((r) => r.customer_id).filter(Boolean) as string[]);
    const emails = new Set(rows.map((r) => (r.email || "").toLowerCase()).filter(Boolean));
    if (custs.size >= DOMAIN_MIN_CUSTOMERS && emails.size >= DOMAIN_MIN_CUSTOMERS) {
      const members: VelocityCaseMember[] = rows.map((r) => ({ customerId: r.customer_id, orderId: r.id, shopOrderId: r.shopify_order_id }));
      await openCase(
        "email_domain_velocity",
        `domain:${domain}`,
        `${custs.size} accounts on @${domain} ordered in 30d`,
        `${custs.size} distinct customers on the custom domain @${domain} placed orders in the last 30 days (${emails.size} distinct addresses) — characteristic of a ring spinning up throwaway accounts on one domain it controls.`,
        { email_domain: domain, customer_count: custs.size, email_count: emails.size, window_days: VELOCITY_WINDOW_DAYS, emails: [...emails].slice(0, 40) },
        members,
      );
    }
  }

  // 3) Surname velocity — many fresh accounts sharing a surname, on custom domains.
  const lastName = (customer?.last_name || "").trim();
  if (lastName.length >= 3) {
    const { data: kin } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .ilike("last_name", lastName)
      .gte("created_at", since)
      .limit(200);
    const rows = kin || [];
    const nonFree = rows.filter((r) => { const d = emailDomain(r.email); return d && !FREEMAIL_DOMAINS.has(d); });
    if (rows.length >= SURNAME_MIN_CUSTOMERS && nonFree.length >= SURNAME_MIN_CUSTOM_DOMAIN) {
      const custIds = rows.map((r) => r.id);
      const { data: kinOrders } = await admin
        .from("orders")
        .select("id, shopify_order_id, customer_id")
        .eq("workspace_id", workspaceId)
        .in("customer_id", custIds)
        .gte("created_at", since)
        .limit(200);
      // One member per order, plus a customer-only member for any surname account
      // with no window orders (keeps it in customer_ids so the ring stays complete).
      const members: VelocityCaseMember[] = (kinOrders || []).map((o) => ({ customerId: o.customer_id, orderId: o.id, shopOrderId: o.shopify_order_id }));
      const withOrders = new Set((kinOrders || []).map((o) => o.customer_id).filter(Boolean) as string[]);
      for (const id of custIds) if (!withOrders.has(id)) members.push({ customerId: id, orderId: "", shopOrderId: null });
      await openCase(
        "surname_velocity",
        `surname:${lastName.toLowerCase()}`,
        `${rows.length} new "${lastName}" accounts (${nonFree.length} on custom domains, 30d)`,
        `${rows.length} new accounts share the surname "${lastName}" in the last 30 days, ${nonFree.length} on custom (non-freemail) domains — characteristic of a ring reusing one identity across throwaway emails.`,
        { surname: lastName, customer_count: rows.length, non_freemail_count: nonFree.length, window_days: VELOCITY_WINDOW_DAYS, emails: rows.map((r) => r.email).filter(Boolean).slice(0, 40) },
        members,
      );
    }
  }

  return fired;
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
      order_ids: [order.id],
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
      order_ids: [order.id],
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
      order_ids: [order.id],
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
