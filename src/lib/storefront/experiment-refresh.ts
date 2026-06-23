/**
 * Storefront experiment refresh orchestrator — Phases 3→4→5 of the storefront
 * experiment + bandit framework
 * (docs/brain/specs/storefront-experiment-bandit-framework.md).
 *
 * One refresh, per workspace:
 *   1. Recompute attribution rollups ([[storefront-experiment-attribution]]).
 *   2. Phase 5 guardrail — auto-rollback a serving arm that regresses vs control on
 *      the LTV proxy (≥2 windows) or shows a refund spike; escalate to Growth.
 *   3. Phase 4 bandit decision ([[storefront-bandit]]) — promote a winner / kill a
 *      loser at a significance + min-exposure floor, conservatively until M3
 *      calibrates ([[storefront-calibration]]).
 *   4. Write the supervisable run record ([[storefront_experiment_runs]]).
 *
 * Every promote/kill/rollback persists its triggering posterior snapshot + the rule
 * invoked (north-star supervisability). Driven by [[../inngest/storefront-experiments]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { isProxyCalibrated } from "@/lib/storefront/calibration";
import { refreshExperimentAttribution, type VariantRollupResult } from "@/lib/storefront/experiment-attribution";
import { decideExperiment, type BanditDecision } from "@/lib/storefront/bandit";
import { updatePosterior } from "@/lib/storefront/lever-memory";
import { gradeCampaign } from "@/lib/storefront/campaign-grader";
import { republishExperimentManifest } from "@/lib/storefront/experiment-cache";

/** A serving arm whose LTV-per-session sits this far below control counts as a
 *  regression window. */
export const LTV_REGRESSION_TOLERANCE = 0.15;
/** Consecutive regression windows that trigger auto-rollback. */
export const REGRESSION_WINDOWS_TO_ROLLBACK = 2;
/** Refund-rate excess (over control) on the attributed cohort that triggers an
 *  immediate rollback regardless of the window counter. */
export const REFUND_SPIKE_DELTA = 0.1;
/** Don't let the guardrail or bandit act on noise — both arms need this many
 *  attributed sessions first. */
export const GUARDRAIL_MIN_SESSIONS = 50;

interface ExperimentRowLite {
  id: string;
  status: string;
  promoted_variant_id: string | null;
  regression_windows: number;
  lever: string;
  product_id: string;
  lander_type: string;
  audience: string;
}

export interface ExperimentDecisionRecord {
  experiment_id: string;
  action: "promote" | "kill" | "rolled_back" | "hold";
  win_prob: number | null;
  rule: string;
  posteriors: BanditDecision["posteriors"] | null;
}

export interface RefreshResult {
  run_id: string;
  experiments_evaluated: number;
  conservative: boolean;
  counts: { promoted: number; killed: number; rolled_back: number; held: number };
  escalations: Array<{ experiment_id: string; reason: string }>;
}

function refundRate(r: VariantRollupResult): number {
  return r.conversions > 0 ? r.refunds / r.conversions : 0;
}
function ltvPerSession(r: VariantRollupResult): number {
  return r.sessions > 0 ? r.ltv_proxy_cents / r.sessions : 0;
}

export async function refreshStorefrontExperiments(opts: {
  workspaceId: string;
  trigger: "cron" | "manual";
  windowDays?: number;
  now?: Date;
}): Promise<RefreshResult> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  // Bet size + promote thresholds gate on the single calibration gate (Phase 4): run
  // conservatively until M3's slow loop has truth-checked the predicted-LTV proxy once.
  const conservative = !(await isProxyCalibrated({ workspaceId: opts.workspaceId }));

  // Open the run record.
  const { data: runRow } = await admin
    .from("storefront_experiment_runs")
    .insert({
      workspace_id: opts.workspaceId,
      trigger: opts.trigger,
      status: "running",
      conservative,
      started_at: now.toISOString(),
    })
    .select("id")
    .single();
  const runId = (runRow?.id as string) ?? "";

  const decisions: ExperimentDecisionRecord[] = [];
  const escalations: Array<{ experiment_id: string; reason: string }> = [];
  const counts = { promoted: 0, killed: 0, rolled_back: 0, held: 0 };

  // Commit the lever-importance learning (win OR loss) for a now-terminal experiment.
  // Best-effort: a memory failure never breaks the supervisable refresh run. Idempotent
  // (updatePosterior dedupes by experiment id), so re-processing a terminal experiment
  // never double-counts. The reward is the predicted-LTV-proxy delta from the rollups.
  const commitLearning = async (exp: ExperimentRowLite, rollups: VariantRollupResult[]) => {
    try {
      await updatePosterior({
        workspaceId: opts.workspaceId,
        experiment: {
          id: exp.id,
          product_id: exp.product_id,
          lander_type: exp.lander_type,
          audience: exp.audience,
          lever: exp.lever,
        },
        rollups,
        now,
        admin,
      });
    } catch (e) {
      console.warn(`[storefront-experiments] lever-memory commit failed exp=${exp.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // M5 — grade the now-concluded campaign at significance (the Head-of-Growth feedback signal,
  // [[storefront-campaign-grader]]). Best-effort: a grader failure never breaks the supervisable
  // refresh; idempotent per campaign (gradeCampaign upserts the initial grade in place). Fired
  // for every terminal outcome — promote (win), kill (loss), and rollback — so a sound hypothesis
  // that lost is graded as much as a win.
  const gradeInitialBestEffort = async (experimentId: string) => {
    try {
      await gradeCampaign({ experimentId, mode: "initial", admin });
    } catch (e) {
      console.warn(`[storefront-experiments] campaign-grade(initial) failed exp=${experimentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    // 1. Attribution (idempotent recompute).
    const attribution = await refreshExperimentAttribution({
      workspaceId: opts.workspaceId,
      windowDays: opts.windowDays,
      now,
    });

    // Group rollups by experiment.
    const byExperiment = new Map<string, VariantRollupResult[]>();
    for (const r of attribution.rollups) {
      const arr = byExperiment.get(r.experiment_id) ?? [];
      arr.push(r);
      byExperiment.set(r.experiment_id, arr);
    }

    // Load experiment rows we attributed.
    const expIds = [...byExperiment.keys()];
    const { data: expData } = expIds.length
      ? await admin
          .from("storefront_experiments")
          .select("id, status, promoted_variant_id, regression_windows, lever, product_id, lander_type, audience")
          .in("id", expIds)
      : { data: [] as ExperimentRowLite[] };
    const expById = new Map((expData as ExperimentRowLite[]).map((e) => [e.id, e]));

    for (const [experimentId, rollups] of byExperiment) {
      const exp = expById.get(experimentId);
      if (!exp) continue;
      const control = rollups.find((r) => r.is_control);
      const arms = rollups.filter((r) => !r.is_control);
      if (!control || arms.length === 0) {
        counts.held++;
        decisions.push({ experiment_id: experimentId, action: "hold", win_prob: null, rule: "no_control_or_arms", posteriors: null });
        continue;
      }

      // Which arm(s) are currently SERVING (eligible for the regression guardrail):
      // the promoted arm when promoted, else every non-control arm while running.
      const serving =
        exp.status === "promoted" && exp.promoted_variant_id
          ? arms.filter((a) => a.variant_id === exp.promoted_variant_id)
          : arms;

      // ── Phase 5 — regression / refund-spike guardrail ──────────────────────
      const controlLtv = ltvPerSession(control);
      const controlRefund = refundRate(control);
      let regressing = false;
      let refundSpike = false;
      for (const a of serving) {
        if (a.sessions < GUARDRAIL_MIN_SESSIONS || control.sessions < GUARDRAIL_MIN_SESSIONS) continue;
        if (controlLtv > 0 && ltvPerSession(a) < controlLtv * (1 - LTV_REGRESSION_TOLERANCE)) regressing = true;
        if (refundRate(a) - controlRefund >= REFUND_SPIKE_DELTA) refundSpike = true;
      }

      const nextWindows = regressing ? exp.regression_windows + 1 : 0;
      if (refundSpike || nextWindows >= REGRESSION_WINDOWS_TO_ROLLBACK) {
        const reason = refundSpike
          ? `refund_spike(>=${REFUND_SPIKE_DELTA} over control)`
          : `ltv_proxy_regression(${REGRESSION_WINDOWS_TO_ROLLBACK}+ windows below control -${LTV_REGRESSION_TOLERANCE})`;
        const snapshot = decideExperiment(rollups, { conservative }).posteriors;
        await admin
          .from("storefront_experiments")
          .update({
            status: "rolled_back",
            promoted_variant_id: null,
            regression_windows: nextWindows,
            rollback_reason: reason,
            rolled_back_at: now.toISOString(),
            stopped_at: now.toISOString(),
            last_decision: { action: "rolled_back", reason, posteriors: snapshot, at: now.toISOString() },
            updated_at: now.toISOString(),
          })
          .eq("id", experimentId);
        counts.rolled_back++;
        escalations.push({ experiment_id: experimentId, reason });
        decisions.push({ experiment_id: experimentId, action: "rolled_back", win_prob: null, rule: reason, posteriors: snapshot });
        // Commit the learning — a rollback is a loss, recorded as much as a win.
        await commitLearning(exp, rollups);
        // Grade the concluded campaign at significance (a rollback is a conclusion too).
        await gradeInitialBestEffort(experimentId);
        // Re-publish the edge manifest + purge the PDP render so a rolled-back PDP
        // experiment reverts every visitor to the real cached hero immediately
        // (pdp-edge-served-experiments).
        if (exp.lander_type === "pdp") await republishExperimentManifest(admin, [exp.product_id]);
        // Surface, don't bury — escalate to Growth (durable record + structured log).
        console.warn(
          `[storefront-experiments] ESCALATION rollback experiment=${experimentId} lever=${exp.lever} reason=${reason} ` +
            `control_ltv/sess=${controlLtv} run=${runId}`,
        );
        continue;
      }

      // ── Phase 4 — bandit decision ──────────────────────────────────────────
      const decision = decideExperiment(rollups, { conservative });
      const update: Record<string, unknown> = {
        regression_windows: nextWindows,
        last_decision: { action: decision.action, rule: decision.rule, win_prob: decision.winProb, posteriors: decision.posteriors, at: now.toISOString() },
        updated_at: now.toISOString(),
      };
      let terminal = false;
      if (decision.action === "promote" && decision.winnerVariantId) {
        update.status = "promoted";
        update.promoted_variant_id = decision.winnerVariantId;
        counts.promoted++;
        terminal = true;
      } else if (decision.action === "kill") {
        update.status = "killed";
        update.stopped_at = now.toISOString();
        counts.killed++;
        terminal = true;
      } else {
        counts.held++;
      }
      await admin.from("storefront_experiments").update(update).eq("id", experimentId);
      // A completed experiment (promote = win, kill = loss) commits its learning to memory
      // and gets graded at significance (the M5 Head-of-Growth feedback signal).
      if (terminal) {
        await commitLearning(exp, rollups);
        await gradeInitialBestEffort(experimentId);
        // Promote/kill changed the served arm set → re-publish the edge manifest +
        // purge the PDP render (pdp-edge-served-experiments). A promoted variant
        // serves all non-holdout traffic from its own cached render; a kill reverts
        // everyone to the real cached PDP.
        if (exp.lander_type === "pdp") await republishExperimentManifest(admin, [exp.product_id]);
      }
      decisions.push({
        experiment_id: experimentId,
        action: decision.action,
        win_prob: decision.winProb,
        rule: decision.rule,
        posteriors: decision.posteriors,
      });
    }

    const finishedAt = new Date();
    await admin
      .from("storefront_experiment_runs")
      .update({
        status: "complete",
        experiments_evaluated: byExperiment.size,
        decisions,
        escalations,
        counts: { ...counts, attributed_variants: attribution.variants },
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(0, finishedAt.getTime() - now.getTime()),
      })
      .eq("id", runId);

    return { run_id: runId, experiments_evaluated: byExperiment.size, conservative, counts, escalations };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("storefront_experiment_runs")
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    throw err;
  }
}
