import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReminderTestResults } from "@/lib/retention/reminder-results-sdk";

/**
 * GET /api/workspaces/[id]/analytics/renewal-reminder — the read-only pre-renewal-reminder results
 * lens (Retention → Renewal Reminder). Hydrates the M4 results page from the Phase-1 results SDK
 * (src/lib/retention/reminder-results-sdk.ts getReminderTestResults): per-arm engagement + 90-day
 * net revenue + refund rate + the live guardrail status + verdict.
 *
 * Session-authenticated + OWNER-gated (mirrors the Analytics routes). READ-ONLY — mutates nothing in
 * the experiment, ledger, or journey rows.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const results = await getReminderTestResults(admin, workspaceId);
  return NextResponse.json(results);
}
