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
  const webhookUrl = `${siteUrl}/api/webhooks/email`;

  try {
    // Check if webhook already exists
    const { data: existingList } = await client.resend.webhooks.list();
    const webhooks = Array.isArray(existingList) ? existingList : (existingList as unknown as { data: { url: string; id: string }[] })?.data || [];
    const alreadyExists = webhooks.find(
      (wh: { url: string }) => wh.url === webhookUrl
    );

    if (alreadyExists) {
      return NextResponse.json({
        success: true,
        message: "Webhook already configured",
        webhook_id: alreadyExists.id,
      });
    }

    // Create webhook for email.received events
    const { data: webhook, error } = await client.resend.webhooks.create({
      endpoint: webhookUrl,
      events: ["email.received"],
    });

    if (error) {
      return NextResponse.json({ error: `Failed to create webhook: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: "Inbound email webhook created",
      webhook_id: webhook?.id,
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
    const webhookUrl = `${siteUrl}/api/webhooks/email`;

    const { data: whList } = await client.resend.webhooks.list();
    const whArr = Array.isArray(whList) ? whList : (whList as unknown as { data: { url: string; id: string }[] })?.data || [];
    const found = whArr.find(
      (wh: { url: string }) => wh.url === webhookUrl
    );

    return NextResponse.json({
      configured: !!found,
      webhook_id: found?.id || null,
    });
  } catch {
    return NextResponse.json({ configured: false, reason: "Failed to check" });
  }
}
