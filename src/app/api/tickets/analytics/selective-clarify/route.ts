/**
 * /api/tickets/analytics/selective-clarify — 7-day rolling selective-clarify rate.
 *
 * Phase 2 of docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md.
 * Powers the "Selective-clarify rate (target ~6%)" tile at /dashboard/tickets/analytics.
 * Read-only. Owner/admin/cs_manager only.
 *
 * Response: { window_days: 7, total: number, clarified: number, rate: number,
 *             by_outcome: Record<string, number>, target: 0.06 }
 *
 * `rate` sits near 0.06 (~6%) when the gate is calibrated. If it climbs toward 0.38
 * we're back in the blanket-clarify regime the parent goal rejects — that's the
 * signal to tighten IRREVERSIBLE_SET or bump clarify-below downward via policies.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows } = await admin
    .from("ticket_resolution_events")
    .select("verified_outcome")
    .eq("workspace_id", workspaceId)
    .gte("staged_at", since);

  const byOutcome: Record<string, number> = { confirmed: 0, unbacked: 0, drifted: 0, clarified: 0, unknown: 0 };
  let total = 0;
  for (const r of rows ?? []) {
    total += 1;
    const outcome = (r as { verified_outcome: string | null }).verified_outcome ?? "unknown";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }
  const clarified = byOutcome.clarified ?? 0;
  const rate = total > 0 ? clarified / total : 0;

  return NextResponse.json({
    window_days: 7,
    total,
    clarified,
    rate,
    by_outcome: byOutcome,
    target: 0.06,
  });
}
