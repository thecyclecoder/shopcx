/**
 * /api/tickets/[id]/resolution-context — GET the ticket's latest resolution event +
 * confidence-gated established problem.
 *
 * Phase 1 of docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md.
 * Powers the "context view" tile at the top of the Improve tab (src/app/dashboard/tickets/[id]/page.tsx)
 * so an operator entering the tab sees the current turn's reasoning + (when a high-confidence
 * problem is locked in) the established problem the box is anchored to.
 *
 * Read-only. Gated to the same roles as the Improve tab (owner / admin / cs_manager).
 * Response:
 *   { latest: { turn, reasoning, confidence, problem } | null,
 *     established: { turn, problem } | null,
 *     threshold: number }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ticketId } = await params;

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
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, channel")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const channel: string = (ticket.channel as string) || "email";

  const { data: channelConfig } = await admin
    .from("ai_channel_config")
    .select("problem_lockin_threshold")
    .eq("workspace_id", workspaceId)
    .eq("channel", channel)
    .maybeSingle();
  const threshold: number =
    typeof channelConfig?.problem_lockin_threshold === "number"
      ? channelConfig.problem_lockin_threshold
      : 0.7;

  const { data: latest } = await admin
    .from("ticket_resolution_events")
    .select("turn_index, reasoning, confidence, problem")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .order("turn_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: locked } = await admin
    .from("ticket_resolution_events")
    .select("turn_index, problem")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .not("problem", "is", null)
    .gte("confidence", threshold)
    .order("turn_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const established =
    locked && typeof locked.problem === "string" && locked.problem.trim().length > 0
      ? { turn: locked.turn_index as number, problem: locked.problem }
      : null;

  return NextResponse.json({
    latest: latest
      ? {
          turn: latest.turn_index as number,
          reasoning: (latest.reasoning as string | null) ?? null,
          confidence: (latest.confidence as number | null) ?? null,
          problem: (latest.problem as string | null) ?? null,
        }
      : null,
    established,
    threshold,
  });
}
