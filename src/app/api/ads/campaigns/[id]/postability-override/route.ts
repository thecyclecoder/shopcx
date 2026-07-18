/**
 * CEO manual postability override — owner/admin only. Set (POST) or clear
 * (DELETE) the override on ONE ad campaign. Never touches Max's real grade on
 * `ad_creative_copy_qc_verdicts` — the whole point of the override is that the
 * disagreement (Max says 6/10; CEO says post) survives as the tuning signal for
 * live Claude sessions.
 *
 * bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate
 * Phase 2 — the attributed action + control the ad detail page invokes.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_QC_ELIGIBILITY_FLOOR } from "@/lib/ads/creative-agent";
import {
  clearPostabilityOverride,
  normalizeOverrideReason,
  setPostabilityOverride,
} from "@/lib/ads/postability-override";
import { recordDirectorActivity } from "@/lib/director-activity";

const GROWTH_DIRECTOR_FUNCTION = "growth";

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
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null =
    typeof body.workspaceId === "string" ? body.workspaceId : null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  const cleanReason = normalizeOverrideReason(
    typeof body.reason === "string" ? body.reason : null,
  );
  if (!cleanReason)
    return NextResponse.json({ error: "missing_reason" }, { status: 400 });
  const suppliedScore =
    typeof body.score === "number" && Number.isFinite(body.score) ? body.score : null;
  const result = await setPostabilityOverride(auth.admin, {
    workspaceId: workspaceId as string,
    adCampaignId: id,
    reason: cleanReason,
    userId: auth.user.id,
    score: suppliedScore,
    scoreFloor: MAX_QC_ELIGIBILITY_FLOOR,
  });
  if (!result.matched)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Audit trail — the growth director's activity feed records who set the
  // override so the Max-vs-CEO gap has a durable provenance. Best-effort:
  // a write miss doesn't fail the API call (the override itself already landed).
  await recordDirectorActivity(auth.admin, {
    workspaceId: workspaceId as string,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "ceo_postability_override_set",
    specSlug: "bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate",
    reason: cleanReason.slice(0, 500),
    metadata: {
      ad_campaign_id: id,
      override_score: result.override?.override_score ?? null,
      override_by: auth.user.id,
      override_at: result.override?.override_at ?? null,
      score_floor: MAX_QC_ELIGIBILITY_FLOOR,
    },
  }).catch(() => null);
  return NextResponse.json({ override: result.override });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  const result = await clearPostabilityOverride(auth.admin, {
    workspaceId: workspaceId as string,
    adCampaignId: id,
  });
  if (!result.matched)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  await recordDirectorActivity(auth.admin, {
    workspaceId: workspaceId as string,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "ceo_postability_override_cleared",
    specSlug: "bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate",
    reason: `CEO cleared postability override on campaign ${id}`,
    metadata: {
      ad_campaign_id: id,
      cleared_by: auth.user.id,
    },
  }).catch(() => null);
  return NextResponse.json({ ok: true });
}
