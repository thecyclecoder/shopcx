/**
 * Notification hygiene — give informational notifications a terminal state a HUMAN doesn't have to
 * reach.
 *
 * The problem (measured 2026-08-28): `dashboard_notifications` held 2,237 undismissed rows against
 * 13 actual decisions. And the pile was NOT being ignored — 98-100% of it was `read`. People open
 * these and leave them, because dismissing accomplishes nothing when there is no decision to make.
 * The only exit from the inbox is a manual click, so anything informational accrues forever BY
 * CONSTRUCTION:
 *
 *   fraud_alert           609 open ·   0% ever dismissed · oldest 2026-04-14
 *   agent_daily_summary   269 open ·   0% ·                oldest 2026-06-24
 *   chargeback_alert      136 open ·   0% ·                oldest 2026-03-27
 *
 * Compare `agent_approval_request`: 5,230 lifetime, 13 open, 100% dismissed. A surface with real
 * decisions gets worked. A surface of log lines does not, and never will.
 *
 * ⭐ The principle: every notification type needs a terminal state something OTHER than a human can
 * reach — a timer, a linked record resolving, or a supersede. If the only exit is a click, the type
 * is a log and does not belong in an inbox.
 *
 * This module implements the two unambiguous cases. Fraud alerts are deliberately NOT swept here:
 * their problem is granularity (one order fired three alerts) and severity routing, which is a
 * product decision, not a retention one.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * How long a daily recap stays in the inbox. Long enough to read over a weekend, short enough that
 * a June standup is never in an August inbox.
 */
export const DAILY_SUMMARY_TTL_DAYS = 7;

/** Notification types that are pure reports — no decision, no linked record, only age. */
export const REPORT_TYPES = ["agent_daily_summary"] as const;

/**
 * Chargeback dispute statuses that mean "this is over". A notification pointing at a finished
 * dispute is a pointer to a closed thing — `chargeback_events` is the working surface, and Slack
 * `#chargebacks` is the live feed.
 */
export const TERMINAL_CHARGEBACK_STATUSES = new Set(["won", "lost", "closed", "accepted"]);

/** Is a report old enough to retire? Pure so the boundary is testable without a clock or a DB. */
export function isExpiredReport(createdAt: string, nowMs: number, ttlDays = DAILY_SUMMARY_TTL_DAYS): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false; // an unparseable date must never be swept
  return nowMs - t > ttlDays * 86400_000;
}

/**
 * Has a chargeback finished? Terminal status OR a `finalized_on` stamp — either is sufficient, and
 * a row can carry the stamp before the status settles.
 */
export function isChargebackSettled(row: { status?: string | null; finalized_on?: string | null } | null | undefined): boolean {
  if (!row) return false; // ledger row missing ⇒ we know nothing ⇒ leave the notification alone
  if (row.finalized_on) return true;
  return TERMINAL_CHARGEBACK_STATUSES.has(String(row.status ?? "").toLowerCase());
}

export interface SweepResult {
  scanned: number;
  dismissed: number;
  ids: string[];
  /** Rows examined but deliberately left — the count that proves the sweep is not indiscriminate. */
  kept: number;
}

/**
 * Retire report-type notifications older than the TTL.
 *
 * Reports have no linked record and no decision, so age is the only honest terminal condition.
 */
export async function sweepExpiredReports(
  admin: Admin,
  args: { workspaceId: string; nowMs?: number; ttlDays?: number; apply: boolean },
): Promise<SweepResult> {
  const nowMs = args.nowMs ?? Date.now();
  const ttl = args.ttlDays ?? DAILY_SUMMARY_TTL_DAYS;
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, created_at")
    .eq("workspace_id", args.workspaceId)
    .eq("dismissed", false)
    .in("type", REPORT_TYPES as unknown as string[]);
  if (error) throw new Error(`sweepExpiredReports: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; created_at: string }>;
  const ids = rows.filter((r) => isExpiredReport(r.created_at, nowMs, ttl)).map((r) => r.id);
  if (args.apply && ids.length) {
    const { error: uerr } = await admin
      .from("dashboard_notifications")
      .update({ dismissed: true })
      .in("id", ids)
      .eq("workspace_id", args.workspaceId);
    if (uerr) throw new Error(`sweepExpiredReports update: ${uerr.message}`);
  }
  return { scanned: rows.length, dismissed: ids.length, ids, kept: rows.length - ids.length };
}

/**
 * Retire chargeback notifications whose dispute has SETTLED.
 *
 * The notification carries `metadata.entity_id` → `chargeback_events.id`. A live dispute
 * (`under_review`) is left alone — that one still wants eyes, and it is the whole reason this sweep
 * is status-driven rather than a timer. Retiring a live dispute on age would hide a real deadline
 * (`chargeback_events.evidence_due_by`).
 */
export async function sweepSettledChargebacks(
  admin: Admin,
  args: { workspaceId: string; apply: boolean },
): Promise<SweepResult> {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, metadata")
    .eq("workspace_id", args.workspaceId)
    .eq("dismissed", false)
    .eq("type", "chargeback_alert");
  if (error) throw new Error(`sweepSettledChargebacks: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>;
  const eventIds = [
    ...new Set(
      rows
        .map((r) => String(r.metadata?.entity_id ?? ""))
        .filter((v) => v && v !== "undefined" && v !== "null"),
    ),
  ];
  if (!eventIds.length) return { scanned: rows.length, dismissed: 0, ids: [], kept: rows.length };

  const { data: events, error: eerr } = await admin
    .from("chargeback_events")
    .select("id, status, finalized_on")
    .eq("workspace_id", args.workspaceId)
    .in("id", eventIds);
  if (eerr) throw new Error(`sweepSettledChargebacks events: ${eerr.message}`);
  const byId = new Map(
    ((events ?? []) as Array<{ id: string; status: string | null; finalized_on: string | null }>).map((e) => [String(e.id), e]),
  );

  // Unresolvable entity_id ⇒ NOT swept. We only retire a pointer when we can see the thing it
  // points at has finished; anything else is a guess, and guessing is what put a phantom card in
  // the CEO's inbox earlier today.
  const ids = rows
    .filter((r) => isChargebackSettled(byId.get(String(r.metadata?.entity_id ?? ""))))
    .map((r) => r.id);

  if (args.apply && ids.length) {
    const { error: uerr } = await admin
      .from("dashboard_notifications")
      .update({ dismissed: true })
      .in("id", ids)
      .eq("workspace_id", args.workspaceId);
    if (uerr) throw new Error(`sweepSettledChargebacks update: ${uerr.message}`);
  }
  return { scanned: rows.length, dismissed: ids.length, ids, kept: rows.length - ids.length };
}
