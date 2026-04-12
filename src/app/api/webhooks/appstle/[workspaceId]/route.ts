import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { Webhook } from "svix";
import { calculateRetentionScore } from "@/lib/retention-score";
import { logCustomerEvent } from "@/lib/customer-events";
import { evaluateRules } from "@/lib/rules-engine";
import { inngest } from "@/lib/inngest/client";

function mapStatus(status: string): "active" | "paused" | "cancelled" | "expired" | "failed" {
  switch (status?.toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    case "CANCELLED": return "cancelled";
    case "EXPIRED": return "expired";
    case "FAILED": return "failed";
    default: return "active";
  }
}

function mapCustomerStatus(status: string): "active" | "paused" | "cancelled" | "never" {
  switch (status?.toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    default: return "cancelled";
  }
}

function extractId(gid: string): string {
  return String(gid).split("/").pop() || String(gid);
}

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const body = await request.text();
  // Svix/webhook headers — Appstle uses "webhook-*" prefix instead of "svix-*"
  const headers = {
    "svix-id": request.headers.get("webhook-id") || request.headers.get("svix-id") || "",
    "svix-timestamp": request.headers.get("webhook-timestamp") || request.headers.get("svix-timestamp") || "",
    "svix-signature": request.headers.get("webhook-signature") || request.headers.get("svix-signature") || "",
  };

  if (!headers["svix-id"] || !headers["svix-signature"]) {
    return NextResponse.json({ error: "Missing webhook headers" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up this specific workspace's secret
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, appstle_webhook_secret_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.appstle_webhook_secret_encrypted) {
    return NextResponse.json({ error: "Appstle not configured for this workspace" }, { status: 404 });
  }

  // Verify signature
  let payload: Record<string, unknown>;
  try {
    const secret = decrypt(workspace.appstle_webhook_secret_encrypted);
    const wh = new Webhook(secret);
    payload = wh.verify(body, headers) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventType = payload.type as string;
  const data = payload.data as Record<string, unknown>;

  if (!data || !eventType) {
    return NextResponse.json({ ok: true });
  }

  console.log(`Appstle webhook: ${eventType}`);

  try {
    // Rich subscription events have data.customer
    // Flat billing events have data.contractId without data.customer
    if (data.customer) {
      await handleSubscriptionEvent(admin, workspaceId, eventType, data);
    } else if (data.contractId) {
      await handleBillingEvent(admin, workspaceId, eventType, data);
    }

    return NextResponse.json({ ok: true, event: eventType });
  } catch (err) {
    console.error(`Appstle webhook error (${eventType}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function handleSubscriptionEvent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
) {
  const customer = data.customer as { id?: string; email?: string; firstName?: string; lastName?: string; phone?: string };
  if (!customer?.email) return;

  const shopifyCustomerId = customer.id ? extractId(customer.id) : null;
  const email = customer.email.toLowerCase();
  const contractId = data.id ? extractId(data.id as string) : null;
  const status = data.status as string;

  // Find or create customer
  let dbCustomer: { id: string } | null = null;

  if (shopifyCustomerId) {
    const { data: found } = await admin.from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("shopify_customer_id", shopifyCustomerId).single();
    dbCustomer = found;
  }
  if (!dbCustomer) {
    const { data: found } = await admin.from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("email", email).single();
    dbCustomer = found;
  }
  if (!dbCustomer) {
    const { data: created } = await admin.from("customers").insert({
      workspace_id: workspaceId, email,
      first_name: customer.firstName || null, last_name: customer.lastName || null,
      phone: customer.phone || null, shopify_customer_id: shopifyCustomerId,
    }).select("id").single();
    dbCustomer = created;
  }
  if (!dbCustomer) return;

  // Extract subscription items
  const lines = (data.lines as { nodes?: Record<string, unknown>[] })?.nodes || [];
  const items = lines.map((line) => ({
    title: line.title,
    sku: line.sku,
    quantity: line.quantity,
    price_cents: dollarsToCents((line.currentPrice as { amount?: string })?.amount),
    product_id: line.productId ? extractId(line.productId as string) : null,
    variant_id: line.variantId ? extractId(line.variantId as string) : null,
    variant_title: line.variantTitle || null,
    selling_plan: line.sellingPlanName || null,
    line_id: line.id ? extractId(line.id as string) : null,
  }));

  const billingPolicy = data.billingPolicy as { interval?: string; intervalCount?: number } | undefined;
  const deliveryPrice = data.deliveryPrice as { amount?: string } | undefined;

  // Extract shipping address from deliveryMethod.address
  const deliveryMethod = data.deliveryMethod as { address?: Record<string, unknown> } | undefined;
  const rawAddr = deliveryMethod?.address;
  const shippingAddress = rawAddr ? {
    firstName: rawAddr.firstName || "",
    lastName: rawAddr.lastName || "",
    address1: rawAddr.address1 || "",
    address2: rawAddr.address2 || "",
    city: rawAddr.city || "",
    province: rawAddr.province || "",
    provinceCode: rawAddr.provinceCode || "",
    zip: rawAddr.zip || "",
    country: rawAddr.country || "",
    countryCode: rawAddr.countryCode || rawAddr.countryCodeV2 || "",
    phone: rawAddr.phone || "",
  } : null;

  // Extract applied discounts from webhook payload
  const discountNodes = ((data.discounts as { nodes?: Record<string, unknown>[] })?.nodes) || [];
  const appliedDiscounts = discountNodes.map(node => {
    const val = node.value as Record<string, unknown> | undefined;
    return {
      id: node.id as string,
      title: (node.title as string) || "",
      type: (node.type as string) || "",
      value: val?.percentage ? Number(val.percentage)
        : (val?.amount as { amount?: string } | undefined)?.amount ? Number((val!.amount as { amount: string }).amount)
        : val?.fixedAmount ? Number((val.fixedAmount as { amount?: string })?.amount || 0)
        : 0,
      valueType: val?.percentage ? "PERCENTAGE" : "FIXED_AMOUNT",
    };
  });

  // Upsert subscription — protect next_billing_date during active dunning
  if (contractId) {
    // Check if there's an active dunning cycle for this contract
    const { data: activeDunning } = await admin.from("dunning_cycles")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .in("status", ["active", "skipped"])
      .limit(1)
      .single();

    // If dunning is active, don't let the webhook override next_billing_date
    // Our dunning system will set the correct date when it finishes
    const nextBillingDate = activeDunning
      ? undefined // Skip updating this field
      : (data.nextBillingDate as string) || null;

    const upsertData: Record<string, unknown> = {
      workspace_id: workspaceId,
      customer_id: dbCustomer.id,
      shopify_contract_id: contractId,
      shopify_customer_id: shopifyCustomerId,
      status: mapStatus(status),
      billing_interval: billingPolicy?.interval?.toLowerCase() || null,
      billing_interval_count: billingPolicy?.intervalCount || null,
      last_payment_status: (data.lastPaymentStatus as string)?.toLowerCase() || null,
      items,
      delivery_price_cents: dollarsToCents(deliveryPrice?.amount),
      shipping_address: shippingAddress,
      subscription_created_at: (data.createdAt as string) || null,
      applied_discounts: appliedDiscounts,
      updated_at: new Date().toISOString(),
    };

    // Only update next_billing_date if dunning isn't active
    if (nextBillingDate !== undefined) {
      upsertData.next_billing_date = nextBillingDate;
    }

    await admin.from("subscriptions").upsert(upsertData, { onConflict: "workspace_id,shopify_contract_id" });

    // Self-heal: if multiple CODE_DISCOUNT coupons detected, remove extras
    // AUTOMATIC_DISCOUNT types (Buy 2, Free Shipping) are managed by Shopify — don't touch
    const codeDiscounts = appliedDiscounts.filter(d => d.type === "CODE_DISCOUNT");
    if (codeDiscounts.length > 1) {
      console.log(`[Appstle] Multiple code discounts on contract ${contractId}: ${codeDiscounts.map(d => d.title).join(", ")}. Auto-removing extras.`);
      try {
        const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
        if (ws?.appstle_api_key_encrypted) {
          const apiKey = decrypt(ws.appstle_api_key_encrypted);
          // Keep the first code discount, remove the rest
          for (const extra of codeDiscounts.slice(1)) {
            await fetch(
              `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${contractId}&discountId=${encodeURIComponent(extra.id)}&api_key=${apiKey}`,
              { method: "PUT", headers: { "X-API-Key": apiKey } },
            ).catch(() => {});
          }
        }
      } catch {}
    }
  }

  // Determine overall customer subscription status from all their subscriptions
  const { data: allSubs } = await admin.from("subscriptions").select("status").eq("customer_id", dbCustomer.id);
  const hasActive = allSubs?.some((s) => s.status === "active");
  const hasPaused = allSubs?.some((s) => s.status === "paused");
  const overallStatus = hasActive ? "active" : hasPaused ? "paused" : mapCustomerStatus(status);

  await admin.from("customers").update({
    subscription_status: overallStatus,
    updated_at: new Date().toISOString(),
  }).eq("id", dbCustomer.id);

  // Recalculate retention score
  const { data: full } = await admin.from("customers")
    .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
    .eq("id", dbCustomer.id).single();
  if (full) {
    await admin.from("customers").update({ retention_score: calculateRetentionScore(full) }).eq("id", dbCustomer.id);
  }

  // Log event
  const summaryMap: Record<string, string> = {
    "subscription.created": `Subscription created — ${status}`,
    "subscription.activated": `Subscription activated`,
    "subscription.paused": `Subscription paused`,
    "subscription.cancelled": `Subscription cancelled`,
    "subscription.updated": `Subscription updated — ${status}`,
    "subscription.billing-success": `Billing succeeded`,
    "subscription.billing-interval-changed": `Billing interval changed to ${billingPolicy?.interval} / ${billingPolicy?.intervalCount}`,
    "subscription.next-order-date-changed": `Next order date changed`,
    "subscription.upcoming-order-notification": `Upcoming order notification`,
  };

  await logCustomerEvent({
    workspaceId,
    customerId: dbCustomer.id,
    eventType,
    source: "appstle",
    summary: summaryMap[eventType] || eventType,
    properties: {
      shopify_contract_id: contractId,
      status,
      next_billing_date: data.nextBillingDate,
      items: items.map(i => i.title).filter(Boolean),
    },
  });

  // Evaluate rules
  const { data: subCtx } = contractId
    ? await admin.from("subscriptions").select("*").eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).single()
    : { data: null };
  const { data: custCtx } = await admin.from("customers").select("*").eq("id", dbCustomer.id).single();
  await evaluateRules(workspaceId, eventType, {
    subscription: subCtx || undefined,
    customer: custCtx || undefined,
  });
}

async function handleBillingEvent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
) {
  const contractId = String(data.contractId);

  const { data: sub } = await admin.from("subscriptions").select("id, customer_id")
    .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).single();

  if (!sub) {
    console.log(`Appstle billing: contract ${contractId} not found`);
    return;
  }

  // Ignore upcoming-order-notification — not actionable
  if (eventType === "subscription.upcoming-order-notification") return;

  // Ignore billing-skipped when Appstle defers to our dunning management
  // These are just Appstle's internal state changes from our retry attempts
  if (eventType === "subscription.billing-skipped" && data.status === "SKIPPED_DUNNING_MGMT") {
    console.log(`Appstle billing-skipped (SKIPPED_DUNNING_MGMT) for contract ${contractId} — ignoring, our dunning manages this.`);
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (eventType === "subscription.billing-failure") {
    updates.last_payment_status = "failed";
  } else if (eventType === "subscription.billing-success") {
    updates.last_payment_status = "succeeded";
    updates.consecutive_skips = 0; // Reset on successful billing

    // Link order → subscription using contract + order ID from billing payload
    const billingOrderId = data.orderId ? String(data.orderId) : null;
    if (billingOrderId && sub.id) {
      await admin.from("orders")
        .update({ subscription_id: sub.id })
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", billingOrderId);
    }
  } else if (eventType === "subscription.billing-skipped") {
    updates.last_payment_status = "skipped";
  }

  await admin.from("subscriptions").update(updates).eq("id", sub.id);

  // Atomic increment consecutive_skips on billing-skipped (only non-dunning skips reach here)
  if (eventType === "subscription.billing-skipped") {
    await admin.rpc("increment_consecutive_skips", { p_sub_id: sub.id });
  }

  // Recalculate retention score on payment failures
  if (sub.customer_id && eventType !== "subscription.billing-success") {
    const { data: customer } = await admin.from("customers")
      .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
      .eq("id", sub.customer_id).single();
    if (customer) {
      await admin.from("customers").update({ retention_score: calculateRetentionScore(customer) }).eq("id", sub.customer_id);
    }

    // Log event
    const billingMsg = eventType === "subscription.billing-failure" ? "Payment failed"
      : eventType === "subscription.billing-skipped" ? "Billing skipped"
      : eventType === "subscription.billing-success" ? "Payment succeeded"
      : eventType === "subscription.upcoming-order-notification" ? "Upcoming order notification"
      : eventType;

    await logCustomerEvent({
      workspaceId,
      customerId: sub.customer_id,
      eventType,
      source: "appstle",
      summary: `${billingMsg} — contract ${contractId}`,
      properties: {
        shopify_contract_id: contractId,
        attempt_count: data.attemptCount,
        status: data.status,
        error_message: data.billingAttemptResponseMessage ? JSON.parse(data.billingAttemptResponseMessage as string)?.error_message : null,
      },
    });

    // Evaluate rules for billing events
    const { data: subCtx } = await admin.from("subscriptions").select("*")
      .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).single();
    const { data: custCtx } = sub.customer_id
      ? await admin.from("customers").select("*").eq("id", sub.customer_id).single()
      : { data: null };
    await evaluateRules(workspaceId, eventType, {
      subscription: subCtx || undefined,
      customer: custCtx || undefined,
    });
  }

  // ── Dunning triggers ──
  if (eventType === "subscription.billing-failure") {
    // Parse error from billing attempt response
    let errorCode: string | null = null;
    let errorMsg: string | null = null;
    if (data.billingAttemptResponseMessage) {
      try {
        const parsed = JSON.parse(data.billingAttemptResponseMessage as string);
        errorCode = parsed?.error_code || null;
        errorMsg = parsed?.error_message || null;
      } catch { /* ignore parse errors */ }
    }

    // Fetch shopify_customer_id for card rotation lookup
    const { data: subForDunning } = await admin.from("subscriptions").select("shopify_customer_id")
      .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).single();

    // Check if dunning is enabled
    const { data: wsSettings } = await admin.from("workspaces").select("dunning_enabled").eq("id", workspaceId).single();
    if (wsSettings?.dunning_enabled) {
      // Guard: if a successful order exists within the current billing cycle,
      // this is a false billing-failure from Appstle — do NOT trigger dunning.
      const { data: subBilling } = await admin.from("subscriptions")
        .select("id, billing_interval, billing_interval_count")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();

      let skipDunning = false;
      if (subBilling) {
        const interval = subBilling.billing_interval || "month";
        const count = subBilling.billing_interval_count || 1;
        let cycleDays = 28;
        if (interval === "week") cycleDays = 7 * count;
        else if (interval === "month") cycleDays = 28 * count;
        else if (interval === "year") cycleDays = 365 * count;
        else if (interval === "day") cycleDays = count;

        const cutoff = new Date(Date.now() - cycleDays * 24 * 60 * 60 * 1000).toISOString();

        const { data: recentOrder } = await admin.from("orders")
          .select("id, order_number, created_at")
          .eq("workspace_id", workspaceId)
          .eq("subscription_id", subBilling.id)
          .eq("financial_status", "paid")
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (recentOrder) {
          console.log(`Dunning guard: skipping for contract ${contractId} — paid order ${recentOrder.order_number} from ${recentOrder.created_at} (within ${cycleDays}-day cycle)`);
          skipDunning = true;
        }
      }

      if (!skipDunning) {
        // Atomically create cycle — unique index on (workspace_id, shopify_contract_id)
        // WHERE status IN ('active','skipped','paused') prevents duplicates.
        // If two webhooks race, only one insert succeeds; the other gets a conflict error.
        const { data: prev } = await admin
          .from("dunning_cycles")
          .select("cycle_number")
          .eq("workspace_id", workspaceId)
          .eq("shopify_contract_id", contractId)
          .in("status", ["recovered", "exhausted"])
          .order("cycle_number", { ascending: false })
          .limit(1)
          .single();

        const cycleNumber = prev ? prev.cycle_number + 1 : 1;
        const billingAttemptId = data.billingAttemptId ? String(data.billingAttemptId) : null;

        const originalBillingDate = data.billingDate ? String(data.billingDate) : new Date().toISOString();

        const { data: newCycle, error: cycleError } = await admin
          .from("dunning_cycles")
          .insert({
            workspace_id: workspaceId,
            shopify_contract_id: contractId,
            subscription_id: sub.id,
            customer_id: sub.customer_id,
            cycle_number: cycleNumber,
            status: "active",
            billing_attempt_id: billingAttemptId,
            original_billing_date: originalBillingDate,
          })
          .select("id, cycle_number")
          .single();

        if (cycleError) {
          // Unique constraint violation = another webhook already created the cycle
          console.log(`Dunning: cycle already exists for contract ${contractId}, skipping duplicate`);
        } else {
          try {
            await inngest.send({
              name: "dunning/payment-failed",
              data: {
                workspace_id: workspaceId,
                shopify_contract_id: contractId,
                subscription_id: sub.id,
                customer_id: sub.customer_id,
                shopify_customer_id: subForDunning?.shopify_customer_id || null,
                billing_attempt_id: billingAttemptId,
                error_code: errorCode,
                error_message: errorMsg,
                cycle_id: newCycle.id,
              },
            });
          } catch (err) {
            console.error("Failed to send dunning event:", err);
          }
        }
      }
    }
  }

  if (eventType === "subscription.billing-success") {
    try {
      await inngest.send({
        name: "dunning/billing-success",
        data: {
          workspace_id: workspaceId,
          shopify_contract_id: contractId,
          customer_id: sub.customer_id,
        },
      });
    } catch (err) {
      console.error("Failed to send billing-success event:", err);
    }
  }
}
