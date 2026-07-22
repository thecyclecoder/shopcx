/**
 * _bump-realtime-demo — service-role write to a `realtime_demo` row, to verify Supabase Realtime.
 *
 * Open /dashboard/developer/realtime-test, then run this. The row's tick increments + note updates,
 * and the open page should reflect it within a few hundred ms with NO refresh (pushed over the
 * WebSocket subscription, not polled).
 *
 *   npx tsx scripts/_bump-realtime-demo.ts                 # increment tick, stamp a default note
 *   npx tsx scripts/_bump-realtime-demo.ts "custom note"   # increment tick, set a custom note
 *
 * Read-safe: touches only the demo table. Idempotent-ish (each run bumps tick by 1).
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const note = process.argv[2] || `bumped at ${new Date().toISOString()}`;
  const admin = createAdminClient();

  const { data: row, error: readErr } = await admin
    .from("realtime_demo")
    .select("id, tick")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!row) {
    console.error("No realtime_demo row found — apply the migration first (it seeds one).");
    process.exit(1);
  }

  const nextTick = (row.tick as number) + 1;
  const { error: updErr } = await admin
    .from("realtime_demo")
    .update({ tick: nextTick, note, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (updErr) throw updErr;

  console.log(`✓ bumped realtime_demo ${String(row.id).slice(0, 8)} → tick=${nextTick}, note="${note}"`);
  console.log("  Watch /dashboard/developer/realtime-test — it should update with no refresh.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
