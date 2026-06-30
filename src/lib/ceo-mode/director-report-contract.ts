// CEO-mode director report contract — the standard output schema every specialist director
// (CFO, Growth, CMO, Retention, Logistics, CS) returns so the CEO synthesizer can compose them
// (docs/brain/goals/ceo-mode.md § "The org model", M0). This is the schema-as-code of the contract
// the goal doc specifies:
//
//   { domain, health_score, metrics_vs_target[],
//     findings[],
//     recommended_actions[{ action, expected_impact_$, effort, confidence, reversible?, depends_on }],
//     risks[] }
//
// North star (CLAUDE.md § North star · ceo-mode.md § "Role agents own the objective"): a director
// agent OWNS an objective and reasons on a PROXY; the contract surfaces both (`objective`/`proxy`) and
// its `assumptions` so a degenerate proxy-move is visible to the CEO and never executed silently. The
// first consumer is the Growth director ([[growth-report-contract]]); the reader is the M4 CEO
// synthesizer (still planned) — this module is the shared shape they meet on.

// Bounded enums so the CEO can rank across directors uniformly.
export type DirectorEffort = "low" | "medium" | "high";
export type DirectorConfidence = "low" | "medium" | "high";
export type MetricStatus = "above" | "at" | "below" | "unknown";
// "high" lets a director surface a cross-cutting Goodhart guardrail (e.g. growth's `do_not_cut`
// finding when blended CAC:LTV ≥ target but a per-channel revenue-ROAS < 1) as a finding the CEO
// must weigh — the trio "info | watch | risk" only spans diagnostic / cautionary observations.
export type FindingSeverity = "info" | "watch" | "risk" | "high";
export type RiskSeverity = "low" | "medium" | "high";

/** One tracked metric against its setpoint, with the week-over-week move. */
export interface MetricVsTarget {
  /** Stable machine-readable identifier (e.g. "blended_cac_ltv") so downstream consumers can pick a
   *  specific row without parsing the human label. Optional for backwards-compat with per-line rows. */
  key?: string;
  /** Human label, e.g. "AcqROAS — Amazing Coffee". */
  metric: string;
  /** Current value over the report window; null when undefined (e.g. no spend). */
  value: number | null;
  /** The setpoint the agent supervises the proxy against; null when not yet defined. */
  target: number | null;
  /** Display unit: "x" (ratio), "$", "%". */
  unit: string;
  /** value vs target. "unknown" when value or target is null. */
  status: MetricStatus;
  /** Week-over-week delta (value − prior-window value); null when no prior window. */
  delta: number | null;
  note?: string;
}

/** A qualitative observation the director surfaces for the CEO. */
export interface Finding {
  summary: string;
  detail?: string;
  severity: FindingSeverity;
  /** Structured evidence the CEO (or a human) can audit the claim against. */
  evidence?: Record<string, unknown>;
}

/**
 * A ranked move the CEO can route (auto-execute low-risk / gate the rest — ceo-mode.md § Execution
 * authority). `expected_impact_usd` is the goal doc's `expected_impact_$`.
 */
export interface RecommendedAction {
  action: string;
  expected_impact_usd: number | null;
  effort: DirectorEffort;
  confidence: DirectorConfidence;
  /** Reversible moves are auto-execute candidates; irreversible ones always gate. */
  reversible: boolean;
  /** Other actions / capability-gap specs this depends on. */
  depends_on: string[];
}

/** A downside the CEO should weigh — including degenerate proxy-moves the agent is guarding against. */
export interface Risk {
  summary: string;
  severity: RiskSeverity;
  mitigation?: string;
}

/** The standard director → CEO report contract. */
export interface DirectorReportContract {
  /** Director domain key: "growth" | "cfo" | "cmo" | "retention" | "logistics" | "cs". */
  domain: string;
  /** 0–100 rollup of the domain's health this window. */
  health_score: number;
  metrics_vs_target: MetricVsTarget[];
  findings: Finding[];
  recommended_actions: RecommendedAction[];
  risks: Risk[];

  // ── North-star + provenance extensions (surfaced so the CEO can supervise, not just aggregate) ──
  /** The real objective the agent owns (e.g. "profitable new-customer acquisition"). */
  objective?: string;
  /** The bounded proxy the agent reasons on (e.g. "AcqROAS"); named so a proxy-move is legible. */
  proxy?: string;
  /** Versioned attribution / methodology assumptions behind every number above. */
  assumptions?: string[];
  /** The report window. */
  window?: { startDate: string; endDate: string };
}

const EFFORTS: DirectorEffort[] = ["low", "medium", "high"];
const CONFIDENCES: DirectorConfidence[] = ["low", "medium", "high"];
const METRIC_STATUSES: MetricStatus[] = ["above", "at", "below", "unknown"];
const FINDING_SEVERITIES: FindingSeverity[] = ["info", "watch", "risk", "high"];
const RISK_SEVERITIES: RiskSeverity[] = ["low", "medium", "high"];

export interface ContractValidation {
  valid: boolean;
  errors: string[];
}

function isNumberOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Runtime-validate an arbitrary object against the director report contract. Returns every violation
 * (not just the first) so a director can be checked before it's handed to the CEO synthesizer.
 */
export function validateDirectorReportContract(input: unknown): ContractValidation {
  const errors: string[] = [];
  const push = (e: string) => errors.push(e);

  if (typeof input !== "object" || input === null) {
    return { valid: false, errors: ["report is not an object"] };
  }
  const r = input as Record<string, unknown>;

  if (typeof r.domain !== "string" || !r.domain.trim()) push("domain must be a non-empty string");
  if (typeof r.health_score !== "number" || !Number.isFinite(r.health_score) || r.health_score < 0 || r.health_score > 100) {
    push("health_score must be a number in [0, 100]");
  }

  if (!Array.isArray(r.metrics_vs_target)) {
    push("metrics_vs_target must be an array");
  } else {
    r.metrics_vs_target.forEach((m, i) => {
      const mm = m as Record<string, unknown>;
      if (typeof mm?.metric !== "string" || !mm.metric.trim()) push(`metrics_vs_target[${i}].metric must be a non-empty string`);
      if (!isNumberOrNull(mm?.value)) push(`metrics_vs_target[${i}].value must be a finite number or null`);
      if (!isNumberOrNull(mm?.target)) push(`metrics_vs_target[${i}].target must be a finite number or null`);
      if (typeof mm?.unit !== "string") push(`metrics_vs_target[${i}].unit must be a string`);
      if (!METRIC_STATUSES.includes(mm?.status as MetricStatus)) push(`metrics_vs_target[${i}].status invalid`);
      if (!isNumberOrNull(mm?.delta)) push(`metrics_vs_target[${i}].delta must be a finite number or null`);
    });
  }

  if (!Array.isArray(r.findings)) {
    push("findings must be an array");
  } else {
    r.findings.forEach((f, i) => {
      const ff = f as Record<string, unknown>;
      if (typeof ff?.summary !== "string" || !ff.summary.trim()) push(`findings[${i}].summary must be a non-empty string`);
      if (!FINDING_SEVERITIES.includes(ff?.severity as FindingSeverity)) push(`findings[${i}].severity invalid`);
    });
  }

  if (!Array.isArray(r.recommended_actions)) {
    push("recommended_actions must be an array");
  } else {
    r.recommended_actions.forEach((a, i) => {
      const aa = a as Record<string, unknown>;
      if (typeof aa?.action !== "string" || !aa.action.trim()) push(`recommended_actions[${i}].action must be a non-empty string`);
      if (!isNumberOrNull(aa?.expected_impact_usd)) push(`recommended_actions[${i}].expected_impact_usd must be a finite number or null`);
      if (!EFFORTS.includes(aa?.effort as DirectorEffort)) push(`recommended_actions[${i}].effort invalid`);
      if (!CONFIDENCES.includes(aa?.confidence as DirectorConfidence)) push(`recommended_actions[${i}].confidence invalid`);
      if (typeof aa?.reversible !== "boolean") push(`recommended_actions[${i}].reversible must be a boolean`);
      if (!Array.isArray(aa?.depends_on)) push(`recommended_actions[${i}].depends_on must be an array`);
    });
  }

  if (!Array.isArray(r.risks)) {
    push("risks must be an array");
  } else {
    r.risks.forEach((rk, i) => {
      const rr = rk as Record<string, unknown>;
      if (typeof rr?.summary !== "string" || !rr.summary.trim()) push(`risks[${i}].summary must be a non-empty string`);
      if (!RISK_SEVERITIES.includes(rr?.severity as RiskSeverity)) push(`risks[${i}].severity invalid`);
    });
  }

  return { valid: errors.length === 0, errors };
}
