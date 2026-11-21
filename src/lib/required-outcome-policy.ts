/**
 * required-outcome-policy — the single, dependency-free definition of "this required outcome is
 * un-completable BY POLICY given the live target state" (see
 * docs/brain/libraries/required-outcome-policy.md).
 *
 * Grounds the fix for the uncompletable-policy-forbidden-required-outcome loop (ticket
 * aaf00047): Sol authored an `apply_loyalty_coupon` required outcome against a PAUSED
 * subscription, which the active "Loyalty redemption — don't recommend applying to a paused sub"
 * rule forbids and which fails upstream with `subscription_not_active`. The row therefore sits in
 * `status='failed'` forever — the only path that clears a failed row needs a successfully-fired
 * rescue action that can never happen by policy — so the Phase-4 completion gate re-escalates the
 * fully-resolved ticket on every reopen.
 *
 * This module is the ONE place that decides whether a given (kind, live-subscription-status)
 * pairing is policy-forbidden, so both ends of the fix read the same rule:
 *   - PREVENT — required-outcomes-validator rejects an item whose target sub is non-active so an
 *     un-completable row is never authored (reason `subscription_not_active`).
 *   - WAIVE — the outcome-completion-gate's `waivePolicyForbiddenOutcomes` marks an already-stuck
 *     pending/failed row `waived` when completing it is policy-forbidden, so the gate stops
 *     re-escalating a correctly-NOT-done outcome.
 *
 * Kept pure + import-free (no Supabase, no subscription-items) so the validator and the gate can
 * share it without pulling heavy module graphs, and so the rule is answerable by a static grep.
 */

/**
 * Coupon/loyalty APPLY kinds that require an ACTIVE subscription. Applying one to a paused or
 * cancelled sub is policy-forbidden (the discount would silently discount a future renewal the
 * customer didn't earn), and the apply handler fails it upstream with `subscription_not_active`,
 * so a required-outcome row for one of these kinds against a non-active sub can never complete.
 */
export const COUPON_APPLY_KINDS: ReadonlySet<string> = new Set<string>([
  "apply_loyalty_coupon",
  "apply_coupon",
]);

/**
 * A coupon is only ever valid on an ACTIVE subscription. Mirrors
 * `couponApplicableToSubStatus` in subscription-items.ts — kept re-defined here (one line) so this
 * module stays dependency-free; the brain page cross-links the two so they can't drift silently.
 * subscriptions.status is lowercase; values in use are 'active' | 'paused' | 'cancelled'.
 */
export function couponApplicableToSubStatus(status: string | null | undefined): boolean {
  return status === "active";
}

export type PolicyForbiddenVerdict =
  | { forbidden: false }
  | { forbidden: true; reason: string };

/**
 * Pure: is this required outcome un-completable BY POLICY given the live target subscription
 * status? The only current rule is a coupon/loyalty apply onto a non-active (paused/cancelled)
 * subscription.
 *
 * Fail-closed on unknown state: `subStatus == null` (the sub couldn't be read, or the kind takes
 * no contract) returns `forbidden:false` — we never auto-waive / auto-block on absent evidence; a
 * human handles that case. The block/waive only fires when we positively observe a non-active sub.
 */
export function assessPolicyForbidden(
  kind: string,
  subStatus: string | null | undefined,
): PolicyForbiddenVerdict {
  if (
    COUPON_APPLY_KINDS.has(kind) &&
    subStatus != null &&
    !couponApplicableToSubStatus(subStatus)
  ) {
    return {
      forbidden: true,
      reason:
        `${kind} is policy-forbidden on a ${subStatus} subscription — ` +
        `a loyalty/coupon redemption only applies to an active sub`,
    };
  }
  return { forbidden: false };
}
