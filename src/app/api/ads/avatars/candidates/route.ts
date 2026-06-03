import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateSoulPortrait, pollJobUntilDone } from "@/lib/higgsfield";
import { uploadFromUrl, signedUrl } from "@/lib/ad-storage";
import {
  buildAvatarPortraitPrompt,
  AVATAR_GENDERS,
  AVATAR_HEALTH_LEVELS,
  AVATAR_ETHNICITIES,
  type AvatarFaceAttributes,
} from "@/lib/ad-tool-config";

export const maxDuration = 300;

/**
 * Generate 3 avatar FACE candidates from four attributes — gender, age, health
 * level, ethnicity — via Higgsfield Soul text-to-image. No reference-photo
 * upload. The operator picks one; POST /api/ads/avatars then mints it into a
 * recurring character. ~3 credits per candidate (~$0.56 for the set).
 *
 * Optional wardrobe/setting context comes from the chosen archetype proposal.
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

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Validate the four attributes.
  const gender = (AVATAR_GENDERS as readonly string[]).includes(body.gender) ? body.gender : "female";
  const ageRange = typeof body.ageRange === "string" && body.ageRange ? body.ageRange : "35-44";
  const healthLevel = AVATAR_HEALTH_LEVELS.some((h) => h.value === body.healthLevel) ? body.healthLevel : "fit";
  const ethnicity = AVATAR_ETHNICITIES.some((e) => e.value === body.ethnicity) ? body.ethnicity : "auto";
  const attrs: AvatarFaceAttributes = { gender, ageRange, healthLevel, ethnicity };

  // Optional wardrobe/setting context from a proposal (face is shot waist-up, but
  // wardrobe still informs the look).
  let context = "";
  let tag = "adhoc";
  if (body.proposalId) {
    const { data: proposal } = await admin
      .from("ad_avatar_proposals")
      .select("archetype_brief, workspace_id")
      .eq("id", body.proposalId)
      .single();
    if (proposal && proposal.workspace_id === workspaceId) {
      const b = proposal.archetype_brief as { wardrobe?: string; setting?: string } | null;
      context = [b?.wardrobe, b?.setting].filter(Boolean).join(", ");
      tag = body.proposalId;
    }
  }

  // Generate candidates in parallel; tolerate per-candidate failures (NSFW etc).
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
          if (!jobSetId) return { ok: false, error: "no_job_set" };
          const res = await pollJobUntilDone(workspaceId, jobSetId, { timeoutMs: 180000 });
          if (res.status === "nsfw") return { ok: false, error: "nsfw" };
          if (res.status !== "completed" || !res.outputUrls[0]) return { ok: false, error: res.status };
          const path = `avatars/${workspaceId}/candidates/${tag}/${i}_${gender}_${healthLevel}_${ethnicity}.png`;
          await uploadFromUrl(path, res.outputUrls[0], "image/png");
          return { ok: true, url: await signedUrl(path) };
        } catch (err: any) {
          return { ok: false, error: String(err?.message || err) };
        }
      })(),
    ),
  );

  const candidates = results.filter((r) => r.ok).map((r) => ({ url: (r as any).url }));
  if (candidates.length === 0) {
    const reason = (results.find((r) => !r.ok) as any)?.error || "generation_failed";
    return NextResponse.json({ error: "no_candidates", reason }, { status: 502 });
  }
  return NextResponse.json({ candidates });
}
