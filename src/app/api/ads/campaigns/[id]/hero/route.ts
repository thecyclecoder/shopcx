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

  // Optional free-text correction appended to the prompt on regeneration
  // (e.g. "the hands look wrong relative to the arms").
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";

  await inngest.send({
    name: "ad-tool/hero-requested",
    data: { workspace_id: workspaceId as string, campaign_id: id, feedback: feedback || undefined },
  });

  return NextResponse.json({ queued: true });
}
