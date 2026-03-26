import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { inngest } from "@/lib/inngest/client";
import { evaluateRules } from "@/lib/rules-engine";

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
      const { data: orders } = await admin
        .from("orders")
        .select("id, order_number, total_cents, currency, financial_status, fulfillment_status, source_name, order_type, line_items, fulfillments, created_at")
        .eq("customer_id", c.id)
        .order("created_at", { ascending: false })
        .limit(10);

      const { data: subscriptions } = await admin
        .from("subscriptions")
        .select("id, status, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items")
        .eq("customer_id", c.id)
        .order("created_at", { ascending: false });

      customer = { ...c, recent_orders: orders || [], subscriptions: subscriptions || [] };
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
    .select("sandbox_mode, resend_domain")
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

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("status" in body) {
    updates.status = body.status;
    if (body.status === "closed" && existing.status !== "closed") {
      updates.resolved_at = new Date().toISOString();
    }
    // Fire CSAT event when ticket is closed
    if (body.status === "closed" && existing.status !== "closed") {
      await inngest.send({
        name: "ticket/closed",
        data: {
          ticket_id: ticketId,
          workspace_id: workspaceId,
          customer_id: existing.customer_id,
          subject: existing.subject,
        },
      });
    }
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

  return NextResponse.json(updated);
}
