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
import { errText } from "@/lib/error-text";
import { isProxyCalibrated } from "@/lib/storefront/calibration";
import { refreshExperimentAttribution, type VariantRollupResult } from "@/lib/storefront/experiment-attribution";
import { decideExperiment, type BanditDecision } from "@/lib/storefront/bandit";
import { updatePosterior } from "@/lib/storefront/lever-memory";
import { pickCampaignGradeBatch } from "@/lib/storefront/campaign-grader";
import { republishExperimentManifest } from "@/lib/storefront/experiment-cache";
import { isEdgeConfigWriteConfigured } from "@/lib/storefront/experiment-manifest";
import {
  expireRenewalOffers,
  rollbackRenewalOffersForExperiment,
  pairPromotedLanderWithAd,
} from "@/lib/storefront/optimizer-agent";
import type { LanderType } from "@/lib/storefront/lever-memory";
import { recordDirectorActivity } from "@/lib/director-activity";

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
  /** Phase-2 delivery audit may have stamped `delivery_flag='failed_to_deliver'` here
   *  ([[experiment-delivery-audit]]) before this refresh ran; the bandit refuses to
   *  act on the suspect rollups in that case. */
  last_decision: Record<string, unknown> | null;
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
      console.warn(`[storefront-experiments] lever-memory commit failed exp=${exp.id}: ${errText(e)}`);
    }
  };

  // M5 — the initial-mode grade lands box-side (grading-cascade-to-box-sessions Phase 4, CEO
  // directive 2026-06-30). We no longer call the API-based gradeCampaign inline; instead a single
  // `campaign-grade` `agent_jobs` row is enqueued AFTER the refresh loop concludes any terminal
  // experiments (promote / kill / rollback). The box's campaign-grade lane
  // (scripts/builder-worker.ts → runCampaignGradeJob) then reads each concluded campaign's real
  // rollups + variants + design-time lever posterior + storefront-optimizer source and writes
  // storefront_campaign_grades via applyBoxCampaignGrade (same UNIQUE(experiment_id) upsert +
  // human-override invariant). This function tracks whether ANY terminal outcome landed so the
  // enqueue at the end of the refresh can dedup-gate. Best-effort per campaign.
  let terminalCampaignSeen = false;
  const noteTerminalCampaign = (_experimentId: string) => {
    terminalCampaignSeen = true;
  };

  try {
    // 0. Auto-expire persist-to-renewal offers whose ends_at has passed (storefront-renewal-offer-lever
    //    P2). Idempotent + best-effort — an expiry failure never breaks the supervisable refresh.
    try {
      const swept = await expireRenewalOffers({ workspaceId: opts.workspaceId, now });
      if (swept.expired) {
        console.log(`[storefront-experiments] auto-expired ${swept.expired} renewal offer(s); unlinked ${swept.subscriptions_unlinked} sub(s)`);
      }
    } catch (e) {
      console.warn(`[storefront-experiments] renewal-offer auto-expire sweep failed: ${errText(e)}`);
    }

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
          .select("id, status, promoted_variant_id, regression_windows, lever, product_id, lander_type, audience, last_decision")
          .in("id", expIds)
      : { data: [] as ExperimentRowLite[] };
    const expById = new Map((expData as ExperimentRowLite[]).map((e) => [e.id, e]));

    for (const [experimentId, rollups] of byExperiment) {
      const exp = expById.get(experimentId);
      if (!exp) continue;

      // Phase-2 delivery audit ([[experiment-delivery-audit]]) — refuse to act on an
      // experiment whose `last_decision.delivery_flag` is `failed_to_deliver`. The
      // rollups exist (variant rows are present) but the delivery signals are silent,
      // so the bandit would be acting on suspect data. Hold + leave `last_decision`
      // untouched so the flag persists for the Director brief + downstream consumers.
      // Spec Phase 3 (growth-adopt-storefront-optimizer) — record a
      // `blocked_promote_undelivered` director_activity row so the refusal surfaces on
      // the brief instead of being silent.
      if ((exp.last_decision as { delivery_flag?: string } | null)?.delivery_flag === "failed_to_deliver") {
        counts.held++;
        decisions.push({
          experiment_id: experimentId,
          action: "hold",
          win_prob: null,
          rule: "blocked_promote_undelivered",
          posteriors: null,
        });
        await recordDirectorActivity(admin, {
          workspaceId: opts.workspaceId,
          directorFunction: "growth",
          actionKind: "blocked_promote_undelivered",
          specSlug: null,
          reason: `storefront experiment ${experimentId} (${exp.lander_type}) carries last_decision.delivery_flag='failed_to_deliver' — refresh refused promote/kill until the delivery audit clears`,
          metadata: {
            experiment_id: experimentId,
            lander_type: exp.lander_type,
            audience: exp.audience,
            lever: exp.lever,
            product_id: exp.product_id,
            run_id: runId,
          },
        });
        continue;
      }

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
        noteTerminalCampaign(experimentId);
        // storefront-renewal-offer-lever P2: roll back any persist-to-renewal offer linked to this
        // experiment too — a margin-bleeding offer touched real renewals, so rollback must un-touch
        // them. Expires the offer + nulls subscriptions.pricing_offer_id so the bleed stops within
        // this refresh cycle. Best-effort (a failure logs + continues).
        try {
          const swept = await rollbackRenewalOffersForExperiment({
            workspaceId: opts.workspaceId,
            experimentId,
            reason,
            now,
          });
          if (swept.expired) {
            console.warn(
              `[storefront-experiments] rolled back ${swept.expired} renewal offer(s) tied to experiment=${experimentId}; unlinked ${swept.subscriptions_unlinked} sub(s)`,
            );
          }
        } catch (e) {
          console.warn(
            `[storefront-experiments] renewal-offer rollback sweep failed for exp=${experimentId}: ${errText(e)}`,
          );
        }
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
      let promotedVariantId: string | null = null;
      if (decision.action === "promote" && decision.winnerVariantId) {
        update.status = "promoted";
        update.promoted_variant_id = decision.winnerVariantId;
        promotedVariantId = decision.winnerVariantId;
        counts.promoted++;
        terminal = true;
      } else if (decision.action === "kill") {
        update.status = "killed";
        update.stopped_at = now.toISOString();
        counts.killed++;
        terminal = true;
        // storefront-renewal-offer-lever P2: a killed offer experiment must un-touch its renewals
        // too (mirror of the rolled_back path) — a kill is a deliberate stop, not a regression, but
        // the offer still touched real subs and must stop bleeding. Best-effort.
        try {
          const swept = await rollbackRenewalOffersForExperiment({
            workspaceId: opts.workspaceId,
            experimentId,
            reason: `bandit kill: ${decision.rule}`,
            now,
          });
          if (swept.expired) {
            console.warn(
              `[storefront-experiments] killed experiment=${experimentId} → expired ${swept.expired} renewal offer(s); unlinked ${swept.subscriptions_unlinked} sub(s)`,
            );
          }
        } catch (e) {
          console.warn(
            `[storefront-experiments] renewal-offer kill sweep failed for exp=${experimentId}: ${errText(e)}`,
          );
        }
      } else {
        counts.held++;
      }
      await admin.from("storefront_experiments").update(update).eq("id", experimentId);
      // A completed experiment (promote = win, kill = loss) commits its learning to memory
      // and gets graded at significance (the M5 Head-of-Growth feedback signal).
      if (terminal) {
        await commitLearning(exp, rollups);
        noteTerminalCampaign(experimentId);
        // Promote/kill changed the served arm set → re-publish the edge manifest +
        // purge the PDP render (pdp-edge-served-experiments). A promoted variant
        // serves all non-holdout traffic from its own cached render; a kill reverts
        // everyone to the real cached PDP.
        if (exp.lander_type === "pdp") await republishExperimentManifest(admin, [exp.product_id]);
        // Spec growth-winning-creative-amplifier Phase 3 reverse direction — a promoted
        // lander variant on an advertorial-family surface requests a fresh static ad for
        // the lander's matching angle so the perf↔creative loop closes both ways. Skips
        // pdp (the ad side doesn't ship statics tied to bare-PDP variants). Best-effort:
        // a failure here NEVER unwinds the promote — the matched ad is a downstream
        // enrichment, not a precondition. Stamps one paired_winner_lander activity row
        // (the cross-side audit trail).
        if (promotedVariantId && exp.lander_type !== "pdp") {
          try {
            await pairPromotedLanderWithAd(admin, {
              workspaceId: opts.workspaceId,
              productId: exp.product_id,
              landerType: exp.lander_type as LanderType,
              experimentId,
              variantId: promotedVariantId,
              specSlug: "growth-winning-creative-amplifier",
            });
          } catch (e) {
            console.warn(
              `[storefront-experiments] paired_winner_lander pair-on-promote failed exp=${experimentId}: ${errText(e)}`,
            );
          }
        }
      }
      decisions.push({
        experiment_id: experimentId,
        action: decision.action,
        win_prob: decision.winProb,
        rule: decision.rule,
        posteriors: decision.posteriors,
      });
    }

    // grading-cascade-to-box-sessions Phase 4: dispatch the initial-mode campaign grade box-side.
    // If any terminal outcome landed on this refresh, pick the batch of ungraded concluded campaigns
    // for this workspace and enqueue ONE `campaign-grade` `agent_jobs` row carrying them; the box
    // lane grades them and writes storefront_campaign_grades. Dedup-gated: skip re-enqueueing while
    // a `campaign-grade` job for this workspace is already queued/building. Best-effort — a grader
    // dispatch failure never breaks the supervisable refresh.
    if (terminalCampaignSeen) {
      try {
        const batch = await pickCampaignGradeBatch({ workspaceId: opts.workspaceId, admin });
        if (batch.length) {
          const { data: inflight } = await admin
            .from("agent_jobs")
            .select("id")
            .eq("workspace_id", opts.workspaceId)
            .eq("kind", "campaign-grade")
            .in("status", ["queued", "queued_resume", "building", "claimed"])
            .limit(1);
          if (!inflight || !inflight.length) {
            const { error } = await admin.from("agent_jobs").insert({
              workspace_id: opts.workspaceId,
              spec_slug: "campaign-grade",
              kind: "campaign-grade",
              status: "queued",
              created_by: null,
              instructions: JSON.stringify({ candidates: batch }),
            });
            if (error) console.error(`[storefront-experiments] campaign-grade enqueue failed ws=${opts.workspaceId}: ${error.message}`);
          }
        }
      } catch (e) {
        console.warn(`[storefront-experiments] campaign-grade pick/enqueue failed ws=${opts.workspaceId}: ${errText(e)}`);
      }
    }

    // Self-heal the edge manifest on EVERY refresh tick (not only on a state change above).
    // An unconditional republish keeps `storefront_experiment_manifest` matching the current
    // set of running/promoted experiments within ≤5 min regardless of how state drifted (a
    // manual DB change, a missed event, a stale entry, or experiments that were already
    // running before the publish code shipped). Idempotent — an upsert of the same manifest is
    // a no-op write — and best-effort (republishExperimentManifest never throws). Gated on
    // isEdgeConfigWriteConfigured() so it no-ops to the blob fallback when Edge Config isn't
    // provisioned. The state-change republishes above stay as the fast path; this is the safety
    // net (edge-manifest-self-heal · pdp-edge-served-experiments).
    if (isEdgeConfigWriteConfigured()) {
      await republishExperimentManifest(admin);
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
    const message = errText(err);
    await admin
      .from("storefront_experiment_runs")
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    throw err;
  }
}
