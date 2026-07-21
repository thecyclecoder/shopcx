/**
 * Generic journey delivery — routes to the correct delivery method per channel.
 *
 * Email/Help Center → HTML CTA email with AI lead-in + button text
 * Chat → CTA link bubble in the chat window
 * Portal → CTA bubble in the portal thread + emailed to the customer
 * SMS/Meta DM → Plain text message with URL link
 * Social Comments → N/A (no journeys)
 *
 * Delivery fails loud: if no branch matches the effective channel, we
 * write an internal error note and return false — never a phantom
 * 'delivered' note with no message sent.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { sendJourneyCTA } from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";
import { markFirstTouch } from "@/lib/first-touch";
import { getDeliveryChannel } from "@/lib/delivery-channel";
import crypto from "crypto";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { emitInlineAgentHeartbeat } from "@/lib/control-tower/heartbeat";
import { INLINE_AGENT_IDS } from "@/lib/control-tower/registry";

type Admin = ReturnType<typeof createAdminClient>;

/** Strip any trailing arrow / chevron / "→" / "»" that an upstream caller
 *  may have appended to ctaText. The styled-button render adds its own
 *  chevron, so without this we get duplicates like "Cancel Subscription → →". */
function cleanCtaLabel(s: string): string {
  return (s || "").replace(/[\s→»>]+$/u, "").trim();
}

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

// Every journey is live-rendered. The orchestrator's only job is to
// pick a journey id + (optionally) a subscription id and insert a
// session row. The API loader at /api/journey/[token] handles ALL
// data fetching, step building, and rendering at click time. No
// config_snapshot, no embedded forms, no AI-generated step trees.
//
// We deliberately killed two patterns that lived here historically:
//   1. The chat `<!--JOURNEY:{...}-->` embedded form. Customers
//      typing inline ("just send me the link") routinely tripped the
//      widget's parser; the rendered form lagged actual state by
//      whatever delta the orchestrator was working with; and the
//      same flow had to maintain two render paths (widget inline +
//      mini-site).
//   2. The "build steps once, freeze into config_snapshot" pattern
//      where subscription / address / loyalty data went stale the
//      moment the customer didn't click for a minute.
// Single path now: send a CTA, mini-site rebuilds at click.

/**
 * Public entry — the inline journey-delivery AI agent (`ai:journey-delivery` in the Control
 * Tower registry). Runs launchJourneyForTicketInner and emits ONE loop_heartbeats beat at the
 * END of the run in a try/finally (control-tower-agent-coverage spec). ok:false on a thrown
 * run OR a non-delivery (returned false) — except a `social_comments` channel, where journeys
 * are N/A by design (an intentional skip ⇒ ok:true).
 */
export async function launchJourneyForTicket(params: LaunchParams): Promise<boolean> {
  const startedAt = Date.now();
  let delivered: boolean | null = null;
  let threw: unknown = null;
  try {
    delivered = await launchJourneyForTicketInner(params);
    return delivered;
  } catch (e) {
    threw = e;
    throw e;
  } finally {
    const intentionalSkip = delivered === false && params.channel === "social_comments";
    await emitInlineAgentHeartbeat(INLINE_AGENT_IDS.journeyDelivery, {
      ok: !threw && (delivered === true || intentionalSkip),
      produced: threw ? { error: "exception" } : { delivered: delivered === true, journey: params.journeyName, ticket: params.ticketId, channel: params.channel },
      detail: threw
        ? `threw: ${errText(threw)}`
        : delivered
        ? `launched ${params.journeyName} via ${params.channel}`
        : intentionalSkip
        ? "skipped (social_comments — journeys N/A)"
        : `not delivered (${params.journeyName} / ${params.channel})`,
      durationMs: Date.now() - startedAt,
    });
  }
}

/**
 * Launch a journey for a ticket via the appropriate channel delivery.
 * Returns true if launched, false if channel doesn't support journeys.
 */
async function launchJourneyForTicketInner(params: LaunchParams): Promise<boolean> {
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

  // Every journey is live-rendered. Snapshot is purely identification —
  // the loader fetches everything it needs at click time.
  let configSnapshot: Record<string, unknown> = {
    codeDriven: true,
    liveRendered: true,
    journeyType: triggerIntent,
    ticketId,
    workspaceId,
  };

  if (prependAccountLinking) {
    configSnapshot = { ...configSnapshot, prependAccountLinking: true };
  }

  // Every link pulls fresh data on every click, so a 24h expiry adds
  // zero security value and a lot of "I tried to use your link, it
  // expired" friction. Default to 30 days.
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

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

  // Track whether a branch below actually emitted a customer-facing
  // message. If nothing did, delivery FAILED — we must not write a
  // phantom 'delivered' note/tag/history (the bug that surfaced on
  // ticket 3bb28cfd, where a portal journey logged success but inserted
  // no CTA and sent no email).
  let delivered = false;

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
      // Every link lives 30 days + pulls fresh data on every click, so
      // we don't bother surfacing an expiry line in the email.
      expiryHours: null,
    });

    // Use a CLEAN HTML for the dashboard display — no inline colors,
    // no fixed background. The dashboard's prose-invert + bubble bg
    // handles theming. The rich email HTML (ctaResult.html) is what
    // the customer actually receives via Resend; the dashboard preview
    // just needs to be readable in both light and dark dashboard themes.
    // Surfaced on ticket 789ebbc5: the email's #18181b dark-text-on-
    // light-bg styling rendered as unreadable dark text on the
    // dashboard's purple message bubble.
    const journeyUrlForPreview = `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/journey/${token}`;
    const emailLabel = channelSwitched
      ? `<p><em>Sent via email (customer left chat)</em></p>`
      : "";
    const expiryNote = ""; // every link lives 30 days; not worth surfacing
    // Strip any trailing arrow / chevron callers may have included on
    // ctaText — the styled-button render is the single source of the
    // chevron, otherwise we end up with "Cancel Subscription → →"
    // (caught on ticket c769e4ff).
    const cleanCta = cleanCtaLabel(ctaText);
    const buttonColor = ws?.help_primary_color || "#4f46e5";
    // Ticket-side preview now renders as the SAME styled button the
    // customer sees in the email, not a bare hyperlink. Agents
    // viewing the ticket get a faithful preview, customers in the
    // email get the proper CTA. Inline styles only so it survives
    // the dashboard's prose render + the mail client.
    const ctaButton = `<a href="${journeyUrlForPreview}" style="display:inline-block;margin:8px 0;padding:12px 24px;background:${buttonColor};color:#ffffff !important;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;line-height:1;">${cleanCta} &rsaquo;</a>`;
    const ticketMsgBody = `${emailLabel}<p>${leadIn}</p><p>${ctaButton}</p>${expiryNote}`;

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
    delivered = true;

  } else if (effectiveChannel === "chat") {
    // Single render path — CTA link to the mini-site. No embedded
    // form, no buildJourneySteps at send time. The widget and the
    // pending-send Inngest function still parse `<!--JOURNEY:{...}-->`
    // tags for backward compatibility with tickets already in flight,
    // but new sessions never produce them.
    const ctaHtml = `<p>${leadIn}</p><p><a href="${journeyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${ws?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">${ctaText}</a></p>`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: ctaHtml,
    });
    delivered = true;

  } else if (effectiveChannel === "portal") {
    // Portal channel — insert the CTA bubble into the portal conversation
    // window (mirrors the chat branch), then ALWAYS email it to the
    // customer the same way every other portal reply is delivered
    // (deliver-pending-send.ts / unified-ticket-handler.ts). The portal
    // submitter isn't necessarily watching the thread, so the email is
    // the guaranteed delivery. The plain <a> button HTML renders fine in
    // that email.
    const ctaHtml = `<p>${leadIn}</p><p><a href="${journeyUrl}" style="display:inline-block;margin:15px 0;padding:10px 20px;background:${ws?.help_primary_color || "#4f46e5"};color:#ffffff !important;text-decoration:none;border-radius:8px;font-weight:600;">${ctaText}</a></p>`;
    const { data: inserted } = await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: ctaHtml,
    }).select("id").single();

    const { sendPortalThreadEmail } = await import("@/lib/portal/portal-thread-email");
    const msgId = await sendPortalThreadEmail(admin, workspaceId, ticketId);
    if (msgId && inserted?.id) {
      await admin.from("ticket_messages")
        .update({ resend_email_id: msgId, email_status: "sent" })
        .eq("id", inserted.id);
    }
    delivered = true;

  } else if (effectiveChannel === "sms") {
    // Plain text + URL
    const smsText = `${leadIn}\n\n${journeyUrl}`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: smsText,
    });
    delivered = true;
    // TODO: actually send via Twilio SMS
    // await sendSms(workspaceId, customer.phone, smsText);

  } else if (effectiveChannel === "meta_dm") {
    // Plain text + URL for DMs
    const dmText = `${leadIn}\n\n${journeyUrl}`;
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external",
      author_type: "system", body: dmText,
    });
    delivered = true;
    // TODO: send via Meta Send API
  }

  // ── Fail loud ──
  // No branch emitted a customer-facing message → delivery FAILED. Write
  // an internal error note (so dashboards never show a phantom send) and
  // return false instead of falling through to the 'delivered' note/tag/
  // journey_history block below.
  if (!delivered) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "internal",
      author_type: "system",
      body: `[System] Journey delivery FAILED: no delivery path for channel ${effectiveChannel}`,
    });
    return false;
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
        model: HAIKU_MODEL, max_tokens: 100,
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
