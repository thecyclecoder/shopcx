/**
 * Director-approved promotion of a ready-to-test creative into a PAUSED Meta ad.
 *
 * Phase 2 of docs/brain/specs/growth-adopt-creative-makers.md — the consumer side of the leash class
 * `promote_ready_to_test_creative` (declared in [[../agents/growth-director]] Phase 1). The box
 * session that watches [[./ready-to-test]] emits ONE `promote_ready_to_test_creative` action per
 * candidate carrying `{ad_campaign_id, meta_page_id, meta_account_id, meta_campaign_id,
 * meta_adset_id, publish_active:false}`. The Growth director auto-approves within the leash; on
 * `applyDirectorApproval` flipping the action `approved`, this module runs the publish:
 *   - resolve a ready [[../../tables/ad_videos]] row for the campaign (the anchor for the
 *     [[../../inngest/ad-tool]] dual-asset publisher),
 *   - fill Meta copy from the action payload OR fall back to [[../ad-meta-copy]] `generateMetaCopy`
 *     (Opus copy generation; never blocks the publish — if copy can't be generated, fields go in empty
 *     and Meta uses the campaign defaults),
 *   - insert an [[../../tables/ad_publish_jobs]] row with `publish_active=false` (the ad lands PAUSED;
 *     a second human approve is required to flip it live),
 *   - fire `ad-tool/publish-to-meta` (the existing entry — [[../../lifecycles/ad-publish]]),
 *   - and write a [[../../tables/director_activity]] row of `action_kind='promoted_ready_to_test'` so
 *     the creative→publish-job→outcome lineage is gradable end-to-end (Phase 3 stamps the outcome row
 *     on the same `ad_publish_jobs_id`).
 *
 * Pure adapter — no growth-director coupling, no router knowledge. The caller (the box worker's
 * `runGrowthDirectorJob`) reads the approved actions and invokes `executeApprovedPromotions`; this
 * module never reads from `agent_jobs` itself beyond the pending-actions handed in.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import { generateMetaCopy } from "@/lib/ad-meta-copy";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The `pending_actions[].type` the box session emits per candidate (matches the leash class). */
export const PROMOTE_READY_TO_TEST_ACTION_TYPE = "promote_ready_to_test_creative" as const;

/** The `director_activity.action_kind` stamped per executed promotion (Phase 2 — past tense). */
export const PROMOTED_READY_TO_TEST_ACTION_KIND = "promoted_ready_to_test" as const;

/** The `agent_jobs.kind` for a ready-to-test promotion target job (the carrier the box session inserts). */
export const GROWTH_CREATIVE_PASS_KIND = "growth-creative-pass" as const;

/** The payload the box session attaches to every `promote_ready_to_test_creative` action — the
 * concrete publish inputs the executor turns into an `ad_publish_jobs` row. Copy fields are
 * optional; if missing, `generateMetaCopy` fills them at execute time. */
export interface PromoteReadyToTestPayload {
  ad_campaign_id: string;
  /** Meta page id (the bare id, no `act_` prefix). */
  meta_page_id: string;
  /** Meta ad account id (the bare id — same shape `ad_publish_jobs.meta_account_id` carries). */
  meta_account_id: string;
  /** Meta campaign id this ad lives under (the campaign the adset belongs to). */
  meta_campaign_id?: string | null;
  /** Meta ad set id the ad will be created PAUSED inside. */
  meta_adset_id: string;
  /** Optional Instagram user id for the page (Meta uses the page default if absent). */
  meta_instagram_user_id?: string | null;
  /** ALWAYS false for this flow — leash invariant. A live spend line never goes live automatically. */
  publish_active: false;
  /** Optional pre-filled copy. When absent, `generateMetaCopy` runs at execute time. */
  headlines?: string[];
  primary_texts?: string[];
  description?: string | null;
  cta_type?: string | null;
  /** Optional override for the landing URL. Defaults to `ad_campaigns.landing_url`. */
  destination_url?: string | null;
}

export interface ExecutePromoteResult {
  ok: boolean;
  reason?: string;
  ad_publish_jobs_id?: string;
}

interface MinimalActionLike {
  id?: string;
  type?: string;
  status?: string;
  result?: string;
  payload?: unknown;
}

/** Lightly-typed agent_jobs row shape the executor needs (matches the worker's `DirectorTargetJob`
 * shape without taking a hard dep on it). */
export interface PromoteTargetJob {
  id: string;
  workspace_id: string;
  spec_slug?: string | null;
  pending_actions: MinimalActionLike[] | null;
}

/**
 * Construct ONE `promote_ready_to_test_creative` pending action carrying the publish payload. The
 * box session uses this so a hand-rolled action and the production one never diverge in shape.
 * The caller generates the `id` (a UUID per action — matches every other `pending_actions[]` entry).
 */
export function buildPromoteReadyToTestAction(actionId: string, payload: PromoteReadyToTestPayload): {
  id: string;
  type: typeof PROMOTE_READY_TO_TEST_ACTION_TYPE;
  status: "pending";
  summary: string;
  payload: PromoteReadyToTestPayload;
} {
  return {
    id: actionId,
    type: PROMOTE_READY_TO_TEST_ACTION_TYPE,
    status: "pending",
    summary: `Promote ad_campaigns/${payload.ad_campaign_id} into adset ${payload.meta_adset_id} (PAUSED)`,
    payload,
  };
}

/** Read a payload off a loosely-typed `pending_actions[]` entry. Returns null when the shape is
 * unusable (no `payload`, or missing the FK + Meta target fields the publish job requires). */
export function readPromotePayload(action: MinimalActionLike): PromoteReadyToTestPayload | null {
  if (!action.payload || typeof action.payload !== "object") return null;
  const p = action.payload as Record<string, unknown>;
  const ad_campaign_id = typeof p.ad_campaign_id === "string" ? p.ad_campaign_id : "";
  const meta_page_id = typeof p.meta_page_id === "string" ? p.meta_page_id : "";
  const meta_account_id = typeof p.meta_account_id === "string" ? p.meta_account_id : "";
  const meta_adset_id = typeof p.meta_adset_id === "string" ? p.meta_adset_id : "";
  if (!ad_campaign_id || !meta_page_id || !meta_account_id || !meta_adset_id) return null;
  return {
    ad_campaign_id,
    meta_page_id,
    meta_account_id,
    meta_campaign_id: typeof p.meta_campaign_id === "string" ? p.meta_campaign_id : null,
    meta_adset_id,
    meta_instagram_user_id: typeof p.meta_instagram_user_id === "string" ? p.meta_instagram_user_id : null,
    publish_active: false,
    headlines: Array.isArray(p.headlines) ? (p.headlines as string[]).filter((s) => typeof s === "string") : undefined,
    primary_texts: Array.isArray(p.primary_texts) ? (p.primary_texts as string[]).filter((s) => typeof s === "string") : undefined,
    description: typeof p.description === "string" ? p.description : null,
    cta_type: typeof p.cta_type === "string" ? p.cta_type : null,
    destination_url: typeof p.destination_url === "string" ? p.destination_url : null,
  };
}

/**
 * Execute ONE approved promotion: resolve the landing URL + anchor video, fill copy via
 * `generateMetaCopy` if the payload didn't carry it, insert the `ad_publish_jobs` row with
 * `publish_active=false`, fire `ad-tool/publish-to-meta`, and write the lineage row to
 * `director_activity` (`action_kind='promoted_ready_to_test'`). Returns the new publish job id on
 * success. Never throws — a failure resolves to `{ok:false, reason}` so the caller can stamp the
 * pending action `failed` without aborting the rest of a bundle.
 */
export async function executePromoteReadyToTest(
  admin: Admin,
  opts: { workspaceId: string; specSlug?: string | null; payload: PromoteReadyToTestPayload },
): Promise<ExecutePromoteResult> {
  const { workspaceId, payload, specSlug } = opts;
  try {
    // Resolve the landing URL + an anchor video. ad_campaigns.landing_url is the source of truth for
    // destination_url unless the payload explicitly overrode it; we never guess a URL.
    const { data: campaignRow, error: campaignErr } = await admin
      .from("ad_campaigns")
      .select("id, landing_url")
      .eq("id", payload.ad_campaign_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (campaignErr) return { ok: false, reason: `campaign_lookup_failed:${campaignErr.message}` };
    if (!campaignRow) return { ok: false, reason: "ad_campaign_not_found" };
    const destinationUrl = payload.destination_url || (campaignRow as { landing_url: string | null }).landing_url;
    if (!destinationUrl) return { ok: false, reason: "no_landing_url" };

    // Pick a ready ad_videos row to anchor the publish job. The Inngest publisher reads BOTH ratios
    // for the campaign internally — we only need to pin a single id (it grabs the other format).
    const { data: anchorVideo } = await admin
      .from("ad_videos")
      .select("id")
      .eq("campaign_id", payload.ad_campaign_id)
      .eq("workspace_id", workspaceId)
      .eq("status", "ready")
      .limit(1)
      .maybeSingle();
    const videoId = (anchorVideo as { id?: string } | null)?.id ?? null;

    // Fill copy: payload first (the box session may have pre-rendered it), then generateMetaCopy as
    // a fallback. The fallback is best-effort — a generation failure leaves arrays empty (Meta uses
    // campaign defaults), it does NOT block the PAUSED publish.
    let headlines = payload.headlines && payload.headlines.length ? payload.headlines : [];
    let primaryTexts = payload.primary_texts && payload.primary_texts.length ? payload.primary_texts : [];
    let description = payload.description || null;
    if (!headlines.length || !primaryTexts.length) {
      try {
        const copy = await generateMetaCopy(workspaceId, payload.ad_campaign_id);
        if (copy) {
          if (!headlines.length) headlines = copy.headlines;
          if (!primaryTexts.length) primaryTexts = copy.primaryTexts;
          if (!description) description = copy.description || null;
        }
      } catch {
        /* best-effort — leave fields empty; the PAUSED publish still proceeds */
      }
    }

    const { data: jobInsert, error: insertErr } = await admin
      .from("ad_publish_jobs")
      .insert({
        workspace_id: workspaceId,
        campaign_id: payload.ad_campaign_id,
        video_id: videoId,
        meta_account_id: payload.meta_account_id,
        meta_campaign_id: payload.meta_campaign_id ?? null,
        meta_adset_id: payload.meta_adset_id,
        meta_page_id: payload.meta_page_id,
        meta_instagram_user_id: payload.meta_instagram_user_id ?? null,
        headlines,
        primary_texts: primaryTexts,
        description,
        cta_type: payload.cta_type ?? "SHOP_NOW",
        destination_url: destinationUrl,
        publish_active: false,
      })
      .select("id")
      .maybeSingle();
    if (insertErr || !jobInsert) {
      return { ok: false, reason: `ad_publish_jobs_insert_failed:${insertErr?.message ?? "no_row"}` };
    }
    const adPublishJobsId = (jobInsert as { id: string }).id;

    await inngest.send({
      name: "ad-tool/publish-to-meta",
      data: { workspace_id: workspaceId, job_id: adPublishJobsId },
    });

    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "growth",
      actionKind: PROMOTED_READY_TO_TEST_ACTION_KIND,
      specSlug: specSlug ?? null,
      reason: `Promoted ad_campaigns/${payload.ad_campaign_id} into adset ${payload.meta_adset_id} as PAUSED creative (ad_publish_jobs ${adPublishJobsId.slice(0, 8)}).`,
      metadata: {
        ad_campaign_id: payload.ad_campaign_id,
        ad_publish_jobs_id: adPublishJobsId,
        meta_account_id: payload.meta_account_id,
        meta_adset_id: payload.meta_adset_id,
        meta_campaign_id: payload.meta_campaign_id ?? null,
        meta_page_id: payload.meta_page_id,
        publish_active: false,
        autonomous: true,
      },
    });

    return { ok: true, ad_publish_jobs_id: adPublishJobsId };
  } catch (err) {
    return { ok: false, reason: errText(err).slice(0, 200) };
  }
}

/** Result of `executeApprovedPromotions` — one entry per action processed plus an overall ok flag. */
export interface ExecuteApprovedPromotionsResult {
  ok: boolean;
  executed: { actionId: string; ad_publish_jobs_id?: string; ok: boolean; reason?: string }[];
}

/**
 * Iterate over a target job's `pending_actions` and execute every `promote_ready_to_test_creative`
 * action whose status is `approved`. Mutates each handled action in place — `status` flips to
 * `done` on success or `failed` on error, and `result` carries the publish job id (or the error
 * reason). The caller is responsible for persisting the mutated array back to `agent_jobs`.
 *
 * Idempotency note: a `done` action carrying an `ad_publish_jobs_id` in `result` is skipped on a
 * re-run, so a worker restart between persist + finalize never double-publishes.
 */
export async function executeApprovedPromotions(
  admin: Admin,
  target: PromoteTargetJob,
): Promise<ExecuteApprovedPromotionsResult> {
  const actions = target.pending_actions || [];
  const out: ExecuteApprovedPromotionsResult = { ok: true, executed: [] };
  for (const action of actions) {
    if (action.type !== PROMOTE_READY_TO_TEST_ACTION_TYPE) continue;
    if (action.status !== "approved") continue;
    const actionId = action.id || "";
    const payload = readPromotePayload(action);
    if (!payload) {
      action.status = "failed";
      action.result = "missing or malformed publish payload";
      out.ok = false;
      out.executed.push({ actionId, ok: false, reason: "malformed_payload" });
      continue;
    }
    const r = await executePromoteReadyToTest(admin, {
      workspaceId: target.workspace_id,
      specSlug: target.spec_slug ?? null,
      payload,
    });
    if (r.ok && r.ad_publish_jobs_id) {
      action.status = "done";
      action.result = `published PAUSED → ad_publish_jobs ${r.ad_publish_jobs_id}`;
      out.executed.push({ actionId, ok: true, ad_publish_jobs_id: r.ad_publish_jobs_id });
    } else {
      action.status = "failed";
      action.result = `promote failed: ${r.reason ?? "unknown"}`;
      out.ok = false;
      out.executed.push({ actionId, ok: false, reason: r.reason });
    }
  }
  return out;
}
