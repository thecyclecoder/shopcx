import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// Phase 4b review action — approve or reject one recommendation. Approving flips
// status → 'approved' and fires meta/execute-recommendation, which (Phase 6b)
// creates the PAUSED/draft Meta object and writes ids back — nothing goes live.
// Rejecting → 'rejected'. Both stamp reviewer + timestamp for the audit trail.

async function authorize(workspaceId: string | null, user: { id: string }) {
  const admin = createAdminClient();
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
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

  // Only pending recommendations are reviewable (idempotent: re-approving is a no-op).
  const { data: rec } = await auth.admin
    .from("iteration_recommendations")
    .select("id, status")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!rec) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (rec.status !== "pending")
    return NextResponse.json({ error: `Already ${rec.status}` }, { status: 409 });

  const { data: updated, error } = await auth.admin
    .from("iteration_recommendations")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .eq("status", "pending")
    .select("id, status, reviewed_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Phase 6b — on approval, dispatch execution (creates the PAUSED draft + writes
  // ids back). Fire-and-forget; the adapter is idempotent + leaves anything it
  // can't yet handle deferred. Approval itself already succeeded above.
  if (action === "approve") {
    await inngest
      .send({
        name: "meta/execute-recommendation",
        data: { workspace_id: workspaceId as string, recommendation_id: id },
      })
      .catch(() => {});
  }

  return NextResponse.json({ recommendation: updated });
}
