/**
 * Storefront experiment detail — both-arm preview links + per-arm funnel for ONE
 * experiment (docs/brain/specs/storefront-test-detail-page.md Phase 1).
 *
 * GET → the experiment (status / lever / hypothesis / started_at), its product, and
 *       every arm side by side with the full funnel from
 *       [[storefront-experiment-funnel]] (sessions, engagement %, ATC, lead,
 *       conversion, sub-attach, predicted-LTV/visitor, rev/visitor) + win-probability
 *       vs control, plus a per-arm owner-only preview link that forces that arm and is
 *       exposure-excluded (`sx_internal=1`).
 *
 * Outcome counts read straight off the persisted rollups the bandit decides on — the
 * detail page and the promote/kill decision never disagree. Owner/admin only.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeExperimentFunnel, type VariantRollupRow } from "@/lib/storefront/experiment-funnel";
import { renderVariantForLanderType, type LanderType } from "@/lib/storefront/experiments";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; experimentId: string }> },
) {
  const { id: workspaceId, experimentId } = await params;
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

  const { data: experiment } = await admin
    .from("storefront_experiments")
    .select(
      "id, workspace_id, product_id, lander_type, audience, lever, hypothesis, status, holdout_pct, promoted_variant_id, started_at, stopped_at, rolled_back_at, rollback_reason, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", experimentId)
    .maybeSingle();
  if (!experiment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [{ data: product }, { data: workspace }, { data: variantRows }] = await Promise.all([
    admin.from("products").select("id, title, handle").eq("id", experiment.product_id).maybeSingle(),
    admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).maybeSingle(),
    admin
      .from("storefront_experiment_variants")
      .select("id, experiment_id, label, is_control, sessions, conversions, sub_attach, revenue_cents, ltv_proxy_cents, alpha, beta")
      .eq("experiment_id", experimentId)
      .order("is_control", { ascending: false }),
  ]);

  const variants = (variantRows as VariantRollupRow[]) ?? [];
  const arms = await computeExperimentFunnel({ admin, workspaceId, variants });

  // Owner-only preview link per arm: forces that arm (`sx_preview`) and is
  // exposure-excluded (`sx_internal=1`). Null if we can't build a public URL.
  const renderVariant = renderVariantForLanderType(experiment.lander_type as LanderType);
  // PDP (renderVariant null) = the bare product page; only non-PDP landers take a ?variant=.
  const variantParam = renderVariant ? `variant=${renderVariant}&` : "";
  const slug = workspace?.storefront_slug ?? null;
  const handle = product?.handle ?? null;
  const previewByVariant = new Map<string, string | null>();
  for (const v of variants) {
    previewByVariant.set(
      v.id,
      slug && handle
        ? `/store/${slug}/${handle}?${variantParam}sx_preview=${experimentId}:${v.id}&sx_internal=1`
        : null,
    );
  }

  return NextResponse.json({
    experiment: {
      id: experiment.id,
      lander_type: experiment.lander_type,
      audience: experiment.audience,
      lever: experiment.lever,
      hypothesis: experiment.hypothesis,
      status: experiment.status,
      holdout_pct: experiment.holdout_pct,
      promoted_variant_id: experiment.promoted_variant_id,
      started_at: experiment.started_at,
      stopped_at: experiment.stopped_at,
      rolled_back_at: experiment.rolled_back_at,
      rollback_reason: experiment.rollback_reason,
      created_at: experiment.created_at,
    },
    product: product ? { id: product.id, title: product.title, handle: product.handle } : null,
    arms: arms.map((a) => ({ ...a, preview_url: previewByVariant.get(a.variant_id) ?? null })),
  });
}
