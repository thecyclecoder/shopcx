/**
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 —
 * PURE normalizer for the "outside dependent depends on a goal-member spec" case.
 *
 * When a standalone (not-in-goal) spec's stored `blocked_by` names a spec that is a MEMBER of goal G,
 * the EFFECTIVE blocker is the GOAL, not the member spec. That member spec never lands on `main` on
 * its own: it accumulates on the goal branch and only reaches `main` via the atomic goal→main promotion
 * (see [[../goals-table]] `stampGoalMainMergeSha`). Reporting the blocker as the goal aligns the
 * board / detail-page display with the actual clear predicate (Phase 2 keys `cleared` on
 * `goals.main_merge_sha`) and lets the enqueue chokepoint (Phase 3) refuse to claim a dependent while
 * its goal is still off `main` (`goals.main_merge_sha === null`).
 *
 * A goal-mate dependency (dependent AND blocker in the SAME goal) is UNCHANGED — the intra-goal
 * serializer / Kahn sort at [[../agent-jobs]] `sequencePromoteCandidates` already orders it against
 * `specs.goal_branch_sha`, so the blocker stays a spec-slug blocker cleared when the mate lands on the
 * goal branch. This module never rewrites a goal-mate to a goal blocker (that would collapse the
 * existing intra-goal ordering into a single self-referential edge).
 *
 * Pure — no I/O. The wire-up in [[brain-roadmap]] `resolveBlockedBy` loads the workspace's goal
 * membership + main-merge state once (via `listGoals`) and passes it to `deriveEffectiveBlocker`.
 *
 * See docs/brain/specs/one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec.md.
 */

/**
 * The workspace-scoped goal-membership index the normalizer reads: a spec slug → the goal it belongs
 * to (or absent when the spec is standalone / not a goal-member). One entry per goal-member spec;
 * standalone specs are absent from the map. `mainMergeSha` mirrors `goals.main_merge_sha` — the
 * atomic goal→main promotion marker Phase 2 keys the goal-blocker `cleared` predicate on.
 */
export interface GoalMembership {
  goalSlug: string;
  goalTitle: string;
  mainMergeSha: string | null;
}

/**
 * The effective blocker computed for one raw `specs.blocked_by` entry.
 *   - `kind: "spec"` — the blocker stays a spec-slug blocker (the standard path). Includes goal-mate
 *     dependencies where both dependent + blocker share a goal.
 *   - `kind: "goal"` — the blocker is EFFECTIVELY the goal that owns the raw spec slug; `slug` /
 *     `title` name the GOAL. `memberSpecSlug` preserves the ORIGINAL raw spec slug so callers that
 *     need to write it back verbatim (the author-spec re-author path) don't lose it.
 */
export type EffectiveBlockerKind = "spec" | "goal";

export interface EffectiveSpecBlockerCore {
  kind: "spec";
  /** The raw spec slug from `specs.blocked_by` — unchanged. */
  slug: string;
}

export interface EffectiveGoalBlockerCore {
  kind: "goal";
  /** The GOAL slug — the effective blocker's identifier for display + gating. */
  slug: string;
  /** The GOAL title (for the UI chip / tooltip). */
  title: string;
  /** The original raw spec slug from `specs.blocked_by` — preserved so the re-author write-back can
   *  round-trip without collapsing the entry to the goal slug (author-time normalization is OPT-IN
   *  and NOT what Phase 1 does — that's Vale's future write-side normalization). */
  memberSpecSlug: string;
  /** `goals.main_merge_sha` for the effective goal (Phase 2's `cleared` predicate reads this). Null
   *  while the goal has not landed on `main`. */
  mainMergeSha: string | null;
}

export type EffectiveBlockerCore = EffectiveSpecBlockerCore | EffectiveGoalBlockerCore;

/**
 * Derive ONE effective blocker for one raw `specs.blocked_by` entry.
 *
 * The rule (Phase 1):
 *   - Blocker slug is NOT a known goal-member → stays a SPEC blocker (kind:"spec").
 *   - Blocker slug IS a goal-member AND the dependent is a goal-mate (same goal) → stays a SPEC
 *     blocker (kind:"spec"). The intra-goal serializer already handles this case; a goal-mate is not
 *     an "outside dependent".
 *   - Blocker slug IS a goal-member AND the dependent is NOT in that goal → EFFECTIVE blocker is the
 *     GOAL (kind:"goal", slug + title from the goal, memberSpecSlug preserved).
 *
 * Also returns a spec blocker when `blockerSlug === dependentSlug` (a self-block — the diagnoser at
 * [[goal-member-blocked-by]] already flags this at author-time, but here we punt to a spec blocker
 * so the read path stays lenient toward drifted rows).
 */
export function deriveEffectiveBlocker(
  blockerSlug: string,
  dependent: { slug: string; goalSlug: string | null },
  goalByBlockerSlug: ReadonlyMap<string, GoalMembership>,
): EffectiveBlockerCore {
  const blockerGoal = goalByBlockerSlug.get(blockerSlug);
  if (!blockerGoal) return { kind: "spec", slug: blockerSlug };
  // Goal-mate: dependent + blocker in the SAME goal. Intra-goal serializer handles it — stay a spec
  // blocker (this is the case Phase 1 explicitly leaves unchanged).
  if (dependent.goalSlug !== null && dependent.goalSlug === blockerGoal.goalSlug) {
    return { kind: "spec", slug: blockerSlug };
  }
  // Outside dependent (or dependent in a DIFFERENT goal) blocked by a goal-member → effective blocker
  // is the GOAL.
  return {
    kind: "goal",
    slug: blockerGoal.goalSlug,
    title: blockerGoal.goalTitle,
    memberSpecSlug: blockerSlug,
    mainMergeSha: blockerGoal.mainMergeSha,
  };
}

/**
 * Batched version — map every raw `specs.blocked_by` slug through `deriveEffectiveBlocker`.
 *
 * Order-preserving. Deduplicates when two raw spec slugs both resolve to the SAME effective goal
 * (an outside dependent blocked by two members of the SAME goal collapses to ONE goal blocker —
 * the "outside" party can't ship until the WHOLE goal lands on main, so two edges to the same goal
 * are redundant). Two raw spec-slug blockers that stay `kind:"spec"` are NOT deduped (they name
 * distinct specs). One raw slug never appears twice in the returned list.
 */
export function deriveEffectiveBlockers(
  rawBlockerSlugs: readonly string[],
  dependent: { slug: string; goalSlug: string | null },
  goalByBlockerSlug: ReadonlyMap<string, GoalMembership>,
): EffectiveBlockerCore[] {
  const out: EffectiveBlockerCore[] = [];
  const seenGoalSlugs = new Set<string>();
  const seenSpecSlugs = new Set<string>();
  for (const raw of rawBlockerSlugs) {
    if (typeof raw !== "string" || !raw) continue;
    const eff = deriveEffectiveBlocker(raw, dependent, goalByBlockerSlug);
    if (eff.kind === "goal") {
      if (seenGoalSlugs.has(eff.slug)) continue;
      seenGoalSlugs.add(eff.slug);
    } else {
      if (seenSpecSlugs.has(eff.slug)) continue;
      seenSpecSlugs.add(eff.slug);
    }
    out.push(eff);
  }
  return out;
}

/**
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 2 —
 * the auto-queue-on-goal-unblock predicate (pure). "Given a spec card whose blockedBy has been
 * resolved by [[../brain-roadmap]] `resolveBlockedBy`, is `goalSlug` its LAST uncleared blocker —
 * so the moment `goals.main_merge_sha` was just stamped, this card is now enqueue-eligible?"
 *
 * TRUE when ALL of:
 *   - The card is not opted out of auto-build (`autoBuild !== false`).
 *   - The card is not already shipped (`status !== "shipped"`).
 *   - The card's resolved blockedBy CONTAINS at least one goal blocker on `goalSlug` (kind==="goal",
 *     slug===goalSlug). Without this, the card has no relationship to THIS goal — the ship of
 *     `goalSlug` doesn't unblock it.
 *   - Every blocker in the card's resolved blockedBy is `cleared: true`. Because Phase 1's
 *     `resolveBlockedBy` keys the goal blocker's `cleared` on `goals.main_merge_sha`, this is
 *     automatically true for the goal blocker on `goalSlug` once the stamp lands; and it demands
 *     every OTHER blocker is independently cleared too (a card blocked on two goals unblocks only
 *     when BOTH ship).
 *
 * FALSE otherwise. The predicate is BOTH the "is this card blocked-on-goalSlug?" test AND the
 * "is every blocker now cleared?" test — the caller doesn't need to combine multiple predicates.
 *
 * Pure. Consumed by the async fan-out `autoQueueUnblockedByGoal` in [[../agent-jobs]] — called
 * from `promoteCompleteGoalsToMain` right after `stampGoalPromotedToMain` succeeds.
 */
export interface DependentCardForGoalUnblock {
  slug: string;
  autoBuild?: boolean;
  status: string;
  blockedBy: readonly { slug: string; cleared: boolean; kind?: "spec" | "goal" }[];
}

export function isReadyForGoalUnblock(
  card: DependentCardForGoalUnblock,
  goalSlug: string,
): boolean {
  if (card.autoBuild === false) return false;
  if (card.status === "shipped") return false;
  const mentionsGoal = card.blockedBy.some((b) => b.kind === "goal" && b.slug === goalSlug);
  if (!mentionsGoal) return false;
  return card.blockedBy.every((b) => b.cleared);
}
