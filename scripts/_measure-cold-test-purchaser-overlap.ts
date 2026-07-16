/**
 * _measure-cold-test-purchaser-overlap — Phase 1 of
 * [[../docs/brain/specs/bianca-measure-cold-test-purchaser-overlap]].
 *
 * The M2 measurement that gates the goal
 * [[../docs/brain/goals/bianca-temperature-aware-campaign-structure]] M2 —
 * "Purchaser hygiene (gated on a 1-hour measurement)". Without this number,
 * the recent-purchaser exclusion cannot be defended (the goal's
 * verify-scale-numbers rule refuses to ship an exclusion on a paper 40-50%
 * estimate). This one-shot enumerates every ACTIVE per-test cohort
 * ([[../docs/brain/tables/media_buyer_test_cohorts]] adset_per_test=true
 * AND is_active=true), cross-references the ads spending under the cohort's
 * test_meta_campaign_id with the customers who purchased BEFORE their first
 * Meta-attributed cold-test click, and writes ONE
 * `media_buyer_purchaser_overlap_measured`
 * [[../docs/brain/tables/director_activity]] row per cohort carrying the
 * cited overlap ratio + verdict.
 *
 * The read plan (per cohort):
 *   1. Resolve meta_ad_ids whose parent adset lives under
 *      cohort.test_meta_campaign_id (meta_ads.meta_campaign_id = cohort.test_meta_campaign_id).
 *   2. Sum attributed_spend_cents from meta_attribution_daily for those
 *      meta_ad_ids over the last N days (default 30, --window flag).
 *   3. Resolve the DISTINCT customer_id set that clicked one of those ads:
 *      primary source is storefront_events (customer_id NOT NULL, event_type
 *      IN ['pdp_view','pdp_engaged','checkout_view','order_placed'], utm_content
 *      matching a meta_ad_id in `meta->>utm_content` OR `url ILIKE ...`).
 *      Belt-and-suspenders: orders with attributed_utm_content = meta_ad_id.
 *   4. For each such customer_id, expand linked_ids via
 *      public.resolve_customer_link_group (same RPC customer-timeline uses) and
 *      check whether ANY order (customer_id IN linked_ids AND created_at <
 *      first_click_at) exists — that customer counts as a prior_purchaser.
 *   5. Sum attributed_spend_cents for the ads whose clickers were
 *      prior_purchasers (proxy for leaked spend).
 *
 * Idempotency: before insert, read the newest director_activity row for
 * (workspace_id, cohort_id, action_kind='media_buyer_purchaser_overlap_measured')
 * and skip if same UTC day.
 *
 * Dry-run by default. Pass `--apply` (or APPLY=1) to write the audit row(s).
 *
 * Run:
 *   npx tsx scripts/_measure-cold-test-purchaser-overlap.ts [--window 30] [--apply]
 *   npx tsx scripts/_measure-cold-test-purchaser-overlap.ts --workspace <uuid>
 *
 * READ-ONLY except for the audit-row insert gated behind --apply.
 */
import { createAdminClient } from "./_bootstrap";
import { recordDirectorActivity } from "../src/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

const OVERLAP_ACTION_KIND = "media_buyer_purchaser_overlap_measured";
const GROWTH_FUNCTION = "growth";
/** The goal's verify-scale-numbers rule: ship the exclusion only when overlap ≥ 15%. */
const PROCEED_THRESHOLD = 0.15;

interface Args {
  windowDays: number;
  apply: boolean;
  workspaceFilter: string | null;
}

function parseArgs(argv: string[]): Args {
  let windowDays = 30;
  let apply = process.env.APPLY === "1";
  let workspaceFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--window" && argv[i + 1]) windowDays = Number(argv[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--workspace" && argv[i + 1]) workspaceFilter = argv[++i];
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`--window must be a positive number, got ${windowDays}`);
    process.exit(2);
  }
  return { windowDays, apply, workspaceFilter };
}

interface CohortRow {
  id: string;
  workspace_id: string;
  test_meta_campaign_id: string;
}

async function loadActivePerTestCohorts(admin: Admin, workspaceFilter: string | null): Promise<CohortRow[]> {
  let q = admin
    .from("media_buyer_test_cohorts")
    .select("id, workspace_id, test_meta_campaign_id")
    .eq("adset_per_test", true)
    .eq("is_active", true)
    .not("test_meta_campaign_id", "is", null);
  if (workspaceFilter) q = q.eq("workspace_id", workspaceFilter);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as CohortRow[]).filter((r) => !!r.test_meta_campaign_id);
}

/** meta_ads under the cohort's testing campaign — the ad-grain set the measurement scopes over. */
async function loadMetaAdIdsForCampaign(
  admin: Admin,
  workspaceId: string,
  metaCampaignId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("meta_ads")
    .select("meta_ad_id")
    .eq("workspace_id", workspaceId)
    .eq("meta_campaign_id", metaCampaignId);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of (data ?? []) as { meta_ad_id: string }[]) {
    if (row.meta_ad_id) set.add(row.meta_ad_id);
  }
  return Array.from(set);
}

/** attributed spend per (meta_ad_id) over the window, summed across all variants + days. */
async function loadSpendPerAd(
  admin: Admin,
  workspaceId: string,
  metaAdIds: string[],
  windowDays: number,
): Promise<Map<string, number>> {
  const spend = new Map<string, number>();
  if (metaAdIds.length === 0) return spend;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString().slice(0, 10);
  const chunkSize = 200;
  for (let i = 0; i < metaAdIds.length; i += chunkSize) {
    const slice = metaAdIds.slice(i, i + chunkSize);
    const { data, error } = await admin
      .from("meta_attribution_daily")
      .select("meta_ad_id, attributed_spend_cents")
      .eq("workspace_id", workspaceId)
      .in("meta_ad_id", slice)
      .gte("snapshot_date", sinceDate);
    if (error) throw error;
    for (const row of (data ?? []) as { meta_ad_id: string; attributed_spend_cents: number | null }[]) {
      const prev = spend.get(row.meta_ad_id) ?? 0;
      spend.set(row.meta_ad_id, prev + Number(row.attributed_spend_cents ?? 0));
    }
  }
  return spend;
}

interface ClickerRow {
  customerId: string;
  metaAdId: string;
  firstClickAt: string;
}

/** DISTINCT clicker set per meta_ad_id, resolved to a customer_id + first-click timestamp. */
async function loadClickers(
  admin: Admin,
  workspaceId: string,
  metaAdIds: string[],
  windowDays: number,
): Promise<ClickerRow[]> {
  const rows: ClickerRow[] = [];
  if (metaAdIds.length === 0) return rows;
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Primary source: storefront_events. Loop per meta_ad_id so we can use the
  // dual predicate (meta->>utm_content = id OR url ILIKE '%utm_content=id%')
  // and PostgREST `.or()` cleanly per id.
  for (const metaAdId of metaAdIds) {
    const { data, error } = await admin
      .from("storefront_events")
      .select("customer_id, created_at")
      .eq("workspace_id", workspaceId)
      .not("customer_id", "is", null)
      .gte("created_at", sinceIso)
      .or(`meta->>utm_content.eq.${metaAdId},url.ilike.%utm_content=${metaAdId}%`)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (error) {
      console.warn(`[measure-cold-test-purchaser-overlap] storefront_events read failed for ${metaAdId}:`, error.message);
      continue;
    }
    const firstPerCustomer = new Map<string, string>();
    for (const row of (data ?? []) as { customer_id: string; created_at: string }[]) {
      if (!row.customer_id) continue;
      if (!firstPerCustomer.has(row.customer_id)) firstPerCustomer.set(row.customer_id, row.created_at);
    }
    for (const [customerId, firstClickAt] of firstPerCustomer) {
      rows.push({ customerId, metaAdId, firstClickAt });
    }
  }

  // Belt-and-suspenders fallback: orders.attributed_utm_content — captures a
  // conversion whose click never landed in storefront_events (a paid-social
  // link that skipped the pixel, or a mid-funnel session that dropped its
  // storefront_sessions row).
  const chunkSize = 200;
  for (let i = 0; i < metaAdIds.length; i += chunkSize) {
    const slice = metaAdIds.slice(i, i + chunkSize);
    const { data, error } = await admin
      .from("orders")
      .select("customer_id, attributed_utm_content, created_at")
      .eq("workspace_id", workspaceId)
      .in("attributed_utm_content", slice)
      .not("customer_id", "is", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn(`[measure-cold-test-purchaser-overlap] orders fallback read failed:`, error.message);
      continue;
    }
    const seen = new Set<string>();
    for (const row of rows) seen.add(`${row.metaAdId}:${row.customerId}`);
    for (const row of (data ?? []) as {
      customer_id: string;
      attributed_utm_content: string;
      created_at: string;
    }[]) {
      const key = `${row.attributed_utm_content}:${row.customer_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        customerId: row.customer_id,
        metaAdId: row.attributed_utm_content,
        firstClickAt: row.created_at,
      });
    }
  }
  return rows;
}

/** Expand a customer_id to the full link group via the same RPC the customer-timeline reads. */
async function resolveLinkedIds(admin: Admin, customerId: string): Promise<string[]> {
  const { data } = await admin.rpc("resolve_customer_link_group", { p_customer_id: customerId });
  return Array.isArray(data) && data.length > 0 ? (data as string[]) : [customerId];
}

/** Did ANY linked-group customer place an order before the cited click? */
async function hasPriorPurchase(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  firstClickAt: string,
): Promise<boolean> {
  const linkedIds = await resolveLinkedIds(admin, customerId);
  const { data, error } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .lt("created_at", firstClickAt)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Newest overlap-measurement row for this cohort, or null. */
async function readLatestOverlapAudit(
  admin: Admin,
  workspaceId: string,
  cohortId: string,
): Promise<{ created_at: string } | null> {
  const { data } = await admin
    .from("director_activity")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .eq("action_kind", OVERLAP_ACTION_KIND)
    .contains("metadata", { cohort_id: cohortId })
    .order("created_at", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as { created_at: string }[];
  return rows[0] ?? null;
}

function sameUtcDay(a: string | null, bMs: number): boolean {
  if (!a) return false;
  return a.slice(0, 10) === new Date(bMs).toISOString().slice(0, 10);
}

interface CohortReport {
  workspaceId: string;
  cohortId: string;
  windowDays: number;
  distinctClickers: number;
  priorPurchasers: number;
  overlapRatio: number;
  spendCentsTotal: number;
  spendCentsAllocatedToPriorPurchasers: number;
  verdict: "proceed" | "defer";
  skipped: "same_day" | "no_ads" | "no_clickers" | null;
}

async function measureCohort(
  admin: Admin,
  cohort: CohortRow,
  windowDays: number,
  apply: boolean,
): Promise<CohortReport> {
  const nowMs = Date.now();
  const existing = await readLatestOverlapAudit(admin, cohort.workspace_id, cohort.id);
  if (existing && sameUtcDay(existing.created_at, nowMs)) {
    return {
      workspaceId: cohort.workspace_id,
      cohortId: cohort.id,
      windowDays,
      distinctClickers: 0,
      priorPurchasers: 0,
      overlapRatio: 0,
      spendCentsTotal: 0,
      spendCentsAllocatedToPriorPurchasers: 0,
      verdict: "defer",
      skipped: "same_day",
    };
  }

  const metaAdIds = await loadMetaAdIdsForCampaign(admin, cohort.workspace_id, cohort.test_meta_campaign_id);
  const spendPerAd = await loadSpendPerAd(admin, cohort.workspace_id, metaAdIds, windowDays);
  const spendCentsTotal = Array.from(spendPerAd.values()).reduce((a, b) => a + b, 0);

  if (metaAdIds.length === 0) {
    return {
      workspaceId: cohort.workspace_id,
      cohortId: cohort.id,
      windowDays,
      distinctClickers: 0,
      priorPurchasers: 0,
      overlapRatio: 0,
      spendCentsTotal: 0,
      spendCentsAllocatedToPriorPurchasers: 0,
      verdict: "defer",
      skipped: "no_ads",
    };
  }

  const clickers = await loadClickers(admin, cohort.workspace_id, metaAdIds, windowDays);
  const distinctClickerIds = new Set(clickers.map((c) => c.customerId));
  const distinctClickers = distinctClickerIds.size;

  // Prior-purchaser flag per customer_id (cache across per-ad rows for the same customer).
  const priorFlagByCustomer = new Map<string, boolean>();
  let priorPurchasers = 0;
  let spendCentsAllocatedToPriorPurchasers = 0;
  const contaminatedAdIds = new Set<string>();
  for (const c of clickers) {
    let flag = priorFlagByCustomer.get(c.customerId);
    if (flag === undefined) {
      flag = await hasPriorPurchase(admin, cohort.workspace_id, c.customerId, c.firstClickAt);
      priorFlagByCustomer.set(c.customerId, flag);
      if (flag) priorPurchasers++;
    }
    if (flag) contaminatedAdIds.add(c.metaAdId);
  }
  for (const adId of contaminatedAdIds) {
    spendCentsAllocatedToPriorPurchasers += spendPerAd.get(adId) ?? 0;
  }

  const overlapRatio = distinctClickers > 0 ? priorPurchasers / distinctClickers : 0;
  const verdict: "proceed" | "defer" = overlapRatio >= PROCEED_THRESHOLD ? "proceed" : "defer";

  const report: CohortReport = {
    workspaceId: cohort.workspace_id,
    cohortId: cohort.id,
    windowDays,
    distinctClickers,
    priorPurchasers,
    overlapRatio,
    spendCentsTotal,
    spendCentsAllocatedToPriorPurchasers,
    verdict,
    skipped: distinctClickers === 0 ? "no_clickers" : null,
  };

  if (apply && report.skipped !== "same_day") {
    const pct = (overlapRatio * 100).toFixed(1);
    const { recorded, reason } = await recordDirectorActivity(admin, {
      workspaceId: cohort.workspace_id,
      directorFunction: GROWTH_FUNCTION,
      actionKind: OVERLAP_ACTION_KIND,
      reason: `M2 measurement — ${pct}% of cold-test clickers are prior purchasers over ${windowDays}d`,
      metadata: {
        cohort_id: cohort.id,
        window_days: windowDays,
        distinct_clickers: distinctClickers,
        prior_purchasers: priorPurchasers,
        overlap_ratio: overlapRatio,
        spend_cents_total: spendCentsTotal,
        spend_cents_allocated_to_prior_purchasers: spendCentsAllocatedToPriorPurchasers,
        verdict,
        autonomous: true,
      },
    });
    if (!recorded) {
      console.warn(`[measure-cold-test-purchaser-overlap] insert failed for cohort ${cohort.id}: ${reason ?? "unknown"}`);
    }
  }

  return report;
}

function formatReport(r: CohortReport): string {
  const pct = (r.overlapRatio * 100).toFixed(1);
  const dollars = (n: number): string => `$${(n / 100).toFixed(0)}`;
  const skipTag = r.skipped ? ` [skipped: ${r.skipped}]` : "";
  return (
    `  cohort=${r.cohortId} workspace=${r.workspaceId} ` +
    `window=${r.windowDays}d clickers=${r.distinctClickers} prior=${r.priorPurchasers} ` +
    `overlap=${pct}% spend=${dollars(r.spendCentsTotal)} ` +
    `leak=${dollars(r.spendCentsAllocatedToPriorPurchasers)} verdict=${r.verdict}${skipTag}`
  );
}

async function main(): Promise<void> {
  const { windowDays, apply, workspaceFilter } = parseArgs(process.argv.slice(2));
  const admin = createAdminClient();

  console.log("── cold-test purchaser overlap measurement ──");
  console.log(`window        : ${windowDays}d`);
  console.log(`mode          : ${apply ? "APPLY (writes audit rows)" : "dry-run (no writes)"}`);
  if (workspaceFilter) console.log(`workspace     : ${workspaceFilter}`);

  const cohorts = await loadActivePerTestCohorts(admin, workspaceFilter);
  console.log(`active per-test cohorts : ${cohorts.length}`);
  if (cohorts.length === 0) {
    console.log("  (no active per-test cohorts with a testing campaign — nothing to measure)");
    return;
  }

  const reports: CohortReport[] = [];
  for (const cohort of cohorts) {
    try {
      const r = await measureCohort(admin, cohort, windowDays, apply);
      reports.push(r);
      console.log(formatReport(r));
    } catch (err) {
      console.error(
        `[measure-cold-test-purchaser-overlap] cohort ${cohort.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const proceed = reports.filter((r) => !r.skipped && r.verdict === "proceed").length;
  const defer = reports.filter((r) => !r.skipped && r.verdict === "defer").length;
  const skipped = reports.filter((r) => r.skipped).length;
  console.log("── summary ──");
  console.log(`  proceed (overlap ≥ ${(PROCEED_THRESHOLD * 100).toFixed(0)}%) : ${proceed}`);
  console.log(`  defer   (overlap < ${(PROCEED_THRESHOLD * 100).toFixed(0)}%) : ${defer}`);
  console.log(`  skipped                       : ${skipped}`);
}

main().catch((err) => {
  console.error("_measure-cold-test-purchaser-overlap failed:", err);
  process.exit(1);
});
