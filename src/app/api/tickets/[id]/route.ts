import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { inngest } from "@/lib/inngest/client";
import { evaluateRules } from "@/lib/rules-engine";
import { calculateRetentionScore } from "@/lib/retention-score";
import { dispatchSlackNotification } from "@/lib/slack-notify";

// GET: ticket detail with messages and customer
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Get ticket
  const { data: ticket } = await admin
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get messages
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  // Enrich messages with author names
  const authorIds = [...new Set(messages?.filter((m) => m.author_id).map((m) => m.author_id))];
  const { data: usersData } = await admin.auth.admin.listUsers();
  const userMap = new Map(
    usersData?.users?.map((u) => [
      u.id,
      { name: u.user_metadata?.full_name || u.user_metadata?.name || u.email, email: u.email },
    ]) ?? []
  );

  const enrichedMessages = messages?.map((m) => ({
    ...m,
    author_name: m.author_id ? userMap.get(m.author_id)?.name : null,
    author_email: m.author_id ? userMap.get(m.author_id)?.email : null,
  }));

  // Get customer with recent orders
  let customer = null;
  if (ticket.customer_id) {
    const { data: c } = await admin
      .from("customers")
      .select("*")
      .eq("id", ticket.customer_id)
      .single();

    if (c) {
      // Get linked customer IDs for combined data
      const linkedCustomerIds = [c.id];
      const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", c.id).single();
      if (link) {
        const { data: groupLinks } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
        for (const gl of groupLinks || []) {
          if (!linkedCustomerIds.includes(gl.customer_id)) linkedCustomerIds.push(gl.customer_id);
        }
      }

      const { data: orders } = await admin
        .from("orders")
        .select("id, shopify_order_id, order_number, total_cents, currency, financial_status, fulfillment_status, delivery_status, source_name, order_type, line_items, fulfillments, shipping_address, created_at")
        .in("customer_id", linkedCustomerIds)
        .order("created_at", { ascending: false })
        .limit(10);

      const { data: subscriptions } = await admin
        .from("subscriptions")
        .select("id, status, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items, applied_discounts")
        .in("customer_id", linkedCustomerIds)
        .order("created_at", { ascending: false });

      // LTV + order count come live from the orders table via the helper —
      // the customers row's denormalized columns drift.
      const { getCustomerStats } = await import("@/lib/customer-stats");
      const stats = await getCustomerStats(c.id);

      // Recalculate retention score with real data
      const lastOrder = orders?.[0];
      const retentionInput = {
        id: c.id,
        last_order_at: lastOrder?.created_at || c.last_order_at,
        total_orders: stats.total_orders,
        ltv_cents: stats.ltv_cents,
        subscription_status: c.subscription_status,
      };
      const realRetention = calculateRetentionScore(retentionInput);

      // Get linked identities for sidebar
      let linkedIdentities: { id: string; email: string; first_name: string | null; last_name: string | null; is_primary: boolean }[] = [];
      if (link) {
        const { data: groupLinks } = await admin
          .from("customer_links")
          .select("customer_id, is_primary, customers(id, email, first_name, last_name)")
          .eq("group_id", link.group_id);

        linkedIdentities = (groupLinks || [])
          .filter((l) => l.customer_id !== c.id)
          .map((l) => {
            const cust = l.customers as unknown as { id: string; email: string; first_name: string | null; last_name: string | null };
            return { id: cust.id, email: cust.email, first_name: cust.first_name, last_name: cust.last_name, is_primary: l.is_primary };
          });
      }

      customer = {
        ...c,
        total_orders: stats.total_orders,
        ltv_cents: stats.ltv_cents,
        retention_score: realRetention,
        recent_orders: orders || [],
        subscriptions: subscriptions || [],
        linked_identities: linkedIdentities,
      };
    }
  }

  // Get assigned user name
  let assignedName = null;
  if (ticket.assigned_to) {
    assignedName = userMap.get(ticket.assigned_to)?.name || null;
  }

  // Get sandbox mode
  const { data: ws } = await admin
    .from("workspaces")
    .select("sandbox_mode, resend_domain, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  const sandboxMode = ws?.sandbox_mode ?? true;
  const inboundAddress = ws?.resend_domain ? `inbound@${ws.resend_domain}` : null;
  const isInboundTicket = ticket.received_at_email === inboundAddress || !ticket.received_at_email;

  return NextResponse.json({
    ticket: { ...ticket, assigned_name: assignedName },
    messages: enrichedMessages || [],
    customer,
    sandbox_mode: sandboxMode,
    email_live: !sandboxMode || isInboundTicket,
    shopify_domain: ws?.shopify_myshopify_domain || null,
  });
}

// PATCH: update ticket
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const body = await request.json();

  // Verify ticket belongs to workspace
  const { data: existing } = await admin
    .from("tickets")
    .select("id, status, workspace_id, customer_id, subject")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Archived tickets are permanently read-only
  if (existing.status === "archived") {
    return NextResponse.json({ error: "Archived tickets cannot be modified" }, { status: 400 });
  }

  // Cancel a pending outbound message
  if (body.cancel_pending_message) {
    await admin.from("ticket_messages").update({ send_cancelled: true }).eq("id", body.cancel_pending_message).eq("ticket_id", ticketId);
    return NextResponse.json({ success: true });
  }

  // Edit a pending outbound message
  if (body.edit_pending_message && body.new_body) {
    const html = `<p>${(body.new_body as string).replace(/\n/g, "</p><p>")}</p>`;
    await admin.from("ticket_messages").update({ body: html }).eq("id", body.edit_pending_message).eq("ticket_id", ticketId).is("sent_at", null);
    return NextResponse.json({ success: true });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("status" in body) {
    updates.status = body.status;
    if (body.status === "closed" && existing.status !== "closed") {
      updates.resolved_at = new Date().toISOString();
      updates.closed_at = new Date().toISOString();
    }
    // Re-opening a closed ticket resets the archive clock
    if (body.status === "open" && existing.status === "closed") {
      updates.closed_at = null;
    }
    // CSAT disabled — will be reimplemented differently
  }

  if ("assigned_to" in body) updates.assigned_to = body.assigned_to || null;
  if ("tags" in body) updates.tags = body.tags;
  if ("csat_score" in body) updates.csat_score = body.csat_score;
  if ("auto_reply_at" in body) updates.auto_reply_at = body.auto_reply_at;
  if ("escalated_to" in body) {
    updates.escalated_to = body.escalated_to || null;
    updates.escalated_at = body.escalated_to ? new Date().toISOString() : null;
    if ("escalation_reason" in body) updates.escalation_reason = body.escalation_reason || null;
  }
  if ("snoozed_until" in body) {
    updates.snoozed_until = body.snoozed_until || null;
  }

  const { data: updated, error } = await admin
    .from("tickets")
    .update(updates)
    .eq("id", ticketId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Evaluate rules on status change
  if ("status" in body && body.status !== existing.status) {
    const { data: custData } = updated.customer_id
      ? await admin.from("customers").select("*").eq("id", updated.customer_id).single()
      : { data: null };
    await evaluateRules(workspaceId, "ticket.status_changed", {
      ticket: updated,
      customer: custData || undefined,
    });
  }

  // Slack notification on manual escalation
  if ("escalated_to" in body && body.escalated_to) {
    const { data: member } = await admin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", body.escalated_to)
      .single();

    const { data: custData } = updated.customer_id
      ? await admin.from("customers").select("first_name, email").eq("id", updated.customer_id).single()
      : { data: null };

    dispatchSlackNotification(workspaceId, "escalation", {
      ticketId,
      ticketNumber: updated.subject || ticketId,
      customer: { name: custData?.first_name || undefined, email: custData?.email },
      reason: body.escalation_reason || "Manual escalation",
      assignedMemberId: member?.id,
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Owner/admin only
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Only owner or admin can delete tickets" }, { status: 403 });
  }

  // Delete messages first (cascade should handle this, but be explicit)
  await admin.from("ticket_messages").delete().eq("ticket_id", ticketId);
  await admin.from("tickets").delete().eq("id", ticketId).eq("workspace_id", workspaceId);

  return NextResponse.json({ deleted: true });
}
