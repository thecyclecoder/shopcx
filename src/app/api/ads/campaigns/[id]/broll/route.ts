import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId)
    return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
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

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Add ONE b-roll clip: "text" (text-to-video), "image" (animate a still), or
  // "avatar" (animate the campaign's avatar doing an AVATAR_BROLL_ACTIONS action).
  const mode = body.mode === "text" ? "text" : body.mode === "avatar" ? "avatar" : "image";
  const model = body.model === "full" ? "full" : "fast";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
  const avatarAction = typeof body.avatar_action === "string" ? body.avatar_action.trim() : "";
  if (mode === "image" && !sourceUrl) return NextResponse.json({ error: "source_url required for image mode" }, { status: 400 });
  if (mode === "text" && !prompt) return NextResponse.json({ error: "prompt required for text mode" }, { status: 400 });
  if (mode === "avatar" && !avatarAction) return NextResponse.json({ error: "avatar_action required for avatar mode" }, { status: 400 });

  await inngest.send({
    name: "ad-tool/broll-requested",
    data: { workspace_id: workspaceId as string, campaign_id: id, mode, model, prompt: prompt || undefined, source_url: sourceUrl || undefined, avatar_action: avatarAction || undefined },
  });

  return NextResponse.json({ queued: true, mode });
}
