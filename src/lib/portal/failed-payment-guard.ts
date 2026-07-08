/**
 * Portal failed-payment guard for subscription mutations (change-date, frequency).
 *
 * The block exists because a customer on a dormant payment-failed Appstle
 * contract used to be able to silently push the next date around without
 * fixing the underlying billing problem (ticket 52a0a618). The right next
 * step there is updating the payment method or cancelling — not moving the
 * date.
 *
 * BUT the block is Appstle-only. Internal subs route through the
 * internal-aware mutation wrapper (appstleUpdate*), which handles the
 * dunning-related cases correctly; the `last_payment_status` flag on an
 * internal sub can be stale after the sub was migrated off Appstle
 * (proven live on ticket 115350d5, sub e1d4f32b: is_internal=true,
 * last_payment_status='failed', portal date change Oct 1 → Oct 6 succeeded
 * with the flag untouched — the block is Appstle-only).
 *
 * Keep this predicate pure so change-date + frequency handlers share the
 * exact same decision and it can be unit-tested without a DB.
 */
export function shouldBlockForFailedPayment(sub: {
  is_internal: boolean | null;
  last_payment_status: string | null;
}): boolean {
  if (sub.is_internal) return false;
  return sub.last_payment_status === "failed";
}
