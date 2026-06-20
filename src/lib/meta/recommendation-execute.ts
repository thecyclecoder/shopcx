/**
 * Approval-gated execution adapters — Storefront Iteration Engine Phase 6b.
 *
 * When Dylan approves an `iteration_recommendations` row (status pending →
 * approved), this dispatcher turns it into a real but DRAFT/PAUSED Meta object —
 * a new live spend line is NEVER set live automatically. It reuses the native ad
 * publish path:
 *
 *   new_static_adset / new_video_adset → create an `ad_publish_jobs` row with
 *     `publish_active=false` (→ PAUSED) and fire `ad-tool/publish-to-meta`, which
 *     uploads the built creative and creates the ad PAUSED in the target adset.
 *     The job is tagged `[ie] …` (via `ad_publish_jobs.ad_name`) so the resulting
 *     Meta object is unambiguously engine-created; the publisher writes the meta
 *     ids back onto the recommendation (`external_result`, status='executed').
 *
 * Ship one action type at a time (`ENABLED_ADAPTERS`). The other recommendation
 * types are recognized but DEFERRED to subsequent increments, each behind its own
 * verification (see the spec's Phase 6b open items):
 *   - new_campaign     → needs net-new createCampaign/createAdSet (objective +
 *                        targeting + optimization decisions not yet specified).
 *   - test_benefit_angle → seed an ad_campaigns row + ad-tool/generate-full, then publish.
 *   - new_lander_variant → generateAdvertorialPagesForCampaign for the chosen angle/variant.
 *   - offer_test       → offer/pricing change — product decision, not an ad publish.
 * A deferred type is left `status='approved'` with `external_result.deferred` set
 * (a reason), so nothing is lost and the rollout is legible.
 *
 * Idempotency: a recommendation already linked to an `ad_publish_jobs` row (via
 * `recommendation_id`) is never re-published; only `status='approved'` rows are
 * dispatched. NO new live spend line ever goes live here.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 6b).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import type { RecommendationType } from "@/lib/meta/decision-engine";

/** The recommendation types whose Phase 6b adapter is enabled (ship one at a time). */
export const ENABLED_ADAPTERS: ReadonlySet<RecommendationType> = new Set<RecommendationType>([
  "new_static_adset",
  "new_video_adset",
]);

/** Stable engine-created marker prepended to every engine-published ad name. */
export const ENGINE_NAME_TAG = "[ie]";

export interface ExecuteRecommendationResult {
  status: "executed" | "deferred" | "failed" | "skipped";
  reason?: string;
  ad_publish_job_id?: string;
}

interface RecommendationRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string;
  action_type: RecommendationType;
  status: string;
  title: string | null;
  params: Record<string, unknown> | null;
  external_result: Record<string, unknown> | null;
}

/**
 * Execute one approved recommendation. Returns a typed result describing what
 * happened (executed a draft, deferred, skipped, or failed). Safe to call more
 * than once — non-approved rows and already-linked rows short-circuit.
 */
export async function executeRecommendation(
  workspaceId: string,
  recommendationId: string,
): Promise<ExecuteRecommendationResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("iteration_recommendations")
    .select("id, workspace_id, meta_ad_account_id, action_type, status, title, params, external_result")
    .eq("id", recommendationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const rec = data as RecommendationRow | null;
  if (!rec) return { status: "skipped", reason: "not_found" };
  if (rec.status !== "approved") return { status: "skipped", reason: `not_approved (${rec.status})` };

  // Idempotency: already linked to a publish job → nothing to do.
  const existingJob = (rec.external_result?.ad_publish_job_id as string | undefined) ?? undefined;
  if (existingJob) return { status: "skipped", reason: "already_dispatched", ad_publish_job_id: existingJob };

  if (!ENABLED_ADAPTERS.has(rec.action_type)) {
    const reason = `adapter_deferred:${rec.action_type}`;
    await admin
      .from("iteration_recommendations")
      .update({
        external_result: { ...(rec.external_result || {}), deferred: reason },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id);
    return { status: "deferred", reason };
  }

  try {
    return await executePublishAdapter(rec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("iteration_recommendations")
      .update({
        status: "failed",
        external_result: { ...(rec.external_result || {}), error: message.slice(0, 500) },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id);
    return { status: "failed", reason: message.slice(0, 200) };
  }
}

/**
 * new_static_adset / new_video_adset → publish the built creative as a PAUSED ad
 * into the target adset, via the native ad-tool/publish-to-meta path. The
 * recommendation's `params` must carry the concrete build inputs (the publish job
 * is the same shape the studio uses):
 *   - ad_campaign_id  (uuid)  the built ad_campaigns row whose ready media to publish
 *   - meta_adset_id   (text)  the EXISTING target adset to publish into
 *   - meta_page_id    (text)  the page for the creative
 *   - destination_url (text)  the landing url
 *   - meta_instagram_user_id, video_id, headlines, primary_texts, description,
 *     cta_type — optional (defaults match ad_publish_jobs).
 * Missing required inputs ⇒ deferred (we never guess creative/targeting).
 */
async function executePublishAdapter(rec: RecommendationRow): Promise<ExecuteRecommendationResult> {
  const admin = createAdminClient();
  const params = rec.params || {};
  const adCampaignId = params.ad_campaign_id as string | undefined;
  const metaAdsetId = params.meta_adset_id as string | undefined;
  const metaPageId = params.meta_page_id as string | undefined;
  const destinationUrl = params.destination_url as string | undefined;

  const missing = [
    !adCampaignId && "ad_campaign_id",
    !metaAdsetId && "meta_adset_id",
    !metaPageId && "meta_page_id",
    !destinationUrl && "destination_url",
  ].filter(Boolean) as string[];
  if (missing.length) {
    const reason = `missing_build_inputs:${missing.join(",")}`;
    await admin
      .from("iteration_recommendations")
      .update({
        external_result: { ...(rec.external_result || {}), deferred: reason },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id);
    return { status: "deferred", reason };
  }

  // Resolve the bare Meta account id from our uuid.
  const { data: acct } = await admin
    .from("meta_ad_accounts")
    .select("meta_account_id")
    .eq("id", rec.meta_ad_account_id)
    .maybeSingle();
  const metaAccountId = acct?.meta_account_id as string | undefined;
  if (!metaAccountId) return { status: "failed", reason: "meta_account_not_found" };

  // Engine-created marker — keep demographic terms out of the Meta object name.
  const adName = `${ENGINE_NAME_TAG} ${rec.title || rec.action_type}`.slice(0, 250);

  const { data: job, error } = await admin
    .from("ad_publish_jobs")
    .insert({
      workspace_id: rec.workspace_id,
      campaign_id: adCampaignId,
      video_id: (params.video_id as string | undefined) ?? null,
      meta_account_id: metaAccountId,
      meta_adset_id: metaAdsetId,
      meta_page_id: metaPageId,
      meta_instagram_user_id: (params.meta_instagram_user_id as string | undefined) ?? null,
      headlines: Array.isArray(params.headlines) ? params.headlines : [],
      primary_texts: Array.isArray(params.primary_texts) ? params.primary_texts : [],
      description: (params.description as string | undefined) ?? null,
      cta_type: (params.cta_type as string | undefined) ?? "SHOP_NOW",
      destination_url: destinationUrl,
      publish_active: false, // ALWAYS PAUSED — never a new live spend line automatically
      ad_name: adName,
      recommendation_id: rec.id,
    })
    .select("id")
    .single();
  if (error || !job) return { status: "failed", reason: `job_insert_failed:${error?.message ?? "no_row"}` };

  const jobId = job.id as string;
  // Record the link immediately (idempotency) — the publisher finalizes
  // status='executed' + meta ids on success, or status='failed' on error.
  await admin
    .from("iteration_recommendations")
    .update({
      external_result: { ...(rec.external_result || {}), ad_publish_job_id: jobId, status: "publishing" },
      updated_at: new Date().toISOString(),
    })
    .eq("id", rec.id);

  await inngest.send({
    name: "ad-tool/publish-to-meta",
    data: { workspace_id: rec.workspace_id, job_id: jobId },
  });

  return { status: "executed", ad_publish_job_id: jobId };
}
