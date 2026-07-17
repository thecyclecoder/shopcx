/**
 * GET /api/developer/agents/model-tier?kind={agentKind} — one agent's current model tier + change
 * history (box-agent-model-tiers spec, Phase 4).
 *
 * Owner-gated, read-only. Returns the agent_model_tiers row for the kind (the resolved tier the box
 * passes as --model, or null = the Max default) plus the recent governed proposals for it (the
 * proposed-model-tier agent_jobs), so the profile can show "Model: {tier}" + the change history. The
 * one-tap Approve on a pending proposal is the existing routed inbox (this route is read-only).
 * See docs/brain/tables/agent_model_tiers.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getModelTier } from "@/lib/agent-model-tiers";
import { MODEL_TIER_PROPOSAL_KIND } from "@/lib/agent-jobs";


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
    return NextResponse.json({ error: "Only the workspace owner can view model tiers" }, { status: 403 });
  }

  const kind = new URL(req.url).searchParams.get("kind");
  if (!kind) return NextResponse.json({ error: "kind is required" }, { status: 400 });

  const current = await getModelTier(admin, workspaceId, kind);

  // The recent governed proposals for this kind — newest first. Each carries its action's summary +
  // status so the profile renders the change history (incl. any pending one awaiting approval).
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, status, pending_actions, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", MODEL_TIER_PROPOSAL_KIND)
    .eq("spec_slug", kind)
    .order("created_at", { ascending: false })
    .limit(20);

  const history = (jobs || []).map((j) => {
    const action = ((j.pending_actions as { type?: string; summary?: string; status?: string }[] | null) || []).find(
      (a) => a.type === "apply_model_tier",
    );
    return {
      jobId: j.id as string,
      jobStatus: j.status as string,
      actionStatus: action?.status ?? null,
      summary: action?.summary ?? null,
      created_at: j.created_at as string,
      updated_at: j.updated_at as string,
    };
  });

  return NextResponse.json({ kind, current, history });
}
