/**
 * Retarget replenish agent — the Media Buyer's THIRD-campaign go-live loop
 * (retarget-campaign-warm-hot-mixed-content Phase 2).
 *
 * Sibling of [[./agent]] `runMediaBuyerLoopForAccount` (Bianca's COLD test rail), but leaner: the
 * retarget rail has ONE lean consolidated ad set carrying WARM + HOT MIXED creative, so there is
 * no per-test adset minting, no crown/kill decision engine — just a supervised REPLENISH that
 * keeps the consolidated adset stocked with the freshest warm/hot creatives Dahlia tagged.
 *
 * Per pass, per (account, product) cohort it:
 *   (a) resolves the retarget cohort via [[./retarget-cohort]] `getEffectiveRetargetCohort`,
 *   (b) reads ready creatives via [[../ads/ready-to-test]] `listReadyToTest` scoped to the
 *       cohort's `audience_temperatures` WHITELIST (default `['warm','hot']`), and
 *   (c) publishes each through [[./retarget-publish-gate]] `evaluateMediaBuyerRetargetPublish`
 *       (single consolidated adset + ceiling + the SHARED 9/10 Max copy-QC floor). A gate refusal
 *       writes the north-star escalation audit row itself; an allow enqueues one
 *       `origin='media-buyer-retarget'` `ad_publish_jobs` row into the consolidated adset.
 *
 * The COLD-only invariant of Bianca's replenish loop is UNTOUCHED — this file never reads
 * `media_buyer_test_cohorts`, never publishes into a cold adset, and reads only warm/hot bands.
 *
 * Node-completeness trio (CLAUDE.md hard rule): owner `growth` (node-registry KIND_OWNER_FALLBACK
 * `media_buyer_retarget` + the `media-buyer-retarget-cadence` MONITORED_LOOPS row), kill-switch
 * coverage via the ancestor `growth` department row, heartbeat emitted by the cadence cron.
 *
 * See docs/brain/inngest/media-buyer-retarget-cadence.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import { recordDirectorActivity } from "@/lib/director-activity";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { readCopyVariants } from "@/lib/ads/ad-copy-variants";
import {
  resolveReplenishAdCopy,
  type ReplenishAngleCopy,
  type ReplenishCopyPack,
} from "@/lib/media-buyer/agent";
import { resolvePublishIdentity, type PublishIdentity } from "@/lib/media-buyer/publish-identity";
import { getEffectiveRetargetCohort, type RetargetCohort } from "@/lib/media-buyer/retarget-cohort";
import {
  evaluateMediaBuyerRetargetPublish,
  MEDIA_BUYER_RETARGET_ORIGIN,
} from "@/lib/media-buyer/retarget-publish-gate";

type Admin = ReturnType<typeof createAdminClient>;

const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The valid `audience_temperature` bands the retarget whitelist may carry. */
const VALID_RETARGET_BANDS: ReadonlySet<string> = new Set(["cold", "warm", "hot"]);

/** Options for one retarget replenish pass (a single account + optional product cohort). */
export interface RunRetargetReplenishOptions {
  workspaceId: string;
  metaAdAccountId: string;
  productId?: string | null;
  /** Override "now" — reserved for deterministic tests. */
  nowMs?: number;
}

export interface RetargetReplenishResult {
  cohortConfigured: boolean;
  readyConsidered: number;
  published: number;
  refused: number;
  publishJobIds: string[];
  summary: string;
}

/** One entry per (account, product) pass the dispatcher ran. */
export interface RetargetReplenishAccountPass {
  productId: string | null;
  result: RetargetReplenishResult;
  error?: string;
}

/** Sort + dedupe the active retarget cohort product_ids for one (workspace, account) — nulls last.
 *  Mirrors [[./agent]] `readActiveCohortProductIds` for the cold rail. Always returns ≥1 entry so
 *  an unconfigured account still runs one dormant pass (the heartbeat lands). */
export async function readActiveRetargetCohortProductIds(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string },
): Promise<Array<string | null>> {
  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .select("product_id")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_ad_account_id", args.metaAdAccountId)
    .eq("is_active", true);
  if (error) throw new Error(`media_buyer_retarget_cohorts read failed: ${error.message}`);

  const productIds: Array<string | null> = ((data ?? []) as Array<{ product_id: string | null }>)
    .map((r) => r.product_id ?? null)
    .sort((a, b) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a < b ? -1 : 1;
    });
  const seen = new Set<string>();
  const unique: Array<string | null> = [];
  for (const pid of productIds) {
    const key = pid ?? "__null__";
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pid);
  }
  if (unique.length === 0) unique.push(null);
  return unique;
}

/** The bare Meta ad-account id (act id) for one of our `meta_ad_accounts.id` UUIDs. */
async function resolveBareMetaAccountId(admin: Admin, metaAdAccountUuid: string): Promise<string | null> {
  const { data } = await admin
    .from("meta_ad_accounts")
    .select("meta_account_id")
    .eq("id", metaAdAccountUuid)
    .maybeSingle();
  const bare = (data as { meta_account_id?: string | null } | null)?.meta_account_id ?? null;
  return bare && bare.length ? bare : null;
}

/**
 * Enqueue ONE `origin='media-buyer-retarget'` `ad_publish_jobs` row for an allowed retarget
 * creative — publishing into the cohort's SINGLE consolidated adset. Mirrors the cold rail's
 * `enqueueReplenishPublish`: resolve the canonical publish identity, read the campaign's
 * landing_url + angle copy + a ready video, then insert + fire the publisher event. Fail-closed
 * (returns a reason) rather than enqueue a malformed job.
 */
async function enqueueRetargetPublish(
  admin: Admin,
  args: {
    workspaceId: string;
    adCampaignId: string;
    cohort: RetargetCohort;
    bareMetaAccountId: string;
    publishIdentity: PublishIdentity;
  },
): Promise<{ inserted: boolean; jobId: string | null; reason?: string }> {
  const { data: campaign } = await admin
    .from("ad_campaigns")
    .select("id, name, landing_url, angle_id")
    .eq("id", args.adCampaignId)
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  const destination = ((campaign as { landing_url?: string | null } | null)?.landing_url || "").trim();
  if (!destination) return { inserted: false, jobId: null, reason: "campaign has no landing_url" };

  const angleId = (campaign as { angle_id?: string | null } | null)?.angle_id ?? null;
  let angle: ReplenishAngleCopy = null;
  let angleMetadataCopyPack: ReplenishCopyPack | null = null;
  if (angleId) {
    const { data } = await admin
      .from("product_ad_angles")
      .select("meta_headline, meta_primary_text, metadata")
      .eq("id", angleId)
      .eq("workspace_id", args.workspaceId)
      .maybeSingle();
    angle = data as ReplenishAngleCopy;
    const meta = (data as { metadata?: { copy_pack?: ReplenishCopyPack | null } | null } | null)?.metadata ?? null;
    angleMetadataCopyPack = meta?.copy_pack ?? null;
  }
  const variants = await readCopyVariants(admin, args.adCampaignId);
  const copy = resolveReplenishAdCopy(angle, { variants, copyPack: angleMetadataCopyPack });
  if (!copy.ok) {
    return {
      inserted: false,
      jobId: null,
      reason: angleId
        ? `campaign angle ${copy.reason} — skipped to avoid a malformed Meta creative`
        : "campaign has no angle_id — no ad-copy source; skipped",
    };
  }

  const { data: video } = await admin
    .from("ad_videos")
    .select("id")
    .eq("campaign_id", args.adCampaignId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!video?.id) return { inserted: false, jobId: null, reason: "campaign has no ready ad_videos row" };

  const adName = ((campaign as { name?: string | null } | null)?.name || `Retarget — ${args.adCampaignId.slice(0, 8)}`).slice(0, 200);

  const insert = {
    workspace_id: args.workspaceId,
    campaign_id: args.adCampaignId,
    video_id: video.id as string,
    meta_account_id: args.bareMetaAccountId,
    meta_adset_id: args.cohort.retargetMetaAdsetId, // the ONE consolidated retarget adset
    create_adset_spec: null,
    meta_page_id: args.publishIdentity.pageId,
    meta_instagram_user_id: args.publishIdentity.instagramUserId,
    headlines: copy.headlines,
    primary_texts: copy.primaryTexts,
    descriptions: copy.descriptions,
    cta_type: "SHOP_NOW" as const,
    destination_url: destination,
    publish_active: true as const,
    publish_status: "queued" as const,
    origin: MEDIA_BUYER_RETARGET_ORIGIN,
    ad_name: adName,
  };

  const { data: job, error } = await admin
    .from("ad_publish_jobs")
    .insert(insert)
    .select("id")
    .single();
  if (error || !job) return { inserted: false, jobId: null, reason: `insert failed: ${error?.message ?? "no row"}` };

  await inngest.send({ name: "ad-tool/publish-to-meta", data: { workspace_id: args.workspaceId, job_id: job.id } });
  return { inserted: true, jobId: job.id as string };
}

/**
 * Run ONE retarget replenish pass for a single (account, product) cohort. Resolves the cohort,
 * reads warm/hot ready creatives, gates each publish, and enqueues the passers. Writes ONE
 * `media_buyer_retarget_pass_completed` heartbeat so the audit trail proves the pass ran (even
 * when dormant / empty). Returns the pass result; never throws for a per-creative failure.
 */
export async function runRetargetReplenishPass(
  admin: Admin,
  opts: RunRetargetReplenishOptions,
): Promise<RetargetReplenishResult> {
  const cohort = await getEffectiveRetargetCohort(admin, opts.workspaceId, {
    metaAdAccountId: opts.metaAdAccountId,
    productId: opts.productId ?? null,
  });

  const emptyResult = (summary: string, cohortConfigured: boolean): RetargetReplenishResult => ({
    cohortConfigured,
    readyConsidered: 0,
    published: 0,
    refused: 0,
    publishJobIds: [],
    summary,
  });

  if (!cohort) {
    const summary = "Retarget replenish dormant: no active media_buyer_retarget_cohorts row for this (account, product).";
    await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_retarget_pass_completed",
      specSlug: null,
      reason: summary,
      metadata: { meta_ad_account_id: opts.metaAdAccountId, product_id: opts.productId ?? null, cohort_configured: false, autonomous: true },
    });
    return emptyResult(summary, false);
  }

  // Resolve the canonical publish identity + bare Meta account id up front — a mis-scoped
  // workspace or an account with no bare id fails the whole pass closed (never a malformed job).
  let publishIdentity: PublishIdentity;
  try {
    publishIdentity = resolvePublishIdentity(opts.workspaceId);
  } catch (e) {
    const summary = `Retarget replenish skipped: ${errText(e)}`;
    await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_retarget_pass_completed",
      specSlug: null,
      reason: summary,
      metadata: { meta_ad_account_id: opts.metaAdAccountId, cohort_id: cohort.id, cohort_configured: true, autonomous: true },
    });
    return emptyResult(summary, true);
  }
  const bareMetaAccountId = await resolveBareMetaAccountId(admin, opts.metaAdAccountId);
  if (!bareMetaAccountId) {
    const summary = `Retarget replenish skipped: meta_ad_accounts row ${opts.metaAdAccountId} has no bare meta_account_id.`;
    await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_retarget_pass_completed",
      specSlug: null,
      reason: summary,
      metadata: { meta_ad_account_id: opts.metaAdAccountId, cohort_id: cohort.id, cohort_configured: true, autonomous: true },
    });
    return emptyResult(summary, true);
  }

  // (b) ready read — scoped to the cohort's audience_temperatures WHITELIST (warm+hot mix).
  const whitelist = cohort.audienceTemperatures
    .filter((t): t is "cold" | "warm" | "hot" => VALID_RETARGET_BANDS.has(t));
  const { readyToTest } = await listReadyToTest(admin, {
    workspaceId: opts.workspaceId,
    productId: cohort.productId ?? null,
    temperatures: whitelist.length ? whitelist : ["warm", "hot"],
  });

  let published = 0;
  let refused = 0;
  const publishJobIds: string[] = [];
  for (const ready of readyToTest) {
    // (c) publish through the retarget gate — single consolidated adset + ceiling + Max copy-QC.
    const gate = await evaluateMediaBuyerRetargetPublish(admin, {
      workspaceId: opts.workspaceId,
      metaAdAccountId: opts.metaAdAccountId,
      productId: cohort.productId ?? null,
      adCampaignId: ready.ad_campaign_id,
      metaAdsetId: cohort.retargetMetaAdsetId,
      projectedDailyCents: cohort.dailyCeilingCents,
    });
    if (!gate.allowed) {
      // The gate already wrote the media_buyer_retarget_publish_refused escalation audit row.
      refused += 1;
      continue;
    }
    const enq = await enqueueRetargetPublish(admin, {
      workspaceId: opts.workspaceId,
      adCampaignId: ready.ad_campaign_id,
      cohort,
      bareMetaAccountId,
      publishIdentity,
    });
    if (enq.inserted && enq.jobId) {
      published += 1;
      publishJobIds.push(enq.jobId);
    }
  }

  const summary = `Retarget replenish: ${readyToTest.length} warm/hot ready considered → ${published} published, ${refused} gate-refused (adset ${cohort.retargetMetaAdsetId}).`;
  await recordDirectorActivity(admin, {
    workspaceId: opts.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_retarget_pass_completed",
    specSlug: null,
    reason: summary,
    metadata: {
      meta_ad_account_id: opts.metaAdAccountId,
      product_id: cohort.productId ?? null,
      cohort_id: cohort.id,
      cohort_configured: true,
      audience_temperatures: whitelist,
      ready_considered: readyToTest.length,
      published,
      refused,
      publish_job_ids: publishJobIds,
      autonomous: true,
    },
  });

  return {
    cohortConfigured: true,
    readyConsidered: readyToTest.length,
    published,
    refused,
    publishJobIds,
    summary,
  };
}

/**
 * Dispatcher — enumerate the active retarget cohorts for one (workspace, account) and run
 * `runRetargetReplenishPass` ONCE per (account, product) tuple. Mirrors [[./agent]]
 * `runMediaBuyerLoopForAccount`: a shared account carrying two products produces two passes; an
 * unconfigured account still runs ONE dormant pass so the heartbeat lands. Per-pass errors are
 * caught + returned so one bad product never hides another's progress.
 */
export async function runRetargetReplenishLoopForAccount(
  admin: Admin,
  opts: Omit<RunRetargetReplenishOptions, "productId">,
): Promise<RetargetReplenishAccountPass[]> {
  const productIds = await readActiveRetargetCohortProductIds(admin, {
    workspaceId: opts.workspaceId,
    metaAdAccountId: opts.metaAdAccountId,
  });

  const passes: RetargetReplenishAccountPass[] = [];
  for (const productId of productIds) {
    try {
      const result = await runRetargetReplenishPass(admin, { ...opts, productId });
      passes.push({ productId, result });
    } catch (err) {
      const msg = errText(err);
      passes.push({
        productId,
        result: {
          cohortConfigured: false,
          readyConsidered: 0,
          published: 0,
          refused: 0,
          publishJobIds: [],
          summary: `Retarget replenish pass threw: ${msg.slice(0, 200)}`,
        },
        error: msg,
      });
    }
  }
  return passes;
}
