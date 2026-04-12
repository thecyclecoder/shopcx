/**
 * Email click tracking redirect.
 * Logs the click event, then redirects to the original URL.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { processResendEvent } from "@/lib/email-tracking";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  const url = new URL(request.url);
  const dest = url.searchParams.get("url");

  if (!dest) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  // Log click asynchronously
  (async () => {
    try {
      const admin = createAdminClient();
      const { data: event } = await admin.from("email_events")
        .select("workspace_id, recipient_email, subject")
        .eq("resend_email_id", trackingId)
        .eq("event_type", "sent")
        .maybeSingle();

      if (event?.workspace_id) {
        await processResendEvent({
          workspaceId: event.workspace_id,
          resendEmailId: trackingId,
          eventType: "clicked",
          occurredAt: new Date().toISOString(),
          recipientEmail: event.recipient_email || undefined,
          subject: event.subject || undefined,
          metadata: { url: dest },
        });
      }
    } catch (err) {
      console.error("[Track click] Error:", err);
    }
  })();

  return NextResponse.redirect(dest, 302);
}
