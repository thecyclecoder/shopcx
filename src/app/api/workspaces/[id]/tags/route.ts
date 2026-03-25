import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Return distinct tags used across tickets in this workspace
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

  // Get all tickets with non-empty tags
  const { data: tickets } = await admin
    .from("tickets")
    .select("tags")
    .eq("workspace_id", workspaceId)
    .not("tags", "eq", "{}");

  const tagSet = new Set<string>();
  for (const t of tickets || []) {
    for (const tag of (t.tags as string[]) || []) {
      tagSet.add(tag);
    }
  }

  return NextResponse.json([...tagSet].sort());
}

// DELETE: Remove a tag from all tickets in this workspace
export async function DELETE(
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

  const body = await request.json();
  const { tag } = body;
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

  // Get all tickets that have this tag
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, tags")
    .eq("workspace_id", workspaceId)
    .contains("tags", [tag]);

  // Remove the tag from each ticket
  for (const ticket of tickets || []) {
    const newTags = ((ticket.tags as string[]) || []).filter((t: string) => t !== tag);
    await admin.from("tickets").update({ tags: newTags }).eq("id", ticket.id);
  }

  // Delete any ticket views that use this tag as a filter
  const { data: views } = await admin
    .from("ticket_views")
    .select("id, filters")
    .eq("workspace_id", workspaceId);

  for (const view of views || []) {
    const filters = (view.filters || {}) as Record<string, string>;
    if (filters.tag === tag) {
      // Delete this view and any children
      await admin.from("ticket_views").delete().eq("parent_id", view.id);
      await admin.from("ticket_views").delete().eq("id", view.id);
    }
  }

  return NextResponse.json({ deleted: true, affected: tickets?.length || 0 });
}
