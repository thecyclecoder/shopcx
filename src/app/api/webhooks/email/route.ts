import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const rawBody = await request.json();

  // Resend webhooks wrap the email in { type: "email.received", data: { ... } }
  const body = rawBody.data || rawBody;

  const {
    from: fromEmail,
    to: toAddresses,
    subject,
    html,
    text,
    headers: emailHeaders,
  } = body;

  // Debug logging — remove once confirmed working
  console.log("Inbound email webhook:", JSON.stringify({
    hasData: !!rawBody.data,
    type: rawBody.type,
    from: fromEmail,
    to: toAddresses,
    subject,
    hasHtml: !!html,
    hasText: !!text,
  }));

  // Extract sender email
  const senderEmail = typeof fromEmail === "string"
    ? fromEmail.match(/<([^>]+)>/)?.[1] || fromEmail
    : fromEmail?.address || fromEmail;

  if (!senderEmail) {
    return NextResponse.json({ error: "No sender" }, { status: 400 });
  }

  // Extract the receiving domain to find the workspace
  const toAddress = Array.isArray(toAddresses) ? toAddresses[0] : toAddresses;
  const toDomain = (typeof toAddress === "string" ? toAddress : toAddress?.address || "")
    .split("@")[1]
    ?.toLowerCase();

  if (!toDomain) {
    return NextResponse.json({ ok: true }); // Swallow, don't retry
  }

  const admin = createAdminClient();

  // Look up workspace by resend_domain
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("resend_domain", toDomain)
    .single();

  if (!workspace) {
    return NextResponse.json({ ok: true }); // Unknown domain, swallow
  }

  const workspaceId = workspace.id;
  const messageId = emailHeaders?.["message-id"] || emailHeaders?.["Message-ID"] || null;
  const inReplyTo = emailHeaders?.["in-reply-to"] || emailHeaders?.["In-Reply-To"] || null;
  const messageBody = html || text || "(empty message)";
  const normalizedEmail = senderEmail.toLowerCase().trim();

  // Capture original To address (for routing/tagging by support email)
  // Check forwarded headers first, fall back to X-Original-To, then the To field itself
  const originalTo = (
    emailHeaders?.["x-original-to"] ||
    emailHeaders?.["X-Original-To"] ||
    emailHeaders?.["x-forwarded-to"] ||
    emailHeaders?.["X-Forwarded-To"] ||
    emailHeaders?.["delivered-to"] ||
    emailHeaders?.["Delivered-To"] ||
    (typeof toAddress === "string" ? toAddress : toAddress?.address) ||
    ""
  ).toLowerCase().trim();

  // Try to thread to existing ticket
  let ticketId: string | null = null;

  // 1. Check In-Reply-To header against ticket email_message_id
  if (inReplyTo) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email_message_id", inReplyTo)
      .single();

    if (ticket) ticketId = ticket.id;
  }

  // 2. Check In-Reply-To against ticket_messages email_message_id
  if (!ticketId && inReplyTo) {
    const { data: msg } = await admin
      .from("ticket_messages")
      .select("ticket_id")
      .eq("email_message_id", inReplyTo)
      .limit(1)
      .single();

    if (msg) ticketId = msg.ticket_id;
  }

  // 3. Fallback: subject matching + same customer email within 7 days
  if (!ticketId && subject) {
    const cleanSubject = subject.replace(/^(Re:|Fwd?:|Fw:)\s*/gi, "").trim();
    if (cleanSubject) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: ticket } = await admin
        .from("tickets")
        .select("id, customers(email)")
        .eq("workspace_id", workspaceId)
        .ilike("subject", cleanSubject)
        .gte("created_at", sevenDaysAgo)
        .limit(1)
        .single();

      const ticketCustomer = Array.isArray(ticket?.customers) ? ticket.customers[0] : ticket?.customers;
      if (ticket && ticketCustomer?.email?.toLowerCase() === normalizedEmail) {
        ticketId = ticket.id;
      }
    }
  }

  if (ticketId) {
    // Add message to existing ticket
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: messageBody,
      email_message_id: messageId,
    });

    // Reopen if pending or resolved
    const { data: ticket } = await admin
      .from("tickets")
      .select("status")
      .eq("id", ticketId)
      .single();

    if (ticket && (ticket.status === "pending" || ticket.status === "resolved")) {
      await admin
        .from("tickets")
        .update({ status: "open", updated_at: new Date().toISOString() })
        .eq("id", ticketId);
    } else {
      await admin
        .from("tickets")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", ticketId);
    }
  } else {
    // New ticket — resolve or create customer
    let customerId: string | null = null;

    const { data: existing } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email", normalizedEmail)
      .single();

    if (existing) {
      customerId = existing.id;
    } else {
      // Extract name from email "From" header
      const nameMatch = (typeof fromEmail === "string" ? fromEmail : "").match(/^([^<]+)</);
      const fromName = nameMatch?.[1]?.trim();

      const { data: created } = await admin
        .from("customers")
        .insert({
          workspace_id: workspaceId,
          email: normalizedEmail,
          first_name: fromName || null,
        })
        .select("id")
        .single();

      customerId = created?.id || null;
    }

    // Create ticket
    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        channel: "email",
        status: "open",
        subject: subject || "(No subject)",
        email_message_id: messageId,
        received_at_email: originalTo || null,
      })
      .select("id")
      .single();

    if (ticket) {
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id,
        direction: "inbound",
        visibility: "external",
        author_type: "customer",
        body: messageBody,
        email_message_id: messageId,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
