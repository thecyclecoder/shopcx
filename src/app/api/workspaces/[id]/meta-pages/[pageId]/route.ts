import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * PATCH — update a single meta_pages row: page_type + AI moderation
 * toggles + active flag. All other fields are read-only via this route
 * (token rotation happens through OAuth, not here).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id: workspaceId, pageId } = await params;
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
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.page_type === "brand" || body.page_type === "creator") {
    updates.page_type = body.page_type;
  }
  if (typeof body.ai_moderate_ad_comments === "boolean") {
    updates.ai_moderate_ad_comments = body.ai_moderate_ad_comments;
  }
  if (typeof body.ai_moderate_organic_comments === "boolean") {
    updates.ai_moderate_organic_comments = body.ai_moderate_organic_comments;
  }
  if (typeof body.is_active === "boolean") {
    updates.is_active = body.is_active;
  }

  const { data: updated, error } = await admin
    .from("meta_pages")
    .update(updates)
    .eq("workspace_id", workspaceId)
    .eq("id", pageId)
    .select("id, platform, meta_page_id, meta_page_name, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments, is_active")
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message || "Update failed" }, { status: 400 });
  }
  return NextResponse.json({ page: updated });
}

/**
 * DELETE — disconnect a meta_pages row. Sets is_active=false rather
 * than deleting outright so historical social_comments rows keep their
 * FK reference. A future cleanup job can hard-delete after a grace
 * period if needed.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id: workspaceId, pageId } = await params;
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

  await admin
    .from("meta_pages")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", pageId);

  return NextResponse.json({ ok: true });
}
