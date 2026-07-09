/**
 * escort-drives-all-greenlit-goals-not-just-platform-owned — regression fixture. Pins the exact failing
 * state the spec's Phase 1 verification names: a growth-owned greenlit goal whose member spec is ready
 * (blockers cleared, review passed, no in-flight build) MUST be included in the escort set. Before this
 * fix, `escortApprovedGoals` filtered `goals.filter((g) => g.owner === PLATFORM)` — so a growth-owned
 * goal (or any non-platform-owned goal) was skipped entirely, which is why the autonomous-media-buyer-
 * supervision stall persisted even after the per-spec readiness fixes (blocker-cleared, durable-vale-
 * stamp) landed. The primary lane AND the backstop reconcile share `selectEscortableGoals` so this one
 * regression pins both decision paths.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agents/platform-director-escort-owner-agnostic.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM, selectEscortableGoals } from "./platform-director";
import type { GoalCard, SpecCard } from "../brain-roadmap";

// A minimal buildable SpecCard: not shipped, not deferred, spec-review passed, no uncleared blockers.
// `isBuildableSpec` reads status/phases/shippedPr/valeReviewPassed/autoBuild/blockedBy — every other field
// is inert for the escort admission decision.
function buildableSpec(slug: string): SpecCard {
  return {
    slug,
    title: slug,
    status: "planned",
    summary: "",
    phases: [{ title: "P1", status: "planned", pr: null, merge_sha: null, build_sha: null }],
    counts: { planned: 1, in_progress: 0, shipped: 0, rejected: 0 },
    blockedBy: [],
    valeReviewPassed: true,
    autoBuild: true,
    shippedPr: null,
    repairSignature: false,
  } as unknown as SpecCard;
}

// A minimal greenlit-at-0% goal with ONE member spec (specSlug is milestone-linked so `goalSpecs` resolves
// it via specBySlug). Owner is the ONE dimension each test varies.
function goal(slug: string, owner: string, specSlug: string): GoalCard {
  return {
    slug,
    title: slug,
    outcome: "",
    successMetric: "",
    target: "",
    owner,
    status: "greenlit",
    milestones: [
      {
        id: "M0",
        name: "milestone-0",
        status: "planned",
        specSlugs: [specSlug],
        completion: 0,
      },
    ],
    pct: 0,
    linkedSpecCount: 1,
    accumulation: { onGoalBranch: 0, totalSpecs: 1, allOnGoalBranch: false, exempt: false, exemptReason: "" },
    promotionHeld: false,
    promotionHeldReason: "",
    mainMergeSha: null,
  } as unknown as GoalCard;
}

test("regression: a GROWTH-OWNED greenlit goal with a buildable member spec IS in the escort set — the escort drives every department's greenlit goals, not just Platform-owned ones", () => {
  const growthGoal = goal("autonomous-media-buyer-supervision", "growth", "daily-cadence-cron");
  const specBySlug = new Map<string, SpecCard>([[
    "daily-cadence-cron",
    buildableSpec("daily-cadence-cron"),
  ]]);

  const escortable = selectEscortableGoals([growthGoal], specBySlug);
  assert.equal(
    escortable.length,
    1,
    "the escort MUST include the growth-owned goal — before the fix, `goals.filter(g => g.owner === PLATFORM)` excluded it and its ready spec never dispatched (the 2026-07-08 autonomous-media-buyer-supervision stall shape)",
  );
  assert.equal(escortable[0].slug, "autonomous-media-buyer-supervision");
});

test("regression: PLATFORM-owned and GROWTH-owned greenlit goals — each with buildable members — are BOTH in the escort set (owner-agnostic)", () => {
  const platformGoal = goal("platform-goal", PLATFORM, "platform-spec");
  const growthGoal = goal("growth-goal", "growth", "growth-spec");
  const csGoal = goal("cs-goal", "cs", "cs-spec");
  const specBySlug = new Map<string, SpecCard>([
    ["platform-spec", buildableSpec("platform-spec")],
    ["growth-spec", buildableSpec("growth-spec")],
    ["cs-spec", buildableSpec("cs-spec")],
  ]);

  const escortable = selectEscortableGoals([platformGoal, growthGoal, csGoal], specBySlug);
  const slugs = escortable.map((g) => g.slug).sort();
  assert.deepEqual(slugs, ["cs-goal", "growth-goal", "platform-goal"], "every buildable greenlit goal MUST be in the escort set regardless of owner — Platform is the universal builder");
});

test("guard: a PROPOSED goal (awaits CEO greenlight) is NOT in the escort set — the escort never re-escalates a proposed goal", () => {
  const growthProposed = goal("growth-proposed", "growth", "growth-spec");
  (growthProposed as unknown as { status: string }).status = "proposed";
  const specBySlug = new Map<string, SpecCard>([["growth-spec", buildableSpec("growth-spec")]]);

  const escortable = selectEscortableGoals([growthProposed], specBySlug);
  assert.equal(escortable.length, 0, "the owner-agnostic broadening MUST NOT relax the greenlit gate — a proposed goal still awaits the CEO");
});

test("guard: a greenlit-at-0% goal with NO buildable spec is NOT in the escort set — it's ready for decomposition (Pia), not for the escort", () => {
  const growthGoal = goal("growth-goal", "growth", "growth-spec");
  const specBySlug = new Map<string, SpecCard>(); // no spec resolves — goalSpecs returns []

  const escortable = selectEscortableGoals([growthGoal], specBySlug);
  assert.equal(escortable.length, 0, "the owner-agnostic broadening MUST NOT auto-start a goal that has nothing to build — it's deferred to the human-gated planner");
});

test("guard: a COMPLETE goal (pct=100) is NOT in the escort set", () => {
  const growthGoal = goal("growth-goal", "growth", "growth-spec");
  (growthGoal as unknown as { pct: number }).pct = 100;
  const specBySlug = new Map<string, SpecCard>([["growth-spec", buildableSpec("growth-spec")]]);

  const escortable = selectEscortableGoals([growthGoal], specBySlug);
  assert.equal(escortable.length, 0, "a done goal has nothing left to escort");
});
