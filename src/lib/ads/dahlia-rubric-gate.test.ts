/**
 * dahlia-rubric-gate tests — pin the dahlia-researches-from-winners-flow-ad-library
 * Phase 3 verification invariants:
 *
 *   1. `evaluateReadyToBinGate` with a composite BELOW threshold triggers a `revise`
 *      outcome (NOT a bin insert), and the revise outcome carries the sorted axis
 *      misses so the caller can build the revise prompt.
 *   2. `evaluateReadyToBinGate` with a composite AT/ABOVE threshold triggers a `bin`
 *      outcome (flip ready-to-test).
 *   3. `resolveDahliaRubricMinComposite` reads the threshold from
 *      `iteration_policies.dahlia_rubric_min_composite` — the setpoint, not a hardcoded
 *      constant.
 *   4. Bounded retries: after `MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS` failed attempts, the
 *      gate returns `exhausted` (the caller escalates + HOLDS the campaign out of the
 *      bin, never silently downgrades to `draft`).
 *
 *   +) `resolveDahliaRubricMinComposite` FAIL-CLOSES on a read error / missing row so
 *      an unproven threshold can never authorize an auto-bin (mirrors
 *      `resolveLf8UnderperformanceThreshold`).
 *   +) `computeDahliaRubricComposite` is the average of the 5 axes rounded to an integer.
 *   +) `collectAxisMisses` orders worst-first (score ASC), preserving axis-list order on ties.
 *
 * Pure — no network, no live DB. Runs via:
 *   npx tsx --test src/lib/ads/dahlia-rubric-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDahliaRubricComposite,
  collectAxisMisses,
  evaluateReadyToBinGate,
  resolveDahliaRubricMinComposite,
  MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS,
  DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT,
} from "./dahlia-rubric-gate";
import type { DahliaCreativeRubric } from "./creative-qa";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// ── shared fixtures ────────────────────────────────────────────────────────

/** All-8 rubric — composite = 8. Above the default 7 threshold. */
function rubricAllEights(): DahliaCreativeRubric {
  return {
    competitor_selection: { score: 8, reason: "on-temp" },
    temperature_selection: { score: 8, reason: "cold-fit" },
    creative_quality: { score: 8, reason: "clean" },
    scroll_stopping: { score: 8, reason: "earns line 2" },
    dr_consumer_psychology: { score: 8, reason: "LF8 stack" },
  };
}

/** Below-bar rubric — composite = 5. Two axes score 3-4 (the misses). */
function rubricBelowBar(): DahliaCreativeRubric {
  return {
    competitor_selection: { score: 3, reason: "picked most_aware; task was cold" },
    temperature_selection: { score: 4, reason: "hot-offer leak in a cold ad" },
    creative_quality: { score: 6, reason: "hierarchy weak" },
    scroll_stopping: { score: 6, reason: "second line thin" },
    dr_consumer_psychology: { score: 6, reason: "LF8 present, cialdini thin" },
  };
}

/** Mixed admin — records calls; sequential .from().select().eq().order().limit().maybeSingle(). */
function makeAdmin(seed: {
  policy?: { dahlia_rubric_min_composite: number | null };
  policyError?: string;
  policyMissing?: boolean;
}): { admin: Admin } {
  function fromIterationPolicies() {
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(_col: string, _val: unknown) {
        return builder;
      },
      order(_col: string, _opts: unknown) {
        return builder;
      },
      limit(_n: number) {
        return builder;
      },
      async maybeSingle() {
        if (seed.policyError) return { data: null, error: { message: seed.policyError } };
        if (seed.policyMissing) return { data: null, error: null };
        return { data: seed.policy ?? { dahlia_rubric_min_composite: 7 }, error: null };
      },
    };
    return builder;
  }
  const admin = {
    from(table: string) {
      if (table === "iteration_policies") return fromIterationPolicies();
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as Admin;
  return { admin };
}

// ── 1. `<threshold triggers revise (not a bin insert)` ────────────────────

test("(P3-1) evaluateReadyToBinGate: composite < threshold → revise (not bin), carries sorted axis misses", () => {
  const outcome = evaluateReadyToBinGate({
    rubric: rubricBelowBar(),
    threshold: 7,
    attemptIndex: 0,
  });
  assert.equal(outcome.kind, "revise", "sub-threshold composite triggers a revise, not a bin insert");
  if (outcome.kind !== "revise") return;
  assert.ok(outcome.composite < 7, "composite is below the threshold");
  assert.ok(outcome.misses.length >= 1, "misses list is populated");
  // Worst-first ordering: competitor_selection scored 3 (worst), temperature_selection scored 4.
  assert.equal(outcome.misses[0].axis, "competitor_selection");
  assert.equal(outcome.misses[0].score, 3);
  assert.equal(outcome.misses[1].axis, "temperature_selection");
  assert.equal(outcome.misses[1].score, 4);
  assert.equal(outcome.nextAttemptIndex, 1, "hands the caller the next attempt index");
});

// ── 2. `≥threshold one flips ready-to-test` ────────────────────────────────

test("(P3-2) evaluateReadyToBinGate: composite ≥ threshold → bin (flip to ready-to-test)", () => {
  const outcome = evaluateReadyToBinGate({
    rubric: rubricAllEights(),
    threshold: 7,
    attemptIndex: 0,
  });
  assert.equal(outcome.kind, "bin");
  if (outcome.kind !== "bin") return;
  assert.equal(outcome.composite, 8);
});

test("(P3-2) evaluateReadyToBinGate: composite EQUAL to threshold → bin (inclusive)", () => {
  // Composite = 7 (a mix of 7s + a 6 + an 8 rounds cleanly).
  const rubric: DahliaCreativeRubric = {
    competitor_selection: { score: 7, reason: "on-temp" },
    temperature_selection: { score: 7, reason: "cold-fit" },
    creative_quality: { score: 7, reason: "clean" },
    scroll_stopping: { score: 7, reason: "ok" },
    dr_consumer_psychology: { score: 7, reason: "LF8 stack" },
  };
  const outcome = evaluateReadyToBinGate({ rubric, threshold: 7, attemptIndex: 0 });
  assert.equal(outcome.kind, "bin");
  if (outcome.kind !== "bin") return;
  assert.equal(outcome.composite, 7);
});

// ── 3. `threshold reads from setpoint (not hardcoded)` ────────────────────

test("(P3-3) resolveDahliaRubricMinComposite: reads the value from iteration_policies (not the DEFAULT)", async () => {
  const { admin } = makeAdmin({ policy: { dahlia_rubric_min_composite: 9 } });
  const result = await resolveDahliaRubricMinComposite(admin, "ws-1");
  assert.equal(result.ok, true, "successful read");
  if (result.ok !== true) return;
  assert.equal(result.value, 9, "reads the workspace-tuned setpoint, NOT the DEFAULT (7)");
  assert.notEqual(result.value, DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT, "value is not the hardcoded default");
});

test("(P3-3) resolveDahliaRubricMinComposite: NULL column value falls back to DEFAULT (7)", async () => {
  const { admin } = makeAdmin({ policy: { dahlia_rubric_min_composite: null } });
  const result = await resolveDahliaRubricMinComposite(admin, "ws-1");
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.value, DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT);
});

test("(P3-3) resolveDahliaRubricMinComposite: FAIL-CLOSED on missing row (no iteration_policies for workspace)", async () => {
  const { admin } = makeAdmin({ policyMissing: true });
  const result = await resolveDahliaRubricMinComposite(admin, "ws-orphan");
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.match(result.reason, /no iteration_policies row/);
});

test("(P3-3) resolveDahliaRubricMinComposite: FAIL-CLOSED on Supabase read error", async () => {
  const { admin } = makeAdmin({ policyError: "connection refused" });
  const result = await resolveDahliaRubricMinComposite(admin, "ws-1");
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.match(result.reason, /iteration_policies read failed/);
  assert.match(result.reason, /connection refused/);
});

// ── 4. `bounded retries cap the loop` ──────────────────────────────────────

test("(P3-4) evaluateReadyToBinGate: after MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS failed attempts → exhausted", () => {
  const outcome = evaluateReadyToBinGate({
    rubric: rubricBelowBar(),
    threshold: 7,
    attemptIndex: MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS, // The Nth revise just returned sub-bar
  });
  assert.equal(outcome.kind, "exhausted");
  if (outcome.kind !== "exhausted") return;
  assert.ok(outcome.composite < 7);
  assert.ok(outcome.misses.length >= 1);
});

test("(P3-4) evaluateReadyToBinGate: attemptIndex = cap - 1 still revises (last sanctioned retry)", () => {
  const outcome = evaluateReadyToBinGate({
    rubric: rubricBelowBar(),
    threshold: 7,
    attemptIndex: MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS - 1,
  });
  assert.equal(outcome.kind, "revise", "one more revise fits under the cap");
});

test("(P3-4) evaluateReadyToBinGate: caller can override maxReviseAttempts", () => {
  const outcome = evaluateReadyToBinGate({
    rubric: rubricBelowBar(),
    threshold: 7,
    attemptIndex: 1,
    maxReviseAttempts: 1,
  });
  assert.equal(outcome.kind, "exhausted", "cap of 1 spent after the first revise");
});

// ── Sanity: pure helpers ───────────────────────────────────────────────────

test("(P3-*) computeDahliaRubricComposite: average of 5 axes, rounded to nearest integer", () => {
  const rubric: DahliaCreativeRubric = {
    competitor_selection: { score: 9, reason: "" },
    temperature_selection: { score: 8, reason: "" },
    creative_quality: { score: 7, reason: "" },
    scroll_stopping: { score: 8, reason: "" },
    dr_consumer_psychology: { score: 8, reason: "" },
  };
  // sum = 40; avg = 8.0 → 8
  assert.equal(computeDahliaRubricComposite(rubric), 8);
});

test("(P3-*) computeDahliaRubricComposite: rounds .5 away from zero", () => {
  const rubric: DahliaCreativeRubric = {
    competitor_selection: { score: 7, reason: "" },
    temperature_selection: { score: 8, reason: "" },
    creative_quality: { score: 7, reason: "" },
    scroll_stopping: { score: 8, reason: "" },
    dr_consumer_psychology: { score: 8, reason: "" },
  };
  // sum = 38; avg = 7.6 → 8
  assert.equal(computeDahliaRubricComposite(rubric), 8);
});

test("(P3-*) collectAxisMisses: worst-first sort, ties preserve DAHLIA_RUBRIC_AXES order", () => {
  const rubric: DahliaCreativeRubric = {
    competitor_selection: { score: 4, reason: "a" },
    temperature_selection: { score: 4, reason: "b" }, // tie with competitor_selection
    creative_quality: { score: 8, reason: "c" },
    scroll_stopping: { score: 3, reason: "d" },
    dr_consumer_psychology: { score: 5, reason: "e" },
  };
  const misses = collectAxisMisses(rubric, 7);
  // scroll_stopping (3) is worst.
  assert.equal(misses[0].axis, "scroll_stopping");
  // Ties (competitor_selection & temperature_selection both at 4) preserve DAHLIA_RUBRIC_AXES order.
  assert.equal(misses[1].axis, "competitor_selection");
  assert.equal(misses[2].axis, "temperature_selection");
  assert.equal(misses[3].axis, "dr_consumer_psychology");
  // creative_quality (8) is not a miss.
  assert.ok(!misses.some((m) => m.axis === "creative_quality"));
});
