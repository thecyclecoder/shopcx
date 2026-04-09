import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { sendTicketReply } from "@/lib/email";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type Admin = ReturnType<typeof createAdminClient>;

export interface WorkflowContext {
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
    shipping_address: string | null;
    // EasyPost enhanced tracking (only populated when Shopify data insufficient)
    easypost_status: string | null; // pre_transit, in_transit, out_for_delivery, delivered, return_to_sender, failure, unknown
    easypost_detail: string | null; // last event message e.g. "Refused", "Delivered to Front Door"
    easypost_location: string | null; // city, state of last event
  } | null;
  subscription: Record<string, unknown> | null;
  workflowSandbox?: boolean;
}

// ── Main entry point ──

export interface ExecuteWorkflowOptions {
  /** Override subscription ID for subscription_inquiry workflows */
  subscriptionId?: string;
}

export async function executeWorkflow(
  workspaceId: string,
  ticketId: string,
  triggerTag: string,
  options?: ExecuteWorkflowOptions,
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

  const workflowSandbox: boolean | undefined = workflow.sandbox_mode ?? undefined;

  // Build context
  const context = await buildContext(admin, workspaceId, ticketId);
  context.workflowSandbox = workflowSandbox;

  try {
    switch (workflow.template) {
      case "order_tracking":
        await executeOrderTracking(admin, workflow.config as Record<string, unknown>, context);
        break;
      case "cancel_request":
        await executeCancelRequest(admin, workflow.config as Record<string, unknown>, context);
        break;
      case "subscription_inquiry":
        await executeSubscriptionInquiry(admin, workflow.config as Record<string, unknown>, context, options?.subscriptionId);
        break;
      case "account_login":
        await executeAccountLogin(admin, workflow.config as Record<string, unknown>, context);
        break;
    }
    // Mark ticket as handled by workflow
    await admin.from("tickets").update({ handled_by: `Workflow: ${workflow.name}` }).eq("id", ticketId);
  } catch (err) {
    console.error(`Workflow "${workflow.name}" error:`, err);
    // Add internal note about the failure
    await addNote(admin, context, `Workflow "${workflow.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Context builder ──

export async function buildContext(admin: Admin, workspaceId: string, ticketId: string): Promise<WorkflowContext> {
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
        shipping_address: null,
        easypost_status: null,
        easypost_detail: null,
        easypost_location: null,
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
            if (shopifyData.shippingAddress) fulfillment.shipping_address = shopifyData.shippingAddress;
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
  shippingAddress: string | null;
}

async function getShopifyFulfillmentStatus(workspaceId: string, shopifyOrderId: string): Promise<ShopifyFulfillmentData | null> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const gid = `gid://shopify/Order/${shopifyOrderId}`;
    const query = `{
      order(id: "${gid}") {
        displayFulfillmentStatus
        shippingAddress { address1 address2 city provinceCode zip country }
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

    // Build shipping address from order
    const sa = order.shippingAddress;
    const shippingAddr = sa
      ? [sa.address1, sa.address2, sa.city, sa.provinceCode, sa.zip].filter(Boolean).join(", ")
      : null;

    return {
      status: f.deliveredAt ? "DELIVERED" : latestEvent?.status || displayStatus || order.displayFulfillmentStatus || "UNKNOWN",
      deliveredAt: f.deliveredAt || null,
      estimatedDeliveryAt: f.estimatedDeliveryAt || null,
      inTransitAt: f.inTransitAt || null,
      latestEvent: latestEvent ? { status: latestEvent.status, city: latestEvent.city || "", province: latestEvent.province || "" } : null,
      carrier: tracking?.company || null,
      trackingNumber: tracking?.number || null,
      trackingUrl: tracking?.url || null,
      shippingAddress: shippingAddr,
    };
  } catch {
    return null;
  }
}

// ── Template variables ──

export function resolveTemplate(template: string, context: WorkflowContext): string {
  // Delivery address from Shopify order's shipping address
  const deliveryAddress = context.fulfillment?.shipping_address || "";
  const addr = context.customer?.default_address as { city?: string; province?: string; provinceCode?: string } | null;
  const deliveryCity = addr?.city || "";
  const deliveryState = addr?.provinceCode || addr?.province || "";

  // Order line items summary
  const lineItems = ((context.order?.line_items as { title: string; quantity: number }[]) || [])
    .map(li => `${li.quantity}x ${li.title}`).join(", ");

  const vars: Record<string, string> = {
    // Customer
    "customer.first_name": (context.customer?.first_name as string) || "there",
    "customer.last_name": (context.customer?.last_name as string) || "",
    "customer.email": (context.customer?.email as string) || "",
    "customer.phone": (context.customer?.phone as string) || "",
    "customer.delivery_address": deliveryAddress,
    "customer.city": deliveryCity,
    "customer.state": deliveryState,
    // Order
    "order.order_number": (context.order?.order_number as string) || "",
    "order.total": context.order?.total_cents ? `$${((context.order.total_cents as number) / 100).toFixed(2)}` : "",
    "order.created_at": context.order?.created_at ? new Date(context.order.created_at as string).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "order.line_items": lineItems,
    // Fulfillment
    "fulfillment.date": context.fulfillment?.date || "",
    "fulfillment.carrier": context.fulfillment?.carrier || "the carrier",
    "fulfillment.tracking_number": context.fulfillment?.tracking_number || "",
    "fulfillment.url": context.fulfillment?.url || "",
    "fulfillment.status": context.fulfillment?.shopify_status || context.fulfillment?.status || "",
    "fulfillment.delivered_at": context.fulfillment?.delivered_at ? new Date(context.fulfillment.delivered_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "fulfillment.estimated_delivery": context.fulfillment?.estimated_delivery ? new Date(context.fulfillment.estimated_delivery).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
    "fulfillment.latest_location": context.fulfillment?.latest_location || "",
    "fulfillment.days_since": context.fulfillment ? String(context.fulfillment.days_since) : "",
    "fulfillment.delivery_address": deliveryAddress,
    "fulfillment.easypost_status": context.fulfillment?.easypost_status || "",
    "fulfillment.easypost_detail": context.fulfillment?.easypost_detail || "",
    "fulfillment.easypost_location": context.fulfillment?.easypost_location || "",
    // Subscription
    "subscription.next_billing_date": context.subscription?.next_billing_date ? new Date(context.subscription.next_billing_date as string).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "",
    "subscription.status": (context.subscription?.status as string) || "",
    "subscription.items": ((context.subscription?.items as { title: string }[]) || []).map(i => i.title).filter(Boolean).join(", ") || "",
    "subscription.billing_interval": context.subscription?.billing_interval_count ? `${context.subscription.billing_interval_count} ${context.subscription.billing_interval || ""}` : "",
  };

  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key: string) => vars[key] || "");
}

// ── Actions ──

async function sendReply(admin: Admin, context: WorkflowContext, templateText: string, statusOverride?: string): Promise<void> {
  const body = resolveTemplate(templateText, context);
  const channel = (context.ticket.channel as string) || "email";

  // Check sandbox — per-workflow setting takes priority, falls back to global
  const { data: ws } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", context.workspaceId).single();
  const isSandbox = context.workflowSandbox ?? ws?.sandbox_mode ?? true;

  if (isSandbox) {
    // Sandbox: internal note only, not visible to customer on any channel, don't close
    await admin.from("ticket_messages").insert({
      ticket_id: context.ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Workflow Draft — Sandbox Mode]\n\n${body}`,
    });

    // Clear auto-reply but don't change status
    await admin.from("tickets").update({ auto_reply_at: null, pending_auto_reply: null, updated_at: new Date().toISOString() }).eq("id", context.ticketId);
    return;
  }

  // Live mode: create external message
  const { error: msgError } = await admin.from("ticket_messages").insert({
    ticket_id: context.ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body,
  });
  if (msgError) console.error("Workflow message insert error:", msgError.message);

  // Send email — only on email channel
  const customerEmail = context.customer?.email as string | undefined;
  if (channel === "email" && customerEmail) {
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
  // Chat/help_center/sms/social — message is already inserted as external, visible in widget

  // Update ticket status — use the workflow's own status config per step
  const statusAfterReply = (statusOverride as string) || "closed";
  const statusUpdates: Record<string, unknown> = { status: statusAfterReply, auto_reply_at: null, pending_auto_reply: null, updated_at: new Date().toISOString() };
  if (statusAfterReply === "closed") {
    statusUpdates.resolved_at = new Date().toISOString();
    statusUpdates.closed_at = new Date().toISOString();
  }
  await admin.from("tickets").update(statusUpdates).eq("id", context.ticketId);

  // Mark first touch
  const { markFirstTouch } = await import("@/lib/first-touch");
  await markFirstTouch(context.ticketId, "workflow");
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
  const easypostThreshold = (config.easypost_lookup_days as number) || 7;

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

  // ── Tier 1: Shopify data ──
  const shopifyStatus = (ctx.fulfillment.shopify_status || "").toUpperCase();

  // Shopify says delivered AND customer isn't asking "where's my order" — trust it
  // (If this workflow fired, customer IS asking — so we may need to verify with EasyPost)
  const customerIsAsking = true; // This workflow only fires when customer asks about tracking

  // ── Tier 2: EasyPost lookup when Shopify data is insufficient ──
  // Conditions: (a) in transit >= X days, OR (b) Shopify says delivered but customer is asking
  const needsEasyPost = ctx.fulfillment.tracking_number && (
    (shopifyStatus !== "DELIVERED" && ctx.fulfillment.days_since >= easypostThreshold) ||
    (shopifyStatus === "DELIVERED" && customerIsAsking)
  );

  if (needsEasyPost) {
    try {
      const { lookupTracking } = await import("@/lib/easypost");
      const tracking = await lookupTracking(
        ctx.workspaceId,
        ctx.fulfillment.tracking_number,
        ctx.fulfillment.carrier || undefined,
      );
      ctx.fulfillment.easypost_status = tracking.status;
      // For return_to_sender, grab the first event with that status (the reason: "Refused", "Unclaimed", etc.)
      // For other statuses, grab the last event (most recent update)
      const reasonEvent = tracking.status === "return_to_sender"
        ? tracking.events.find(e => e.status === "return_to_sender")
        : null;
      const lastEvent = tracking.events[tracking.events.length - 1];
      const detailEvent = reasonEvent || lastEvent;
      if (detailEvent) {
        ctx.fulfillment.easypost_detail = detailEvent.message;
        ctx.fulfillment.easypost_location = [detailEvent.city, detailEvent.state].filter(Boolean).join(", ");
      }

      // Sync EasyPost data back to order + post note on Shopify order
      if (ctx.order?.id) {
        const { syncEasyPostToOrder } = await import("@/lib/easypost-order-sync");
        await syncEasyPostToOrder({
          workspaceId: ctx.workspaceId,
          orderId: ctx.order.id as string,
          shopifyOrderId: ctx.order.shopify_order_id as string | null,
          trackingResult: tracking,
        });
      }

      // Add internal note with EasyPost findings
      await addNote(admin, ctx, `EasyPost tracking lookup: status "${tracking.status}"${lastEvent ? ` — "${lastEvent.message}" at ${ctx.fulfillment.easypost_location || "unknown location"}` : ""}. Carrier: ${ctx.fulfillment.carrier}. Tracking: ${ctx.fulfillment.tracking_number}.`);
    } catch (err) {
      // EasyPost lookup failed (no funds, config issue) — fall back to Shopify data
      console.error("[workflow] EasyPost lookup failed, falling back to Shopify:", err);
    }
  }

  // ── Route based on best available status ──
  const effectiveStatus = ctx.fulfillment.easypost_status || shopifyStatus.toLowerCase();

  // Return to sender — split on reason
  if (effectiveStatus === "return_to_sender") {
    const reason = (ctx.fulfillment.easypost_detail || "").toLowerCase();
    const isRefused = reason.includes("refused");

    if (isRefused) {
      // ── Refused: cancel linked subscription + notify customer ──
      let cancelledSub = false;
      if (ctx.order.subscription_id) {
        try {
          const { data: sub } = await admin
            .from("subscriptions")
            .select("shopify_contract_id, status")
            .eq("id", ctx.order.subscription_id as string)
            .single();

          if (sub && sub.status === "active" && sub.shopify_contract_id) {
            const { appstleSubscriptionAction } = await import("@/lib/appstle");
            const result = await appstleSubscriptionAction(
              ctx.workspaceId,
              sub.shopify_contract_id,
              "cancel",
              "Shipment Refused - Auto Cancel",
              "Tracking Workflow",
            );
            cancelledSub = result.success;
            await addNote(admin, ctx, `Subscription ${sub.shopify_contract_id} ${cancelledSub ? "cancelled" : "cancel failed"} — order was refused at delivery.`);
          }
        } catch (err) {
          console.error("[workflow] Failed to cancel subscription for refused order:", err);
        }
      }

      // Update order status + tag in Shopify
      await admin.from("orders").update({
        delivery_status: "returned",
        sync_resolved_at: new Date().toISOString(),
        sync_resolved_note: "Refused",
      }).eq("id", ctx.order.id);

      if (ctx.order.shopify_order_id) {
        const { addOrderTags } = await import("@/lib/shopify-order-tags");
        await addOrderTags(ctx.workspaceId, ctx.order.shopify_order_id as string, ["delivery:refused"]);
      }

      const replyText = cancelledSub
        ? "We see from the tracking that your order {{order.order_number}} was refused at delivery. We have cancelled your active subscription — no future orders will be shipped."
        : "We see from the tracking that your order {{order.order_number}} was refused at delivery.";
      await sendReply(admin, ctx, (config.reply_refused as string) || replyText, config.reply_refused_status as string || "closed");
      return;
    }

    // ── Other return-to-sender (wrong address, unclaimed, etc.) → order replacement playbook ──
    const detail = ctx.fulfillment.easypost_detail || "undeliverable";
    await addNote(admin, ctx, `Order ${ctx.order.order_number} returned to sender: "${detail}" at ${ctx.fulfillment.easypost_location || "unknown"}. Starting order replacement flow.`);

    // Update order status + tag in Shopify
    const tagSlug = detail.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    await admin.from("orders").update({
      delivery_status: "returned",
      sync_resolved_at: new Date().toISOString(),
      sync_resolved_note: detail,
    }).eq("id", ctx.order.id);

    if (ctx.order.shopify_order_id) {
      const { addOrderTags } = await import("@/lib/shopify-order-tags");
      await addOrderTags(ctx.workspaceId, ctx.order.shopify_order_id as string, [`delivery:${tagSlug}`]);
    }

    // Tag ticket for playbook pickup
    const { addTicketTag } = await import("@/lib/ticket-tags");
    await addTicketTag(ctx.ticketId, "return-to-sender");
    await addTicketTag(ctx.ticketId, `rts:${tagSlug}`);

    // Assign replacement playbook if available
    const { data: replacementPlaybook } = await admin.from("playbooks")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("name", "Replacement Order")
      .eq("is_active", true)
      .limit(1).single();

    const playbookUpdates: Record<string, unknown> = {
      status: "open",
      updated_at: new Date().toISOString(),
    };

    if (replacementPlaybook) {
      playbookUpdates.active_playbook_id = replacementPlaybook.id;
      playbookUpdates.playbook_step = 0;
      playbookUpdates.playbook_context = {
        easypost_status: ctx.fulfillment?.easypost_status,
        easypost_detail: detail,
        easypost_location: ctx.fulfillment?.easypost_location,
        replacement_reason: "delivery_error",
        customer_error: tagSlug.includes("address"),
        identified_order_id: ctx.order?.id,
        identified_order: ctx.order?.order_number,
        tracking_number: ctx.fulfillment?.tracking_number,
        carrier: ctx.fulfillment?.carrier,
      };
      playbookUpdates.handled_by = "Playbook: Replacement Order";
    }

    await admin.from("tickets").update(playbookUpdates).eq("id", ctx.ticketId);

    await sendReply(admin, ctx, (config.reply_return_to_sender as string) || "It looks like there was a delivery issue with your order {{order.order_number}} — the carrier was unable to complete delivery. We're going to get a replacement out to you. Let us confirm a few details.", config.reply_return_to_sender_status as string || "open");
    return;
  }

  // Failure — carrier reported issue
  if (effectiveStatus === "failure" || effectiveStatus === "error") {
    const detail = ctx.fulfillment.easypost_detail ? ` (${ctx.fulfillment.easypost_detail})` : "";
    await escalate(
      admin, ctx,
      "delivery-failure",
      (config.escalate_to as string) || null,
      `Order ${ctx.order.order_number} has a delivery failure${detail}. Carrier: ${ctx.fulfillment.carrier}. Tracking: ${ctx.fulfillment.tracking_number}.`,
    );
    await sendReply(admin, ctx, (config.reply_delivery_failure as string) || "We've identified an issue with the delivery of your order {{order.order_number}} and our team is looking into it. We'll follow up with you shortly.", config.reply_delivery_failure_status as string || "open");
    return;
  }

  // Delivered (confirmed by EasyPost or Shopify)
  if (effectiveStatus === "delivered" || shopifyStatus === "DELIVERED") {
    await sendReply(admin, ctx, (config.reply_delivered as string) || "Our records show your order {{order.order_number}} was delivered on {{fulfillment.delivered_at}}. If you haven't received it, please reply and we'll investigate.", config.reply_delivered_status as string);
    return;
  }

  // In transit — check delay → escalate
  if (ctx.fulfillment.days_since >= threshold) {
    if (config.escalate_delayed !== false) {
      const escalateReply = config.reply_escalated as string;
      if (escalateReply) {
        await sendReply(admin, ctx, escalateReply, config.reply_escalated_status as string);
      }

      const locationInfo = ctx.fulfillment.easypost_location || ctx.fulfillment.latest_location || "";
      await escalate(
        admin, ctx,
        (config.escalate_tag as string) || "delayed-shipment",
        (config.escalate_to as string) || null,
        `Order ${ctx.order.order_number} shipped ${ctx.fulfillment.days_since} days ago (threshold: ${threshold}).${locationInfo ? ` Last seen: ${locationInfo}.` : ""} Carrier: ${ctx.fulfillment.carrier}. Tracking: ${ctx.fulfillment.tracking_number}.`,
      );

      await addNote(admin, ctx, `Workflow escalated: order ${ctx.order.order_number} shipped ${ctx.fulfillment.days_since} days ago. Status: ${effectiveStatus}.${locationInfo ? ` Last seen: ${locationInfo}.` : ""} Carrier: ${ctx.fulfillment.carrier}. Tracking: ${ctx.fulfillment.tracking_number}.`);

      if (!escalateReply) {
        const escalateStatus = (config.escalate_status as string) || "open";
        const statusUpdates: Record<string, unknown> = { status: escalateStatus, updated_at: new Date().toISOString() };
        if (escalateStatus === "closed") statusUpdates.resolved_at = new Date().toISOString();
        await admin.from("tickets").update(statusUpdates).eq("id", ctx.ticketId);
      }
    }
    return;
  }

  // Out for delivery
  if (effectiveStatus === "out_for_delivery" || shopifyStatus === "OUT_FOR_DELIVERY") {
    const loc = ctx.fulfillment.easypost_location || ctx.fulfillment.latest_location;
    const locStr = loc ? ` in ${loc}` : "";
    await sendReply(admin, ctx, (config.reply_out_for_delivery as string) || `Great news! Your order {{order.order_number}} is out for delivery${locStr}. It should arrive today!`, config.reply_out_for_delivery_status as string);
    return;
  }

  // In transit, within threshold
  const locationInfo = (ctx.fulfillment.easypost_location || ctx.fulfillment.latest_location)
    ? ` It was last seen in ${ctx.fulfillment.easypost_location || ctx.fulfillment.latest_location}.`
    : "";
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

async function executeSubscriptionInquiry(admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext, subscriptionIdOverride?: string): Promise<void> {
  const customerId = ctx.customer?.id as string | undefined;
  if (!customerId) {
    await sendReply(admin, ctx, "I'd be happy to help with your subscription! Could you share the email on your account?", "open");
    return;
  }

  // Get ALL subscriptions across linked accounts
  const linkedIds = [customerId];
  const { data: lnk } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (lnk) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", lnk.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const { data: allSubs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, next_billing_date, billing_interval, billing_interval_count, shipping_address, applied_discounts, delivery_price_cents")
    .eq("workspace_id", ctx.workspaceId)
    .in("customer_id", linkedIds)
    .order("created_at", { ascending: false });

  // If a specific subscription was selected, use it directly (skip multi-subscription logic)
  if (subscriptionIdOverride) {
    const overrideSub = (allSubs || []).find(s => s.id === subscriptionIdOverride);
    if (overrideSub) {
      // Jump straight to single-subscription details with the selected sub
      return executeSubscriptionInquirySingle(admin, config, ctx, overrideSub);
    }
    // Subscription not found among linked accounts — fall through to normal logic
  }

  const active = (allSubs || []).filter(s => s.status === "active");
  const paused = (allSubs || []).filter(s => s.status === "paused");
  const cancelled = (allSubs || []).filter(s => s.status === "cancelled");

  // ── No active subscriptions ──
  if (active.length === 0) {
    const channel = (ctx.ticket?.channel as string) || "email";
    const useHtml = ["email", "chat", "help_center"].includes(channel);
    let reply = "You don't currently have any active subscriptions.";

    const showPaused = paused.slice(0, 2);
    const showCancelled = cancelled.slice(0, 2);

    if (showPaused.length > 0) {
      reply += useHtml ? "<p><b>Paused subscriptions:</b></p><ul>" : "\n\nPaused subscriptions:";
      for (const s of showPaused) {
        const items = ((s.items as { title: string; quantity: number }[]) || [])
          .filter(i => !i.title.toLowerCase().includes("shipping protection"))
          .map(i => `${i.quantity}x ${i.title}`).join(", ");
        reply += useHtml ? `<li>${items}</li>` : `\n• ${items}`;
      }
      if (useHtml) reply += "</ul>";
      reply += useHtml ? "<p>Would you like to unpause one of these?</p>" : "\n\nWould you like to unpause one of these?";
    }

    if (showCancelled.length > 0) {
      const prefix = showPaused.length > 0 ? "You also have c" : "C";
      reply += useHtml ? `<p><b>${prefix}ancelled subscriptions:</b></p><ul>` : `\n\n${prefix}ancelled subscriptions:`;
      for (const s of showCancelled) {
        const items = ((s.items as { title: string; quantity: number }[]) || [])
          .filter(i => !i.title.toLowerCase().includes("shipping protection"))
          .map(i => `${i.quantity}x ${i.title}`).join(", ");
        reply += useHtml ? `<li>${items}</li>` : `\n• ${items}`;
      }
      if (useHtml) reply += "</ul>";
      reply += useHtml ? "<p>Would you like to reactivate one of these?</p>" : "\n\nWould you like to reactivate one of these?";
    }

    await sendReply(admin, ctx, reply, "open");
    return;
  }

  // ── Multiple active → select subscription journey ──
  if (active.length > 1) {
    try {
      const { data: jd } = await admin.from("journey_definitions")
        .select("id, name").eq("workspace_id", ctx.workspaceId)
        .eq("slug", "select-subscription").eq("is_active", true).limit(1).single();
      if (jd) {
        const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
        await launchJourneyForTicket({
          workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, customerId,
          journeyId: jd.id, journeyName: jd.name,
          triggerIntent: "select_subscription", channel: (ctx.ticket?.channel as string) || "email",
          leadIn: "I see you have multiple subscriptions. Which one are you asking about?",
          ctaText: "Select Subscription",
        });
        return;
      }
    } catch { /* fall through to text list */ }

    let reply = "I see you have multiple active subscriptions. Which one are you asking about?\n";
    for (const s of active) {
      const items = ((s.items as { title: string; quantity: number }[]) || [])
        .filter(i => !i.title.toLowerCase().includes("shipping protection"))
        .map(i => `${i.quantity}x ${i.title}`).join(", ");
      reply += `\n• ${items}`;
    }
    await sendReply(admin, ctx, reply, "open");
    return;
  }

  // ── Single active subscription → full details + AI answer ──
  return executeSubscriptionInquirySingle(admin, config, ctx, active[0]);
}

/** Render full details for a single subscription (extracted for reuse with subscription_id override) */
async function executeSubscriptionInquirySingle(
  admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext,
  sub: Record<string, unknown>,
): Promise<void> {
  const rawItems = ((sub.items as { title: string; quantity: number; price_cents: number; variant_id?: string }[]) || [])
    .filter(i => !i.title.toLowerCase().includes("shipping protection"));

  // Enrich with variant titles + MSRP from products
  const { data: products } = await admin.from("products").select("title, variants").eq("workspace_id", ctx.workspaceId);
  const variantMap = new Map<string, { title: string; msrpCents: number }>();
  for (const p of products || []) {
    for (const v of (p.variants as { id: string; title: string; price_cents: number }[]) || []) {
      variantMap.set(String(v.id), {
        title: v.title && v.title !== "Default Title" ? `${p.title} — ${v.title}` : p.title,
        msrpCents: v.price_cents || 0,
      });
    }
  }

  const enrichedItems = rawItems.map(i => {
    const v = i.variant_id ? variantMap.get(i.variant_id) : null;
    return { title: v?.title || i.title, quantity: i.quantity, priceCents: i.price_cents, msrpCents: v?.msrpCents || i.price_cents };
  });

  const discounts = (sub.applied_discounts as { id: string; type: string; title: string; value: number; valueType: string }[] | null) || [];
  const addr = sub.shipping_address as { address1?: string; city?: string; provinceCode?: string; state?: string; zip?: string } | null;
  const nextDate = sub.next_billing_date ? new Date(sub.next_billing_date as string).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "not scheduled";
  const interval = `${(sub.billing_interval_count as number) || 4} ${((sub.billing_interval as string) || "week").toLowerCase()}${((sub.billing_interval_count as number) || 4) > 1 ? "s" : ""}`;

  // Categorize discounts: MANUAL/automatic = every order, CODE_DISCOUNT = one-time
  const autoDiscounts = discounts.filter(d => d.type === "MANUAL" || d.type === "AUTOMATIC");
  const codeDiscounts = discounts.filter(d => d.type === "CODE_DISCOUNT");

  // Price breakdown
  let totalMsrp = 0;
  let totalSub = 0;
  for (const item of enrichedItems) { totalMsrp += item.msrpCents * item.quantity; totalSub += item.priceCents * item.quantity; }
  const subscribeSavings = totalMsrp - totalSub;
  // Discounts stack multiplicatively — each applies to the running total, not the original
  let totalAfterDiscounts = totalSub;
  const discountBreakdown: { discount: typeof autoDiscounts[0]; savedCents: number }[] = [];
  for (const d of [...autoDiscounts, ...codeDiscounts]) {
    if (d.valueType === "PERCENTAGE") {
      const saved = Math.round(totalAfterDiscounts * d.value / 100);
      discountBreakdown.push({ discount: d, savedCents: saved });
      totalAfterDiscounts -= saved;
    }
  }
  const totalSavings = totalMsrp - totalAfterDiscounts;

  const channel = (ctx.ticket?.channel as string) || "email";
  const useHtml = ["email", "chat", "help_center"].includes(channel);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  // Build canned subscription details card
  let reply: string;

  if (useHtml) {
    reply = `<p><b>Your Subscription</b></p>`;
    reply += `<p>${enrichedItems.map(i => `${i.quantity}x ${i.title}`).join("<br>")}</p>`;
    reply += `<p>Next order: <b>${nextDate}</b> (every ${interval})</p>`;
    if (addr?.address1) {
      reply += `<p>Ships to: ${[addr.address1, addr.city, addr.provinceCode || addr.state, addr.zip].filter(Boolean).join(", ")}</p>`;
    }
    reply += `<p><b>Your Savings</b></p><p>`;
    reply += `Retail: ${fmt(totalMsrp)}<br>`;
    reply += `Subscribe &amp; Save: <b>-${fmt(subscribeSavings)}</b> (every order)<br>`;
    for (const { discount: d, savedCents } of discountBreakdown) {
      const isCode = d.type === "CODE_DISCOUNT";
      if (isCode) {
        reply += `Coupon "${d.title}" (${d.value}% off): <b>-${fmt(savedCents)}</b> (this order only)<br>`;
      } else {
        reply += `${d.title} (${d.value}% off): <b>-${fmt(savedCents)}</b> (every order)<br>`;
      }
    }
    reply += `<b>You pay: ${fmt(totalAfterDiscounts)}</b></p>`;
    if (totalSavings > 0) {
      reply += `<p>That's <b>${fmt(totalSavings)} in savings</b> on this order!</p>`;
    }
  } else {
    reply = `Your Subscription\n`;
    reply += enrichedItems.map(i => `${i.quantity}x ${i.title}`).join("\n") + "\n\n";
    reply += `Next order: ${nextDate} (every ${interval})\n`;
    if (addr?.address1) {
      reply += `Ships to: ${[addr.address1, addr.city, addr.provinceCode || addr.state, addr.zip].filter(Boolean).join(", ")}\n`;
    }
    reply += `\nYour Savings\n`;
    reply += `Retail: ${fmt(totalMsrp)}\n`;
    reply += `Subscribe & Save: -${fmt(subscribeSavings)} (every order)\n`;
    for (const { discount: d, savedCents } of discountBreakdown) {
      const isCode = d.type === "CODE_DISCOUNT";
      if (isCode) {
        reply += `Coupon "${d.title}" (${d.value}% off): -${fmt(savedCents)} (this order only)\n`;
      } else {
        reply += `${d.title} (${d.value}% off): -${fmt(savedCents)} (every order)\n`;
      }
    }
    reply += `You pay: ${fmt(totalAfterDiscounts)}\n`;
    if (totalSavings > 0) {
      reply += `\nThat's ${fmt(totalSavings)} in savings on this order!`;
    }
  }

  await addNote(admin, ctx, `[Workflow] Subscription details: ${enrichedItems.length} items, ${autoDiscounts.length} auto discounts, ${codeDiscounts.length} coupon codes, saves ${fmt(totalSavings)}`);
  await sendReply(admin, ctx, reply, config.reply_status as string || "closed");
}

// ── Account Login Workflow ──

async function executeAccountLogin(admin: Admin, config: Record<string, unknown>, ctx: WorkflowContext): Promise<void> {
  if (!ctx.customer) {
    await sendReply(admin, ctx, (config.reply_no_customer as string) || "I'd be happy to help you access your account! Could you share the email address associated with your account?", config.reply_no_customer_status as string || "open");
    return;
  }

  const email = ctx.customer.email as string;
  const customerId = ctx.customer.id as string;
  let shopifyCustomerId = (ctx.customer.shopify_customer_id as string) || "";

  // If no shopify_customer_id, check linked accounts
  if (!shopifyCustomerId) {
    const { data: link } = await admin.from("customer_links")
      .select("group_id").eq("customer_id", customerId).maybeSingle();
    if (link) {
      const { data: linked } = await admin.from("customer_links")
        .select("customer_id").eq("group_id", link.group_id).neq("customer_id", customerId);
      for (const l of linked || []) {
        const { data: lCust } = await admin.from("customers")
          .select("shopify_customer_id").eq("id", l.customer_id).single();
        if (lCust?.shopify_customer_id) {
          shopifyCustomerId = lCust.shopify_customer_id;
          break;
        }
      }
    }
  }

  // If still no shopify_customer_id, check for potential unlinked accounts
  if (!shopifyCustomerId) {
    const { findUnlinkedMatches } = await import("@/lib/account-matching");
    const matches = await findUnlinkedMatches(ctx.workspaceId, customerId, admin);
    // Check if any match has a shopify_customer_id (i.e. subscriptions)
    const matchesWithShopify: { id: string; email: string }[] = [];
    for (const m of matches) {
      const { data: mCust } = await admin.from("customers")
        .select("shopify_customer_id").eq("id", m.id).single();
      if (mCust?.shopify_customer_id) matchesWithShopify.push(m);
    }

    if (matchesWithShopify.length > 0) {
      // Potential linked accounts with subscriptions — send account linking journey first
      const { data: linkingJourney } = await admin.from("journey_definitions")
        .select("id, name").eq("workspace_id", ctx.workspaceId)
        .eq("trigger_intent", "account_linking").eq("is_active", true).maybeSingle();
      if (linkingJourney) {
        const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
        const channel = (ctx.ticket?.channel as string) || "email";
        await launchJourneyForTicket({
          workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, customerId,
          journeyId: linkingJourney.id, journeyName: linkingJourney.name,
          triggerIntent: "account_linking", channel,
          leadIn: "It looks like you may have more than one account with us. Let's link them so we can get you logged in.",
          ctaText: "Link My Accounts",
        });
        // Stash intent so post-linking re-trigger sends the magic link
        await admin.from("tickets").update({
          handled_by: `Journey: ${linkingJourney.name}`,
          ai_detected_intent: "account_login",
        }).eq("id", ctx.ticketId);
        await addNote(admin, ctx, `No Shopify account found for ${email}. Found potential linked accounts (${matchesWithShopify.map(m => m.email).join(", ")}). Sent account linking journey — magic link will follow after linking.`);
        return;
      }
    }

    // No linked accounts, no potential matches with subscriptions
    await sendReply(admin, ctx, "I'm sorry, we don't have any subscriptions under that email address. If you have another email you may have used, please let us know and we'll look it up!", "closed");
    await addNote(admin, ctx, `No Shopify account or potential linked accounts found for ${email}. Replied with no-subscriptions message.`);
    return;
  }

  // Generate magic link
  const { generateMagicLinkURL } = await import("@/lib/magic-link");
  const magicUrl = await generateMagicLinkURL(customerId, shopifyCustomerId, email, ctx.workspaceId);

  // Build response with the magic link
  const channel = (ctx.ticket?.channel as string) || "email";
  const useHtml = ["email", "chat", "help_center"].includes(channel);

  let reply: string;
  if (useHtml) {
    reply = `<p>Here's your personal login link to access your account:</p><p><a href="${magicUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Log In to My Account</a></p><p>This link is valid for 24 hours and is unique to you — no password needed.</p>`;
  } else {
    reply = `Here's your personal login link to access your account:\n\n${magicUrl}\n\nThis link is valid for 24 hours and is unique to you — no password needed.`;
  }

  await sendReply(admin, ctx, (config.reply_login_link as string) || reply, config.reply_login_link_status as string || "closed");

  // Always send the magic link via email, even if ticket is chat/sms
  const ticketChannel = (ctx.ticket?.channel as string) || "email";
  if (ticketChannel !== "email") {
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", ctx.workspaceId).single();
    await sendTicketReply({
      workspaceId: ctx.workspaceId,
      toEmail: email,
      subject: `Your login link — ${ws?.name || "Portal"}`,
      body: `<p>Here's your personal login link to access your account:</p><p><a href="${magicUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Log In to My Account</a></p><p>This link is valid for 24 hours and is unique to you — no password needed.</p>`,
      inReplyTo: null,
      agentName: ws?.name || "Support",
      workspaceName: ws?.name || "",
    });
  }

  await addNote(admin, ctx, `Magic login link sent to ${email}.`);
}
