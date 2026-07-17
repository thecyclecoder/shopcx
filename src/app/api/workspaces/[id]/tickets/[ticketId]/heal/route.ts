/**
 * POST { research_run_id, gap_id } — execute the gap's proposed_heal
 * synchronously. Re-verifies the gap exists, runs the action, re-verifies
 * the gap closed, sends the customer follow-up, closes the ticket.
 *
 * Returns the full heal_attempt outcome so the dashboard can render it
 * inline without polling.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeHeal } from "@/lib/inngest/ticket-research";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  const { id: workspaceId, ticketId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { research_run_id, gap_id } = await request.json().catch(() => ({}));
  if (!research_run_id || !gap_id) {
    return NextResponse.json({ error: "research_run_id + gap_id required" }, { status: 400 });
  }

  const result = await executeHeal(ticketId, research_run_id, gap_id, user.id);
  return NextResponse.json(result);
}
