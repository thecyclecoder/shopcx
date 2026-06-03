import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function authorize(workspaceId: string | null) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: campaign, error } = await auth.admin
    .from("ad_campaigns")
    .select("*, products(title)")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (error || !campaign)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: videos } = await auth.admin
    .from("ad_videos")
    .select("*")
    .eq("campaign_id", id)
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false });

  // Creative library: the active pieces that make up this ad, with signed
  // preview URLs so the operator can inspect (and refresh) each one.
  const { data: segs } = await auth.admin
    .from("ad_segments")
    .select("id, kind, seq, version, script_text, model, storage_path, trim_sec, status")
    .eq("campaign_id", id)
    .eq("is_active", true)
    .order("kind", { ascending: true })
    .order("seq", { ascending: true });
  const { signedUrl } = await import("@/lib/ad-storage");
  const segments = await Promise.all(
    (segs || []).map(async (s) => ({
      ...s,
      preview_url: s.storage_path ? await signedUrl(s.storage_path).catch(() => null) : null,
    })),
  );

  return NextResponse.json({ campaign, videos: videos || [], segments });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const update: Record<string, unknown> = {};
  if (typeof body.script_text === "string") update.script_text = body.script_text;
  if (typeof body.voice_id === "string") update.voice_id = body.voice_id;
  if (typeof body.caption_style === "string") update.caption_style = body.caption_style;
  if (typeof body.name === "string") update.name = body.name;

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "no_fields" }, { status: 400 });

  const { data: campaign, error } = await auth.admin
    .from("ad_campaigns")
    .update(update)
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .select("*")
    .single();

  if (error || !campaign)
    return NextResponse.json({ error: error?.message || "update_failed" }, { status: 500 });

  return NextResponse.json({ campaign });
}
