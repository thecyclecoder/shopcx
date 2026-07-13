import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  // Product filter semantics (Phase 1 preserves current behavior via `includeUnscoped: true`):
  // when a product is selected, still include workspace-level (product_id IS NULL) competitors —
  // the legacy seeds are all null-scoped, so a naive equality filter would render an empty list.
  // Phase 2 of [[competitor-sdk-chokepoint-and-per-product-cleanup]] drops the null-scope fold.
  let rows;
  try {
    rows = await listCompetitors({
      workspaceId: workspaceId as string,
      status:
        status && STATUSES.includes(status) ? (status as CompetitorStatus) : undefined,
      productId: productId ?? undefined,
      includeUnscoped: !!productId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Resolve `runs_ads_for` (self-FK) → the fronted competitor's brand so the UI can render
  // "runs ads for {brand}" without a second lookup. Whitelisted-page rows only.
  const runsAdsForIds = Array.from(
    new Set(rows.map((r) => r.runs_ads_for).filter((v): v is string => !!v)),
  );
  const idToBrand = await getCompetitorBrandsById(workspaceId as string, runsAdsForIds);
  const withResolved = rows.map((r) => ({
    ...r,
    runs_ads_for_brand: r.runs_ads_for ? idToBrand.get(r.runs_ads_for) || null : null,
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
