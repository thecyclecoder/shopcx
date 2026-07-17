import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCharacter } from "@/lib/higgsfield";
import { MAX_AVATARS_PER_WORKSPACE } from "@/lib/ad-tool-config";

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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data, error } = await auth.admin
    .from("ad_avatars")
    .select(
      "id, name, higgsfield_character_id, reference_image_urls, status, cost_cents, last_used_at, created_at",
    )
    .eq("workspace_id", workspaceId as string)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(req: Request) {
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const name: string = (body.name || "").trim();
  const imageUrls: string[] = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  const proposalId: string | null = body.proposalId ?? null;
  const candidateId: string | null = body.candidateId ?? null;

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (imageUrls.length === 0)
    return NextResponse.json({ error: "imageUrls required" }, { status: 400 });

  // Enforce the active-avatar cap.
  const { count } = await auth.admin
    .from("ad_avatars")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId as string)
    .eq("status", "active");

  if ((count ?? 0) >= MAX_AVATARS_PER_WORKSPACE)
    return NextResponse.json({ error: "avatar_limit" }, { status: 400 });

  let characterId: string | null = null;
  try {
    const res = await createCharacter({
      workspaceId: workspaceId as string,
      name,
      imageUrls,
    });
    characterId = res.characterId;
  } catch (e) {
    const message = e instanceof Error ? e.message : "higgsfield_create_character_failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { data: avatar, error: insertErr } = await auth.admin
    .from("ad_avatars")
    .insert({
      workspace_id: workspaceId as string,
      name,
      higgsfield_character_id: characterId,
      reference_image_urls: imageUrls,
      status: "active",
      cost_cents: 250,
      created_by: auth.user.id,
      proposed_from_id: proposalId,
    })
    .select(
      "id, name, higgsfield_character_id, reference_image_urls, status, cost_cents, last_used_at, created_at",
    )
    .single();

  if (insertErr || !avatar)
    return NextResponse.json(
      { error: insertErr?.message || "insert_failed" },
      { status: 500 },
    );

  if (proposalId) {
    await auth.admin
      .from("ad_avatar_proposals")
      .update({ status: "confirmed", confirmed_avatar_id: avatar.id })
      .eq("id", proposalId)
      .eq("workspace_id", workspaceId as string);
  }

  // Tag the chosen library face as used (it stays in the library, badged).
  if (candidateId) {
    await auth.admin
      .from("ad_avatar_candidates")
      .update({ status: "used", used_avatar_id: avatar.id })
      .eq("id", candidateId)
      .eq("workspace_id", workspaceId as string);
  }

  return NextResponse.json(avatar);
}
