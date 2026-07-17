import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signLanderShot, type LanderSkeleton } from "@/lib/landing-page-scout";

// Research → Lander Teardowns reader (docs/brain/specs/research-lander-teardown-viewer.md, Phase 1).
//   GET ?workspaceId=&productId=&competitorId= → captured COMPETITOR funnels, grouped by funnel_root_url
//   (fallback: competitor_id+url for legacy single-step rows), steps ordered by funnel_step. Each step
//   carries { url, brand, status, page_type, skeleton, cta_target_url, chapters: [{ label, index,
//   signed_url }] }. is_ours=true snapshots are excluded — this surface is the competitor teardown view.
// Owner-only (403 for admin/member) to match the spec's role gate.

interface ChapterShot {
  index?: number;
  label?: string;
  screenshot_path?: string;
}

interface SnapshotRow {
  id: string;
  product_id: string | null;
  competitor_id: string | null;
  brand: string | null;
  url: string;
  source: string;
  status: string;
  chapters: ChapterShot[] | null;
  funnel_step: number | null;
  funnel_root_url: string | null;
  cta_target_url: string | null;
  page_type: string | null;
  skeleton: LanderSkeleton | null;
  captured_at: string | null;
  created_at: string;
}

interface TeardownStep {
  id: string;
  url: string;
  brand: string | null;
  status: string;
  funnel_step: number;
  page_type: string | null;
  skeleton: LanderSkeleton | null;
  cta_target_url: string | null;
  captured_at: string | null;
  chapters: Array<{ index: number | null; label: string | null; signed_url: string | null }>;
}

interface TeardownFunnel {
  key: string;
  competitor_id: string | null;
  product_id: string | null;
  brand: string | null;
  root_url: string;
  captured_at: string | null;
  steps: TeardownStep[];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");
  const competitorId = url.searchParams.get("competitorId");

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

  let q = admin
    .from("lander_snapshots")
    .select(
      "id, product_id, competitor_id, brand, url, source, status, chapters, funnel_step, funnel_root_url, cta_target_url, page_type, skeleton, captured_at, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("is_ours", false)
    .order("created_at", { ascending: false })
    .limit(500);
  if (productId) q = q.eq("product_id", productId);
  if (competitorId) q = q.eq("competitor_id", competitorId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as SnapshotRow[];

  // Group by funnel_root_url when present; fall back to competitor_id+url for legacy pre-funnel-follow
  // rows (funnel_root_url is null on those — [[lander_snapshots]] gotchas).
  const groups = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const key = r.funnel_root_url
      ? `root:${r.funnel_root_url}`
      : `solo:${r.competitor_id ?? "none"}:${r.url}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  // Within each group, keep the LATEST capture per (funnel_step, url) — the table is append-only per
  // run, so re-captures produce duplicate rows. Order steps by funnel_step, then created_at.
  const funnels: TeardownFunnel[] = await Promise.all(
    [...groups.entries()].map(async ([key, groupRows]) => {
      const dedup = new Map<string, SnapshotRow>();
      for (const r of groupRows) {
        const k = `${r.funnel_step ?? 0}:${r.url}`;
        const existing = dedup.get(k);
        if (!existing || (r.created_at > existing.created_at)) dedup.set(k, r);
      }
      const ordered = [...dedup.values()].sort((a, b) => {
        const s = (a.funnel_step ?? 0) - (b.funnel_step ?? 0);
        if (s !== 0) return s;
        return a.created_at < b.created_at ? -1 : 1;
      });

      const steps: TeardownStep[] = await Promise.all(
        ordered.map(async (r) => {
          const chapters = await Promise.all(
            (r.chapters ?? []).map(async (ch) => ({
              index: typeof ch.index === "number" ? ch.index : null,
              label: ch.label ?? null,
              signed_url: ch.screenshot_path ? await signLanderShot(ch.screenshot_path) : null,
            })),
          );
          return {
            id: r.id,
            url: r.url,
            brand: r.brand,
            status: r.status,
            funnel_step: r.funnel_step ?? 0,
            page_type: r.page_type,
            skeleton: r.skeleton,
            cta_target_url: r.cta_target_url,
            captured_at: r.captured_at,
            chapters,
          };
        }),
      );

      const head = ordered[0] ?? groupRows[0];
      const rootUrl = head.funnel_root_url ?? head.url;
      const capturedAt = ordered.reduce<string | null>(
        (acc, r) => (r.captured_at && (!acc || r.captured_at > acc) ? r.captured_at : acc),
        null,
      );
      return {
        key,
        competitor_id: head.competitor_id,
        product_id: head.product_id,
        brand: head.brand,
        root_url: rootUrl,
        captured_at: capturedAt,
        steps,
      };
    }),
  );

  // Newest funnel first — most-recently captured group leads.
  funnels.sort((a, b) => {
    if (!a.captured_at && !b.captured_at) return 0;
    if (!a.captured_at) return 1;
    if (!b.captured_at) return -1;
    return a.captured_at < b.captured_at ? 1 : -1;
  });

  return NextResponse.json({ funnels });
}
