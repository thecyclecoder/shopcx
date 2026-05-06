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
  subscriptionId?: string;  // Optional — orchestrator can pass this when it knows
                            // which sub the customer is referencing. Mini-site
                            // skips the picker step when set.
}

// Cancel journey is fully live-rendered by the mini-site. The orchestrator's
// only job is to pick the right ids and insert a session row; the API loader
// at /api/journey/[token] handles all data fetching, step-building, and
// rendering. See feedback_orchestrator_minimal_payload memory entry.
const LIVE_RENDERED_INTENTS = new Set([
  "cancel_subscription",
  "cancel",
]);

/**
 * Launch a journey for a ticket via the appropriate channel delivery.
 * Returns true if launched, false if channel doesn't support journeys.
 */
export async function launchJourneyForTicket(params: LaunchParams): Promise<boolean> {
  const { workspaceId, ticketId, customerId, journeyId, journeyName, triggerIntent, channel, leadIn, ctaText, prependAccountLinking, subscriptionId } = params;
  const admin = createAdminClient();

  if (channel === "social_comments") return false;

  // Defensive guard: if this is an account_linking journey AND we've already
  // sent one on this ticket, AND the customer's most recent inbound message
  // contains an email address, try linking directly via that email instead of
  // bouncing them through the form again. Sonnet should already prefer the
  // direct action via prompt rule, but this catches the case where it doesn't.
  if (triggerIntent === "account_linking") {
    const { data: prior } = await admin.from("journey_sessions")
      .select("id").eq("ticket_id", ticketId).eq("trigger_intent", "account_linking").limit(1);
    if (prior?.length) {
      const { data: lastInbound } = await admin.from("ticket_messages")
        .select("body")
        .eq("ticket_id", ticketId).eq("direction", "inbound")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const text = (lastInbound?.body || "").replace(/<[^>]+>/g, " ");
      const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      if (emailMatch) {
        const email = emailMatch[0].toLowerCase();
        const { data: target } = await admin.from("customers")
          .select("id, email").eq("workspace_id", workspaceId).ilike("email", email).maybeSingle();
        if (target && target.id !== customerId) {
          const { data: ownerLink } = await admin.from("customer_links")
            .select("group_id, is_primary").eq("customer_id", customerId).maybeSingle();
          const { data: targetLink } = await admin.from("customer_links")
            .select("group_id").eq("customer_id", target.id).maybeSingle();
          const alreadyLinked = ownerLink && targetLink && ownerLink.group_id === targetLink.group_id;
          if (!alreadyLinked) {
            const groupId = ownerLink?.group_id || targetLink?.group_id || crypto.randomUUID();
            if (!ownerLink) {
              await admin.from("customer_links").upsert({
                customer_id: customerId, workspace_id: workspaceId, group_id: groupId, is_primary: true,
              }, { onConflict: "customer_id" });
            }
            await admin.from("customer_links").upsert({
              customer_id: target.id, workspace_id: workspaceId, group_id: groupId, is_primary: false,
            }, { onConflict: "customer_id" });
            await addTicketTag(ticketId, "link");
            await admin.from("ticket_messages").insert({
              ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
              body: `[System] Auto-linked ${target.email} from customer's text instead of re-sending the account_linking form (already sent ${prior.length} time(s)).`,
            });
          }
          // Skip form delivery — link is in place. Caller treats this as launched.
          return true;
        }
      }
    }
  }

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

  const isLiveRendered = LIVE_RENDERED_INTENTS.has(triggerIntent);

  let configSnapshot: Record<string, unknown>;
  if (isLiveRendered) {
    // Live-rendered journey — orchestrator's job is to pick ids; the
    // mini-site loader does all data fetching and step building at
    // click time. No builder call here, no snapshot to go stale.
    configSnapshot = {
      codeDriven: true,
      liveRendered: true,
      journeyType: triggerIntent,
      ticketId,
      workspaceId,
    };
  } else if (isEmptyConfig) {
    // Code-driven journey (legacy snapshot path) — kept for journeys
    // that haven't migrated to live-rendered yet.
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
    subscription_id: subscriptionId || null,
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
    // HTML CTA email — sendJourneyCTA returns the rendered HTML and
    // Resend message ID so we store the exact email body in
    // ticket_messages and wire up the same email tracking as any
    // other outbound. Agent sees in the dashboard exactly what the
    // customer got — no "separate email" / lead-in-only mismatch.
    if (!customer?.email) return false;
    const ctaResult = await sendJourneyCTA({
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

    const emailLabel = channelSwitched ? `<p style="font-size:12px;color:#6b7280;">📧 Sent via email (customer left chat)</p>` : "";
    const ticketMsgBody = `${emailLabel}${ctaResult.html || `<p>${leadIn}</p>`}`;

    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "external",
      author_type: "system",
      body: ticketMsgBody,
      sent_at: new Date().toISOString(),
      resend_email_id: ctaResult.messageId || null,
      email_status: ctaResult.messageId ? "sent" : null,
      email_message_id: ctaResult.messageId ? `<${ctaResult.messageId}@resend.dev>` : null,
    });

    // Future inbound replies thread back here: set the ticket's
    // email_message_id to this CTA's Message-ID if not already set.
    if (ctaResult.messageId && !ticket?.email_message_id) {
      await admin.from("tickets")
        .update({ email_message_id: `<${ctaResult.messageId}@resend.dev>` })
        .eq("id", ticketId);
    }

    // Universal email tracking — same telemetry as a normal sendTicketReply
    if (ctaResult.messageId) {
      const { logEmailSent } = await import("@/lib/email-tracking");
      await logEmailSent({
        workspaceId,
        resendEmailId: ctaResult.messageId,
        recipientEmail: customer.email,
        subject: `Re: ${ticket?.subject || "Your request"}`,
        ticketId,
        customerId,
      });
    }

  } else if (effectiveChannel === "chat") {
    // Live-rendered journeys (cancel) always use a CTA link in chat —
    // mini-site is the single rendering path. Drops the inline embed
    // and its associated bug surface (out-of-sync snapshot, half-built
    // steps, etc.). See feedback_orchestrator_minimal_payload.
    if (isLiveRendered) {
      const ctaHtml = `<p>${leadIn}</p><p><a href="${journeyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${ws?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">${ctaText}</a></p>`;
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId, direction: "outbound", visibility: "external",
        author_type: "system", body: ctaHtml,
      });
    } else {
      // Legacy snapshot-based journeys still embed inline in chat.
      const { buildJourneySteps } = await import("@/lib/journey-step-builder");
      const built = await buildJourneySteps(workspaceId, triggerIntent, customerId, ticketId);

      if (built.steps.length > 0) {
        const journeyPayload = JSON.stringify({ token, steps: built.steps, ctaText });
        const body = `${leadIn}<!--JOURNEY:${journeyPayload}-->`;
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId, direction: "outbound", visibility: "external",
          author_type: "system", body,
        });
      } else {
        const ctaHtml = `<p>${leadIn}</p><p><a href="${journeyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${ws?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">${ctaText}</a></p>`;
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId, direction: "outbound", visibility: "external",
          author_type: "system", body: ctaHtml,
        });
      }
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
