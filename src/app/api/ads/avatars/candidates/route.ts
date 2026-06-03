import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateSoulPortrait, pollJobUntilDone } from "@/lib/higgsfield";
import { uploadFromUrl, signedUrl, removeObjects } from "@/lib/ad-storage";
import {
  buildAvatarPortraitPrompt,
  AVATAR_GENDERS,
  AVATAR_HEALTH_LEVELS,
  AVATAR_ETHNICITIES,
  type AvatarFaceAttributes,
} from "@/lib/ad-tool-config";

export const maxDuration = 300;

async function authorize(workspaceId: string | null, userId: string) {
  if (!workspaceId) return null;
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string)) return null;
  return admin;
}

/**
 * GET — the saved avatar-face library. Every generated face is persisted in
 * ad_avatar_candidates; this re-signs each storage_path and returns them newest
 * first so the operator reuses existing faces instead of regenerating (which
 * burns Soul credits). Excludes discarded faces.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const admin = await authorize(workspaceId, user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: rows } = await admin
    .from("ad_avatar_candidates")
    .select("id, gender, age_range, health_level, ethnicity, storage_path, status, created_at")
    .eq("workspace_id", workspaceId as string)
    .neq("status", "discarded")
    .order("created_at", { ascending: false })
    .limit(200);

  const candidates = await Promise.all(
    (rows || []).map(async (r) => ({
      id: r.id,
      url: await signedUrl(r.storage_path).catch(() => ""),
      gender: r.gender,
      age_range: r.age_range,
      health_level: r.health_level,
      ethnicity: r.ethnicity,
      status: r.status,
    })),
  );
  return NextResponse.json({ candidates: candidates.filter((c) => c.url) });
}

/**
 * POST — generate N avatar FACE candidates from four attributes (gender, age,
 * health level, ethnicity) via Higgsfield Soul text-to-image, persist each into
 * the library, and return them. No reference-photo upload. ~3 credits per face.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const workspaceId: string | undefined = body.workspaceId;
  const count: number = Math.min(Math.max(Number(body.count) || 3, 1), 4);
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const admin = await authorize(workspaceId, user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const gender = (AVATAR_GENDERS as readonly string[]).includes(body.gender) ? body.gender : "female";
  const ageRange = typeof body.ageRange === "string" && body.ageRange ? body.ageRange : "35-44";
  const healthLevel = AVATAR_HEALTH_LEVELS.some((h) => h.value === body.healthLevel) ? body.healthLevel : "fit";
  const ethnicity = AVATAR_ETHNICITIES.some((e) => e.value === body.ethnicity) ? body.ethnicity : "auto";
  const attrs: AvatarFaceAttributes = { gender, ageRange, healthLevel, ethnicity };

  let context = "";
  let proposalId: string | null = null;
  let productId: string | null = typeof body.productId === "string" ? body.productId : null;
  if (body.proposalId) {
    const { data: proposal } = await admin
      .from("ad_avatar_proposals")
      .select("archetype_brief, workspace_id, product_id")
      .eq("id", body.proposalId)
      .single();
    if (proposal && proposal.workspace_id === workspaceId) {
      const b = proposal.archetype_brief as { wardrobe?: string; setting?: string } | null;
      context = [b?.wardrobe, b?.setting].filter(Boolean).join(", ");
      proposalId = body.proposalId;
      productId = proposal.product_id;
    }
  }
  // Direct product scoping (builder path, no proposal): confirm ownership.
  if (productId && !proposalId) {
    const { data: prod } = await admin.from("products").select("workspace_id").eq("id", productId).single();
    if (!prod || prod.workspace_id !== workspaceId) productId = null;
  }

  const stamp = `${gender}_${ageRange}_${healthLevel}_${ethnicity}`;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      (async () => {
        try {
          const { jobSetId } = await generateSoulPortrait({
            workspaceId,
            prompt: buildAvatarPortraitPrompt(attrs, context, i),
            quality: "1080p",
            seed: 1000 + i,
          });
          if (!jobSetId) return { ok: false as const, error: "no_job_set" };
          const res = await pollJobUntilDone(workspaceId, jobSetId, { timeoutMs: 180000 });
          if (res.status === "nsfw") return { ok: false as const, error: "nsfw" };
          if (res.status !== "completed" || !res.outputUrls[0]) return { ok: false as const, error: res.status };
          // Unique path per face so library entries never collide.
          const path = `avatars/${workspaceId}/library/${stamp}_${Date.now()}_${i}.png`;
          await uploadFromUrl(path, res.outputUrls[0], "image/png");
          const { data: row } = await admin
            .from("ad_avatar_candidates")
            .insert({
              workspace_id: workspaceId,
              proposal_id: proposalId,
              product_id: productId,
              gender,
              age_range: ageRange,
              health_level: healthLevel,
              ethnicity,
              storage_path: path,
              status: "available",
              created_by: user.id,
            })
            .select("id")
            .single();
          return { ok: true as const, id: row?.id, url: await signedUrl(path) };
        } catch (err: any) {
          return { ok: false as const, error: String(err?.message || err) };
        }
      })(),
    ),
  );

  const candidates = results.filter((r) => r.ok).map((r) => ({ id: (r as any).id, url: (r as any).url }));
  if (candidates.length === 0) {
    const reason = (results.find((r) => !r.ok) as any)?.error || "generation_failed";
    return NextResponse.json({ error: "no_candidates", reason }, { status: 502 });
  }
  return NextResponse.json({ candidates });
}

/** DELETE — permanently remove a saved face from the library (row + storage object). */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const id = url.searchParams.get("id");
  const admin = await authorize(workspaceId, user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: row } = await admin
    .from("ad_avatar_candidates")
    .select("storage_path, workspace_id")
    .eq("id", id)
    .single();
  if (!row || row.workspace_id !== workspaceId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await removeObjects([row.storage_path]).catch(() => {});
  await admin.from("ad_avatar_candidates").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
