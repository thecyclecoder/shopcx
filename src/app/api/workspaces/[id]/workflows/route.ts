import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: workflows } = await admin
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  return NextResponse.json(workflows || []);
}

// Default configs per template
const DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  order_tracking: {
    delay_threshold_days: 10,
    reply_preparing: "Hi {{customer.first_name}}, your order {{order.order_number}} is being prepared and should ship within 2-3 business days.",
    reply_no_tracking: "Your order {{order.order_number}} has shipped! Tracking details should be available within 24 hours.",
    reply_in_transit: "Your order {{order.order_number}} shipped on {{fulfillment.date}} via {{fulfillment.carrier}}. Track it here: {{fulfillment.url}}",
    reply_out_for_delivery: "Great news! Your order {{order.order_number}} is out for delivery in {{fulfillment.latest_location}}. It should arrive today!",
    reply_delivered: "I checked on your order ({{order.order_number}}) and it looks like it was delivered on {{fulfillment.delivered_at}}. If you haven't received it, please reply and we'll investigate. The tracking number we have for that order is {{fulfillment.url}}. Your order was shipped to {{fulfillment.delivery_address}} via {{fulfillment.carrier}}.",
    reply_no_order: "Hi {{customer.first_name}}, we couldn't find a recent order on your account. Could you provide your order number so we can look into this?",
    escalate_delayed: true,
    reply_escalated: "Hi {{customer.first_name}}, I can see there may be an issue with the delivery of your order {{order.order_number}}. I'm escalating this to our team and we'll get back to you shortly.",
    reply_escalated_status: "pending",
    escalate_to: null,
    escalate_tag: "delayed-shipment",
    escalate_status: "open",
  },
  cancel_request: {
    check_subscription: true,
    reply_no_subscription: "Hi {{customer.first_name}}, we couldn't find an active subscription on your account. Can you provide more details so we can help?",
    reply_confirm_cancel: "We've received your cancellation request for your subscription. Our team will process this shortly.",
    auto_cancel_via_appstle: false,
    escalate_to_agent: true,
    escalate_assign_to: null,
    escalate_tag: "cancel-request",
  },
  subscription_inquiry: {
    reply_next_date: "Hi {{customer.first_name}}, your next shipment is scheduled for {{subscription.next_billing_date}}. Your subscription includes: {{subscription.items}}.",
    reply_no_subscription: "Hi {{customer.first_name}}, we couldn't find an active subscription for your account. Can you provide more details?",
    allow_skip: false,
    allow_pause: false,
  },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

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
  const template = body.template as string;

  if (!DEFAULT_CONFIGS[template]) {
    return NextResponse.json({ error: "Unknown template" }, { status: 400 });
  }

  const triggerTagMap: Record<string, string> = {
    order_tracking: "smart:order-tracking",
    cancel_request: "smart:cancel-request",
    subscription_inquiry: "smart:subscription",
  };

  const nameMap: Record<string, string> = {
    order_tracking: "Order Tracking",
    cancel_request: "Cancel Request",
    subscription_inquiry: "Subscription Inquiry",
  };

  const { data: workflow, error } = await admin
    .from("workflows")
    .insert({
      workspace_id: workspaceId,
      name: body.name || nameMap[template],
      template,
      trigger_tag: body.trigger_tag || triggerTagMap[template],
      enabled: body.enabled ?? false,
      config: body.config || DEFAULT_CONFIGS[template],
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(workflow, { status: 201 });
}
