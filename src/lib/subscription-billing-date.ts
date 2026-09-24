/**
 * Pure helper for advancing a subscription's next-billing-date after a successful
 * charge — Phase 2 of
 * [[../../docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind]].
 *
 * The bug this fixes: three sites in
 * [[../../docs/brain/inngest/internal-subscription-renewals]] (the comp branch, the
 * zero-total branch, and the paid-renewal branch) computed the next billing date as
 * `stored next_billing_date + one interval`. A subscription that had fallen several
 * cycles behind therefore stayed in the past after charging, was re-picked by the
 * next daily cron, and was billed again — one charge per day until it caught up.
 * Two customers were billed two cycles a day apart that way; one was owed a $179.70
 * refund. The ground-truth 2026-09-24 audit found six such multi-charge bursts on
 * single subscriptions totalling $1,232.70.
 *
 * The CEO rule this encodes: **one subscription can only ever be behind by a single
 * cycle**. Multiple cycles charged close together on ONE sub are the bug shape;
 * multiple cycles charged close together across DIFFERENT subs are legitimate.
 *
 * `advanceToNextFutureBillingDate(current, interval, count, now)` steps by whole
 * intervals from `current` until the result is strictly in the future. It ALWAYS
 * advances by at least one interval — the cycle just charged — so a portal press
 * that charged an early cycle still moves the calendar forward. Any additional
 * cycles skipped past to reach the future are NOT recorded as billed anywhere; the
 * per-cycle claim ledger only stamps rows for cycles that actually charged.
 *
 * Whole-interval stepping preserves the customer's day-of-cycle anchor (e.g. a
 * monthly sub anchored to the 24th stays on the 24th). Month stepping anchors
 * against the ORIGINAL `current` and clamps day-of-month to the target month's last
 * day — a naive `setUTCMonth` OVERFLOWS at month-end (Jan 31 + 1 month lands on
 * Mar 3), and the drift compounds every step. Days 1–28 are unaffected; anchor
 * days 29–31 need the clamp.
 *
 * The 520-step cap is a bounded runaway guard — a malformed interval must never
 * spin forever. A daily sub 500+ days behind, or a malformed count of 0 that got
 * past the `Math.max(1, ...)` normalization, would surface as a thrown error rather
 * than a permanent-past write that the renewal cron picks up daily.
 *
 * Kept pure so the three renewal sites share one testable implementation and can
 * never drift apart again.
 */

/**
 * How many step iterations before we bail with a thrown error rather than a
 * bad-forever write. Chosen well above the largest plausible backlog for any real
 * cadence — the point is to catch a MALFORMED interval/count that would spin
 * forever, not to gate real customers.
 */
const MAX_ADVANCE_STEPS = 520;

/**
 * Step `current` by whole `interval` × `count` cycles until the result is strictly
 * greater than `now`, always taking at least one step. Preserves the day-of-cycle
 * anchor from `current` for month/year stepping (clamped to the target month's last
 * day).
 *
 * Signature pinned by
 * [[../../docs/brain/specs/a-subscription-is-never-more-than-one-cycle-behind]]
 * Phase 2 verification.
 *
 * Throws if the step cap is reached without producing a future date — a malformed
 * cadence that would otherwise write a bad-forever value that the renewal cron
 * would re-select daily.
 */
export function advanceToNextFutureBillingDate(
  current: Date,
  interval: string,
  count: number,
  now: Date,
): Date {
  const step = Math.max(1, count || 1);
  const unit = String(interval || "month").toLowerCase();
  const anchorDay = current.getUTCDate();
  const baseYear = current.getUTCFullYear();
  const baseMonth = current.getUTCMonth();
  const out = new Date(current);
  let months = 0;

  for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
    if (unit === "day") {
      out.setUTCDate(out.getUTCDate() + step);
    } else if (unit === "week") {
      out.setUTCDate(out.getUTCDate() + 7 * step);
    } else if (unit === "year") {
      out.setUTCFullYear(out.getUTCFullYear() + step);
    } else {
      // Month (also the fallback for unknown units — previously 4-week / 28 days;
      // switched to true month-anchor so a monthly sub stays on its day-of-cycle).
      // Anchor from the ORIGINAL `current` + running months, never a drifting `out`.
      months += step;
      const m = baseMonth + months;
      const lastDay = new Date(Date.UTC(baseYear, m + 1, 0)).getUTCDate();
      out.setUTCFullYear(baseYear, m, Math.min(anchorDay, lastDay));
    }
    if (out.getTime() > now.getTime()) return out;
  }

  throw new Error(
    `advanceToNextFutureBillingDate_step_cap: current=${current.toISOString()} ` +
      `interval=${interval} count=${count} now=${now.toISOString()} ` +
      `(malformed cadence — cap ${MAX_ADVANCE_STEPS} reached without producing a future date)`,
  );
}
