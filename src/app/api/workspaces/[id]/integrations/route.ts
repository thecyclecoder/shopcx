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
      "resend_api_key_encrypted, resend_domain, support_email, sandbox_mode, shopify_domain, shopify_client_id_encrypted, shopify_client_secret_encrypted, shopify_access_token_encrypted, shopify_myshopify_domain, shopify_scopes, appstle_webhook_secret_encrypted, appstle_api_key_encrypted, auto_close_reply, response_delays"
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
    sandbox_mode: workspace.sandbox_mode ?? true,

    // Shopify
    shopify_connected: !!workspace.shopify_access_token_encrypted,
    shopify_has_credentials: !!(workspace.shopify_client_id_encrypted && workspace.shopify_client_secret_encrypted),
    shopify_domain: workspace.shopify_domain,
    shopify_myshopify_domain: workspace.shopify_myshopify_domain,
    shopify_scopes: workspace.shopify_scopes,

    // Appstle
    appstle_connected: !!workspace.appstle_webhook_secret_encrypted,
    appstle_has_api_key: !!workspace.appstle_api_key_encrypted,
    appstle_secret_hint: workspace.appstle_webhook_secret_encrypted
      ? `whsec_...${decrypt(workspace.appstle_webhook_secret_encrypted).slice(-4)}`
      : null,
    appstle_api_key_hint: workspace.appstle_api_key_encrypted
      ? `...${decrypt(workspace.appstle_api_key_encrypted).slice(-4)}`
      : null,

    // Auto-close + delays
    auto_close_reply: workspace.auto_close_reply || null,
    response_delays: workspace.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10 },
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

  const updates: Record<string, string | boolean | null> = {};

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

    if ("sandbox_mode" in body) {
      updates.sandbox_mode = !!body.sandbox_mode;
    }

    if ("auto_close_reply" in body) {
      updates.auto_close_reply = body.auto_close_reply || null;
    }

    if ("response_delays" in body) {
      updates.response_delays = body.response_delays;
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

    // Appstle
    if ("appstle_webhook_secret" in body) {
      updates.appstle_webhook_secret_encrypted = body.appstle_webhook_secret
        ? encrypt(body.appstle_webhook_secret)
        : null;
    }

    if ("appstle_api_key" in body) {
      updates.appstle_api_key_encrypted = body.appstle_api_key
        ? encrypt(body.appstle_api_key)
        : null;
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
