/**
 * Approval-gated execution adapters — Storefront Iteration Engine Phase 6b +
 * media-buyer loop (meta-campaign-adset-creation-primitive Phase 2 + Phase 3).
 *
 * When Dylan approves an `iteration_recommendations` row (status pending →
 * approved), this dispatcher turns it into a real but DRAFT/PAUSED Meta object —
 * a new live spend line is NEVER set live automatically. Two adapters today:
 *
 *   new_static_adset / new_video_adset → publish a built creative as a PAUSED ad
 *     into an EXISTING target adset via `ad-tool/publish-to-meta`. The publisher
 *     writes the meta ids back onto the recommendation.
 *
 *   new_campaign → the media-buyer path: get-or-create the shared MB testing
 *     campaign (ABO) and create a PAUSED purchase-optimized ad set under it,
 *     one per creative concept. Gated on `ad_spend_governor` — a request that
 *     would push the account's rolling window past the `ad_spend_budgets`
 *     ceiling ESCALATES to a growth `director_activity` row and marks the
 *     recommendation `deferred` — it does NOT create a live object. Every
 *     successful create stamps `director_activity` for Max's audit AND
 *     reconciles the new campaign + ad set into the local mirror
 *     (`meta_campaigns` + `meta_adsets`) so the attribution engine and
 *     winner-detector see the object immediately, without waiting for the
 *     next `syncMetaStructure` cycle (Phase 3). If the recommendation also
 *     carries `ad_campaign_id` (a built ad_campaigns row), the adapter chains
 *     straight into the publish path so the concept's ad lands PAUSED inside
 *     the newly-created ad set.
 *
 * A deferred type is left `status='approved'` with `external_result.deferred` set
 * (a reason), so nothing is lost and the rollout is legible.
 *
 * Idempotency: a recommendation already linked to an `ad_publish_jobs` row (via
 * `recommendation_id`) is never re-published; only `status='approved'` rows are
 * dispatched; a recommendation with a stored `meta_adset_id` short-circuits
 * campaign/adset creation. NO new live spend line ever goes live here.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 6b) and
 * docs/brain/specs/meta-campaign-adset-creation-primitive.md (Phase 2).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import type { RecommendationType } from "@/lib/meta/decision-engine";
import {
  createAdSet,
  getMetaUserToken,
  getOrCreateTestingCampaign,
} from "@/lib/meta-ads";
import { getMetaPixelId } from "@/lib/meta-capi";
import {
  type AdSpendBudget,
  getEffectiveAdSpendBudget,
  rollupAdSpendActual,
} from "@/lib/ad-spend-governor";
import { recordDirectorActivity } from "@/lib/director-activity";
import { isEffectivelyEnabled } from "@/lib/control-tower/legacy-switch-compat";

/** The recommendation types whose adapter is enabled (ship one at a time). */
export const ENABLED_ADAPTERS: ReadonlySet<RecommendationType> = new Set<RecommendationType>([
  "new_static_adset",
  "new_video_adset",
  // meta-campaign-adset-creation-primitive Phase 2 — media-buyer loop, governed + PAUSED.
  "new_campaign",
]);

/**
 * migrate-ad-hoc-kill-switches-to-resolver Phase 1 — union check that wraps the legacy
 * `ENABLED_ADAPTERS` set with a resolver read for the recommendation-executor. A recommendation
 * `action_type` is enabled ONLY IF (a) it is in the ad-hoc set AND (b) BOTH the `media-buyer`
 * cascade AND the `dept:platform` integration rail are ON. Mirrors [[./execution]]
 * `isMetaExecutionAdapterEnabled`; the two adapter sets stay distinct (execution.ts operates on
 * `AutonomousActionType`; this one on `RecommendationType`).
 *
 * Phase 3 Fix 1 — the `media-buyer` node resolves under `growth`
 * ([[../control-tower/node-registry]] `KIND_OWNER_FALLBACK`), so a `growth` department-off already
 * cascades. Meta ad execution is ALSO a platform integration primitive, so a `platform`
 * department-off must pause the adapter too — the extra `dept:platform` check binds that cascade.
 */
export async function isMetaRecommendationAdapterEnabled(
  action_type: RecommendationType,
): Promise<boolean> {
  const legacyFn = async (): Promise<boolean | undefined> => ENABLED_ADAPTERS.has(action_type);
  if (!(await isEffectivelyEnabled("media-buyer", legacyFn))) return false;
  return isEffectivelyEnabled("dept:platform", async () => true);
}

/** Stable engine-created marker prepended to every engine-published ad name. */
export const ENGINE_NAME_TAG = "[ie]";

/** Growth is the DRI on ad-account structural changes (mirrors ad-spend-governor). */
const GROWTH_DIRECTOR_FUNCTION = "growth";

export interface ExecuteRecommendationResult {
  status: "executed" | "deferred" | "failed" | "skipped";
  reason?: string;
  ad_publish_job_id?: string;
  meta_campaign_id?: string;
  meta_adset_id?: string;
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
 * meta-campaign-adset-creation-primitive Phase 3 — mirror reconcile after
 * create. Seeds the local `meta_campaigns` + `meta_adsets` mirror with the
 * campaign + ad set we JUST created so the attribution engine
 * ([[meta_attribution_daily]]) and the winner-detector see the new object
 * within the same cycle — no wait for the next `syncMetaStructure` GET.
 *
 * We upsert on the same natural keys `syncMetaStructure` uses
 * (`workspace_id,meta_campaign_id` / `workspace_id,meta_adset_id`), so when
 * that later cron runs and hydrates the effective_status / meta_created_time
 * from Meta, it overwrites cleanly on top of what we seeded here.
 *
 * A supabase error is THROWN — a swallowed upsert would leave the mirror
 * silently stale (the failure mode called out in performance.ts's own
 * `upsertOrThrow` comment). The caller decides whether to retry or fail
 * the recommendation; either way, no silent drift.
 */
export interface ReconcileCreatedAdSetInput {
  workspaceId: string;
  /** Our DB uuid for the ad account (meta_ad_accounts.id). */
  metaAdAccountId: string;
  metaCampaignId: string;
  campaignName: string;
  campaignObjective: string;
  metaAdsetId: string;
  adsetName: string;
  optimizationGoal: string;
  /** Ad-set-level daily budget in minor units (ABO). Null when the ad set uses a lifetime budget or CBO. */
  dailyBudgetCents: number | null;
  /** Ad-set + campaign status. Always `PAUSED` for engine-created objects. */
  status: string;
  /** ISO timestamp — the moment of creation (used for `synced_at`/`updated_at`/`meta_created_time`). */
  syncedAt: string;
}

/**
 * Minimal admin surface this helper touches — the tests inject a fake with
 * exactly this shape (see recommendation-execute.test.ts). Kept intentionally
 * narrow so the reconcile can't grow a hidden dependency on the full client.
 */
type MirrorAdmin = {
  from(table: string): {
    upsert(
      rows: Record<string, unknown>[],
      opts?: { onConflict?: string },
    ): PromiseLike<{ error: { message: string; code?: string } | null }>;
  };
};

export async function reconcileCreatedAdSetToMirror(
  admin: MirrorAdmin,
  input: ReconcileCreatedAdSetInput,
): Promise<void> {
  const campaignRow: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    meta_ad_account_id: input.metaAdAccountId,
    meta_campaign_id: input.metaCampaignId,
    name: input.campaignName,
    status: input.status,
    // The next real sync will overwrite these two with Meta's computed values.
    effective_status: input.status,
    objective: input.campaignObjective,
    // ABO campaigns carry no campaign-level budget — the ad set carries it.
    daily_budget_cents: null,
    lifetime_budget_cents: null,
    meta_created_time: input.syncedAt,
    meta_updated_time: input.syncedAt,
    synced_at: input.syncedAt,
    updated_at: input.syncedAt,
  };
  const { error: campaignError } = await admin
    .from("meta_campaigns")
    .upsert([campaignRow], { onConflict: "workspace_id,meta_campaign_id" });
  if (campaignError) {
    throw new Error(
      `meta_campaigns upsert failed (mirror reconcile): ${campaignError.code ?? "?"} ${campaignError.message}`,
    );
  }

  const adsetRow: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    meta_ad_account_id: input.metaAdAccountId,
    meta_adset_id: input.metaAdsetId,
    // Parent-link is the campaign's Meta id (text natural key — meta_adsets.md).
    meta_campaign_id: input.metaCampaignId,
    name: input.adsetName,
    status: input.status,
    effective_status: input.status,
    optimization_goal: input.optimizationGoal,
    daily_budget_cents: input.dailyBudgetCents,
    lifetime_budget_cents: null,
    meta_created_time: input.syncedAt,
    meta_updated_time: input.syncedAt,
    synced_at: input.syncedAt,
    updated_at: input.syncedAt,
  };
  const { error: adsetError } = await admin
    .from("meta_adsets")
    .upsert([adsetRow], { onConflict: "workspace_id,meta_adset_id" });
  if (adsetError) {
    throw new Error(
      `meta_adsets upsert failed (mirror reconcile): ${adsetError.code ?? "?"} ${adsetError.message}`,
    );
  }
}

/**
 * Pure governor guard — the "test ceiling" predicate the spec requires. Given
 * the effective `ad_spend_budgets` row + the account's rolling window spend +
 * the proposed ad-set daily budget (minor units), decide whether creating a
 * new PAUSED live-object would (once unpaused) push the window past the
 * ceiling. Returns `ok:true` when the projected spend fits under the ceiling,
 * `ok:false` (with a human `reason`) when the caller must escalate instead of
 * create.
 *
 * `budget=null` → `ok:true` (no ceiling configured, nothing to enforce).
 * Projected = `actualCents + proposedDailyBudgetCents × budget.windowDays` —
 * we treat the proposed daily as if it spent every day of the window, which
 * is conservative (matches the governor's own rolling-window model).
 */
export function evaluateGovernorHeadroom(
  budget: AdSpendBudget | null,
  actualCents: number,
  proposedDailyBudgetCents: number,
): { ok: boolean; reason?: string; projectedCents: number; ceilingCents: number | null } {
  if (!budget) return { ok: true, projectedCents: actualCents + proposedDailyBudgetCents, ceilingCents: null };
  const projectedCents = actualCents + Math.max(0, proposedDailyBudgetCents) * budget.windowDays;
  const ceilingCents = budget.usdCeilingCents;
  if (projectedCents <= ceilingCents) return { ok: true, projectedCents, ceilingCents };
  const usdProj = (projectedCents / 100).toFixed(2);
  const usdCeil = (ceilingCents / 100).toFixed(2);
  return {
    ok: false,
    projectedCents,
    ceilingCents,
    reason:
      `Ad-spend ceiling headroom check: projected $${usdProj} over ${budget.windowDays}d window (actual + proposed daily × window) ` +
      `exceeds the $${usdCeil} ceiling. Escalating instead of creating a new live object.`,
  };
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

  if (!(await isMetaRecommendationAdapterEnabled(rec.action_type))) {
    const reason = `adapter_deferred:${rec.action_type}`;
    await updateRecommendationGuarded(admin, rec, {
      external_result: { ...(rec.external_result || {}), deferred: reason },
    });
    return { status: "deferred", reason };
  }

  try {
    if (rec.action_type === "new_campaign") return await executeNewCampaignAdapter(rec);
    return await executePublishAdapter(rec);
  } catch (err) {
    const message = errText(err);
    await updateRecommendationGuarded(admin, rec, {
      status: "failed",
      external_result: { ...(rec.external_result || {}), error: message.slice(0, 500) },
    });
    return { status: "failed", reason: message.slice(0, 200) };
  }
}

/**
 * Compare-and-set update on iteration_recommendations — the "prove the guard
 * before it fires" pattern from the coaching. Rebinds the write to the row's
 * (id, workspace_id, status='approved') coordinates so a concurrent flip or a
 * stale async read cannot overwrite the wrong row. Returns `changed=false`
 * when zero rows transitioned so callers can bail on follow-on writes.
 */
async function updateRecommendationGuarded(
  admin: ReturnType<typeof createAdminClient>,
  rec: RecommendationRow,
  patch: {
    status?: string;
    external_result?: Record<string, unknown>;
  },
): Promise<{ changed: boolean }> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from("iteration_recommendations")
    .update({ ...patch, updated_at: now })
    .eq("id", rec.id)
    .eq("workspace_id", rec.workspace_id)
    .eq("status", "approved")
    .select("id");
  return { changed: Array.isArray(data) && data.length === 1 };
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
    await updateRecommendationGuarded(admin, rec, {
      external_result: { ...(rec.external_result || {}), deferred: reason },
    });
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
  await updateRecommendationGuarded(admin, rec, {
    external_result: { ...(rec.external_result || {}), ad_publish_job_id: jobId, status: "publishing" },
  });

  await inngest.send({
    name: "ad-tool/publish-to-meta",
    data: { workspace_id: rec.workspace_id, job_id: jobId },
  });

  return { status: "executed", ad_publish_job_id: jobId };
}

/**
 * new_campaign → media-buyer loop. Get-or-create the shared MB testing campaign
 * (ABO), create ONE PAUSED purchase-optimized ad set per creative concept under
 * it (advertisement-set-scoped daily_budget), stamp a growth `director_activity`
 * row, then — if the caller supplied a built `ad_campaign_id` — chain into the
 * publish adapter so the concept's ad lands PAUSED inside the new ad set.
 *
 * Gated on `ad_spend_governor`: a proposed daily-budget × window that would push
 * the account's rolling spend past the `ad_spend_budgets` ceiling ESCALATES
 * (growth `director_activity` + rec.deferred) instead of creating a live object.
 *
 * Required params (validated up front):
 *   - daily_budget_cents (number > 0)   ad-set-level daily budget in minor units
 *   - targeting          (object)       Meta targeting spec (geo/age/audiences/…);
 *                                       omit publisher_platforms/*_positions for
 *                                       Advantage+ placements (the default).
 * Optional params:
 *   - meta_campaign_id   (string)       explicit parent — else uses the shared
 *                                       MB testing campaign (idempotent by name)
 *   - ad_campaign_id     (uuid)         built ad_campaigns row → chain to publish
 *   - meta_page_id, destination_url, headlines, primary_texts, description,
 *     cta_type, video_id, meta_instagram_user_id — passed straight through to
 *     the publish adapter (required only when ad_campaign_id is present).
 *   - pixel_id           (string)       override the workspace's default pixel
 *   - optimization_goal / bid_strategy / billing_event / custom_event_type —
 *     forwarded to `createAdSet` (spec defaults win when omitted).
 */
async function executeNewCampaignAdapter(rec: RecommendationRow): Promise<ExecuteRecommendationResult> {
  const admin = createAdminClient();
  const params = rec.params || {};
  const dailyBudgetCents = Number(params.daily_budget_cents ?? 0);
  const rawTargeting = params.targeting;
  const targeting =
    rawTargeting && typeof rawTargeting === "object" && !Array.isArray(rawTargeting)
      ? (rawTargeting as Record<string, unknown>)
      : null;

  const missing = [
    !(dailyBudgetCents > 0) && "daily_budget_cents",
    !targeting && "targeting",
  ].filter(Boolean) as string[];
  if (missing.length || !targeting) {
    const reason = `missing_build_inputs:${missing.join(",")}`;
    await updateRecommendationGuarded(admin, rec, {
      external_result: { ...(rec.external_result || {}), deferred: reason },
    });
    return { status: "deferred", reason };
  }

  // Idempotency: this rec already stood up an ad set — don't double-create.
  const existingAdset = (rec.external_result?.meta_adset_id as string | undefined) ?? undefined;
  const existingCampaign = (rec.external_result?.meta_campaign_id as string | undefined) ?? undefined;
  if (existingAdset) {
    // Fall through to the publish chain if the ad-campaign build was queued.
    if (params.ad_campaign_id) {
      return executePublishAdapter({
        ...rec,
        params: { ...params, meta_adset_id: existingAdset },
      });
    }
    return { status: "skipped", reason: "already_created", meta_adset_id: existingAdset, meta_campaign_id: existingCampaign };
  }

  // Resolve the bare Meta account id from our uuid.
  const { data: acct } = await admin
    .from("meta_ad_accounts")
    .select("meta_account_id")
    .eq("id", rec.meta_ad_account_id)
    .maybeSingle();
  const metaAccountId = acct?.meta_account_id as string | undefined;
  if (!metaAccountId) return { status: "failed", reason: "meta_account_not_found" };

  const token = await getMetaUserToken(rec.workspace_id);
  if (!token) return { status: "failed", reason: "no_meta_user_token" };

  const pixelId = (params.pixel_id as string | undefined) ?? (await getMetaPixelId(rec.workspace_id));
  if (!pixelId) return { status: "failed", reason: "no_meta_pixel_id" };

  // Governor / test-ceiling gate — a live-object that would push us past the
  // ad-spend ceiling ESCALATES (growth director_activity + deferred) instead
  // of being created. This is the "hit a rail → escalate, never execute"
  // invariant from operational-rules § North star.
  const budget = await getEffectiveAdSpendBudget(admin, rec.workspace_id, {
    platform: "meta",
    metaAdAccountId: rec.meta_ad_account_id,
  });
  const rollup = await rollupAdSpendActual(admin, {
    workspaceId: rec.workspace_id,
    platform: "meta",
    metaAdAccountId: rec.meta_ad_account_id,
    windowDays: budget?.windowDays ?? 7,
  });
  const headroom = evaluateGovernorHeadroom(budget, rollup.actualCents, dailyBudgetCents);
  if (!headroom.ok) {
    await recordDirectorActivity(admin, {
      workspaceId: rec.workspace_id,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "escalated_new_adset_over_ceiling",
      specSlug: null,
      reason: headroom.reason ?? "governor_headroom_breach",
      metadata: {
        recommendation_id: rec.id,
        meta_ad_account_id: rec.meta_ad_account_id,
        proposed_daily_budget_cents: dailyBudgetCents,
        actual_cents: rollup.actualCents,
        window_days: rollup.windowDays,
        projected_cents: headroom.projectedCents,
        ceiling_cents: headroom.ceilingCents,
        autonomous: true,
      },
    });
    await updateRecommendationGuarded(admin, rec, {
      external_result: {
        ...(rec.external_result || {}),
        deferred: "governor_ceiling_breach",
        governor: {
          projected_cents: headroom.projectedCents,
          ceiling_cents: headroom.ceilingCents,
          actual_cents: rollup.actualCents,
        },
      },
    });
    return { status: "deferred", reason: "governor_ceiling_breach" };
  }

  // Get-or-create the shared MB testing campaign (idempotent by name), unless
  // the caller explicitly named a campaign.
  const explicitCampaign = params.meta_campaign_id as string | undefined;
  const metaCampaignId = explicitCampaign ?? (await getOrCreateTestingCampaign(token, metaAccountId));

  // One ad set per creative concept — PAUSED, purchase-optimized, Advantage+ placements.
  const adsetName = `${ENGINE_NAME_TAG} ${rec.title || "test adset"}`.slice(0, 250);
  const optimizationGoal = typeof params.optimization_goal === "string" ? params.optimization_goal : "OFFSITE_CONVERSIONS";
  const metaAdsetId = await createAdSet(token, metaAccountId, {
    name: adsetName,
    campaignId: metaCampaignId,
    dailyBudgetCents,
    pixelId,
    targeting,
    optimizationGoal,
    ...(typeof params.billing_event === "string" ? { billingEvent: params.billing_event } : {}),
    ...(typeof params.bid_strategy === "string" ? { bidStrategy: params.bid_strategy } : {}),
    ...(typeof params.custom_event_type === "string" ? { customEventType: params.custom_event_type } : {}),
    // status omitted → createAdSet defaults to PAUSED (the invariant).
  });

  // Phase 3 — mirror reconcile. Seed `meta_campaigns` + `meta_adsets` with the
  // objects we just created so the attribution engine and winner-detector
  // resolve the ad set id from the local mirror without waiting for the next
  // `syncMetaStructure` cycle. A supabase error THROWS — the outer try/catch
  // marks the recommendation `failed` with the message so a silent stale
  // mirror can never mask a broken create.
  await reconcileCreatedAdSetToMirror(admin, {
    workspaceId: rec.workspace_id,
    metaAdAccountId: rec.meta_ad_account_id,
    metaCampaignId,
    campaignName: explicitCampaign ? (rec.title || metaCampaignId) : "MB — Testing (ABO)",
    campaignObjective: "OUTCOME_SALES",
    metaAdsetId,
    adsetName,
    optimizationGoal,
    dailyBudgetCents,
    status: "PAUSED",
    syncedAt: new Date().toISOString(),
  });

  // Growth-owned audit trail — Max's "who created what and why" lineage row.
  await recordDirectorActivity(admin, {
    workspaceId: rec.workspace_id,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "created_test_adset",
    specSlug: null,
    reason: `Created PAUSED purchase-optimized ad set ${metaAdsetId} under MB testing campaign ${metaCampaignId} (rec ${rec.id}).`,
    metadata: {
      recommendation_id: rec.id,
      meta_ad_account_id: rec.meta_ad_account_id,
      meta_account_id: metaAccountId,
      meta_campaign_id: metaCampaignId,
      meta_adset_id: metaAdsetId,
      daily_budget_cents: dailyBudgetCents,
      actual_cents: rollup.actualCents,
      ceiling_cents: headroom.ceilingCents,
      autonomous: true,
    },
  });

  // Persist the created ids on the rec before any downstream write — the
  // guarded update lets us bail cleanly if the rec was flipped concurrently.
  const patched = await updateRecommendationGuarded(admin, rec, {
    external_result: {
      ...(rec.external_result || {}),
      meta_campaign_id: metaCampaignId,
      meta_adset_id: metaAdsetId,
      status: "adset_created",
    },
  });
  if (!patched.changed) {
    // The rec was flipped mid-flight (approved → something else). The Meta
    // objects are PAUSED so no live spend was uncovered; leaving them
    // orphaned is safer than continuing to publish creatives against a
    // stale approval. The director_activity above still captures the
    // lineage for Max's audit.
    return { status: "skipped", reason: "rec_flipped_mid_execute", meta_adset_id: metaAdsetId, meta_campaign_id: metaCampaignId };
  }

  // Chain to the publish adapter when the caller supplied a built ad campaign.
  if (params.ad_campaign_id) {
    const publishResult = await executePublishAdapter({
      ...rec,
      params: { ...params, meta_adset_id: metaAdsetId },
    });
    return {
      ...publishResult,
      meta_campaign_id: metaCampaignId,
      meta_adset_id: metaAdsetId,
    };
  }

  return {
    status: "executed",
    meta_campaign_id: metaCampaignId,
    meta_adset_id: metaAdsetId,
  };
}
