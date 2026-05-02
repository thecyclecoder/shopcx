import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface PortalConfig {
  general: {
    lock_days: number;
    shipping_protection_product_ids: string[];
    products_available_to_add: string[]; // product IDs from our products table
    rewards_url: string;
  };
  shopify: {
    enabled: boolean;
    proxy_path: string; // e.g. /apps/portal-v2
  };
  minisite: {
    enabled: boolean;
    subdomain: string;
    custom_domain: string;
    logo_url: string;
    primary_color: string;
    auth_method: "shopify_multipass" | "magic_link" | "shopify_oauth" | "";
  };
}

const DEFAULT_CONFIG: PortalConfig = {
  general: {
    lock_days: 7,
    shipping_protection_product_ids: [],
    products_available_to_add: [],
    rewards_url: "",
  },
  shopify: {
    enabled: true,
    proxy_path: "/apps/portal",
  },
  minisite: {
    enabled: false,
    subdomain: "",
    custom_domain: "",
    logo_url: "",
    primary_color: "#000000",
    auth_method: "",
  },
};

function mergeWithDefaults(raw: Record<string, unknown>): PortalConfig {
  return {
    general: {
      ...DEFAULT_CONFIG.general,
      ...(typeof raw?.general === "object" && raw.general !== null
        ? (raw.general as Record<string, unknown>)
        : {}),
    } as PortalConfig["general"],
    shopify: {
      ...DEFAULT_CONFIG.shopify,
      ...(typeof raw?.shopify === "object" && raw.shopify !== null
        ? (raw.shopify as Record<string, unknown>)
        : {}),
    } as PortalConfig["shopify"],
    minisite: {
      ...DEFAULT_CONFIG.minisite,
      ...(typeof raw?.minisite === "object" && raw.minisite !== null
        ? (raw.minisite as Record<string, unknown>)
        : {}),
    } as PortalConfig["minisite"],
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const config = mergeWithDefaults(
    (workspace.portal_config as Record<string, unknown>) || {}
  );

  return NextResponse.json(config);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const config = mergeWithDefaults(body);

  const admin = createAdminClient();

  // Diff the incoming custom_domain against what's stored. When it
  // changes to a non-empty value, register it with Vercel so SSL
  // provisioning + routing are wired up automatically — same pattern
  // used by storefront_domain and help_custom_domain elsewhere.
  const { data: existing } = await admin
    .from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();
  const oldDomain = (
    (existing?.portal_config as { minisite?: { custom_domain?: string } } | null)?.minisite?.custom_domain || ""
  ).toLowerCase().trim();
  const newDomain = (config.minisite.custom_domain || "").toLowerCase().trim();
  config.minisite.custom_domain = newDomain;

  if (newDomain && newDomain !== oldDomain) {
    const vercelToken = process.env.VERCEL_API_TOKEN;
    const vercelProjectId = process.env.VERCEL_PROJECT_ID;
    const vercelTeamId = process.env.VERCEL_TEAM_ID;
    if (vercelToken && vercelProjectId) {
      const url = `https://api.vercel.com/v10/projects/${vercelProjectId}/domains${vercelTeamId ? `?teamId=${vercelTeamId}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newDomain }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // 409 / "domain already exists" is fine — we may have added it
        // earlier or it's used by another product on the same project.
        if (res.status !== 409 && !err?.error?.code?.includes("existing")) {
          return NextResponse.json(
            { error: `Failed to add domain to Vercel: ${err?.error?.message || res.status}` },
            { status: 400 },
          );
        }
      }
    }
  }

  const { data, error } = await admin
    .from("workspaces")
    .update({ portal_config: config })
    .eq("id", workspaceId)
    .select("portal_config")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    mergeWithDefaults((data.portal_config as Record<string, unknown>) || {})
  );
}
