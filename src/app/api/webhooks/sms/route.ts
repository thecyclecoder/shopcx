import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/twilio";
import { evaluateRules } from "@/lib/rules-engine";
import { inngest } from "@/lib/inngest/client";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  let params: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const urlParams = new URLSearchParams(text);
    urlParams.forEach((value, key) => {
      params[key] = value;
    });
  } else {
    const body = await request.json();
    params = body;
  }

  const from = params.From;
  const messageBody = params.Body || "";
  const messageSid = params.MessageSid || "";
  const twilioNumber = params.To || "";

  if (!from) {
    return twimlResponse();
  }

  // Validate Twilio signature using global auth token
  const signature = request.headers.get("x-twilio-signature") || "";
  const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/api/webhooks/sms`;

  if (process.env.NODE_ENV === "production" && !validateTwilioSignature(signature, webhookUrl, params)) {
    console.error("Invalid Twilio signature");
    return twimlResponse();
  }

  const normalizedPhone = from.replace(/\s/g, "");
  const admin = createAdminClient();

  // Find workspace by the Twilio phone number (To field)
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("twilio_phone_number", twilioNumber)
    .single();

  if (!workspace) {
    console.error("No workspace found for Twilio number:", twilioNumber);
    return twimlResponse();
  }

  const workspaceId = workspace.id;

  // Find customer by phone number
  let customerId: string | null = null;

  // Try exact match first, then common phone format variations
  const phoneVariants = [normalizedPhone];
  if (normalizedPhone.startsWith("+1")) {
    phoneVariants.push(normalizedPhone.slice(2));
  } else if (!normalizedPhone.startsWith("+")) {
    phoneVariants.push(`+1${normalizedPhone}`);
    phoneVariants.push(`+${normalizedPhone}`);
  }

  for (const variant of phoneVariants) {
    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("phone", variant)
      .single();
    if (customer) {
      customerId = customer.id;
      break;
    }
  }

  // Create customer if not found
  if (!customerId) {
    const { data: created } = await admin
      .from("customers")
      .insert({
        workspace_id: workspaceId,
        phone: normalizedPhone,
      })
      .select("id")
      .single();
    customerId = created?.id || null;
  }

  // Thread to existing open SMS ticket from this customer
  let ticketId: string | null = null;

  if (customerId) {
    const { data: existingTicket } = await admin
      .from("tickets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .eq("channel", "sms")
      .in("status", ["open", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (existingTicket) {
      ticketId = existingTicket.id;
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
      sms_message_id: messageSid || null,
    });

    // Reopen if closed/pending
    const { data: ticket } = await admin
      .from("tickets")
      .select("status, handled_by, ai_handled, assigned_to")
      .eq("id", ticketId)
      .single();

    const statusUpdate: Record<string, unknown> = {
      last_customer_reply_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (ticket && (ticket.status === "pending" || ticket.status === "closed")) {
      statusUpdate.status = "open";
    }
    await admin.from("tickets").update(statusUpdate).eq("id", ticketId);

    // Evaluate rules
    const { data: ticketData } = await admin.from("tickets").select("*").eq("id", ticketId).single();
    const { data: custData } = customerId
      ? await admin.from("customers").select("*").eq("id", customerId).single()
      : { data: null };
    await evaluateRules(workspaceId, "ticket.message_received", {
      ticket: ticketData || undefined,
      customer: custData || undefined,
      message: { body: messageBody, direction: "inbound", author_type: "customer" },
    });

    // Multi-turn AI: if ticket was AI-handled or unassigned, let AI continue
    if (ticketData) {
      const isAIHandled = ticketData.handled_by === "AI Agent" || ticketData.ai_handled;
      const isUnassigned = !ticketData.assigned_to;

      const { data: aiConfig } = await admin
        .from("ai_channel_config")
        .select("enabled")
        .eq("workspace_id", workspaceId)
        .eq("channel", "sms")
        .single();

      if (aiConfig?.enabled && (isAIHandled || isUnassigned)) {
        await inngest.send({
          name: "ai/reply-received",
          data: {
            workspace_id: workspaceId,
            ticket_id: ticketId,
            message_body: messageBody,
          },
        });
      }
    }
  } else {
    // Create new ticket
    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        channel: "sms",
        status: "open",
        subject: `SMS from ${normalizedPhone}`,
        sms_message_id: messageSid || null,
        last_customer_reply_at: new Date().toISOString(),
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
        sms_message_id: messageSid || null,
      });

      // Check if AI is enabled for SMS channel
      const { data: aiConfig } = await admin
        .from("ai_channel_config")
        .select("enabled")
        .eq("workspace_id", workspaceId)
        .eq("channel", "sms")
        .single();

      if (aiConfig?.enabled) {
        const { data: wsDelay } = await admin.from("workspaces").select("response_delays").eq("id", workspaceId).single();
        const delays = (wsDelay?.response_delays || { sms: 10 }) as Record<string, number>;
        const delaySec = delays.sms || 10;

        await admin.from("tickets").update({
          auto_reply_at: new Date(Date.now() + delaySec * 1000).toISOString(),
          pending_auto_reply: "AI is drafting a response...",
        }).eq("id", ticket.id);

        await inngest.send({
          name: "ai/draft-ticket",
          data: { workspace_id: workspaceId, ticket_id: ticket.id, channel: "sms", delay_seconds: delaySec },
        });
      }

      // Evaluate rules for new ticket
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

  return twimlResponse();
}

function twimlResponse() {
  return new NextResponse("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
