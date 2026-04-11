/**
 * Generic journey delivery — routes to the correct delivery method per channel.
 *
 * Email/Help Center → HTML CTA email with AI lead-in + button text
 * Chat → Embedded inline form (hides send input)
 * SMS/Meta DM → Plain text message with URL link
 * Social Comments → N/A (no journeys)
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendJourneyCTA } from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";
import { markFirstTouch } from "@/lib/first-touch";
import { getDeliveryChannel } from "@/lib/delivery-channel";
import crypto from "crypto";

type Admin = ReturnType<typeof createAdminClient>;

interface LaunchParams {
  workspaceId: string;
  ticketId: string;
  customerId: string;
  journeyId: string;
  journeyName: string;
  triggerIntent: string;
  channel: string;
  leadIn: string;       // AI-generated, tone-aware
  ctaText: string;      // AI-generated, action-specific
  prependAccountLinking?: boolean;
}

/**
 * Launch a journey for a ticket via the appropriate channel delivery.
 * Returns true if launched, false if channel doesn't support journeys.
 */
export async function launchJourneyForTicket(params: LaunchParams): Promise<boolean> {
  const { workspaceId, ticketId, customerId, journeyId, journeyName, triggerIntent, channel, leadIn, ctaText, prependAccountLinking } = params;
  const admin = createAdminClient();

  if (channel === "social_comments") return false;

  // Get journey definition config
  const { data: journeyDef } = await admin
    .from("journey_definitions")
    .select("id, config")
    .eq("id", journeyId)
    .single();

  if (!journeyDef) return false;

  // Build config — detect code-driven journeys (empty config or specific types)
  const rawConfig = journeyDef.config;
  const isEmptyConfig = !rawConfig || (Array.isArray(rawConfig) && rawConfig.length === 0) || (typeof rawConfig === "object" && !Array.isArray(rawConfig) && Object.keys(rawConfig as Record<string, unknown>).length === 0);

  let configSnapshot: Record<string, unknown>;
  if (isEmptyConfig) {
    // Code-driven journey — the mini-site uses journeyType to run the right executor
    configSnapshot = {
      codeDriven: true,
      journeyType: triggerIntent,
      ticketId,
      workspaceId,
    };
  } else {
    configSnapshot = rawConfig as Record<string, unknown>;
  }

  if (prependAccountLinking) {
    configSnapshot = { ...configSnapshot, prependAccountLinking: true };
  }

  // Create session
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await admin.from("journey_sessions").insert({
    workspace_id: workspaceId,
    journey_id: journeyId,
    customer_id: customerId,
    ticket_id: ticketId,
    token,
    token_expires_at: expiresAt,
    status: "pending",
    config_snapshot: configSnapshot,
  });

  // Get customer + workspace info
  const { data: customer } = await admin.from("customers")
    .select("email, first_name, phone")
    .eq("id", customerId).single();

  const { data: ws } = await admin.from("workspaces")
    .select("name, help_primary_color")
    .eq("id", workspaceId).single();

  const { data: ticket } = await admin.from("tickets")
    .select("subject, email_message_id")
    .eq("id", ticketId).single();

  // Get In-Reply-To for email threading
  let inReplyTo: string | null = ticket?.email_message_id || null;
  if (!inReplyTo) {
    const { data: lastMsg } = await admin.from("ticket_messages")
      .select("email_message_id")
      .eq("ticket_id", ticketId)
      .not("email_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    inReplyTo = lastMsg?.email_message_id || null;
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const journeyUrl = `${siteUrl}/journey/${token}`;

  // ── Channel-specific delivery ──
  // For chat: switch to email if customer has been idle
  const effectiveChannel = await getDeliveryChannel(ticketId, channel);
  const channelSwitched = effectiveChannel !== channel;

  if (effectiveChannel === "email" || effectiveChannel === "help_center") {
    // HTML CTA email
    if (!customer?.email) return false;
    await sendJourneyCTA({
      workspaceId,
      toEmail: customer.email,
      customerName: customer.first_name || "",
      journeyToken: token,
      contextMessage: leadIn,
      workspaceName: ws?.name || "Support",
      primaryColor: ws?.help_primary_color || undefined,
      subject: `Re: ${ticket?.subject || "Your request"}`,
      buttonLabel: ctaText,
      inReplyTo,
    });

    // Post external message record (visible in ticket conversation)
    const emailLabel = channelSwitched ? `<p style="font-size:12px;color:#6b7280;">📧 Sent via email (customer left chat)</p>` : "";
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: `${emailLabel}<p>${leadIn}</p>`,
    });

  } else if (effectiveChannel === "chat") {
    // Build inline form steps for the chat widget
    const { buildJourneySteps } = await import("@/lib/journey-step-builder");
    const built = await buildJourneySteps(workspaceId, triggerIntent, customerId, ticketId);

    if (built.steps.length > 0) {
      // Embed journey form as hidden comment — widget parses and renders InlineJourneyForm
      const journeyPayload = JSON.stringify({ token, steps: built.steps });
      const body = `${leadIn}<!--JOURNEY:${journeyPayload}-->`;
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId, direction: "outbound", visibility: "external",
        author_type: "system", body,
      });
    } else {
      // No steps (e.g. no unlinked accounts found) — fall back to CTA link
      const ctaHtml = `<p>${leadIn}</p><p><a href="${journeyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${ws?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">${ctaText}</a></p>`;
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId, direction: "outbound", visibility: "external",
        author_type: "system", body: ctaHtml,
      });
    }

  } else if (effectiveChannel === "sms") {
    // Plain text + URL
    const smsText = `${leadIn}\n\n${journeyUrl}`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: smsText,
    });
    // TODO: actually send via Twilio SMS
    // await sendSms(workspaceId, customer.phone, smsText);

  } else if (effectiveChannel === "meta_dm") {
    // Plain text + URL for DMs
    const dmText = `${leadIn}\n\n${journeyUrl}`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: dmText,
    });
    // TODO: send via Meta Send API
  }

  // ── Common post-delivery ──

  const deliveryNote = channelSwitched
    ? `[System] Journey "${journeyName}" delivered via email (chat customer idle). Token: ${token.slice(0, 8)}...`
    : `[System] Journey "${journeyName}" delivered via ${effectiveChannel}. Token: ${token.slice(0, 8)}...`;
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId, direction: "outbound", visibility: "internal",
    author_type: "system", body: deliveryNote,
  });

  await addTicketTag(ticketId, `j:${journeyName.toLowerCase().replace(/\s+/g, "_")}`);
  await markFirstTouch(ticketId, "journey");

  // Update journey history on ticket
  const { data: ticketData } = await admin.from("tickets")
    .select("journey_history").eq("id", ticketId).single();

  const history = (ticketData?.journey_history as { journey_id: string; journey_name: string; sent_at: string; nudged_at: string | null; completed: boolean }[]) || [];
  history.push({
    journey_id: journeyId,
    journey_name: journeyName,
    sent_at: new Date().toISOString(),
    nudged_at: null,
    completed: false,
  });

  await admin.from("tickets").update({
    journey_history: history,
    handled_by: `Journey: ${journeyName}`,
  }).eq("id", ticketId);

  return true;
}

/**
 * Re-nudge a journey that was already sent but not completed.
 * Haiku rewrites the lead-in to address why the customer needs to use the form.
 */
export async function nudgeJourney(
  workspaceId: string,
  ticketId: string,
  journeyEntry: { journey_id: string; journey_name: string },
  channel: string,
  customerMessage: string,
  personality: { name?: string; tone?: string } | null,
): Promise<boolean> {
  const admin = createAdminClient();

  // Find the existing session
  const { data: session } = await admin.from("journey_sessions")
    .select("token, token_expires_at, status")
    .eq("ticket_id", ticketId)
    .eq("journey_id", journeyEntry.journey_id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1).single();

  if (!session) return false;

  // Check if token is still valid
  const expired = new Date(session.token_expires_at) < new Date();
  let token = session.token;

  if (expired) {
    // Create new session with fresh token
    const { data: journeyDef } = await admin.from("journey_definitions")
      .select("id, config").eq("id", journeyEntry.journey_id).single();
    if (!journeyDef) return false;

    token = crypto.randomBytes(24).toString("hex");
    await admin.from("journey_sessions").insert({
      workspace_id: workspaceId,
      journey_id: journeyEntry.journey_id,
      customer_id: (await admin.from("tickets").select("customer_id").eq("id", ticketId).single()).data?.customer_id || null,
      ticket_id: ticketId,
      token,
      token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      config_snapshot: journeyDef.config,
    });
  }

  // Generate re-nudge lead-in with Haiku
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let nudgeText = `I understand your concern. To process this securely, please use the link below — it only takes a minute.`;

  if (apiKey) {
    const persona = personality ? `Your name is ${personality.name}. Tone: ${personality.tone}.` : "You are a friendly support agent.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 100,
        messages: [{ role: "user", content: `${persona} Never reveal AI. A customer needs to complete a "${journeyEntry.journey_name}" form but replied instead of clicking the link. Their message: "${customerMessage}". Write a brief, empathetic re-nudge (2-3 sentences max) explaining they need to use the secure form link. Acknowledge their frustration. Only the message, no markdown.` }],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      nudgeText = (data.content?.[0] as { text: string })?.text?.trim() || nudgeText;
    }
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const journeyUrl = `${siteUrl}/journey/${token}`;

  // Deliver based on channel (switch to email if chat customer idle)
  const nudgeChannel = await getDeliveryChannel(ticketId, channel);

  if (nudgeChannel === "email" || nudgeChannel === "help_center") {
    const { data: customer } = await admin.from("customers")
      .select("email, first_name").eq("id",
        (await admin.from("tickets").select("customer_id").eq("id", ticketId).single()).data?.customer_id || "").single();

    if (customer?.email) {
      const { data: ws } = await admin.from("workspaces").select("name, help_primary_color").eq("id", workspaceId).single();
      const { data: ticket } = await admin.from("tickets").select("subject").eq("id", ticketId).single();
      await sendJourneyCTA({
        workspaceId, toEmail: customer.email, customerName: customer.first_name || "",
        journeyToken: token, contextMessage: nudgeText, workspaceName: ws?.name || "Support",
        primaryColor: ws?.help_primary_color || undefined, subject: `Re: ${ticket?.subject || "Your request"}`,
        buttonLabel: `Complete ${journeyEntry.journey_name} →`, inReplyTo: ticketId,
      });
      if (nudgeChannel !== channel) {
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
          body: `[System] Re-nudge sent via email (chat customer idle).`,
        });
      }
    }
  } else if (nudgeChannel === "chat") {
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
    const nudgeJourneyUrl = `${siteUrl}/journey/${token}`;
    const { data: wsNudge } = await admin.from("workspaces").select("help_primary_color").eq("id", workspaceId).single();
    const nudgeCtaHtml = `<p>${nudgeText}</p><p><a href="${nudgeJourneyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${wsNudge?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">Complete ${journeyEntry.journey_name} →</a></p>`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external", author_type: "system",
      body: nudgeCtaHtml,
    });
  } else {
    // SMS / Meta DM
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external", author_type: "system",
      body: `${nudgeText}\n\n${journeyUrl}`,
    });
  }

  // Update journey history
  const { data: ticketData } = await admin.from("tickets").select("journey_history").eq("id", ticketId).single();
  const history = (ticketData?.journey_history as { journey_id: string; nudged_at: string | null }[]) || [];
  const entry = history.find(h => h.journey_id === journeyEntry.journey_id);
  if (entry) entry.nudged_at = new Date().toISOString();
  await admin.from("tickets").update({ journey_history: history }).eq("id", ticketId);

  await admin.from("ticket_messages").insert({
    ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
    body: `[System] Re-nudge sent for journey "${journeyEntry.journey_name}" via ${channel}`,
  });

  return true;
}
