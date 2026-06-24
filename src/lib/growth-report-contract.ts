// Growth director — CEO-mode report contract output (docs/brain/specs/growth-acquisition-roas-spine-report-contract.md
// Phase 1; M2 of docs/brain/goals/ceo-mode.md). The OUTPUT/PRESENTATION layer over the shipped metric:
// wrap computeAcqROAS(group, window) ([[acquisition-roas]]) into the CEO-mode director report contract
// ([[director-report-contract]]) so the M4 CEO synthesizer can compose Growth alongside the other
// directors. One metric row per product line: AcqROAS, non-renewal new-customer revenue, channel mix,
// week-over-week delta, and the do-NOT-cut guardrail flag.
//
// North star (CLAUDE.md · ceo-mode.md § "Role agents own the objective"): the Growth agent OWNS
// "profitable new-customer acquisition" — AcqROAS is its PROXY, named as such on the contract. This
// module flags the degenerate move the proxy invites (cutting a proven SKU on on-site ROAS alone when
// the Amazon halo carries it) as a risk + a high-confidence "do not cut" guardrail, never an action.
//
// Contribution-margin ROAS is a DECLARED DEPENDENCY on M1 COGS — until then every number here is
// REVENUE-ROAS, surfaced in `assumptions`. Consumes the shipped spine; does not re-derive the metric.

import { createAdminClient } from "@/lib/supabase/admin";
import { computeAcqROAS, type AcqRoasResult } from "@/lib/acquisition-roas";
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
  /** AcqROAS setpoint the agent supervises the proxy against. Defaults to break-even (1.0). */
  targetAcqRoas?: number;
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

interface LinePass {
  current: AcqRoasResult;
  prior: AcqRoasResult | null;
}

// Build the per-line contributions (one product line → its metric row, findings, actions, risks).
function buildLine(pass: LinePass, target: number): {
  metric: MetricVsTarget;
  findings: Finding[];
  actions: RecommendedAction[];
  risks: Risk[];
  aboveTarget: boolean | null;
} {
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

/**
 * Build the Growth director's CEO-mode report contract for a window. One metric row per product line
 * (linked group with a Meta ad-account mapping), validated against [[director-report-contract]].
 */
export async function buildGrowthReportContract(params: GrowthReportParams): Promise<DirectorReportContract> {
  const {
    workspaceId,
    startDate,
    endDate,
    priorStartDate,
    priorEndDate,
    targetAcqRoas = DEFAULT_ACQ_ROAS_TARGET,
    groupIds,
  } = params;

  const lineGroupIds = groupIds?.length ? groupIds : await getMappedGroupIds(workspaceId);
  const hasPrior = Boolean(priorStartDate && priorEndDate);

  const passes: LinePass[] = await Promise.all(
    lineGroupIds.map(async (groupId) => {
      const [current, prior] = await Promise.all([
        computeAcqROAS({ workspaceId, groupId, startDate, endDate }),
        hasPrior
          ? computeAcqROAS({ workspaceId, groupId, startDate: priorStartDate!, endDate: priorEndDate! })
          : Promise.resolve(null),
      ]);
      return { current, prior };
    }),
  );

  const metrics_vs_target: MetricVsTarget[] = [];
  const findings: Finding[] = [];
  const recommended_actions: RecommendedAction[] = [];
  const risks: Risk[] = [];
  let above = 0;
  let scored = 0;

  for (const pass of passes) {
    const line = buildLine(pass, targetAcqRoas);
    metrics_vs_target.push(line.metric);
    findings.push(...line.findings);
    recommended_actions.push(...line.actions);
    risks.push(...line.risks);
    if (line.aboveTarget !== null) {
      scored += 1;
      if (line.aboveTarget) above += 1;
    }
  }

  if (!lineGroupIds.length) {
    findings.push({
      summary: "No product line has a Meta ad-account mapping — AcqROAS cannot be reported.",
      severity: "watch",
    });
  }

  // health_score: share of measurable lines at/above target, 0–100. 50 (neutral) when nothing scored.
  const health_score = scored > 0 ? Math.round((above / scored) * 100) : 50;

  // Methodology assumptions — uniform across the report.
  const assumptions: string[] = [
    "Revenue-ROAS (gross non-renewal new-customer revenue ÷ mapped Meta spend). Contribution-margin ROAS is a declared dependency on M1 COGS (ceo-mode.md) — not yet available.",
    "Numerator = on-site non-renewal revenue + Amazon halo (when credited per the group's mapping). Denominator = mapped Meta spend × each account's spend_share.",
    "A shared ad account at spend_share 1.0 makes that line's AcqROAS a conservative floor (denominator carries another line's spend).",
  ];

  return {
    domain: "growth",
    health_score,
    metrics_vs_target,
    findings,
    recommended_actions,
    risks,
    objective: "profitable new-customer acquisition (CAC ≤ LTV, spend ≥ a revenue floor)",
    proxy: "AcqROAS — a bounded measurement proxy the Growth agent reasons on, NOT the objective; supervised against degenerate proxy-moves (see risks).",
    assumptions,
    window: { startDate, endDate },
  };
}
