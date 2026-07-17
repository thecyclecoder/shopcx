import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAgentKpis } from "@/lib/agents/agent-kpis";

/**
 * GET /api/workspaces/[id]/agent-kpis?kind={agentKind}
 *
 * Returns the tiered [[../../../../../lib/agents/agent-kpis|computeAgentKpis]] structure for
 * the requested agent kind. Auth + workspace-member gated. Bespoke tiers when a definition
 * is registered (currently `storefront-optimizer`); a generic fallback for every other kind.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  if (!kind) {
    return NextResponse.json(
      { error: "Missing required query param: kind" },
      { status: 400 },
    );
  }

  const kpis = await computeAgentKpis({ workspaceId, agentKind: kind, admin });
  return NextResponse.json(kpis);
}
