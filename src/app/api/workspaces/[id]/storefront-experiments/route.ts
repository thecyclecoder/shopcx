/**
 * Storefront experiments — the tests index for the owner-facing detail page
 * (docs/brain/specs/storefront-test-detail-page.md Phase 1).
 *
 * GET → every experiment in the workspace (newest/active first) with its product,
 *       status, lever/hypothesis, started_at, arm count, and total exposed sessions —
 *       enough for the index list to render and link into each detail page.
 *
 * Owner/admin only (mirrors the optimizer-policy edit gate): the detail page exposes
 * owner-only preview links, so the whole tests surface is owner-gated.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Active/interesting statuses sort to the top; within a status, newest first. */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  promoted: 1,
  draft: 2,
  rolled_back: 3,
  killed: 4,
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: experiments } = await admin
    .from("storefront_experiments")
    .select("id, product_id, lander_type, audience, lever, hypothesis, status, started_at, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  const rows = experiments ?? [];
  if (!rows.length) return NextResponse.json({ experiments: [] });

  // Product titles for the list.
  const productIds = [...new Set(rows.map((e) => e.product_id))];
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle")
    .in("id", productIds);
  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  // Arm count + total exposed sessions per experiment (the persisted rollup the
  // bandit decides on — no divergent math).
  const { data: variants } = await admin
    .from("storefront_experiment_variants")
    .select("experiment_id, sessions")
    .in(
      "experiment_id",
      rows.map((e) => e.id),
    );
  const armCount = new Map<string, number>();
  const sessionTotal = new Map<string, number>();
  for (const v of variants ?? []) {
    armCount.set(v.experiment_id, (armCount.get(v.experiment_id) ?? 0) + 1);
    sessionTotal.set(v.experiment_id, (sessionTotal.get(v.experiment_id) ?? 0) + (v.sessions ?? 0));
  }

  const list = rows
    .map((e) => {
      const product = productById.get(e.product_id);
      return {
        id: e.id,
        product_id: e.product_id,
        product_title: product?.title ?? null,
        product_handle: product?.handle ?? null,
        lander_type: e.lander_type,
        audience: e.audience,
        lever: e.lever,
        hypothesis: e.hypothesis,
        status: e.status,
        started_at: e.started_at,
        created_at: e.created_at,
        arm_count: armCount.get(e.id) ?? 0,
        sessions: sessionTotal.get(e.id) ?? 0,
      };
    })
    .sort((a, b) => {
      const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (r !== 0) return r;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });

  return NextResponse.json({ experiments: list });
}
