import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResendClient } from "@/lib/email";

// POST: create inbound email webhook on Resend
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const client = await getResendClient(workspaceId);
  if (!client) {
    return NextResponse.json({ error: "Resend not configured" }, { status: 400 });
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const inboundUrl = `${siteUrl}/api/webhooks/email`;
  const trackingUrl = `${siteUrl}/api/webhooks/resend-events`;

  try {
    // Check existing webhooks
    const { data: existingList } = await client.resend.webhooks.list();
    const webhooks = Array.isArray(existingList) ? existingList : (existingList as unknown as { data: { endpoint: string; id: string }[] })?.data || [];
    const inboundExists = webhooks.find((wh: { endpoint: string }) => wh.endpoint === inboundUrl);
    const trackingExists = webhooks.find((wh: { endpoint: string }) => wh.endpoint === trackingUrl);

    const results: string[] = [];

    // Create inbound webhook if missing
    if (!inboundExists) {
      const { data: wh, error } = await client.resend.webhooks.create({
        endpoint: inboundUrl,
        events: ["email.received"],
      });
      if (error) results.push(`Inbound failed: ${error.message}`);
      else results.push("Inbound webhook created");
    } else {
      results.push("Inbound webhook already active");
    }

    // Create tracking webhook if missing
    if (!trackingExists) {
      const { data: wh, error } = await client.resend.webhooks.create({
        endpoint: trackingUrl,
        events: ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced", "email.complained"],
      });
      if (error) results.push(`Tracking failed: ${error.message}`);
      else results.push("Email tracking webhook created (open/click/bounce)");
    } else {
      results.push("Tracking webhook already active");
    }

    return NextResponse.json({
      success: true,
      message: results.join(". "),
      inbound_configured: !!inboundExists || results[0]?.includes("created"),
      tracking_configured: !!trackingExists || results[1]?.includes("created"),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create webhook" },
      { status: 500 }
    );
  }
}

// GET: check if webhook exists
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const client = await getResendClient(workspaceId);
  if (!client) {
    return NextResponse.json({ configured: false, reason: "Resend not configured" });
  }

  try {
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
    const inboundUrl = `${siteUrl}/api/webhooks/email`;
    const trackingUrl = `${siteUrl}/api/webhooks/resend-events`;

    const { data: whList } = await client.resend.webhooks.list();
    const whArr = Array.isArray(whList) ? whList : (whList as unknown as { data: { endpoint: string; id: string }[] })?.data || [];
    const inbound = whArr.find((wh: { endpoint: string }) => wh.endpoint === inboundUrl);
    const tracking = whArr.find((wh: { endpoint: string }) => wh.endpoint === trackingUrl);

    return NextResponse.json({
      configured: !!inbound,
      tracking_configured: !!tracking,
      webhook_id: inbound?.id || null,
      tracking_webhook_id: tracking?.id || null,
    });
  } catch {
    return NextResponse.json({ configured: false, reason: "Failed to check" });
  }
}
