/**
 * A cancelled subscription row must not advertise a future charge date.
 *
 * On ticket f773b8ec (bonnie marlette, 2026-08-21) a cancelled subscription still
 * carried next_billing_date=2026-09-11; the CS Director read the field, concluded
 * the contract was still live in Appstle, and escalated a $209.13 'post-cancel
 * renewals' refund to the founder. The forecast-events ledger showed the cancel
 * landed 36 minutes AFTER the last renewal — every 'post-cancel' charge was an
 * ordinary pre-cancel renewal. The field lied and an agent believed it.
 *
 * Both cancel writers (the Appstle webhook and the appstleSubscriptionAction
 * direct path) call this helper so a cancel write always clears
 * next_billing_date and stamps cancelled_at in the same update as
 * status='cancelled'. Non-cancel actions return an empty patch and leave the
 * billing date alone (pause/resume must not lose the schedule).
 *
 * Pure function, no I/O — importable by both the webhook route and the SDK,
 * and pinned by src/lib/subscription-cancel-truth.test.ts.
 */

export type CancelTruthAction = "active" | "paused" | "cancelled" | "expired" | "failed" | "cancel" | "pause" | "resume";

export interface CancelTruthPatch {
  next_billing_date?: null;
  cancelled_at?: string;
}

export function isCancelAction(action: CancelTruthAction): boolean {
  return action === "cancel" || action === "cancelled";
}

export function buildCancelTruthPatch(
  action: CancelTruthAction,
  opts?: { existingCancelledAt?: string | null; nowIso?: string },
): CancelTruthPatch {
  if (!isCancelAction(action)) return {};
  const cancelledAt = opts?.existingCancelledAt ?? opts?.nowIso ?? new Date().toISOString();
  return {
    next_billing_date: null,
    cancelled_at: cancelledAt,
  };
}

/**
 * Merge the cancel-truth patch into an in-flight update blob. Returns the same
 * object for chaining. Cancel writers use this instead of hand-rolling the two
 * fields — a single helper keeps the invariant enforced in one place.
 */
export function applyCancelTruth<T extends Record<string, unknown>>(
  update: T,
  action: CancelTruthAction,
  opts?: { existingCancelledAt?: string | null; nowIso?: string },
): T {
  const patch = buildCancelTruthPatch(action, opts);
  const bag = update as Record<string, unknown>;
  if (patch.next_billing_date !== undefined) bag.next_billing_date = patch.next_billing_date;
  if (patch.cancelled_at !== undefined) bag.cancelled_at = patch.cancelled_at;
  return update;
}
