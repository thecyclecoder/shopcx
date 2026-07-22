/**
 * Retarget replenish agent — the RETARGET-rail sibling of
 * [[./agent]] `runMediaBuyerLoopForAccount` (the cold-test replenish loop).
 *
 * The v3 Ad Creative Engine goal M3
 * ([[../../../docs/brain/specs/retarget-campaign-warm-hot-mixed-content]] Phase 2)
 * ships a distinct third Meta campaign — one lean retarget campaign, one
 * consolidated adset per cohort, warm+hot MIXED content — on its own
 * supervisable-autonomy rail. Bianca's cold rail
 * ([[./agent]] `runMediaBuyerLoopForAccount`) passes `temperature:'cold'` to
 * `listReadyToTest` per the shipped
 * [[../../../docs/brain/specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]]
 * spec — a hard invariant this sibling MUST NOT violate.
 *
 * Per cadence pass, per (workspace, meta_ad_account) tuple:
 *
 *   1) Enumerate every ACTIVE retarget cohort for the tuple via
 *      [[./retarget-cohort]] `listActiveRetargetCohorts`. A workspace with no
 *      provisioned cohort is DORMANT — the loop returns an empty plan.
 *
 *   2) For each cohort, READ the ready-to-test bin via [[../ads/ready-to-test]]
 *      `listReadyToTest` SCOPED to the cohort's `audienceTemperatures` whitelist
 *      (defaults to `['warm','hot']`). A cold-tagged creative CANNOT surface
 *      here — its rail stays with Bianca's cold replenish.
 *
 *   3) PER ready creative, evaluate [[./retarget-publish-gate]]
 *      `evaluateMediaBuyerRetargetPublish`. On refusal, insert one
 *      `director_activity` row with `kind='media_buyer_retarget_publish_refused'`
 *      and escalate to the CEO via
 *      `escalateMediaBuyerRetargetPublishRefusal` — the publish PAUSES
 *      (never silently spends). On allow, insert one `ad_publish_jobs` row
 *      with `origin='media-buyer-retarget'` targeting `cohort.retargetMetaAdsetId`
 *      and fire the Inngest publisher event.
 *
 * Every allow AND refusal writes exactly one growth-owned `director_activity`
 * row so the audit trail cites concrete (cohort, creative, reason) — never a
 * silent proxy-optimizer per the ShopCX north star.
 *
 * The runner is READ-ONLY vs the shipped cold test cohort table + Bianca's
 * agent.ts. It reads its own [[./retarget-cohort]] SDK for the cohort row and
 * writes its own `ad_publish_jobs` origin — nothing in Bianca's rail is
 * consulted, mutated, or renamed.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import { recordDirectorActivity } from "@/lib/director-activity";
import { listReadyToTest, type ReadyToTestRow } from "@/lib/ads/ready-to-test";
import { readCopyVariants } from "@/lib/ads/ad-copy-variants";
import {
  hasResolvedInstagramIdentity,
  MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON,
  resolvePublishIdentity,
  type PublishIdentity,
} from "@/lib/media-buyer/publish-identity";
import {
  listActiveRetargetCohorts,
  type MediaBuyerRetargetCohort,
} from "@/lib/media-buyer/retarget-cohort";
import {
  evaluateMediaBuyerRetargetPublish,
  escalateMediaBuyerRetargetPublishRefusal,
  MEDIA_BUYER_RETARGET_ORIGIN,
  type MediaBuyerRetargetRefusalReason,
} from "@/lib/media-buyer/retarget-publish-gate";
import { resolveReplenishAdCopy, type ReplenishCopyPack } from "@/lib/media-buyer/agent";

type Admin = ReturnType<typeof createAdminClient>;

const GROWTH_DIRECTOR_FUNCTION = "growth";

/**
 * The default per-creative daily budget the retarget rail publishes at when the
 * cohort ceiling permits. Kept LOW ($10/day) so a single misfired creative
 * cannot exhaust a retarget cohort's ceiling on its own — the cohort's own
 * `dailyCeilingCents` is the outer bound the gate still enforces. Sized off the
 * shipped [[./publish-gate]] per-test budget (~$150) minus the cold rail's
 * scale-out shape — retarget cohorts are one consolidated adset carrying MANY
 * creatives, not one adset per creative.
 */
export const DEFAULT_RETARGET_CREATIVE_DAILY_CENTS = 1000;

/** One row per `(cohort, creative)` decision the pass made — allow / refuse / skip. */
export type RetargetPlanAction = {
  cohortId: string;
  adCampaignId: string;
  audienceTemperature: "warm" | "hot" | null;
  metaAdsetId: string;
  projectedDailyCents: number;
} & (
  | { kind: "published"; jobId: string }
  | { kind: "refused"; reason: MediaBuyerRetargetRefusalReason; diagnosis: string }
  | { kind: "skipped"; skipReason: string }
);

export interface RunRetargetReplenishOptions {
  workspaceId: string;
  metaAdAccountId: string;
}

export interface RunRetargetReplenishResult {
  cohortsEnumerated: number;
  readyEnumerated: number;
  actions: RetargetPlanAction[];
  writes: {
    directorActivityRows: number;
    publishJobsInserted: number;
    escalationsEmitted: number;
  };
  /** A one-line human summary the caller can pin to a heartbeat / audit row. */
  summary: string;
}

/**
 * Run one retarget replenish pass for a single `(workspace, meta_ad_account)`
 * tuple. Public entry point the cron ([[../inngest/media-buyer-retarget-cadence]]
 * — Phase 3) drives.
 *
 * Bianca's cold rail is untouched: this runner reads its own cohort SDK, its own
 * whitelisted ready-to-test bin, its own publish gate, and writes its own
 * origin — no import from [[./agent]] `runMediaBuyerLoopForAccount` beyond the
 * PURE helpers (`resolveReplenishAdCopy`).
 *
 * A workspace with no active retarget cohort short-circuits — returns an empty
 * plan and writes one heartbeat `director_activity` row so the audit ledger
 * proves the pass ran (dormant is a fact, not silence).
 */
export async function runRetargetReplenishLoopForAccount(
  admin: Admin,
  opts: RunRetargetReplenishOptions,
): Promise<RunRetargetReplenishResult> {
  const cohorts = await listActiveRetargetCohorts(admin, {
    workspaceId: opts.workspaceId,
    metaAdAccountId: opts.metaAdAccountId,
  });
  const workspaceWide = await listActiveRetargetCohorts(admin, {
    workspaceId: opts.workspaceId,
    metaAdAccountId: null,
  });
  // Compose the effective cohort list: per-account cohorts win, but a workspace-
  // wide (null-account) cohort still runs when no per-account cohort covers its
  // product tuple. Mirrors the cold rail's account-then-workspace enumeration.
  const effectiveCohorts = dedupeCohorts([...cohorts, ...workspaceWide]);

  const actions: RetargetPlanAction[] = [];
  let readyEnumerated = 0;
  let directorActivityRows = 0;
  let publishJobsInserted = 0;
  let escalationsEmitted = 0;

  const publishIdentity = tryResolvePublishIdentity(opts.workspaceId);

  for (const cohort of effectiveCohorts) {
    const { readyToTest } = await listReadyToTest(admin, {
      workspaceId: opts.workspaceId,
      productId: cohort.productId,
      temperatures: cohort.audienceTemperatures,
    });
    readyEnumerated += readyToTest.length;

    for (const ready of readyToTest) {
      const projected = DEFAULT_RETARGET_CREATIVE_DAILY_CENTS;
      const gate = await evaluateMediaBuyerRetargetPublish(admin, {
        workspaceId: opts.workspaceId,
        metaAdAccountId: opts.metaAdAccountId,
        productId: cohort.productId,
        metaAdsetId: cohort.retargetMetaAdsetId,
        projectedDailyCents: projected,
        adCampaignId: ready.ad_campaign_id,
      });

      if (!gate.allowed) {
        actions.push({
          cohortId: cohort.id,
          adCampaignId: ready.ad_campaign_id,
          audienceTemperature: readyTemperature(ready),
          metaAdsetId: cohort.retargetMetaAdsetId,
          projectedDailyCents: projected,
          kind: "refused",
          reason: gate.reason,
          diagnosis: gate.diagnosis,
        });
        const audit = await recordDirectorActivity(admin, {
          workspaceId: opts.workspaceId,
          directorFunction: GROWTH_DIRECTOR_FUNCTION,
          actionKind: "media_buyer_retarget_publish_refused",
          specSlug: null,
          reason: gate.diagnosis,
          metadata: {
            reason: gate.reason,
            cohort_id: cohort.id,
            ad_campaign_id: ready.ad_campaign_id,
            meta_adset_id: cohort.retargetMetaAdsetId,
            meta_ad_account_id: opts.metaAdAccountId,
            projected_daily_cents: projected,
            ceiling_cents: gate.ceilingCents,
            audience_temperature: readyTemperature(ready),
            autonomous: true,
          },
        });
        if (audit.recorded) directorActivityRows += 1;
        const esc = await escalateMediaBuyerRetargetPublishRefusal(admin, {
          workspaceId: opts.workspaceId,
          metaAdsetId: cohort.retargetMetaAdsetId,
          metaAdAccountId: opts.metaAdAccountId,
          projectedDailyCents: projected,
          reason: gate.reason,
          diagnosis: gate.diagnosis,
          ceilingCents: gate.ceilingCents,
          jobId: null,
          campaignId: ready.ad_campaign_id,
          cohortId: cohort.id,
        });
        if (esc.emitted) escalationsEmitted += 1;
        continue;
      }

      // Allowed — try to insert the publish job. A per-creative missing-copy /
      // missing-video / missing-landing-url still SKIPS the ad without touching
      // the gate; the audit row cites the exact skip reason.
      const enqueue = await enqueueRetargetPublish(admin, {
        workspaceId: opts.workspaceId,
        metaAdAccountId: opts.metaAdAccountId,
        cohort,
        ready,
        projectedDailyCents: projected,
        publishIdentity,
      });
      if (!enqueue.ok) {
        actions.push({
          cohortId: cohort.id,
          adCampaignId: ready.ad_campaign_id,
          audienceTemperature: readyTemperature(ready),
          metaAdsetId: cohort.retargetMetaAdsetId,
          projectedDailyCents: projected,
          kind: "skipped",
          skipReason: enqueue.reason,
        });
        const audit = await recordDirectorActivity(admin, {
          workspaceId: opts.workspaceId,
          directorFunction: GROWTH_DIRECTOR_FUNCTION,
          actionKind: "media_buyer_retarget_publish_skipped",
          specSlug: null,
          reason: enqueue.reason,
          metadata: {
            cohort_id: cohort.id,
            ad_campaign_id: ready.ad_campaign_id,
            meta_adset_id: cohort.retargetMetaAdsetId,
            meta_ad_account_id: opts.metaAdAccountId,
            audience_temperature: readyTemperature(ready),
            autonomous: true,
          },
        });
        if (audit.recorded) directorActivityRows += 1;
        continue;
      }

      actions.push({
        cohortId: cohort.id,
        adCampaignId: ready.ad_campaign_id,
        audienceTemperature: readyTemperature(ready),
        metaAdsetId: cohort.retargetMetaAdsetId,
        projectedDailyCents: projected,
        kind: "published",
        jobId: enqueue.jobId,
      });
      publishJobsInserted += 1;
      const audit = await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: "media_buyer_retarget_publish_enqueued",
        specSlug: null,
        reason:
          `Enqueued retarget publish for ${ready.ad_campaign_id} into cohort ${cohort.id} adset ` +
          `${cohort.retargetMetaAdsetId} at $${(projected / 100).toFixed(2)}/day.`,
        metadata: {
          cohort_id: cohort.id,
          ad_campaign_id: ready.ad_campaign_id,
          meta_adset_id: cohort.retargetMetaAdsetId,
          meta_ad_account_id: opts.metaAdAccountId,
          audience_temperature: readyTemperature(ready),
          projected_daily_cents: projected,
          job_id: enqueue.jobId,
          autonomous: true,
        },
      });
      if (audit.recorded) directorActivityRows += 1;
    }
  }

  // One heartbeat row per pass — proves the runner executed even when the plan
  // is empty (no active cohort, no ready creative). Mirrors the cold rail's
  // `media_buyer_pass_completed` heartbeat.
  const heartbeat = await recordDirectorActivity(admin, {
    workspaceId: opts.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_retarget_pass_completed",
    specSlug: null,
    reason:
      `Retarget replenish pass: ${effectiveCohorts.length} cohort(s), ${readyEnumerated} ready creative(s), ` +
      `${publishJobsInserted} published, ${actions.filter((a) => a.kind === "refused").length} refused, ` +
      `${actions.filter((a) => a.kind === "skipped").length} skipped.`,
    metadata: {
      meta_ad_account_id: opts.metaAdAccountId,
      cohorts_enumerated: effectiveCohorts.length,
      ready_enumerated: readyEnumerated,
      published: publishJobsInserted,
      refused: actions.filter((a) => a.kind === "refused").length,
      skipped: actions.filter((a) => a.kind === "skipped").length,
      autonomous: true,
    },
  });
  if (heartbeat.recorded) directorActivityRows += 1;

  return {
    cohortsEnumerated: effectiveCohorts.length,
    readyEnumerated,
    actions,
    writes: { directorActivityRows, publishJobsInserted, escalationsEmitted },
    summary:
      `Retarget replenish pass (account ${opts.metaAdAccountId}): ${effectiveCohorts.length} cohort(s), ` +
      `${readyEnumerated} ready, ${publishJobsInserted} published, ` +
      `${actions.filter((a) => a.kind === "refused").length} refused.`,
  };
}

/** Best-effort resolver — a workspace missing a canonical identity SKIPS every publish (audit reason). */
function tryResolvePublishIdentity(workspaceId: string): PublishIdentity | null {
  try {
    return resolvePublishIdentity(workspaceId);
  } catch {
    return null;
  }
}

/** PURE — dedupe cohorts by id so the account-then-workspace merge yields unique rows. */
function dedupeCohorts(rows: MediaBuyerRetargetCohort[]): MediaBuyerRetargetCohort[] {
  const seen = new Set<string>();
  const out: MediaBuyerRetargetCohort[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function readyTemperature(ready: ReadyToTestRow): "warm" | "hot" | null {
  return ready.audience_temperature === "warm" || ready.audience_temperature === "hot"
    ? ready.audience_temperature
    : null;
}

interface EnqueueRetargetPublishArgs {
  workspaceId: string;
  metaAdAccountId: string;
  cohort: MediaBuyerRetargetCohort;
  ready: ReadyToTestRow;
  projectedDailyCents: number;
  publishIdentity: PublishIdentity | null;
}

type EnqueueRetargetPublishResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: string };

/**
 * Insert one `ad_publish_jobs` row for a retarget replenish action
 * (origin='media-buyer-retarget', publish_active=true) + fire the Inngest
 * publisher. The publisher's belt-and-suspenders gate ([[../inngest/ad-tool]]
 * `adToolPublishToMeta`) re-runs `evaluateMediaBuyerRetargetPublish` on this
 * origin before flipping the ad ACTIVE — a mid-run cohort retire is caught
 * defensively.
 *
 * Skips (never inserts a malformed row) when the workspace has no canonical
 * publish identity, the campaign has no landing_url, the angle carries no
 * usable copy, or there is no ready `ad_videos` row for the campaign. Mirrors
 * the cold rail's [[./agent]] `enqueueReplenishPublish` skip precedence.
 */
async function enqueueRetargetPublish(
  admin: Admin,
  args: EnqueueRetargetPublishArgs,
): Promise<EnqueueRetargetPublishResult> {
  if (!args.publishIdentity || !hasResolvedInstagramIdentity(args.publishIdentity)) {
    return { ok: false, reason: MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON };
  }
  const { data: campaign, error: campaignErr } = await admin
    .from("ad_campaigns")
    .select("id, name, landing_url, angle_id")
    .eq("id", args.ready.ad_campaign_id)
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  if (campaignErr) return { ok: false, reason: `campaign lookup failed: ${campaignErr.message}` };
  const destination = ((campaign as { landing_url?: string | null } | null)?.landing_url || "").trim();
  if (!destination) return { ok: false, reason: "campaign has no landing_url" };

  const angleId = (campaign as { angle_id?: string | null } | null)?.angle_id ?? null;
  let angle: { meta_headline?: string | null; meta_primary_text?: string | null } | null = null;
  let angleMetadataCopyPack: ReplenishCopyPack | null = null;
  if (angleId) {
    const { data } = await admin
      .from("product_ad_angles")
      .select("meta_headline, meta_primary_text, metadata")
      .eq("id", angleId)
      .eq("workspace_id", args.workspaceId)
      .maybeSingle();
    angle = data as typeof angle;
    const meta = (data as { metadata?: { copy_pack?: ReplenishCopyPack | null } | null } | null)?.metadata ?? null;
    angleMetadataCopyPack = meta?.copy_pack ?? null;
  }
  const variants = await readCopyVariants(admin, args.ready.ad_campaign_id);
  const copy = resolveReplenishAdCopy(angle, { variants, copyPack: angleMetadataCopyPack });
  if (!copy.ok) {
    return {
      ok: false,
      reason: angleId
        ? `campaign angle ${copy.reason} — skipped to avoid a malformed Meta creative`
        : "campaign has no angle_id — no ad-copy source; skipped",
    };
  }

  const { data: video } = await admin
    .from("ad_videos")
    .select("id")
    .eq("campaign_id", args.ready.ad_campaign_id)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const videoId = (video as { id?: string } | null)?.id ?? null;
  if (!videoId) return { ok: false, reason: "campaign has no ready ad_videos row" };

  // The account's bare Meta act id — needed on the publish row. Read via
  // meta_ad_accounts.id → meta_account_id.
  const { data: acctRow } = await admin
    .from("meta_ad_accounts")
    .select("meta_account_id")
    .eq("id", args.metaAdAccountId)
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  const metaAccountId = (acctRow as { meta_account_id?: string | null } | null)?.meta_account_id ?? null;
  if (!metaAccountId) return { ok: false, reason: "meta_ad_accounts row missing meta_account_id" };

  const adName = (
    (campaign as { name?: string | null } | null)?.name ||
    `Retarget — ${args.ready.ad_campaign_id.slice(0, 8)}`
  ).slice(0, 200);

  const insertBody = {
    workspace_id: args.workspaceId,
    campaign_id: args.ready.ad_campaign_id,
    video_id: videoId,
    meta_account_id: metaAccountId,
    meta_adset_id: args.cohort.retargetMetaAdsetId,
    meta_page_id: args.publishIdentity.pageId,
    meta_instagram_user_id: args.publishIdentity.instagramUserId,
    headlines: copy.headlines,
    primary_texts: copy.primaryTexts,
    descriptions: copy.descriptions.length ? copy.descriptions : null,
    cta_type: "SHOP_NOW" as const,
    destination_url: destination,
    publish_active: true,
    publish_status: "queued" as const,
    origin: MEDIA_BUYER_RETARGET_ORIGIN,
    ad_name: adName,
  };

  const { data: job, error } = await admin
    .from("ad_publish_jobs")
    .insert(insertBody)
    .select("id")
    .single();
  if (error || !job) {
    return { ok: false, reason: `insert failed: ${errText(error) || "no row"}` };
  }

  try {
    await inngest.send({
      name: "ad-tool/publish-to-meta",
      data: { workspace_id: args.workspaceId, job_id: (job as { id: string }).id },
    });
  } catch (e) {
    // Best-effort dispatch — the ledger row still exists and the publisher's
    // own drain (or a re-run) will pick it up. Recorded on the caller's skip
    // audit row so an inngest outage is visible.
    return { ok: false, reason: `inngest dispatch failed: ${errText(e)}` };
  }
  return { ok: true, jobId: (job as { id: string }).id };
}
