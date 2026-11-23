/**
 * Unit tests for the pre-renewal-reminder guardrail + verdict engine's PURE core (spec:
 * renewal-reminder-launch-followups Phase 2).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/subscriber-experiment-guardrails.test.ts
 *
 * These pin the two named failing states Phase 2 fixes:
 *   1. evaluateVerdict named a winner at a 1% relative lift with NO significance test, though the
 *      test is powered for ~10% — now a winner needs the Welch CI to exclude 0, and the verdict
 *      reports that interval.
 *   2. The cancel/refund HARD_FLOORS tripped on the treatment arm's ABSOLUTE rate, so normal 90-day
 *      churn (which hits both arms) could pause the test — now they trip only on treatment's EXCESS
 *      over holdout, and only past the min-sample bar. The SMS STOP floor stays absolute.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateVerdict,
  evaluateGuardrails,
  HARD_FLOORS,
} from "@/lib/subscriber-experiment-guardrails";
import type { ArmResults, ArmEngagement } from "@/lib/retention/reminder-results-sdk";

function engagement(over: Partial<ArmEngagement> = {}): ArmEngagement {
  return {
    reminded: 0, emailsSent: 0, smsSent: 0, smsSuppressedStop: 0, smsSuppressedNoConsent: 0,
    opened: 0, edited: 0, swapped: 0, skipped: 0, cancelled: 0, saved: 0, ...over,
  };
}

function arm(a: "treatment" | "holdout", over: Partial<ArmResults> = {}): ArmResults {
  return {
    arm: a,
    customerGroups: 0,
    engagement: engagement(),
    netRevenueCents: 0,
    netRevenuePerCustomerCents: 0,
    netRevenueVarianceCents2: 0,
    grossRevenueCents: 0,
    refundsCents: 0,
    refundRate: 0,
    voluntaryCancelRate: 0,
    ...over,
  };
}

/* ── Verdict: significance, not a bare 1% lift ─────────────────────────────────────────────── */

test("evaluateVerdict is no_difference when a small lift is swamped by variance (powered for ~10%)", () => {
  // ~1% lift ($60.10 vs $60.00) with huge per-person variance → NOT significant at alpha.
  const t = arm("treatment", { customerGroups: 80, netRevenuePerCustomerCents: 6010, netRevenueVarianceCents2: 90_000_000 });
  const h = arm("holdout", { customerGroups: 80, netRevenuePerCustomerCents: 6000, netRevenueVarianceCents2: 90_000_000 });
  const v = evaluateVerdict(t, h, 0.05);
  assert.equal(v.verdict, "no_difference");
  assert.equal(v.detail.significant, false);
  const ci = v.detail.confidenceInterval as { lowCents: number; highCents: number };
  assert.ok(ci.lowCents < 0 && ci.highCents > 0, "interval spans 0 → no winner");
});

test("evaluateVerdict declares a winner only when the Welch interval excludes 0, and reports it", () => {
  const t = arm("treatment", { customerGroups: 200, netRevenuePerCustomerCents: 8000, netRevenueVarianceCents2: 250_000 });
  const h = arm("holdout", { customerGroups: 200, netRevenuePerCustomerCents: 6000, netRevenueVarianceCents2: 250_000 });
  const v = evaluateVerdict(t, h, 0.05);
  assert.equal(v.verdict, "treatment_wins");
  assert.equal(v.detail.significant, true);
  const ci = v.detail.confidenceInterval as { lowCents: number; highCents: number };
  assert.ok(ci.lowCents > 0, "interval is entirely above 0");
  assert.equal(v.detail.liftCents, 2000);
});

/* ── Floors: holdout-relative, not absolute on treatment ───────────────────────────────────── */

test("cancel + refund floors do NOT trip when both arms share high baseline churn (the named bug)", () => {
  // Both arms at a 25% cancel + 25% refund rate — ABOVE the old absolute 0.2 floor — but EQUAL, so
  // the reminder caused no excess. Must not pause the test.
  const t = arm("treatment", { customerGroups: 100, voluntaryCancelRate: 0.25, refundRate: 0.25 });
  const h = arm("holdout", { customerGroups: 100, voluntaryCancelRate: 0.25, refundRate: 0.25 });
  const e = evaluateGuardrails(t, h);
  const cancel = e.signals.find((s) => s.key === "voluntary_cancel")!;
  const refund = e.signals.find((s) => s.key === "refund")!;
  assert.equal(cancel.tripped, false);
  assert.equal(refund.tripped, false);
});

test("cancel floor trips on treatment's EXCESS over holdout past the min-sample bar", () => {
  const t = arm("treatment", { customerGroups: 80, voluntaryCancelRate: 0.20 });
  const h = arm("holdout", { customerGroups: 80, voluntaryCancelRate: 0.10 }); // excess 10pts ≥ 5pts
  const e = evaluateGuardrails(t, h);
  assert.equal(e.signals.find((s) => s.key === "voluntary_cancel")!.tripped, true);
});

test("excess floor does NOT trip below the min-sample bar", () => {
  // Same 10pt excess but tiny n (< netRevenueMinN) → excess floor gated off; thin-sample significance
  // also can't reject, so the signal stays untripped.
  const n = HARD_FLOORS.netRevenueMinN - 1;
  const t = arm("treatment", { customerGroups: n, voluntaryCancelRate: 0.20, refundRate: 0.20 });
  const h = arm("holdout", { customerGroups: n, voluntaryCancelRate: 0.10, refundRate: 0.10 });
  const e = evaluateGuardrails(t, h);
  assert.equal(e.signals.find((s) => s.key === "voluntary_cancel")!.tripped, false);
  assert.equal(e.signals.find((s) => s.key === "refund")!.tripped, false);
});

test("SMS STOP opt-out floor stays ABSOLUTE on the treatment arm", () => {
  // Treatment sends SMS; holdout sends none. A STOP rate at/above the absolute floor trips with no
  // holdout baseline to net against.
  const reminded = 100;
  const stops = Math.ceil(reminded * HARD_FLOORS.smsOptOutRate); // ≥ 5%
  const t = arm("treatment", { customerGroups: 100, engagement: engagement({ reminded, smsSuppressedStop: stops }) });
  const h = arm("holdout", { customerGroups: 100, engagement: engagement({ reminded: 100 }) });
  const e = evaluateGuardrails(t, h);
  assert.equal(e.signals.find((s) => s.key === "sms_opt_out")!.tripped, true);
});
