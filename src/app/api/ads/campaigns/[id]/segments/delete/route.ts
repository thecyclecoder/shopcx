import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

/**
 * Discard a segment from this ad's cut (soft delete — is_active=false). The clip
 * stays in the creative library (reusable later); it just leaves this composition.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const segId = typeof body.segId === "string" ? body.segId : "";
  if (!segId) return NextResponse.json({ error: "segId required" }, { status: 400 });

  const { error } = await auth.admin
    .from("ad_segments")
    .update({ is_active: false })
    .eq("id", segId)
    .eq("campaign_id", id)
    .eq("workspace_id", workspaceId as string);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
