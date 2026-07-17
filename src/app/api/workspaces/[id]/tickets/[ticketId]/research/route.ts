/**
 * GET  — list the latest ticket_research_runs for a ticket (one per recipe).
 * POST — { recipes: ["verify_coupon_promises", ...] } manually run those
 *        recipes synchronously. Returns the results inline so the dashboard
 *        can show them without a poll round-trip.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecipe, getRecipe, listRecipes } from "@/lib/research";

export async function GET(
  _req: Request,
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

  const { data: runs } = await admin
    .from("ticket_research_runs")
    .select("id, recipe_slug, recipe_version, ran_at, findings, gaps, triggered_by, source_analysis_id")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .order("ran_at", { ascending: false });

  // Group by recipe_slug, keep the most recent per recipe
  type RunRow = NonNullable<typeof runs>[number];
  const latestByRecipe = new Map<string, RunRow>();
  for (const r of (runs as RunRow[]) || []) {
    if (!latestByRecipe.has(r.recipe_slug as string)) latestByRecipe.set(r.recipe_slug as string, r);
  }

  // Also include the prior heal_attempts so the UI can show what's already healed
  const { data: heals } = await admin
    .from("ticket_heal_attempts")
    .select("id, gap_id, action_type, status, attempted_at, error, customer_message_sent")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .order("attempted_at", { ascending: false });

  return NextResponse.json({
    runs: Array.from(latestByRecipe.values()),
    all_runs: runs || [],
    heals: heals || [],
    available_recipes: listRecipes().map(r => ({ slug: r.slug, description: r.description, version: r.version })),
  });
}

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

  const { recipes } = await request.json().catch(() => ({}));
  if (!Array.isArray(recipes) || recipes.length === 0) {
    return NextResponse.json({ error: "recipes array required" }, { status: 400 });
  }

  const results: Array<{ slug: string; runId?: string; findings: number; gaps: number; error?: string }> = [];
  for (const slug of recipes as string[]) {
    if (!getRecipe(slug)) {
      results.push({ slug, findings: 0, gaps: 0, error: "Unknown recipe" });
      continue;
    }
    const r = await runRecipe(slug, ticketId, { triggeredBy: "manual" });
    if ("error" in r) {
      results.push({ slug, findings: 0, gaps: 0, error: r.error });
    } else {
      results.push({ slug, runId: r.runId, findings: r.result.findings.length, gaps: r.result.gaps.length });
    }
  }

  return NextResponse.json({ results });
}
