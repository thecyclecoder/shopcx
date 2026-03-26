import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResendClient, sendTicketReply } from "@/lib/email";
import { decrypt } from "@/lib/crypto";
import { logCustomerEvent } from "@/lib/customer-events";
import { evaluateRules } from "@/lib/rules-engine";
import { matchPatterns } from "@/lib/pattern-matcher";
import { inngest } from "@/lib/inngest/client";

// Detect short positive confirmation replies (thanks, got it, etc.)
const POSITIVE_PHRASES = [
  "thanks", "thank you", "thank u", "thx", "ty", "got it", "great",
  "perfect", "awesome", "wonderful", "appreciate", "that helps",
  "all good", "all set", "sounds good", "ok great", "ok thanks",
  "ok thank you", "ok cool", "understood", "noted", "good to know",
  "excellent", "much appreciated", "cool thanks", "love it",
  "problem solved", "no further", "that worked",
];

function isShortPositiveReply(body: string): boolean {
  const cleaned = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0]
    .trim();

  // Must be short (under 50 words) — long replies are real messages
  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 50) return false;

  return POSITIVE_PHRASES.some(phrase => cleaned.includes(phrase));
}

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

    // Check if this is a positive confirmation on a smart-tagged ticket
    const { data: ticket } = await admin
      .from("tickets")
      .select("id, status, tags, workspace_id, subject, customer_id, email_message_id")
      .eq("id", ticketId)
      .single();

    const hasSmartTag = (ticket?.tags as string[] || []).some(t => t.startsWith("smart:"));
    const isPositiveConfirmation = hasSmartTag && isShortPositiveReply(messageBody);

    if (isPositiveConfirmation && ticket && (ticket.status === "pending" || ticket.status === "closed")) {
      // Get the configurable auto-close message
      const { data: ws } = await admin.from("workspaces").select("name, auto_close_reply").eq("id", workspaceId).single();
      const autoCloseReply = ws?.auto_close_reply || "You're welcome! If you need anything else, we're always here to help.";

      // Auto-close with friendly reply instead of reopening
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId,
        direction: "outbound",
        visibility: "external",
        author_type: "system",
        body: autoCloseReply,
      });

      // Send the auto-close email
      const { data: cust } = ticket.customer_id
        ? await admin.from("customers").select("email").eq("id", ticket.customer_id).single()
        : { data: null };
      if (cust?.email) {
        await sendTicketReply({
          workspaceId,
          toEmail: cust.email,
          subject: (ticket.subject as string) || "Support",
          body: autoCloseReply,
          inReplyTo: (ticket.email_message_id as string) || null,
          agentName: "Support",
          workspaceName: ws?.name || "Support",
        });
      }

      await admin.from("tickets").update({
        status: "closed",
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", ticketId);
    } else if (ticket && (ticket.status === "pending" || ticket.status === "closed")) {
      // Normal reopen
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

      await logCustomerEvent({
        workspaceId,
        customerId,
        eventType: "ticket.created",
        source: "email",
        summary: `New ticket: ${subject || "(No subject)"}`,
        properties: { ticket_id: ticket.id, subject, from: normalizedEmail },
      });

      // Smart pattern matching — 3-layer: keywords → embeddings → AI
      const matched = await matchPatterns(workspaceId, subject, messageBody);
      if (matched?.autoTag) {
        const { data: t } = await admin.from("tickets").select("tags").eq("id", ticket.id).single();
        const tags = [...((t?.tags as string[]) || []), matched.autoTag];
        await admin.from("tickets").update({ tags: [...new Set(tags)] }).eq("id", ticket.id);

        console.log(`Pattern matched: ${matched.category} (${matched.method}, confidence: ${matched.confidence}) → ${matched.autoTag}`);

        // Fire workflow execution via Inngest (respects channel response delay)
        // Set auto_reply_at so agents can see the ticket is queued
        const { data: wsDelay } = await admin.from("workspaces").select("response_delays").eq("id", workspaceId).single();
        const delays = (wsDelay?.response_delays || { email: 60 }) as Record<string, number>;
        const delaySec = delays.email || 60;
        const autoReplyAt = new Date(Date.now() + delaySec * 1000).toISOString();
        await admin.from("tickets").update({ auto_reply_at: autoReplyAt }).eq("id", ticket.id);

        await inngest.send({
          name: "workflow/execute",
          data: { workspace_id: workspaceId, ticket_id: ticket.id, trigger_tag: matched.autoTag, channel: "email" },
        });
      }

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
