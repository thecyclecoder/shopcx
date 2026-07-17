import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Landing Page Scout recommendations list (docs/brain/specs/landing-page-scout.md, Phase 1).
//   GET ?workspaceId=&status=&productId=  → list gap recommendations (proposed/approved/rejected)
// Approve/reject one row (which routes it to Build / the optimizer) lives in ./[id]/route.ts. Owner/admin only.

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

const STATUSES = ["proposed", "approved", "rejected"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const status = url.searchParams.get("status");
  const productId = url.searchParams.get("productId");

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  let q = auth.admin
    .from("lander_recommendations")
    .select("id, product_id, gap_type, title, rationale, route, target_slug, evidence, status, route_result, reviewed_by, reviewed_at, review_note, created_at")
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false })
    .limit(500);

  if (status && STATUSES.includes(status)) q = q.eq("status", status);
  if (productId) q = q.eq("product_id", productId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recommendations: data ?? [] });
}
