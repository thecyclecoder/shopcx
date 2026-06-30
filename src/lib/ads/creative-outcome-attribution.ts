/**
 * Creative→outcome lineage attribution — Phase 3 of docs/brain/specs/growth-adopt-creative-makers.md.
 *
 * After the Growth Director promotes a ready-to-test creative ([[./ready-to-test-promote]] writes a
 * `director_activity` row of `action_kind='promoted_ready_to_test'` carrying `metadata.ad_publish_jobs_id`),
 * we need a follow-up row that grades the bet. On the next settled-outcome window — at least
 * `OUTCOME_MATURATION_DAYS=3` ([[../meta/iteration-run]]) days after the publish — read the matching
 * [[../../tables/meta_attribution_daily]] rows by the publish job's `meta_ad_id`, aggregate spend/sessions/
 * revenue over the 7-day attribution window, and write ONE
 * `director_activity` row of `action_kind='attributed_creative_outcome'` with metadata
 * `{ad_publish_jobs_id, meta_ad_id, attribution_window_days:7, outcome:{roas?, spend_cents, sessions, variant_key?}}`.
 *
 * That lineage row is what the Director brief reads to answer "which creatives we promoted converted",
 * making the leash's autonomous promotions gradable end-to-end (promote → publish → outcome).
 *
 * The whole pass is idempotent: a publish job that already has an `attributed_creative_outcome` row in
 * `director_activity` is skipped on the next run, so the daily iteration-run heartbeat can fire this
 * stage every day without double-stamping. Per the spec, this rides the existing `meta-iteration-run`
 * reconcile stage as its heartbeat — see [[../inngest/meta-performance]] `metaIterationRun`.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import { OUTCOME_MATURATION_DAYS } from "@/lib/meta/iteration-run";

type Admin = ReturnType<typeof createAdminClient>;

/** The `director_activity.action_kind` Phase 2 stamps when the Director promotes a ready-to-test creative. */
export const PROMOTED_READY_TO_TEST_KIND = "promoted_ready_to_test" as const;

/** The `director_activity.action_kind` Phase 3 stamps once an attribution window has settled. */
export const ATTRIBUTED_CREATIVE_OUTCOME_KIND = "attributed_creative_outcome" as const;

/** Trailing attribution window the outcome aggregates over (the spec's 7d default). */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;

/** Shape of the `outcome` blob written into the lineage row's metadata. */
export interface CreativeOutcome {
  /** revenue_cents / spend_cents — null when the window has no spend (a degenerate ROAS). */
  roas: number | null;
  /** summed `attributed_spend_cents` across the window. */
  spend_cents: number;
  /** summed `sessions` across the window. */
  sessions: number;
  /** dominant variant by session share — the one Meta drove most traffic to. */
  variant_key: string | null;
}

/** Minimum input fields the aggregator reads off [[meta_attribution_daily]]. */
export interface AttributionRow {
  variant: string | null;
  sessions: number | null;
  attributed_spend_cents: number | null;
  revenue_cents: number | null;
  snapshot_date: string;
}

/**
 * Pure aggregator — sum rows in a [[meta_attribution_daily]] slice into one `outcome` blob. Exported
 * so tests can pin behavior without round-tripping the DB. `null` numerics are treated as 0. The
 * `(unresolved)` variant counts toward spend/sessions but does NOT win the `variant_key` race unless
 * it is the ONLY one present — a real lander beats the unresolved bucket every time.
 */
export function aggregateAttributionRows(rows: AttributionRow[]): CreativeOutcome {
  let spend = 0;
  let sessions = 0;
  let revenue = 0;
  const sessionsByVariant = new Map<string, number>();
  for (const r of rows) {
    const s = Number(r.sessions ?? 0);
    const sp = Number(r.attributed_spend_cents ?? 0);
    const rv = Number(r.revenue_cents ?? 0);
    spend += sp;
    sessions += s;
    revenue += rv;
    const v = r.variant || "(unresolved)";
    sessionsByVariant.set(v, (sessionsByVariant.get(v) ?? 0) + s);
  }
  // Pick the variant with the most sessions; tie-break by lexical so the result is deterministic.
  // Filter out `(unresolved)` unless it's the only signal — a real lander always wins over it.
  const namedVariants = [...sessionsByVariant.entries()].filter(([k]) => k !== "(unresolved)");
  const pool = namedVariants.length > 0 ? namedVariants : [...sessionsByVariant.entries()];
  let variant_key: string | null = null;
  let bestSessions = -1;
  for (const [k, v] of pool) {
    if (v > bestSessions || (v === bestSessions && (variant_key === null || k < variant_key))) {
      variant_key = k;
      bestSessions = v;
    }
  }
  const roas = spend > 0 ? Number((revenue / spend).toFixed(4)) : null;
  return { roas, spend_cents: spend, sessions, variant_key };
}

/** UTC day string (`YYYY-MM-DD`) — matches the `meta_attribution_daily.snapshot_date` shape. */
function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Days between two `YYYY-MM-DD` strings (b - a). Safe across DST since both are UTC days. */
function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86400_000);
}

export interface AttributeCreativeOutcomesOptions {
  workspaceId: string;
  /** The snapshot day the iteration-run is reconciling for (`YYYY-MM-DD`). Defaults to today UTC. */
  snapshotDate?: string;
  /** Override the spec's 7-day attribution window (tests). */
  attributionWindowDays?: number;
  /** Override `OUTCOME_MATURATION_DAYS` (tests). */
  maturationDays?: number;
}

export interface AttributeCreativeOutcomesResult {
  /** How many new `attributed_creative_outcome` rows were written. */
  attributed: number;
  /** Promotions whose publish job hasn't matured yet (`elapsed < maturationDays`). */
  skipped_immature: number;
  /** Mature promotions whose publish job has no `published` status or no `meta_ad_id` to key on. */
  skipped_not_published: number;
  /** Mature promotions with NO matching `meta_attribution_daily` rows in the window (no signal yet). */
  skipped_no_attribution: number;
  /** Promotions already stamped on a prior pass (idempotency). */
  skipped_already_done: number;
}

/**
 * Look at every `promoted_ready_to_test` lineage row for the workspace and, for each whose publish
 * has settled, write the matching `attributed_creative_outcome` follow-up row. Idempotent — a publish
 * job already attributed on a prior pass is skipped.
 *
 * The loop is per-workspace (not per-ad-account) because `meta_attribution_daily` and
 * `director_activity` are workspace-scoped; the iteration-run wrapper invokes this once per account
 * but the work is no-op after the first call per snapshot day per workspace.
 */
export async function attributeCreativeOutcomes(
  admin: Admin,
  opts: AttributeCreativeOutcomesOptions,
): Promise<AttributeCreativeOutcomesResult> {
  const workspaceId = opts.workspaceId;
  const snapshotDate = opts.snapshotDate ?? dayStr(new Date());
  const attributionWindowDays = opts.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS;
  const maturationDays = opts.maturationDays ?? OUTCOME_MATURATION_DAYS;

  const result: AttributeCreativeOutcomesResult = {
    attributed: 0,
    skipped_immature: 0,
    skipped_not_published: 0,
    skipped_no_attribution: 0,
    skipped_already_done: 0,
  };

  // 1) Every `promoted_ready_to_test` lineage row for this workspace, with the publish job id.
  const { data: promotedData } = await admin
    .from("director_activity")
    .select("metadata, spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("action_kind", PROMOTED_READY_TO_TEST_KIND);
  const promotedRows = (promotedData || []) as { metadata: Record<string, unknown> | null; spec_slug: string | null }[];
  const promotedByJobId = new Map<string, { spec_slug: string | null }>();
  for (const row of promotedRows) {
    const jobId = row.metadata?.["ad_publish_jobs_id"];
    if (typeof jobId !== "string" || !jobId) continue;
    // First seen wins — a re-promote of the same job is a no-op against this map.
    if (!promotedByJobId.has(jobId)) promotedByJobId.set(jobId, { spec_slug: row.spec_slug });
  }
  if (promotedByJobId.size === 0) return result;

  // 2) Dedup against existing `attributed_creative_outcome` rows. The spec wants exactly ONE per
  // publish job, so a present row is always a skip (an "ignore" not an "update").
  const { data: doneData } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("workspace_id", workspaceId)
    .eq("action_kind", ATTRIBUTED_CREATIVE_OUTCOME_KIND);
  const alreadyDone = new Set<string>();
  for (const row of (doneData || []) as { metadata: Record<string, unknown> | null }[]) {
    const jobId = row.metadata?.["ad_publish_jobs_id"];
    if (typeof jobId === "string" && jobId) alreadyDone.add(jobId);
  }

  // 3) Pull the publish job rows we still need to consider. The Phase-2 helper writes the
  // `ad_publish_jobs_id` into the lineage row's metadata; we read the publish status + meta_ad_id +
  // the publish day off the row itself.
  const pendingJobIds = [...promotedByJobId.keys()].filter((id) => !alreadyDone.has(id));
  result.skipped_already_done = promotedByJobId.size - pendingJobIds.length;
  if (pendingJobIds.length === 0) return result;

  const { data: jobData } = await admin
    .from("ad_publish_jobs")
    .select("id, publish_status, meta_ad_id, meta_account_id, updated_at, created_at")
    .eq("workspace_id", workspaceId)
    .in("id", pendingJobIds);
  type JobRow = {
    id: string;
    publish_status: string | null;
    meta_ad_id: string | null;
    meta_account_id: string | null;
    updated_at: string | null;
    created_at: string | null;
  };
  const jobs = (jobData || []) as JobRow[];
  const jobsById = new Map<string, JobRow>();
  for (const j of jobs) jobsById.set(j.id, j);

  // 4) For every pending job, gate on (published + meta_ad_id + matured), aggregate the window,
  // and write the lineage row. Per-row best-effort: a failure on one job doesn't abort the rest.
  for (const jobId of pendingJobIds) {
    const job = jobsById.get(jobId);
    if (!job || job.publish_status !== "published" || !job.meta_ad_id) {
      result.skipped_not_published += 1;
      continue;
    }
    // `updated_at` flips on the `publish_status='published'` write — close enough to publish-time
    // for a day-grain maturation check. The created_at fallback covers a job that never updated.
    const publishedAt = job.updated_at || job.created_at;
    if (!publishedAt) {
      result.skipped_not_published += 1;
      continue;
    }
    const publishDay = publishedAt.slice(0, 10);
    const elapsed = daysBetween(publishDay, snapshotDate);
    if (elapsed < maturationDays) {
      result.skipped_immature += 1;
      continue;
    }

    // The 7-day window starts at the publish day (inclusive) and runs for `attributionWindowDays`.
    const windowStart = publishDay;
    const windowEndDate = new Date(Date.parse(publishDay) + (attributionWindowDays - 1) * 86400_000);
    const windowEnd = dayStr(windowEndDate);
    const { data: attrData } = await admin
      .from("meta_attribution_daily")
      .select("variant, sessions, attributed_spend_cents, revenue_cents, snapshot_date")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_id", job.meta_ad_id)
      .gte("snapshot_date", windowStart)
      .lte("snapshot_date", windowEnd);
    const attrRows = (attrData || []) as AttributionRow[];
    if (attrRows.length === 0) {
      result.skipped_no_attribution += 1;
      continue;
    }
    const outcome = aggregateAttributionRows(attrRows);

    const promoter = promotedByJobId.get(jobId);
    const reason =
      `Attributed outcome for promoted creative — publish job ${jobId.slice(0, 8)} → Meta ad ${job.meta_ad_id} ` +
      `over ${attributionWindowDays}d: spend $${(outcome.spend_cents / 100).toFixed(2)}, sessions ${outcome.sessions}` +
      (outcome.roas !== null ? `, ROAS ${outcome.roas}` : ", ROAS n/a (no spend)");
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "growth",
      actionKind: ATTRIBUTED_CREATIVE_OUTCOME_KIND,
      specSlug: promoter?.spec_slug ?? null,
      reason,
      metadata: {
        ad_publish_jobs_id: jobId,
        meta_ad_id: job.meta_ad_id,
        meta_account_id: job.meta_account_id,
        attribution_window_days: attributionWindowDays,
        snapshot_date: snapshotDate,
        publish_day: publishDay,
        outcome,
        autonomous: true,
      },
    });
    result.attributed += 1;
  }

  return result;
}
