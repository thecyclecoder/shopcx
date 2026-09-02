/**
 * escalation-health — the pure predicate behind `scripts/open-tickets.ts list`.
 *
 * WHY neglect, not age. In steady state every OPEN ticket should be escalated to the CEO,
 * assigned to a human, or newer than the grace window. Anything else is a dropped hand-off.
 * The prior version decided from `age` (now − created_at) alone, so the moment a customer
 * replied to an old thread the ticket reopened and was instantly reported as a defect that
 * had supposedly been sitting unowned for days — even while an agent was actively answering
 * it. On 2026-09-02 a customer reopened an 8-day-old thread; the agent replied three minutes
 * later and closed it, but the queue view still flagged it as a week-old dropped hand-off.
 *
 * The fix: a ticket is only a defect when it is open, unescalated, unassigned, older than
 * the grace window AND has not been touched within that window. `reopened` — old but
 * touched inside the grace — is its own visible-but-non-defect state; silently hiding it
 * would just trade a false positive for a false negative.
 *
 * PURE. The CLI (`scripts/open-tickets.ts`) does the display_name lookup and the durations
 * → human formatting; this module just returns the state so the rule can be unit-tested.
 */

export type EscalationHealth =
  | { state: "escalated" }
  | { state: "assigned" }
  | { state: "new"; ageMin: number }
  | { state: "reopened"; idleMin: number }
  | { state: "defect"; idleMin: number };

export interface EscalationHealthInput {
  ageMin: number;
  idleMin: number;
  escalatedTo: string | null | undefined;
  assignedTo: string | null | undefined;
  graceMin: number;
}

export function classifyEscalationHealth(input: EscalationHealthInput): EscalationHealth {
  const { ageMin, idleMin, escalatedTo, assignedTo, graceMin } = input;
  if (escalatedTo) return { state: "escalated" };
  if (assignedTo) return { state: "assigned" };
  if (ageMin <= graceMin) return { state: "new", ageMin };
  if (idleMin <= graceMin) return { state: "reopened", idleMin };
  return { state: "defect", idleMin };
}
