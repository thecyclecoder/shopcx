/**
 * Resend tracking webhook — handles email.sent, email.delivered,
 * email.opened, email.clicked, email.bounced events.
 * Routes to the universal email tracking system.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processResendEvent } from "@/lib/email-tracking";

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = payload.type as string;
  const data = payload.data as Record<string, unknown> | undefined;

  if (!data || !eventType) {
    return NextResponse.json({ ok: true });
  }

  // Skip inbound emails — handled by /api/webhooks/email
  if (eventType === "email.received") {
    return NextResponse.json({ ok: true });
  }

  // Map Resend event types to our simplified types
  const typeMap: Record<string, string> = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.opened": "opened",
    "email.clicked": "clicked",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.delivery_delayed": "delivered", // treat as delivered
  };

  const mappedType = typeMap[eventType];
  if (!mappedType) {
    return NextResponse.json({ ok: true, skipped: eventType });
  }

  const resendEmailId = data.email_id as string;
  if (!resendEmailId) {
    return NextResponse.json({ ok: true, skipped: "no email_id" });
  }

  // Resolve workspace from the "from" field domain
  const fromField = (data.from as string) || "";
  const domainMatch = fromField.match(/@([^>]+)/);
  const fromDomain = domainMatch?.[1] || "";

  const admin = createAdminClient();

  let workspaceId: string | null = null;

  // Try matching by from domain
  if (fromDomain) {
    const { data: ws } = await admin.from("workspaces")
      .select("id")
      .eq("resend_domain", fromDomain)
      .maybeSingle();
    workspaceId = ws?.id || null;
  }

  // Fallback: look up via existing email_events or ticket_messages
  if (!workspaceId) {
    const { data: existing } = await admin.from("email_events")
      .select("workspace_id")
      .eq("resend_email_id", resendEmailId)
      .limit(1)
      .maybeSingle();
    workspaceId = existing?.workspace_id || null;
  }

  if (!workspaceId) {
    const { data: msg } = await admin.from("ticket_messages")
      .select("ticket_id")
      .eq("resend_email_id", resendEmailId)
      .limit(1)
      .maybeSingle();
    if (msg?.ticket_id) {
      const { data: t } = await admin.from("tickets").select("workspace_id").eq("id", msg.ticket_id).single();
      workspaceId = t?.workspace_id || null;
    }
  }

  if (!workspaceId) {
    // Can't resolve workspace — log and skip
    console.log(`[Resend webhook] Could not resolve workspace for email ${resendEmailId} from ${fromDomain}`);
    return NextResponse.json({ ok: true, skipped: "no workspace" });
  }

  try {
    await processResendEvent({
      workspaceId,
      resendEmailId,
      eventType: mappedType,
      occurredAt: (data.created_at as string) || new Date().toISOString(),
      recipientEmail: Array.isArray(data.to) ? data.to[0] : (data.to as string) || undefined,
      subject: data.subject as string | undefined,
      metadata: eventType === "email.clicked"
        ? { url: (data.click as { link?: string })?.link || (data.click as { url?: string })?.url }
        : eventType === "email.bounced"
        ? { bounce: data.bounce }
        : undefined,
    });
  } catch (err) {
    console.error(`[Resend webhook] Error processing ${eventType}:`, err);
  }

  return NextResponse.json({ ok: true, event: eventType });
}
