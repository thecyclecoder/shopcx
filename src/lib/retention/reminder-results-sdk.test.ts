/**
 * Unit tests for the pre-renewal-reminder results lens pure core (renewal-reminder-results-dashboard
 * Phase 1 · [[../../../docs/brain/libraries/reminder-results-sdk]]).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/retention/reminder-results-sdk.test.ts
 *
 * The DB-reading orchestrator (`getReminderTestResults`) composes the harness metrics + ledger +
 * journey events against a real pooler; these tests pin the PURE rollup math the page's numbers rest
 * on — engagement folding, arm assembly, guardrails, and the derived verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rollupEngagement,
  buildArmResults,
  computeMaturedArmRevenue,
  deriveGuardrails,
  deriveVerdict,
  type ArmEngagement,
} from "@/lib/retention/reminder-results-sdk";
import type { ArmMetrics, GroupNetRevenue } from "@/lib/subscriber-experiment-metrics";
import type { ExperimentArm, CustomerLifecycleExperimentRow } from "@/lib/subscriber-experiments";
import type { ReminderLedgerRow } from "@/lib/pre-renewal-reminders";

function ledgerRow(over: Partial<ReminderLedgerRow>): ReminderLedgerRow {
  return {
    group_id: "g",
    customer_id: "c",
    experiment_arm: "treatment",
    status: "sent",
    channels: ["email"],
    journey_session_id: null,
    email_status: "sent",
    sms_status: null,
    sms_suppression_reason: null,
    sms_scheduled_send_at: null,
    next_billing_date: null,
    ...over,
  };
}

function metrics(arm: ExperimentArm, over: Partial<ArmMetrics>): ArmMetrics {
  return {
    arm,
    customerGroups: 0,
    netRevenueCents: 0,
    grossRevenueCents: 0,
    refundsCents: 0,
    refundedCustomerGroups: 0,
    netRevenuePerCustomerCents: 0,
    netRevenueVarianceCents2: 0,
    voluntaryCancelRate: 0,
    skipRate: 0,
    swapAddOnRate: 0,
    distinctProductsPerCustomer: 0,
    ...over,
  };
}

function emptyEngagement(): ArmEngagement {
  return {
    reminded: 0,
    emailsSent: 0,
    smsSent: 0,
    smsSuppressedStop: 0,
    smsSuppressedNoConsent: 0,
    smsOptOutsAfterReminder: 0,
    opened: 0,
    edited: 0,
    swapped: 0,
    skipped: 0,
    cancelled: 0,
    saved: 0,
  };
}

test("rollupEngagement folds send + suppression counts per arm from the ledger", () => {
  const rows: ReminderLedgerRow[] = [
    ledgerRow({ experiment_arm: "treatment", email_status: "sent", sms_status: "sent" }),
    ledgerRow({ experiment_arm: "treatment", email_status: "sent", sms_status: "suppressed_stop" }),
    ledgerRow({ experiment_arm: "treatment", email_status: "failed", sms_status: "suppressed_no_consent" }),
    ledgerRow({ experiment_arm: "holdout", status: "holdout", email_status: null, sms_status: null, channels: [] }),
  ];
  const e = rollupEngagement(rows, []);
  assert.equal(e.treatment.reminded, 3);
  assert.equal(e.treatment.emailsSent, 2);
  assert.equal(e.treatment.smsSent, 1);
  assert.equal(e.treatment.smsSuppressedStop, 1);
  assert.equal(e.treatment.smsSuppressedNoConsent, 1);
  assert.equal(e.holdout.reminded, 1);
  assert.equal(e.holdout.emailsSent, 0);
});

test("rollupEngagement attributes journey lifecycle events to the ledger's arm; holdout stays zero", () => {
  const rows: ReminderLedgerRow[] = [
    ledgerRow({ experiment_arm: "treatment", journey_session_id: "s1" }),
    ledgerRow({ experiment_arm: "holdout", journey_session_id: null, status: "holdout" }),
  ];
  const events = [
    { session_id: "s1", response_value: "opened", response_label: null },
    { session_id: "s1", response_value: "edited", response_label: "swapped a flavor" },
    { session_id: "s1", response_value: "edited", response_label: "added an item to your subscription" },
    { session_id: "s1", response_value: "edited", response_label: "updated your next delivery date" },
    { session_id: "s1", response_value: "skipped", response_label: "skipped your next order" },
    { session_id: "s1", response_value: "saved", response_label: null },
    { session_id: "s1", response_value: "cancelled", response_label: null },
    { session_id: "orphan", response_value: "opened", response_label: null }, // not on the ledger → ignored
  ];
  const e = rollupEngagement(rows, events);
  assert.equal(e.treatment.opened, 1);
  assert.equal(e.treatment.edited, 3);
  assert.equal(e.treatment.swapped, 2); // swap + add, not the date change
  assert.equal(e.treatment.skipped, 1);
  assert.equal(e.treatment.saved, 1);
  assert.equal(e.treatment.cancelled, 1);
  // Holdout gets no journey → every engagement count is zero (the clean counterfactual).
  assert.equal(e.holdout.opened, 0);
  assert.equal(e.holdout.edited, 0);
});

test("rollupEngagement counts only POST-reminder opt-outs, never already-unsubscribed customers", () => {
  const textedAt = "2026-11-24T18:00:00.000Z";
  const rows: ReminderLedgerRow[] = [
    // Texted, then opted out AFTER the send → the one real post-reminder opt-out.
    ledgerRow({ customer_id: "optout-after", sms_status: "scheduled", sms_scheduled_send_at: textedAt }),
    // Texted, still subscribed → not an opt-out.
    ledgerRow({ customer_id: "still-sub", sms_status: "sent", sms_scheduled_send_at: textedAt }),
    // Already unsubscribed before the run → suppressed, never texted → informational only.
    ledgerRow({ customer_id: "pre-stop", sms_status: "suppressed_stop", sms_scheduled_send_at: null }),
  ];
  const optOuts = new Map<string, string | null>([
    ["optout-after", "2026-11-25T09:00:00.000Z"], // after the text
  ]);
  const e = rollupEngagement(rows, [], optOuts);
  assert.equal(e.treatment.smsSent, 2);
  assert.equal(e.treatment.smsOptOutsAfterReminder, 1);
  assert.equal(e.treatment.smsSuppressedStop, 1);
});

test("rollupEngagement does NOT count an opt-out stamped before the text was sent", () => {
  const rows: ReminderLedgerRow[] = [
    ledgerRow({ customer_id: "c1", sms_status: "scheduled", sms_scheduled_send_at: "2026-11-24T18:00:00.000Z" }),
  ];
  // The flip predates the send → not caused by the reminder.
  const optOuts = new Map<string, string | null>([["c1", "2026-11-20T10:00:00.000Z"]]);
  const e = rollupEngagement(rows, [], optOuts);
  assert.equal(e.treatment.smsOptOutsAfterReminder, 0);
});

test("buildArmResults derives refund rate from refunded groups / total groups", () => {
  const withRefunds = buildArmResults(
    metrics("treatment", { customerGroups: 10, refundedCustomerGroups: 2, grossRevenueCents: 50000, refundsCents: 3000 }),
    emptyEngagement(),
  );
  assert.equal(withRefunds.refundRate, 0.2);
  assert.equal(withRefunds.grossRevenueCents, 50000);
  // Zero groups never divides by zero.
  const empty = buildArmResults(metrics("holdout", { customerGroups: 0, refundedCustomerGroups: 0 }), emptyEngagement());
  assert.equal(empty.refundRate, 0);
});

test("computeMaturedArmRevenue averages ONLY groups whose reminded renewal has billed + settled", () => {
  const now = new Date("2026-11-28T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  const matured = new Date(now.getTime() - 10 * day).toISOString(); // > 7-day settle buffer
  const fresh = new Date(now.getTime() - 2 * day).toISOString(); // within the buffer → not matured
  const perGroupNet: GroupNetRevenue[] = [
    { groupId: "t-matured-1", arm: "treatment", netRevenueCents: 6000 },
    { groupId: "t-matured-2", arm: "treatment", netRevenueCents: 4000 },
    { groupId: "t-fresh", arm: "treatment", netRevenueCents: 0 }, // partial window → excluded
    { groupId: "t-noledger", arm: "treatment", netRevenueCents: 9999 }, // no renewal date → excluded
    { groupId: "h-matured", arm: "holdout", netRevenueCents: 5000 },
  ];
  const renewals = new Map<string, string | null>([
    ["t-matured-1", matured],
    ["t-matured-2", matured],
    ["t-fresh", fresh],
    ["h-matured", matured],
    // t-noledger intentionally absent.
  ]);
  const t = computeMaturedArmRevenue(perGroupNet, renewals, "treatment", now);
  assert.equal(t.maturedGroups, 2);
  assert.equal(t.maturedNetRevenuePerCustomerCents, 5000); // (6000 + 4000) / 2, fresh + no-ledger excluded
  const h = computeMaturedArmRevenue(perGroupNet, renewals, "holdout", now);
  assert.equal(h.maturedGroups, 1);
  assert.equal(h.maturedNetRevenuePerCustomerCents, 5000);
  // No matured groups → a clean zero, never a divide-by-zero.
  const none = computeMaturedArmRevenue(perGroupNet, new Map(), "treatment", now);
  assert.equal(none.maturedGroups, 0);
  assert.equal(none.maturedNetRevenuePerCustomerCents, 0);
});

test("deriveGuardrails flags sample completion and watches a worse treatment refund rate", () => {
  const experiment = { required_n_per_arm: 100 } as CustomerLifecycleExperimentRow;
  const treatment = buildArmResults(
    metrics("treatment", { customerGroups: 120, refundedCustomerGroups: 12 }),
    { ...emptyEngagement(), smsSuppressedStop: 3 },
  );
  const holdout = buildArmResults(
    metrics("holdout", { customerGroups: 110, refundedCustomerGroups: 2 }),
    emptyEngagement(),
  );
  const g = deriveGuardrails(experiment, { treatment, holdout }, { treatment: treatment.engagement, holdout: holdout.engagement });
  assert.equal(g.requiredNPerArm, 100);
  assert.equal(g.sampleComplete, true);
  // The 3 suppressed_stop customers were already unsubscribed BEFORE the run — informational only,
  // never counted as a reminder-caused opt-out.
  assert.equal(g.smsAlreadyUnsubscribed, 3);
  assert.equal(g.smsOptOutsAfterReminder, 0);
  assert.equal(g.status, "watch");
  assert.ok(g.notes.some((n) => n.includes("refund")));
});

test("deriveGuardrails stays ok and incomplete when sample is short and metrics are even", () => {
  const experiment = { required_n_per_arm: 500 } as CustomerLifecycleExperimentRow;
  const treatment = buildArmResults(metrics("treatment", { customerGroups: 50 }), emptyEngagement());
  const holdout = buildArmResults(metrics("holdout", { customerGroups: 48 }), emptyEngagement());
  const g = deriveGuardrails(experiment, { treatment, holdout }, { treatment: treatment.engagement, holdout: holdout.engagement });
  assert.equal(g.sampleComplete, false);
  assert.equal(g.status, "ok");
  assert.equal(g.notes.length, 0);
});

test("deriveVerdict reports the leading arm by net revenue per customer and conclusion by status", () => {
  const treatment = buildArmResults(metrics("treatment", { customerGroups: 10, netRevenuePerCustomerCents: 8000 }), emptyEngagement());
  const holdout = buildArmResults(metrics("holdout", { customerGroups: 10, netRevenuePerCustomerCents: 6000 }), emptyEngagement());

  const running = deriveVerdict({ status: "running" } as CustomerLifecycleExperimentRow, { treatment, holdout });
  assert.equal(running.concluded, false);
  assert.equal(running.leadingArm, "treatment");
  assert.equal(running.netRevenuePerCustomerLiftCents, 2000);
  assert.equal(running.derived, true);

  const complete = deriveVerdict({ status: "complete" } as CustomerLifecycleExperimentRow, { treatment, holdout });
  assert.equal(complete.concluded, true);
  assert.equal(complete.experimentStatus, "complete");

  // Absent experiment / no data → no leading arm and no interval.
  const emptyT = buildArmResults(metrics("treatment", {}), emptyEngagement());
  const emptyH = buildArmResults(metrics("holdout", {}), emptyEngagement());
  const absent = deriveVerdict(null, { treatment: emptyT, holdout: emptyH });
  assert.equal(absent.experimentStatus, "absent");
  assert.equal(absent.leadingArm, null);
  assert.equal(absent.confidenceIntervalCents, null);
  assert.equal(absent.significant, false);
});

test("deriveVerdict reports a confidence interval on the lift once both arms have ≥2 groups", () => {
  // Big mean gap, tiny variance, healthy n → the CI should exclude 0 (significant).
  const treatment = buildArmResults(
    metrics("treatment", { customerGroups: 200, netRevenuePerCustomerCents: 8000, netRevenueVarianceCents2: 250000 }),
    emptyEngagement(),
  );
  const holdout = buildArmResults(
    metrics("holdout", { customerGroups: 200, netRevenuePerCustomerCents: 6000, netRevenueVarianceCents2: 250000 }),
    emptyEngagement(),
  );
  const v = deriveVerdict({ status: "complete", alpha: 0.05 } as CustomerLifecycleExperimentRow, { treatment, holdout });
  assert.ok(v.confidenceIntervalCents, "interval present");
  assert.equal(v.netRevenuePerCustomerLiftCents, 2000);
  // Interval brackets the point estimate and (here) excludes 0.
  assert.ok(v.confidenceIntervalCents!.lowCents < 2000 && v.confidenceIntervalCents!.highCents > 2000);
  assert.ok(v.confidenceIntervalCents!.lowCents > 0);
  assert.equal(v.significant, true);

  // A tiny gap swamped by huge variance → interval spans 0, not significant.
  const noisyT = buildArmResults(metrics("treatment", { customerGroups: 60, netRevenuePerCustomerCents: 6010, netRevenueVarianceCents2: 90000000 }), emptyEngagement());
  const noisyH = buildArmResults(metrics("holdout", { customerGroups: 60, netRevenuePerCustomerCents: 6000, netRevenueVarianceCents2: 90000000 }), emptyEngagement());
  const noisy = deriveVerdict({ status: "complete", alpha: 0.05 } as CustomerLifecycleExperimentRow, { treatment: noisyT, holdout: noisyH });
  assert.equal(noisy.significant, false);
  assert.ok(noisy.confidenceIntervalCents!.lowCents < 0 && noisy.confidenceIntervalCents!.highCents > 0);
});
