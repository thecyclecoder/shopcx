/**
 * One-off: clear the phantom `loop:migration-drift-check` alert.
 *
 * Background — the migration-drift check misread the live-present table set (privilege-filtered
 * information_schema.tables at the pooler hid god_mode_sessions / god_mode_approvals even though
 * both tables physically exist), so the loop flipped RED and paged. Phase 1 swapped the fetch to
 * pg_catalog.pg_class (permission-agnostic), which will make the next check-tick's color GREEN and
 * the monitor's auto-resolve fire. This script forces immediate closure so operators aren't staring
 * at the red tile in the ~30-min gap between Phase 1 shipping and the next monitor sweep.
 *
 * Dry-run by default; pass --apply to write. Scoped tightly to the phantom signature so it can
 * NEVER touch an unrelated open alert:
 *   loop_id = 'migration-drift-check' AND status = 'open' AND detail ILIKE '%god_mode%'
 *
 * The detail filter is belt-and-suspenders — a REAL drift alert on this loop that names something
 * OTHER than god_mode (a genuinely-absent table, a merged-but-unapplied migration) is left alone.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const LOOP_ID = "migration-drift-check";

async function main() {
  const admin = createAdminClient();

  const { data: alerts, error } = await admin
    .from("loop_alerts")
    .select("id, loop_id, reason, detail, status, opened_at, last_seen_at")
    .eq("loop_id", LOOP_ID)
    .eq("status", "open")
    .ilike("detail", "%god_mode%");
  if (error) throw error;

  console.log(`\nPhantom migration-drift alerts matched: ${alerts?.length ?? 0}`);
  for (const a of alerts ?? []) {
    console.log(
      `  • ${a.id}  reason=${a.reason}  opened=${a.opened_at}  last_seen=${a.last_seen_at}`,
    );
    console.log(`    detail: ${(a.detail ?? "").slice(0, 200)}`);
  }

  // Safety: show any OTHER open alert on this loop that we deliberately WON'T touch.
  const { data: otherOpen } = await admin
    .from("loop_alerts")
    .select("id, reason, detail, opened_at")
    .eq("loop_id", LOOP_ID)
    .eq("status", "open");
  const untouched = (otherOpen ?? []).filter((o) => !(alerts ?? []).some((a) => a.id === o.id));
  console.log(`\nOther open alerts on ${LOOP_ID} (NOT touched): ${untouched.length}`);
  for (const o of untouched) {
    console.log(`  • ${o.id}  reason=${o.reason}  detail: ${(o.detail ?? "").slice(0, 120)}`);
  }

  if (!APPLY) {
    console.log(`\n[dry-run] No writes. Re-run with --apply to resolve the above.\n`);
    return;
  }

  let cleared = 0;
  for (const a of alerts ?? []) {
    // Compare-and-set: re-assert loop_id + status='open' + the id so a concurrent
    // monitor auto-resolve or dashboard operator action can't be silently clobbered.
    const { data: updated, error: uErr } = await admin
      .from("loop_alerts")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", a.id)
      .eq("loop_id", LOOP_ID)
      .eq("status", "open")
      .select("id");
    if (uErr) {
      console.error(`  ! failed to resolve alert ${a.id}: ${uErr.message}`);
    } else if (!updated?.length) {
      console.log(`  · alert ${a.id} already resolved by another actor (no-op)`);
    } else {
      cleared++;
      console.log(`  ✓ resolved alert ${a.id}`);
    }
  }

  console.log(`\nDONE — resolved ${cleared} phantom migration-drift alert(s).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
