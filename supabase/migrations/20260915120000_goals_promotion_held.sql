-- goal-promotion-fold-collision-and-held-surfacing Phase 2 — persist the atomic goal→main promotion state
-- on the goal row so the roadmap reader can surface a HELD/needs-owner badge (and NEVER render a folded-
-- but-unpromoted goal as fully shipped).
--
-- Two new columns on public.goals:
--   • main_merge_sha:        the M5 atomic goal→main merge SHA, written by promoteCompleteGoalsToMain on
--                            success (via stampGoalPromotedToMain). NULL while the goal branch has not
--                            landed on main. A folded/complete goal with a NULL value is the silent-stall
--                            shape (the 2026-07-06 centralized-commerce-sdk incident) — the reader flips
--                            such a goal to HELD (backstop) so the founder is never surprised.
--   • promotion_held_reason: the human-readable conflict reason from a failed mergeGoalBranchIntoMain 409,
--                            written by stampGoalPromotionHeld. Cleared to NULL on a subsequent successful
--                            merge (stampGoalPromotedToMain does the clear atomically alongside the SHA
--                            write). Non-NULL → GoalCard.promotionHeld = true with this exact reason.
--
-- Additive-only, nullable, idempotent (IF NOT EXISTS). No index needed — both columns are read on the goal
-- detail path (single row) and on the board reader (already loads every active goal). No RLS change: the
-- existing goals policies cover these columns.
--
-- See docs/brain/specs/goal-promotion-fold-collision-and-held-surfacing.md Phase 2 for the surface spec.

alter table public.goals add column if not exists main_merge_sha text null;
alter table public.goals add column if not exists promotion_held_reason text null;

comment on column public.goals.main_merge_sha is
  'M5 atomic goal→main merge SHA. Stamped by promoteCompleteGoalsToMain on a successful mergeGoalBranchIntoMain via stampGoalPromotedToMain (goals-table SDK). NULL while the goal branch has not landed on main. A folded/complete goal with a NULL value is treated as HELD by the roadmap reader (silent-stall backstop) so the roadmap never renders a not-on-main goal as fully shipped. See goal-promotion-fold-collision-and-held-surfacing Phase 2.';
comment on column public.goals.promotion_held_reason is
  'Human-readable conflict reason from a failed mergeGoalBranchIntoMain (409). Written by stampGoalPromotionHeld on the M5 pass that saw the conflict; cleared to NULL on a subsequent successful merge via stampGoalPromotedToMain. Non-NULL → GoalCard.promotionHeld = true with this reason, and cardStatus is forced OFF `complete` so the goal never leaks as fully shipped while its code is not on main. See goal-promotion-fold-collision-and-held-surfacing Phase 2.';
