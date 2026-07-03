import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listResearchUrls,
  type ResearchUrlClassification,
  type ResearchUrlVerdict,
} from "@/lib/research-urls";

// Research → Landers reader (docs/brain/specs/research-landers-viewer.md, Phase 1). The owner-facing
// window onto Rhea's URL sensor output — the list surface for /dashboard/research/landers.
//   GET ?workspaceId=&classification=&verdict= → workspace's research_urls rows worthiest-first
//   (ordered by ad_count desc), each carrying `has_teardown` so the UI can mark the clickable ones.
// Owner-only (role !== 'owner' → 403), mirroring the sibling /api/ads/lander-teardowns surface.

const CLASSIFICATIONS: readonly ResearchUrlClassification[] = [
  "advertorial",
  "quiz",
  "generic_pdp",
  "homepage",
  "spam",
  "unviewable",
  "excluded",
  "checkout",
];

const VERDICTS: readonly ResearchUrlVerdict[] = ["worthy", "not_worthy", "unreviewed"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const classification = url.searchParams.get("classification");
  const verdict = url.searchParams.get("verdict");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const filter: {
    classification?: ResearchUrlClassification;
    teardown_verdict?: ResearchUrlVerdict;
    limit?: number;
  } = { limit: 500 };
  if (classification && CLASSIFICATIONS.includes(classification as ResearchUrlClassification)) {
    filter.classification = classification as ResearchUrlClassification;
  }
  if (verdict && VERDICTS.includes(verdict as ResearchUrlVerdict)) {
    filter.teardown_verdict = verdict as ResearchUrlVerdict;
  }

  const rows = await listResearchUrls(workspaceId, filter);

  // Project down to the list-view shape the spec calls out — omit the (potentially large) `teardown`
  // recipe here; the detail endpoint returns it. `has_teardown` is the flag the list uses to mark
  // clickable rows.
  const landers = rows.map((r) => ({
    id: r.id,
    url: r.url,
    brand: r.brand,
    domain: r.domain,
    classification: r.classification,
    ad_count: r.ad_count,
    teardown_verdict: r.teardown_verdict,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    has_teardown: r.teardown !== null,
  }));

  return NextResponse.json({ landers });
}
