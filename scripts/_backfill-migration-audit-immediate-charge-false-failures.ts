/**
 * Ship-time backfill: re-verify every `migration_audits` row that ended `status='failed'`
 * on the `immediate_charge` check against SETTLED subscription state, and flip it to
 * `passed` when the charge demonstrably succeeded.
 *
 * Phase 1 fixed [[../src/lib/migration-audit]]'s `immediate_charge` check so it judges
 * settled state (`subscriptions.last_payment_status` OR a `paid`/`partially_refunded`
 * order created after the migration timestamp), not the pre-retry `renewal` transaction
 * it used to read inline. Historical rows were flagged under the old logic — 10 measured
 * on 2026-08-28, all 10 subscriptions actually paid — and this backfill clears them.
 *
 * Ground truth: audit `ecf8e8fc` (Denise Butler, sub `549c234d`, 2026-08-18) — audit row
 * created `03:21:27.99`, order `SHOPCX229` paid $64.96 at `03:21:32.92`. The old check
 * saw the OLD failed renewal 5 seconds before the retry's paid order landed and flagged
 * the row `failed: immediate_charge: last renewal failed`; the sub itself reads
 * `last_payment_status='succeeded'`.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` (writes a `pending` row to `public.data_op_runs`
 * and escalates any un-run row to the CEO inbox); the box worker's ship-time backfill
 * executor ([[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`)
 * runs it and flips the row to `ran` / `failed` on completion.
 *
 * NARROW BY CONSTRUCTION — this script only touches audit rows that:
 *   1. `status = 'failed'`
 *   2. Their `checks` array shows the `immediate_charge` check as the (or a) failing key
 *   3. Live subscription state proves the charge actually succeeded — EITHER
 *        (a) `subscriptions.last_payment_status = 'succeeded'`, OR
 *        (b) an `orders` row for this subscription created after `migration_audits.created_at`
 *            with `financial_status in ('paid','partially_refunded')`.
 * A row that shows any OTHER failing check (pricing_preserved, items_on_uuids, appstle_cancelled,
 * card_pinned, no_double_bill, etc.) is LEFT ALONE — this backfill only reverses the false
 * positive introduced by the pre-retry read; a genuine renewal-at-risk stays `failed` for
 * human review. A row whose subscription cannot be proven succeeded is also LEFT ALONE.
 *
 * Idempotent by construction — a compare-and-set update filters on `status = 'failed'`, so a
 * re-run finds zero eligible rows (every previously-flipped row now carries `status='passed'`
 * and no longer matches). A concurrent re-verify that lands between our read and our write
 * only affects rows we haven't cursored to yet.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-migration-audit-immediate-charge-false-failures.ts            # dry-run
 *   npx tsx scripts/_backfill-migration-audit-immediate-charge-false-failures.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { reverifyImmediateCharge } from "../src/lib/migration-audit";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 500;

interface AuditRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  status: string;
  checks: unknown;
  created_at: string;
  last_error: string | null;
}

interface Check {
  key: string;
  ok: boolean;
  detail?: string;
}

function normalizeChecks(raw: unknown): Check[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      key: String(c.key ?? ""),
      ok: c.ok === true,
      detail: c.detail == null ? undefined : String(c.detail),
    }))
    .filter((c) => c.key);
}

/** True iff the row's ONLY failing check was `immediate_charge` — a row with any other
 *  failing check is a genuine (or additional) renewal-at-risk and stays `failed`. */
export function immediateChargeIsSoleFailure(checks: Check[]): boolean {
  const failing = checks.filter((c) => !c.ok);
  return failing.length > 0 && failing.every((c) => c.key === "immediate_charge");
}

async function main(): Promise<void> {
  const admin = createAdminClient();

  console.log(
    `migration_audit_immediate_charge_false_failures_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  console.log(
    `  matching: migration_audits where status='failed' AND immediate_charge is the sole failing check`,
  );
  console.log(
    `  flipping only when live sub state proves the charge succeeded (last_payment_status OR paid order after created_at)\n`,
  );

  let cursor: string | null = null;
  let scanned = 0;
  let eligibleShape = 0;
  let wouldFlip = 0;
  let flipped = 0;
  let leftAloneOtherChecks = 0;
  let leftAloneUnsettled = 0;
  let racedByCas = 0;

  for (;;) {
    let q = admin
      .from("migration_audits")
      .select("id, workspace_id, subscription_id, status, checks, created_at, last_error")
      .eq("status", "failed")
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`select failed: ${error.message}`);

    const chunk = (data ?? []) as AuditRow[];
    if (!chunk.length) break;

    for (const row of chunk) {
      scanned++;
      const checks = normalizeChecks(row.checks);

      if (!immediateChargeIsSoleFailure(checks)) {
        leftAloneOtherChecks++;
        continue;
      }
      eligibleShape++;

      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, last_payment_status")
        .eq("id", row.subscription_id)
        .eq("workspace_id", row.workspace_id)
        .maybeSingle();
      const lastPaymentStatus = (sub as { last_payment_status?: string | null } | null)?.last_payment_status ?? null;
      // Reuse the SAME settled-state predicate the live check runs — no drift.
      const settled = await reverifyImmediateCharge(admin, {
        workspaceId: row.workspace_id,
        subscriptionId: row.subscription_id,
        migratedAt: row.created_at,
        lastPaymentStatus,
      });
      if (!settled.ok) {
        leftAloneUnsettled++;
        console.log(`  leave-alone audit=${row.id} sub=${row.subscription_id} — ${settled.detail}`);
        continue;
      }

      const proof = settled.detail;

      if (!APPLY) {
        wouldFlip++;
        console.log(`  would-flip  audit=${row.id} sub=${row.subscription_id} — ${proof}`);
        continue;
      }

      const nextChecks = checks.map((c) =>
        c.key === "immediate_charge"
          ? { key: c.key, ok: true, detail: `backfilled 2026-08-28: settled ${proof}` }
          : c,
      );
      const { data: upData, error: upErr } = await admin
        .from("migration_audits")
        .update({
          status: "passed",
          checks: nextChecks,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("status", "failed")
        .select("id");
      if (upErr) throw new Error(`update failed audit=${row.id}: ${upErr.message}`);
      if (!upData?.length) {
        racedByCas++;
        console.log(
          `  raced-by-cas audit=${row.id} — status changed between read and write (safe: no overwrite)`,
        );
        continue;
      }
      flipped++;
      console.log(`  flipped     audit=${row.id} sub=${row.subscription_id} — ${proof}`);
    }

    if (chunk.length < CHUNK) break;
    cursor = chunk[chunk.length - 1].id;
  }

  console.log("");
  if (APPLY) {
    console.log(
      `result: scanned=${scanned} eligible-shape=${eligibleShape} flipped=${flipped} left-alone-other-checks=${leftAloneOtherChecks} left-alone-unsettled=${leftAloneUnsettled} raced-by-cas=${racedByCas}`,
    );
  } else {
    console.log(
      `result: scanned=${scanned} eligible-shape=${eligibleShape} would-flip=${wouldFlip} left-alone-other-checks=${leftAloneOtherChecks} left-alone-unsettled=${leftAloneUnsettled} (dry-run — re-run with --apply to write)`,
    );
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("ERR", errText(e));
    process.exit(1);
  });
}
