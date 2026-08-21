/**
 * Backfill Phase 2 of cancelled-subs-stop-reporting-a-future-billing-date.
 *
 * Phase 1 makes future cancels leave a truthful row (`status='cancelled'` ⇒
 * `next_billing_date IS NULL` AND `cancelled_at IS NOT NULL`). This one fixes
 * every historically-cancelled row so an agent reading one today is not
 * misled the way the CS Director was on ticket f773b8ec (bonnie marlette,
 * 2026-08-21) — her contract 27806990509 still reads
 * `next_billing_date=2026-09-11` on a `cancelled` row.
 *
 * For every `public.subscriptions` row with `status = 'cancelled'`:
 *   1. Null `next_billing_date` where currently non-null.
 *   2. Stamp `cancelled_at` where currently null, sourced from the most-recent
 *      `public.billing_forecast_events` row for the same `shopify_contract_id`
 *      with `event_type = 'cancellation'` (the literal written by
 *      `logForecastEvent` in [[../src/lib/billing-forecast.ts]] `forecastCancelled`
 *      — probed in `docs/brain/tables/billing_forecast_events.md`).
 *   3. Fall back to the subscription row's `updated_at` when no cancellation
 *      event exists (older rows predating the forecast ledger) and count it
 *      in the run summary — never silently present a guess as the cancel moment.
 *
 * Idempotent + resumable + chunked. Re-running after a successful pass finds
 * every row already truth-invariant and writes nothing. Every write is a
 * compare-and-set on the row still being `cancelled` in its workspace, so an
 * async read result cannot overwrite a row a concurrent path just reactivated
 * (see the confirming-predicate coaching).
 *
 * Two-phase per the [[../.claude/skills/backfill]] convention: dry-run by
 * default (prints counts + a per-row diff sample), `--apply` to write. When
 * scoped to a single workspace, pass the UUID as the first positional arg;
 * otherwise the script iterates every workspace_id present on cancelled subs.
 *
 *   npx tsx scripts/_backfill-cancelled-sub-truth.ts                 # dry-run, all workspaces
 *   npx tsx scripts/_backfill-cancelled-sub-truth.ts <workspaceId>   # dry-run, one workspace
 *   npx tsx scripts/_backfill-cancelled-sub-truth.ts --apply         # write, all workspaces
 *
 * See [[../docs/brain/specs/cancelled-subs-stop-reporting-a-future-billing-date]] Phase 2.
 */
import { createAdminClient } from "./_bootstrap";
import { buildCancelTruthPatch } from "../src/lib/subscription-cancel-truth";

const CHUNK = 200;

interface Sub {
  id: string;
  workspace_id: string;
  shopify_contract_id: string | null;
  next_billing_date: string | null;
  cancelled_at: string | null;
  updated_at: string | null;
}

interface RowPlan {
  sub: Sub;
  clearNextBillingDate: boolean;
  stampCancelledAt: string | null;
  fallbackToUpdatedAt: boolean;
}

async function mostRecentCancellationEventAt(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  shopifyContractId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("billing_forecast_events")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .eq("event_type", "cancellation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.created_at as string | undefined) ?? null;
}

async function planRow(
  admin: ReturnType<typeof createAdminClient>,
  sub: Sub,
): Promise<RowPlan> {
  const plan: RowPlan = {
    sub,
    clearNextBillingDate: sub.next_billing_date != null,
    stampCancelledAt: null,
    fallbackToUpdatedAt: false,
  };
  if (sub.cancelled_at == null) {
    let ts: string | null = null;
    if (sub.shopify_contract_id) {
      ts = await mostRecentCancellationEventAt(admin, sub.workspace_id, sub.shopify_contract_id);
    }
    if (!ts) {
      ts = sub.updated_at ?? new Date().toISOString();
      plan.fallbackToUpdatedAt = true;
    }
    plan.stampCancelledAt = ts;
  }
  return plan;
}

async function processWorkspace(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  apply: boolean,
): Promise<{
  scanned: number;
  datesCleared: number;
  stampedFromLedger: number;
  stampedFromFallback: number;
  alreadyTruthful: number;
}> {
  const totals = {
    scanned: 0,
    datesCleared: 0,
    stampedFromLedger: 0,
    stampedFromFallback: 0,
    alreadyTruthful: 0,
  };

  // Resumable cursor over (created_at, id) — pagination without OFFSET.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = admin
      .from("subscriptions")
      .select("id, workspace_id, shopify_contract_id, next_billing_date, cancelled_at, updated_at, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "cancelled")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(`workspace=${workspaceId} read failed: ${error.message}`);
    const page = (rows ?? []) as Array<Sub & { created_at: string }>;
    if (page.length === 0) break;

    for (const row of page) {
      totals.scanned += 1;
      const plan = await planRow(admin, row);
      if (!plan.clearNextBillingDate && plan.stampCancelledAt == null) {
        totals.alreadyTruthful += 1;
      } else {
        if (plan.clearNextBillingDate) totals.datesCleared += 1;
        if (plan.stampCancelledAt != null) {
          if (plan.fallbackToUpdatedAt) totals.stampedFromFallback += 1;
          else totals.stampedFromLedger += 1;
        }
        if (apply) {
          // Use the same pure helper the two writers use — one invariant, one
          // patch shape. Pass existingCancelledAt so a row already carrying a
          // stamp keeps it (idempotent re-runs).
          const patch = buildCancelTruthPatch("cancelled", {
            existingCancelledAt: row.cancelled_at,
            nowIso: plan.stampCancelledAt ?? undefined,
          });
          // Compare-and-set: only rewrite rows STILL cancelled in this
          // workspace so an intervening resume can't be clobbered. The
          // .select('id') asserts a single row transitioned (or none — a
          // resumed row is intentionally skipped, not an error).
          const { error: updErr } = await admin
            .from("subscriptions")
            .update({
              next_billing_date: patch.next_billing_date ?? null,
              cancelled_at: patch.cancelled_at ?? row.cancelled_at,
            })
            .eq("id", row.id)
            .eq("workspace_id", row.workspace_id)
            .eq("status", "cancelled")
            .select("id");
          if (updErr) {
            console.error(`  ! update failed for ${row.id}: ${updErr.message}`);
          }
        }
      }
    }

    cursorCreatedAt = page[page.length - 1].created_at;
    cursorId = page[page.length - 1].id;
    if (page.length < CHUNK) break;
  }

  return totals;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  const scopedWorkspace = args[0];

  const admin = createAdminClient();

  let workspaceIds: string[];
  if (scopedWorkspace) {
    workspaceIds = [scopedWorkspace];
  } else {
    // Every workspace with at least one cancelled sub — narrow the sweep so a
    // fresh-tenant workspace with zero subs is skipped.
    const { data: rows, error } = await admin
      .from("subscriptions")
      .select("workspace_id")
      .eq("status", "cancelled");
    if (error) throw new Error(`workspace discovery failed: ${error.message}`);
    workspaceIds = Array.from(new Set((rows ?? []).map((r) => r.workspace_id as string))).filter(Boolean);
  }

  const grand = {
    scanned: 0,
    datesCleared: 0,
    stampedFromLedger: 0,
    stampedFromFallback: 0,
    alreadyTruthful: 0,
  };

  console.log(
    `cancelled-sub-truth backfill — mode=${apply ? "APPLY" : "DRY-RUN"} · workspaces=${workspaceIds.length}`,
  );
  for (const ws of workspaceIds) {
    const t = await processWorkspace(admin, ws, apply);
    grand.scanned += t.scanned;
    grand.datesCleared += t.datesCleared;
    grand.stampedFromLedger += t.stampedFromLedger;
    grand.stampedFromFallback += t.stampedFromFallback;
    grand.alreadyTruthful += t.alreadyTruthful;
    console.log(
      `  ws=${ws}  scanned=${t.scanned}  truthful=${t.alreadyTruthful}  dates_cleared=${t.datesCleared}  stamped_from_ledger=${t.stampedFromLedger}  stamped_from_updated_at=${t.stampedFromFallback}`,
    );
  }

  console.log("\nsummary");
  console.log(`  rows scanned                   ${grand.scanned}`);
  console.log(`  already truthful               ${grand.alreadyTruthful}`);
  console.log(`  next_billing_date cleared      ${grand.datesCleared}`);
  console.log(`  cancelled_at from ledger       ${grand.stampedFromLedger}`);
  console.log(`  cancelled_at from updated_at   ${grand.stampedFromFallback}  (fallback — no cancellation event)`);
  if (!apply) {
    console.log("\n(dry-run) — re-run with --apply to write.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
