import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

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
 * Refresh ONE talking beat ("this ad is fatiguing — refresh the hook") and
 * re-stitch. Regenerates the segment at `seq` with `new_script` (Veo), then
 * re-renders from the creative library reusing every other piece.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const seq = Number(body.seq);
  const kind = body.kind === "broll" ? "broll" : "talking_head";
  const model = body.model === "full" ? "full" : "fast";
  const newScript = typeof body.new_script === "string" ? body.new_script.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!Number.isInteger(seq) || seq < 0) return NextResponse.json({ error: "seq required" }, { status: 400 });
  // talking_head with no new_script = regenerate same content (e.g. HQ upgrade).
  // broll never needs a script.

  // Confirm the campaign belongs to the workspace.
  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await inngest.send({
    name: "ad-tool/segment-regenerate",
    data: { workspace_id: workspaceId as string, campaign_id: id, seq, kind, model, new_script: newScript || undefined, prompt: prompt || undefined },
  });

  return NextResponse.json({ ok: true, seq, kind, model });
}
