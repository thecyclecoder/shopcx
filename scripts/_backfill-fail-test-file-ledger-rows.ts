/**
 * One-time cleanup: retire the phantom `*.test.ts` rows the ship-time-backfill ledger accrued
 * before `isBackfillScriptPath` learned to reject test files —
 * [[../docs/brain/specs/ship-time-backfill-executor-passes-apply]] Phase 1.
 *
 * Why: the detector's `isBackfillScriptPath` regex `^scripts/_backfill-…\.ts$` also matched a
 * `_backfill-foo.test.ts` companion (the `.test` is just more `[a-z0-9._-]`), so the post-merge
 * detector ledgered unit-test files as `pending` `data_op_runs` backfills. Two such phantom rows
 * exist on main today:
 *   - scripts/_backfill-migration-audit-immediate-charge-false-failures.test.ts
 *   - scripts/_backfill-renewal-free-shipping-refunds.test.ts
 * The same PR teaches `isBackfillScriptPath` to reject `*.test.ts` / `*.spec.ts`, so no NEW
 * phantom row can be ledgered; this script flips every EXISTING `pending` test-file row to
 * `failed` with error `not a backfill (test file)` — through the ledger's own writer
 * (`markLedgerRowFailed`), never raw `.from(...).update` SQL.
 *
 * Idempotent: a re-run finds no `pending` test-file rows (the earlier run already flipped them)
 * and no-ops. Each write is a compare-and-set on `status='pending'`, so a row another pass
 * advanced is left alone.
 *
 * Auto-ledgered by the post-merge
 * [[../src/lib/ship-time-backfill-detector|ship-time-backfill-detector]] (the
 * `scripts/_backfill-*.ts` filename convention) and drained on the box by
 * `executeShipTimeBackfillsForSpec` in
 * [[../src/lib/ship-time-backfill-executor|ship-time-backfill-executor]].
 *
 * Dry-run by default. Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-fail-test-file-ledger-rows.ts            # dry-run
 *   npx tsx scripts/_backfill-fail-test-file-ledger-rows.ts --apply    # write
 *
 * Spec: docs/brain/specs/ship-time-backfill-executor-passes-apply.md Phase 1.
 */
import { createAdminClient } from "./_bootstrap";
import {
  isTestFileScriptPath,
  markLedgerRowFailed,
} from "../src/lib/ship-time-backfill-detector";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

const FAIL_REASON = "not a backfill (test file)";

type LedgerRow = { id: string; workspace_id: string; script_path: string };

(async () => {
  const admin = createAdminClient();
  console.log(
    `fail_test_file_ledger_rows_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const { data, error } = await admin
    .from("data_op_runs")
    .select("id, workspace_id, script_path")
    .eq("status", "pending");
  if (error) throw new Error(`data_op_runs read failed: ${error.message}`);

  const rows = ((data ?? []) as LedgerRow[]).filter((r) =>
    isTestFileScriptPath(r.script_path),
  );
  console.log(`  found ${rows.length} pending test-file ledger row(s)\n`);

  let flipped = 0;
  let raced = 0;
  for (const row of rows) {
    const label = `${row.script_path} (${row.id})`;
    if (!APPLY) {
      console.log(`  would fail  ${label}`);
      continue;
    }
    const ok = await markLedgerRowFailed(admin, {
      id: row.id,
      workspaceId: row.workspace_id,
      error: FAIL_REASON,
    });
    if (ok) {
      flipped++;
      console.log(`  failed      ${label}`);
    } else {
      raced++;
      console.log(`  raced       ${label} — already advanced by another pass`);
    }
  }

  console.log("");
  if (rows.length === 0) {
    console.log("result: no-op — nothing to do (no pending test-file rows)");
  } else if (APPLY) {
    console.log(`result: flipped=${flipped} raced=${raced}`);
  } else {
    console.log(
      `result: would-fail=${rows.length} (dry-run — re-run with --apply to write)`,
    );
  }
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
