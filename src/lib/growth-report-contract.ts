// Growth director — CEO-mode report contract output (docs/brain/specs/growth-acquisition-roas-spine-report-contract.md
// Phase 1; M2 of docs/brain/goals/ceo-mode.md). The OUTPUT/PRESENTATION layer over the shipped metric:
// wrap computeAcqROAS(group, window) ([[acquisition-roas]]) into the CEO-mode director report contract
// ([[director-report-contract]]) so the M4 CEO synthesizer can compose Growth alongside the other
// directors.
//
// Top-line is the Growth Director's BLENDED CAC↔LTV objective ([[blended-cac-ltv]],
// docs/brain/specs/growth-blended-cac-ltv-objective.md Phase 2): one `blended_cac_ltv` MetricVsTarget
// row (with `blended_payback_days` secondary) BEFORE the per-product AcqROAS rows, so the Director
// optimizes ONE blended number, not per-channel ROAS — the Goodhart guardrail the goal calls out.
// Per-line AcqROAS rows follow as supporting detail / the do-NOT-cut surface.
//
// North star (CLAUDE.md · ceo-mode.md § "Role agents own the objective"): the Growth agent OWNS
// "profitable new-customer acquisition" — the BLENDED cacLtvRatio is its PROXY, named as such on the
// contract (`contract.proxy = "blended_cac_ltv"`). This module flags the degenerate move the proxy
// invites (cutting a proven SKU on on-site ROAS alone when the Amazon halo carries it) as a risk + a
// high-confidence "do not cut" guardrail, never an action.
//
// Contribution-margin ROAS is a DECLARED DEPENDENCY on M1 COGS — until then every number here is
// REVENUE-ROAS, surfaced in `assumptions`. Consumes the shipped spine; does not re-derive the metric.

import { createAdminClient } from "@/lib/supabase/admin";
import { computeAcqROAS, type AcqRoasResult } from "@/lib/acquisition-roas";
import {
  computeBlendedCacLtv,
  DEFAULT_BLENDED_CAC_LTV_TARGET,
  type BlendedCacLtvResult,
} from "@/lib/blended-cac-ltv";
import type {
  DirectorReportContract,
  MetricVsTarget,
  MetricStatus,
  Finding,
  RecommendedAction,
  Risk,
} from "@/lib/ceo-mode/director-report-contract";

/** Default break-even setpoint for revenue-AcqROAS (1.0× = ad spend recovered from new-customer revenue). */
export const DEFAULT_ACQ_ROAS_TARGET = 1.0;

export interface GrowthReportParams {
  workspaceId: string;
  /** Report window, inclusive, YYYY-MM-DD Central-time (matches the AcqROAS snapshot boundaries). */
  startDate: string;
  endDate: string;
  /** Prior window for the week-over-week delta. Both must be set or neither (delta is null without it). */
  priorStartDate?: string;
  priorEndDate?: string;
  /** AcqROAS setpoint the agent supervises the per-line proxy against. Defaults to break-even (1.0). */
  targetAcqRoas?: number;
  /** Blended CAC:LTV setpoint the Director supervises. Defaults to DEFAULT_BLENDED_CAC_LTV_TARGET (3×). */
  targetCacLtv?: number;
  /** Blended payback-days setpoint. Surfaced on the blended-payback row's `target` (null if not set). */
  targetPaybackDays?: number;
  /** Restrict to specific linked-group ids; defaults to every group with an ad-account mapping. */
  groupIds?: string[];
}

const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Linked-product groups that have a Meta ad-account mapping — the measurable "product lines". */
async function getMappedGroupIds(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_ad_account_mappings")
    .select("group_id")
    .eq("workspace_id", workspaceId);
  return Array.from(new Set((data || []).map((r) => r.group_id as string).filter(Boolean)));
}

/** On-site-only ROAS (excludes the Amazon halo) — the number a naive proxy-cut would act on. */
function onsiteRoas(r: AcqRoasResult): number | null {
  const { onsiteCents, spendCents } = r.channelSplit;
  return spendCents > 0 ? onsiteCents / spendCents : null;
}

export interface LinePass {
  current: AcqRoasResult;
  prior: AcqRoasResult | null;
}

interface LineContribution {
  metric: MetricVsTarget;
  findings: Finding[];
  actions: RecommendedAction[];
  risks: Risk[];
  aboveTarget: boolean | null;
}

// Build the per-line contributions (one product line → its metric row, findings, actions, risks).
function buildLine(pass: LinePass, target: number): LineContribution {
  const { current, prior } = pass;
  const name = current.groupName || current.groupId;
  const acq = current.acqRoas;
  const priorAcq = prior?.acqRoas ?? null;
  const delta = acq !== null && priorAcq !== null ? round2(acq - priorAcq) : null;

  const status: MetricStatus = acq === null ? "unknown" : acq > target ? "above" : acq < target ? "below" : "at";
  const metric: MetricVsTarget = {
    metric: `AcqROAS — ${name}`,
    value: acq === null ? null : round2(acq),
    target,
    unit: "x",
    status,
    delta,
    note: current.flags.length ? current.flags.join("; ") : undefined,
  };

  const findings: Finding[] = [];
  const actions: RecommendedAction[] = [];
  const risks: Risk[] = [];

  const { onsiteCents, amazonCents, spendCents } = current.channelSplit;
  findings.push({
    summary: `${name}: ${acq === null ? "AcqROAS undefined" : `AcqROAS ${round2(acq)}×`} on ${fmtUsd(spendCents)} mapped Meta spend`,
    detail:
      `Non-renewal new-customer revenue ${fmtUsd(current.numeratorCents)} ` +
      `(on-site ${fmtUsd(onsiteCents)} + Amazon halo ${fmtUsd(amazonCents)})` +
      (current.haloRatio !== null ? `, halo ratio ${round2(current.haloRatio)}×.` : ".") +
      (delta !== null ? ` Week-over-week ${delta >= 0 ? "+" : ""}${delta}×.` : ""),
    severity: acq !== null && acq < target ? "watch" : "info",
    evidence: {
      acqRoas: acq,
      channelSplit: current.channelSplit,
      haloRatio: current.haloRatio,
      assumptions: current.assumptions,
      flags: current.flags,
      window: { startDate: current.startDate, endDate: current.endDate },
    },
  });

  // ── North-star guardrail: the degenerate proxy-move ──────────────────────────────
  // On-site ROAS below break-even but halo-blended AcqROAS at/above target → the Amazon halo carries
  // the line. Cutting it on the on-site number alone destroys the objective. Flag, do NOT recommend cut.
  const onsite = onsiteRoas(current);
  const haloCarries = onsite !== null && onsite < 1 && acq !== null && acq >= target;
  if (haloCarries) {
    risks.push({
      summary:
        `${name}: on-site ROAS ${round2(onsite!)}× < 1 but halo-blended AcqROAS ${round2(acq!)}× ≥ target ${target}× — ` +
        `do NOT cut. The Amazon halo carries this proven line; cutting on the on-site number alone is a ` +
        `Goodhart proxy-move that destroys profitable new-customer acquisition.`,
      severity: "high",
      mitigation: "Hold spend; judge this line on halo-blended AcqROAS, not on-site ROAS.",
    });
    findings.push({
      summary: `${name}: do-NOT-cut guardrail active (halo carries the line)`,
      severity: "risk",
      evidence: { onsiteRoas: onsite, blendedAcqRoas: acq, target },
    });
  } else if (acq !== null && acq < target && spendCents > 0) {
    // Genuinely under target on the blended number — a real efficiency gap, not a halo artifact.
    findings.push({
      summary: `${name}: blended AcqROAS ${round2(acq)}× below target ${target}× — real efficiency gap`,
      detail: "Diagnose root cause before cutting (creative fatigue, targeting, lander, or offer), per the Growth agent's supervisory role.",
      severity: "watch",
      evidence: { acqRoas: acq, target, onsiteRoas: onsite },
    });
  }

  const aboveTarget = acq === null ? null : acq >= target;
  return { metric, findings, actions, risks, aboveTarget };
}

/** Build the top-line blended CAC:LTV row (higher is better). Status compares value to target the
 *  same direction-agnostic way the per-line AcqROAS rows do. */
function buildBlendedCacLtvRow(
  blended: BlendedCacLtvResult,
  prior: BlendedCacLtvResult | null,
  target: number,
): MetricVsTarget {
  const value = blended.cacLtvRatio;
  const priorValue = prior?.cacLtvRatio ?? null;
  const delta = value !== null && priorValue !== null ? round2(value - priorValue) : null;
  const status: MetricStatus =
    value === null ? "unknown" : value > target ? "above" : value < target ? "below" : "at";
  const noteParts: string[] = ["higher is better"];
  if (blended.flags.length) noteParts.push(blended.flags.join("; "));
  return {
    key: "blended_cac_ltv",
    metric: "Blended CAC:LTV",
    value,
    target,
    unit: "x",
    status,
    delta,
    note: noteParts.join(" — "),
  };
}

/** Secondary top-line payback-days row (LOWER is better). Direction-agnostic status compare; the
 *  `note` flags the inverted semantic so a CEO reading "above" doesn't misread it as good. */
function buildBlendedPaybackRow(
  blended: BlendedCacLtvResult,
  prior: BlendedCacLtvResult | null,
  target: number | null,
): MetricVsTarget {
  const value = blended.paybackDays;
  const priorValue = prior?.paybackDays ?? null;
  const delta = value !== null && priorValue !== null ? value - priorValue : null;
  const status: MetricStatus =
    value === null || target === null
      ? "unknown"
      : value > target
        ? "above"
        : value < target
          ? "below"
          : "at";
  return {
    key: "blended_payback_days",
    metric: "Blended payback days",
    value,
    target,
    unit: "days",
    status,
    delta,
    note: "lower is better",
  };
}

/** health_score from the BLENDED top-line — round(clamp(ratio / target, 0, 1) × 100). Neutral 50 when
 *  the ratio is undefined (no spend, no LTV, no new customers). Replaces the prior per-line-share
 *  rollup so the Director's score reflects blended attainment, not per-channel proxy. */
function blendedHealthScore(blended: BlendedCacLtvResult, target: number): number {
  if (blended.cacLtvRatio === null) return 50;
  if (target <= 0) return 50;
  const ratio = blended.cacLtvRatio / target;
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/** Strings appended verbatim to `contract.assumptions` for the blended top-line so a CEO reading the
 *  contract knows the methodology — including the COGS-deferred line spec verification asserts on. */
function blendedAssumptionLines(blended: BlendedCacLtvResult): string[] {
  const a = blended.assumptions;
  const lines: string[] = [];
  if (a.marginRoasBlockedOnCogs) {
    lines.push(
      "Blended CAC:LTV is REVENUE-side: margin-ROAS is a declared dependency on CFO M1 COGS (computeModeledRenewalMargin still returns cogs_source_missing=true) — marginRoasBlockedOnCogs=true.",
    );
  }
  if (a.ltvProxyUncalibrated) {
    lines.push(
      "Blended LTV uses the storefront-ltv-proxy v1 (uncalibrated against actual 4-month cohort LTV until the reconciler Phase 3 lands) — ltvProxyUncalibrated=true.",
    );
  }
  if (a.paybackUsesWindowRateExtrapolation) {
    lines.push(
      "Blended payback extrapolates the in-window new-customer revenue rate forward (paybackDays = spend × windowDays / revenue) — paybackUsesWindowRateExtrapolation=true.",
    );
  }
  if (!a.creditAmazonHalo) {
    lines.push(
      "Blended numerator does NOT credit the Amazon halo for every measured group (creditAmazonHalo=false) — see the group-level flags.",
    );
  }
  if (!a.countAllNonRenewal) {
    lines.push(
      "Blended numerator restricts to utm_source=meta on at least one measured group (countAllNonRenewal=false) — see the group-level flags.",
    );
  }
  return lines;
}

/** Pure assembler — given pre-computed inputs, return the contract. Split out so a unit test can
 *  exercise the wiring (blended row first, payback row second, per-line rows after, assumptions
 *  appended, health from blended) without a database. */
export interface AssembleGrowthReportInput {
  startDate: string;
  endDate: string;
  passes: LinePass[];
  blendedCurrent: BlendedCacLtvResult;
  blendedPrior: BlendedCacLtvResult | null;
  targetAcqRoas: number;
  targetCacLtv: number;
  targetPaybackDays: number | null;
  /** True when there was no measurable product line (no `product_ad_account_mappings` row). */
  noMappedGroups: boolean;
}

export function assembleGrowthReportContract(input: AssembleGrowthReportInput): DirectorReportContract {
  const {
    startDate,
    endDate,
    passes,
    blendedCurrent,
    blendedPrior,
    targetAcqRoas,
    targetCacLtv,
    targetPaybackDays,
    noMappedGroups,
  } = input;

  const metrics_vs_target: MetricVsTarget[] = [];
  const findings: Finding[] = [];
  const recommended_actions: RecommendedAction[] = [];
  const risks: Risk[] = [];

  // ── Top-line: blended CAC:LTV + payback BEFORE per-product rows ──
  metrics_vs_target.push(buildBlendedCacLtvRow(blendedCurrent, blendedPrior, targetCacLtv));
  metrics_vs_target.push(buildBlendedPaybackRow(blendedCurrent, blendedPrior, targetPaybackDays));

  for (const pass of passes) {
    const line = buildLine(pass, targetAcqRoas);
    metrics_vs_target.push(line.metric);
    findings.push(...line.findings);
    recommended_actions.push(...line.actions);
    risks.push(...line.risks);
  }

  if (noMappedGroups) {
    findings.push({
      summary: "No product line has a Meta ad-account mapping — AcqROAS cannot be reported.",
      severity: "watch",
    });
  }

  // Methodology assumptions — uniform across the report. Blended-top-line lines appended first so
  // the COGS-deferred / LTV-uncalibrated provenance leads.
  const assumptions: string[] = [
    ...blendedAssumptionLines(blendedCurrent),
    "Per-line AcqROAS is revenue-ROAS (gross non-renewal new-customer revenue ÷ mapped Meta spend). Contribution-margin ROAS is a declared dependency on M1 COGS (ceo-mode.md) — not yet available.",
    "Numerator = on-site non-renewal revenue + Amazon halo (when credited per the group's mapping). Denominator = mapped Meta spend × each account's spend_share.",
    "A shared ad account at spend_share 1.0 makes that line's AcqROAS a conservative floor (denominator carries another line's spend).",
  ];

  return {
    domain: "growth",
    health_score: blendedHealthScore(blendedCurrent, targetCacLtv),
    metrics_vs_target,
    findings,
    recommended_actions,
    risks,
    objective: "profitable new-customer acquisition (CAC ≤ LTV, spend ≥ a revenue floor)",
    proxy: "blended_cac_ltv",
    assumptions,
    window: { startDate, endDate },
  };
}

/**
 * Build the Growth director's CEO-mode report contract for a window. Top-line is the blended
 * CAC:LTV objective + payback window; per-product AcqROAS rows follow as supporting detail.
 * Validated against [[director-report-contract]].
 */
export async function buildGrowthReportContract(params: GrowthReportParams): Promise<DirectorReportContract> {
  const {
    workspaceId,
    startDate,
    endDate,
    priorStartDate,
    priorEndDate,
    targetAcqRoas = DEFAULT_ACQ_ROAS_TARGET,
    targetCacLtv = DEFAULT_BLENDED_CAC_LTV_TARGET,
    targetPaybackDays,
    groupIds,
  } = params;

  const lineGroupIds = groupIds?.length ? groupIds : await getMappedGroupIds(workspaceId);
  const hasPrior = Boolean(priorStartDate && priorEndDate);

  const [passes, blendedCurrent, blendedPrior] = await Promise.all([
    Promise.all(
      lineGroupIds.map(async (groupId): Promise<LinePass> => {
        const [current, prior] = await Promise.all([
          computeAcqROAS({ workspaceId, groupId, startDate, endDate }),
          hasPrior
            ? computeAcqROAS({ workspaceId, groupId, startDate: priorStartDate!, endDate: priorEndDate! })
            : Promise.resolve(null),
        ]);
        return { current, prior };
      }),
    ),
    computeBlendedCacLtv({
      workspaceId,
      startDate,
      endDate,
      targetCacLtv,
      targetPaybackDays,
      groupIds: lineGroupIds.length ? lineGroupIds : undefined,
    }),
    hasPrior
      ? computeBlendedCacLtv({
          workspaceId,
          startDate: priorStartDate!,
          endDate: priorEndDate!,
          targetCacLtv,
          targetPaybackDays,
          groupIds: lineGroupIds.length ? lineGroupIds : undefined,
        })
      : Promise.resolve(null),
  ]);

  return assembleGrowthReportContract({
    startDate,
    endDate,
    passes,
    blendedCurrent,
    blendedPrior,
    targetAcqRoas,
    targetCacLtv,
    targetPaybackDays: targetPaybackDays ?? null,
    noMappedGroups: lineGroupIds.length === 0,
  });
}
