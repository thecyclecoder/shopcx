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
import { recordDirectorActivity } from "@/lib/director-activity";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { getEffectiveAdSpendBudget, rollupAdSpendActual } from "@/lib/ad-spend-governor";
import { computeBlendedCacLtv } from "@/lib/blended-cac-ltv";

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

// ── Phase 2 — Allocation decision composer ───────────────────────────────────────
//
// Pure composer that maps the M2 blended objective + each tool's marginal-leverage
// signal + the current ad-spend ceiling state into ONE typed AllocationDecision.
// No DB calls — the caller fans out [[./blended-cac-ltv]] + the Phase-1 readers
// + [[./ad-spend-governor]] `getEffectiveAdSpendBudget`/`rollupAdSpendActual` and
// hands the assembled snapshot in. Phase 3 stamps `director_activity` per kind
// (`allocated_spend` / `escalated_ceiling_raise` / `allocation_no_useful_lever`)
// and routes `escalate_*` to `escalateDiagnosisToCeo`.
//
// Decision rules — the supervisable-autonomy spine (operational-rules § north star:
// hit a rail → escalate, never execute):
//   1. No useful lever on either side → `no_useful_lever`; UNLESS the ceiling is
//      tapped AND blended is healthy → `escalate_new_platform` (we'd love to spend
//      more but neither tool can absorb it — that's the CEO's "open a new channel"
//      call, never the director's).
//   2. Meta is the candidate AND its marginal ROAS would DEGRADE the blended target
//      (estimated_marginal_roas < blended.targetCacLtv) → `hold`. This is the
//      explicit Goodhart guard from M2 — a tool's local win that hurts the
//      single TOP-LINE is rejected, not executed.
//   3. Meta is the candidate AND the proposed scale-up step would EXCEED the
//      effective `ad_spend_budgets` ceiling → `escalate_ceiling_raise`. Within-
//      ceiling is the director's leash; raising it is the CEO's call (mirrors
//      [[./ad-spend-governor]]).
//   4. Meta candidate, accretive to blended, within ceiling → `reallocate_within_ceiling`
//      typed for the [[../tables/iteration_policies]] path (a scale_up of the cited
//      scorecard/recommendation object).
//   5. Storefront candidate (no ad-spend ceiling involved) → `reallocate_within_ceiling`
//      typed for the [[../tables/storefront_optimizer_policy]] path (promote the
//      winning bandit variant).

/** Default scale-up step (10% of the current rolling-window spend) when the caller
 *  doesn't pass a `proposedDeltaCents` override. Mirrors the spirit of
 *  [[../tables/iteration_policies]] `scale_up_step_pct` without coupling the pure
 *  composer to that table — Phase 3's wiring may pass the active policy's value. */
export const DEFAULT_ALLOCATION_SCALE_UP_STEP_PCT = 0.1;

/** The slice of [[./blended-cac-ltv]] `BlendedCacLtvResult` the composer reads — the
 *  ratio + its target. Defined here so the composer's input type stays decoupled from
 *  the M2 helper's full result shape. */
export interface AllocationBlendedSnapshot {
  /** blendedLtvCents / blendedCAC; `null` when no new customers / no spend in window. */
  cacLtvRatio: number | null;
  /** The target setpoint from `assumptions.targetCacLtv` (default 3 from M2 — healthy DTC). */
  targetCacLtv: number;
}

/** Ceiling-side snapshot for the workspace × ad-account axis the composer is deciding on.
 *  Caller assembles this from [[./ad-spend-governor]] `getEffectiveAdSpendBudget` +
 *  `rollupAdSpendActual`. `ceilingCents=null` ⇒ no budget row set (the composer treats
 *  any Meta scale-up as in-leash but flags the missing ceiling). */
export interface AllocationCeilingState {
  platform: "meta" | "google" | "amazon";
  metaAdAccountId: string | null;
  windowDays: number;
  /** Effective rolling-window ceiling for the platform/account. `null` when unset. */
  ceilingCents: number | null;
  /** Sum of actual spend over the same window (today, UTC). */
  currentSpendCents: number;
  /** Override for the proposed Meta scale-up delta in cents. When omitted the composer
   *  derives it as `round(currentSpendCents * DEFAULT_ALLOCATION_SCALE_UP_STEP_PCT)`,
   *  floored at 1 cent so a from-zero spend can still propose a $X test budget. */
  proposedDeltaCents?: number;
}

export type AllocationDecisionKind =
  | "reallocate_within_ceiling"
  | "hold"
  | "no_useful_lever"
  | "escalate_ceiling_raise"
  | "escalate_new_platform";

/** Typed Meta side-lever for the [[../tables/iteration_policies]] path. */
export interface AllocationMetaLever {
  tool: "meta";
  action: "scale_up";
  /** The scorecard row the decision cites (when sourced from `scorecard_scale_up`). */
  scorecard_id?: string;
  /** The pending recommendation row (when sourced from `pending_recommendation`). */
  recommendation_id?: string;
  meta_ad_account_id: string | null;
  object_id?: string;
  label?: string | null;
}

/** Typed Storefront side-lever for the [[../tables/storefront_optimizer_policy]] path. */
export interface AllocationStorefrontLever {
  tool: "storefront";
  action: "promote";
  experiment_id: string;
  variant_id: string;
  lever: string;
  lander_type: string;
}

export type AllocationLever = AllocationMetaLever | AllocationStorefrontLever;

/** The evidence the composer is leaning on — a flat ledger of every signal the input
 *  carried, plus a `tool` tag so a downstream board can render per-side. */
export interface AllocationDecisionEvidence {
  tool: "meta" | "storefront" | "ceiling" | "blended";
  rationale: string;
  /** A primitive numeric the decision was leaning on (marginal ROAS, expected_lift cents, etc). */
  value?: number;
  /** Cite-back identifiers (scorecard_id / recommendation_id / experiment_id / variant_id, etc). */
  source_ids?: Record<string, string | null>;
}

export interface AllocationDecision {
  kind: AllocationDecisionKind;
  rationale: string;
  /** Set when `kind='reallocate_within_ceiling'`. */
  toLever?: AllocationLever;
  /** Cents moved (Meta scale-up) — set with `toLever.tool='meta'`. Storefront promotes carry no spend. */
  amountCents?: number;
  /** The Meta ad-account the move is sourced from (for an account-scoped Meta move). */
  fromAccountId?: string;
  evidence: AllocationDecisionEvidence[];
  /** Non-blocking caveats (no ceiling row set, mixed assumptions, etc). */
  flags: string[];
}

export interface ComposeAllocationDecisionParams {
  workspaceId: string;
  blended: AllocationBlendedSnapshot;
  metaSignal: MetaMarginalLeverageResult;
  storefrontSignal: StorefrontMarginalLeverageResult;
  ceilingState: AllocationCeilingState;
  /** Override the default 10% scale-up step. */
  scaleUpStepPct?: number;
}

function bestMetaEvidence(metaSignal: MetaMarginalLeverageResult): MetaLeverageEvidence | null {
  if (!metaSignal.evidence.length) return null;
  return metaSignal.evidence.reduce((best, e) =>
    e.estimated_marginal_roas > best.estimated_marginal_roas ? e : best,
  );
}

function bestStorefrontEvidence(s: StorefrontMarginalLeverageResult): StorefrontLeverageEvidence | null {
  if (!s.evidence.length) return null;
  return s.evidence.reduce((best, e) => (e.expected_lift_cents > best.expected_lift_cents ? e : best));
}

function deriveProposedDelta(ceiling: AllocationCeilingState, stepPct: number): number {
  if (ceiling.proposedDeltaCents != null) return Math.max(0, Math.round(ceiling.proposedDeltaCents));
  return Math.max(1, Math.round(ceiling.currentSpendCents * stepPct));
}

function blendedHealthy(blended: AllocationBlendedSnapshot): boolean {
  return blended.cacLtvRatio != null && blended.cacLtvRatio >= blended.targetCacLtv;
}

/**
 * Compose ONE typed `AllocationDecision` from the M2 blended objective + each tool's
 * marginal-leverage signal + the current ad-spend ceiling state. Pure — see file
 * header for the decision rules. Phase 3 wires this into `runGrowthDirectorJob` and
 * stamps `director_activity` per kind.
 */
export function composeAllocationDecision(params: ComposeAllocationDecisionParams): AllocationDecision {
  const { blended, metaSignal, storefrontSignal, ceilingState } = params;
  const stepPct = params.scaleUpStepPct ?? DEFAULT_ALLOCATION_SCALE_UP_STEP_PCT;
  const evidence: AllocationDecisionEvidence[] = [];
  const flags: string[] = [];

  // Surface the blended snapshot up front — every decision's first cite is the top-line ratio.
  evidence.push({
    tool: "blended",
    rationale:
      blended.cacLtvRatio == null
        ? `blended CAC:LTV ratio undefined this window (target ${blended.targetCacLtv.toFixed(2)}×)`
        : `blended CAC:LTV ratio ${blended.cacLtvRatio.toFixed(2)}× vs ${blended.targetCacLtv.toFixed(2)}× target`,
    value: blended.cacLtvRatio ?? undefined,
  });

  // Ceiling snapshot — every Meta-side branch reads it.
  evidence.push({
    tool: "ceiling",
    rationale:
      ceilingState.ceilingCents == null
        ? `no ad_spend_budgets ceiling set for ${ceilingState.platform}${ceilingState.metaAdAccountId ? `/${ceilingState.metaAdAccountId}` : ""}`
        : `${ceilingState.platform}${ceilingState.metaAdAccountId ? `/${ceilingState.metaAdAccountId}` : ""} ${ceilingState.windowDays}d window: $${(ceilingState.currentSpendCents / 100).toFixed(2)} actual vs $${(ceilingState.ceilingCents / 100).toFixed(2)} ceiling`,
    value: ceilingState.ceilingCents ?? undefined,
  });
  if (ceilingState.ceilingCents == null) {
    flags.push("no_ceiling_set");
  }

  const meta = bestMetaEvidence(metaSignal);
  const sf = bestStorefrontEvidence(storefrontSignal);
  const metaHasSignal = meta != null && (metaSignal.metaScore ?? 0) > 0;
  const storefrontHasSignal = sf != null;

  // Roll the per-side signal flags up so the activity ledger sees them.
  for (const f of metaSignal.flags) flags.push(`meta: ${f}`);
  for (const f of storefrontSignal.flags) flags.push(`storefront: ${f}`);

  // ── 1. No useful lever ─────────────────────────────────────────────────────────
  if (!metaHasSignal && !storefrontHasSignal) {
    const ceilingTapped =
      ceilingState.ceilingCents != null && ceilingState.currentSpendCents >= ceilingState.ceilingCents;
    if (ceilingTapped && blendedHealthy(blended)) {
      return {
        kind: "escalate_new_platform",
        rationale:
          `Neither Meta nor Storefront has a useful next-dollar lever, blended CAC:LTV is healthy (${blended.cacLtvRatio?.toFixed(2)}× ≥ ${blended.targetCacLtv.toFixed(2)}×), and the ${ceilingState.platform} ceiling is fully tapped — escalating to the CEO to open a new acquisition channel.`,
        evidence,
        flags,
      };
    }
    return {
      kind: "no_useful_lever",
      rationale:
        `Neither Meta nor Storefront surfaced a marginal-leverage signal this pass — holding without action${ceilingTapped ? " (ceiling tapped)" : ""}.`,
      evidence,
      flags,
    };
  }

  // ── 2. Goodhart guard — a Meta scale-up that DEGRADES the blended is rejected ──
  // Only relevant when Meta is the candidate; if storefront also has a usable lever,
  // we fall through and prefer storefront below.
  const metaDegradesBlended =
    metaHasSignal && meta != null && meta.estimated_marginal_roas < blended.targetCacLtv;

  if (metaHasSignal && meta != null) {
    evidence.push({
      tool: "meta",
      rationale: `Meta marginal lever: ${meta.rationale}`,
      value: meta.estimated_marginal_roas,
      source_ids: {
        scorecard_id: meta.scorecard_id ?? null,
        recommendation_id: meta.recommendation_id ?? null,
        object_id: meta.object_id ?? null,
      },
    });
  }
  if (storefrontHasSignal && sf != null) {
    evidence.push({
      tool: "storefront",
      rationale: `Storefront marginal lever: ${sf.rationale}`,
      value: sf.expected_lift_cents,
      source_ids: { experiment_id: sf.experiment_id, variant_id: sf.winning_variant_id },
    });
  }

  // ── 3 + 4. Meta candidate path ─────────────────────────────────────────────────
  // Prefer Meta unless it would degrade blended (and storefront has nothing). If meta
  // degrades AND storefront has a useful lever, we fall through to storefront.
  if (metaHasSignal && meta != null && !metaDegradesBlended) {
    const proposedDeltaCents = deriveProposedDelta(ceilingState, stepPct);
    const wouldBreachCeiling =
      ceilingState.ceilingCents != null &&
      ceilingState.currentSpendCents + proposedDeltaCents > ceilingState.ceilingCents;

    if (wouldBreachCeiling) {
      const overshootCents =
        ceilingState.currentSpendCents + proposedDeltaCents - (ceilingState.ceilingCents ?? 0);
      return {
        kind: "escalate_ceiling_raise",
        rationale:
          `Meta has a high-leverage scale-up (${meta.rationale}), but the proposed +$${(proposedDeltaCents / 100).toFixed(2)} step would push the ${ceilingState.windowDays}d window $${(overshootCents / 100).toFixed(2)} over the $${((ceilingState.ceilingCents ?? 0) / 100).toFixed(2)} ceiling. Director's leash: raising the ceiling is the CEO's call.`,
        fromAccountId: ceilingState.metaAdAccountId ?? undefined,
        amountCents: proposedDeltaCents,
        evidence,
        flags,
      };
    }

    return {
      kind: "reallocate_within_ceiling",
      rationale:
        `Meta scale-up is accretive to the blended target (marginal ${meta.estimated_marginal_roas.toFixed(2)}× ≥ ${blended.targetCacLtv.toFixed(2)}× target) and within the ${ceilingState.windowDays}d ceiling — moving +$${(proposedDeltaCents / 100).toFixed(2)} via iteration_policies (scale_up).`,
      toLever: {
        tool: "meta",
        action: "scale_up",
        scorecard_id: meta.scorecard_id,
        recommendation_id: meta.recommendation_id,
        meta_ad_account_id: ceilingState.metaAdAccountId,
        object_id: meta.object_id,
        label: meta.label,
      },
      fromAccountId: ceilingState.metaAdAccountId ?? undefined,
      amountCents: proposedDeltaCents,
      evidence,
      flags,
    };
  }

  // ── 5. Storefront candidate path ───────────────────────────────────────────────
  if (storefrontHasSignal && sf != null) {
    return {
      kind: "reallocate_within_ceiling",
      rationale:
        `Storefront has the strongest within-ceiling lever today (${sf.rationale}) — promoting via storefront_optimizer_policy.` +
        (metaDegradesBlended
          ? ` Meta's surfaced lever (marginal ${meta?.estimated_marginal_roas.toFixed(2)}×) was rejected as a Goodhart move — it would degrade the ${blended.targetCacLtv.toFixed(2)}× blended target.`
          : ""),
      toLever: {
        tool: "storefront",
        action: "promote",
        experiment_id: sf.experiment_id,
        variant_id: sf.winning_variant_id,
        lever: sf.lever,
        lander_type: sf.lander_type,
      },
      evidence,
      flags,
    };
  }

  // Meta had signal but it degrades blended; storefront has nothing usable → hold.
  return {
    kind: "hold",
    rationale:
      `Meta's only candidate lever (marginal ${meta?.estimated_marginal_roas.toFixed(2)}×) is below the ${blended.targetCacLtv.toFixed(2)}× blended target — scaling it would DEGRADE the top-line, so holding rather than executing the proxy win (Goodhart guard).`,
    evidence,
    flags,
  };
}

// ── Phase 3 — director_activity stamp + box-lane wiring ──────────────────────────
//
// One end-to-end "daily Growth Director allocation pass" per (workspace, ad-account).
// Composes the cross-tool decision and stamps the supervisable-autonomy ledger so the
// share of autonomous reallocations is auditable — the success metric the M2 goal names.
//
// Steps:
//   1. Resolve the active `ad_spend_budgets` row for the (workspace, ad-account) →
//      window length, ceiling cents.
//   2. Snapshot the blended CAC:LTV objective ([[./blended-cac-ltv]]) for the same
//      rolling window ending on `snapshotDate`.
//   3. Read both marginal-leverage signals (Phase 1 readers) and the current rolling
//      Meta spend ([[./ad-spend-governor]] `rollupAdSpendActual`) for the same window.
//   4. Compose ONE typed `AllocationDecision` (Phase 2 composer).
//   5. Write a [[../tables/director_activity]] row (`director_function='growth'`) with
//      the per-decision `action_kind` (see `allocationDecisionToActionKind`) and the
//      full `{ decision, evidence, ceiling_state, blended, flags }` metadata.
//   6. For an `escalate_*` decision, fire `escalateDiagnosisToCeo` so the CEO inbox
//      lights up (`escalationKind='budget_raise'|'new_platform'`). The platform-director
//      helper is notification-first + dedupes on `dashboard_notifications.metadata->>dedupe_key`,
//      so a surfaced escalation pings the CEO exactly once until dismissed.
//
// Wired into the existing `meta-iteration-run` Inngest chain as the post-stage-7 step
// so the allocation decision lands AFTER the iteration engine settles its same-day
// actions (Phase 6a → 6b → 7 → 8 = this pass).

/** The director_function slug this writer stamps on every activity row. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Fallback window when no `ad_spend_budgets` row is configured for the account. Mirrors the
 *  governor's default 7-day rolling window so the blended snapshot + the ceiling state agree. */
export const ALLOCATION_DEFAULT_WINDOW_DAYS = 7;

/** Deep-link the CEO escalation drops into — mirrors [[./ad-spend-governor]] `AD_SPEND_DEEP_LINK`
 *  so the same Marketing → Ads surface owns both ceiling-breach + ceiling-raise + new-platform asks. */
const GROWTH_ALLOCATION_DEEP_LINK = "/dashboard/marketing/ads";

/**
 * The discriminated `director_activity.action_kind` vocabulary this lane emits. Open vocabulary
 * (no CHECK on the column) — declared in code so callers + the brain page stay in sync.
 *
 * Map AllocationDecisionKind → director_activity row:
 *   reallocate_within_ceiling  → action_kind: "allocated_spend"
 *   hold                        → action_kind: "allocation_no_useful_lever" (Goodhart-guarded — same audit
 *                                  bucket as no_useful_lever; the rationale + flags carry the why)
 *   no_useful_lever             → action_kind: "allocation_no_useful_lever"
 *   escalate_ceiling_raise      → action_kind: "escalated_ceiling_raise"  (+ escalationKind 'budget_raise')
 *   escalate_new_platform       → action_kind: "escalated_new_platform"   (+ escalationKind 'new_platform')
 */
export type GrowthAllocationActionKind =
  | "allocated_spend"
  | "allocation_no_useful_lever"
  | "escalated_ceiling_raise"
  | "escalated_new_platform";

/** The escalation kind the CEO notification carries. Both routes share the Marketing → Ads deep-link;
 *  only the kind distinguishes "raise an existing ceiling" from "open a new acquisition channel." */
export type GrowthAllocationEscalationKind = "budget_raise" | "new_platform";

/** Pure: AllocationDecisionKind → the audit-ledger action_kind. */
export function allocationDecisionToActionKind(kind: AllocationDecisionKind): GrowthAllocationActionKind {
  switch (kind) {
    case "reallocate_within_ceiling":
      return "allocated_spend";
    case "escalate_ceiling_raise":
      return "escalated_ceiling_raise";
    case "escalate_new_platform":
      return "escalated_new_platform";
    case "hold":
    case "no_useful_lever":
      return "allocation_no_useful_lever";
  }
}

/** Pure: AllocationDecisionKind → the CEO `escalationKind` (null when the decision is not an escalation). */
export function allocationDecisionToEscalationKind(kind: AllocationDecisionKind): GrowthAllocationEscalationKind | null {
  if (kind === "escalate_ceiling_raise") return "budget_raise";
  if (kind === "escalate_new_platform") return "new_platform";
  return null;
}

export interface RunGrowthAllocationPassParams {
  workspaceId: string;
  adAccountId: string;
  /** The UTC day the iteration engine just settled on — the window endpoint for the blended
   *  snapshot + the marginal-leverage reads. */
  snapshotDate: string;
}

export interface RunGrowthAllocationPassResult {
  decision: AllocationDecision;
  /** The action_kind stamped on the director_activity row. */
  actionKind: GrowthAllocationActionKind;
  /** Whether the director_activity insert landed (best-effort writer, never throws). */
  activityRecorded: boolean;
  /** Set on `escalate_*` kinds — whether the CEO notification was emitted (dedup may swallow). */
  escalation?: { emitted: boolean; escalationKind: GrowthAllocationEscalationKind };
  /** The ceiling state the composer reasoned over — handy for callers that log a stage summary. */
  ceilingState: AllocationCeilingState;
  /** The blended snapshot the composer reasoned over. */
  blended: AllocationBlendedSnapshot;
}

function computeWindowStartDate(snapshotDate: string, windowDays: number): string {
  const d = new Date(`${snapshotDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (windowDays - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * One Growth-Director allocation pass for ONE (workspace, ad-account) snapshot. Composes the
 * cross-tool decision, stamps the audit ledger, and routes escalations. Best-effort against
 * transient read errors — every input source has a documented degrade-safely path (no ceiling
 * row → null + `no_ceiling_set` flag; no signal on either side → `no_useful_lever`).
 */
export async function runGrowthAllocationPass(
  params: RunGrowthAllocationPassParams,
): Promise<RunGrowthAllocationPassResult> {
  const admin = createAdminClient();
  const { workspaceId, adAccountId, snapshotDate } = params;

  // 1. Active Meta ceiling for this (workspace, ad-account) — windowDays + ceilingCents.
  let ceilingCents: number | null = null;
  let windowDays = ALLOCATION_DEFAULT_WINDOW_DAYS;
  try {
    const budget = await getEffectiveAdSpendBudget(admin, workspaceId, {
      platform: "meta",
      metaAdAccountId: adAccountId,
    });
    if (budget) {
      ceilingCents = budget.usdCeilingCents;
      windowDays = budget.windowDays;
    }
  } catch {
    /* degrade-safely: composer will flag `no_ceiling_set` */
  }

  // 2-3. Parallel reads — blended snapshot, both marginal-leverage readers, current rolling spend.
  const startDate = computeWindowStartDate(snapshotDate, windowDays);
  const [blendedResult, metaSignal, storefrontSignal, currentSpend] = await Promise.all([
    computeBlendedCacLtv({ workspaceId, startDate, endDate: snapshotDate }).catch(() => null),
    readMetaMarginalLeverage({ workspaceId, adAccountId, snapshotDate }),
    readStorefrontMarginalLeverage({ workspaceId }),
    rollupAdSpendActual(admin, {
      workspaceId,
      platform: "meta",
      metaAdAccountId: adAccountId,
      windowDays,
      asOfDate: snapshotDate,
    }).catch(() => ({ actualCents: 0, toDate: snapshotDate, sinceDate: startDate, windowDays })),
  ]);

  const blended: AllocationBlendedSnapshot = blendedResult
    ? { cacLtvRatio: blendedResult.cacLtvRatio, targetCacLtv: blendedResult.assumptions.targetCacLtv }
    : { cacLtvRatio: null, targetCacLtv: 3 };

  const ceilingState: AllocationCeilingState = {
    platform: "meta",
    metaAdAccountId: adAccountId,
    windowDays,
    ceilingCents,
    currentSpendCents: currentSpend.actualCents,
  };

  // 4. Compose ONE typed AllocationDecision.
  const decision = composeAllocationDecision({
    workspaceId,
    blended,
    metaSignal,
    storefrontSignal,
    ceilingState,
  });

  // 5. Stamp director_activity (open vocabulary; map decision.kind → action_kind).
  const actionKind = allocationDecisionToActionKind(decision.kind);
  const activityMetadata = {
    decision: {
      kind: decision.kind,
      rationale: decision.rationale,
      toLever: decision.toLever ?? null,
      amountCents: decision.amountCents ?? null,
      fromAccountId: decision.fromAccountId ?? null,
    },
    evidence: decision.evidence,
    ceiling_state: ceilingState,
    blended,
    flags: decision.flags,
    snapshot_date: snapshotDate,
    autonomous: true,
  };
  const activity = await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind,
    specSlug: null,
    reason: decision.rationale,
    metadata: activityMetadata,
  });

  // 6. Escalations route to the CEO inbox via the shared platform-director helper. Dedupe-keyed
  //    per (escalationKind, workspace, ad-account) so a still-tapped ceiling pings the CEO once
  //    until dismissed.
  let escalation: RunGrowthAllocationPassResult["escalation"];
  const escalationKind = allocationDecisionToEscalationKind(decision.kind);
  if (escalationKind) {
    const dedupeKey = `growth_allocation:${escalationKind}:${workspaceId}:${adAccountId}`;
    const title =
      escalationKind === "budget_raise"
        ? `Growth: ad-spend ceiling raise needed (${adAccountId.slice(0, 8)})`
        : "Growth: open a new acquisition channel";
    const r = await escalateDiagnosisToCeo(admin, {
      workspaceId,
      specSlug: null,
      title,
      diagnosis: decision.rationale,
      dedupeKey,
      deepLink: GROWTH_ALLOCATION_DEEP_LINK,
      escalationKind,
      metadata: {
        ad_account_id: adAccountId,
        snapshot_date: snapshotDate,
        decision_kind: decision.kind,
        amount_cents: decision.amountCents ?? null,
        ceiling_cents: ceilingState.ceilingCents,
        current_spend_cents: ceilingState.currentSpendCents,
        window_days: windowDays,
      },
    });
    escalation = { emitted: r.emitted, escalationKind };
  }

  return {
    decision,
    actionKind,
    activityRecorded: activity.recorded,
    escalation,
    ceilingState,
    blended,
  };
}
