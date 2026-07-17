import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET — list all connected meta_pages for a workspace.
 * Returns moderation policy + page_type so the settings UI can render
 * the per-page card.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
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

  const [pagesRes, workspaceRes] = await Promise.all([
    admin
      .from("meta_pages")
      .select(
        "id, platform, meta_page_id, meta_page_name, meta_instagram_id, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments, is_active, connected_at, last_synced_at, webhook_verify_token",
      )
      .eq("workspace_id", workspaceId)
      .order("connected_at", { ascending: true }),
    admin
      .from("workspaces")
      .select("ad_destination_domains")
      .eq("id", workspaceId)
      .single(),
  ]);

  return NextResponse.json({
    pages: pagesRes.data || [],
    ad_destination_domains: (workspaceRes.data?.ad_destination_domains as string[]) || [],
  });
}

/**
 * PATCH — update workspace-scoped Meta integration settings.
 * Currently just the ad-destination-domains list (used by the social-comment
 * product matcher to recognize ad CTA URLs).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
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

  const body = await request.json().catch(() => ({}));
  const raw = body.ad_destination_domains;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "ad_destination_domains must be an array" }, { status: 400 });
  }
  // Normalize: lowercase, strip scheme/www/trailing-slash, dedupe.
  const normalized = Array.from(new Set(
    raw
      .map((v) => typeof v === "string" ? v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") : "")
      .filter(Boolean),
  ));

  const { error } = await admin
    .from("workspaces")
    .update({ ad_destination_domains: normalized })
    .eq("id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ad_destination_domains: normalized });
}
