/**
 * One-time backfill — re-run the Phase-3 scorecard rollup for accounts that have
 * attribution rows but persisted 0 `iteration_scorecards_daily` rows.
 *
 * Context: `computeScorecards` previously swallowed the upsert `{ error }` and
 * returned `rows: records.length`, so a single dangling FK (an angle_id /
 * advertorial_page_id pointing at a deleted row) silently dropped the whole batch
 * — the run reported `scorecard_rows=7` while 0 rows landed, leaving the decision
 * engine flying blind. The fix (scripts → src/lib/meta/scorecards.ts) nulls
 * unresolved refs + isolates bad rows + throws on real errors; this script just
 * replays the rollup so the table populates from the existing
 * meta_attribution_daily rows.
 *
 * Idempotent: `computeScorecards` upserts on
 * (workspace_id, level, object_id, snapshot_date). Re-running is safe.
 *
 * Dry-run by default (lists the work). Pass --apply to actually write.
 *   npx tsx scripts/backfill-iteration-scorecards.ts          # dry-run
 *   npx tsx scripts/backfill-iteration-scorecards.ts --apply  # write
 *
 * See docs/brain/specs/iteration-scorecard-upsert-resilience.md.
 */
import { createAdminClient } from "./_bootstrap";
import { computeScorecards } from "../src/lib/meta/scorecards";

const APPLY = process.argv.includes("--apply");

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const admin = createAdminClient();

  // Accounts with at least one attribution row → candidates for a rollup.
  const { data: accts, error: acctErr } = await admin
    .from("meta_ad_accounts")
    .select("id, workspace_id");
  if (acctErr) throw new Error(`load meta_ad_accounts: ${acctErr.message}`);

  const snapshotDate = dayStr(new Date());
  console.log(`[backfill] snapshot_date=${snapshotDate} apply=${APPLY} accounts=${accts?.length ?? 0}`);

  for (const acct of accts || []) {
    const adAccountId = acct.id as string;
    const workspaceId = acct.workspace_id as string;

    const { count: attrCount } = await admin
      .from("meta_attribution_daily")
      .select("*", { count: "exact", head: true })
      .eq("meta_ad_account_id", adAccountId);
    const { count: scoreCount } = await admin
      .from("iteration_scorecards_daily")
      .select("*", { count: "exact", head: true })
      .eq("meta_ad_account_id", adAccountId)
      .eq("snapshot_date", snapshotDate);

    if (!attrCount) continue; // no attribution → nothing to roll up
    console.log(
      `[backfill] account=${adAccountId} attribution_rows=${attrCount} ` +
        `scorecards@${snapshotDate}=${scoreCount ?? 0}`,
    );

    if (!APPLY) {
      console.log(`[backfill]   dry-run — would re-run computeScorecards`);
      continue;
    }
    const r = await computeScorecards({ workspaceId, adAccountId }, snapshotDate);
    console.log(
      `[backfill]   persisted rows=${r.rows} counts=${JSON.stringify(r.counts)} ` +
        `coverage=${r.variant_attribution_coverage}`,
    );
  }

  console.log(`[backfill] done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
