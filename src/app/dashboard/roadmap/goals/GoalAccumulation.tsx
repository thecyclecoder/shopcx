/**
 * GoalAccumulation — the goal-branch accumulation surface for a goal card
 * (spec-goal-branch-pm-flow M6).
 *
 * A goal accumulates its finished specs on a `goal/{slug}` branch (one merge per spec, M4). When EVERY
 * member spec is on the goal branch (and the goal-branch preview is green), the goal atomic-promotes to
 * main in ONE merge (M5) — the whole goal ships coherently, never half-built in prod. This component shows:
 *
 *   - "N of M specs on the goal branch" — the live accumulation (from `GoalCard.accumulation`).
 *   - a "ready to promote" badge when `allOnGoalBranch` (the goal is fully accumulated + about to promote).
 *   - a parent-goal note when the goal is EXEMPT from atomic promotion (a PARENT goal — its sub-goals
 *     promote INDEPENDENTLY; there's no single whole-goal promote).
 *   - a "HELD — needs owner" badge with the conflict reason when M5's atomic promotion 409'd or the goal
 *     is derived-complete without a main merge SHA on record
 *     (goal-promotion-fold-collision-and-held-surfacing Phase 2 — the 2026-07-06 incident's visibility gap).
 *
 * Pure + server-renderable. `variant="card"` (default) = the compact form on the goals-board card;
 * `variant="detail"` = the fuller form in the goal-detail sidebar (adds the explanatory copy).
 */
import type { GoalBranchAccumulation } from "@/lib/brain-roadmap";

export default function GoalAccumulation({
  accumulation,
  variant = "card",
  promotionHeld = false,
  promotionHeldReason = "",
}: {
  accumulation: GoalBranchAccumulation;
  variant?: "card" | "detail";
  /** goal-promotion-fold-collision-and-held-surfacing Phase 2 — surface a HELD state when the M5 atomic
   *  goal→main promotion 409'd (or the code is not yet on main). Renders a "HELD — needs owner" badge
   *  with the reason; supersedes the "ready to promote" chip because the goal is NOT ready. */
  promotionHeld?: boolean;
  promotionHeldReason?: string;
}) {
  const { onGoalBranch, totalSpecs, allOnGoalBranch, exempt, exemptReason } = accumulation;

  // goal-promotion-fold-collision-and-held-surfacing Phase 2 — HELD supersedes both the exempt / ready
  // states. A HELD goal's code is not on main; nothing else about "ready to promote" is relevant until
  // the conflict clears. Detail variant adds the reason as explanatory copy.
  if (promotionHeld) {
    return (
      <div className="mt-3">
        <span
          title={`Atomic goal→main promotion HELD — needs owner. ${promotionHeldReason || "The goal's code is not on main."}`}
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
        >
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" />
          HELD — needs owner
        </span>
        {variant === "detail" && promotionHeldReason && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            {promotionHeldReason}
          </p>
        )}
      </div>
    );
  }

  // A parent goal doesn't accumulate on a single goal branch — its sub-goals promote independently. Surface
  // the exemption instead of a (meaningless) whole-goal accumulation count.
  if (exempt) {
    return (
      <div className="mt-3">
        <span
          title={`Exempt from the atomic goal→main promotion: ${exemptReason}. Its sub-goals promote independently — no whole-goal promote.`}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
          Parent goal · sub-goals promote independently
        </span>
        {variant === "detail" && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
            {exemptReason}. There is no single goal branch to atomic-promote — each sub-goal reaches main on
            its own completion.
          </p>
        )}
      </div>
    );
  }

  // A goal with no buildable member specs shows nothing branch-specific (it's covered by the exempt path
  // above when totalSpecs is 0, but guard anyway).
  if (totalSpecs === 0) return null;

  const pct = Math.round((onGoalBranch / totalSpecs) * 100);

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span>Goal branch</span>
          {allOnGoalBranch && (
            <span
              title="Every spec in this goal is on the goal branch — when the goal-branch preview is green it atomic-promotes to main in one merge."
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
            >
              ⬆ ready to promote
            </span>
          )}
        </span>
        <span className="tabular-nums font-medium text-zinc-700 dark:text-zinc-300">
          {onGoalBranch} of {totalSpecs} specs
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${allOnGoalBranch ? "bg-emerald-500" : "bg-indigo-500"}`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      {variant === "detail" && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {allOnGoalBranch
            ? "All specs accumulated on the goal branch — the goal is about to atomic-promote to main in one merge."
            : `${onGoalBranch} of ${totalSpecs} finished specs have merged onto the goal branch. The goal promotes to main in one atomic merge once all are accumulated + green.`}
        </p>
      )}
    </div>
  );
}
