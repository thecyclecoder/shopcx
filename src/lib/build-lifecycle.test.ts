/**
 * Unit tests for the 5-node build-lifecycle timeline derivation (build-card-lifecycle-timeline Phase 1),
 * pinned to the BRANCH-FLOW stage order (spec-goal-branch-pm-flow): build-on-branch → pre-merge spec-test
 * → pre-merge security → ship-to-main → fold. The bug these guard against: a spec built on its branch with
 * a LIVE pre-merge spec-test rendered Build=active + Spec Test/Security greyed (the old `status !== shipped
 * → pending` gates), making the card look like "no spec test happened" during the whole pre-merge window.
 *
 * Pure helper — no DB. Run:
 *   npm run test:build-lifecycle
 *   (= tsx --test src/lib/build-lifecycle.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLifecycleStage, type LifecycleContext, type LifecycleStageName, type LifecycleStageStatus } from "./build-lifecycle";
import { buildLifecycleContext } from "./build-lifecycle-context";
import type { SpecCard } from "./brain-roadmap";
import type { AgentJob } from "./agent-jobs";

// A neutral context: past Vale, nothing built, no test/security signals. Each test overrides what it pins.
function ctx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    status: "in_progress",
    valePass: true,
    phases: [],
    builtOnBranch: false,
    buildLive: false,
    buildNeedsAttention: false,
    specTestVerdict: null,
    specTestHasOpenRegression: false,
    specTestLive: false,
    specTestHasChecks: true,
    securityLive: false,
    securitySurfaced: false,
    securityCompletedClean: false,
    ...overrides,
  };
}

function byName(c: LifecycleContext): Record<LifecycleStageName, LifecycleStageStatus> {
  const d = deriveLifecycleStage(c);
  return Object.fromEntries(d.stages.map((s) => [s.name, s.status])) as Record<LifecycleStageName, LifecycleStageStatus>;
}

// ── The bug: pre-merge spec-test in flight ────────────────────────────────────────

test("BUG FIX: built on branch + LIVE pre-merge spec-test → Build=done, Spec Test=active, Security=pending", () => {
  // status is NOT shipped (still on its branch), phases are build_sha'd (builtOnBranch), a live spec-test job.
  const c = ctx({ status: "in_progress", builtOnBranch: true, specTestVerdict: null, specTestLive: true });
  const s = byName(c);
  assert.equal(s.build, "done", "Build must be done once built on branch — not active for the whole pre-merge window");
  assert.equal(s["spec-test"], "active", "a live pre-merge spec-test must light the node active, not grey");
  assert.equal(s["security-test"], "pending");
  assert.equal(s.fold, "pending");
  assert.equal(deriveLifecycleStage(c).current, "spec-test");
});

test("built on branch, no spec-test run yet (verdict null, no live job) → Spec Test still active (queued)", () => {
  const s = byName(ctx({ status: "in_progress", builtOnBranch: true }));
  assert.equal(s.build, "done");
  assert.equal(s["spec-test"], "active");
  assert.equal(s["security-test"], "pending");
});

// ── human-only-specs-ship-and-fold: a needs_human (0 machine checks) run IS a complete spec-test ─────

test("human-only run (needs_human + >=1 check, no regression, not live) → Spec Test=done, Security current", () => {
  // A spec whose Verification is entirely advisory human checks: 0 machine tests to run, so needs_human is
  // its TERMINAL spec-test state. The node must read `done` (mirrors isCleanMachinePassRun / the fold gate)
  // and advance to Security — NOT sit on "QA-verifying" forever (the CEO-flagged visual lag).
  const c = ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "needs_human", specTestHasChecks: true, specTestLive: false });
  const s = byName(c);
  assert.equal(s["spec-test"], "done", "a human-only needs_human run is a COMPLETE spec-test (nothing to machine-verify)");
  assert.equal(deriveLifecycleStage(c).current, "security-test", "flow must advance to Security");
});

test("degenerate 0-check run (needs_human but specTestHasChecks=false) → Spec Test stays active (not a silent-empty pass)", () => {
  const s = byName(ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "needs_human", specTestHasChecks: false }));
  assert.equal(s["spec-test"], "active", "a 0-check run cannot satisfy the fold gate — must not read done");
});

// ── Pre-merge security in flight ──────────────────────────────────────────────────

test("mid pre-merge security (spec-test approved, security live, NOT shipped) → Spec Test=done, Security=active", () => {
  const c = ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "approved", securityLive: true });
  const s = byName(c);
  assert.equal(s.build, "done");
  assert.equal(s["spec-test"], "done");
  assert.equal(s["security-test"], "active");
  assert.equal(s.fold, "pending");
  assert.equal(deriveLifecycleStage(c).current, "security-test");
});

test("spec-test approved but no security record yet → Security=active (about to fire)", () => {
  const s = byName(ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "approved" }));
  assert.equal(s["spec-test"], "done");
  assert.equal(s["security-test"], "active");
});

// ── Monotonic gating — security stays pending while spec-test still active ─────────

test("security clean but spec-test still active (parallel) → Security shows pending (monotonic timeline)", () => {
  // securityCompletedClean true, but no spec-test verdict yet — the node must not jump ahead of spec-test.
  const s = byName(ctx({ status: "in_progress", builtOnBranch: true, specTestVerdict: null, securityCompletedClean: true }));
  assert.equal(s["spec-test"], "active");
  assert.equal(s["security-test"], "pending");
});

// ── Red spec-test ─────────────────────────────────────────────────────────────────

test("open regression → Spec Test = needs-attention", () => {
  const c = ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "approved", specTestHasOpenRegression: true });
  const s = byName(c);
  assert.equal(s["spec-test"], "needs-attention");
  assert.equal(s["security-test"], "pending", "a red spec-test must hold security pending");
  assert.equal(deriveLifecycleStage(c).current, "spec-test");
});

test("verdict 'issues' → Spec Test = needs-attention", () => {
  assert.equal(byName(ctx({ status: "in_testing", builtOnBranch: true, specTestVerdict: "issues" }))["spec-test"], "needs-attention");
});

// ── Early stage — not built yet (no regression) ───────────────────────────────────

test("planned/in_progress, NOT built on branch, build live → Build=active, Spec Test + Security pending", () => {
  const c = ctx({ status: "in_progress", builtOnBranch: false, buildLive: true, phases: [{ status: "in_progress" }, { status: "planned" }] });
  const s = byName(c);
  assert.equal(s.build, "active");
  assert.equal(s["spec-test"], "pending");
  assert.equal(s["security-test"], "pending");
  assert.equal(deriveLifecycleStage(c).current, "build");
});

test("build surfaced needs_attention → Build=needs-attention, downstream pending", () => {
  const c = ctx({ status: "in_progress", builtOnBranch: false, buildNeedsAttention: true });
  const s = byName(c);
  assert.equal(s.build, "needs-attention");
  assert.equal(s["spec-test"], "pending");
});

// ── Post-merge (shipped) and folded — no regressions ──────────────────────────────

test("shipped, spec-test approved, security clean, not folded → Build/SpecTest/Security done, current=fold", () => {
  const c = ctx({ status: "shipped", builtOnBranch: true, specTestVerdict: "approved", securityCompletedClean: true });
  const s = byName(c);
  assert.equal(s.build, "done");
  assert.equal(s["spec-test"], "done");
  assert.equal(s["security-test"], "done");
  assert.equal(s.fold, "pending");
  assert.equal(deriveLifecycleStage(c).current, "fold");
});

test("folded spec → all five nodes done", () => {
  const c = ctx({ status: "folded", builtOnBranch: true, specTestVerdict: "approved", securityCompletedClean: true });
  for (const s of deriveLifecycleStage(c).stages) assert.equal(s.status, "done", `${s.name} should be done`);
  assert.equal(deriveLifecycleStage(c).current, "fold");
});

// ── Spec-review stage (unchanged) ─────────────────────────────────────────────────

test("in_review, vale null → Spec Review active", () => {
  assert.equal(byName(ctx({ status: "in_review", valePass: null }))["spec-review"], "active");
});

test("in_review, vale false → Spec Review needs-attention", () => {
  assert.equal(byName(ctx({ status: "in_review", valePass: false }))["spec-review"], "needs-attention");
});

// ── buildLifecycleContext.builtOnBranch derivation ────────────────────────────────

function specCard(over: Partial<SpecCard> & Pick<SpecCard, "slug" | "status" | "phases">): SpecCard {
  return { valePass: true, ...over } as unknown as SpecCard;
}

test("builtOnBranch: multi-phase spec, every phase build_sha'd → true (built on branch, pre-merge)", () => {
  const spec = specCard({
    slug: "x",
    status: "in_progress",
    phases: [
      { status: "in_progress", build_sha: "abc" },
      { status: "in_progress", build_sha: "def" },
    ] as SpecCard["phases"],
  });
  const c = buildLifecycleContext({ spec, job: null, testRun: null, humanResolutions: new Map(), liveSpecTestSlugs: new Set(), security: undefined, folded: false });
  assert.equal(c.builtOnBranch, true);
});

test("builtOnBranch: multi-phase spec with an un-built phase (no build_sha) → false", () => {
  const spec = specCard({
    slug: "x",
    status: "in_progress",
    phases: [
      { status: "in_progress", build_sha: "abc" },
      { status: "planned", build_sha: null },
    ] as SpecCard["phases"],
  });
  const c = buildLifecycleContext({ spec, job: null, testRun: null, humanResolutions: new Map(), liveSpecTestSlugs: new Set(), security: undefined, folded: false });
  assert.equal(c.builtOnBranch, false);
});

test("builtOnBranch: one-shot spec (0 phases) with build job completed → true", () => {
  const spec = specCard({ slug: "x", status: "in_progress", phases: [] as SpecCard["phases"] });
  const job = { kind: "build", status: "completed" } as unknown as AgentJob;
  const c = buildLifecycleContext({ spec, job, testRun: null, humanResolutions: new Map(), liveSpecTestSlugs: new Set(), security: undefined, folded: false });
  assert.equal(c.builtOnBranch, true);
});

test("builtOnBranch: one-shot spec, build job still building → false", () => {
  const spec = specCard({ slug: "x", status: "in_progress", phases: [] as SpecCard["phases"] });
  const job = { kind: "build", status: "building" } as unknown as AgentJob;
  const c = buildLifecycleContext({ spec, job, testRun: null, humanResolutions: new Map(), liveSpecTestSlugs: new Set(), security: undefined, folded: false });
  assert.equal(c.builtOnBranch, false);
});
