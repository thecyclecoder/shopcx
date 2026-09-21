/**
 * Stranded-dunning-cycle detector — the safety net for the class of failure
 * verified on 2026-09-21: an OPEN `dunning_cycles` row silently pointing at a
 * dead pre-migration contract, holding an active subscription out of renewal
 * selection for weeks without ever writing a signal. Five real customers were
 * stranded 50-72 days; six of thirty-three open cycles were on wrong contracts.
 *
 * Two invariants — both MUST be 0:
 *
 * (a) **Contract drift** — an open `dunning_cycles` row whose
 *     `shopify_contract_id` differs from its `subscription_id`'s current value.
 *     This is the exact defect Phase 1's migration re-point closes going
 *     forward; the detector is how we notice if a repair regresses.
 *
 * (b) **Overdue-but-active** — `subscriptions.status='active'`,
 *     `is_internal=true`, `next_billing_date` more than 1.5 billing intervals
 *     in the past. Comp subs (`comp=true`) are excluded — sub 5ec77e57 is a
 *     legitimate 92-day-overdue comp.
 *
 * Surface: `dashboard_notifications` (`type='billing_alert'`) with a stable
 * dedupe key inside metadata — same shape as
 * [[subscription-duplicate-renewal-detector]]. Piggy-backed on the daily
 * internal-subscription-renewal-cron end-of-run (no new MONITORED_LOOPS row —
 * no new cadence to monitor).
 *
 * All writes go through `admin.from('dashboard_notifications')` — never
 * modifies dunning_cycles/subscriptions. Best-effort: a detector failure MUST
 * NOT break the renewal fan-out.
 *
 * See docs/brain/libraries/dunning-strand-detector.md.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface StrandedContractDriftFinding {
  workspace_id: string;
  cycle_id: string;
  subscription_id: string;
  cycle_contract_id: string;
  subscription_contract_id: string;
  cycle_status: string;
  cycle_number: number;
}

export interface StrandedOverdueFinding {
  workspace_id: string;
  subscription_id: string;
  customer_id: string | null;
  contract_id: string;
  next_billing_date: string;
  billing_interval: string;
  billing_interval_count: number;
  days_overdue: number;
}

export interface StrandedDunningReport {
  workspace_id: string;
  contract_drift: StrandedContractDriftFinding[];
  overdue_but_active: StrandedOverdueFinding[];
}

const INTERVAL_MS: Record<string, number> = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  year: 365 * 24 * 60 * 60_000,
};

function intervalMs(unit: string | null, count: number | null): number {
  const u = (unit || "week").toLowerCase();
  const c = Math.max(1, Number(count || 1));
  const base = INTERVAL_MS[u] ?? INTERVAL_MS.week;
  return base * c;
}

/**
 * Report both stranded populations for one workspace. Read-only against the DB;
 * the caller is responsible for surfacing findings via
 * `surfaceStrandedDunningAlerts`.
 */
export async function detectStrandedDunningCycles(
  admin: Admin,
  workspace_id: string,
  nowMs: number = Date.now(),
): Promise<StrandedDunningReport> {
  const OPEN_STATUSES = ["active", "rotating", "retrying", "skipped", "paused"];

  // (a) Contract drift — open dunning_cycles JOIN subscriptions on subscription_id
  //     and compare cycle.shopify_contract_id vs sub.shopify_contract_id. Postgrest's
  //     nested-select syntax gives us the join in one round-trip.
  const { data: openCycles } = await admin
    .from("dunning_cycles")
    .select("id, subscription_id, shopify_contract_id, status, cycle_number, subscriptions!inner(shopify_contract_id)")
    .eq("workspace_id", workspace_id)
    .in("status", OPEN_STATUSES)
    .not("subscription_id", "is", null);

  const contract_drift: StrandedContractDriftFinding[] = [];
  for (const row of (openCycles || []) as Array<{
    id: string;
    subscription_id: string;
    shopify_contract_id: string;
    status: string;
    cycle_number: number;
    subscriptions: { shopify_contract_id: string } | { shopify_contract_id: string }[] | null;
  }>) {
    const subs = row.subscriptions;
    const subContract = Array.isArray(subs) ? subs[0]?.shopify_contract_id : subs?.shopify_contract_id;
    if (!subContract) continue;
    if (subContract === row.shopify_contract_id) continue;
    contract_drift.push({
      workspace_id,
      cycle_id: row.id,
      subscription_id: row.subscription_id,
      cycle_contract_id: row.shopify_contract_id,
      subscription_contract_id: subContract,
      cycle_status: row.status,
      cycle_number: row.cycle_number,
    });
  }

  // (b) Overdue-but-active — internal active subs whose next_billing_date is
  //     more than 1.5 billing intervals in the past. Comp subs excluded (a
  //     legitimate 92-day-overdue comp shouldn't page).
  const { data: activeSubs } = await admin
    .from("subscriptions")
    .select("id, workspace_id, customer_id, shopify_contract_id, next_billing_date, billing_interval, billing_interval_count, comp, is_internal, status")
    .eq("workspace_id", workspace_id)
    .eq("status", "active")
    .eq("is_internal", true)
    .or("comp.is.null,comp.eq.false");

  const overdue_but_active: StrandedOverdueFinding[] = [];
  for (const s of (activeSubs || []) as Array<{
    id: string;
    workspace_id: string;
    customer_id: string | null;
    shopify_contract_id: string;
    next_billing_date: string | null;
    billing_interval: string | null;
    billing_interval_count: number | null;
    comp: boolean | null;
    is_internal: boolean | null;
    status: string;
  }>) {
    if (!s.next_billing_date) continue;
    const nbd = Date.parse(s.next_billing_date);
    if (!Number.isFinite(nbd)) continue;
    const threshold = intervalMs(s.billing_interval, s.billing_interval_count) * 1.5;
    const overdueBy = nowMs - nbd;
    if (overdueBy <= threshold) continue;
    overdue_but_active.push({
      workspace_id,
      subscription_id: s.id,
      customer_id: s.customer_id,
      contract_id: s.shopify_contract_id,
      next_billing_date: s.next_billing_date,
      billing_interval: (s.billing_interval || "week").toLowerCase(),
      billing_interval_count: Math.max(1, Number(s.billing_interval_count || 1)),
      days_overdue: Math.floor(overdueBy / (24 * 60 * 60_000)),
    });
  }

  return { workspace_id, contract_drift, overdue_but_active };
}

/**
 * Write one `dashboard_notifications` card per finding, deduplicated on a
 * stable `dedupe_key` inside `metadata` — same convention as
 * [[subscription-duplicate-renewal-detector]] surfaceDuplicateRenewalAlert
 * (the partial UNIQUE index `dashboard_notifications_dedupe_key_open_uniq`
 * enforces one-open-card-per-key at the DB level, so a rescanned finding does
 * not stack cards).
 */
export async function surfaceStrandedDunningAlerts(
  admin: Admin,
  report: StrandedDunningReport,
): Promise<{ alerts_inserted: number }> {
  let alerts_inserted = 0;

  for (const f of report.contract_drift) {
    const dedupe_key = `stranded-dunning-contract-drift:${f.cycle_id}`;
    const { data: existing } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", f.workspace_id)
      .contains("metadata", { dedupe_key })
      .limit(1)
      .maybeSingle();
    if (existing) continue;
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: f.workspace_id,
      type: "billing_alert",
      title: `Stranded dunning cycle — contract drift on subscription ${f.subscription_id.slice(0, 8)}`,
      body:
        `Dunning cycle ${f.cycle_id} (cycle #${f.cycle_number}, status ${f.cycle_status}) points at contract ` +
        `${f.cycle_contract_id}, but its subscription ${f.subscription_id} is now on ${f.subscription_contract_id}. ` +
        `Every dunning retry follows the cycle's contract, so this cycle silently retries a dead contract and ` +
        `the sub drops out of renewal selection. Repair: re-point the cycle to the sub's current contract via ` +
        `updateDunningCycle (or close the cycle as exhausted with closed_reason='orphaned_by_migration' on a ` +
        `cycle_number collision).`,
      metadata: {
        kind: "stranded_dunning_contract_drift",
        dedupe_key,
        cycle_id: f.cycle_id,
        subscription_id: f.subscription_id,
        cycle_contract_id: f.cycle_contract_id,
        subscription_contract_id: f.subscription_contract_id,
        cycle_status: f.cycle_status,
        cycle_number: f.cycle_number,
      },
    });
    if (error) throw new Error(`surface_stranded_contract_drift_failed: ${error.message}`);
    alerts_inserted++;
  }

  for (const f of report.overdue_but_active) {
    const dedupe_key = `stranded-dunning-overdue-active:${f.subscription_id}`;
    const { data: existing } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", f.workspace_id)
      .contains("metadata", { dedupe_key })
      .limit(1)
      .maybeSingle();
    if (existing) continue;
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: f.workspace_id,
      type: "billing_alert",
      title: `Stranded subscription — active + internal, ${f.days_overdue} days past billing date`,
      body:
        `Subscription ${f.subscription_id} (contract ${f.contract_id}) is status='active', is_internal=true, and ` +
        `next_billing_date ${f.next_billing_date} is more than 1.5 × ${f.billing_interval_count} ${f.billing_interval}(s) ` +
        `in the past (${f.days_overdue} days overdue). Comp subs are excluded, so this is a real billable sub that ` +
        `has silently stopped renewing. Investigate the sub's open dunning cycles (contract drift?), payment method ` +
        `validity, and the last renewal attempt's outcome.`,
      metadata: {
        kind: "stranded_dunning_overdue_active",
        dedupe_key,
        subscription_id: f.subscription_id,
        customer_id: f.customer_id,
        contract_id: f.contract_id,
        next_billing_date: f.next_billing_date,
        billing_interval: f.billing_interval,
        billing_interval_count: f.billing_interval_count,
        days_overdue: f.days_overdue,
      },
    });
    if (error) throw new Error(`surface_stranded_overdue_failed: ${error.message}`);
    alerts_inserted++;
  }

  return { alerts_inserted };
}

/**
 * Scan + surface in one call — the shape the daily internal-subscription-renewal-cron
 * uses at end-of-run to piggy-back the sweep with no new cadence to monitor.
 */
export async function runStrandedDunningCyclesSweep(
  admin: Admin,
  workspace_id: string,
): Promise<{ contract_drift: number; overdue_but_active: number; alerts_inserted: number }> {
  const report = await detectStrandedDunningCycles(admin, workspace_id);
  const surface = await surfaceStrandedDunningAlerts(admin, report);
  return {
    contract_drift: report.contract_drift.length,
    overdue_but_active: report.overdue_but_active.length,
    alerts_inserted: surface.alerts_inserted,
  };
}
