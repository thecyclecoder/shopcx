import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl } from "@/lib/ad-storage";

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
 * Workspace-wide b-roll library — every ready b-roll clip ever made, reusable
 * across ads. Deduped by storage_path (a clip reused in N ads appears once).
 * Optional ?excludeCampaign= to hide clips already in the campaign being edited.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const excludeCampaign = url.searchParams.get("excludeCampaign");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: rows } = await auth.admin
    .from("ad_segments")
    .select("id, campaign_id, prompt, model, storage_path, source_url, created_at")
    .eq("workspace_id", workspaceId as string)
    .eq("kind", "broll")
    .eq("status", "ready")
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  const seen = new Set<string>();
  const clips: any[] = [];
  for (const r of rows || []) {
    if (excludeCampaign && r.campaign_id === excludeCampaign) continue;
    if (seen.has(r.storage_path as string)) continue;
    seen.add(r.storage_path as string);
    clips.push({
      id: r.id,
      prompt: r.prompt,
      model: r.model,
      storage_path: r.storage_path,
      source_url: r.source_url,
      preview_url: await signedUrl(r.storage_path as string).catch(() => null),
    });
  }
  return NextResponse.json({ clips });
}
