import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Check membership and role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: workspace } = await admin
    .from("workspaces")
    .select("resend_api_key_encrypted, resend_domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    resend_connected: !!workspace.resend_api_key_encrypted,
    resend_domain: workspace.resend_domain,
    // Mask the key - only show last 4 chars
    resend_api_key_hint: workspace.resend_api_key_encrypted
      ? `re_...${decrypt(workspace.resend_api_key_encrypted).slice(-4)}`
      : null,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
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

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, string | null> = {};

  try {
    if ("resend_api_key" in body) {
      if (body.resend_api_key) {
        if (!body.resend_api_key.startsWith("re_")) {
          return NextResponse.json({ error: "Invalid Resend API key format" }, { status: 400 });
        }
        updates.resend_api_key_encrypted = encrypt(body.resend_api_key);
      } else {
        updates.resend_api_key_encrypted = null;
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Encryption failed. ENCRYPTION_KEY may not be configured." },
      { status: 500 }
    );
  }

  if ("resend_domain" in body) {
    updates.resend_domain = body.resend_domain || null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", workspaceId);

  if (error) {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
