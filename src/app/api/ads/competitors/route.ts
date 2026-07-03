import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// Competitor Scout owner surface (docs/brain/specs/competitor-scout.md, Phase 1).
//   GET  ?workspaceId=&status=&productId=  → list competitors (proposed/approved/rejected)
//   POST { workspaceId, productId }        → fire the discovery pass for one product
// Approve/reject one row lives in ./[id]/route.ts. Owner/admin only.

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

  let q = auth.admin
    .from("competitors")
    .select(
      "id, product_id, brand, domain, pdp_urls, category, spend_signal, source, status, evidence, search_keyword, runs_ads_for, reviewed_by, reviewed_at, review_note, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false })
    .limit(500);

  if (status && STATUSES.includes(status)) q = q.eq("status", status);
  // Product filter semantics: when a product is selected, still include workspace-level
  // (product_id IS NULL) competitors — the seeds are all null-scoped, so a naive equality
  // filter would render an empty list. See docs/brain/dashboard/research__competitors.md.
  if (productId) q = q.or(`product_id.eq.${productId},product_id.is.null`);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve `runs_ads_for` (self-FK) → the fronted competitor's brand so the UI can render
  // "runs ads for {brand}" without a second lookup. Whitelisted-page rows only.
  const rows = data ?? [];
  const runsAdsForIds = Array.from(
    new Set(rows.map((r) => r.runs_ads_for as string | null).filter((v): v is string => !!v)),
  );
  const idToBrand = new Map<string, string>();
  if (runsAdsForIds.length) {
    const { data: fronted } = await auth.admin
      .from("competitors")
      .select("id, brand")
      .eq("workspace_id", workspaceId as string)
      .in("id", runsAdsForIds);
    for (const r of fronted || []) idToBrand.set(r.id as string, (r.brand as string) || "");
  }
  const withResolved = rows.map((r) => ({
    ...r,
    runs_ads_for_brand: r.runs_ads_for ? idToBrand.get(r.runs_ads_for as string) || null : null,
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
