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
