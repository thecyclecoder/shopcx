import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceBySlug } from "@/app/(storefront)/_lib/page-data";

/**
 * Public, CORS-enabled reviews feed for EXTERNAL surfaces (the Shopify theme
 * homepage). Two modes:
 *
 *   GET ?handles=a,b,c   → { byHandle: { handle: review|null } }
 *       One review per product handle for the bestsellers grid — prefers
 *       featured, else the best 5★ with a body.
 *
 *   GET ?limit=6         → { reviews: [...] }
 *       Top featured reviews across the workspace for the homepage reviews
 *       section (the dramatic, real testimonials).
 *
 * CORS: open (reviews are public). Cached at the edge. Shape mirrors the
 * in-house storefront/extension review payload so the same render works.
 */
const REVIEW_COLS = "reviewer_name, rating, title, body, summary, product_id, featured";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
};

type Review = { reviewer_name: string | null; rating: number | null; title: string | null; body: string | null; summary: string | null; product_id: string | null };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace: workspaceSlug } = await params;
  const url = new URL(request.url);
  const ws = await getWorkspaceBySlug(workspaceSlug);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404, headers: CORS });
  const admin = createAdminClient();

  const trim = (r: Review, product_title?: string) => ({
    reviewer_name: r.reviewer_name,
    rating: r.rating,
    title: r.title,
    body: r.body,
    summary: r.summary,
    product_title: product_title || null,
  });

  // ── Per-product mode (bestseller cards) ──
  const handlesParam = url.searchParams.get("handles");
  if (handlesParam) {
    const handles = handlesParam.split(",").map((h) => h.trim()).filter(Boolean).slice(0, 24);
    const { data: products } = await admin
      .from("products")
      .select("id, handle, title")
      .eq("workspace_id", ws.id)
      .in("handle", handles);
    const byHandle: Record<string, ReturnType<typeof trim> | null> = {};
    for (const h of handles) byHandle[h] = null;
    await Promise.all(
      (products || []).map(async (p) => {
        // Prefer a featured review; else best 5★; else best rated — all need a body.
        const { data: revs } = await admin
          .from("product_reviews")
          .select(REVIEW_COLS)
          .eq("workspace_id", ws.id)
          .eq("product_id", p.id)
          .in("status", ["published", "featured"])
          .not("body", "is", null)
          .order("featured", { ascending: false })
          .order("rating", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1);
        if (revs && revs[0]) byHandle[p.handle] = trim(revs[0] as Review, p.title);
      }),
    );
    return NextResponse.json({ byHandle }, { headers: CORS });
  }

  // ── Homepage mode: top featured reviews across the workspace ──
  const limit = Math.min(24, Math.max(1, parseInt(url.searchParams.get("limit") || "6", 10)));
  const { data: revs } = await admin
    .from("product_reviews")
    .select(REVIEW_COLS)
    .eq("workspace_id", ws.id)
    .eq("featured", true)
    .eq("rating", 5)
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(80);
  const pool = (revs || []) as Review[];
  // Title lookup for context line.
  const pids = [...new Set(pool.map((r) => r.product_id).filter(Boolean))] as string[];
  const { data: prods } = pids.length
    ? await admin.from("products").select("id, title").in("id", pids)
    : { data: [] as { id: string; title: string }[] };
  const titles = new Map((prods || []).map((p) => [p.id, p.title]));
  const reviews = pool.slice(0, limit).map((r) => trim(r, titles.get(r.product_id || "") || undefined));
  return NextResponse.json({ reviews, total: pool.length }, { headers: CORS });
}
