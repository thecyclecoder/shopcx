/**
 * Universal email event tracking — logs every outbound email and
 * processes Resend webhook events (delivered, opened, clicked, bounced).
 * Works for all email types: ticket replies, crisis, CSAT, dunning, marketing.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";

/**
 * Generate a tracking token and inject a self-hosted open tracking pixel.
 * Call BEFORE sending the email. After sending, call mapTrackingToken()
 * to link the token to the actual resend email ID.
 *
 * Only add to emails we want to track (crisis, marketing — NOT transactional).
 */
export function injectTrackingPixel(html: string): { html: string; trackingToken: string } {
  const trackingToken = crypto.randomUUID();
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const pixelUrl = `${siteUrl}/api/track/open/${trackingToken}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`;

  let tracked: string;
  if (html.includes("</div>")) {
    const lastDiv = html.lastIndexOf("</div>");
    tracked = html.slice(0, lastDiv) + pixel + html.slice(lastDiv);
  } else {
    tracked = html + pixel;
  }

  return { html: tracked, trackingToken };
}

/**
 * After sending, map the tracking token to the actual resend email ID.
 * This allows the pixel endpoint to find the right email event.
 */
export async function mapTrackingToken(
  trackingToken: string,
  resendEmailId: string,
  workspaceId: string,
  recipientEmail: string,
  subject: string,
  ticketId?: string | null,
  customerId?: string | null,
): Promise<void> {
  const admin = createAdminClient();
  // Insert a "sent" event with the tracking token as an alias
  await admin.from("email_events").upsert({
    workspace_id: workspaceId,
    resend_email_id: trackingToken, // The pixel will hit this ID
    event_type: "sent",
    occurred_at: new Date().toISOString(),
    recipient_email: recipientEmail,
    subject,
    ticket_id: ticketId || null,
    customer_id: customerId || null,
    metadata: { resend_email_id: resendEmailId, tracked: true },
  }, { onConflict: "resend_email_id,event_type,occurred_at" });

  // Also log the actual resend ID
  await logEmailSent({
    workspaceId,
    resendEmailId,
    recipientEmail,
    subject,
    ticketId,
    customerId,
  });
}

/**
 * Rewrite links in email HTML to pass through our click tracking redirect.
 * Only rewrites http/https links, skips mailto: and tel: links.
 */
export function injectTrackingLinks(html: string, trackingToken: string): string {
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  return html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url: string) => {
      // Don't track links to our own tracking endpoints
      if (url.includes("/api/track/")) return match;
      const trackUrl = `${siteUrl}/api/track/click/${trackingToken}?url=${encodeURIComponent(url)}`;
      return `href="${trackUrl}"`;
    },
  );
}

/**
 * Convenience: inject both tracking pixel AND link tracking in one call.
 */
export function injectFullTracking(html: string): { html: string; trackingToken: string } {
  const { html: withPixel, trackingToken } = injectTrackingPixel(html);
  const withLinks = injectTrackingLinks(withPixel, trackingToken);
  return { html: withLinks, trackingToken };
}

const STATUS_HIERARCHY: Record<string, number> = {
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 0, // bounced is a terminal state, not a progression
  complained: 0,
};

/**
 * Log an outbound email send. Call this after every successful email send.
 */
export async function logEmailSent(params: {
  workspaceId: string;
  resendEmailId: string;
  recipientEmail: string;
  subject: string;
  ticketId?: string | null;
  customerId?: string | null;
}): Promise<void> {
  const admin = createAdminClient();

  await admin.from("email_events").upsert({
    workspace_id: params.workspaceId,
    resend_email_id: params.resendEmailId,
    event_type: "sent",
    occurred_at: new Date().toISOString(),
    recipient_email: params.recipientEmail,
    subject: params.subject,
    ticket_id: params.ticketId || null,
    customer_id: params.customerId || null,
  }, { onConflict: "resend_email_id,event_type,occurred_at" });

  // Update ticket_message if linked
  if (params.ticketId) {
    await admin.from("ticket_messages")
      .update({ resend_email_id: params.resendEmailId, email_status: "sent" })
      .eq("ticket_id", params.ticketId)
      .eq("direction", "outbound")
      .is("resend_email_id", null)
      .order("created_at", { ascending: false })
      .limit(1);
  }

  // Log customer event
  if (params.customerId) {
    const { logCustomerEvent } = await import("@/lib/customer-events");
    await logCustomerEvent({
      workspaceId: params.workspaceId,
      customerId: params.customerId,
      eventType: "email.sent",
      source: "resend",
      summary: `Sent: ${params.subject}`,
      properties: {
        resend_email_id: params.resendEmailId,
        ticket_id: params.ticketId,
        recipient: params.recipientEmail,
      },
    });
  }
}

/**
 * Process a Resend webhook event (delivered, opened, clicked, bounced).
 */
export async function processResendEvent(params: {
  workspaceId: string;
  resendEmailId: string;
  eventType: string;
  occurredAt: string;
  recipientEmail?: string;
  subject?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();

  // Upsert email event (dedup by resend_email_id + event_type + occurred_at)
  await admin.from("email_events").upsert({
    workspace_id: params.workspaceId,
    resend_email_id: params.resendEmailId,
    event_type: params.eventType,
    occurred_at: params.occurredAt,
    recipient_email: params.recipientEmail || null,
    subject: params.subject || null,
    metadata: params.metadata || {},
  }, { onConflict: "resend_email_id,event_type,occurred_at" });

  // Update ticket_message email_status (only advance forward)
  const { data: msg } = await admin.from("ticket_messages")
    .select("id, ticket_id, email_status")
    .eq("resend_email_id", params.resendEmailId)
    .maybeSingle();

  if (msg) {
    const currentRank = STATUS_HIERARCHY[msg.email_status || ""] || 0;
    const newRank = STATUS_HIERARCHY[params.eventType] || 0;
    if (newRank > currentRank || params.eventType === "bounced") {
      await admin.from("ticket_messages")
        .update({ email_status: params.eventType })
        .eq("id", msg.id);
    }

    // Also set ticket_id and customer_id on the email_event if we found the message
    const { data: ticket } = await admin.from("tickets")
      .select("id, customer_id")
      .eq("id", msg.ticket_id)
      .single();

    if (ticket) {
      await admin.from("email_events")
        .update({ ticket_id: ticket.id, customer_id: ticket.customer_id })
        .eq("resend_email_id", params.resendEmailId)
        .eq("event_type", params.eventType);

      // Log customer event for opens and clicks
      if (ticket.customer_id && (params.eventType === "opened" || params.eventType === "clicked")) {
        const { logCustomerEvent } = await import("@/lib/customer-events");
        const summary = params.eventType === "opened"
          ? `Opened email: ${params.subject || "unknown"}`
          : `Clicked link in email: ${(params.metadata?.url as string) || params.subject || "unknown"}`;

        await logCustomerEvent({
          workspaceId: params.workspaceId,
          customerId: ticket.customer_id,
          eventType: `email.${params.eventType}`,
          source: "resend",
          summary,
          properties: {
            resend_email_id: params.resendEmailId,
            ticket_id: ticket.id,
            subject: params.subject,
            ...(params.metadata || {}),
          },
        });
      }
    }
  }
}
