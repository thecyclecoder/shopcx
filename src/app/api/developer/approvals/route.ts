/**
 * GET /api/developer/approvals — the unified Approvals activity feed (developer/approvals dashboard).
 *
 * Owner-gated, read-only. Returns the pending routed approval queue + the approval_decisions ledger,
 * merged newest-first and enriched off each item's agent_jobs row (spec · milestone/goal · phase ·
 * who raised it · who it routed to · type). The escalated-to-human items carry inline Approve/Decline
 * affordances (decided via the unchanged POST /api/roadmap/approve path).
 *
 * `?count=1` short-circuits to just the escalated-to-human count (the sidebar badge — keeps the
 * always-mounted sidebar off the full enrichment query). See docs/brain/dashboard/approvals.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildApprovalsFeed, countEscalatedApprovals } from "@/lib/agents/approvals-feed";

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
    return NextResponse.json({ error: "Only the workspace owner can view approvals" }, { status: 403 });
  }

  // Lightweight count-only path for the sidebar badge.
  if (new URL(req.url).searchParams.get("count")) {
    const escalatedCount = await countEscalatedApprovals(admin, workspaceId);
    return NextResponse.json({ escalatedCount });
  }

  const feed = await buildApprovalsFeed(admin, workspaceId);
  return NextResponse.json(feed);
}
