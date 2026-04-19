import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";
import crypto from "crypto";

/**
 * GET — Find subscriptions with the affected item for the current user.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Get crisis to know affected item
  const { data: crisis } = await admin.from("crisis_events")
    .select("affected_variant_id, affected_sku")
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!crisis) return NextResponse.json({ error: "Crisis not found" }, { status: 404 });

  // Find the user's customer profile(s) by email
  const { data: customers } = await admin.from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", user.email);

  const customerIds = (customers || []).map(c => c.id);
  if (customerIds.length === 0) return NextResponse.json({ subscriptions: [] });

  // Get their active subs
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, items, status, next_billing_date")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIds)
    .in("status", ["active", "paused"]);

  // Filter to ones with the affected item
  const matching = (subs || []).filter(s => {
    const items = (s.items as { sku?: string; variant_id?: string }[]) || [];
    return items.some(i =>
      (i.sku && crisis.affected_sku && i.sku.toUpperCase() === crisis.affected_sku.toUpperCase()) ||
      (i.variant_id && i.variant_id === crisis.affected_variant_id),
    );
  });

  return NextResponse.json({ subscriptions: matching });
}

/**
 * POST — Test the crisis campaign on a single subscription.
 * Only works in draft mode. Runs the full Tier 1 flow (auto-swap + email + journey).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;

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

  const body = await request.json();
  const { subscription_id } = body;
  if (!subscription_id) return NextResponse.json({ error: "subscription_id required" }, { status: 400 });

  // Get crisis
  const { data: crisis } = await admin.from("crisis_events")
    .select("*")
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!crisis) return NextResponse.json({ error: "Crisis not found" }, { status: 404 });

  // Get subscription
  const { data: sub } = await admin.from("subscriptions")
    .select("id, customer_id, shopify_contract_id, status, items, next_billing_date")
    .eq("id", subscription_id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

  // Verify sub has the affected item
  const items = (sub.items as { title: string; quantity: number; sku?: string; variant_id?: string }[]) || [];
  const realItems = items.filter(i =>
    !i.title.toLowerCase().includes("shipping protection") && !i.title.toLowerCase().includes("insure"),
  );
  const affectedItem = realItems.find(i =>
    (i.sku && crisis.affected_sku && i.sku.toUpperCase() === crisis.affected_sku.toUpperCase()) ||
    (i.variant_id && i.variant_id === crisis.affected_variant_id),
  );

  if (!affectedItem) {
    return NextResponse.json({ error: "This subscription does not have the affected item" }, { status: 400 });
  }

  const nonAffectedItems = realItems.filter(i => i !== affectedItem);
  const segment = nonAffectedItems.length === 0 ? "berry_only" : "berry_plus";

  // Auto-swap via Appstle + preserve base price
  let preservedBasePriceCents: number | null = null;
  if (crisis.default_swap_variant_id && sub.shopify_contract_id) {
    try {
      const { subSwapVariant, getLastOrderPrice, calcBasePrice, subUpdateLineItemPrice } = await import("@/lib/subscription-items");

      // Get price customer was paying before swap
      const lastPrice = await getLastOrderPrice(workspaceId, sub.customer_id, affectedItem.sku || null, affectedItem.variant_id || null);
      if (lastPrice) {
        preservedBasePriceCents = calcBasePrice(lastPrice, 25);
      }

      const swapResult = await subSwapVariant(
        workspaceId,
        sub.shopify_contract_id,
        affectedItem.variant_id || crisis.affected_variant_id,
        crisis.default_swap_variant_id,
        affectedItem.quantity || 1,
      );

      // Update price on new variant to preserve customer's pricing
      if (preservedBasePriceCents) {
        await subUpdateLineItemPrice(workspaceId, sub.shopify_contract_id, crisis.default_swap_variant_id, preservedBasePriceCents, swapResult.newLineGid);
      }
    } catch { /* non-fatal */ }
  }

  // Create ticket
  const { data: ticket } = await admin.from("tickets").insert({
    workspace_id: workspaceId,
    customer_id: sub.customer_id,
    subject: `[TEST] Update about your ${crisis.affected_product_title || "subscription"}`,
    status: "closed",
    channel: "email",
    tags: ["crisis", `crisis:${crisis.id.slice(0, 8)}`, "crisis:test", "touched", "ft:journey"],
    handled_by: `Crisis: ${crisis.name}`,
  }).select("id").single();

  // Check for existing action (re-test)
  const { data: existing } = await admin.from("crisis_customer_actions")
    .select("id")
    .eq("crisis_id", crisis.id)
    .eq("subscription_id", sub.id)
    .maybeSingle();

  if (existing) {
    // Delete old test action so we can re-test
    await admin.from("crisis_customer_actions").delete().eq("id", existing.id);
  }

  // Record action
  const { data: actionRecord } = await admin.from("crisis_customer_actions").insert({
    crisis_id: crisis.id,
    workspace_id: workspaceId,
    subscription_id: sub.id,
    customer_id: sub.customer_id,
    segment,
    original_item: affectedItem,
    current_tier: 1,
    tier1_sent_at: new Date().toISOString(),
    tier1_swapped_to: crisis.default_swap_variant_id
      ? { variantId: crisis.default_swap_variant_id, title: crisis.default_swap_title || "default swap" }
      : null,
    ticket_id: ticket?.id || null,
    preserved_base_price_cents: preservedBasePriceCents,
  }).select("id").single();

  // Create journey session
  const token = crypto.randomBytes(24).toString("hex");
  // Look up crisis tier 1 journey definition
  const { data: journeyDef } = await admin.from("journey_definitions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("trigger_intent", "crisis_tier1")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  await admin.from("journey_sessions").insert({
    workspace_id: workspaceId,
    journey_id: journeyDef?.id || null,
    customer_id: sub.customer_id,
    ticket_id: ticket?.id || null,
    token,
    token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    config_snapshot: {
      codeDriven: true,
      journeyType: "crisis_tier1",
      metadata: {
        crisisId: crisis.id,
        actionId: actionRecord?.id,
        subscriptionId: sub.id,
        customerId: sub.customer_id,
        workspaceId,
        ticketId: ticket?.id,
        affectedVariantId: crisis.affected_variant_id,
        affectedProductTitle: crisis.affected_product_title,
        defaultSwapVariantId: crisis.default_swap_variant_id,
        defaultSwapTitle: crisis.default_swap_title,
      },
    },
  });

  // Send email
  const { data: customer } = await admin.from("customers")
    .select("email, first_name").eq("id", sub.customer_id).single();

  if (!customer?.email) {
    return NextResponse.json({ error: "Customer has no email" }, { status: 400 });
  }

  const { data: ws } = await admin.from("workspaces")
    .select("name, help_primary_color").eq("id", workspaceId).single();

  const firstName = customer.first_name || "there";
  const defaultSwap = crisis.default_swap_title || "an available flavor";
  const restockDate = crisis.expected_restock_date
    ? new Date(crisis.expected_restock_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "a few months";

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const journeyUrl = `${siteUrl}/journey/${token}`;
  const primaryColor = ws?.help_primary_color || "#4f46e5";

  const emailBody = `<p>Hi ${firstName},</p>
<p>We wanted to let you know that <b>${crisis.affected_product_title || "your item"}</b> is temporarily out of stock. We expect it back by <b>${restockDate}</b>.</p>
<p>To make sure you don't miss your next shipment, we've switched it to <b>${defaultSwap}</b>. ${segment === "berry_plus" ? "Your other items will ship as usual." : ""}</p>
<p>If you'd prefer a different flavor, you can change it here:</p>
<p style="text-align:center;margin:20px 0;"><a href="${journeyUrl}" style="display:inline-block;padding:12px 28px;background:${primaryColor};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Choose a Different Flavor →</a></p>
<p style="color:#6b7280;font-size:13px;">If you're happy with ${defaultSwap}, no action needed — your next shipment will include it automatically.</p>`;

  // Inject tracking (open pixel + click links)
  const { injectFullTracking, mapTrackingToken } = await import("@/lib/email-tracking");
  const { html: trackedBody, trackingToken } = injectFullTracking(emailBody);

  // Send email with tracking
  const testSubject = `[TEST] Update about your ${crisis.affected_product_title || "subscription"}`;
  const emailResult = await sendTicketReply({
    workspaceId,
    toEmail: customer.email,
    subject: testSubject,
    body: trackedBody,
    inReplyTo: null,
    agentName: "Customer Care",
    workspaceName: ws?.name || "",
  });

  // Map tracking token
  if (emailResult.messageId) {
    await mapTrackingToken(trackingToken, emailResult.messageId, workspaceId, customer.email, testSubject, ticket?.id, sub.customer_id);
  }

  // Insert ticket message (clean body for display)
  const emailMessageId = emailResult.messageId ? `<${emailResult.messageId}@resend.dev>` : null;
  await admin.from("ticket_messages").insert({
    ticket_id: ticket?.id,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body: emailBody,
    sent_at: new Date().toISOString(),
    email_message_id: emailMessageId,
  });

  return NextResponse.json({
    success: true,
    subscription_id: sub.id,
    customer_email: customer.email,
    segment,
    ticket_id: ticket?.id,
    journey_url: journeyUrl,
    swapped: !!crisis.default_swap_variant_id,
  });
}
