/**
 * BranchPosition — the branch-accumulation lifecycle timeline for a spec card
 * (spec-goal-branch-pm-flow M6).
 *
 * The branch-flow model (M1–M5): every phase of a spec builds onto ONE `spec/{slug}` (or
 * `claude/build-{slug}`) branch; when the whole spec is built + green on that branch it derives
 * `in_testing` (tested, NOT in prod). A GOAL-bound spec then merges onto its `goal/{goal}` branch
 * (stamping `specs.goal_branch_sha` → `onGoalBranch`) and waits there; when EVERY spec in the goal is
 * accumulated + green, the goal atomic-promotes to main in ONE merge → `shipped`. A ONE-OFF spec (no goal)
 * merges its branch straight to main on green → `shipped`.
 *
 * This is the SECOND timeline on a spec card — orthogonal to the agent-pipeline `LifecycleTimeline`
 * (Spec Review · Build · Spec Test · Security · Fold). Where that one tracks the QA/security gates, this
 * one tracks WHERE THE CODE LIVES along the promotion path so `in_testing` reads as a distinct state (on a
 * branch, not in prod) rather than getting conflated with `in_progress` or `shipped`:
 *
 *   built on branch → in testing → on goal branch → shipped (promoted to main)
 *
 * Goal-bound specs render all four steps; a one-off (no-goal) spec collapses the goal-branch step (it
 * promotes straight to main). Pure + server-renderable — reads only `status` + `onGoalBranch`. One shared
 * component for the board card AND the spec-detail card (the reusable-components rule).
 */
import type { SpecCard } from "@/lib/brain-roadmap";

type StepState = "done" | "active" | "pending";

interface Step {
  key: string;
  label: string;
  title: string;
  state: StepState;
}

/**
 * Derive the 3- or 4-step branch-flow timeline for a spec. `goalBound` (a spec linked to a goal) keeps the
 * "on goal branch" step; a one-off spec drops it (it promotes straight to main). Returns null when the spec
 * hasn't reached a branch-specific state yet (planned / in_progress / in_review / deferred) — nothing to show.
 */
export function branchFlowSteps(spec: Pick<SpecCard, "status" | "onGoalBranch">, goalBound: boolean): Step[] | null {
  const inTesting = spec.status === "in_testing";
  const onGoalBranch = !!spec.onGoalBranch;
  const shipped = spec.status === "shipped";

  // Pre-branch states have no branch position to surface.
  if (!inTesting && !onGoalBranch && !shipped) return null;

  // "built on branch" is reached once the spec is in_testing / on a goal branch / shipped (the code is on a
  // branch). It's `active` only at the in_testing-on-its-own-spec-branch moment, else `done`.
  const builtState: StepState = shipped || onGoalBranch ? "done" : "active";
  const builtLabel = "built on branch";

  // "in testing" — built + green on its branch, tested, not in prod.
  const testingState: StepState = shipped || onGoalBranch ? "done" : inTesting ? "active" : "pending";

  const steps: Step[] = [
    { key: "built", label: builtLabel, title: "Every phase committed onto the spec's own branch (no main round-trip).", state: builtState },
    { key: "in_testing", label: "in testing", title: "Built + green on its branch — tested, NOT in production yet.", state: testingState },
  ];

  if (goalBound) {
    const goalState: StepState = shipped ? "done" : onGoalBranch ? "active" : "pending";
    steps.push({
      key: "goal_branch",
      label: "on goal branch",
      title:
        "Merged onto the goal branch (goal/{goal}); waiting for the WHOLE goal to accumulate + go green, then the goal atomic-promotes to main.",
      state: goalState,
    });
  }

  steps.push({
    key: "shipped",
    label: goalBound ? "promoted to main" : "shipped to main",
    title: goalBound
      ? "The goal's atomic promotion to main landed (one merge ships the whole goal)."
      : "The one-off spec's branch merged straight to main on green.",
    state: shipped ? "active" : "pending",
  });

  return steps;
}

const NODE_RING: Record<StepState, string> = {
  pending: "border-zinc-200 bg-white text-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600",
  active: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  done: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

const CONNECTOR: Record<StepState, string> = {
  pending: "bg-zinc-200 dark:bg-zinc-800",
  active: "bg-zinc-200 dark:bg-zinc-800",
  done: "bg-emerald-300 dark:bg-emerald-700",
};

function glyph(state: StepState): string {
  if (state === "done") return "✓";
  if (state === "active") return "•";
  return "·";
}

export default function BranchPosition({
  spec,
  goalBound = false,
}: {
  spec: Pick<SpecCard, "status" | "onGoalBranch">;
  /** True when the spec is linked to a goal (renders the "on goal branch" step). A one-off spec promotes
   *  straight to main, so it drops that step. The board/detail page knows goal membership; default false. */
  goalBound?: boolean;
}) {
  const steps = branchFlowSteps(spec, goalBound);
  if (!steps) return null;
  return (
    <div className="mt-2 w-full" aria-label="branch-flow position">
      <div className="flex w-full items-start justify-between gap-1">
        {steps.map((step, idx) => {
          const next = steps[idx + 1];
          const connectorState: StepState = step.state === "done" ? "done" : "pending";
          return (
            <div key={step.key} className="flex min-w-0 flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <span className="h-px flex-1" aria-hidden />
                <span
                  aria-label={`${step.label}: ${step.state}`}
                  title={step.title}
                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none ${NODE_RING[step.state]}`}
                >
                  {glyph(step.state)}
                </span>
                <span className={`h-px flex-1 ${next ? CONNECTOR[connectorState] : "bg-transparent"}`} aria-hidden />
              </div>
              <span
                className={`mt-1 block w-full truncate text-center text-[9px] font-medium ${
                  step.state === "active" ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"
                }`}
                title={step.title}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
