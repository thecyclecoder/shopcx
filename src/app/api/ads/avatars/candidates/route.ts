import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { signedUrl, removeObjects } from "@/lib/ad-storage";
import { AVATAR_GENDERS, AVATAR_HEALTH_LEVELS, AVATAR_ETHNICITIES } from "@/lib/ad-tool-config";

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
  const { user } = await getAuthedUser();
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
      // generating rows have no storage_path yet — null url, UI shows a spinner.
      url: r.storage_path ? await signedUrl(r.storage_path).catch(() => null) : null,
      gender: r.gender,
      age_range: r.age_range,
      health_level: r.health_level,
      ethnicity: r.ethnicity,
      status: r.status,
    })),
  );
  // Drop only completed-but-unsignable rows; keep generating (no url) so the UI
  // can show in-progress placeholders and poll until they're ready.
  return NextResponse.json({ candidates: candidates.filter((c) => c.url || c.status === "generating") });
}

/**
 * POST — kick off N avatar FACE generations (async). Image gen exceeds the
 * Vercel function budget, so this inserts N rows in status='generating' and
 * fires an `ad-tool/face-requested` Inngest event per face, then returns
 * immediately. The Inngest worker generates + uploads + flips each row to
 * 'available'; the UI polls GET until none are 'generating'. ~3 credits per face.
 */
export async function POST(req: Request) {
  const { user } = await getAuthedUser();
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
  if (productId && !proposalId) {
    const { data: prod } = await admin.from("products").select("workspace_id").eq("id", productId).single();
    if (!prod || prod.workspace_id !== workspaceId) productId = null;
  }

  // Insert N 'generating' rows (no image yet), then fire one event per face.
  const rowsToInsert = Array.from({ length: count }, () => ({
    workspace_id: workspaceId,
    proposal_id: proposalId,
    product_id: productId,
    gender,
    age_range: ageRange,
    health_level: healthLevel,
    ethnicity,
    status: "generating",
    created_by: user.id,
  }));
  const { data: rows, error } = await admin.from("ad_avatar_candidates").insert(rowsToInsert).select("id");
  if (error || !rows) return NextResponse.json({ error: error?.message || "insert_failed" }, { status: 500 });

  await Promise.all(
    rows.map((r, i) =>
      inngest.send({
        name: "ad-tool/face-requested",
        data: { workspace_id: workspaceId, candidate_id: r.id, gender, age_range: ageRange, health_level: healthLevel, ethnicity, context, variant: i },
      }),
    ),
  );

  return NextResponse.json({ candidates: rows.map((r) => ({ id: r.id, status: "generating" })) });
}

/** DELETE — permanently remove a saved face from the library (row + storage object). */
export async function DELETE(req: Request) {
  const { user } = await getAuthedUser();
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
