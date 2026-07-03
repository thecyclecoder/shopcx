/**
 * GET /api/developer/pulse — the founder-pulse cached five-lens snapshot
 * (founder-pulse Phase 2). Owner-gated, read-only in the default path;
 * with `?refresh=1` recomputes from digests + specs + jobs, upserts into
 * pulse_snapshots, and returns the fresh row.
 *
 * See docs/brain/specs/founder-pulse.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPulse, getPulseSnapshot, persistPulseSnapshot, synthesizeDeterministic, type PulseSnapshot } from "@/lib/pulse";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view the pulse" }, { status: 403 });
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const subject = url.searchParams.get("subject") || "founder";

  if (!refresh) {
    const cached = await getPulseSnapshot(admin, workspaceId, subject);
    if (cached) return NextResponse.json(cached);
    // No snapshot yet → fall through to a first-run computation.
  }

  let snapshot: PulseSnapshot;
  try {
    snapshot = await buildPulse({ workspaceId, subject, admin, narrate: refresh });
  } catch (err) {
    // A build failure must not leave the founder with a blank page — return an empty deterministic
    // synthesis so the surface still renders. The failure surfaces via the empty lenses + model tag.
    console.error("[pulse] buildPulse failed:", err);
    snapshot = synthesizeDeterministic({ digests: [], specs: [], jobs: [] }, { subject });
  }
  const { synthesized_at } = await persistPulseSnapshot(admin, workspaceId, snapshot);
  return NextResponse.json({ ...snapshot, synthesized_at });
}
