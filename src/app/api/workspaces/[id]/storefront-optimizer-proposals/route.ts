/**
 * Storefront Optimizer proposals — the Growth review/approve surface (read-only list).
 *
 * GET → the workspace's pending storefront-optimizer campaign proposals: `agent_jobs`
 *       rows `kind='storefront-optimizer'` AND `status='needs_approval'`, each unpacked
 *       from its `storefront_campaign` pending_action into a Build/Approve card
 *       (jobId + actionId for the existing `POST /api/roadmap/approve` route, the
 *       surface, the lever, the agent's surfaced reasoning, and the variant preview).
 *
 * No new approval path — approval still goes through `approveRoadmapAction`
 * (docs/brain/specs/storefront-optimizer-proposal-cards.md Phase 1). This route only
 * READS. Owner/admin only, mirroring the policy PATCH role-gate.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OptimizerProposal } from "@/lib/storefront/optimizer-agent";

/** One pending campaign proposal, flattened for the card UI. */
interface ProposalCard {
  jobId: string;
  actionId: string;
  spec_slug: string;
  product_id: string;
  product_name: string | null;
  lander_type: string;
  audience: string;
  lever: string;
  /** The action kind — 'storefront_campaign' (reversible/hero) or 'storefront_offer' (persist-to-renewal). */
  card_kind: "campaign" | "offer";
  hypothesis: string;
  reasoning: string;
  /** Combined hypothesis + reasoning the worker stored on the pending_action. */
  preview: string;
  variant: { kind: string; label: string; hero_prompt?: string; patch?: unknown; offer?: unknown };
  /** For storefront_offer cards: the pricing_rule_offers row id the worker created at propose time
   *  (the row flips proposed→active on owner approval — storefront-renewal-offer-lever). */
  offer_id?: string;
  /** For storefront_offer cards: the modeled-margin diagnostic the agent passed the floor with (or
   *  the cogs_source_missing soft-pass flag) — surfaced so the approver sees the audit. */
  margin?: { modeled_renewal_margin_pct: number | null; floor_pct: number; cogs_source_missing: boolean; reason: string };
  created_at: string | null;
  // ── optimizer-hero-preview-gate ──
  // 'concept' = the owner is approving the idea (a hero candidate is generated on approve); 'preview' =
  // a candidate hero is generated and awaiting image-approval (Approve goes live / Reject-with-notes regens).
  stage?: "concept" | "preview";
  preview_image_url?: string;
  preview_attempts?: { url: string; notes?: string; at: string }[];
}

/** Shape of one element of agent_jobs.pending_actions (see scripts/builder-worker.ts PendingAction). */
interface PendingActionRow {
  id: string;
  type: string;
  summary?: string;
  preview?: string;
  status?: string;
  campaign_plan?: OptimizerProposal & {
    offer_id?: string;
    experiment_id?: string;
    variant_id?: string;
    margin?: { modeled_renewal_margin_pct: number | null; floor_pct: number; cogs_source_missing: boolean; reason: string };
  };
  offer_id?: string;
  stage?: "concept" | "preview";
  preview_image_url?: string;
  preview_attempts?: { url: string; notes?: string; at: string }[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Owner/admin only — mirror the policy PATCH role-gate. Non-members 403.
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, pending_actions, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "storefront-optimizer")
    .eq("status", "needs_approval")
    .order("created_at", { ascending: false });

  const cards: ProposalCard[] = [];
  for (const job of jobs ?? []) {
    const actions = (Array.isArray(job.pending_actions) ? job.pending_actions : []) as PendingActionRow[];
    for (const act of actions) {
      // Live optimizer cards: reversible campaign + persist-to-renewal offer; skip anything else
      // (e.g. storefront_build) and anything already declined/done.
      const isCampaign = act.type === "storefront_campaign";
      const isOffer = act.type === "storefront_offer";
      if (!isCampaign && !isOffer) continue;
      if (act.status && !["pending", "approved"].includes(act.status)) continue;

      const plan = act.campaign_plan;
      // spec_slug is the surface key `product_id:lander_type:audience` (optimizer-agent.surfaceKey).
      const slug = String(job.spec_slug ?? "");
      const [slugProduct = "", slugLander = "", ...slugAudience] = slug.split(":");

      cards.push({
        jobId: job.id,
        actionId: act.id,
        spec_slug: slug,
        product_id: slugProduct,
        product_name: null, // filled in below
        lander_type: String(plan?.lander_type ?? slugLander ?? ""),
        audience: String(plan?.audience ?? slugAudience.join(":") ?? ""),
        lever: String(plan?.lever_key ?? ""),
        card_kind: isOffer ? "offer" : "campaign",
        hypothesis: String(plan?.hypothesis ?? ""),
        reasoning: String(plan?.reasoning ?? ""),
        preview: String(act.preview ?? ""),
        variant: {
          kind: String(plan?.variant?.kind ?? ""),
          label: String(plan?.variant?.label ?? ""),
          hero_prompt: plan?.variant?.hero_prompt,
          patch: plan?.variant?.patch,
          offer: (plan?.variant as { offer?: unknown } | undefined)?.offer,
        },
        offer_id: act.offer_id ?? plan?.offer_id,
        margin: plan?.margin,
        created_at: job.created_at ?? null,
        stage: act.stage,
        preview_image_url: act.preview_image_url,
        preview_attempts: Array.isArray(act.preview_attempts) ? act.preview_attempts : undefined,
      });
    }
  }

  // Resolve product names in one query (cards reference products by id from the surface key).
  const productIds = Array.from(new Set(cards.map((c) => c.product_id).filter(Boolean)));
  if (productIds.length) {
    const { data: products } = await admin
      .from("products")
      .select("id, title")
      .eq("workspace_id", workspaceId)
      .in("id", productIds);
    const nameById = new Map((products ?? []).map((p) => [p.id, p.title as string]));
    for (const c of cards) c.product_name = nameById.get(c.product_id) ?? null;
  }

  return NextResponse.json({ proposals: cards });
}
