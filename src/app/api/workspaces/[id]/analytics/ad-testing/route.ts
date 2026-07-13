import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTestingResults, enrichWithMetaCreatives } from "@/lib/ads/testing-results-sdk";
import { getMetaUserToken } from "@/lib/meta-ads";
import { metaGraphRequest } from "@/lib/meta/api";

/**
 * GET /api/workspaces/[id]/analytics/ad-testing — the read-only Ad Testing lens (Analytics → Ad Testing).
 * Numbers come from meta_insights_daily (kept fresh + today-inclusive by the 2h media-buyer-test-cadence
 * cron); creatives (thumbnail + current copy) are overlaid from the LIVE Meta creative for ACTIVE tests.
 * READ-ONLY. See src/lib/ads/testing-results-sdk.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const results = await getTestingResults(admin, workspaceId);

  // Overlay live Meta creatives on ACTIVE tests (bounds the Graph fan-out). Best-effort — a failed
  // token/read just leaves the DB snapshot, the numbers are unaffected.
  try {
    const token = await getMetaUserToken(workspaceId);
    if (token) {
      const rows = results.products.flatMap((g) => g.rows);
      await enrichWithMetaCreatives(rows, token, metaGraphRequest, { onlyActive: true, concurrency: 6 });
    }
  } catch {
    /* creatives are best-effort; the funnel numbers stand on their own */
  }

  return NextResponse.json(results);
}
