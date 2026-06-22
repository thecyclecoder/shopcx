/**
 * Thompson-sampling bandit over storefront experiment variants — Phase 4 of the
 * storefront experiment + bandit framework
 * (docs/brain/specs/storefront-experiment-bandit-framework.md).
 *
 * Pure math + decision logic (no DB). Given the per-variant posteriors persisted by
 * Phase 3 ([[storefront-experiment-attribution]]) it:
 *   (a) reports each arm's posterior win-probability vs the control/holdout, and
 *   (b) decides promote / kill / hold at a significance + minimum-exposure floor.
 *
 * Runs CONSERVATIVELY until M3's LTV-proxy reconciler has calibrated once: a tighter
 * promote threshold + a higher exposure floor (the goal's "run conservatively until
 * the slow loop calibrates" rule). The actual traffic-share throttle lives in
 * [[storefront-experiments]] `assignVariant` (conservative explore share).
 */
import type { VariantRollupResult } from "@/lib/storefront/experiment-attribution";

export type BanditAction = "promote" | "kill" | "hold";

export interface BanditThresholds {
  /** Win-prob over control required to promote a variant. */
  promoteWinProb: number;
  /** If the BEST variant's win-prob over control is at/below this, control clearly
   *  wins → kill the experiment. */
  killWinProb: number;
  /** Minimum exposed sessions on BOTH the candidate arm and control before any
   *  promote/kill fires. */
  minExposureFloor: number;
}

export const NORMAL_THRESHOLDS: BanditThresholds = {
  promoteWinProb: 0.95,
  killWinProb: 0.05,
  minExposureFloor: 200,
};

/** Tighter promote bar + higher floor while M3 is uncalibrated (conservative). */
export const CONSERVATIVE_THRESHOLDS: BanditThresholds = {
  promoteWinProb: 0.99,
  killWinProb: 0.02,
  minExposureFloor: 500,
};

export function thresholdsFor(conservative: boolean): BanditThresholds {
  return conservative ? CONSERVATIVE_THRESHOLDS : NORMAL_THRESHOLDS;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

type Rng = () => number;

/** Standard-normal sample (Box–Muller). */
function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(k,1) sample (Marsaglia–Tsang). */
function sampleGamma(k: number, rng: Rng): number {
  if (k < 1) return sampleGamma(1 + k, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded loop — accept/reject converges in ~1-2 iters; cap defends against a
  // pathological rng.
  for (let i = 0; i < 1000; i++) {
    let x = 0;
    let vv = 0;
    do {
      x = gaussian(rng);
      vv = 1 + c * x;
    } while (vv <= 0);
    vv = vv * vv * vv;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * vv;
    if (Math.log(u) < 0.5 * x * x + d * (1 - vv + Math.log(vv))) return d * vv;
  }
  return d; // fallback (mean)
}

/** Beta(alpha,beta) sample via two Gamma draws. */
export function sampleBeta(alpha: number, beta: number, rng: Rng = Math.random): number {
  const x = sampleGamma(Math.max(alpha, 1e-6), rng);
  const y = sampleGamma(Math.max(beta, 1e-6), rng);
  return x / (x + y);
}

/** Monte-Carlo P(armPosterior > controlPosterior) over the Beta-Bernoulli proxy. */
export function winProbabilityVsControl(
  arm: { alpha: number; beta: number },
  control: { alpha: number; beta: number },
  draws = 4000,
  rng: Rng = Math.random,
): number {
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    if (sampleBeta(arm.alpha, arm.beta, rng) > sampleBeta(control.alpha, control.beta, rng)) wins++;
  }
  return wins / draws;
}

// ── Decision ────────────────────────────────────────────────────────────────

export interface ArmPosterior {
  variant_id: string;
  is_control: boolean;
  sessions: number;
  conversions: number;
  alpha: number;
  beta: number;
  /** P(this arm beats control) — undefined for the control arm itself. */
  winProb?: number;
  /** Mean of the LTV-proxy reward per session (cents). */
  ltvPerSession: number;
}

export interface BanditDecision {
  action: BanditAction;
  winnerVariantId: string | null;
  winProb: number | null;
  rule: string;
  posteriors: ArmPosterior[];
}

/**
 * Decide an experiment's next move from its variant rollups. Pure; the caller
 * persists the status flip + the snapshot.
 */
export function decideExperiment(
  rollups: VariantRollupResult[],
  opts: { conservative: boolean; draws?: number; rng?: Rng },
): BanditDecision {
  const th = thresholdsFor(opts.conservative);
  const control = rollups.find((r) => r.is_control);
  const arms = rollups.filter((r) => !r.is_control);

  const posteriors: ArmPosterior[] = rollups.map((r) => ({
    variant_id: r.variant_id,
    is_control: r.is_control,
    sessions: r.sessions,
    conversions: r.conversions,
    alpha: r.alpha,
    beta: r.beta,
    ltvPerSession: r.sessions > 0 ? r.ltv_proxy_cents / r.sessions : 0,
  }));

  if (!control || arms.length === 0) {
    return { action: "hold", winnerVariantId: null, winProb: null, rule: "no_control_or_arms", posteriors };
  }

  // Win-probability of each arm vs control.
  for (const p of posteriors) {
    if (p.is_control) continue;
    p.winProb = winProbabilityVsControl(p, control, opts.draws ?? 4000, opts.rng);
  }

  // Best arm by win-probability.
  const best = posteriors
    .filter((p) => !p.is_control)
    .sort((a, b) => (b.winProb ?? 0) - (a.winProb ?? 0))[0];
  const winProb = best.winProb ?? 0;
  const exposureMet = best.sessions >= th.minExposureFloor && control.sessions >= th.minExposureFloor;

  if (!exposureMet) {
    return {
      action: "hold",
      winnerVariantId: null,
      winProb,
      rule: `below_min_exposure(${th.minExposureFloor})`,
      posteriors,
    };
  }
  if (winProb >= th.promoteWinProb) {
    return {
      action: "promote",
      winnerVariantId: best.variant_id,
      winProb,
      rule: `win_prob>=${th.promoteWinProb}${opts.conservative ? "(conservative)" : ""}`,
      posteriors,
    };
  }
  if (winProb <= th.killWinProb) {
    return {
      action: "kill",
      winnerVariantId: null,
      winProb,
      rule: `win_prob<=${th.killWinProb}(control_wins)`,
      posteriors,
    };
  }
  return { action: "hold", winnerVariantId: null, winProb, rule: "inconclusive", posteriors };
}
