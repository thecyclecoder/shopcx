import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  appstleSubscriptionAction,
  appstleSkipUpcomingOrder,
  appstleUpdateBillingInterval,
} from "@/lib/appstle";
import { changeNextBillingDate } from "@/lib/shopify-subscriptions";
import { logCustomerEvent } from "@/lib/customer-events";

// GET: Full subscription detail with dunning, orders, events
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Load subscription
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("*, customers(id, email, first_name, last_name, shopify_customer_id, retention_score, subscription_status)")
    .eq("id", subId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !sub) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Dunning cycles
  const { data: dunningCycles } = await admin
    .from("dunning_cycles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", sub.shopify_contract_id)
    .order("cycle_number", { ascending: false });

  // Payment failures for this subscription
  const { data: paymentFailures } = await admin
    .from("payment_failures")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", sub.shopify_contract_id)
    .order("created_at", { ascending: false })
    .limit(20);

  // Recent orders from this subscription
  const { data: orders } = await admin
    .from("orders")
    .select("id, shopify_order_id, order_number, total_cents, line_items, fulfillments, created_at")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", subId)
    .order("created_at", { ascending: false })
    .limit(10);

  // Customer events for this subscription
  const { data: events } = await admin
    .from("customer_events")
    .select("id, event_type, summary, properties, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", sub.customer_id)
    .or(`properties->>shopify_contract_id.eq.${sub.shopify_contract_id},event_type.ilike.subscription%`)
    .order("created_at", { ascending: false })
    .limit(20);

  // Recovery status
  const activeDunning = dunningCycles?.find(c => ["active", "skipped", "paused"].includes(c.status));
  let recovery_status: string | null = null;
  if (activeDunning) {
    if (activeDunning.status === "active" || activeDunning.status === "skipped") recovery_status = "in_recovery";
    else recovery_status = "failed";
  } else {
    const recovered = dunningCycles?.find(c => c.status === "recovered");
    if (recovered?.recovered_at) {
      const recoveredAt = new Date(recovered.recovered_at);
      if (Date.now() - recoveredAt.getTime() < 7 * 24 * 60 * 60 * 1000) recovery_status = "recovered";
    }
  }

  return NextResponse.json({
    subscription: { ...sub, recovery_status },
    dunning_cycles: dunningCycles || [],
    payment_failures: paymentFailures || [],
    orders: orders || [],
    events: events || [],
  });
}

// PATCH: Subscription actions (pause, resume, cancel, skip, frequency, date)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin", "agent"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const { action } = body;

  let result: { success: boolean; error?: string };
  let eventSummary: string;

  switch (action) {
    case "pause": {
      result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "pause");
      eventSummary = "Subscription paused";
      break;
    }
    case "resume": {
      result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "resume");
      eventSummary = "Subscription resumed";
      break;
    }
    case "cancel": {
      const reason = body.reason || "manual";
      result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "cancel", reason, member.display_name || user.email || "agent");
      eventSummary = `Subscription cancelled — ${reason}`;
      break;
    }
    case "skip": {
      result = await appstleSkipUpcomingOrder(workspaceId, sub.shopify_contract_id);
      eventSummary = "Next order skipped";
      break;
    }
    case "change_frequency": {
      const { interval, intervalCount } = body;
      if (!interval || !intervalCount) return NextResponse.json({ error: "interval and intervalCount required" }, { status: 400 });
      result = await appstleUpdateBillingInterval(workspaceId, sub.shopify_contract_id, interval, intervalCount);
      eventSummary = `Frequency changed to every ${intervalCount} ${interval.toLowerCase()}(s)`;
      break;
    }
    case "change_date": {
      const { nextBillingDate } = body;
      if (!nextBillingDate) return NextResponse.json({ error: "nextBillingDate required" }, { status: 400 });
      result = await changeNextBillingDate(workspaceId, sub.shopify_contract_id, nextBillingDate);
      // Update local record
      if (result.success) {
        await admin.from("subscriptions").update({ next_billing_date: nextBillingDate, updated_at: new Date().toISOString() }).eq("id", subId);
      }
      eventSummary = `Next order date changed to ${nextBillingDate}`;
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Action failed" }, { status: 500 });
  }

  // Log event
  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId,
      customerId: sub.customer_id,
      eventType: `subscription.${action}`,
      source: "agent",
      summary: `${eventSummary} by ${member.display_name || user.email}`,
      properties: { shopify_contract_id: sub.shopify_contract_id, action, ...body },
    });
  }

  return NextResponse.json({ ok: true, action });
}
