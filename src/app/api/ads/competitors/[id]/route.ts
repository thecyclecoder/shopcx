import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompetitor, setCompetitorStatus } from "@/lib/competitors";

// Competitor Scout review action (docs/brain/specs/competitor-scout.md, Phase 1) — approve or
// reject one proposed competitor. Approving flips status → 'approved' (it then enters the
// creative-finder sweep on the next run); rejecting → 'rejected' (the row stays, so the UNIQUE
// brand key blocks it from re-surfacing in a later discovery/category-sweep pass). Both stamp the
// reviewer + timestamp for the audit trail. Owner/admin only.
//
// The row read + status flip go through the src/lib/competitors.ts SDK chokepoint
// (see CLAUDE.md § Local conventions + scripts/_check-competitors-sdk-compliance.ts).

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
  const row = await getCompetitor(id, { workspaceId: workspaceId as string });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "proposed")
    return NextResponse.json({ error: `Already ${row.status}` }, { status: 409 });

  let updated;
  try {
    updated = await setCompetitorStatus(
      id,
      action === "approve" ? "approved" : "rejected",
      user.id,
      note,
      { workspaceId: workspaceId as string, expectedStatus: "proposed" },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    competitor: {
      id: updated.id,
      brand: updated.brand,
      status: updated.status,
      reviewed_at: updated.reviewed_at,
    },
  });
}
