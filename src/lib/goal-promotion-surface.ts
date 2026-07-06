/**
 * goal-promotion-fold-collision-and-held-surfacing Phase 2 — the pure predicate the roadmap goal card
 * runs to decide whether an atomic goal→main promotion has landed. Extracted into its own tiny module so
 * `brain-roadmap.ts` (the reader) and any test/agent that needs the same decision share ONE truth for
 * "is this goal HELD" — the same one-truth pattern Phase 1's `isFoldSafeGivenGoalStatus` uses.
 *
 * The 2026-07-06 centralized-commerce-sdk incident's second failure was invisibility: a goal whose atomic
 * promotion 409'd on the fold/promotion doc collision still rolled up as `complete` on the roadmap because
 * the goal-fold worker flipped its stored status to `folded` off the derived rollup — the founder found it
 * live-broken on the loyalty dashboard. This predicate makes the HELD state a first-class card field so the
 * board list + detail page + any downstream reader all agree on when a goal's CODE is actually on main.
 *
 * Rules (in order):
 *   1. EXEMPT goals (parent goals, is_parent, or no buildable specs) never atomic-promote. They surface
 *      via `deriveGoalAccumulation.exempt` — never HELD.
 *   2. `promotionHeldReason` set → HELD, reason as-is. `mergeGoalBranchIntoMain` writes it on 409 (via
 *      `stampGoalPromotionHeld`); a subsequent successful merge clears it (via `stampGoalPromotedToMain`).
 *   3. `derivedComplete` (every milestone rolled up ≥1) BUT `mainMergeSha` is null → HELD (silent-stall
 *      backstop). This catches the incident shape: a goal-fold worker flipped status → `folded` off the
 *      derived rollup, no 409 stored, but the atomic merge never landed → code isn't on main. The reader
 *      falls back to "atomic promotion not yet landed" as the reason.
 *   4. Otherwise NOT HELD.
 *
 * Also produces the CARD status override so the "roadmap goal list + detail" surface (`GoalCard.status`)
 * never renders `complete` for a not-on-main goal — that's the second verification bullet ("a folded goal
 * whose merge_sha/code is not yet on main, expect the reader to NOT display it as fully shipped").
 *
 * Pure — no I/O. See `goal-promotion-surface.test.ts` for the state pins.
 */

/** The stored `goals.status` enum. Mirrors `goals-table.GoalRowStatus`; duplicated here to keep this
 *  predicate module import-free (no circular dep with the SDK). */
export type GoalStoredStatusForPromotion = "proposed" | "greenlit" | "complete" | "folded";

/** The card-level status the roadmap surfaces. Mirrors `brain-roadmap.GoalStatus`. */
export type GoalCardStatusForPromotion = "proposed" | "greenlit" | "complete";

export interface GoalPromotionInput {
  /** The stored `goals.status` column (never the derived rollup). */
  storedStatus: GoalStoredStatusForPromotion;
  /** True iff every milestone rolled up to completion ≥1 (deriveGoalAccumulation's completeness signal). */
  derivedComplete: boolean;
  /** True iff this goal is EXEMPT from atomic goal→main promotion (parent goal / has sub-goals / no
   *  buildable member specs). Exempt goals never atomic-promote, so HELD never applies. */
  exempt: boolean;
  /** The M5 atomic goal→main merge SHA — null until `mergeGoalBranchIntoMain` succeeds. */
  mainMergeSha: string | null;
  /** The last conflict reason `mergeGoalBranchIntoMain` returned (null when no 409 was recorded / after a
   *  subsequent successful merge cleared it). */
  promotionHeldReason: string | null;
}

export interface GoalPromotionSurface {
  /** The card status override — proposed | greenlit | complete. HELD forces DOWN to `greenlit` so the
   *  card is NEVER rendered as fully shipped when the goal's code isn't on main. */
  cardStatus: GoalCardStatusForPromotion;
  /** True iff the goal's atomic promotion is HELD (either a stored 409 reason, or a derived-complete goal
   *  with no `main_merge_sha`). Drives the roadmap "HELD — needs owner" badge. */
  promotionHeld: boolean;
  /** Human-readable reason surfaced on the badge (empty string when not held). */
  promotionHeldReason: string;
}

const BACKSTOP_REASON = "atomic goal→main promotion has not landed (no main_merge_sha)";

/** Map a stored `goals.status` → the card-level status enum (folded rolls back to greenlit — the card
 *  never surfaces `folded` on the active board, and a HELD folded goal must NOT read as complete). */
function storedToCardStatus(s: GoalStoredStatusForPromotion): GoalCardStatusForPromotion {
  if (s === "complete") return "complete";
  if (s === "proposed") return "proposed";
  return "greenlit"; // greenlit + folded → greenlit (the caller filters folded-vs-active separately)
}

/**
 * Derive the promotion surface a `GoalCard` renders (status + HELD badge). See module-level docstring for
 * the ordered rules.
 */
export function deriveGoalPromotionSurface(input: GoalPromotionInput): GoalPromotionSurface {
  const base = storedToCardStatus(input.storedStatus);
  const derivedStatus: GoalCardStatusForPromotion = input.derivedComplete ? "complete" : base;
  // Rule 1: EXEMPT goals never atomic-promote — HELD never applies.
  if (input.exempt) {
    return { cardStatus: derivedStatus, promotionHeld: false, promotionHeldReason: "" };
  }
  // Rule 2: an explicit stored HELD reason (from a `mergeGoalBranchIntoMain` 409) — HELD as-is.
  if (input.promotionHeldReason && input.promotionHeldReason.trim().length > 0) {
    return {
      // NEVER render HELD as complete — force to `greenlit` so the card can't leak "fully shipped".
      cardStatus: "greenlit",
      promotionHeld: true,
      promotionHeldReason: input.promotionHeldReason.trim(),
    };
  }
  // Rule 3: silent-stall backstop — derived-complete but no atomic-merge SHA on record. Covers the
  // incident's exact shape (goal-fold worker flipped the row → folded off the derived rollup while
  // `mergeGoalBranchIntoMain` never landed). A `folded` stored status with no merge SHA also lands here.
  const codeOnMain = input.mainMergeSha !== null && input.mainMergeSha.length > 0;
  if (!codeOnMain && (input.derivedComplete || input.storedStatus === "complete" || input.storedStatus === "folded")) {
    return {
      cardStatus: "greenlit",
      promotionHeld: true,
      promotionHeldReason: BACKSTOP_REASON,
    };
  }
  return { cardStatus: derivedStatus, promotionHeld: false, promotionHeldReason: "" };
}
