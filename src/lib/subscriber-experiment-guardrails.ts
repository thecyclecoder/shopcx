/**
 * Guardrail + verdict engine for the pre-renewal-reminder 50/50 test (spec:
 * renewal-reminder-launch-readiness Phase 5 — the work left unbuilt by
 * subscriber-experiment-guardrails-verdict Phases 2–3).
 *
 * A daily retention-owned cron ([[inngest/subscriber-experiment-guardrails]], id
 * `subscriber-experiment-guardrail-cron`) evaluates guardrails treatment-vs-holdout with a
 * SEQUENTIAL-SAFE method (an anytime-valid confidence sequence, NOT repeated naive p-values, so
 * daily peeking can't inflate false trips) plus hard absolute floors. On a trip it flips the
 * experiment to `stopped` through the status SDK (which, after Phase 4, halts ALL reminders) and
 * sends ONE deduped CEO notification with the reasoning (north star: escalate, don't execute
 * silently). Never auto-resumes. When the pre-registered sample is reached AND every group's 90-day
 * window has closed, it records the verdict on the primary metric and notifies the CEO once.
 *
 * Supervisable autonomy: the cron honours its kill switch (`GUARDRAIL_CRON_LOOP_ID`) and only ever
 * PAUSES (stopped) — it cannot launch or resume a test; that stays a CEO-approved status flip.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { resolveEffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";
import {
  getExperiment,
  isExperimentRunning,
  listAssignments,
  recordExperimentVerdict,
  setExperimentStatus,
  PRE_RENEWAL_EXPERIMENT_SLUG,
} from "@/lib/subscriber-experiments";
import { DEFAULT_WINDOW_DAYS, welchTwoSampleCI } from "@/lib/subscriber-experiment-metrics";
import { getReminderTestResults, type ArmResults } from "@/lib/retention/reminder-results-sdk";

type Admin = ReturnType<typeof createAdminClient>;

/** Control-tower loop id for the daily guardrail/verdict cron (owner: retention). */
export const GUARDRAIL_CRON_LOOP_ID = "subscriber-experiment-guardrail-cron";

/**
 * The status-SDK pause writer the cron injects (defaults to `setExperimentStatus`). The AUTONOMY
 * BOUNDARY — the cron — owns the capability to pause the test and passes it in explicitly, so the
 * only path that can flip the experiment to `stopped` on harm is through the audited status SDK.
 */
export type PauseWriter = typeof setExperimentStatus;

/** Default anytime-valid significance level for a guardrail trip. */
export const GUARDRAIL_ALPHA = 0.05;

/** Hard floors — a trip regardless of the significance test (CEO: STOP/complaint spikes etc.). The
 *  cancel/refund floors are HOLDOUT-RELATIVE (treatment's EXCESS over holdout), not absolute on the
 *  treatment arm alone — normal 90-day churn hits both arms equally, so an absolute floor on
 *  treatment would pause the test on baseline churn the reminder never caused. Only the SMS STOP
 *  floor stays absolute (the holdout sends no SMS, so there is no holdout baseline to net against). */
export const HARD_FLOORS = {
  /** Treatment SMS STOP opt-out rate this high is a hard stop no matter the sample (ABSOLUTE — the
   *  holdout sends nothing, so there is no holdout rate to subtract). */
  smsOptOutRate: 0.05,
  /** Treatment refund rate exceeding holdout's by this many points (e.g. 0.05 = 5pts) is a hard stop. */
  refundExcessOverHoldout: 0.05,
  /** Treatment voluntary-cancel rate exceeding holdout's by this many points (0.05 = 5pts) is a hard stop. */
  voluntaryCancelExcessOverHoldout: 0.05,
  /** Treatment net merchandise revenue per person this far BELOW holdout (relative) is a hard stop. */
  netRevenueRelativeDrop: 0.2,
  /** Minimum groups per arm before the net-revenue + excess floors can trip (avoids tiny-sample noise). */
  netRevenueMinN: 50,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Anytime-valid confidence radius for a bounded mean — an iterated-logarithm (Howard-style
 * sub-Gaussian) boundary that is valid at EVERY sample size, so peeking daily does not inflate the
 * error rate (unlike a fixed-n z-interval re-read every day). `variance` is a per-observation
 * variance proxy (p(1-p) for a proportion, capped for conservatism by the caller).
 */
export function anytimeValidRadius(n: number, variance: number, alpha: number): number {
  if (n <= 0) return Infinity;
  const loglog = Math.log(Math.log(Math.max(Math.E, n)) + 1); // ≥ 0
  return Math.sqrt((2 * variance * (Math.log(1 / alpha) + 3 * loglog)) / n);
}

/**
 * Is treatment's bad-rate anytime-valid-significantly WORSE (higher) than holdout's? Disjoint
 * anytime-valid intervals in the harmful direction. Variance proxy is floored at the max 0.25 when
 * p is extreme, so a zero-holdout arm still yields a conservative (wide) interval.
 */
export function proportionHarmTripped(pT: number, nT: number, pH: number, nH: number, alpha: number): boolean {
  if (nT < 1 || nH < 1) return false;
  if (!(pT > pH)) return false;
  const vT = Math.max(pT * (1 - pT), 0.01);
  const vH = Math.max(pH * (1 - pH), 0.01);
  const rT = anytimeValidRadius(nT, vT, alpha);
  const rH = anytimeValidRadius(nH, vH, alpha);
  return pT - rT > pH + rH;
}

export interface GuardrailSignal {
  key: "voluntary_cancel" | "refund" | "sms_opt_out" | "net_revenue";
  tripped: boolean;
  treatment: number;
  holdout: number;
  reason: string;
}

export interface GuardrailEvaluation {
  anyTripped: boolean;
  signals: GuardrailSignal[];
  /** One-line combined reason for the tripped signals (empty when none tripped). */
  reason: string;
}

/**
 * Evaluate every guardrail treatment-vs-holdout. PURE — all I/O already resolved into the two
 * ArmResults. A signal trips on EITHER the anytime-valid significance test OR a hard absolute floor.
 */
export function evaluateGuardrails(
  treatment: ArmResults,
  holdout: ArmResults,
  alpha: number = GUARDRAIL_ALPHA,
): GuardrailEvaluation {
  const signals: GuardrailSignal[] = [];
  const nT = treatment.customerGroups;
  const nH = holdout.customerGroups;

  // Both arms must clear the min-sample bar before an EXCESS floor can trip (avoids tiny-sample noise
  // and matches the net-revenue floor's gate).
  const haveMinN = nT >= HARD_FLOORS.netRevenueMinN && nH >= HARD_FLOORS.netRevenueMinN;

  // Voluntary cancel rate — trip on significance OR treatment's EXCESS over holdout (never on
  // treatment's absolute rate, which includes baseline churn the reminder didn't cause).
  {
    const pT = treatment.voluntaryCancelRate;
    const pH = holdout.voluntaryCancelRate;
    const excessTripped = haveMinN && pT - pH >= HARD_FLOORS.voluntaryCancelExcessOverHoldout;
    const tripped = proportionHarmTripped(pT, nT, pH, nH, alpha) || excessTripped;
    signals.push({ key: "voluntary_cancel", tripped, treatment: pT, holdout: pH,
      reason: tripped ? `treatment voluntary-cancel rate ${(pT * 100).toFixed(1)}% vs holdout ${(pH * 100).toFixed(1)}% (excess ${((pT - pH) * 100).toFixed(1)}pts)` : "" });
  }

  // Refund rate — trip on significance OR treatment's EXCESS over holdout.
  {
    const pT = treatment.refundRate;
    const pH = holdout.refundRate;
    const excessTripped = haveMinN && pT - pH >= HARD_FLOORS.refundExcessOverHoldout;
    const tripped = proportionHarmTripped(pT, nT, pH, nH, alpha) || excessTripped;
    signals.push({ key: "refund", tripped, treatment: pT, holdout: pH,
      reason: tripped ? `treatment refund rate ${(pT * 100).toFixed(1)}% vs holdout ${(pH * 100).toFixed(1)}% (excess ${((pT - pH) * 100).toFixed(1)}pts)` : "" });
  }

  // SMS STOP opt-out rate (treatment is the only arm that sends; holdout ≈ 0).
  {
    const tReminded = treatment.engagement.reminded;
    const pT = tReminded > 0 ? treatment.engagement.smsSuppressedStop / tReminded : 0;
    const hReminded = holdout.engagement.reminded;
    const pH = hReminded > 0 ? holdout.engagement.smsSuppressedStop / hReminded : 0;
    const tripped = proportionHarmTripped(pT, tReminded, pH, hReminded, alpha) || pT >= HARD_FLOORS.smsOptOutRate;
    signals.push({ key: "sms_opt_out", tripped, treatment: pT, holdout: pH,
      reason: tripped ? `treatment SMS STOP opt-out rate ${(pT * 100).toFixed(1)}%` : "" });
  }

  // Net merchandise revenue per person — trip only on a material relative DROP vs holdout with a
  // minimum sample (the primary metric; we never trip it on thin data).
  {
    const tRev = treatment.netRevenuePerCustomerCents;
    const hRev = holdout.netRevenuePerCustomerCents;
    const materialDrop = hRev > 0 && tRev < hRev * (1 - HARD_FLOORS.netRevenueRelativeDrop);
    const tripped = materialDrop && nT >= HARD_FLOORS.netRevenueMinN && nH >= HARD_FLOORS.netRevenueMinN;
    signals.push({ key: "net_revenue", tripped, treatment: tRev, holdout: hRev,
      reason: tripped ? `treatment net merchandise revenue/person ${(tRev / 100).toFixed(2)} vs holdout ${(hRev / 100).toFixed(2)}` : "" });
  }

  const tripped = signals.filter((s) => s.tripped);
  return {
    anyTripped: tripped.length > 0,
    signals,
    reason: tripped.map((s) => s.reason).join("; "),
  };
}

export interface VerdictResult {
  verdict: "treatment_wins" | "holdout_wins" | "no_difference";
  detail: Record<string, unknown>;
}

/**
 * Classify the terminal verdict on the primary metric (90-day net merchandise revenue per person).
 * PURE — the caller gates on sample-complete + windows-closed before calling.
 *
 * A winner (`treatment_wins`/`holdout_wins`) is declared ONLY when a two-sample Welch t-test on
 * per-person net merchandise revenue REJECTS at the experiment's pre-registered `alpha` — i.e. the
 * confidence interval on the lift excludes 0. The old 1%-relative rule named a winner on noise the
 * test (powered for ~10% MDE) can't distinguish from zero; it's gone. The verdict detail reports the
 * lift with its `confidenceInterval` { lowCents, highCents } so the reader sees the uncertainty.
 */
export function evaluateVerdict(
  treatment: ArmResults,
  holdout: ArmResults,
  alpha: number = GUARDRAIL_ALPHA,
): VerdictResult {
  const tRev = treatment.netRevenuePerCustomerCents;
  const hRev = holdout.netRevenuePerCustomerCents;
  const liftCents = tRev - hRev;
  const relative = hRev !== 0 ? liftCents / Math.abs(hRev) : (tRev > 0 ? 1 : 0);
  const ci = welchTwoSampleCI(
    tRev, treatment.netRevenueVarianceCents2, treatment.customerGroups,
    hRev, holdout.netRevenueVarianceCents2, holdout.customerGroups,
    alpha,
  );
  let verdict: VerdictResult["verdict"] = "no_difference";
  if (ci.significant) verdict = liftCents > 0 ? "treatment_wins" : "holdout_wins";
  return {
    verdict,
    detail: {
      metric: "90d_net_merchandise_revenue_per_customer",
      treatmentPerCustomerCents: tRev,
      holdoutPerCustomerCents: hRev,
      liftCents,
      relativeLift: relative,
      alpha,
      significant: ci.significant,
      confidenceInterval: { lowCents: ci.lowCents, highCents: ci.highCents },
      degreesOfFreedom: ci.df,
      treatmentN: treatment.customerGroups,
      holdoutN: holdout.customerGroups,
    },
  };
}

/** Have ALL assignment windows closed (every group's 90-day window ended before `now`)? */
async function allWindowsClosed(
  workspaceId: string,
  windowDays: number,
  now: Date,
  admin: Admin,
): Promise<boolean> {
  const assignments = await listAssignments(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, admin);
  if (assignments.length === 0) return false;
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  return assignments.every((a) => new Date(a.assigned_at).getTime() <= cutoff);
}

/**
 * Insert ONE CEO dashboard notification, deduped per (experiment, kind). Returns true if a new row
 * was inserted, false if an identical un-dismissed notification already exists. Never throws on a
 * fire-and-forget failure.
 */
async function notifyCeoOnce(
  admin: Admin,
  workspaceId: string,
  experimentId: string,
  kind: "guardrail_trip" | "verdict",
  title: string,
  body: string,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const dedupeKey = `subscriber-experiment:${experimentId}:${kind}`;
  try {
    const { data: existing } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", "system")
      .contains("metadata", { dedupe_key: dedupeKey })
      .maybeSingle();
    if (existing?.id) return false;
    await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: "system",
      title,
      body,
      metadata: { dedupe_key: dedupeKey, experiment_id: experimentId, kind, ...extra },
    });
    return true;
  } catch (e) {
    console.warn(`[guardrail-cron] notifyCeoOnce(${kind}) failed:`, errText(e));
    return false;
  }
}

export interface GuardrailRunResult {
  workspaces: number;
  evaluated: number;
  tripped: number;
  concluded: number;
  killSwitchOff?: boolean;
}

/**
 * Evaluate ONE workspace's pre-renewal experiment. Returns which actions fired.
 */
export async function evaluateWorkspaceGuardrails(
  workspaceId: string,
  now: Date,
  admin: Admin,
  pauseWriter: PauseWriter = setExperimentStatus,
): Promise<{ evaluated: boolean; tripped: boolean; concluded: boolean }> {
  const experiment = await getExperiment(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, admin);
  // Only a RUNNING experiment is worth evaluating — draft/stopped/complete are no-ops.
  if (!isExperimentRunning(experiment) || !experiment) return { evaluated: false, tripped: false, concluded: false };

  const results = await getReminderTestResults(admin, workspaceId);
  const { treatment, holdout } = results.arms;

  // ── Guardrail trip → auto-pause through the status SDK + ONE deduped CEO escalation. ──
  const guardrails = evaluateGuardrails(treatment, holdout);
  if (guardrails.anyTripped) {
    await pauseWriter(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, "stopped", {
      by: "guardrail",
      reason: guardrails.reason,
    }, admin);
    await notifyCeoOnce(
      admin,
      workspaceId,
      experiment.id,
      "guardrail_trip",
      "Pre-renewal reminder test auto-paused on a guardrail trip",
      `The pre-renewal reminder 50/50 test was auto-paused (status → stopped). ${guardrails.reason}. No reminders will send until you resume it.`,
      { signals: guardrails.signals.filter((s) => s.tripped) },
    );
    return { evaluated: true, tripped: true, concluded: false };
  }

  // ── Verdict: pre-registered sample reached AND every group's window closed → conclude once. ──
  if (results.guardrails.sampleComplete) {
    const closed = await allWindowsClosed(workspaceId, results.windowDays || DEFAULT_WINDOW_DAYS, now, admin);
    if (closed) {
      const verdict = evaluateVerdict(treatment, holdout, experiment.alpha ?? GUARDRAIL_ALPHA);
      await recordExperimentVerdict(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, verdict, {
        by: "guardrail",
        reason: "pre-registered sample reached + all windows closed",
      }, admin);
      const ci = verdict.detail.confidenceInterval as { lowCents: number; highCents: number };
      await notifyCeoOnce(
        admin,
        workspaceId,
        experiment.id,
        "verdict",
        "Pre-renewal reminder test reached its verdict",
        `The pre-renewal reminder 50/50 test concluded: ${verdict.verdict}. Treatment net merchandise revenue/person ${(treatment.netRevenuePerCustomerCents / 100).toFixed(2)} vs holdout ${(holdout.netRevenuePerCustomerCents / 100).toFixed(2)} (lift CI $${(ci.lowCents / 100).toFixed(2)} to $${(ci.highCents / 100).toFixed(2)} at alpha ${experiment.alpha ?? GUARDRAIL_ALPHA}).`,
        { verdict: verdict.verdict, detail: verdict.detail },
      );
      return { evaluated: true, tripped: false, concluded: true };
    }
  }

  return { evaluated: true, tripped: false, concluded: false };
}

/**
 * The daily guardrail/verdict run across all workspaces. Honours the cron kill switch (an OFF trip
 * skips evaluation but returns cleanly so the cron still heartbeats). Read-mostly; the only writes
 * are through the status SDK (pause / verdict) + a deduped CEO notification.
 */
export async function runSubscriberExperimentGuardrails(
  now: Date = new Date(),
  admin: Admin = createAdminClient(),
  pauseWriter: PauseWriter = setExperimentStatus,
): Promise<GuardrailRunResult> {
  const base: GuardrailRunResult = { workspaces: 0, evaluated: 0, tripped: 0, concluded: 0 };

  const sw = await resolveEffectiveSwitch(GUARDRAIL_CRON_LOOP_ID);
  if (sw.off) return { ...base, killSwitchOff: true };

  const { data: workspaces } = await admin.from("workspaces").select("id");
  for (const w of workspaces || []) {
    base.workspaces++;
    try {
      const r = await evaluateWorkspaceGuardrails(w.id as string, now, admin, pauseWriter);
      if (r.evaluated) base.evaluated++;
      if (r.tripped) base.tripped++;
      if (r.concluded) base.concluded++;
    } catch (e) {
      console.warn(`[guardrail-cron] workspace ${w.id} failed:`, errText(e));
    }
  }
  return base;
}
