import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Competitor Scout review action (docs/brain/specs/competitor-scout.md, Phase 1) — approve or
// reject one proposed competitor. Approving flips status → 'approved' (it then enters the
// creative-finder sweep on the next run); rejecting → 'rejected' (the row stays, so the UNIQUE
// brand key blocks it from re-surfacing in a later discovery/category-sweep pass). Both stamp the
// reviewer + timestamp for the audit trail. Owner/admin only.

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const action: string = body.action; // "approve" | "reject"
  const note: string | null = body.note ?? null;

  if (action !== "approve" && action !== "reject")
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });

  const auth = await authorize(workspaceId, user);
  if (auth.error) return auth.error;

  // Only proposed competitors are reviewable (idempotent: re-reviewing a settled row is a no-op).
  const { data: row } = await auth.admin
    .from("competitors")
    .select("id, status")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "proposed")
    return NextResponse.json({ error: `Already ${row.status}` }, { status: 409 });

  const { data: updated, error } = await auth.admin
    .from("competitors")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .eq("status", "proposed")
    .select("id, brand, status, reviewed_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ competitor: updated });
}
