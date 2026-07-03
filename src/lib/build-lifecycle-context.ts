/**
 * build-lifecycle-context — server-side context builder for the 5-node lifecycle timeline
 * ([[build-card-lifecycle-timeline]] Phase 2).
 *
 * Pure transform: takes a SpecCard + the already-loaded board signals (the latest job, the latest
 * spec_test_runs row, owner resolutions, the live-spec-test slug set, the per-spec security rollup,
 * the folded flag) and returns the LifecycleContext the Phase 1 `deriveLifecycleStage` helper
 * consumes. No I/O — the page-level loader fetches once and passes everything in.
 */
import type { AgentJob, JobStatus, PendingFold } from "@/lib/agent-jobs";
import { isActive } from "@/lib/agent-jobs";
import type { SpecCard } from "@/lib/brain-roadmap";
import type { LifecycleDerivation, LifecycleContext } from "@/lib/build-lifecycle";
import { checkKey, type HumanCheckRow, type SpecTestRun } from "@/lib/spec-test-runs";
import type { SecurityStateBySlug } from "@/lib/security-agent";

const BUILD_NEEDS_ATTENTION_STATUSES: ReadonlySet<string> = new Set(["needs_attention", "needs_approval"]);

/**
 * True iff the spec's latest test run carries an unresolved auto-`fail` (an open regression). Mirrors
 * [[getAutoFoldEligibleSlugs]] verbatim so the Spec Test node + the fold gate can never disagree.
 */
export function specTestHasOpenRegression(
  slug: string,
  run: SpecTestRun | null,
  humanResolutions: Map<string, HumanCheckRow>,
): boolean {
  if (!run) return false;
  for (const c of run.checks) {
    if (c.verdict !== "fail") continue;
    const res = humanResolutions.get(`${slug}:${checkKey(c.text)}`);
    if (!res?.resolution) return true;
  }
  return false;
}

export interface BuildLifecycleInputs {
  spec: SpecCard;
  /** The latest non-meta job for this spec (build / spec-test / pr-resolve / …) — what the board card already loads. */
  job: AgentJob | null;
  testRun: SpecTestRun | null;
  humanResolutions: Map<string, HumanCheckRow>;
  /** Slugs with a `spec-test` agent_jobs row in ACTIVE_STATUSES — per-board fetch, looked up by slug. */
  liveSpecTestSlugs: ReadonlySet<string>;
  /** Per-slug security rollup ([[getSecurityStateBySlug]]); undefined when no security-review row exists. */
  security: SecurityStateBySlug | undefined;
  /** True when `public.specs.status === 'folded'` — the SpecCard surface coerces folded to 'shipped', so the caller passes the raw flag. */
  folded?: boolean;
}

/**
 * **Built on its branch** — the branch-flow Build-done signal (spec-goal-branch-pm-flow). True once the
 * spec is fully built on `claude/build-{slug}`, BEFORE it merges to main, so the 5-node timeline's Build
 * node can finish while the pre-merge spec-test + security gates run on the branch preview.
 *
 * Derivation (mirrors `isSpecAccumulationComplete` / the `in_testing` deriver in brain-roadmap):
 * - Already past the build window (`in_testing` / `shipped` / `folded`) ⇒ built. (`in_testing` is the
 *   derived "built + green on a branch, not yet on main" slot; it can only hold once accumulation is
 *   complete, so it implies built-on-branch.)
 * - A **multi-phase** spec is built when every phase carries a `build_sha` or is terminal
 *   (`shipped`/`rejected`) — the accumulation-complete condition, read off `SpecCard.phases` directly.
 * - A **one-shot** spec (0 phases) is built when its `build` job reached a `completed`/`merged` terminal.
 */
function deriveBuiltOnBranch(spec: SpecCard, buildJob: AgentJob | null, folded: boolean): boolean {
  if (folded || spec.status === "shipped" || spec.status === "in_testing") return true;
  if (spec.phases.length > 0) {
    return spec.phases.every((p) => !!p.build_sha || p.status === "shipped" || p.status === "rejected");
  }
  // One-shot spec, still pre-`in_testing`: rely on the build job reaching a built terminal on its branch.
  return !!buildJob && (buildJob.status === "completed" || buildJob.status === "merged");
}

/**
 * Build the LifecycleContext for one spec from the board's already-loaded signals.
 *
 * Build-stage signals: only a `build` job counts as the spec's BUILD lifecycle state — a `spec-test` /
 * `pr-resolve` / fold job is a DIFFERENT stage (Spec Test / Fold) and its `building`/`needs_approval`
 * must not bleed into the Build node. (`getLatestJobsBySlug` already filters out director/meta jobs;
 * we further restrict the build-stage reads to `kind === 'build'` here.)
 *
 * Pure: no I/O.
 */
export function buildLifecycleContext(opts: BuildLifecycleInputs): LifecycleContext {
  const { spec, job, testRun, humanResolutions, liveSpecTestSlugs, security, folded } = opts;
  const buildJob = job && job.kind === "build" ? job : null;
  return {
    status: folded ? "folded" : spec.status,
    valePass: typeof spec.valePass === "boolean" ? spec.valePass : null,
    phases: spec.phases.map((p) => ({ status: p.status })),
    builtOnBranch: deriveBuiltOnBranch(spec, buildJob, !!folded),
    buildLive: !!(buildJob && isActive(buildJob.status)),
    buildNeedsAttention: !!(buildJob && BUILD_NEEDS_ATTENTION_STATUSES.has(buildJob.status)),
    specTestVerdict: testRun?.agent_verdict ?? null,
    specTestHasOpenRegression: specTestHasOpenRegression(spec.slug, testRun, humanResolutions),
    specTestLive: liveSpecTestSlugs.has(spec.slug),
    // >=1 check floor (mirrors isCleanMachinePassRun) — a human-only run (all advisory checks) still has
    // >=1 check, so its Spec Test node reads `done`; a degenerate 0-check run does not. [human-only-specs-ship-and-fold]
    specTestHasChecks: (testRun?.checks?.length ?? 0) >= 1,
    securityLive: security?.live ?? false,
    securitySurfaced: security?.surfaced ?? false,
    securityCompletedClean: security?.completedClean ?? false,
  };
}

/** The default pill copy per JobStatus, mirroring BuildButton's chip vocabulary. */
const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting…",
  building: "Building…",
  needs_input: "Needs input",
  needs_approval: "Needs approval",
  queued_resume: "Resuming…",
  blocked_on_usage: "Paused · usage",
  completed: "Built",
  merged: "Merged ✓",
  failed: "Failed",
  needs_attention: "Needs attention",
};

/**
 * Compute the human-friendly pill label + tooltip for the CURRENT stage's chip on the timeline.
 *
 * The Phase 1 helper labels stages structurally (`active`/`done`/etc.) but the chip should read like
 * the floating pill it replaces — "Building…", "Vale pending", "Folding…", etc. This helper centralizes
 * that translation so the roadmap board card and the spec-detail card render IDENTICAL pills. Pure.
 *
 * `fold` is the pending-fold row keyed by slug (the SpecCard already loads it for the BuildButton); a
 * pending/folding row turns the Fold node's pill into "Folding…" — the only signal that survives the
 * floating-pill removal.
 */
export function lifecyclePillForCurrent(
  derivation: LifecycleDerivation,
  job: AgentJob | null,
  fold: PendingFold | null,
  valePass: boolean | null,
): { label?: string; title?: string } {
  const { current, currentStatus } = derivation;
  // Done = no pill (the floating chip was hidden on a fully-shipped lifecycle).
  if (currentStatus === "done") return {};

  // Folding → the Fold node carries the "Folding…" pill (mirrors BuildButton's folding chip,
  // which is being subsumed by the timeline). A folding row is pending/folding on the spec.
  const folding = !!fold && (fold.status === "pending" || fold.status === "folding");
  if (current === "fold" && folding) {
    return {
      label: "Folding…",
      title: "Verified — being retired into the brain by a batch fold-build (one PR folds all verified specs)",
    };
  }

  // Spec Review — derive from Vale's verdict (valePass: false === needs-fix, null === pending).
  if (current === "spec-review") {
    if (currentStatus === "needs-attention") {
      return { label: "Vale: needs fix", title: "Vale's CHECKLIST verdict is needs_fix — fix and re-send for re-review." };
    }
    return {
      label: valePass === true ? "Ada disposing" : "Vale: pending",
      title:
        valePass === true
          ? "Vale cleared the CHECKLIST; Ada's disposition lane will pick it up next."
          : "Awaiting Vale's CHECKLIST quality pass — the build pipeline refuses this spec until it clears.",
    };
  }

  // Build — pull the live job's status if a `build` job is on this stage. A `needs_approval` job with a
  // PR reads "Built · needs approval" (matches the existing BuildButton chip rule). Other kinds (a
  // pr-resolve / spec-test) don't carry the Build stage's pill — Spec Test / etc. own those.
  if (current === "build") {
    const buildJob = job && job.kind === "build" ? job : null;
    if (buildJob) {
      const text =
        buildJob.status === "needs_approval" && buildJob.pr_number
          ? "Built · needs approval"
          : JOB_STATUS_LABEL[buildJob.status];
      return { label: text, title: `Build job ${buildJob.status}` };
    }
    return {
      label: currentStatus === "needs-attention" ? "Needs attention" : "Build",
      title: currentStatus === "needs-attention" ? "A build job for this spec is surfaced for the owner." : undefined,
    };
  }

  // Spec Test — the latest spec_test_run shapes the pill (verdict + open-regression flag).
  if (current === "spec-test") {
    if (currentStatus === "needs-attention") {
      return { label: "Spec-test: issues", title: "The machine spec-test surfaced issues or an open regression — review and remediate before fold." };
    }
    // active: a live spec-test job or no verdict yet
    return { label: "QA-verifying", title: "Machine spec-test running (or queued) — checks the verification block end-to-end." };
  }

  // Security — the security-review job's state.
  if (current === "security-test") {
    if (currentStatus === "needs-attention") {
      return { label: "Security: needs review", title: "A security review surfaced a routed real-vuln fix or a needs-human finding — clear it in the Agents inbox before fold." };
    }
    return { label: "Security review", title: "Pre-merge security review is in flight on the branch preview — promotion to main defers until it clears." };
  }

  // Fold (active without a folding row) — the spec passed both gates (spec-test + security) and is
  // waiting for the auto-fold gate's next pass to enqueue the batch fold-build.
  if (current === "fold") {
    return { label: "Awaiting fold", title: "Spec is shipped + verified + security-clear; the auto-fold gate will pick it up on the next pass." };
  }

  return {};
}
