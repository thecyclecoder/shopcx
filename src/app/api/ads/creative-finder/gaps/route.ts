/**
 * Ad Creative Scout — the ad-gap layer (docs/brain/specs/ad-creative-scout.md, Phase 1).
 *
 *   GET ?workspaceId=&minBrands=&minDaysRunning=
 *     → competitor winning ANGLES we don't run, ranked by independent-brand recurrence +
 *       longevity + spend, each with the supporting ad evidence (advertiser, destination domain,
 *       creative). Computed on demand (deterministic, no LLM spend) — same as the pattern matrix.
 *
 * Proposes; the Growth director approves what becomes an ad iteration. See acquisition-research-engine.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAdGapReport } from "@/lib/ad-gap";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const minBrands = Number(url.searchParams.get("minBrands")) || 1;
  const minDaysRunning = Number(url.searchParams.get("minDaysRunning")) || 0;
  const report = await buildAdGapReport(workspaceId, { minBrands, minDaysRunning });
  return NextResponse.json(report);
}
