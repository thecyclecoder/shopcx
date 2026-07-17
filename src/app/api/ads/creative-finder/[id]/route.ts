/**
 * Winning Static-Creative Finder — shortlist / archive a skeleton.
 *
 *   PATCH ?workspaceId= { status }  → 'shortlisted' | 'archived' | 'analyzed'
 *
 * The shortlist is the hook for the variant-generation spec to pull patterns.
 * See docs/brain/specs/winning-static-creative-finder.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ALLOWED = new Set(["shortlisted", "archived", "analyzed"]);

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { status?: string };
  if (!body.status || !ALLOWED.has(body.status))
    return NextResponse.json({ error: "invalid status" }, { status: 400 });

  const { error } = await admin
    .from("creative_skeletons")
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
