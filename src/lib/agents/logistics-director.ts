/**
 * Logistics Director (Marco) leash surface — Phase 3 of marco-logistics-director-seat.
 *
 * A pure-config module — no server imports, no side effects — so it can be imported from a client
 * component (e.g. the Guide tab) as safely as from server code. Its only job is to declare, in code,
 * that Marco (Logistics) currently has NO autonomous leash: he lands as a READ-ONLY OBSERVER in the
 * Message Center, answers questions about inventory + fulfillment + crisis state, and NEVER emits an
 * autonomously-executable pending_action. Every pending_action on a logistics thread escalates to the
 * CEO via the shared `escalateApprovalRequestToCeo` rail in the M3 dispatch.
 *
 * ⭐ Landing shape B (marco_landing='B') from Phase 1. Evidence: the storefront-availability toggle
 * has NO callable server-side helper (crisis-forecast.ts:187 is prose only, not an executor); the
 * swap-enrollment writer DOES exist as `crisis_enroll` / `crisis_set_auto_readd` in
 * action-executor.ts; AND docs/brain/functions/logistics.md § "Provenance / build model" explicitly
 * flags this whole tooling as OFF-LIMITS to Ada — "Kept off public.specs by founder directive
 * 2026-07-10 — deliberate, bounded exception to 'Ada is the sole builder'". The founder is hand-
 * driving the inventory executors; Marco's autonomous surface stays closed until the follow-up spec
 * marco-logistics-executor-surface lands.
 *
 * See docs/brain/specs/marco-logistics-director-seat.md · docs/brain/functions/logistics.md.
 */

/**
 * Marco's LIVE leash categories. Currently EMPTY — Marco is a read-only observer (Phase 3 landing).
 * `director-leash-guide.ts` `getLeashGuide` handles an empty array naturally: `autonomous:[]` +
 * only the generic CEO-facing escalation rails render. Adding a category here (once
 * marco-logistics-executor-surface lands the callable executors) auto-flows the guide + the M3
 * dispatch's in-leash check without touching those files.
 */
export type LeashCategory = never;

export const LEASH_CATEGORIES: LeashCategory[] = [];

/**
 * READ_ONLY = true is the plain marker downstream code MAY key on to render Marco's tab with a
 * "Read-only observer — every request routes to the CEO" subheader, distinct from a director whose
 * `LEASH_CATEGORIES` is TEMPORARILY empty at deploy-time. Kept declarative (not derived from
 * `LEASH_CATEGORIES.length === 0`) so a future Marco with one auto category doesn't accidentally
 * lose the "read-only" framing until this marker is explicitly flipped.
 */
export const READ_ONLY = true as const;
