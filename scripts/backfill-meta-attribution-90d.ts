/**
 * Backfill + prove the Meta attribution signal is restored — Phase 3 of the
 * attribution-sensor-recalibration spec.
 *
 * Runs `refreshVariantAttribution` with a forced **90-day** window over EVERY
 * active `meta_ad_accounts` row and captures each account's
 * `variant_attribution_coverage` so the improvement is auditable in one place.
 *
 *   Recompute source:   src/lib/meta/attribution.ts (computeVariantAttribution)
 *   Write path:         idempotent upsert on
 *                       (workspace_id, meta_ad_id, variant, snapshot_date)
 *
 * Follows every recompute with two read-only verification probes:
 *
 *   1. `meta_attribution_daily` — last 30 days — asserts AT LEAST ONE row with
 *      variant != '(unresolved)' AND roas > 0 (June's converting ads resolve).
 *   2. `detectWinners()` — returns without throwing and reads a non-degenerate
 *      universe: at least one `(meta_ad_id, variant)` cell has revenue > 0
 *      (kills the "everything is roas=0" state the sensor was in).
 *
 * Dry-run / apply gate per script-conventions:
 *
 *   npx tsx scripts/backfill-meta-attribution-90d.ts            # DRY-RUN (probes only, no recompute)
 *   npx tsx scripts/backfill-meta-attribution-90d.ts --apply    # writes: recomputes 90d per account
 *
 * The write is a non-destructive idempotent upsert — no schema change, no
 * deletes — but this is the gated owner action because it fans out over every
 * connected account and rewrites the last 90 days of attribution rows.
 */
import type { createAdminClient as _createAdminClient } from "../src/lib/supabase/admin";
import { createAdminClient } from "./_bootstrap";
import { refreshVariantAttribution, UNRESOLVED_VARIANT } from "../src/lib/meta/attribution";
import { detectWinners } from "../src/lib/ads/winning-creative-detect";

type Admin = ReturnType<typeof _createAdminClient>;

const APPLY = process.argv.includes("--apply");
const BACKFILL_DAYS = 90;
const VERIFY_WINDOW_DAYS = 30;

interface AccountResult {
  workspaceId: string;
  adAccountId: string;
  metaAccountId: string;
  recomputed: boolean;
  coverage: number | null;
  metaOrdersTotal: number;
  metaOrdersResolved: number;
  rowsPersisted: number;
  probe30d: {
    rowsTotal: number;
    rowsResolvedWithRoas: number; // variant != '(unresolved)' AND roas > 0
    passed: boolean;
  };
  detectWinners: {
    rowsWithRevenue: number; // at least 1 → sensor no longer degenerate
    winnersReturned: number; // detectWinners actual return count (top-K, may be 0)
    passed: boolean;
    error: string | null;
  };
}

async function loadActiveAccounts(admin: Admin) {
  const { data, error } = await admin
    .from("meta_ad_accounts")
    .select("id, workspace_id, meta_account_id")
    .eq("is_active", true)
    .order("id", { ascending: true });
  if (error) throw new Error(`meta_ad_accounts fetch: ${error.message}`);
  return (data || []) as { id: string; workspace_id: string; meta_account_id: string }[];
}

/** Read-only 30d probe of `meta_attribution_daily` — kills the roas=0 universe assertion. */
async function probeLast30Days(admin: Admin, adAccountId: string) {
  const since = new Date(Date.now() - VERIFY_WINDOW_DAYS * 86400000)
    .toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const { data, error } = await admin
    .from("meta_attribution_daily")
    .select("meta_ad_id, variant, roas, revenue_cents, snapshot_date")
    .eq("meta_ad_account_id", adAccountId)
    .gte("snapshot_date", since);
  if (error) throw new Error(`meta_attribution_daily probe: ${error.message}`);
  const rows = (data || []) as { variant: string; roas: number | null; revenue_cents: number | null }[];
  const rowsResolvedWithRoas = rows.filter(
    (r) => r.variant !== UNRESOLVED_VARIANT && Number(r.roas || 0) > 0,
  ).length;
  return { rowsTotal: rows.length, rowsResolvedWithRoas, passed: rowsResolvedWithRoas > 0 };
}

/** Read-only detectWinners probe — asserts non-degenerate revenue universe + no throw. */
async function probeDetectWinners(admin: Admin, workspaceId: string, adAccountId: string) {
  try {
    const winners = await detectWinners(admin, { workspaceId });
    const { data, error } = await admin
      .from("meta_attribution_daily")
      .select("revenue_cents")
      .eq("meta_ad_account_id", adAccountId)
      .gt("revenue_cents", 0)
      .limit(1);
    if (error) throw new Error(`revenue_cents probe: ${error.message}`);
    const rowsWithRevenue = (data || []).length;
    return { rowsWithRevenue, winnersReturned: winners.length, passed: rowsWithRevenue > 0, error: null };
  } catch (err) {
    return {
      rowsWithRevenue: 0,
      winnersReturned: 0,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function processAccount(
  admin: Admin,
  acct: { id: string; workspace_id: string; meta_account_id: string },
): Promise<AccountResult> {
  const base = {
    workspaceId: acct.workspace_id,
    adAccountId: acct.id,
    metaAccountId: acct.meta_account_id,
  };

  let recomputed = false;
  let coverage: number | null = null;
  let metaOrdersTotal = 0;
  let metaOrdersResolved = 0;
  let rowsPersisted = 0;
  if (APPLY) {
    // incrementalDays: 90 forces a 90-day recompute even when the account
    // already has rows (default incremental is 7d). The upsert on
    // (workspace_id, meta_ad_id, variant, snapshot_date) makes this idempotent.
    const res = await refreshVariantAttribution(
      { workspaceId: acct.workspace_id, adAccountId: acct.id },
      { backfillDays: BACKFILL_DAYS, incrementalDays: BACKFILL_DAYS },
    );
    recomputed = true;
    coverage = res.coverage.variant_attribution_coverage;
    metaOrdersTotal = res.coverage.meta_orders_total;
    metaOrdersResolved = res.coverage.meta_orders_resolved;
    rowsPersisted = res.rows;
  }

  const probe30d = await probeLast30Days(admin, acct.id);
  const winners = await probeDetectWinners(admin, acct.workspace_id, acct.id);

  return {
    ...base,
    recomputed,
    coverage,
    metaOrdersTotal,
    metaOrdersResolved,
    rowsPersisted,
    probe30d,
    detectWinners: winners,
  };
}

async function main() {
  const admin = createAdminClient();

  console.log(
    `Meta attribution backfill + verify — mode=${APPLY ? "APPLY (90d recompute per account)" : "DRY-RUN (probes only)"}`,
  );

  const accounts = await loadActiveAccounts(admin);
  if (accounts.length === 0) {
    console.log("No active meta_ad_accounts. Nothing to do.");
    return;
  }
  console.log(`Found ${accounts.length} active meta_ad_accounts.\n`);

  const results: AccountResult[] = [];
  for (const acct of accounts) {
    console.log(`── ${acct.id} (workspace=${acct.workspace_id} · meta=${acct.meta_account_id}) ──`);
    const t0 = Date.now();
    try {
      const r = await processAccount(admin, acct);
      results.push(r);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.recomputed) {
        console.log(
          `  recompute: rows=${r.rowsPersisted} · orders_total=${r.metaOrdersTotal} · orders_resolved=${r.metaOrdersResolved} · coverage=${r.coverage ?? "n/a"} (${dt}s)`,
        );
      } else {
        console.log(`  recompute: SKIPPED (dry-run) (${dt}s)`);
      }
      console.log(
        `  30d probe: rowsTotal=${r.probe30d.rowsTotal} · resolvedWithRoas=${r.probe30d.rowsResolvedWithRoas} · PASSED=${r.probe30d.passed}`,
      );
      console.log(
        `  detectWinners: rowsWithRevenue=${r.detectWinners.rowsWithRevenue} · winnersReturned=${r.detectWinners.winnersReturned} · PASSED=${r.detectWinners.passed}${r.detectWinners.error ? ` · error=${r.detectWinners.error}` : ""}`,
      );
    } catch (err) {
      console.error(`  FATAL: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }

  // Summary — one row the operator can paste into the spec verification note.
  console.log("─".repeat(88));
  console.log("SUMMARY");
  console.log("─".repeat(88));
  let anyPassed = false;
  let coverageSum = 0;
  let coverageN = 0;
  for (const r of results) {
    if (r.probe30d.passed && r.detectWinners.passed) anyPassed = true;
    if (r.coverage != null) {
      coverageSum += r.coverage;
      coverageN += 1;
    }
    const status = r.probe30d.passed && r.detectWinners.passed ? "OK" : "FAIL";
    console.log(
      `  ${status} · account=${r.adAccountId} · coverage=${r.coverage ?? "n/a"} · 30d_ok=${r.probe30d.passed} · winners_ok=${r.detectWinners.passed}`,
    );
  }
  const avgCoverage = coverageN > 0 ? (coverageSum / coverageN).toFixed(4) : "n/a";
  console.log(
    `\nActive accounts: ${accounts.length} · At least one PASSED: ${anyPassed} · Avg coverage (over APPLY runs): ${avgCoverage} (target > 0.5)`,
  );
  console.log(APPLY ? "\n✓ Backfill complete." : "\nDRY-RUN — re-run with --apply to recompute 90 days per account.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
