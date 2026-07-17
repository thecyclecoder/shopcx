import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listResearchUrls } from "@/lib/research-urls";

// Research → Teardowns reader (docs/brain/specs/research-teardowns-view.md, Phase 1). The owner-facing
// window onto Rhea's successful teardowns — the curated gallery, sibling to the broader Landers list.
//   GET ?workspaceId= → workspace's research_urls rows WHERE `teardown IS NOT NULL`, worthiest-first
//   (ordered by ad_count desc). Each row projects the recipe's `funnel_type` + captured date + a
//   showcase href for the founder-approved 'View HTML' board (Phase 2).
// Owner-only (role !== 'owner' → 403), mirroring /api/research/landers.

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
  if (!member || (member.role as string) !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await listResearchUrls(workspaceId, { has_teardown: true, limit: 500 });

  const teardowns = rows.map((r) => ({
    id: r.id,
    url: r.url,
    brand: r.brand,
    domain: r.domain,
    funnel_type: r.teardown?.funnel_type ?? null,
    ad_count: r.ad_count,
    captured_at: r.last_seen,
    showcase_href: `/showcase/tools/teardowns/examples/${r.id}`,
  }));

  return NextResponse.json({ teardowns });
}
