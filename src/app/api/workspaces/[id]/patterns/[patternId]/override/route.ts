import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST: Enable or dismiss a global pattern for this workspace
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; patternId: string }> }
) {
  const { id: workspaceId, patternId } = await params;

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
  const enabled = body.enabled !== false;

  const { error } = await admin
    .from("workspace_pattern_overrides")
    .upsert({
      workspace_id: workspaceId,
      pattern_id: patternId,
      enabled,
    }, { onConflict: "workspace_id,pattern_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ enabled });
}
