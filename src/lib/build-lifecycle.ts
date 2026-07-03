/**
 * build-lifecycle — DB-driven derivation of which of the 5 lifecycle stages a spec card is currently on
 * (build-card-lifecycle-timeline Phase 1).
 *
 * The 5 stages, in order: `spec-review` → `build` → `spec-test` → `security-test` → `fold`.
 *
 * **Branch-flow order (spec-goal-branch-pm-flow).** The pipeline builds + TESTS a spec on its branch
 * preview BEFORE promoting it to `main`: build-on-branch → spec-test (pre-merge) → security (pre-merge)
 * → MERGE/ship to main → fold. So the Build node is `done` once the spec is **built on its branch**
 * (every phase carries a `build_sha`, or — one-shot — the build job reached completed/merged), NOT when
 * the spec has shipped; and Spec Test + Security are the **pre-merge gates** that run while the spec is
 * still `in_testing` (built + being tested on a branch, not yet on main). The "shipped to main" event
 * happens between Security-done and Fold — the card's top 3-node timeline (built on branch → in testing →
 * shipped) shows it; this 5-node detail folds it into that Build/SpecTest/Security → Fold transition.
 *
 * `deriveLifecycleStage(ctx)` is **pure + side-effect-free** — it reads only the context the board /
 * Control Tower already loads (the spec's status, vale_pass, phases, the built-on-branch signal, the
 * latest spec_test_runs row, the live/terminal security-review agent_jobs state for the slug). No DB
 * reads, no I/O. Unit-testable from a fixture (see `src/lib/build-lifecycle.test.ts`).
 *
 * Per-stage rollup mirrors the spec language so the timeline UI (Phase 2) can render a check on every
 * completed upstream stage AND attach the live status pill to the CURRENT (earliest non-done) stage. The
 * current stage is the furthest-right stage the spec has reached — by construction the upstream stages are
 * `done` once that current stage is reached, because the inputs progress monotonically (Build can't be done
 * until the spec is built on its branch; Spec Test can't be done until Build is; Security can't be done
 * until Spec Test is).
 *
 * Security state in this helper MUST match what the fold gate (Phase 3) will read — the Security node can
 * never read "done" while the gate still blocks, or vice-versa.
 */
import type { Phase, SpecStatus } from "@/lib/brain-roadmap";
import type { AgentVerdict } from "@/lib/spec-test-runs";

/** The 5 lifecycle stages a build-card moves through, in order. */
export type LifecycleStageName = "spec-review" | "build" | "spec-test" | "security-test" | "fold";

/** Per-stage rollup status. `pending` = not started; `active` = running; `done` = checked;
 *  `needs-attention` = surfaced for the owner (a stop). */
export type LifecycleStageStatus = "pending" | "active" | "done" | "needs-attention";

/** Inputs the board / Control Tower already load per spec. The helper is pure over this shape. */
export interface LifecycleContext {
  /** Whole-spec status. `SpecCard.status` (from `brain-roadmap`) is filtered to boardable values and never
   *  surfaces `folded`, so callers reading a card pass `"folded"` here when the row's `specs.status` is
   *  `folded` (the archive lane). */
  status: SpecStatus | "folded";
  /** Vale's CHECKLIST verdict mirrored from `specs.vale_pass`. `null` = not yet verdicted (a brand-new or
   *  freshly sent-back spec); `true` = cleared; `false` = a needs_fix verdict. Only consulted when the spec
   *  is in `in_review` (a passed/non-in_review spec is past this stage). */
  valePass: boolean | null;
  /** The spec's phases (only `status` is read here) — the SpecCard.phases array verbatim. */
  phases: { status: Phase }[];
  /** **Built on its branch** — the branch-flow Build-done signal (spec-goal-branch-pm-flow). True once the
   *  spec is fully built on `claude/build-{slug}`, BEFORE it merges to main: a multi-phase spec where every
   *  phase carries a `build_sha` or is terminal (the `isSpecAccumulationComplete` condition), or a one-shot
   *  spec whose build job reached `completed`/`merged`, or any spec already at `in_testing`/`shipped`/
   *  `folded`. Computed in `build-lifecycle-context.ts` from the SpecCard's phases (`build_sha`) + the build
   *  job — the helper just reads it. This is what makes the Build node go `done` while spec-test/security
   *  run pre-merge, instead of staying `active` for the whole pre-merge testing window. */
  builtOnBranch: boolean;
  /** A `build` `agent_jobs` row for this slug in ACTIVE_STATUSES (live build). */
  buildLive: boolean;
  /** A `build` `agent_jobs` row for this slug surfaced for the owner (`needs_attention` or a
   *  `needs_approval` pending action). */
  buildNeedsAttention: boolean;
  /** The latest `spec_test_runs` row's `agent_verdict` for this slug, or `null` when no run exists yet. */
  specTestVerdict: AgentVerdict | null;
  /** The latest `spec_test_runs` row has at least one unresolved auto-`fail` check (an open regression).
   *  Mirrors `getAutoFoldEligibleSlugs`'s definition so this and the fold gate can't disagree. */
  specTestHasOpenRegression: boolean;
  /** A `spec-test` `agent_jobs` row for this slug in ACTIVE_STATUSES (live spec-test). */
  specTestLive: boolean;
  /** The latest spec_test_run asserted >=1 check. Mirrors `isCleanMachinePassRun`'s `checks.length >= 1`
   *  floor so the Spec Test node can mark `done` for a HUMAN-ONLY run (all advisory `needs_human` checks,
   *  0 machine checks) exactly when the fold gate would — while still rejecting a degenerate 0-check
   *  "silent empty pass". False when there's no run yet. [human-only-specs-ship-and-fold] */
  specTestHasChecks: boolean;
  /** A `security-review` `agent_jobs` row for this slug / its merge SHA in
   *  `queued`/`claimed`/`building`/`needs_input`/`queued_resume` (running, not yet surfaced). */
  securityLive: boolean;
  /** A `security-review` `agent_jobs` row for this slug / its merge SHA in `needs_approval` /
   *  `needs_attention` (a routed real-vuln fix OR a needs-human finding awaiting the owner). */
  securitySurfaced: boolean;
  /** A `security-review` for this slug / its merge SHA reached a clean terminal state (`completed` with no
   *  real-vuln route and no open surfaced job). This is the same condition Phase 3's fold gate will read. */
  securityCompletedClean: boolean;
}

export interface LifecycleStage {
  name: LifecycleStageName;
  label: string;
  status: LifecycleStageStatus;
}

export interface LifecycleDerivation {
  /** The earliest stage that is not yet `done` — by construction the furthest-right stage the spec has
   *  reached. The timeline pill attaches here (Phase 2). When every stage is `done` (a folded spec), this is
   *  the final `fold` stage. */
  current: LifecycleStageName;
  /** The current stage's status — what the pill renders. */
  currentStatus: LifecycleStageStatus;
  /** All 5 stages with their derived statuses, in order. Phase 2 renders one node per entry. */
  stages: LifecycleStage[];
}

/** Stable human labels for the timeline nodes. */
export const LIFECYCLE_STAGE_LABELS: Record<LifecycleStageName, string> = {
  "spec-review": "Spec Review",
  "build": "Build",
  "spec-test": "Spec Test",
  "security-test": "Security",
  "fold": "Fold",
};

/** Order the 5 stages are traversed in. */
export const LIFECYCLE_STAGE_ORDER: LifecycleStageName[] = [
  "spec-review",
  "build",
  "spec-test",
  "security-test",
  "fold",
];

function reviewStatus(ctx: LifecycleContext): LifecycleStageStatus {
  if (ctx.status === "in_review") {
    if (ctx.valePass === false) return "needs-attention";
    if (ctx.valePass === true) return "done";
    return "active";
  }
  // Past `in_review` (planned/in_progress/shipped/deferred/folded/rejected) — Vale's stage is done by
  // construction (the build pipeline refuses an in_review spec, so reaching any later status implies it
  // cleared this stage).
  return "done";
}

function buildStatusFor(ctx: LifecycleContext): LifecycleStageStatus {
  if (ctx.buildNeedsAttention) return "needs-attention";
  // Branch-flow Build-done = BUILT ON BRANCH (spec-goal-branch-pm-flow), NOT shipped-to-main. The
  // `builtOnBranch` signal (computed in build-lifecycle-context.ts) is true once every phase carries a
  // `build_sha`/is terminal, or a one-shot's build job reached completed/merged, or the spec is already
  // `in_testing`/`shipped`/`folded`. This is what lets the Build node finish while the pre-merge spec-test
  // + security still run on the branch preview.
  if (ctx.builtOnBranch) return "done";
  // Not yet fully built on branch — show `active` while a build is in flight, else `pending`.
  if (ctx.phases.length > 0) {
    const anyInProgress = ctx.phases.some((p) => p.status === "in_progress");
    if (anyInProgress || ctx.buildLive) return "active";
    return "pending";
  }
  // One-shot spec (no `## Phase` sections — the whole spec ships in one PR), still building on its branch.
  if (ctx.buildLive || ctx.status === "in_progress") return "active";
  return "pending";
}

function specTestStatus(ctx: LifecycleContext, buildDone: boolean): LifecycleStageStatus {
  // Spec-test is a PRE-MERGE gate (spec-goal-branch-pm-flow M3): it runs on the branch preview once the
  // spec is fully built on its branch, BEFORE it merges to main — NOT post-ship. So gate only on Build
  // being done (built on branch), then derive from the spec-test signals regardless of shipped status. A
  // live pre-merge run therefore lights this node `active` (not grey) for the whole testing window.
  if (!buildDone) return "pending";
  // An unresolved machine regression / an issues|error verdict keeps the node open regardless — remediate
  // before fold.
  if (ctx.specTestHasOpenRegression) return "needs-attention";
  if (ctx.specTestVerdict === "issues" || ctx.specTestVerdict === "error") return "needs-attention";
  // COMPLETE when the fold gate (`isCleanMachinePassRun`) would accept it — mirror it EXACTLY: verdict ∈
  // {approved, needs_human} + >=1 check + no open regression. human-only-specs-ship-and-fold: a spec whose
  // Verification is entirely advisory human checks has 0 MACHINE checks to run, so `needs_human` IS its
  // terminal spec-test state — the node reads `done` so the flow advances to Security → Shipped instead of
  // sitting on "QA-verifying" forever (the exact CEO-flagged visual lag: 0 machine tests ⇒ nothing to run ⇒
  // spec-test is already complete). The >=1-check floor still rejects a degenerate 0-check silent-empty pass.
  if (
    (ctx.specTestVerdict === "approved" || ctx.specTestVerdict === "needs_human") &&
    ctx.specTestHasChecks
  ) {
    return "done";
  }
  // No verdict yet (null), or a run that can't satisfy the gate (0 checks) / a live re-test → active.
  return "active";
}

function securityStatus(ctx: LifecycleContext, specTestDone: boolean): LifecycleStageStatus {
  // Security is the second PRE-MERGE gate (spec-goal-branch-pm-flow M4): it runs on the branch preview
  // before the merge to main, NOT post-merge. Gate it on the spec-test node having cleared (which itself
  // requires Build done), then derive from the security signals regardless of shipped status. A live
  // pre-merge security review therefore lights this node `active` (not grey).
  if (!specTestDone) return "pending";
  if (ctx.securitySurfaced) return "needs-attention";
  if (ctx.securityLive) return "active";
  if (ctx.securityCompletedClean) return "done";
  // Spec-test cleared but no security-review record yet — the review is about to fire / will be picked up.
  return "active";
}

function foldStatus(ctx: LifecycleContext): LifecycleStageStatus {
  if (ctx.status === "folded") return "done";
  return "pending";
}

/**
 * Derive the lifecycle stage + per-stage rollup for a spec card. Pure: no I/O, no DB reads — every signal
 * comes from `ctx`. See file header for the stage definitions and sourcing rules.
 */
export function deriveLifecycleStage(ctx: LifecycleContext): LifecycleDerivation {
  // Branch-flow gates chain: Spec Test waits on Build (built on branch); Security waits on Spec Test —
  // mirroring the on-branch build → pre-merge spec-test → pre-merge security order (the ship-to-main event
  // sits between Security and Fold). Compute upstream-done flags so the gates can't disagree.
  const buildStage = buildStatusFor(ctx);
  const specTestStage = specTestStatus(ctx, buildStage === "done");
  const securityStage = securityStatus(ctx, specTestStage === "done");
  const perStage: Record<LifecycleStageName, LifecycleStageStatus> = {
    "spec-review": reviewStatus(ctx),
    "build": buildStage,
    "spec-test": specTestStage,
    "security-test": securityStage,
    "fold": foldStatus(ctx),
  };

  const stages: LifecycleStage[] = LIFECYCLE_STAGE_ORDER.map((name) => ({
    name,
    label: LIFECYCLE_STAGE_LABELS[name],
    status: perStage[name],
  }));

  // The "current" stage = the earliest stage that is not yet `done`. By construction every upstream stage
  // is `done` once the current stage is reached (the inputs progress monotonically), so the timeline UI can
  // render a check on every upstream node and attach the pill to the current one.
  const firstNonDone = stages.findIndex((s) => s.status !== "done");
  const currentIdx = firstNonDone === -1 ? stages.length - 1 : firstNonDone;
  return {
    current: stages[currentIdx].name,
    currentStatus: stages[currentIdx].status,
    stages,
  };
}
