import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import { randomBytes } from "crypto";

async function getAmplifierAuth(admin: ReturnType<typeof createAdminClient>, workspaceId: string) {
  const { data: workspace } = await admin
    .from("workspaces")
    .select("amplifier_api_key_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.amplifier_api_key_encrypted) return null;

  const apiKey = decrypt(workspace.amplifier_api_key_encrypted);
  return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}

// GET — list registered webhooks
export async function GET(
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

  const auth = await getAmplifierAuth(admin, workspaceId);
  if (!auth) return NextResponse.json({ error: "Amplifier not connected" }, { status: 400 });

  // Get stored webhook IDs
  const { data: workspace } = await admin
    .from("workspaces")
    .select("amplifier_webhook_received_id, amplifier_webhook_shipped_id")
    .eq("id", workspaceId)
    .single();

  const res = await fetch("https://api.amplifier.com/webhooks", {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch webhooks from Amplifier" }, { status: 502 });
  }

  const data = await res.json();
  const webhooks = data.data || [];

  // Check if our webhooks are registered
  const receivedId = workspace?.amplifier_webhook_received_id;
  const shippedId = workspace?.amplifier_webhook_shipped_id;
  const receivedRegistered = receivedId && webhooks.some((w: { id: string }) => w.id === receivedId);
  const shippedRegistered = shippedId && webhooks.some((w: { id: string }) => w.id === shippedId);

  return NextResponse.json({
    registered: receivedRegistered && shippedRegistered,
    received: receivedRegistered ? { id: receivedId } : null,
    shipped: shippedRegistered ? { id: shippedId } : null,
  });
}

// POST — register webhooks
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

  const auth = await getAmplifierAuth(admin, workspaceId);
  if (!auth) return NextResponse.json({ error: "Amplifier not connected" }, { status: 400 });

  // Generate webhook secret token
  const token = randomBytes(32).toString("hex");
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const webhookUrl = `${siteUrl}/api/webhooks/amplifier?token=${token}`;

  const errors: string[] = [];
  let receivedId: string | null = null;
  let shippedId: string | null = null;

  // Register order.received webhook
  const receivedRes = await fetch("https://api.amplifier.com/webhooks", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "order.received", url: webhookUrl }),
  });

  if (receivedRes.ok) {
    const data = await receivedRes.json();
    receivedId = data.id;
  } else {
    errors.push(`order.received: ${receivedRes.status}`);
  }

  // Register order.shipped webhook
  const shippedRes = await fetch("https://api.amplifier.com/webhooks", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "order.shipped", url: webhookUrl }),
  });

  if (shippedRes.ok) {
    const data = await shippedRes.json();
    shippedId = data.id;
  } else {
    errors.push(`order.shipped: ${shippedRes.status}`);
  }

  // Store token and webhook IDs
  await admin
    .from("workspaces")
    .update({
      amplifier_webhook_token_encrypted: encrypt(token),
      amplifier_webhook_received_id: receivedId,
      amplifier_webhook_shipped_id: shippedId,
    })
    .eq("id", workspaceId);

  return NextResponse.json({
    registered: errors.length === 0,
    received_id: receivedId,
    shipped_id: shippedId,
    errors,
  });
}

// DELETE — remove webhooks
export async function DELETE(
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

  const auth = await getAmplifierAuth(admin, workspaceId);
  if (!auth) return NextResponse.json({ error: "Amplifier not connected" }, { status: 400 });

  const { data: workspace } = await admin
    .from("workspaces")
    .select("amplifier_webhook_received_id, amplifier_webhook_shipped_id")
    .eq("id", workspaceId)
    .single();

  const errors: string[] = [];

  if (workspace?.amplifier_webhook_received_id) {
    const res = await fetch(`https://api.amplifier.com/webhooks/${workspace.amplifier_webhook_received_id}`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    if (!res.ok && res.status !== 404) errors.push(`order.received: ${res.status}`);
  }

  if (workspace?.amplifier_webhook_shipped_id) {
    const res = await fetch(`https://api.amplifier.com/webhooks/${workspace.amplifier_webhook_shipped_id}`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    if (!res.ok && res.status !== 404) errors.push(`order.shipped: ${res.status}`);
  }

  // Clear stored IDs and token
  await admin
    .from("workspaces")
    .update({
      amplifier_webhook_token_encrypted: null,
      amplifier_webhook_received_id: null,
      amplifier_webhook_shipped_id: null,
    })
    .eq("id", workspaceId);

  return NextResponse.json({ removed: true, errors });
}
