// Blended new-customer CAC↔LTV objective + payback window — Phase 1 of
// docs/brain/specs/growth-blended-cac-ltv-objective.md (M2 of docs/brain/goals/growth-director).
//
// The Growth Director's single TOP-LINE. Composes:
//   • predicted LTV per new customer from [[../libraries/storefront-ltv-proxy]] (the current
//     uncalibrated proxy — flagged via `assumptions.ltvProxyUncalibrated=true`)
//   • new-customer revenue + Meta spend in cents from [[../libraries/acquisition-roas]]
//     (including the Amazon halo per the group's `credit_amazon_to_meta` mapping)
// into ONE blended cacLtvRatio + paybackDays so the Director optimizes a single number instead
// of per-channel ROAS (the Goodhart guardrail the goal calls out — Phase 3 surfaces the
// per-channel do-NOT-cut finding).
//
// Margin-ROAS is a DECLARED dependency on CFO M1 COGS — until then `assumptions.marginRoasBlockedOnCogs=true`
// surfaces on the result (mirrors [[../libraries/storefront-optimizer-agent]] `computeModeledRenewalMargin`
// which still documents `cogs_source_missing=true` today). Declared, never blocked-on.
//
// Phase 2 wires this into [[../libraries/growth-report-contract]] as a MetricVsTarget row.

import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeAcqROAS,
  getProductAdAccountMapping,
  type AcqRoasResult,
  type ProductAdAccountMapping,
} from "@/lib/acquisition-roas";
import { getShopifyInternalNonRenewalRevenue } from "@/lib/shopify-internal-revenue";
import { getAmazonNonRenewalRevenue } from "@/lib/amazon/per-product-revenue";
import { estimateSubLTV } from "@/lib/storefront/ltv-proxy";

/** Default cacLtvRatio setpoint — a healthy DTC subscription business runs LTV ≥ 3× CAC. The goal's
 *  "CAC:LTV ratio … healthy and trending right" success metric uses this as the baseline. */
export const DEFAULT_BLENDED_CAC_LTV_TARGET = 3;

/** Versioned attribution / methodology assumptions surfaced on every result so a degenerate proxy-move
 *  (cutting a line on a single per-channel ROAS) is visible upstream. */
export interface BlendedCacLtvAssumptions {
  /** True while CFO M1 COGS hasn't landed — `computeModeledRenewalMargin` returns `cogs_source_missing=true`,
   *  so the LTV here is REVENUE-side and not contribution-margin LTV. Declared, never blocked-on. */
  marginRoasBlockedOnCogs: boolean;
  /** True until the storefront-ltv-proxy reconciler (Phase 3 of that spec) has recalibrated the
   *  proxy weights against actual 4-month cohort LTV. */
  ltvProxyUncalibrated: boolean;
  /** True when every measured group credits the Amazon halo to Meta in its mapping. */
  creditAmazonHalo: boolean;
  /** True when every measured group counts ALL non-renewal sales (not just utm_source=meta). */
  countAllNonRenewal: boolean;
  /** Payback extrapolates the in-window new-customer revenue rate forward — see the formula in
   *  `blendedCacLtvFromTotals`. */
  paybackUsesWindowRateExtrapolation: boolean;
  /** The cacLtvRatio setpoint used (or DEFAULT_BLENDED_CAC_LTV_TARGET). */
  targetCacLtv: number;
  /** The paybackDays setpoint (null when caller didn't set one). */
  targetPaybackDays: number | null;
}

export interface BlendedCacLtvResult {
  /** blendedLtvCents / CAC; null when no new customers or no LTV in the window. */
  cacLtvRatio: number | null;
  /** Days at the in-window new-customer revenue rate to recoup the blended CAC; null when revenue=0. */
  paybackDays: number | null;
  /** Σ mapped Meta spend × spend_share across measured groups. */
  blendedSpendCents: number;
  /** Σ non-renewal order count across measured groups (on-site + Amazon when credited). */
  blendedNewCustomers: number;
  /** Σ non-renewal new-customer revenue across measured groups (on-site + Amazon when credited). */
  blendedRevenueCents: number;
  /** Revenue-weighted product-level est_sub_ltv_cents from the storefront LTV proxy — predicted lifetime
   *  margin per new customer (treated as ≈ per-subscriber LTV under the v1 proxy; refined in M3). */
  blendedLtvCents: number;
  assumptions: BlendedCacLtvAssumptions;
  /** Human-readable caveats (no mapping, zero spend, mixed assumptions across groups, etc). */
  flags: string[];
}

/** Pure aggregate-to-metric step — split out so a unit test can assert the math on fixture totals
 *  without hitting the database. */
export interface BlendedCacLtvTotals {
  blendedSpendCents: number;
  blendedRevenueCents: number;
  blendedNewCustomers: number;
  blendedLtvCents: number;
  /** Days in the report window (inclusive). Used only by the payback extrapolation. */
  windowDays: number;
  /** Surfaced on the result `assumptions`. */
  creditAmazonHalo: boolean;
  countAllNonRenewal: boolean;
  /** Overrides DEFAULT_BLENDED_CAC_LTV_TARGET. */
  targetCacLtv?: number;
  targetPaybackDays?: number;
  /** Additional flags from the data layer (no-mapping, mixed assumptions, …). */
  extraFlags?: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure computation: given the aggregated totals + window length, emit the cacLtvRatio + paybackDays
 *  result. Tests pin the math here without needing a database. */
export function blendedCacLtvFromTotals(t: BlendedCacLtvTotals): BlendedCacLtvResult {
  const targetCacLtv = t.targetCacLtv ?? DEFAULT_BLENDED_CAC_LTV_TARGET;
  const targetPaybackDays = t.targetPaybackDays ?? null;
  const flags: string[] = [...(t.extraFlags ?? [])];

  const cacCents = t.blendedNewCustomers > 0 ? t.blendedSpendCents / t.blendedNewCustomers : null;

  const cacLtvRatio =
    cacCents !== null && cacCents > 0 && t.blendedLtvCents > 0
      ? round2(t.blendedLtvCents / cacCents)
      : null;

  // Payback at the in-window new-customer revenue rate, extrapolated:
  //   revenue_per_customer_per_day  =  revenue / customers / windowDays
  //   paybackDays                   =  CAC / revenue_per_customer_per_day
  //                                  =  spend × windowDays / revenue
  // Surfaced via `paybackUsesWindowRateExtrapolation`. Revenue-side, not margin-side (COGS deferred).
  const paybackDays =
    t.blendedRevenueCents > 0 && t.windowDays > 0
      ? Math.round((t.blendedSpendCents * t.windowDays) / t.blendedRevenueCents)
      : null;

  if (cacCents === null) flags.push("no new customers in window — CAC undefined");
  if (t.blendedLtvCents === 0) flags.push("LTV proxy returned 0 — likely insufficient subscription history");
  if (t.blendedSpendCents === 0) flags.push("zero mapped Meta spend in window — cacLtvRatio undefined");

  return {
    cacLtvRatio,
    paybackDays,
    blendedSpendCents: t.blendedSpendCents,
    blendedNewCustomers: t.blendedNewCustomers,
    blendedRevenueCents: t.blendedRevenueCents,
    blendedLtvCents: t.blendedLtvCents,
    assumptions: {
      marginRoasBlockedOnCogs: true,
      ltvProxyUncalibrated: true,
      creditAmazonHalo: t.creditAmazonHalo,
      countAllNonRenewal: t.countAllNonRenewal,
      paybackUsesWindowRateExtrapolation: true,
      targetCacLtv,
      targetPaybackDays,
    },
    flags,
  };
}

// ── Data-layer ─────────────────────────────────────────────────────────────────────────────────

export interface ComputeBlendedCacLtvParams {
  workspaceId: string;
  /** Inclusive YYYY-MM-DD (Central-time, matching AcqROAS snapshot boundaries). */
  startDate: string;
  endDate: string;
  /** Accepted for the report contract's week-over-week delta (Phase 2); the composer ignores them
   *  internally — the caller computes prior by re-invoking with the prior window. */
  priorStartDate?: string;
  priorEndDate?: string;
  /** cacLtvRatio setpoint; defaults to DEFAULT_BLENDED_CAC_LTV_TARGET (3×). */
  targetCacLtv?: number;
  /** paybackDays setpoint; surfaced on `assumptions.targetPaybackDays` (no default). */
  targetPaybackDays?: number;
  /** Restrict to specific linked-group ids; defaults to every group with an ad-account mapping. */
  groupIds?: string[];
}

function daysInclusive(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 1;
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

async function getMappedGroupIds(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_ad_account_mappings")
    .select("group_id")
    .eq("workspace_id", workspaceId);
  return Array.from(new Set((data || []).map((r) => r.group_id as string).filter(Boolean)));
}

async function getGroupProductIds(groupId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_link_members")
    .select("product_id")
    .eq("group_id", groupId);
  return (data || []).map((r) => r.product_id as string).filter(Boolean);
}

interface GroupAgg {
  groupId: string;
  productIds: string[];
  mappings: ProductAdAccountMapping[];
  acq: AcqRoasResult;
  newCustomers: number;
  /** Revenue per product_id within this group's window — drives LTV weighting. */
  byProductRevenueCents: Map<string, number>;
}

async function aggregateGroup(params: {
  workspaceId: string;
  groupId: string;
  startDate: string;
  endDate: string;
}): Promise<GroupAgg> {
  const { workspaceId, groupId, startDate, endDate } = params;
  const [mappings, productIds, acq] = await Promise.all([
    getProductAdAccountMapping({ workspaceId, groupId }),
    getGroupProductIds(groupId),
    computeAcqROAS({ workspaceId, groupId, startDate, endDate }),
  ]);

  // Mirror the per-group assumptions acquisition-roas applies so newCustomers + byProduct revenue
  // line up with acq.numeratorCents / acq.channelSplit (every non-renewal vs. utm-meta-only; Amazon halo).
  const creditAmazonToMeta = mappings.length ? mappings.every((m) => m.creditAmazonToMeta) : true;
  const countAllNonRenewal = mappings.length ? mappings.every((m) => m.countAllNonRenewal) : true;

  const [onsite, amazon] = await Promise.all([
    getShopifyInternalNonRenewalRevenue({
      workspaceId,
      productIds,
      startDate,
      endDate,
      metaOnlyUtm: !countAllNonRenewal,
    }),
    creditAmazonToMeta
      ? getAmazonNonRenewalRevenue({ workspaceId, productIds, startDate, endDate })
      : Promise.resolve({ grossCents: 0, netCents: 0, orderCount: 0, units: 0, byProduct: {} as Record<string, { grossCents: number; netCents: number; units: number; orderCount: number }> }),
  ]);

  const byProductRevenueCents = new Map<string, number>();
  for (const [pid, p] of Object.entries(onsite.byProduct)) {
    byProductRevenueCents.set(pid, (byProductRevenueCents.get(pid) ?? 0) + (p.grossCents || 0));
  }
  if (creditAmazonToMeta) {
    for (const [pid, p] of Object.entries(amazon.byProduct)) {
      byProductRevenueCents.set(pid, (byProductRevenueCents.get(pid) ?? 0) + (p.grossCents || 0));
    }
  }

  return {
    groupId,
    productIds,
    mappings,
    acq,
    newCustomers: (onsite.orderCount || 0) + (creditAmazonToMeta ? amazon.orderCount || 0 : 0),
    byProductRevenueCents,
  };
}

/** Resolve a per-customer LTV (the est_sub_ltv_cents from the storefront LTV proxy) for every
 *  product that has revenue in the window — weighted across products by their revenue share. */
async function computeBlendedLtvCents(
  workspaceId: string,
  byProductRevenueCents: Map<string, number>,
): Promise<number> {
  const products = [...byProductRevenueCents.entries()].filter(([, rev]) => rev > 0);
  if (products.length === 0) return 0;

  const estimates = await Promise.all(
    products.map(([productId]) => estimateSubLTV({ workspaceId, product_id: productId })),
  );

  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < products.length; i += 1) {
    const [, revenueCents] = products[i];
    const ltv = estimates[i].est_sub_ltv_cents;
    weightedSum += ltv * revenueCents;
    totalWeight += revenueCents;
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

/**
 * Blended new-customer CAC↔LTV objective + payback window for a workspace + report window. The
 * Growth Director's single top-line metric — see file header.
 */
export async function computeBlendedCacLtv(params: ComputeBlendedCacLtvParams): Promise<BlendedCacLtvResult> {
  const { workspaceId, startDate, endDate, targetCacLtv, targetPaybackDays } = params;
  const groupIds = params.groupIds?.length ? params.groupIds : await getMappedGroupIds(workspaceId);
  const flags: string[] = [];

  if (!groupIds.length) {
    flags.push("no product line has a Meta ad-account mapping — blended CAC:LTV cannot be reported");
    return blendedCacLtvFromTotals({
      blendedSpendCents: 0,
      blendedRevenueCents: 0,
      blendedNewCustomers: 0,
      blendedLtvCents: 0,
      windowDays: daysInclusive(startDate, endDate),
      creditAmazonHalo: true,
      countAllNonRenewal: true,
      targetCacLtv,
      targetPaybackDays,
      extraFlags: flags,
    });
  }

  const aggs = await Promise.all(
    groupIds.map((groupId) => aggregateGroup({ workspaceId, groupId, startDate, endDate })),
  );

  let blendedSpendCents = 0;
  let blendedRevenueCents = 0;
  let blendedNewCustomers = 0;
  const blendedByProduct = new Map<string, number>();

  let allCreditAmazon = true;
  let allCountAllNonRenewal = true;
  let anyCreditAmazon = false;
  let anyCountAllNonRenewal = false;

  for (const a of aggs) {
    blendedSpendCents += a.acq.channelSplit.spendCents;
    blendedRevenueCents += a.acq.numeratorCents;
    blendedNewCustomers += a.newCustomers;
    for (const [pid, rev] of a.byProductRevenueCents) {
      blendedByProduct.set(pid, (blendedByProduct.get(pid) ?? 0) + rev);
    }
    allCreditAmazon = allCreditAmazon && a.acq.assumptions.creditAmazonToMeta;
    allCountAllNonRenewal = allCountAllNonRenewal && a.acq.assumptions.countAllNonRenewal;
    anyCreditAmazon = anyCreditAmazon || a.acq.assumptions.creditAmazonToMeta;
    anyCountAllNonRenewal = anyCountAllNonRenewal || a.acq.assumptions.countAllNonRenewal;
    for (const f of a.acq.flags) flags.push(`${a.acq.groupName ?? a.groupId}: ${f}`);
  }

  if (anyCreditAmazon && !allCreditAmazon) {
    flags.push("mixed Amazon-halo credit across product lines — blended numerator straddles attribution regimes");
  }
  if (anyCountAllNonRenewal && !allCountAllNonRenewal) {
    flags.push("mixed non-renewal counting across product lines (utm-meta-only on some, all on others)");
  }

  const blendedLtvCents = await computeBlendedLtvCents(workspaceId, blendedByProduct);

  return blendedCacLtvFromTotals({
    blendedSpendCents,
    blendedRevenueCents,
    blendedNewCustomers,
    blendedLtvCents,
    windowDays: daysInclusive(startDate, endDate),
    creditAmazonHalo: allCreditAmazon,
    countAllNonRenewal: allCountAllNonRenewal,
    targetCacLtv,
    targetPaybackDays,
    extraFlags: flags,
  });
}
