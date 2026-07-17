/**
 * GET /api/developer/agents/decisions?role={ceo|slug}&decision=&autonomy= — a role's Decision
 * history (approval-routing-engine spec, Phase 3 — the supervisable-autonomy ledger).
 *
 * Owner-gated, read-only. Reads public.approval_decisions: the CEO sees EVERY routed decision in
 * the workspace (the guarantee that the CEO can always audit what any proxy decided + why); a
 * director sees only the decisions routed to it. Filterable by function (CEO only), decision, and
 * autonomous-vs-human. See docs/brain/tables/approval_decisions.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CEO } from "@/lib/agents/approval-router";
import { listApprovalDecisions, type DecisionHistoryFilters, type DecisionOutcome } from "@/lib/agents/approval-decisions";


const DECISIONS: DecisionOutcome[] = ["approved", "declined", "escalated"];

export async function GET(req: Request) {
  const { user } = await getAuthedUser();
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
    return NextResponse.json({ error: "Only the workspace owner can view decision history" }, { status: 403 });
  }

  const url = new URL(req.url);
  const role = url.searchParams.get("role") || CEO;
  const decisionParam = url.searchParams.get("decision");
  const autonomyParam = url.searchParams.get("autonomy"); // "autonomous" | "human" | null
  const fnParam = url.searchParams.get("function");

  const filters: DecisionHistoryFilters = {};
  if (decisionParam && DECISIONS.includes(decisionParam as DecisionOutcome)) filters.decision = decisionParam as DecisionOutcome;
  if (autonomyParam === "autonomous") filters.autonomous = true;
  else if (autonomyParam === "human") filters.autonomous = false;
  if (fnParam) filters.routedToFunction = fnParam;

  const items = await listApprovalDecisions(admin, workspaceId, role, filters);
  return NextResponse.json({ role, items });
}
