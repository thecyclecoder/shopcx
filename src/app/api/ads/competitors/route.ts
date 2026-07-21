import { NextResponse } from "next/server";
import { errText } from "@/lib/error-text";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import {
  getCompetitorBrandsById,
  listCompetitors,
  type CompetitorStatus,
} from "@/lib/competitors";

// Competitor Scout owner surface (docs/brain/specs/competitor-scout.md, Phase 1).
//   GET  ?workspaceId=&status=&productId=  → list competitors (proposed/approved/rejected)
//   POST { workspaceId, productId }        → fire the discovery pass for one product
// Approve/reject one row lives in ./[id]/route.ts. Owner/admin only.
//
// All competitor reads/writes go through the src/lib/competitors.ts SDK — the chokepoint enforced
// by scripts/_check-competitors-sdk-compliance.ts. See CLAUDE.md § Local conventions.

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

const STATUSES = ["proposed", "approved", "rejected"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const status = url.searchParams.get("status");
  const productId = url.searchParams.get("productId");

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  // Product filter semantics (Phase 2 of [[competitor-sdk-chokepoint-and-per-product-cleanup]]):
  // strict per-product — a selected productId returns ONLY that product's rows. The legacy
  // `product_id.eq.{id} OR product_id.is.null` fold is retired here so the owner surface reflects
  // the selected product only; Phase 3 purges the null-scoped seed rows the fold used to include.
  let rows;
  try {
    rows = await listCompetitors({
      workspaceId: workspaceId as string,
      status:
        status && STATUSES.includes(status) ? (status as CompetitorStatus) : undefined,
      productId: productId ?? undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: errText(err) },
      { status: 500 },
    );
  }

  // Resolve `runs_ads_for` (self-FK) → the fronted competitor's brand so the UI can render
  // "runs ads for {brand}" without a second lookup. Whitelisted-page rows only.
  const runsAdsForIds = Array.from(
    new Set(rows.map((r) => r.runs_ads_for).filter((v): v is string => !!v)),
  );
  const idToBrand = await getCompetitorBrandsById(workspaceId as string, runsAdsForIds);

  // Per-competitor AD YIELD — Static vs Video counts from creative_skeletons (competitor-ad-yield).
  // A competitor with 0 in BOTH is the "bad seed" signal (wrong/generic search_keyword, or the brand
  // simply isn't running ads) — the founder acts on it (fix the keyword or replace). Direct read mirrors
  // the /api/ads/creative-finder route (creative_skeletons has no SDK chokepoint). media_type is the
  // clean discriminator: 'static' vs 'video'.
  const compIds = rows.map((r) => r.id);
  const counts = new Map<string, { static_count: number; video_count: number }>();
  if (compIds.length) {
    const { data: sk } = await auth.admin
      .from("creative_skeletons")
      .select("competitor_id, media_type")
      .eq("workspace_id", workspaceId as string)
      .in("competitor_id", compIds);
    for (const s of (sk ?? []) as { competitor_id: string | null; media_type: string | null }[]) {
      if (!s.competitor_id) continue;
      const e = counts.get(s.competitor_id) ?? { static_count: 0, video_count: 0 };
      if (s.media_type === "video") e.video_count += 1;
      else e.static_count += 1;
      counts.set(s.competitor_id, e);
    }
  }

  const withResolved = rows.map((r) => ({
    ...r,
    runs_ads_for_brand: r.runs_ads_for ? idToBrand.get(r.runs_ads_for) || null : null,
    static_count: counts.get(r.id)?.static_count ?? 0,
    video_count: counts.get(r.id)?.video_count ?? 0,
  }));

  return NextResponse.json({ competitors: withResolved });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const productId: string | null = body.productId ?? null;

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  // Discovery is the LLM + web-search pass; run it async (it can take a while + spends tokens).
  await inngest
    .send({ name: "ads/competitor-scout.discover", data: { workspaceId, productId } })
    .catch(() => {});

  return NextResponse.json({ ok: true, dispatched: { workspaceId, productId } });
}
