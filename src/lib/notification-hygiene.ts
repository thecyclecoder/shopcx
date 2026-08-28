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
 * All three high-volume informational types are swept, each on its OWN terminal condition:
 * a timer for reports, and the linked record's resolution for chargebacks and fraud.
 *
 * A note on how the fraud case was initially misread, because it shaped the design: a first pass
 * looked for `fraud_signals` / `fraud_decisions` / `order_fraud_reviews`, found none, and concluded
 * fraud had no working surface — then read two alerts naming the same order as one alert duplicated.
 * Both were wrong. `/dashboard/fraud` + `fraud_cases` IS the working surface (714 cases, 100% in a
 * terminal status, reviewed within hours), and the alerts run exactly 1.0 per case — the two naming
 * one order were two distinct rule matches, which is correct behaviour. The lesson is the one this
 * module encodes: resolve the pointer before judging the pointee.
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

/**
 * Fraud case statuses that mean "worked". Grounded in what the ledger ACTUALLY uses — measured
 * 2026-08-28, `fraud_cases` holds exactly `{dismissed: 631, confirmed_fraud: 83}`, i.e. 100% of
 * cases reach a terminal state. `resolved`/`closed` are included as forward-compatible synonyms.
 *
 * Deliberately NOT a catch-all: a future status meaning "escalated" or "awaiting review" must fall
 * OUTSIDE this set so the sweep keeps the notification. Being too narrow costs a stale row; being
 * too broad hides live fraud.
 */
export const TERMINAL_FRAUD_STATUSES = new Set(["dismissed", "confirmed_fraud", "resolved", "closed"]);

/**
 * Has a fraud case been worked? Terminal status OR a `reviewed_at` stamp — the fraud analogue of
 * `finalized_on`, since a case can be reviewed before its status settles.
 */
export function isFraudCaseResolved(row: { status?: string | null; reviewed_at?: string | null } | null | undefined): boolean {
  if (!row) return false; // case missing ⇒ we know nothing ⇒ leave the notification alone
  if (row.reviewed_at) return true;
  return TERMINAL_FRAUD_STATUSES.has(String(row.status ?? "").toLowerCase());
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

/**
 * Retire fraud notifications whose case has been WORKED.
 *
 * `/dashboard/fraud` is the real queue and someone works it daily — measured 2026-08-28, cases
 * created 08:02 were reviewed by 14:03, and 609/609 open alerts pointed at cases already in a
 * terminal state. The notification is a pointer at a closed thing; `fraud_cases` is the surface.
 *
 * An unresolvable `entity_id` is NOT swept, same as chargebacks: we only retire a pointer when we
 * can see the thing it points at has finished.
 */
export async function sweepResolvedFraudCases(
  admin: Admin,
  args: { workspaceId: string; apply: boolean },
): Promise<SweepResult> {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, metadata")
    .eq("workspace_id", args.workspaceId)
    .eq("dismissed", false)
    .eq("type", "fraud_alert");
  if (error) throw new Error(`sweepResolvedFraudCases: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>;
  const caseIds = [
    ...new Set(
      rows
        .map((r) => String(r.metadata?.entity_id ?? ""))
        .filter((v) => v && v !== "undefined" && v !== "null"),
    ),
  ];
  if (!caseIds.length) return { scanned: rows.length, dismissed: 0, ids: [], kept: rows.length };

  // Chunked: a single `.in()` over ~600 uuids fails the PostgREST request outright (observed).
  const byId = new Map<string, { status: string | null; reviewed_at: string | null }>();
  for (let i = 0; i < caseIds.length; i += 100) {
    const { data: cases, error: cerr } = await admin
      .from("fraud_cases")
      .select("id, status, reviewed_at")
      .eq("workspace_id", args.workspaceId)
      .in("id", caseIds.slice(i, i + 100));
    if (cerr) throw new Error(`sweepResolvedFraudCases cases: ${cerr.message}`);
    for (const c of (cases ?? []) as Array<{ id: string; status: string | null; reviewed_at: string | null }>) {
      byId.set(String(c.id), c);
    }
  }

  const ids = rows
    .filter((r) => isFraudCaseResolved(byId.get(String(r.metadata?.entity_id ?? ""))))
    .map((r) => r.id);

  if (args.apply && ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error: uerr } = await admin
        .from("dashboard_notifications")
        .update({ dismissed: true })
        .in("id", ids.slice(i, i + 200))
        .eq("workspace_id", args.workspaceId);
      if (uerr) throw new Error(`sweepResolvedFraudCases update: ${uerr.message}`);
    }
  }
  return { scanned: rows.length, dismissed: ids.length, ids, kept: rows.length - ids.length };
}
