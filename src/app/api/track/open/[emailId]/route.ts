/**
 * Email open tracking pixel — 1x1 transparent GIF.
 * When an email client loads this image, we log the open event.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { processResendEvent } from "@/lib/email-tracking";

// 1x1 transparent GIF
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(
  request: Request,
  { params }: { params: Promise<{ emailId: string }> },
) {
  const { emailId } = await params;

  // Log open asynchronously — don't block the pixel response
  (async () => {
    try {
      const admin = createAdminClient();

      // Find the email event to get workspace info
      const { data: event } = await admin.from("email_events")
        .select("workspace_id, recipient_email, subject")
        .eq("resend_email_id", emailId)
        .eq("event_type", "sent")
        .maybeSingle();

      if (event?.workspace_id) {
        await processResendEvent({
          workspaceId: event.workspace_id,
          resendEmailId: emailId,
          eventType: "opened",
          occurredAt: new Date().toISOString(),
          recipientEmail: event.recipient_email || undefined,
          subject: event.subject || undefined,
        });
      }
    } catch (err) {
      console.error("[Track pixel] Error:", err);
    }
  })();

  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}
