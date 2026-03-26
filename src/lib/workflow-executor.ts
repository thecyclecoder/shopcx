import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { sendTicketReply } from "@/lib/email";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type Admin = ReturnType<typeof createAdminClient>;

interface WorkflowContext {
  workspaceId: string;
  ticketId: string;
  ticket: Record<string, unknown>;
  customer: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  fulfillment: {
    status: string | null;
    date: string | null;
    carrier: string | null;
    tracking_number: string | null;
    url: string | null;
    days_since: number;
    shopify_status: string | null;
    delivered_at: string | null;
    estimated_delivery: string | null;
    in_transit_at: string | null;
    latest_location: string | null;
  } | null;
  subscription: Record<string, unknown> | null;
}

// ── Main entry point ──

export async function executeWorkflow(
  workspaceId: string,
  ticketId: string,
  triggerTag: string,
): Promise<void> {
  const admin = createAdminClient();

  // Find enabled workflow for this tag
  const { data: workflow } = await admin
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("trigger_tag", triggerTag)
    .eq("enabled", true)
    .single();

  if (!workflow) return;

  // Build context
  const context = await buildContext(admin, workspaceId, ticketId);

  try {
    switch (workflow.template) {
      case "order_tracking":
        await executeOrderTracking(admin, workflow.config as Record<string, unknown>, context);
        break;
      case "cancel_request":
        await executeCancelRequest(admin, workflow.config as Record<string, unknown>, context);
        break;
      case "subscription_inquiry":
        await executeSubscriptionInquiry(admin, workflow.config as Record<string, unknown>, context);
        break;
    }
  } catch (err) {
    console.error(`Workflow "${workflow.name}" error:`, err);
    // Add internal note about the failure
    await addNote(admin, context, `Workflow "${workflow.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Context builder ──

async function buildContext(admin: Admin, workspaceId: string, ticketId: string): Promise<WorkflowContext> {
  const { data: ticket } = await admin.from("tickets").select("*").eq("id", ticketId).single();

  let customer: Record<string, unknown> | null = null;
  let order: Record<string, unknown> | null = null;
  let subscription: Record<string, unknown> | null = null;

  if (ticket?.customer_id) {
    const { data: c } = await admin.from("customers").select("*").eq("id", ticket.customer_id).single();
    customer = c;

    // Most recent order
    const { data: o } = await admin.from("orders").select("*")
      .eq("customer_id", ticket.customer_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    order = o;

    // Active subscription
    const { data: s } = await admin.from("subscriptions").select("*")
      .eq("customer_id", ticket.customer_id)
      .eq("status", "active")
      .limit(1)
      .single();
    subscription = s;
  }

  // Parse fulfillment from order
  let fulfillment: WorkflowContext["fulfillment"] = null;
  if (order) {
    const fulfillments = (order.fulfillments as { trackingInfo?: { number: string; url: string | null; company: string | null }[]; status?: string; createdAt?: string }[]) || [];
    const f = fulfillments[0];
    if (f) {
      const tracking = f.trackingInfo?.[0];
      const createdAt = f.createdAt ? new Date(f.createdAt) : null;
      const daysSince = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)) : 0;

      fulfillment = {
        status: (order.fulfillment_status as string) || null,
        date: createdAt ? createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null,
        carrier: tracking?.company || null,
        tracking_number: tracking?.number || null,
        url: tracking?.url || null,
        days_since: daysSince,
        shopify_status: null,
        delivered_at: null,
        estimated_delivery: null,
        in_transit_at: null,
        latest_location: null,
      };

      // Try to get real-time Shopify fulfillment status with carrier events
      if (order.shopify_order_id) {
        try {
          const shopifyData = await getShopifyFulfillmentStatus(workspaceId, order.shopify_order_id as string);
          if (shopifyData) {
            fulfillment.shopify_status = shopifyData.status;
            fulfillment.delivered_at = shopifyData.deliveredAt;
            fulfillment.estimated_delivery = shopifyData.estimatedDeliveryAt;
            fulfillment.in_transit_at = shopifyData.inTransitAt;
            if (shopifyData.latestEvent) {
              const loc = [shopifyData.latestEvent.city, shopifyData.latestEvent.province].filter(Boolean).join(", ");
              fulfillment.latest_location = loc || null;
            }
            // Use Shopify's tracking data if we don't have it locally
            if (!fulfillment.carrier && shopifyData.carrier) fulfillment.carrier = shopifyData.carrier;
            if (!fulfillment.tracking_number && shopifyData.trackingNumber) fulfillment.tracking_number = shopifyData.trackingNumber;
            if (!fulfillment.url && shopifyData.trackingUrl) fulfillment.url = shopifyData.trackingUrl;
          }
        } catch {
          // Non-critical — continue with DB data
        }
      }
    }
  }

  return {
    workspaceId,
    ticketId,
    ticket: ticket || {},
    customer,
    order,
    fulfillment,
    subscription,
  };
}

// ── Shopify fulfillment status lookup ──

interface ShopifyFulfillmentData {
  status: string;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  inTransitAt: string | null;
  latestEvent: { status: string; city: string; province: string } | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

async function getShopifyFulfillmentStatus(workspaceId: string, shopifyOrderId: string): Promise<ShopifyFulfillmentData | null> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const gid = `gid://shopify/Order/${shopifyOrderId}`;
    const query = `{
      order(id: "${gid}") {
        displayFulfillmentStatus
        fulfillments(first: 1) {
          status
          createdAt
          deliveredAt
          estimatedDeliveryAt
          inTransitAt
          displayStatus
          trackingInfo { number url company }
          events(first: 5, sortKey: HAPPENED_AT, reverse: true) {
            edges { node { status happenedAt city province country } }
          }
        }
      }
    }`;

    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) return null;
    const json = await res.json();
    const order = json.data?.order;
    if (!order) return null;

    const f = order.fulfillments?.[0];
    if (!f) return null;

    const latestEvent = f.events?.edges?.[0]?.node || null;
    const tracking = f.trackingInfo?.[0];
    const displayStatus = f.displayStatus || f.status;

    return {
      status: f.deliveredAt ? "DELIVERED" : latestEvent?.status || displayStatus || order.displayFulfillmentStatus || "UNKNOWN",
      deliveredAt: f.deliveredAt || null,
      estimatedDeliveryAt: f.estimatedDeliveryAt || null,
      inTransitAt: f.inTransitAt || null,
      latestEvent: latestEvent ? { status: latestEvent.status, city: latestEvent.city || "", province: latestEvent.province || "" } : null,
      carrier: tracking?.company || null,
      trackingNumber: tracking?.number || null,
      trackingUrl: tracking?.url || null,
    };
  } catch {
    return null;
  }
}

// ── Template variables ──

function resolveTemplate(template: string, context: WorkflowContext): string {
  const vars: Record<string, string> = {
    "customer.first_name": (context.customer?.first_name as string) || "there",
    "customer.email": (context.customer?.email as string) || "",
    "order.order_number": (context.order?.order_number as string) || "",
    "order.total": context.order?.total_cents ? `$${((context.order.total_cents as number) / 100).toFixed(2)}` : "",
    "order.created_at": context.order?.created_at ? new Date(context.order.created_at as string).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "fulfillment.date": context.fulfillment?.date || "",
    "fulfillment.carrier": context.fulfillment?.carrier || "the carrier",
    "fulfillment.tracking_number": context.fulfillment?.tracking_number || "",
    "fulfillment.url": context.fulfillment?.url || "",
    "fulfillment.status": context.fulfillment?.shopify_status || context.fulfillment?.status || "",
    "fulfillment.delivered_at": context.fulfillment?.delivered_at ? new Date(context.fulfillment.delivered_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "fulfillment.estimated_delivery": context.fulfillment?.estimated_delivery ? new Date(context.fulfillment.estimated_delivery).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "fulfillment.latest_location": context.fulfillment?.latest_location || "",
    "fulfillment.days_since": context.fulfillment ? String(context.fulfillment.days_since) : "",
    "subscription.next_billing_date": context.subscription?.next_billing_date ? new Date(context.subscription.next_billing_date as string).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "",
    "subscription.status": (context.subscription?.status as string) || "",
    "subscription.items": ((context.subscription?.items as { title: string }[]) || []).map(i => i.title).filter(Boolean).join(", ") || "",
  };

  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key: string) => vars[key] || "");
}

// ── Actions ──

async function sendReply(admin: Admin, context: WorkflowContext, templateText: string, statusOverride?: string): Promise<void> {
  const body = resolveTemplate(templateText, context);

  const { error: msgError } = await admin.from("ticket_messages").insert({
    ticket_id: context.ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body,
  });
  if (msgError) console.error("Workflow message insert error:", msgError.message);

  // Send email
  const customerEmail = context.customer?.email as string | undefined;
  if (customerEmail) {
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", context.workspaceId).single();
    await sendTicketReply({
      workspaceId: context.workspaceId,
      toEmail: customerEmail,
      subject: (context.ticket.subject as string) || "Support",
      body,
      inReplyTo: (context.ticket.email_message_id as string) || null,
      agentName: "Support",
      workspaceName: ws?.name || "Support",
    });
  }

  // Update ticket status (configurable — defaults to pending)
  const statusAfterReply = (statusOverride as string) || "pending";
  const statusUpdates: Record<string, unknown> = { status: statusAfterReply, updated_at: new Date().toISOString() };
  if (statusAfterReply === "closed") statusUpdates.resolved_at = new Date().toISOString();
  await admin.from("tickets").update(statusUpdates).eq("id", context.ticketId);
}

async function escalate(admin: Admin, context: WorkflowContext, tag: string, assignTo: string | null, reason?: string): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Set escalation (separate from assignment)
  if (assignTo) {
    updates.escalated_to = assignTo;
    updates.escalated_at = new Date().toISOString();
    updates.escalation_reason = reason || `Workflow escalation: ${tag}`;
  }

  // Add escalation tag
  const { data: ticket } = await admin.from("tickets").select("tags").eq("id", context.ticketId).single();
  const tags = [...((ticket?.tags as string[]) || []), tag];
  updates.tags = [...new Set(tags)];

  await admin.from("tickets").update(updates).eq("id", context.ticketId);
}

async function addNote(admin: Admin, context: WorkflowContext, body: string): Promise<void> {
  await admin.from("ticket_messages").insert({
    ticket_id: context.ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body,
  });
}

// ── Template Executors ──

async function executeOrderTracking(admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext): Promise<void> {
  const threshold = (config.delay_threshold_days as number) || 10;

  if (!ctx.order) {
    await sendReply(admin, ctx, (config.reply_no_order as string) || "Hi {{customer.first_name}}, we couldn't find a recent order on your account. Could you provide your order number so we can look into this?", config.reply_no_order_status as string);
    return;
  }

  const fulfillmentStatus = ctx.order.fulfillment_status as string | null;

  // Unfulfilled
  if (!fulfillmentStatus || fulfillmentStatus === "UNFULFILLED" || fulfillmentStatus === "null") {
    await sendReply(admin, ctx, (config.reply_preparing as string) || "Hi {{customer.first_name}}, your order {{order.order_number}} is being prepared and should ship within 2-3 business days.", config.reply_preparing_status as string);
    return;
  }

  // Fulfilled but no tracking
  if (!ctx.fulfillment?.tracking_number) {
    await sendReply(admin, ctx, (config.reply_no_tracking as string) || "Your order {{order.order_number}} has shipped! Tracking details should be available within 24 hours.", config.reply_no_tracking_status as string);
    return;
  }

  // Check Shopify fulfillment status
  const status = (ctx.fulfillment.shopify_status || "").toUpperCase();

  if (status === "DELIVERED") {
    await sendReply(admin, ctx, (config.reply_delivered as string) || "Our records show your order {{order.order_number}} was delivered on {{fulfillment.delivered_at}}. If you haven't received it, please reply and we'll investigate.", config.reply_delivered_status as string);
    return;
  }

  // In transit — check delay
  if (ctx.fulfillment.days_since >= threshold) {
    if (config.escalate_delayed !== false) {
      await escalate(admin, ctx, (config.escalate_tag as string) || "delayed-shipment", (config.escalate_assign_to as string) || null);
      const location = ctx.fulfillment.latest_location ? ` Last seen: ${ctx.fulfillment.latest_location}.` : "";
      await addNote(admin, ctx, `Workflow escalated: order ${ctx.order.order_number} shipped ${ctx.fulfillment.days_since} days ago (threshold: ${threshold} days). Status: ${status}. Carrier: ${ctx.fulfillment.carrier}. Tracking: ${ctx.fulfillment.tracking_number}.${location}`);
    }
    return;
  }

  // Out for delivery
  if (status === "OUT_FOR_DELIVERY") {
    await sendReply(admin, ctx, (config.reply_out_for_delivery as string) || "Great news! Your order {{order.order_number}} is out for delivery in {{fulfillment.latest_location}}. It should arrive today!", config.reply_out_for_delivery_status as string);
    return;
  }

  // In transit, within threshold
  const locationInfo = ctx.fulfillment.latest_location ? ` It was last seen in {{fulfillment.latest_location}}.` : "";
  const estimateInfo = ctx.fulfillment.estimated_delivery ? ` Estimated delivery: {{fulfillment.estimated_delivery}}.` : "";
  await sendReply(admin, ctx, (config.reply_in_transit as string) || `Your order {{order.order_number}} shipped on {{fulfillment.date}} via {{fulfillment.carrier}}.${locationInfo}${estimateInfo} Track it here: {{fulfillment.url}}`, config.reply_in_transit_status as string);
}

async function executeCancelRequest(admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext): Promise<void> {
  if (!ctx.subscription) {
    await sendReply(admin, ctx, (config.reply_no_subscription as string) || "Hi {{customer.first_name}}, we couldn't find an active subscription on your account. Can you provide more details so we can help?", config.reply_no_subscription_status as string);
    return;
  }

  if (config.auto_cancel_via_appstle && ctx.subscription.shopify_contract_id) {
    try {
      const { appstleSubscriptionAction } = await import("@/lib/appstle");
      await appstleSubscriptionAction(ctx.workspaceId, ctx.subscription.shopify_contract_id as string, "cancel");
      await sendReply(admin, ctx, (config.reply_cancelled as string) || "Hi {{customer.first_name}}, your subscription has been cancelled as requested. If you change your mind, just let us know!", config.reply_cancelled_status as string);
      return;
    } catch {
      // Fall through to escalation
    }
  }

  await sendReply(admin, ctx, (config.reply_confirm_cancel as string) || "We've received your cancellation request for your subscription. Our team will process this shortly.", config.reply_confirm_cancel_status as string);

  if (config.escalate_to_agent !== false) {
    await escalate(admin, ctx, (config.escalate_tag as string) || "cancel-request", (config.escalate_assign_to as string) || null);
  }
}

async function executeSubscriptionInquiry(admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext): Promise<void> {
  if (!ctx.subscription) {
    await sendReply(admin, ctx, (config.reply_no_subscription as string) || "Hi {{customer.first_name}}, we couldn't find an active subscription for your account. Can you provide more details?", config.reply_no_subscription_status as string);
    return;
  }

  await sendReply(admin, ctx, (config.reply_next_date as string) || "Hi {{customer.first_name}}, your next shipment is scheduled for {{subscription.next_billing_date}}. Your subscription includes: {{subscription.items}}.", config.reply_next_date_status as string);
}
