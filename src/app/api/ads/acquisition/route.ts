/**
 * Acquisition Research Hub — the owner-only aggregation surface
 * (docs/brain/specs/acquisition-research-hub.md, Phase 1; M4 of the Acquisition Research Engine).
 *
 *   GET ?workspaceId=&productId=
 *     → { products, selectedProductId, competitors, adFindings, landerSnapshots, gapQueue, throughput }
 *       the competitor set + both scouts' findings + the UNIFIED gap queue (ad + lander gaps, with
 *       derived shipped/won) + gap-throughput stats. Materializes the current ad gaps as a side-effect
 *       (idempotent) so they enter the trackable queue.
 *
 * OWNER-ONLY (the negative test: a non-owner cannot access). Read/propose only — nothing routes here.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadHubData } from "@/lib/acquisition-hub";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");

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
  if (!member || member.role !== "owner")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const data = await loadHubData(workspaceId, productId);
  return NextResponse.json(data);
}
