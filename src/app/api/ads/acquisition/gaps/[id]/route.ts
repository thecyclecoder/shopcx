/**
 * Acquisition Research Hub — approve/reject one AD gap (docs/brain/specs/acquisition-research-hub.md,
 * Phase 1). The ad-side mirror of /api/ads/lander-recommendations/[id]: APPROVING enacts the gap's
 * route (only ever after the owner approves) — route='build' enqueues an agent_jobs build for an
 * ad-creative iteration; rejecting just stamps the row. Both stamp reviewer + timestamp. OWNER-ONLY.
 *
 * Lander gaps in the same hub queue are approved via the existing /api/ads/lander-recommendations/[id].
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enactAdGapRoute } from "@/lib/acquisition-hub";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const action: string = body.action; // "approve" | "reject"
  const note: string | null = body.note ?? null;

  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (action !== "approve" && action !== "reject")
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Only proposed gaps are reviewable (idempotent: re-reviewing a settled row is a 409).
  const { data: rec } = await admin
    .from("ad_gap_recommendations")
    .select("id, workspace_id, product_id, gap_type, title, rationale, route, target_slug, evidence, status")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .single();
  if (!rec) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (rec.status !== "proposed")
    return NextResponse.json({ error: `Already ${rec.status}` }, { status: 409 });

  // Approving enacts the route BEFORE flipping status, so a routing failure leaves it reviewable.
  let routeResult: Record<string, unknown> | null = null;
  if (action === "approve") {
    const enacted = await enactAdGapRoute(
      {
        id: rec.id,
        workspace_id: rec.workspace_id,
        product_id: rec.product_id,
        gap_type: rec.gap_type,
        title: rec.title,
        rationale: rec.rationale,
        route: rec.route as "build" | "optimizer",
        target_slug: rec.target_slug,
        evidence: rec.evidence as Record<string, unknown> | null,
      },
      user.id,
    );
    if (!enacted.ok) return NextResponse.json({ error: `routing failed: ${enacted.error}` }, { status: 502 });
    routeResult = enacted.route_result ?? null;
  }

  const { data: updated, error } = await admin
    .from("ad_gap_recommendations")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      route_result: routeResult,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .select("id, gap_type, status, route, route_result, reviewed_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recommendation: updated });
}
