import { NextResponse } from "next/server";
import { errText } from "@/lib/error-text";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompetitor, setCompetitorStatus } from "@/lib/competitors";
import { setSkeletonDoNotUse } from "@/lib/creative-skeleton";

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
      { error: errText(err) },
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

// flag-a-competitor-ad-do-not-use Phase 2 — the CEO's per-AD "don't use" toggle.
//
// Under PATCH, the URL `[id]` addresses a `creative_skeletons` row (one competitor AD), not a
// competitor brand row (which is what POST's `[id]` addresses). Deliberately verb-scoped: the
// flag is per-AD by design (a brand can hold both great and lame ads — CEO's Magic Mind vs.
// Onnit case), so the resource under PATCH is the skeleton. The write goes through the sole
// chokepoint `setSkeletonDoNotUse` in src/lib/creative-skeleton.ts (workspace-scoped +
// compare-and-set); the flag is honored by `queryProvenAngles` in src/lib/ads/creative-sourcing.ts
// (Phase 1) so a flagged ad never becomes an imitation angle for Dahlia.
//
// Body: { workspaceId: string, doNotUse: boolean, reason?: string | null }.
// The `by` audit column is stamped 'ceo' server-side — this route is the manual-flag path; the
// Phase-3 Max grader calls `setSkeletonDoNotUse` directly with `by='max'`, not through here.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: skeletonId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string;
    doNotUse?: boolean;
    reason?: string | null;
  };
  const workspaceId: string | null = body.workspaceId ?? null;
  if (typeof body.doNotUse !== "boolean")
    return NextResponse.json({ error: "doNotUse (boolean) required" }, { status: 400 });

  const auth = await authorize(workspaceId, user);
  if (auth.error) return auth.error;

  try {
    const ok = await setSkeletonDoNotUse({
      workspaceId: workspaceId as string,
      skeletonId,
      doNotUse: body.doNotUse,
      reason: body.doNotUse ? (body.reason ?? "ceo_manual") : null,
      by: "ceo",
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json(
      { error: errText(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, do_not_use: body.doNotUse });
}
