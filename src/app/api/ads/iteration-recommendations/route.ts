import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 4b review surface — list the engine's approval-gated recommendations so
// Dylan can approve/reject. Read-only here (no external side effects); Phase 6b
// executes approved rows as PAUSED drafts. Filter by `?workspaceId=&status=&adAccountId=`.

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

const STATUSES = ["pending", "approved", "rejected", "executed", "failed"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const status = url.searchParams.get("status");
  const adAccountId = url.searchParams.get("adAccountId");

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  let q = auth.admin
    .from("iteration_recommendations")
    .select(
      "id, snapshot_date, action_type, status, persona, title, rationale, source_metrics, expected_impact, confidence, target_object_level, target_object_id, params, source_scorecard_ids, reviewed_by, reviewed_at, review_note, executed_at, external_result, created_at",
    )
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false })
    .limit(200);

  if (adAccountId) q = q.eq("meta_ad_account_id", adAccountId);
  if (status && STATUSES.includes(status)) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recommendations: data ?? [] });
}
