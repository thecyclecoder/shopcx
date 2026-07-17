import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enactRecommendationRoute } from "@/lib/landing-page-scout";

// Landing Page Scout review action (docs/brain/specs/landing-page-scout.md, Phase 1) — approve or
// reject one proposed lander-gap recommendation. APPROVING enacts its route (supervisable: only ever
// after the owner approves): route='build' enqueues an agent_jobs build for the missing component
// spec; route='optimizer' stands up a storefront_experiments DRAFT. Rejecting just stamps the row.
// Both stamp the reviewer + timestamp for the audit trail. Owner/admin only.

async function authorize(workspaceId: string | null, user: { id: string }) {
  const admin = createAdminClient();
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { admin };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const action: string = body.action; // "approve" | "reject"
  const note: string | null = body.note ?? null;

  if (action !== "approve" && action !== "reject")
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });

  const auth = await authorize(workspaceId, user);
  if (auth.error) return auth.error;

  // Only proposed recommendations are reviewable (idempotent: re-reviewing a settled row is a no-op).
  const { data: rec } = await auth.admin
    .from("lander_recommendations")
    .select("id, workspace_id, product_id, gap_type, title, rationale, route, target_slug, evidence, status")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!rec) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (rec.status !== "proposed")
    return NextResponse.json({ error: `Already ${rec.status}` }, { status: 409 });

  // Approving enacts the route BEFORE flipping status, so a routing failure leaves it reviewable.
  let routeResult: Record<string, unknown> | null = null;
  if (action === "approve") {
    const enacted = await enactRecommendationRoute(
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

  const { data: updated, error } = await auth.admin
    .from("lander_recommendations")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      route_result: routeResult,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .eq("status", "proposed")
    .select("id, gap_type, status, route, route_result, reviewed_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recommendation: updated });
}
