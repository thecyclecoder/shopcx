/**
 * Predicate for the metaIterationRun catch block — decides whether a caught
 * error is the Meta App Dashboard human-blocked class (canonical: yearly Data
 * Use Checkup, which pins every affected account's Graph call to a
 * permanent-until-cleared 400 that no Inngest retry can clear).
 *
 * When true, the caller records the outcome on the run row and RETURNS a
 * handled result — no `notifyOpsAlert`, no rethrow through /api/inngest —
 * because the shared escalation handler
 * ([[../meta/app-owner-action-escalation]] `installDefaultAppOwnerActionEscalationHandler`)
 * has already booked exactly one deduped CEO card per workspace per UTC day.
 * Every OTHER error still falls through to the loud rethrow branch so real
 * Meta outages and code regressions surface on the Inngest failure feed.
 *
 * Lives in its own module (not in [[./meta-performance]]) so the regression
 * test can import + pin both the tagged and control branches without dragging
 * the Inngest sink through its transitive control-tower ↔ registered-functions
 * cycle (a TDZ on `metaSyncPerformance`).
 */
export function isAppOwnerActionRequiredError(err: unknown): boolean {
  return (err as { metaClass?: string } | null)?.metaClass === "app_owner_action_required";
}
