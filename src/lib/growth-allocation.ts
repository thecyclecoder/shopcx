/**
 * Cross-tool growth-allocation brain — Phase 1: marginal-leverage readers.
 *
 * Two pure-ish reads, one per "tool" the Growth Director can move spend on:
 *
 *   • `readMetaMarginalLeverage(...)` — surveys [[../tables/iteration_scorecards_daily]]
 *     (the engine's authorized daily metrics) + pending [[../tables/iteration_recommendations]]
 *     for `scale_up` adset/campaign opportunities AND `new_*_adset` / `new_campaign`
 *     opportunities the iteration engine has already typed up. Emits the best
 *     estimated marginal ROAS the next dollar of Meta spend could earn, plus the
 *     evidence rows it cited.
 *
 *   • `readStorefrontMarginalLeverage(...)` — walks every `running`
 *     [[../tables/storefront_experiments]] and reads its `last_decision` snapshot
 *     (written by [[./storefront/experiment-refresh]] off the [[./storefront/bandit]]
 *     posteriors). Emits the best win-prob-weighted LTV lift per session a single
 *     storefront promote/activation would unlock.
 *
 * Per spec, each returns `{ metaScore | storefrontScore, evidence[], flags[] }`. The
 * SCORE FUNCTIONS are pure (DB-free) so a unit test pins them on fixture inputs; the
 * data-layer wrappers fetch + invoke the pure function.
 *
 * Phase 2 (composer) consumes both sides and produces ONE typed AllocationDecision;
 * Phase 3 stamps `director_activity` and wires this into the box-lane.
 *
 * See docs/brain/specs/growth-allocation-brain.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

// ── Shared types ─────────────────────────────────────────────────────────────────

/**
 * Default ROAS at/above which an adset is considered scale-up-eligible when the
 * workspace has no [[../tables/iteration_policies]] row active yet. A break-even-with-margin
 * threshold; the active policy overrides when present.
 */
export const DEFAULT_SCALE_UP_ROAS_TRIGGER = 1.5;

// ── Meta side ────────────────────────────────────────────────────────────────────

/** Scorecard subset the Meta reader needs. Mirrors [[./meta/decision-engine]] `ScorecardRow`
 *  but kept minimal — this read only cares about ROAS, spend, fatigue + cite-back ids. */
export interface MetaScorecardRow {
  id: string;
  level: "adset" | "campaign" | "ad" | "variant" | "angle";
  object_id: string;
  label: string | null;
  snapshot_date: string;
  spend_cents: number;
  revenue_cents: number;
  roas: number;
  ctr_declining: boolean;
  frequency_rising: boolean;
  fatigue_score: number;
}

/** Pending [[iteration_recommendations]] subset the Meta reader needs. */
export interface MetaPendingRecommendationRow {
  id: string;
  action_type: string;
  title: string | null;
  confidence: number | null;
  source_metrics: Record<string, unknown>;
  source_scorecard_ids: string[];
}

export type MetaLeverageEvidenceSource = "scorecard_scale_up" | "pending_recommendation";

export interface MetaLeverageEvidence {
  source: MetaLeverageEvidenceSource;
  /** Estimated marginal ROAS the next-dollar move could earn. */
  estimated_marginal_roas: number;
  rationale: string;
  /** Cite-back: the scorecard row this was read from (when source='scorecard_scale_up'). */
  scorecard_id?: string;
  /** Cite-back: the recommendation row (when source='pending_recommendation'). */
  recommendation_id?: string;
  /** Subject of the opportunity, for downstream rationale. */
  object_id?: string;
  label?: string | null;
  action_type?: string;
  confidence?: number | null;
}

export interface MetaMarginalLeverageResult {
  /** Best estimated marginal ROAS across all evidence. `null` when there is no signal — the
   *  composer treats that as "Meta has no useful next-dollar lever today." */
  metaScore: number | null;
  evidence: MetaLeverageEvidence[];
  flags: string[];
}

/** New-spend-line recommendation types this reader treats as a candidate marginal lever. */
const META_NEW_SPEND_LINE_ACTION_TYPES = new Set<string>([
  "new_static_adset",
  "new_video_adset",
  "new_campaign",
]);

/** Pull a best-effort numeric marginal-ROAS estimate out of a recommendation's
 *  `source_metrics` blob. The decision engine writes a free-form jsonb here; we accept
 *  any of the common shapes and fall back to `null`. */
function extractRecommendationRoas(sourceMetrics: Record<string, unknown>): number | null {
  const candidates: Array<unknown> = [
    sourceMetrics.estimated_marginal_roas,
    sourceMetrics.expected_roas,
    sourceMetrics.projected_roas,
    sourceMetrics.account_roas,
    sourceMetrics.benchmark_roas,
    sourceMetrics.roas,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/**
 * Pure scorer — takes the already-fetched scorecards + recommendations + the
 * scale-up ROAS trigger, returns the marginal-leverage result. DB-free.
 */
export function scoreMetaMarginalLeverage(input: {
  scorecards: MetaScorecardRow[];
  recommendations: MetaPendingRecommendationRow[];
  scaleUpRoasTrigger: number;
}): MetaMarginalLeverageResult {
  const evidence: MetaLeverageEvidence[] = [];
  const flags: string[] = [];

  // 1. Scale-up scorecards — adset/campaign rows where current-window ROAS clears the
  //    policy's scale_up trigger AND the row is not fatigued (mirrors the conditions
  //    `computeAutonomousActions` uses before issuing a `scale_up`, kept here as a
  //    READ-ONLY survey — the decision-engine still owns the execute path).
  for (const row of input.scorecards) {
    if (row.level !== "adset" && row.level !== "campaign") continue;
    if (row.roas < input.scaleUpRoasTrigger) continue;
    if (row.ctr_declining || row.frequency_rising) continue;
    evidence.push({
      source: "scorecard_scale_up",
      estimated_marginal_roas: row.roas,
      rationale: `${row.level} ${row.label ?? row.object_id} ran ${row.roas.toFixed(2)}× ROAS (≥ ${input.scaleUpRoasTrigger.toFixed(2)}× trigger), not fatigued`,
      scorecard_id: row.id,
      object_id: row.object_id,
      label: row.label,
      action_type: "scale_up",
    });
  }

  // 2. Pending new-spend-line recommendations — the engine's Phase-4b output that opens
  //    a NEW live spend line (still gated on Dylan approve). Their `source_metrics`
  //    blob is where the engine stamps the marginal-ROAS estimate it reasoned over.
  for (const rec of input.recommendations) {
    if (!META_NEW_SPEND_LINE_ACTION_TYPES.has(rec.action_type)) continue;
    const roas = extractRecommendationRoas(rec.source_metrics);
    if (roas == null) {
      flags.push(`recommendation ${rec.id} (${rec.action_type}) has no marginal-ROAS estimate in source_metrics`);
      continue;
    }
    evidence.push({
      source: "pending_recommendation",
      estimated_marginal_roas: roas,
      rationale: `pending ${rec.action_type}${rec.title ? ` — ${rec.title}` : ""} (est. ${roas.toFixed(2)}× marginal ROAS)`,
      recommendation_id: rec.id,
      action_type: rec.action_type,
      confidence: rec.confidence,
    });
  }

  if (evidence.length === 0) {
    flags.push("no_signal_meta");
    return { metaScore: null, evidence, flags };
  }

  const metaScore = evidence.reduce((m, e) => (e.estimated_marginal_roas > m ? e.estimated_marginal_roas : m), 0);
  return { metaScore, evidence, flags };
}

// ── Storefront side ──────────────────────────────────────────────────────────────

/** Posterior shape the bandit persists onto `storefront_experiments.last_decision.posteriors[]`
 *  (see [[./storefront/bandit]] `ArmPosterior`). Re-typed here so the reader stays decoupled
 *  from the bandit internals — the field set we touch is small. */
export interface StorefrontLastDecisionPosterior {
  variant_id: string;
  is_control: boolean;
  sessions: number;
  conversions: number;
  alpha: number;
  beta: number;
  winProb?: number | null;
  ltvPerSession: number;
}

export interface StorefrontLastDecision {
  action: "promote" | "kill" | "hold" | "rolled_back" | string;
  rule: string;
  win_prob: number | null;
  posteriors: StorefrontLastDecisionPosterior[];
  /** Set by [[./storefront/experiment-delivery-audit]] when the served-arm telemetry
   *  doesn't match what the bandit was told it served. The bandit refuses to act on
   *  this experiment; we mirror that and skip it as a leverage signal. */
  delivery_flag?: string;
  at?: string;
}

export interface StorefrontExperimentRow {
  id: string;
  lever: string;
  lander_type: string;
  last_decision: StorefrontLastDecision | null;
}

export interface StorefrontLeverageEvidence {
  experiment_id: string;
  lever: string;
  lander_type: string;
  /** The candidate variant we'd promote. */
  winning_variant_id: string;
  /** Posterior P(arm > control) the bandit computed last refresh. */
  win_prob: number;
  /** LTV lift per session (cents) of the winning arm over control. */
  ltv_lift_per_session_cents: number;
  /** `win_prob × ltv_lift_per_session_cents` — the "expected promote payoff." Used as the score. */
  expected_lift_cents: number;
  /** The bandit's last rule (`win_prob>=0.95`, `below_min_exposure(200)`, etc). */
  rule: string;
  rationale: string;
}

export interface StorefrontMarginalLeverageResult {
  /** Best `expected_lift_cents` across running experiments. `null` when no experiment has a
   *  usable last_decision. */
  storefrontScore: number | null;
  evidence: StorefrontLeverageEvidence[];
  flags: string[];
}

/**
 * Pure scorer — takes the already-fetched running storefront experiments (with their
 * `last_decision` snapshots) and returns the marginal-leverage result. DB-free.
 */
export function scoreStorefrontMarginalLeverage(input: {
  experiments: StorefrontExperimentRow[];
}): StorefrontMarginalLeverageResult {
  const evidence: StorefrontLeverageEvidence[] = [];
  const flags: string[] = [];

  for (const exp of input.experiments) {
    const ld = exp.last_decision;
    if (!ld || !Array.isArray(ld.posteriors) || ld.posteriors.length === 0) {
      flags.push(`experiment ${exp.id} (${exp.lever}) has no last_decision posteriors yet`);
      continue;
    }
    if (ld.delivery_flag === "failed_to_deliver") {
      flags.push(`experiment ${exp.id} (${exp.lever}) suspended on delivery-audit failure — not a usable signal`);
      continue;
    }
    const control = ld.posteriors.find((p) => p.is_control);
    if (!control) {
      flags.push(`experiment ${exp.id} (${exp.lever}) has no control arm in last_decision — skipping`);
      continue;
    }
    let best: StorefrontLastDecisionPosterior | null = null;
    for (const arm of ld.posteriors) {
      if (arm.is_control) continue;
      const wp = arm.winProb ?? 0;
      const bestWp = best?.winProb ?? 0;
      if (wp > bestWp) best = arm;
    }
    if (!best || best.winProb == null) {
      flags.push(`experiment ${exp.id} (${exp.lever}) has no scored non-control arm — skipping`);
      continue;
    }
    const liftCents = best.ltvPerSession - control.ltvPerSession;
    const expected = best.winProb * Math.max(liftCents, 0);
    evidence.push({
      experiment_id: exp.id,
      lever: exp.lever,
      lander_type: exp.lander_type,
      winning_variant_id: best.variant_id,
      win_prob: best.winProb,
      ltv_lift_per_session_cents: liftCents,
      expected_lift_cents: expected,
      rule: ld.rule,
      rationale: `${exp.lander_type}/${exp.lever}: candidate variant ${best.variant_id} at ${(best.winProb * 100).toFixed(1)}% win-prob, +${(liftCents / 100).toFixed(2)} LTV/session vs control (rule=${ld.rule})`,
    });
  }

  if (evidence.length === 0) {
    flags.push("no_signal_storefront");
    return { storefrontScore: null, evidence, flags };
  }

  const storefrontScore = evidence.reduce((m, e) => (e.expected_lift_cents > m ? e.expected_lift_cents : m), 0);
  return { storefrontScore, evidence, flags };
}

// ── Data layer ───────────────────────────────────────────────────────────────────

interface ScaleUpTriggerResult {
  trigger: number;
  source: "active_policy" | "default";
}

/** Load the active policy's `scale_up_roas_trigger`. Degrades to the documented default
 *  when no policy is active (or the table doesn't exist yet) — mirrors decision-engine's
 *  "no active policy → degrade safely" pattern. */
async function loadScaleUpRoasTrigger(workspaceId: string): Promise<ScaleUpTriggerResult> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("iteration_policies")
      .select("scale_up_roas_trigger")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return { trigger: DEFAULT_SCALE_UP_ROAS_TRIGGER, source: "default" };
    const trig = Number((data as { scale_up_roas_trigger?: unknown }).scale_up_roas_trigger ?? NaN);
    if (!Number.isFinite(trig) || trig <= 0) return { trigger: DEFAULT_SCALE_UP_ROAS_TRIGGER, source: "default" };
    return { trigger: trig, source: "active_policy" };
  } catch {
    return { trigger: DEFAULT_SCALE_UP_ROAS_TRIGGER, source: "default" };
  }
}

/**
 * Survey Meta's marginal-leverage signal for one workspace × ad-account on one snapshot
 * date. Reads only the engine's persisted outputs (scorecards + pending recommendations),
 * never the raw insights tables — same invariant as [[./meta/decision-engine]].
 */
export async function readMetaMarginalLeverage(params: {
  workspaceId: string;
  adAccountId: string;
  snapshotDate: string;
}): Promise<MetaMarginalLeverageResult> {
  const admin = createAdminClient();
  const { workspaceId, adAccountId, snapshotDate } = params;

  const [scorecardsRes, recsRes, trig] = await Promise.all([
    admin
      .from("iteration_scorecards_daily")
      .select("id, level, object_id, label, snapshot_date, spend_cents, revenue_cents, roas, ctr_declining, frequency_rising, fatigue_score")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_account_id", adAccountId)
      .eq("snapshot_date", snapshotDate)
      .in("level", ["adset", "campaign"]),
    admin
      .from("iteration_recommendations")
      .select("id, action_type, title, confidence, source_metrics, source_scorecard_ids")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_account_id", adAccountId)
      .eq("status", "pending"),
    loadScaleUpRoasTrigger(workspaceId),
  ]);

  const flags: string[] = [];
  if (scorecardsRes.error) flags.push(`scorecards read failed: ${scorecardsRes.error.message}`);
  if (recsRes.error) flags.push(`recommendations read failed: ${recsRes.error.message}`);

  const scorecards = (scorecardsRes.data ?? []) as MetaScorecardRow[];
  const recommendations = (recsRes.data ?? []) as MetaPendingRecommendationRow[];

  const scored = scoreMetaMarginalLeverage({
    scorecards,
    recommendations,
    scaleUpRoasTrigger: trig.trigger,
  });

  if (trig.source === "default") {
    flags.push(`scale_up_roas_trigger=${trig.trigger.toFixed(2)} (default — no active iteration_policies row)`);
  }
  return { ...scored, flags: [...flags, ...scored.flags] };
}

/**
 * Survey the storefront tool's marginal-leverage signal for one workspace. Reads the
 * `last_decision` snapshot the bandit refresh persists onto every running experiment.
 * Promoted/killed/rolled-back experiments are NOT candidates — only `running` rows have
 * an open lever to pull.
 */
export async function readStorefrontMarginalLeverage(params: {
  workspaceId: string;
}): Promise<StorefrontMarginalLeverageResult> {
  const admin = createAdminClient();
  const { workspaceId } = params;

  const { data, error } = await admin
    .from("storefront_experiments")
    .select("id, lever, lander_type, last_decision")
    .eq("workspace_id", workspaceId)
    .eq("status", "running");

  const flags: string[] = [];
  if (error) flags.push(`storefront_experiments read failed: ${error.message}`);

  const experiments = (data ?? []) as StorefrontExperimentRow[];
  const scored = scoreStorefrontMarginalLeverage({ experiments });
  return { ...scored, flags: [...flags, ...scored.flags] };
}
