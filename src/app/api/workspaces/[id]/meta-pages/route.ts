import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

  const { data: pages } = await admin
    .from("meta_pages")
    .select(
      "id, platform, meta_page_id, meta_page_name, meta_instagram_id, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments, is_active, connected_at, last_synced_at, webhook_verify_token",
    )
    .eq("workspace_id", workspaceId)
    .order("connected_at", { ascending: true });

  return NextResponse.json({ pages: pages || [] });
}
