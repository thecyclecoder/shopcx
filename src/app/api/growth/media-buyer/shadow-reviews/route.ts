import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Growth → Media Buyer shadow reviews (media-buyer-shadow-mode Phase 3).
//
//   GET  ?workspaceId=…            → { open: [{director_activity_id, action_kind, created_at, metadata, reason}] }
//                                    Recent `<verb>_shadow` director_activity rows that LACK a media_buyer_shadow_reviews row.
//                                    Ordered by director_activity.created_at desc, limit 100 — the Growth dashboard tile reads this.
//   POST { director_activity_id, verdict, rationale? }?workspaceId=…
//                                   → 200 { review: {id, verdict, reviewed_at} } — upserts idempotently on director_activity_id.
//                                   400 on validation (missing field / bad verdict).
//                                   404 when director_activity_id is unknown to THIS workspace.
//
// Owner-only, mirrors /api/marketing/landers/blueprints. Service-role write so we can
// upsert past RLS while still confirming the referenced director_activity row actually
// belongs to the caller's workspace (guard-before-mutate: the write only fires when the
// target action row exists AND is scoped to workspaceId).

type Verdict = "concur" | "dissent" | "undecided";
const VALID_VERDICTS = new Set<Verdict>(["concur", "dissent", "undecided"]);

async function authOwnerAdmin(workspaceId: string, userId: string): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();
  if (!member || (member.role as string) !== "owner") {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const auth = await authOwnerAdmin(workspaceId, user.id);
  if (!auth.ok) return auth.res;

  const admin = createAdminClient();

  // 1) Read the most-recent 100 `<verb>_shadow` director_activity rows for the workspace.
  //    LIKE '%_shadow' matches media_buyer_promoted_winner_shadow / _paused_loser_shadow /
  //    _replenished_test_cohort_shadow / _fatigue_replenish_triggered_shadow — the exact four
  //    verbs Phase 2 emits. `director_function='growth'` narrows to the Media Buyer's own rows.
  const { data: rows, error: rowsErr } = await admin
    .from("director_activity")
    .select("id, action_kind, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", "growth")
    .like("action_kind", "%_shadow")
    .order("created_at", { ascending: false })
    .limit(100);
  if (rowsErr) {
    return NextResponse.json({ error: `director_activity read failed: ${rowsErr.message}` }, { status: 500 });
  }
  const activityRows = (rows ?? []) as Array<{
    id: string;
    action_kind: string;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  if (activityRows.length === 0) {
    return NextResponse.json({ open: [] });
  }

  // 2) Find which of those already have a review — the tile only surfaces the OPEN ones.
  //    Bounded IN filter (max 100 ids) so this stays a single indexed lookup.
  const activityIds = activityRows.map((r) => r.id);
  const { data: reviewed } = await admin
    .from("media_buyer_shadow_reviews")
    .select("director_activity_id")
    .eq("workspace_id", workspaceId)
    .in("director_activity_id", activityIds);
  const reviewedSet = new Set(
    ((reviewed ?? []) as Array<{ director_activity_id: string }>).map((r) => r.director_activity_id),
  );

  const open = activityRows
    .filter((r) => !reviewedSet.has(r.id))
    .map((r) => ({
      director_activity_id: r.id,
      action_kind: r.action_kind,
      reason: r.reason,
      metadata: r.metadata,
      created_at: r.created_at,
    }));
  return NextResponse.json({ open });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const auth = await authOwnerAdmin(workspaceId, user.id);
  if (!auth.ok) return auth.res;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { director_activity_id?: unknown; verdict?: unknown; rationale?: unknown };
  const directorActivityId = typeof b.director_activity_id === "string" ? b.director_activity_id.trim() : "";
  const verdict = typeof b.verdict === "string" ? (b.verdict.trim() as Verdict) : ("" as Verdict);
  const rationale = typeof b.rationale === "string" ? b.rationale.trim() : null;
  if (!directorActivityId) {
    return NextResponse.json({ error: "director_activity_id required" }, { status: 400 });
  }
  if (!VALID_VERDICTS.has(verdict)) {
    return NextResponse.json({ error: "verdict must be one of concur | dissent | undecided" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Guard-before-mutate — confirm the referenced director_activity row EXISTS AND belongs to THIS
  // workspace. Without this check, an owner of workspace A could review a row in workspace B; with
  // it, a wrong / unknown id 404s deterministically. (Learning #1 — re-assert read-time preconditions
  // at the write point; don't trust the id proxy.)
  const { data: activity, error: activityErr } = await admin
    .from("director_activity")
    .select("id, workspace_id, action_kind")
    .eq("id", directorActivityId)
    .maybeSingle();
  if (activityErr) {
    return NextResponse.json({ error: `director_activity lookup failed: ${activityErr.message}` }, { status: 500 });
  }
  if (!activity || (activity.workspace_id as string) !== workspaceId) {
    return NextResponse.json({ error: "director_activity_id not found" }, { status: 404 });
  }

  // Upsert on director_activity_id — idempotent re-review; a second POST updates in place.
  const { data: upserted, error: upErr } = await admin
    .from("media_buyer_shadow_reviews")
    .upsert(
      {
        workspace_id: workspaceId,
        director_activity_id: directorActivityId,
        verdict,
        rationale,
        reviewer: user.id,
        reviewed_at: new Date().toISOString(),
      },
      { onConflict: "director_activity_id" },
    )
    .select("id, verdict, reviewed_at")
    .single();
  if (upErr || !upserted) {
    return NextResponse.json({ error: `insert failed: ${upErr?.message ?? "no row"}` }, { status: 500 });
  }

  return NextResponse.json({ review: upserted });
}
