/**
 * CS Director (June) leash surface — Phase 1 of cs-director-leash-categories.
 *
 * A pure-config module — no server imports, no side effects — so it can be imported from a client
 * component (e.g. the Guide tab) as safely as from server code. Its only job is to declare, in code,
 * the leash surface June's runner (src/lib/cs-director.ts) already enforces on her verdict paths, so
 * the generalized coach framing + the Guide tab + director-leash-guide.ts can read June's live leash
 * off her own module instead of hardcoding it. The runner + the tests it already has (cs-director.ts /
 * cs-director.test.ts) are not touched by this phase — this is the structural declaration only.
 *
 * See docs/brain/specs/cs-director-leash-categories.md · docs/brain/libraries/cs-director.md.
 */

/**
 * What the CS Director MAY act on herself, under her supervisor's watch. Every category maps to a
 * verdict path applyBoxCsDirectorCall already handles or a proposal shape already surfaced under the
 * director-leash-recommendations surface — nothing new to executor-side behavior:
 *
 *  - `approve_remedy_within_ceiling` — the applyBoxCsDirectorCall approve_remedy path: a bounded
 *    customer remedy (coupon / partial refund / pause / resend) inside the refund ceiling, fired
 *    through executeSonnetDecision + delivered via deliverTicketMessage once each action verifies.
 *  - `author_derived_from_ticket_spec` — the ticket-derived spec-authoring path documented in
 *    docs/brain/libraries/cs-director.md § Scope: a recurring ticket pattern becomes a spec on the
 *    roadmap with owner=cs.
 *  - `amend_low_blast_sonnet_prompt` — the conversation-rule proposal surface already exposed by
 *    src/lib/agents/director-leash-recommendations.ts for CS: a rule change with narrow blast radius.
 *
 * Anything outside this — anything destructive / irreversible / new-goal-touching, and any escalated
 * ticket that needs the CEO — flows through the generic escalation rails, not this array.
 *
 * ⭐ ABSOLUTE LOYALTY RAIL (spec:
 * loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates). A loyalty-derived benefit
 * (`redeem_points` / `apply_loyalty_coupon` / `redeem_points_as_refund`) whose value exceeds
 * `LOYALTY_REMEDY_MAX_CENTS` (default $15) is CATEGORICALLY out of scope — not just off-leash. Any
 * loyalty cash-out, make-whole, or expiry-extension is refused hard by
 * `planNeedsLoyaltyRefusal` in the cs-director runner and NEVER routed to the founder as a
 * "may I grant this?" ask. Resolve inside the $15 ceiling or hold firm; do not escalate the
 * question. This closes the ticket-2ba3b665 class where June computed a ~$150 make-whole and
 * paged the founder to approve it.
 */
export type LeashCategory =
  | "approve_remedy_within_ceiling"
  | "author_derived_from_ticket_spec"
  | "amend_low_blast_sonnet_prompt";

export const LEASH_CATEGORIES: LeashCategory[] = [
  "approve_remedy_within_ceiling",
  "author_derived_from_ticket_spec",
  "amend_low_blast_sonnet_prompt",
];
