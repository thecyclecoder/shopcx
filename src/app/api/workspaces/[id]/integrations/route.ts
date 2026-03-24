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
    .select(
      "resend_api_key_encrypted, resend_domain, support_email, shopify_domain, shopify_client_id_encrypted, shopify_client_secret_encrypted, shopify_access_token_encrypted, shopify_myshopify_domain, shopify_scopes"
    )
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    // Resend
    resend_connected: !!workspace.resend_api_key_encrypted,
    resend_domain: workspace.resend_domain,
    resend_api_key_hint: workspace.resend_api_key_encrypted
      ? `re_...${decrypt(workspace.resend_api_key_encrypted).slice(-4)}`
      : null,
    support_email: workspace.support_email,

    // Shopify
    shopify_connected: !!workspace.shopify_access_token_encrypted,
    shopify_has_credentials: !!(workspace.shopify_client_id_encrypted && workspace.shopify_client_secret_encrypted),
    shopify_domain: workspace.shopify_domain,
    shopify_myshopify_domain: workspace.shopify_myshopify_domain,
    shopify_scopes: workspace.shopify_scopes,
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
    // Resend
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

    if ("resend_domain" in body) {
      updates.resend_domain = body.resend_domain || null;
    }

    if ("support_email" in body) {
      updates.support_email = body.support_email || null;
    }

    // Shopify credentials
    if ("shopify_client_id" in body) {
      updates.shopify_client_id_encrypted = body.shopify_client_id
        ? encrypt(body.shopify_client_id)
        : null;
    }

    if ("shopify_client_secret" in body) {
      updates.shopify_client_secret_encrypted = body.shopify_client_secret
        ? encrypt(body.shopify_client_secret)
        : null;
    }

    if ("shopify_domain" in body) {
      updates.shopify_domain = body.shopify_domain || null;
    }

    // Shopify disconnect — clear all shopify fields
    if (body.shopify_disconnect === true) {
      updates.shopify_client_id_encrypted = null;
      updates.shopify_client_secret_encrypted = null;
      updates.shopify_access_token_encrypted = null;
      updates.shopify_domain = null;
      updates.shopify_myshopify_domain = null;
      updates.shopify_scopes = null;
      updates.shopify_oauth_state = null;
    }
  } catch {
    return NextResponse.json(
      { error: "Encryption failed. ENCRYPTION_KEY may not be configured." },
      { status: 500 }
    );
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
