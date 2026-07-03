import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResearchUrl, listResearchShotChapters } from "@/lib/research-urls";

// Research → Landers detail (docs/brain/specs/research-landers-viewer.md, Phase 1). The full
// research_urls row for one lander — INCLUDES the structured `teardown` recipe (see
// libraries/research-urls TeardownRecipe) and, when `capture_ref` is populated, a `chapters[]`
// list where each entry carries a short-lived signed URL under the private `research-shots`
// bucket. Owner-only (role !== 'owner' → 403).
//
//   GET /api/research/landers/[id]?workspaceId=… → { lander: { …row, chapters: [{ index, label,
//                                                     signed_url }] } }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || (member.role as string) !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const row = await getResearchUrl(workspaceId, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const chapters = await listResearchShotChapters(row.capture_ref);

  return NextResponse.json({
    lander: {
      id: row.id,
      url: row.url,
      brand: row.brand,
      domain: row.domain,
      classification: row.classification,
      ad_count: row.ad_count,
      teardown_verdict: row.teardown_verdict,
      rationale: row.rationale,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      capture_ref: row.capture_ref,
      classified_at: row.classified_at,
      classified_by: row.classified_by,
      teardown: row.teardown,
      chapters,
    },
  });
}
