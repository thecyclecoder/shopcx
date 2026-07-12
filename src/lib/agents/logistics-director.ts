/**
 * Logistics Director (Marco) leash surface.
 *
 * A pure-config module — no server imports, no side effects — so it can be imported from a client
 * component (e.g. the Guide tab) as safely as from server code. Its only job is to declare, in code,
 * the leash categories Marco (Logistics) may auto-act inside.
 *
 * ⭐ Phase 2 of [[../../../docs/brain/specs/marco-logistics-executor-surface.md]] — Marco is now the
 * fourth LIVE leash-bound director. His two categories, grounded in the crisis-cohort surface, are:
 *
 *   1. `availability_toggle_within_crisis_lever` — flip a variant on/off in the storefront + portal
 *      swap options via [[../logistics/storefront-availability]] `setStorefrontAvailability` (the
 *      Phase-1 callable). Card payload names crisis_id + variant_id + available + reason; the M3
 *      dispatch verifies the crisis is real + same-workspace + names the target variant (the
 *      crisis-cohort guard) BEFORE firing the executor.
 *
 *   2. `auto_readd_swapped_subscribers_within_crisis_cohort` — bulk-flip `auto_readd=true` across
 *      every `crisis_customer_actions` row scoped to a named crisis so the swapped-away subscribers
 *      get switched back to their original variant on restock. Card payload names crisis_id + reason;
 *      the M3 dispatch verifies the crisis is real + same-workspace BEFORE firing the bulk update.
 *
 * The live-flip stays a CEO action (function_autonomy.live) — this module only opens the CAPABILITY.
 * Marco's coach thread now emits the two card shapes as pending_actions the CEO approves; the M3
 * dispatch runs the executor branch only for an in-leash category (an out-of-leash card still
 * escalates via `escalateApprovalRequestToCeo`, per director-chat-in-leash-execution).
 *
 * Retires the Phase-3 marco-logistics-director-seat READ_ONLY marker — Marco's tab now renders as a
 * live leash-bound director (like Ada / Max / June), not a read-only observer.
 *
 * See docs/brain/specs/marco-logistics-executor-surface.md · docs/brain/functions/logistics.md.
 */

/**
 * The leash categories Marco may auto-act inside. Both are crisis-cohort scoped — every action
 * carries a `crisis_id` the M3 dispatch verifies against `public.crisis_events` (workspace-scoped)
 * before executing. Retires the Phase-3 read-only-observer landing (LEASH_CATEGORIES was `[]`).
 */
export type LeashCategory =
  | "availability_toggle_within_crisis_lever"
  | "auto_readd_swapped_subscribers_within_crisis_cohort";

export const LEASH_CATEGORIES: readonly LeashCategory[] = [
  "availability_toggle_within_crisis_lever",
  "auto_readd_swapped_subscribers_within_crisis_cohort",
] as const;
