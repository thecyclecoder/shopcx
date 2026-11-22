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
  deriveGuardrails,
  deriveVerdict,
  type ArmEngagement,
} from "@/lib/retention/reminder-results-sdk";
import type { ArmMetrics } from "@/lib/subscriber-experiment-metrics";
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
  assert.equal(g.smsOptOuts, 3);
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

  // Absent experiment / no data → no leading arm.
  const emptyT = buildArmResults(metrics("treatment", {}), emptyEngagement());
  const emptyH = buildArmResults(metrics("holdout", {}), emptyEngagement());
  const absent = deriveVerdict(null, { treatment: emptyT, holdout: emptyH });
  assert.equal(absent.experimentStatus, "absent");
  assert.equal(absent.leadingArm, null);
});
