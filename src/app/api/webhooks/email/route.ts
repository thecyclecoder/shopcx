import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResendClient, sendTicketReply } from "@/lib/email";
import { stripQuotedReply } from "@/lib/email-utils";
import { cleanEmailBody } from "@/lib/email-cleaner";
import { decrypt } from "@/lib/crypto";
import { logCustomerEvent } from "@/lib/customer-events";
import { evaluateRules } from "@/lib/rules-engine";
import { inngest } from "@/lib/inngest/client";
import { dispatchSlackNotification } from "@/lib/slack-notify";

// Positive close detection moved to unified ticket handler
// Fetch email body from Resend's receiving API
async function fetchEmailBody(
  apiKey: string,
  emailId: string
): Promise<{ html: string | null; text: string | null; headers: Record<string, string> }> {
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error("Failed to fetch email body:", res.status, await res.text());
      return { html: null, text: null, headers: {} };
    }
    const data = await res.json();
    return {
      html: data.html || null,
      text: data.text || null,
      headers: data.headers || {},
    };
  } catch (err) {
    console.error("Error fetching email body:", err);
    return { html: null, text: null, headers: {} };
  }
}

export async function POST(request: Request) {
  const rawBody = await request.json();

  // Resend webhooks wrap the email in { type: "email.received", data: { ... } }
  const body = rawBody.data || rawBody;

  const {
    from: fromEmail,
    to: toAddresses,
    subject,
    email_id: emailId,
    message_id: topLevelMessageId,
    in_reply_to: topLevelInReplyTo,
  } = body;

  // Extract sender email
  const senderEmail = typeof fromEmail === "string"
    ? fromEmail.match(/<([^>]+)>/)?.[1] || fromEmail
    : fromEmail?.address || fromEmail;

  if (!senderEmail) {
    return NextResponse.json({ error: "No sender" }, { status: 400 });
  }

  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() || "";
  const senderLower = senderEmail.toLowerCase();
  const subjectLower = (subject || "").toLowerCase();

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
    .select("id, name, resend_api_key_encrypted")
    .eq("resend_domain", toDomain)
    .single();

  if (!workspace) {
    return NextResponse.json({ ok: true }); // Unknown domain, swallow
  }

  const workspaceId = workspace.id;

  // ── Email filter: block spam/system/marketing emails ──
  const { data: filters } = await admin
    .from("email_filters")
    .select("filter_type, pattern, action")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  if (filters?.length) {
    const blocked = filters.some(f => {
      if (f.action !== "block") return false;
      if (f.filter_type === "domain" && senderDomain === f.pattern.toLowerCase()) return true;
      if (f.filter_type === "sender" && senderLower.startsWith(f.pattern.toLowerCase())) return true;
      if (f.filter_type === "subject" && subjectLower.includes(f.pattern.toLowerCase())) return true;
      return false;
    });

    if (blocked) {
      return NextResponse.json({ ok: true, filtered: true }); // Silently drop
    }
  }

  // Fetch the full email body from Resend's receiving API
  let emailContent = { html: null as string | null, text: null as string | null, headers: {} as Record<string, string> };
  if (emailId && workspace.resend_api_key_encrypted) {
    const apiKey = decrypt(workspace.resend_api_key_encrypted);
    emailContent = await fetchEmailBody(apiKey, emailId);
  }

  const messageId = topLevelMessageId || emailContent.headers?.["message-id"] || null;
  const inReplyTo = topLevelInReplyTo || emailContent.headers?.["in-reply-to"] || null;
  const messageBody = emailContent.html || emailContent.text || "(No message body)";
  const normalizedEmail = senderEmail.toLowerCase().trim();

  // Capture original To address (for routing/tagging by support email)
  // Check forwarded headers first, fall back to X-Original-To, then the To field itself
  const hdrs = emailContent.headers || {};
  const originalTo = (
    hdrs["x-original-to"] ||
    hdrs["X-Original-To"] ||
    hdrs["x-forwarded-to"] ||
    hdrs["X-Forwarded-To"] ||
    hdrs["delivered-to"] ||
    hdrs["Delivered-To"] ||
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

  // If matched ticket is archived, create a new ticket instead of threading
  if (ticketId) {
    const { data: matchedTicket } = await admin
      .from("tickets")
      .select("status")
      .eq("id", ticketId)
      .single();

    if (matchedTicket?.status === "archived") {
      ticketId = null;
    }
  }

  if (ticketId) {
    // Strip quoted reply content (the previous message) from the body
    const cleanBody = stripQuotedReply(messageBody) || messageBody;
    // Deep clean for AI: strip HTML, signatures, quoted history, noise
    const bodyClean = cleanEmailBody(cleanBody, fromEmail);

    // Add message to existing ticket
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: cleanBody,
      body_clean: bodyClean,
      email_message_id: messageId,
    });

    // Check if this is a positive confirmation on a smart-tagged ticket
    const { data: ticket } = await admin
      .from("tickets")
      .select("id, status, tags, workspace_id, subject, customer_id, email_message_id")
      .eq("id", ticketId)
      .single();

    // Always reopen closed/pending tickets on customer reply + track last reply
    if (ticket && (ticket.status === "pending" || ticket.status === "closed")) {
      await admin.from("tickets").update({
        status: "open",
        closed_at: null, // Reset archive clock on reopen
        last_customer_reply_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", ticketId);
    } else {
      await admin.from("tickets").update({
        last_customer_reply_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", ticketId);
    }

    // Positive close is handled by the unified ticket handler

    // Evaluate rules for message received on existing ticket
    const { data: ticketData } = await admin.from("tickets").select("*").eq("id", ticketId).single();
    const { data: custData } = ticketData?.customer_id
      ? await admin.from("customers").select("*").eq("id", ticketData.customer_id).single()
      : { data: null };
    await evaluateRules(workspaceId, "ticket.message_received", {
      ticket: ticketData || undefined,
      customer: custData || undefined,
      message: { body: messageBody, direction: "inbound", author_type: "customer" },
    });

    // Unified handler handles all routing including positive close
    if (ticketData) {
      const isAutoHandled = ticketData.ai_handled;
      const isUnassigned = !ticketData.assigned_to;
      const channel = ticketData.channel || "email";

      // Check if AI is enabled for this channel
      const { data: aiConfig } = await admin
        .from("ai_channel_config")
        .select("enabled")
        .eq("workspace_id", workspaceId)
        .eq("channel", channel)
        .single();

      const wasReopenedFromClosed = ticket && (ticket.status === "pending" || ticket.status === "closed");
      if (aiConfig?.enabled && (isAutoHandled || isUnassigned || wasReopenedFromClosed)) {
        await inngest.send({
          name: "ticket/inbound-message",
          data: {
            workspace_id: workspaceId,
            ticket_id: ticketId,
            message_body: bodyClean,
            channel: "email",
            is_new_ticket: false,
          },
        });
      }
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

    // Crisis auto-merge: if customer has an active crisis action and subject matches, redirect to crisis ticket
    if (customerId && subject) {
      const cleanSubjectForCrisis = subject.replace(/^(Re:|Fwd?:|Fw:)\s*/gi, "").trim().toLowerCase();
      const { data: crisisAction } = await admin
        .from("crisis_customer_actions")
        .select("ticket_id, crisis_id")
        .eq("customer_id", customerId)
        .is("exhausted_at", null)
        .gt("current_tier", 0)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (crisisAction?.ticket_id && crisisAction.crisis_id) {
        // Verify crisis is still active and subject matches affected product
        const { data: crisis } = await admin
          .from("crisis_events")
          .select("affected_product_title, status")
          .eq("id", crisisAction.crisis_id)
          .single();

        if (crisis?.status === "active" && crisis.affected_product_title &&
            cleanSubjectForCrisis.includes(crisis.affected_product_title.toLowerCase())) {
          // Verify crisis ticket exists and isn't archived
          const { data: crisisTicket } = await admin
            .from("tickets")
            .select("id, status, workspace_id")
            .eq("id", crisisAction.ticket_id)
            .single();

          if (crisisTicket && crisisTicket.status !== "archived") {
            // Merge: insert message on crisis ticket instead of creating new one
            const cleanBody = stripQuotedReply(messageBody) || messageBody;
            const bodyClean = cleanEmailBody(cleanBody, fromEmail);

            await admin.from("ticket_messages").insert({
              ticket_id: crisisTicket.id,
              direction: "inbound", visibility: "external", author_type: "customer",
              body: cleanBody, body_clean: bodyClean, email_message_id: messageId,
            });

            // Reopen if closed/pending
            if (crisisTicket.status === "closed" || crisisTicket.status === "pending") {
              await admin.from("tickets").update({
                status: "open", closed_at: null,
                last_customer_reply_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }).eq("id", crisisTicket.id);
            } else {
              await admin.from("tickets").update({
                last_customer_reply_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }).eq("id", crisisTicket.id);
            }

            // System note
            await admin.from("ticket_messages").insert({
              ticket_id: crisisTicket.id,
              direction: "outbound", visibility: "internal", author_type: "system",
              body: `[System] Auto-merged inbound email (would have created new ticket). Subject: "${subject}"`,
            });

            // Dispatch to unified handler with crisis context
            await inngest.send({
              name: "ticket/inbound-message",
              data: {
                workspace_id: workspaceId,
                ticket_id: crisisTicket.id,
                message_body: bodyClean || messageBody || subject || "",
                channel: "email",
                is_new_ticket: false,
              },
            });

            return NextResponse.json({ ok: true });
          }
        }
      }
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
        last_customer_reply_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (ticket) {
      const newBodyClean = cleanEmailBody(messageBody, fromEmail);
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id,
        direction: "inbound",
        visibility: "external",
        author_type: "customer",
        body: messageBody,
        body_clean: newBodyClean,
        email_message_id: messageId,
      });

      await logCustomerEvent({
        workspaceId,
        customerId,
        eventType: "ticket.created",
        source: "email",
        summary: `New ticket: ${subject || "(No subject)"}`,
        properties: { ticket_id: ticket.id, subject, from: normalizedEmail },
      });

      // Slack notification for new ticket
      dispatchSlackNotification(workspaceId, "new_ticket", {
        ticketId: ticket.id,
        customer: { email: normalizedEmail },
        channel: "email",
        subject: subject || "(No subject)",
      }).catch(() => {});

      // Unified handler handles all routing: journey → workflow → macro → KB → escalate
      await inngest.send({
        name: "ticket/inbound-message",
        data: { workspace_id: workspaceId, ticket_id: ticket.id, message_body: newBodyClean || messageBody || subject || "", channel: "email", is_new_ticket: true },
      });

      // Evaluate rules for new ticket (tags are set, so rules can trigger on them)
      const { data: fullTicket } = await admin.from("tickets").select("*").eq("id", ticket.id).single();
      const { data: custData } = customerId
        ? await admin.from("customers").select("*").eq("id", customerId).single()
        : { data: null };
      await evaluateRules(workspaceId, "ticket.created", {
        ticket: fullTicket || undefined,
        customer: custData || undefined,
        message: { body: messageBody, direction: "inbound", author_type: "customer" },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
