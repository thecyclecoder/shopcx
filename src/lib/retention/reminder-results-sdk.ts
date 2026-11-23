/**
 * Read-only results lens for the pre-renewal-reminder 50/50 test (spec:
 * renewal-reminder-results-dashboard Phase 1 · [[../../../docs/brain/libraries/reminder-results-sdk]]).
 *
 * The M4 results dashboard needs the test readable at a glance, but its data is spread across four
 * surfaces: the experiment row + sticky assignments (the harness), the pre-renewal reminder send
 * ledger (M2), the next-order journey lifecycle events (M1), and orders/refunds. This module is the
 * SINGLE read-only lens that composes those into one typed per-arm rollup — exactly the
 * compose-several-reads, return-a-typed-shape pattern of [[../ads/testing-results-sdk]]
 * ([[../../../docs/brain/libraries/testing-results-sdk]]). The page and any CLI read THIS, never a
 * hand-rolled join.
 *
 * Reuse, not re-derivation: the per-arm 90-day net revenue and the secondary rates come straight
 * from [[../subscriber-experiment-metrics]] `computeExperimentMetrics` (the single place
 * charges-minus-settled-refunds is defined). Send/suppression counts come from the reminder ledger
 * through its chokepoint ([[../pre-renewal-reminders]] `listReminderLedger`, so no raw
 * `.from("pre_renewal_reminders")` leaks out). The arm assignments + experiment lifecycle (for the
 * guardrail status + verdict) are read ONLY through the harness SDK ([[../subscriber-experiments]]),
 * never a raw `.from` on its tables (CLAUDE.md raw-`.from` STOP rule).
 *
 * STRICTLY READ-ONLY: this module performs NO writes. The journey lifecycle events it reads
 * (opened / edited / swapped / skipped / cancelled / saved) are attributed to an arm via the
 * ledger's `journey_session_id → experiment_arm`, so the holdout — which gets no reminder and no
 * journey — naturally shows zero engagement, the clean counterfactual.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeExperimentMetrics,
  welchTwoSampleCI,
  type ArmMetrics,
} from "@/lib/subscriber-experiment-metrics";
import {
  getExperiment,
  PRE_RENEWAL_EXPERIMENT_SLUG,
  type CustomerLifecycleExperimentRow,
  type ExperimentArm,
} from "@/lib/subscriber-experiments";
import {
  listReminderLedger,
  type ReminderLedgerRow,
} from "@/lib/pre-renewal-reminders";

type Admin = ReturnType<typeof createAdminClient>;

/** Chunk size for `.in(...)` filters — keeps a single IN list bounded for large arms. */
const IN_CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Per-arm reminder + next-order-journey funnel counts. Holdout engagement is zero by design. */
export interface ArmEngagement {
  /** Reminder decisions recorded for the arm (one ledger row per person-group per renewal). */
  reminded: number;
  /** Reminder emails that sent (treatment only). */
  emailsSent: number;
  /** Reminder SMS that sent or scheduled (treatment only). */
  smsSent: number;
  /** SMS suppressed because the customer sent STOP (opt-out) — an M3 guardrail input. */
  smsSuppressedStop: number;
  /** SMS suppressed for plain non-consent / bad phone. */
  smsSuppressedNoConsent: number;
  /** Next-order journeys opened. */
  opened: number;
  /** Journeys where the customer made an edit. */
  edited: number;
  /** Edits that were a swap or add-on (subset of `edited`). */
  swapped: number;
  /** Journeys where the customer skipped the next order. */
  skipped: number;
  /** Journeys that ended in a cancel. */
  cancelled: number;
  /** Journeys saved / confirmed. */
  saved: number;
}

/** Per-arm rollup: assignment size, the engagement funnel, net revenue, and refund rate. */
export interface ArmResults {
  arm: ExperimentArm;
  /** Assigned person-groups in this arm. */
  customerGroups: number;
  engagement: ArmEngagement;
  /** Σ net merchandise revenue (paid-order merchandise − settled refunds) in-window, in cents. */
  netRevenueCents: number;
  /** Mean 90-day net MERCHANDISE revenue per person-group, in cents (the PRIMARY metric, ex tax/shipping). */
  netRevenuePerCustomerCents: number;
  /** Sample variance (÷ n−1) of per-person net merchandise revenue, in cents² — feeds the verdict's Welch t-test. */
  netRevenueVarianceCents2: number;
  /** Σ merchandise charges in-window (ex tax/shipping), in cents. */
  grossRevenueCents: number;
  /** Σ settled refunds netted out, in cents. */
  refundsCents: number;
  /** Fraction of the arm's groups with ≥1 settled refund in-window. */
  refundRate: number;
  /** Fraction of the arm's groups with ≥1 voluntary cancel in-window. */
  voluntaryCancelRate: number;
}

/** Live guardrail status derived from the harness row + the secondary metrics. */
export interface ReminderGuardrails {
  requiredNPerArm: number | null;
  treatmentN: number;
  holdoutN: number;
  /** Both arms reached the pre-registered per-arm sample size. */
  sampleComplete: boolean;
  /** STOP opt-outs seen across arms (TCPA / message-fatigue guardrail). */
  smsOptOuts: number;
  /** Coarse health read: 'ok' until a secondary metric on treatment breaches holdout. */
  status: "ok" | "watch";
  notes: string[];
  /** True when the guardrail cron has auto-paused the test (status='stopped' by 'guardrail'). The
   *  PERSISTED trip supersedes the derived `status` once the cron has run. */
  tripped: boolean;
  /** The persisted trip reason (from the experiment's status_changed_reason), null until a trip. */
  trippedReason: string | null;
}

/**
 * The test's verdict. Phase 1 DERIVES this from the harness experiment status + the primary metric;
 * the dedicated verdict engine (subscriber-experiment-guardrails-verdict) supersedes it once it
 * lands. `derived: true` flags that provenance to the page.
 */
export interface ReminderVerdict {
  experimentStatus: CustomerLifecycleExperimentRow["status"] | "absent";
  /** The test has reached a terminal state (stopped / complete). */
  concluded: boolean;
  /** Which arm leads on 90-day net revenue per customer (null until either arm has data). */
  leadingArm: ExperimentArm | null;
  /** Treatment − holdout net revenue per customer, in cents (the primary-metric delta). */
  netRevenuePerCustomerLiftCents: number;
  /** Confidence interval on that lift (Welch's t-test at the experiment's alpha), in cents — null
   *  until both arms have ≥2 groups. The banner shows this so a lift is never read as a win without
   *  its uncertainty. */
  confidenceIntervalCents: { lowCents: number; highCents: number } | null;
  /** Whether the lift is statistically significant at the experiment's alpha (the CI excludes 0). A
   *  winner is only declared when this is true. */
  significant: boolean;
  /** The PERSISTED terminal verdict label once the cron has recorded it (null while derived). */
  verdict: string | null;
  /** false once the persisted verdict/guardrail engine has run; true for the pre-evaluation fallback. */
  derived: boolean;
}

export interface ReminderTestResults {
  generatedAt: string;
  experimentSlug: string;
  windowDays: number;
  arms: Record<ExperimentArm, ArmResults>;
  guardrails: ReminderGuardrails;
  verdict: ReminderVerdict;
}

/** A journey lifecycle event as the rollup reads it. */
export interface JourneyLifecycleEvent {
  session_id: string;
  response_value: string | null;
  response_label: string | null;
}

function emptyEngagement(): ArmEngagement {
  return {
    reminded: 0,
    emailsSent: 0,
    smsSent: 0,
    smsSuppressedStop: 0,
    smsSuppressedNoConsent: 0,
    opened: 0,
    edited: 0,
    swapped: 0,
    skipped: 0,
    cancelled: 0,
    saved: 0,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Pure rollup math (unit-tested, no I/O).
 * --------------------------------------------------------------------------------------------- */

/**
 * Fold the reminder ledger + journey lifecycle events into per-arm engagement counts. PURE.
 *
 *   • Ledger rows give the send/suppression funnel and the `journey_session_id → arm` map.
 *   • Lifecycle events (step_key 'lifecycle') are attributed to an arm via that map; an event whose
 *     session isn't on the ledger is ignored. Swap/add-on is the `edited` subset whose label reads
 *     swap/add (same detection as the metrics module).
 */
export function rollupEngagement(
  ledgerRows: ReminderLedgerRow[],
  lifecycleEvents: JourneyLifecycleEvent[],
): Record<ExperimentArm, ArmEngagement> {
  const byArm: Record<ExperimentArm, ArmEngagement> = {
    treatment: emptyEngagement(),
    holdout: emptyEngagement(),
  };
  const sessionToArm = new Map<string, ExperimentArm>();

  for (const r of ledgerRows) {
    const arm = r.experiment_arm;
    const e = byArm[arm];
    if (!e) continue;
    e.reminded += 1;
    if (r.email_status === "sent") e.emailsSent += 1;
    if (r.sms_status === "sent" || r.sms_status === "scheduled") e.smsSent += 1;
    if (r.sms_status === "suppressed_stop") e.smsSuppressedStop += 1;
    if (r.sms_status === "suppressed_no_consent") e.smsSuppressedNoConsent += 1;
    if (r.journey_session_id) sessionToArm.set(r.journey_session_id, arm);
  }

  for (const ev of lifecycleEvents) {
    const arm = sessionToArm.get(ev.session_id);
    if (!arm) continue;
    const e = byArm[arm];
    switch (ev.response_value) {
      case "opened":
        e.opened += 1;
        break;
      case "edited": {
        e.edited += 1;
        const label = (ev.response_label ?? "").toLowerCase();
        if (label.includes("swap") || label.includes("add")) e.swapped += 1;
        break;
      }
      case "skipped":
        e.skipped += 1;
        break;
      case "cancelled":
        e.cancelled += 1;
        break;
      case "saved":
        e.saved += 1;
        break;
      default:
        break;
    }
  }

  return byArm;
}

/** Combine the metrics rollup + engagement into one per-arm shape. PURE. */
export function buildArmResults(
  metrics: ArmMetrics,
  engagement: ArmEngagement,
): ArmResults {
  const refundRate =
    metrics.customerGroups > 0 ? metrics.refundedCustomerGroups / metrics.customerGroups : 0;
  return {
    arm: metrics.arm,
    customerGroups: metrics.customerGroups,
    engagement,
    netRevenueCents: metrics.netRevenueCents,
    netRevenuePerCustomerCents: metrics.netRevenuePerCustomerCents,
    netRevenueVarianceCents2: metrics.netRevenueVarianceCents2,
    grossRevenueCents: metrics.grossRevenueCents,
    refundsCents: metrics.refundsCents,
    refundRate,
    voluntaryCancelRate: metrics.voluntaryCancelRate,
  };
}

/** Derive the live guardrail status from the harness row + the two arms' secondary metrics. PURE. */
export function deriveGuardrails(
  experiment: CustomerLifecycleExperimentRow | null,
  arms: Record<ExperimentArm, ArmResults>,
  engagement: Record<ExperimentArm, ArmEngagement>,
): ReminderGuardrails {
  const requiredN = experiment?.required_n_per_arm ?? null;
  const treatmentN = arms.treatment.customerGroups;
  const holdoutN = arms.holdout.customerGroups;
  const sampleComplete = requiredN != null && treatmentN >= requiredN && holdoutN >= requiredN;
  const smsOptOuts = engagement.treatment.smsSuppressedStop + engagement.holdout.smsSuppressedStop;

  const notes: string[] = [];
  let status: "ok" | "watch" = "ok";
  if (arms.treatment.refundRate > arms.holdout.refundRate && arms.treatment.refundRate > 0) {
    notes.push("treatment refund rate exceeds holdout");
    status = "watch";
  }
  if (
    arms.treatment.voluntaryCancelRate > arms.holdout.voluntaryCancelRate &&
    arms.treatment.voluntaryCancelRate > 0
  ) {
    notes.push("treatment voluntary-cancel rate exceeds holdout");
    status = "watch";
  }

  return { requiredNPerArm: requiredN, treatmentN, holdoutN, sampleComplete, smsOptOuts, status, notes, tripped: false, trippedReason: null };
}

/** Derive the verdict from the harness experiment status + the primary metric. PURE. */
export function deriveVerdict(
  experiment: CustomerLifecycleExperimentRow | null,
  arms: Record<ExperimentArm, ArmResults>,
): ReminderVerdict {
  const experimentStatus = experiment?.status ?? "absent";
  const concluded = experimentStatus === "complete" || experimentStatus === "stopped";
  const lift =
    arms.treatment.netRevenuePerCustomerCents - arms.holdout.netRevenuePerCustomerCents;
  let leadingArm: ExperimentArm | null = null;
  if (arms.treatment.customerGroups > 0 || arms.holdout.customerGroups > 0) {
    leadingArm = lift >= 0 ? "treatment" : "holdout";
  }
  // Welch's t-test at the experiment's pre-registered alpha (default 0.05) on per-person net
  // merchandise revenue — the lift is only a WIN when its CI excludes 0. Computed live so the banner
  // always shows the interval, even before the cron has persisted the terminal verdict.
  const alpha = experiment?.alpha ?? 0.05;
  const ci =
    arms.treatment.customerGroups >= 2 && arms.holdout.customerGroups >= 2
      ? welchTwoSampleCI(
          arms.treatment.netRevenuePerCustomerCents, arms.treatment.netRevenueVarianceCents2, arms.treatment.customerGroups,
          arms.holdout.netRevenuePerCustomerCents, arms.holdout.netRevenueVarianceCents2, arms.holdout.customerGroups,
          alpha,
        )
      : null;
  return {
    experimentStatus,
    concluded,
    leadingArm,
    netRevenuePerCustomerLiftCents: lift,
    confidenceIntervalCents: ci ? { lowCents: ci.lowCents, highCents: ci.highCents } : null,
    significant: ci?.significant ?? false,
    verdict: null,
    derived: true,
  };
}

/**
 * Prefer the PERSISTED verdict/guardrail state the guardrail cron wrote, falling back to the derived
 * values only before the first evaluation (spec Phase 5). PURE — given the experiment row + the
 * derived shapes, overlay the persisted fields when present.
 */
export function overlayPersisted(
  experiment: CustomerLifecycleExperimentRow | null,
  guardrails: ReminderGuardrails,
  verdict: ReminderVerdict,
): { guardrails: ReminderGuardrails; verdict: ReminderVerdict } {
  if (!experiment) return { guardrails, verdict };

  // Guardrail: a status of 'stopped' flipped by the guardrail cron is the persisted trip.
  const stoppedByGuardrail = experiment.status === "stopped" && experiment.status_changed_by === "guardrail";
  const g: ReminderGuardrails = stoppedByGuardrail
    ? { ...guardrails, status: "watch", tripped: true, trippedReason: experiment.status_changed_reason ?? "guardrail trip" }
    : guardrails;

  // Verdict: once the cron records a verdict label it supersedes the derived lead.
  const v: ReminderVerdict = experiment.verdict
    ? { ...verdict, verdict: experiment.verdict, concluded: true, derived: false }
    : verdict;

  return { guardrails: g, verdict: v };
}

/* ------------------------------------------------------------------------------------------------
 * Orchestration (the read surface the API + page hydrate from).
 * --------------------------------------------------------------------------------------------- */

/** Read the journey lifecycle events for the given sessions (step_key 'lifecycle'). Read-only. */
async function fetchLifecycleEvents(
  admin: Admin,
  workspaceId: string,
  sessionIds: string[],
): Promise<JourneyLifecycleEvent[]> {
  if (sessionIds.length === 0) return [];
  const out: JourneyLifecycleEvent[] = [];
  for (const part of chunk(sessionIds, IN_CHUNK)) {
    const { data } = await admin
      .from("journey_step_events")
      .select("session_id, response_value, response_label")
      .eq("workspace_id", workspaceId)
      .eq("step_key", "lifecycle")
      .in("session_id", part);
    for (const ev of (data as JourneyLifecycleEvent[] | null) ?? []) out.push(ev);
  }
  return out;
}

/**
 * The read-only results rollup for the pre-renewal-reminder test in a workspace. Composes the
 * harness experiment row + metrics, the reminder send ledger, and the next-order journey events
 * into a typed treatment-vs-holdout shape. Mutates nothing. Returns zeroed arms (and an `absent`
 * verdict) when the experiment doesn't exist for the workspace.
 */
export async function getReminderTestResults(
  admin: Admin,
  workspaceId: string,
): Promise<ReminderTestResults> {
  const slug = PRE_RENEWAL_EXPERIMENT_SLUG;
  const asOf = new Date();

  const [experiment, metrics, ledger] = await Promise.all([
    getExperiment(workspaceId, slug, admin),
    computeExperimentMetrics(workspaceId, slug, { admin, asOf }),
    listReminderLedger(workspaceId, admin),
  ]);

  const sessionIds = ledger
    .map((r) => r.journey_session_id)
    .filter((id): id is string => Boolean(id));
  const lifecycleEvents = await fetchLifecycleEvents(admin, workspaceId, sessionIds);

  const engagement = rollupEngagement(ledger, lifecycleEvents);
  const arms: Record<ExperimentArm, ArmResults> = {
    treatment: buildArmResults(metrics.arms.treatment, engagement.treatment),
    holdout: buildArmResults(metrics.arms.holdout, engagement.holdout),
  };

  // Derived first (the pre-evaluation fallback), then overlay the PERSISTED verdict/guardrail state
  // the guardrail cron wrote (spec Phase 5 — persisted supersedes derived once the cron has run).
  const derivedGuardrails = deriveGuardrails(experiment, arms, engagement);
  const derivedVerdict = deriveVerdict(experiment, arms);
  const { guardrails, verdict } = overlayPersisted(experiment, derivedGuardrails, derivedVerdict);

  return {
    generatedAt: asOf.toISOString(),
    experimentSlug: slug,
    windowDays: metrics.windowDays,
    arms,
    guardrails,
    verdict,
  };
}
