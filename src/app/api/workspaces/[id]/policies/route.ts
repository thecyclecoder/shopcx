/**
 * GET /api/workspaces/[id]/policies
 * Returns the active policies for this workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { data: policies } = await admin
    .from("policies")
    .select("id, slug, name, version, customer_summary, internal_summary, rules, effective_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("slug");

  return NextResponse.json({ policies: policies || [] });
}
