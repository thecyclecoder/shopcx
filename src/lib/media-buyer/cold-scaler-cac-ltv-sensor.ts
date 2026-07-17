/**
 * media-buyer/cold-scaler-cac-ltv-sensor — Phase 2 of
 * [[../../../docs/brain/specs/bianca-cold-scaler-campaign-cac-ltv-sensor.md]]
 * (Bianca goal M4 "Bounded, supervised cold scaler gated on Dahlia winner
 * supply").
 *
 * The CAMPAIGN-SCOPED CAC:LTV sensor for the cold-scaler surface — the
 * missing grain between the per-creative ROAS grader
 * ([[media-buyer-grader]]) and the workspace-blended composer
 * ([[../blended-cac-ltv]]). One row per `(workspace, cold_scaler_cohort,
 * iso_week)` persists the numerator (blended LTV cents), denominator
 * (scaler-scope spend + new-customer count from [[meta_attribution_daily]]
 * filtered to the scaler campaign's `meta_ad_id` set), the derived
 * `cacLtvRatio` + `paybackDays`, the band (`red`|`yellow`|`green`|`unknown`),
 * and the human-readable `flags` carried over from `blendedCacLtvFromTotals`
 * so a red band shows WHY without re-derivation.
 *
 * The row is the durable, cite-able artifact the M4 arming gate reads (via
 * `readLatestColdScalerCacLtvSnapshot`) + the CEO grades against. Distinct
 * from [[media_buyer_cold_scaler_arming_authorization]] which pins the
 * shadow→armed authorization decision; this pins the CAC:LTV NUMBER the
 * authorization consumes.
 *
 * Delegates the math to the shared `blendedCacLtvFromTotals` composer
 * (single source of truth for the CAC:LTV formula, per the CLAUDE.md
 * "raw .from(...) STOP → SDK" principle applied to composers). The band
 * boundaries are the only sensor-local decision: green ≥ target, yellow ≥
 * `COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER × target` and < target, red below,
 * unknown when ratio is null.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  blendedCacLtvFromTotals,
  computeBlendedCacLtv,
  DEFAULT_BLENDED_CAC_LTV_TARGET,
} from "@/lib/blended-cac-ltv";
import { getMediaBuyerColdScalerCohortById } from "./cold-scaler-cohort";

type Admin = ReturnType<typeof createAdminClient>;

/** The Growth director's function slug — mirrors the sibling arming gate. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The spec slug this sensor implements — surfaced on every director_activity row. */
const COLD_SCALER_CAC_LTV_SENSOR_SPEC_SLUG =
  "bianca-cold-scaler-campaign-cac-ltv-sensor";

/** Default green floor — a healthy DTC scaler runs LTV ≥ target × CAC. Same 3× floor
 *  as [[../blended-cac-ltv]]'s `DEFAULT_BLENDED_CAC_LTV_TARGET`. */
export const COLD_SCALER_CAC_LTV_GREEN_MIN = DEFAULT_BLENDED_CAC_LTV_TARGET;

/** Yellow floor MULTIPLIER of the target — a ratio ≥ `0.7 × target` (and < target)
 *  is warning-band; below is red. Kept as a fraction so the same relative buffer
 *  applies when a caller lowers the target. */
export const COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER = 0.7;

/** Days in one ISO week — the snapshot's sample window (matches
 *  [[../../../docs/brain/tables/media_buyer_cold_scaler_cac_ltv_snapshots]]
 *  `iso_week` column). */
const ISO_WEEK_DAYS = 7;

/** Snapshot band vocabulary — mirrors the check-constrained `band` column on
 *  [[../../../docs/brain/tables/media_buyer_cold_scaler_cac_ltv_snapshots]]. */
export type ColdScalerCacLtvBand = "red" | "yellow" | "green" | "unknown";

/** The pure-sensor output shape — one row's worth of numbers ready to persist. */
export interface ColdScalerCacLtvSnapshot {
  spendCents: number;
  newCustomers: number;
  revenueCents: number;
  ltvCents: number;
  cacLtvRatio: number | null;
  paybackDays: number | null;
  band: ColdScalerCacLtvBand;
  flags: string[];
}

export interface ComputeColdScalerCacLtvSnapshotInput {
  spendCents: number;
  newCustomers: number;
  revenueCents: number;
  ltvCents: number;
  /** Overrides `COLD_SCALER_CAC_LTV_GREEN_MIN` (which is
   *  `DEFAULT_BLENDED_CAC_LTV_TARGET`). */
  target?: number;
  /** Extra flags forwarded to the composer (e.g. "no meta_ads found",
   *  "mixed Amazon-halo attribution") — surfaced verbatim on the snapshot's
   *  `flags` column so a red band shows WHY. */
  flags?: string[];
  /** Sample window in days — defaults to one ISO week (`7`). Only affects
   *  the payback-days extrapolation inside `blendedCacLtvFromTotals`. */
  windowDays?: number;
}

/**
 * PURE — the sensor's math step. Delegates the ratio + payback derivation to
 * the shared `blendedCacLtvFromTotals` composer, then maps the derived ratio
 * to a band via the boundary constants. Unit tests pin each band by feeding
 * fixture ratios — no DB, no side effects.
 */
export function computeColdScalerCacLtvSnapshot(
  input: ComputeColdScalerCacLtvSnapshotInput,
): ColdScalerCacLtvSnapshot {
  const target = input.target ?? COLD_SCALER_CAC_LTV_GREEN_MIN;
  const windowDays = input.windowDays ?? ISO_WEEK_DAYS;

  const blended = blendedCacLtvFromTotals({
    blendedSpendCents: input.spendCents,
    blendedRevenueCents: input.revenueCents,
    blendedNewCustomers: input.newCustomers,
    blendedLtvCents: input.ltvCents,
    windowDays,
    creditAmazonHalo: true,
    countAllNonRenewal: true,
    targetCacLtv: target,
    extraFlags: input.flags,
  });

  return {
    spendCents: input.spendCents,
    newCustomers: input.newCustomers,
    revenueCents: input.revenueCents,
    ltvCents: input.ltvCents,
    cacLtvRatio: blended.cacLtvRatio,
    paybackDays: blended.paybackDays,
    band: ratioToBand(blended.cacLtvRatio, target),
    flags: blended.flags,
  };
}

/** Map a `cacLtvRatio` (or null) to the snapshot band. Exported for tests +
 *  for any surface that has a bare ratio and needs the same band label. */
export function ratioToBand(
  ratio: number | null,
  target: number = COLD_SCALER_CAC_LTV_GREEN_MIN,
): ColdScalerCacLtvBand {
  if (ratio === null) return "unknown";
  if (ratio >= target) return "green";
  if (ratio >= COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER * target) return "yellow";
  return "red";
}

// ── ISO-week window helper ────────────────────────────────────────────────────

/**
 * ISO 8601 week label (`YYYY-Www`) → inclusive `[startDate, endDate]` for a
 * Mon..Sun week. Mirrors [[cold-scaler-arming-gate]] `isoWeekLabel`'s
 * convention (Thursday-based year, ISO week 1 = week of Jan 4). Exported so
 * the sensor tests can pin the parse without re-invoking the orchestrator.
 */
export function isoWeekWindow(isoWeek: string): { startDate: string; endDate: string } {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) {
    throw new Error(`Invalid ISO-week label: ${isoWeek} (expected YYYY-Www)`);
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  // ISO week 1 contains the first Thursday of the year. Its Monday is week-1's start.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7; // 1..7 (Mon=1)
  const week1Monday = jan4 - (jan4Day - 1) * 86_400_000;
  const monday = week1Monday + (week - 1) * 7 * 86_400_000;
  const sunday = monday + 6 * 86_400_000;
  return {
    startDate: new Date(monday).toISOString().slice(0, 10),
    endDate: new Date(sunday).toISOString().slice(0, 10),
  };
}

// ── DB-touching orchestrator ──────────────────────────────────────────────────

/** Signature of the LTV-numerator computer the orchestrator invokes.
 *  Exposed as an injectable seam so the in-memory orchestrator round-trip
 *  test can pin the LTV without spinning up `computeBlendedCacLtv`'s upstream
 *  data-layer (mapped groups, on-site + Amazon revenue, LTV proxy). */
export type ColdScalerLtvComputer = (
  admin: Admin,
  args: { workspaceId: string; isoWeek: string; target: number; flags: string[] },
) => Promise<number>;

export interface RunColdScalerCacLtvSensorInput {
  workspaceId: string;
  coldScalerCohortId: string;
  isoWeek: string;
  /** Overrides `COLD_SCALER_CAC_LTV_GREEN_MIN`. */
  target?: number;
  /** Injected clock — tests pin `evaluated_at`. */
  now?: Date;
  /** Test seam — override the LTV-numerator computer. Defaults to
   *  `computeScalerLtvNumeratorCents` (which delegates to
   *  [[../blended-cac-ltv]] `computeBlendedCacLtv`). Production callers omit
   *  this. */
  computeLtvCents?: ColdScalerLtvComputer;
}

export interface RunColdScalerCacLtvSensorResult {
  snapshotId: string | null;
  band: ColdScalerCacLtvBand;
  cacLtvRatio: number | null;
  spendCents: number;
  ltvCents: number;
}

/**
 * The DB-touching orchestrator. Resolves the scaler's `meta_ad_id` set
 * (cohort → `scaler_meta_campaign_id` → [[meta_adsets]] → [[meta_ads]]),
 * aggregates `attributed_spend_cents` + `revenue_cents` + `orders` from
 * [[meta_attribution_daily]] over the ISO-week window, blends per-product
 * LTV via [[../blended-cac-ltv]] `computeBlendedCacLtv` (LTV numerator only
 * — the ratio + band come from the pure sensor over the scaler-scope
 * spend/revenue/customers), calls `computeColdScalerCacLtvSnapshot`, upserts
 * one snapshot row keyed by `(workspace, cohort, iso_week)`, and stamps a
 * best-effort `director_activity` row so the Growth digest + grader can
 * cite the number without re-derivation.
 */
export async function runColdScalerCacLtvSensor(
  admin: Admin,
  input: RunColdScalerCacLtvSensorInput,
): Promise<RunColdScalerCacLtvSensorResult> {
  const target = input.target ?? COLD_SCALER_CAC_LTV_GREEN_MIN;
  const now = input.now ?? new Date();
  const flags: string[] = [];

  const cohort = await getMediaBuyerColdScalerCohortById(admin, {
    workspaceId: input.workspaceId,
    id: input.coldScalerCohortId,
  });

  let spendCents = 0;
  let revenueCents = 0;
  let newCustomers = 0;

  if (!cohort) {
    flags.push(`cohort ${input.coldScalerCohortId} not found or inactive`);
  } else if (!cohort.scalerMetaCampaignId) {
    flags.push(
      `cohort ${input.coldScalerCohortId} has no scaler_meta_campaign_id — nothing to sense yet`,
    );
  } else {
    const totals = await aggregateScalerCampaignTotals(admin, {
      workspaceId: input.workspaceId,
      scalerMetaCampaignId: cohort.scalerMetaCampaignId,
      isoWeek: input.isoWeek,
    });
    spendCents = totals.spendCents;
    revenueCents = totals.revenueCents;
    newCustomers = totals.newCustomers;
    for (const f of totals.flags) flags.push(f);
  }

  const ltvComputer = input.computeLtvCents ?? computeScalerLtvNumeratorCents;
  const ltvCents = await ltvComputer(admin, {
    workspaceId: input.workspaceId,
    isoWeek: input.isoWeek,
    target,
    flags,
  });

  const snapshot = computeColdScalerCacLtvSnapshot({
    spendCents,
    newCustomers,
    revenueCents,
    ltvCents,
    target,
    flags,
  });

  const snapshotId = await upsertColdScalerCacLtvSnapshot(admin, {
    workspaceId: input.workspaceId,
    metaAdAccountId: cohort?.metaAdAccountId ?? null,
    coldScalerCohortId: input.coldScalerCohortId,
    isoWeek: input.isoWeek,
    snapshot,
    evaluatedAt: now.toISOString(),
  });

  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_cold_scaler_cac_ltv_snapshot_written",
    specSlug: COLD_SCALER_CAC_LTV_SENSOR_SPEC_SLUG,
    reason: `Cold-scaler CAC:LTV snapshot for cohort ${input.coldScalerCohortId} (${input.isoWeek}) — band ${snapshot.band}, cacLtvRatio ${snapshot.cacLtvRatio ?? "null"}`,
    metadata: {
      cohort_id: input.coldScalerCohortId,
      iso_week: input.isoWeek,
      band: snapshot.band,
      cac_ltv_ratio: snapshot.cacLtvRatio,
      spend_cents: snapshot.spendCents,
      ltv_cents: snapshot.ltvCents,
      autonomous: true,
    },
  });

  return {
    snapshotId,
    band: snapshot.band,
    cacLtvRatio: snapshot.cacLtvRatio,
    spendCents: snapshot.spendCents,
    ltvCents: snapshot.ltvCents,
  };
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

interface ScalerCampaignTotals {
  spendCents: number;
  revenueCents: number;
  newCustomers: number;
  flags: string[];
}

/**
 * Resolve the scaler's `meta_ad_id` set (adsets under `scaler_meta_campaign_id`
 * → their child ads) and sum `attributed_spend_cents` + `revenue_cents` +
 * `orders` from [[meta_attribution_daily]] over the ISO-week window. Returns
 * zeroes + a flag when the campaign has no adsets/ads yet (a freshly-created
 * scaler campaign, mid-ingest) — the sensor then lands `band='unknown'` with
 * the flag surfaced.
 */
async function aggregateScalerCampaignTotals(
  admin: Admin,
  args: { workspaceId: string; scalerMetaCampaignId: string; isoWeek: string },
): Promise<ScalerCampaignTotals> {
  const flags: string[] = [];
  const { data: adsets, error: adsetErr } = await admin
    .from("meta_adsets")
    .select("meta_adset_id")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_campaign_id", args.scalerMetaCampaignId);
  if (adsetErr) {
    console.warn(
      `[cold-scaler-cac-ltv-sensor] meta_adsets read failed: ${adsetErr.message}`,
    );
    return { spendCents: 0, revenueCents: 0, newCustomers: 0, flags: [adsetErr.message] };
  }
  const adsetIds = ((adsets ?? []) as Array<{ meta_adset_id: string }>)
    .map((r) => r.meta_adset_id)
    .filter(Boolean);
  if (!adsetIds.length) {
    flags.push(
      `no meta_adsets found under scaler_meta_campaign_id ${args.scalerMetaCampaignId} — cannot sense yet`,
    );
    return { spendCents: 0, revenueCents: 0, newCustomers: 0, flags };
  }

  const { data: ads, error: adErr } = await admin
    .from("meta_ads")
    .select("meta_ad_id")
    .eq("workspace_id", args.workspaceId)
    .in("meta_adset_id", adsetIds);
  if (adErr) {
    console.warn(`[cold-scaler-cac-ltv-sensor] meta_ads read failed: ${adErr.message}`);
    return { spendCents: 0, revenueCents: 0, newCustomers: 0, flags: [adErr.message] };
  }
  const metaAdIds = ((ads ?? []) as Array<{ meta_ad_id: string }>)
    .map((r) => r.meta_ad_id)
    .filter(Boolean);
  if (!metaAdIds.length) {
    flags.push(
      `no meta_ads found under scaler_meta_campaign_id ${args.scalerMetaCampaignId} — cannot sense yet`,
    );
    return { spendCents: 0, revenueCents: 0, newCustomers: 0, flags };
  }

  const { startDate, endDate } = isoWeekWindow(args.isoWeek);
  const { data: rows, error: attrErr } = await admin
    .from("meta_attribution_daily")
    .select("attributed_spend_cents, revenue_cents, orders")
    .eq("workspace_id", args.workspaceId)
    .in("meta_ad_id", metaAdIds)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);
  if (attrErr) {
    console.warn(
      `[cold-scaler-cac-ltv-sensor] meta_attribution_daily read failed: ${attrErr.message}`,
    );
    return { spendCents: 0, revenueCents: 0, newCustomers: 0, flags: [attrErr.message] };
  }

  let spendCents = 0;
  let revenueCents = 0;
  let newCustomers = 0;
  const attrRows = (rows ?? []) as Array<{
    attributed_spend_cents: number | string | null;
    revenue_cents: number | string | null;
    orders: number | string | null;
  }>;
  for (const r of attrRows) {
    spendCents += toNumber(r.attributed_spend_cents);
    revenueCents += toNumber(r.revenue_cents);
    newCustomers += toNumber(r.orders);
  }
  return { spendCents, revenueCents, newCustomers, flags };
}

/**
 * The LTV numerator — revenue-weighted blended LTV across the products with
 * new-customer revenue in the ISO-week. Reuses [[../blended-cac-ltv]]
 * `computeBlendedCacLtv` (whose `blendedLtvCents` is exactly the composer's
 * per-product LTV blend) so the sensor and the workspace-blended composer
 * never disagree on the LTV formula. `flags` collects any `ltv:` diagnostics
 * so a red band shows WHY (missing mapping, uncalibrated proxy, …).
 */
async function computeScalerLtvNumeratorCents(
  admin: Admin,
  args: { workspaceId: string; isoWeek: string; target: number; flags: string[] },
): Promise<number> {
  void admin; // computeBlendedCacLtv resolves its own admin client
  try {
    const { startDate, endDate } = isoWeekWindow(args.isoWeek);
    const blended = await computeBlendedCacLtv({
      workspaceId: args.workspaceId,
      startDate,
      endDate,
      targetCacLtv: args.target,
    });
    for (const f of blended.flags) args.flags.push(`ltv: ${f}`);
    return blended.blendedLtvCents;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cold-scaler-cac-ltv-sensor] computeBlendedCacLtv threw: ${msg}`);
    args.flags.push(`ltv: composer threw — ${msg}`);
    return 0;
  }
}

// ── Upsert + reader ───────────────────────────────────────────────────────────

interface UpsertColdScalerCacLtvSnapshotArgs {
  workspaceId: string;
  metaAdAccountId: string | null;
  coldScalerCohortId: string;
  isoWeek: string;
  snapshot: ColdScalerCacLtvSnapshot;
  evaluatedAt: string;
}

/**
 * Upsert one `media_buyer_cold_scaler_cac_ltv_snapshots` row keyed by
 * `(workspace_id, cold_scaler_cohort_id, iso_week)`. Same select-then-write
 * compare-and-set pattern as [[cold-scaler-arming-gate]]
 * `upsertColdScalerAuthorization` — the unique index on those three columns
 * lets a re-evaluation within the same iso_week UPDATE in place instead of
 * inserting a duplicate.
 */
export async function upsertColdScalerCacLtvSnapshot(
  admin: Admin,
  args: UpsertColdScalerCacLtvSnapshotArgs,
): Promise<string | null> {
  const row = {
    workspace_id: args.workspaceId,
    meta_ad_account_id: args.metaAdAccountId,
    cold_scaler_cohort_id: args.coldScalerCohortId,
    iso_week: args.isoWeek,
    spend_cents: args.snapshot.spendCents,
    new_customers: args.snapshot.newCustomers,
    revenue_cents: args.snapshot.revenueCents,
    ltv_cents: args.snapshot.ltvCents,
    cac_ltv_ratio: args.snapshot.cacLtvRatio,
    payback_days: args.snapshot.paybackDays,
    band: args.snapshot.band,
    flags: args.snapshot.flags,
    evaluated_at: args.evaluatedAt,
  };

  const { data: existing, error: selErr } = await admin
    .from("media_buyer_cold_scaler_cac_ltv_snapshots")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("cold_scaler_cohort_id", args.coldScalerCohortId)
    .eq("iso_week", args.isoWeek)
    .maybeSingle();
  if (selErr) {
    console.warn(
      `[cold-scaler-cac-ltv-sensor] media_buyer_cold_scaler_cac_ltv_snapshots select failed: ${selErr.message}`,
    );
    return null;
  }

  if (existing && (existing as { id: string }).id) {
    const id = (existing as { id: string }).id;
    const { data: updated, error: updErr } = await admin
      .from("media_buyer_cold_scaler_cac_ltv_snapshots")
      .update({
        meta_ad_account_id: row.meta_ad_account_id,
        spend_cents: row.spend_cents,
        new_customers: row.new_customers,
        revenue_cents: row.revenue_cents,
        ltv_cents: row.ltv_cents,
        cac_ltv_ratio: row.cac_ltv_ratio,
        payback_days: row.payback_days,
        band: row.band,
        flags: row.flags,
        evaluated_at: row.evaluated_at,
      })
      .eq("id", id)
      .eq("workspace_id", args.workspaceId)
      .select("id");
    if (updErr) {
      console.warn(
        `[cold-scaler-cac-ltv-sensor] media_buyer_cold_scaler_cac_ltv_snapshots update failed: ${updErr.message}`,
      );
      return null;
    }
    return Array.isArray(updated) && updated.length === 1 ? id : null;
  }

  const { data: inserted, error: insErr } = await admin
    .from("media_buyer_cold_scaler_cac_ltv_snapshots")
    .insert(row)
    .select("id");
  if (insErr) {
    console.warn(
      `[cold-scaler-cac-ltv-sensor] media_buyer_cold_scaler_cac_ltv_snapshots insert failed: ${insErr.message}`,
    );
    return null;
  }
  const insertedRows = inserted as Array<{ id: string }> | null;
  return Array.isArray(insertedRows) && insertedRows.length === 1
    ? insertedRows[0].id
    : null;
}

// ── Reader (the arming-gate consumer chokepoint) ──────────────────────────────

export interface ReadLatestColdScalerCacLtvSnapshotInput {
  workspaceId: string;
  coldScalerCohortId: string;
}

/** The TS shape returned by the reader — snake→camel + bigint-string→number. */
export interface ColdScalerCacLtvSnapshotRow {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  coldScalerCohortId: string;
  isoWeek: string;
  spendCents: number;
  newCustomers: number;
  revenueCents: number;
  ltvCents: number;
  cacLtvRatio: number | null;
  paybackDays: number | null;
  band: ColdScalerCacLtvBand;
  flags: string[];
  evaluatedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ColdScalerCacLtvSnapshotDbRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  cold_scaler_cohort_id: string;
  iso_week: string;
  spend_cents: number | string;
  new_customers: number | string;
  revenue_cents: number | string;
  ltv_cents: number | string;
  cac_ltv_ratio: number | string | null;
  payback_days: number | string | null;
  band: string;
  flags: unknown;
  evaluated_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns the newest `media_buyer_cold_scaler_cac_ltv_snapshots` row for
 * `(workspaceId, coldScalerCohortId)`, or `null`. This is the chokepoint the
 * [[cold-scaler-arming-gate]] consumes to prefer the campaign-scoped snapshot
 * over the workspace-blended composer. `null` means "no snapshot yet" and the
 * arming gate falls through to `computeBlendedCacLtv` — same denial-branch
 * shape (`cac_ltv_below_target` / `cac_ltv_unknown`) works either way.
 */
export async function readLatestColdScalerCacLtvSnapshot(
  admin: Admin,
  input: ReadLatestColdScalerCacLtvSnapshotInput,
): Promise<ColdScalerCacLtvSnapshotRow | null> {
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cac_ltv_snapshots")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("cold_scaler_cohort_id", input.coldScalerCohortId)
    .order("evaluated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(
      `[cold-scaler-cac-ltv-sensor] readLatestColdScalerCacLtvSnapshot failed: ${error.message}`,
    );
    return null;
  }
  if (!data) return null;
  return toSnapshotRow(data as ColdScalerCacLtvSnapshotDbRow);
}

function toSnapshotRow(row: ColdScalerCacLtvSnapshotDbRow): ColdScalerCacLtvSnapshotRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    coldScalerCohortId: row.cold_scaler_cohort_id,
    isoWeek: row.iso_week,
    spendCents: toNumber(row.spend_cents),
    newCustomers: toNumber(row.new_customers),
    revenueCents: toNumber(row.revenue_cents),
    ltvCents: toNumber(row.ltv_cents),
    cacLtvRatio: row.cac_ltv_ratio === null ? null : toNumber(row.cac_ltv_ratio),
    paybackDays: row.payback_days === null ? null : toNumber(row.payback_days),
    band: normalizeBand(row.band),
    flags: Array.isArray(row.flags) ? (row.flags as string[]) : [],
    evaluatedAt: row.evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeBand(band: string): ColdScalerCacLtvBand {
  return band === "red" || band === "yellow" || band === "green" || band === "unknown"
    ? band
    : "unknown";
}

function toNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "string" ? Number(v) : v;
}
