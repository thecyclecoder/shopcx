/**
 * build-lifecycle — DB-driven derivation of which of the 5 lifecycle stages a spec card is currently on
 * (build-card-lifecycle-timeline Phase 1).
 *
 * The 5 stages, in order: `spec-review` → `build` → `spec-test` → `security-test` → `fold`.
 *
 * `deriveLifecycleStage(ctx)` is **pure + side-effect-free** — it reads only the context the board /
 * Control Tower already loads (the spec's status, vale_pass, phases, the latest spec_test_runs row, the
 * live/terminal security-review agent_jobs state for the slug). No DB reads, no I/O. Unit-testable from a
 * fixture (see `scripts/verify-build-lifecycle.ts`).
 *
 * Per-stage rollup mirrors the spec language so the timeline UI (Phase 2) can render a check on every
 * completed upstream stage AND attach the live status pill to the CURRENT (earliest non-done) stage. The
 * current stage is the furthest-right stage the spec has reached — by construction the upstream stages are
 * `done` once that current stage is reached, because the inputs progress monotonically (Build can't be done
 * until the spec has shipped; Spec Test can't be done until Build is; etc.).
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
  // Multi-phase spec: roll up from `phases`. `rejected` (cut) phases count as done — they're not blocking.
  if (ctx.phases.length > 0) {
    const allDone = ctx.phases.every((p) => p.status === "shipped" || p.status === "rejected");
    if (allDone) return "done";
    const anyInProgress = ctx.phases.some((p) => p.status === "in_progress");
    if (anyInProgress || ctx.buildLive) return "active";
    return "pending";
  }
  // One-shot spec (no `## Phase` sections — the whole spec ships in one PR). Use the row status.
  if (ctx.status === "shipped" || ctx.status === "folded") return "done";
  if (ctx.buildLive || ctx.status === "in_progress") return "active";
  return "pending";
}

function specTestStatus(ctx: LifecycleContext): LifecycleStageStatus {
  // Spec-test runs POST-ship only — before the spec has merged there's nothing for the QA agent to test.
  if (ctx.status !== "shipped" && ctx.status !== "folded") return "pending";
  // The fold gate requires `approved` + 0 open regressions (`getAutoFoldEligibleSlugs`) — mirror exactly so
  // the Spec Test node and the fold gate can never disagree.
  if (ctx.specTestVerdict === "approved" && !ctx.specTestHasOpenRegression) return "done";
  if (ctx.specTestHasOpenRegression) return "needs-attention";
  if (ctx.specTestVerdict === "issues" || ctx.specTestVerdict === "error") return "needs-attention";
  // No verdict yet (null), `needs_human` (advisory — not a fold gate), or a live spec-test job → active.
  return "active";
}

function securityStatus(ctx: LifecycleContext): LifecycleStageStatus {
  // Security review fires post-merge (the merge hook enqueues it) — pre-ship, nothing to read.
  if (ctx.status !== "shipped" && ctx.status !== "folded") return "pending";
  if (ctx.securitySurfaced) return "needs-attention";
  if (ctx.securityLive) return "active";
  if (ctx.securityCompletedClean) return "done";
  // Post-ship but no security-review record yet — the queue is about to fire / will be picked up shortly.
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
  const perStage: Record<LifecycleStageName, LifecycleStageStatus> = {
    "spec-review": reviewStatus(ctx),
    "build": buildStatusFor(ctx),
    "spec-test": specTestStatus(ctx),
    "security-test": securityStatus(ctx),
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
