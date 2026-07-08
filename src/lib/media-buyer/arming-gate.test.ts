/**
 * Unit tests for the media-buyer arming gate — Phase 1 verification
 * (media-buyer-arming-gate). Pins each denial branch of the PURE
 * `evaluateMediaBuyerArmingPure` on fixture inputs so the guard predicates
 * are locked before the DB-touching runner assembles them.
 *
 * The named branches the spec calls out (§ Phase 1):
 *   1. insufficient_sample — reviewed shadow actions < MIN_REVIEWED_SHADOW_ACTIONS.
 *   2. low_agreement — concur rate below MIN_AGREEMENT_RATE.
 *   3. trust_no_snapshots — zero sensor-trust snapshots in the window.
 *   4. trust_streak_short — <MIN_CONSECUTIVE_GREEN_TRUST consecutive green snapshots.
 *   5. blended_cac_ltv_below_target — cacLtvRatio present but < target.
 *   6. blended_cac_ltv_unknown — cacLtvRatio null (no CAC / no LTV / no mapping).
 *
 * Plus the happy path (all three preconditions clear → allowed=true, reasons=[]).
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/arming-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMediaBuyerArmingPure,
  MIN_REVIEWED_SHADOW_ACTIONS,
  MIN_AGREEMENT_RATE,
  MIN_CONSECUTIVE_GREEN_TRUST,
  isoWeekLabel,
  type ShadowReviewInput,
  type TrustSnapshotInput,
} from "./arming-gate";
import { DEFAULT_BLENDED_CAC_LTV_TARGET, type BlendedCacLtvResult } from "@/lib/blended-cac-ltv";

// ── Fixture builders ────────────────────────────────────────────────────────

function makeReviews(concurred: number, dissented: number, undecided: number): ShadowReviewInput[] {
  const rows: ShadowReviewInput[] = [];
  const now = new Date("2026-07-08T12:00:00Z").getTime();
  const push = (verdict: ShadowReviewInput["verdict"], i: number) =>
    rows.push({ verdict, reviewedAt: new Date(now - i * 3_600_000).toISOString() });
  for (let i = 0; i < concurred; i++) push("concur", i);
  for (let i = 0; i < dissented; i++) push("dissent", concurred + i);
  for (let i = 0; i < undecided; i++) push("undecided", concurred + dissented + i);
  return rows;
}

function makeGreenStreak(n: number, endDate = "2026-07-08"): TrustSnapshotInput[] {
  const rows: TrustSnapshotInput[] = [];
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) {
    rows.push({ snapshotDate: new Date(end - i * 86_400_000).toISOString().slice(0, 10), band: "green" });
  }
  return rows;
}

function makeBrokenStreak(): TrustSnapshotInput[] {
  // The latest snapshot is green, then a yellow breaks the streak at position 3.
  const end = new Date("2026-07-08T00:00:00Z").getTime();
  return [
    { snapshotDate: new Date(end - 0 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 1 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 2 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 3 * 86_400_000).toISOString().slice(0, 10), band: "yellow" },
    { snapshotDate: new Date(end - 4 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 5 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 6 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 7 * 86_400_000).toISOString().slice(0, 10), band: "green" },
  ];
}

function makeBlended(overrides: Partial<BlendedCacLtvResult> = {}): BlendedCacLtvResult {
  return {
    cacLtvRatio: DEFAULT_BLENDED_CAC_LTV_TARGET, // exactly at the floor → allowed
    paybackDays: 90,
    blendedSpendCents: 100000,
    blendedNewCustomers: 50,
    blendedRevenueCents: 500000,
    blendedLtvCents: 600000,
    assumptions: {
      marginRoasBlockedOnCogs: true,
      ltvProxyUncalibrated: true,
      creditAmazonHalo: true,
      countAllNonRenewal: true,
      paybackUsesWindowRateExtrapolation: true,
      targetCacLtv: DEFAULT_BLENDED_CAC_LTV_TARGET,
      targetPaybackDays: null,
    },
    flags: [],
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — all three preconditions clear → allowed=true", () => {
  const reviews = makeReviews(24, 1, 0); // 25 reviewed, 24 concur ≥ 0.8 rate
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, true);
  assert.equal(r.reasons.length, 0);
  assert.equal(r.metrics.reviewed, 25);
  assert.equal(r.metrics.concurred, 24);
  assert.equal(r.metrics.consecutiveGreen, MIN_CONSECUTIVE_GREEN_TRUST + 1);
  assert.equal(r.metrics.cacLtvRatio, 3.5);
});

// ── Deny branch 1: insufficient_sample ──────────────────────────────────────

test("evaluateMediaBuyerArmingPure — fewer than MIN_REVIEWED_SHADOW_ACTIONS reviews → insufficient_sample", () => {
  const reviews = makeReviews(4, 1, 0); // only 5 reviewed
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("insufficient_sample"), `expected insufficient_sample, got ${codes.join(",")}`);
  assert.equal(r.metrics.reviewed, 5);
});

// ── Deny branch 2: low_agreement ────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — concur rate below MIN_AGREEMENT_RATE → low_agreement", () => {
  // 25 reviewed, 15 concur → 60% — under the 80% floor.
  const reviews = makeReviews(15, 8, 2);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("low_agreement"), `expected low_agreement, got ${codes.join(",")}`);
  assert.ok(r.metrics.agreementRate !== null && r.metrics.agreementRate < MIN_AGREEMENT_RATE);
});

// ── Deny branch 3: trust_no_snapshots ───────────────────────────────────────

test("evaluateMediaBuyerArmingPure — zero sensor-trust snapshots → trust_no_snapshots", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust: TrustSnapshotInput[] = [];
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_no_snapshots"), `expected trust_no_snapshots, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreen, 0);
});

// ── Deny branch 4: trust_streak_short ───────────────────────────────────────

test("evaluateMediaBuyerArmingPure — <MIN_CONSECUTIVE_GREEN_TRUST consecutive greens → trust_streak_short", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeBrokenStreak(); // only 3 consecutive green from the latest
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_streak_short"), `expected trust_streak_short, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreen, 3);
});

// ── Deny branch 5: blended_cac_ltv_below_target ─────────────────────────────

test("evaluateMediaBuyerArmingPure — blended CAC:LTV below target → blended_cac_ltv_below_target", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 1.5 }); // below the 3× target

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    codes.includes("blended_cac_ltv_below_target"),
    `expected blended_cac_ltv_below_target, got ${codes.join(",")}`,
  );
});

// ── Deny branch 6: blended_cac_ltv_unknown ──────────────────────────────────

test("evaluateMediaBuyerArmingPure — blended CAC:LTV null → blended_cac_ltv_unknown", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: null, flags: ["no new customers in window"] });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("blended_cac_ltv_unknown"), `expected blended_cac_ltv_unknown, got ${codes.join(",")}`);
});

// ── Multiple denials compose ────────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — multiple failing preconditions surface every reason", () => {
  const reviews = makeReviews(3, 1, 0); // insufficient_sample
  const trust: TrustSnapshotInput[] = []; // trust_no_snapshots
  const blended = makeBlended({ cacLtvRatio: null }); // blended_cac_ltv_unknown

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code).sort();
  assert.deepEqual(codes, ["blended_cac_ltv_unknown", "insufficient_sample", "trust_no_snapshots"]);
});

// ── ISO week label ──────────────────────────────────────────────────────────

test("isoWeekLabel — 2026-07-08 lands in ISO week 28", () => {
  assert.equal(isoWeekLabel(new Date("2026-07-08T12:00:00Z")), "2026-W28");
});

test("isoWeekLabel — Monday 2026-01-05 is week 02", () => {
  assert.equal(isoWeekLabel(new Date("2026-01-05T00:00:00Z")), "2026-W02");
});
