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
 * Reuse an existing b-roll clip from the library in THIS ad — copies the segment
 * row (same storage file, no regeneration) as the next b-roll seq. B-roll is
 * highly reusable, so this avoids re-spending Veo on a clip you already have.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const srcId = typeof body.segId === "string" ? body.segId : "";
  if (!srcId) return NextResponse.json({ error: "segId required" }, { status: 400 });

  // The source clip (must belong to this workspace).
  const { data: src } = await auth.admin
    .from("ad_segments")
    .select("prompt, model, storage_path, source_url, duration_sec, trim_sec")
    .eq("id", srcId)
    .eq("workspace_id", workspaceId as string)
    .eq("kind", "broll")
    .single();
  if (!src || !src.storage_path) return NextResponse.json({ error: "clip_not_found" }, { status: 404 });

  // Next b-roll seq in this campaign.
  const { data: existing } = await auth.admin
    .from("ad_segments")
    .select("seq")
    .eq("campaign_id", id)
    .eq("kind", "broll")
    .eq("is_active", true)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSeq = (existing?.seq ?? -1) + 1;

  const { data: row, error } = await auth.admin
    .from("ad_segments")
    .insert({
      workspace_id: workspaceId,
      campaign_id: id,
      kind: "broll",
      seq: nextSeq,
      version: 1,
      is_active: true,
      prompt: src.prompt,
      model: src.model,
      storage_path: src.storage_path, // shared file — reuse, not re-render
      source_url: src.source_url,
      duration_sec: src.duration_sec,
      trim_sec: src.trim_sec,
      status: "ready",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: row!.id, seq: nextSeq });
}
