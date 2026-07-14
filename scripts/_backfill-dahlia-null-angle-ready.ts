/**
 * One-time backfill for dahlia-creative-requires-angle-before-ready (Phase 2).
 *
 * Symptom: ~10 Dahlia competitor creatives are `ad_campaigns.status='ready' AND angle_id IS NULL`
 * across every hero product (Coffee, Creamer, Guru Focus, Creatine, Tabs, Zen Relax). Each LOOKS
 * available to Bianca (counts toward bin depth via listReadyToTest) but the media-buyer replenish
 * path skips it — `src/lib/media-buyer/agent.ts:1478 "campaign has no angle_id — no ad-copy source;
 * skipped to avoid a malformed Meta creative"`. Result: phantom depth, un-replenishable rows.
 *
 * Scope (deliberately narrow — leave manual/legacy rows untouched):
 *   workspace_id = <ws>  AND  status = 'ready'  AND  angle_id IS NULL  AND  name ILIKE 'Dahlia %competitor%'
 *   (the pipeline signature — Dahlia · <product> · competitor from insertReadyCreative)
 *
 * Action per row: hold the row out of 'ready' by flipping status to 'draft'. We do NOT fabricate an
 * angle_id (attaching a foreign product_ad_angles row would misattribute the creative to another
 * campaign's angle). Once out of 'ready', listReadyToTest ignores it and bin depth reflects only
 * deployable creatives; Dahlia's Phase-1 guard prevents the class from recurring.
 *
 * Dry-run by default. Prints the count + a per-row line. Pass `--apply` to actually write.
 *   npx tsx scripts/_backfill-dahlia-null-angle-ready.ts            # dry-run
 *   npx tsx scripts/_backfill-dahlia-null-angle-ready.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  // Read the offenders — scoped to the pipeline signature so manual/legacy rows (e.g. "… Reviews",
  // "(example)") stay untouched. Include product_id so the per-row log is legible.
  const { data: before, error: readErr } = await admin
    .from("ad_campaigns")
    .select("id, name, product_id, created_at, angle_id, status")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("status", "ready")
    .is("angle_id", null)
    .ilike("name", "Dahlia %competitor%")
    .order("created_at", { ascending: true });
  if (readErr) {
    console.error("read_failed", readErr.message);
    process.exit(1);
  }
  const rows = (before ?? []) as Array<{ id: string; name: string; product_id: string; created_at: string; angle_id: string | null; status: string }>;

  console.log(`dahlia_null_angle_ready_backfill — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  workspace: ${SUPERFOODS_WORKSPACE_ID}`);
  console.log(`  scope:     status='ready' AND angle_id IS NULL AND name ILIKE 'Dahlia %competitor%'`);
  console.log(`  before:    ${rows.length} row(s) to hold at 'draft'`);
  for (const r of rows) {
    console.log(`   - ${r.id}  product=${r.product_id}  ${JSON.stringify(r.name).slice(0, 100)}  (created ${r.created_at})`);
  }

  if (!rows.length) {
    console.log("nothing to backfill.");
    return;
  }

  if (!apply) {
    console.log("\n(dry-run) — rerun with --apply to hold these rows at status='draft'.");
    return;
  }

  // Compare-and-set: only flip rows still matching the read-time preconditions
  // (status='ready' AND angle_id IS NULL AND workspace scope) so an intervening
  // human write doesn't get clobbered. Chunked in small batches for a small set.
  const ids = rows.map((r) => r.id);
  const { data: updated, error: updErr } = await admin
    .from("ad_campaigns")
    .update({ status: "draft" })
    .in("id", ids)
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("status", "ready")
    .is("angle_id", null)
    .select("id");
  if (updErr) {
    console.error("update_failed", updErr.message);
    process.exit(1);
  }
  const changed = ((updated ?? []) as Array<{ id: string }>).length;
  console.log(`  updated:   ${changed} row(s) flipped to status='draft'`);

  // Re-read the after count for confidence.
  const { data: after } = await admin
    .from("ad_campaigns")
    .select("id")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("status", "ready")
    .is("angle_id", null)
    .ilike("name", "Dahlia %competitor%");
  const remaining = ((after ?? []) as Array<{ id: string }>).length;
  console.log(`  after:     ${remaining} row(s) still match the null-angle-ready scope (should be 0)`);
  if (remaining > 0) console.warn("⚠️  some rows remain — investigate before rerunning.");
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
