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
      "resend_api_key_encrypted, resend_domain, support_email, sandbox_mode, shopify_domain, shopify_client_id_encrypted, shopify_client_secret_encrypted, shopify_access_token_encrypted, shopify_myshopify_domain, shopify_scopes, shopify_multipass_secret_encrypted, appstle_webhook_secret_encrypted, appstle_api_key_encrypted, auto_close_reply, response_delays, help_center_url, help_slug, help_logo_url, help_primary_color, help_custom_domain, meta_page_id, meta_page_access_token_encrypted, meta_instagram_id, meta_page_name, meta_webhook_verify_token, klaviyo_api_key_encrypted, klaviyo_public_key, klaviyo_last_sync_at, amplifier_api_key_encrypted, amplifier_order_source_code, amplifier_tracking_sla_days, amplifier_cutoff_hour, amplifier_cutoff_timezone, amplifier_shipping_days, slack_bot_token_encrypted, slack_team_id, slack_team_name, slack_connected_at"
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
    response_delays: workspace.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 },

    // Help center
    help_center_url: workspace.help_center_url || null,
    help_slug: workspace.help_slug || null,
    help_logo_url: workspace.help_logo_url || null,
    help_primary_color: workspace.help_primary_color || "#4f46e5",
    help_custom_domain: workspace.help_custom_domain || null,

    // Meta
    meta_connected: !!workspace.meta_page_access_token_encrypted,
    meta_page_id: workspace.meta_page_id,
    meta_page_name: workspace.meta_page_name,
    meta_instagram_id: workspace.meta_instagram_id,
    meta_webhook_verify_token: workspace.meta_webhook_verify_token,

    // Klaviyo
    klaviyo_connected: !!workspace.klaviyo_api_key_encrypted,
    klaviyo_api_key_hint: workspace.klaviyo_api_key_encrypted
      ? `pk_...${decrypt(workspace.klaviyo_api_key_encrypted).slice(-4)}`
      : null,
    klaviyo_public_key: workspace.klaviyo_public_key,
    klaviyo_last_sync_at: workspace.klaviyo_last_sync_at,
    klaviyo_review_count: null, // Populated by caller if needed

    // Amplifier
    amplifier_connected: !!workspace.amplifier_api_key_encrypted,
    amplifier_api_key_hint: workspace.amplifier_api_key_encrypted
      ? `...${decrypt(workspace.amplifier_api_key_encrypted).slice(-4)}`
      : null,
    amplifier_order_source_code: workspace.amplifier_order_source_code || null,
    amplifier_tracking_sla_days: workspace.amplifier_tracking_sla_days ?? 1,
    amplifier_cutoff_hour: workspace.amplifier_cutoff_hour ?? 11,
    amplifier_cutoff_timezone: workspace.amplifier_cutoff_timezone || "America/Chicago",
    amplifier_shipping_days: workspace.amplifier_shipping_days || [1, 2, 3, 4, 5],

    // Multipass
    shopify_multipass_hint: workspace.shopify_multipass_secret_encrypted
      ? decrypt(workspace.shopify_multipass_secret_encrypted).slice(-4)
      : null,

    // Slack
    slack_connected: !!workspace.slack_bot_token_encrypted,
    slack_team_name: workspace.slack_team_name,
    slack_connected_at: workspace.slack_connected_at,
    slack_members_mapped: 0,
    slack_members_total: 0,
    ...(workspace.slack_bot_token_encrypted ? await (async () => {
      const { data: members } = await admin
        .from("workspace_members")
        .select("slack_user_id")
        .eq("workspace_id", workspaceId);
      return {
        slack_members_mapped: members?.filter((m) => m.slack_user_id).length || 0,
        slack_members_total: members?.length || 0,
      };
    })() : {}),
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

  const updates: Record<string, string | boolean | number | null> = {};

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

    if ("help_slug" in body && body.help_slug) {
      // Check uniqueness
      const { data: existing } = await admin.from("workspaces").select("id").eq("help_slug", body.help_slug).neq("id", workspaceId).single();
      if (existing) {
        return NextResponse.json({ error: "This slug is already taken. Please choose another." }, { status: 409 });
      }
      updates.help_slug = body.help_slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
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

    if ("shopify_multipass_secret" in body) {
      updates.shopify_multipass_secret_encrypted = body.shopify_multipass_secret
        ? encrypt(body.shopify_multipass_secret)
        : null;
    }

    if ("shopify_domain" in body) {
      updates.shopify_domain = body.shopify_domain || null;
    }

    // Shopify disconnect — clear all shopify fields
    if (body.shopify_disconnect === true) {
      // Only clear access token + OAuth state — keep client ID, secret, and domain
      updates.shopify_access_token_encrypted = null;
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

    // Meta disconnect
    if (body.meta_disconnect === true) {
      updates.meta_page_id = null;
      updates.meta_page_access_token_encrypted = null;
      updates.meta_instagram_id = null;
      updates.meta_webhook_verify_token = null;
      updates.meta_page_name = null;
      updates.meta_oauth_state = null;
    }

    // Klaviyo
    if ("klaviyo_api_key" in body) {
      if (body.klaviyo_api_key) {
        updates.klaviyo_api_key_encrypted = encrypt(body.klaviyo_api_key);
      } else {
        updates.klaviyo_api_key_encrypted = null;
      }
    }

    if ("klaviyo_public_key" in body) {
      updates.klaviyo_public_key = body.klaviyo_public_key || null;
    }

    // Amplifier
    if ("amplifier_api_key" in body) {
      if (body.amplifier_api_key) {
        updates.amplifier_api_key_encrypted = encrypt(body.amplifier_api_key);
      } else {
        updates.amplifier_api_key_encrypted = null;
      }
    }

    if ("amplifier_order_source_code" in body) {
      updates.amplifier_order_source_code = body.amplifier_order_source_code || null;
    }

    if ("amplifier_tracking_sla_days" in body) {
      updates.amplifier_tracking_sla_days = parseInt(body.amplifier_tracking_sla_days) || 1;
    }

    if ("amplifier_cutoff_hour" in body) {
      updates.amplifier_cutoff_hour = parseInt(body.amplifier_cutoff_hour) ?? 11;
    }

    if ("amplifier_cutoff_timezone" in body) {
      updates.amplifier_cutoff_timezone = body.amplifier_cutoff_timezone || "America/Chicago";
    }

    if ("amplifier_shipping_days" in body) {
      updates.amplifier_shipping_days = body.amplifier_shipping_days || [1, 2, 3, 4, 5];
    }

    // VIP threshold
    if ("vip_retention_threshold" in body) {
      updates.vip_retention_threshold = parseInt(body.vip_retention_threshold) || 85;
    }

    // Help center branding
    if ("help_logo_url" in body) {
      updates.help_logo_url = body.help_logo_url || null;
    }

    if ("help_primary_color" in body) {
      updates.help_primary_color = body.help_primary_color || "#4f46e5";
    }

    // Custom domain — add to Vercel automatically
    if ("help_custom_domain" in body) {
      const domain = (body.help_custom_domain || "").toLowerCase().trim();
      if (domain) {
        // Add domain to Vercel project
        const vercelToken = process.env.VERCEL_API_TOKEN;
        const vercelProjectId = process.env.VERCEL_PROJECT_ID;
        const vercelTeamId = process.env.VERCEL_TEAM_ID;
        if (vercelToken && vercelProjectId) {
          const url = `https://api.vercel.com/v10/projects/${vercelProjectId}/domains${vercelTeamId ? `?teamId=${vercelTeamId}` : ""}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: domain }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            // Domain already added is fine (409 or "already exists")
            if (res.status !== 409 && !err?.error?.code?.includes("existing")) {
              return NextResponse.json({ error: `Failed to add domain to Vercel: ${err?.error?.message || res.status}` }, { status: 400 });
            }
          }
        }
        updates.help_custom_domain = domain;
      } else {
        updates.help_custom_domain = null;
      }
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
