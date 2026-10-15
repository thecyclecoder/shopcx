/**
 * The allowed `dashboard_notifications.type` values — the TypeScript mirror of the
 * `dashboard_notifications_type_check` CHECK constraint.
 *
 * Why this exists: an insert with a type the CHECK does not list is rejected by Postgres
 * (23514 → PostgREST 400), and almost every notification insert is fire-and-forget, so the card is
 * silently lost. 2026-09-28 → 2026-10-14 the daily internal-subscription-renewal cron's
 * stranded-dunning + duplicate-renewal detectors (and the renewal price check) wrote
 * `type='billing_alert'` — never in the CHECK — so every billing alert they raised dropped.
 *
 * Keep this list and the LATEST migration that re-creates `dashboard_notifications_type_check` in
 * lockstep. `src/lib/dashboard-notification-types.test.ts` pins both directions:
 *   - this tuple == the CHECK list in the newest migration (set equality), and
 *   - every `type` literal passed to a `.from("dashboard_notifications").insert/upsert(...)` in
 *     src/ + scripts/ is a member of this tuple.
 * Adding a type = add it here + ship a migration that drops and re-creates the CHECK with the
 * full superset. Never remove a value that live rows still carry.
 *
 * Brain: docs/brain/tables/dashboard_notifications.md.
 */
export const DASHBOARD_NOTIFICATION_TYPES = [
  "macro_suggestion",
  "pattern_review",
  "knowledge_gap",
  "system",
  "fraud_alert",
  "chargeback_alert",
  "duplicate_order_alert",
  "escalation_gap",
  "agent_approval_request",
  "agent_message",
  "agent_daily_summary",
  "return_request",
  "mario_accuracy_alarm",
  "refund_drift",
  "fulfillment_alert",
  "billing_alert",
  "box_account_auth_expired",
] as const;

export type DashboardNotificationType = (typeof DASHBOARD_NOTIFICATION_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(DASHBOARD_NOTIFICATION_TYPES);

/** True when `t` is a value the `dashboard_notifications_type_check` CHECK accepts. */
export function isDashboardNotificationType(t: unknown): t is DashboardNotificationType {
  return typeof t === "string" && TYPE_SET.has(t);
}
