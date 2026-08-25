/**
 * Delete the `status='failed'` creative_skeletons rows written by the first live Meta scout.
 *
 * They are artefacts of a renderer bug (a STRING passed to `page.evaluate`, which Playwright
 * evaluates as an expression and never calls — so every render looked like a stripped creative and
 * was misclassified `permanent`). Those rows have no creative, no vision, and their `dedup_key`
 * would make `splitNewExisting` skip the same ads on every future sweep — poisoning them forever.
 *
 * Scope is deliberately narrow: source='meta_ad_library' AND status='failed' AND thumb_path IS NULL
 * AND hook IS NULL. A genuinely-analyzed Meta row can never match.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("creative_skeletons")
    .select("id, advertiser, dedup_key, status, thumb_path, hook")
    .eq("source", "meta_ad_library")
    .eq("status", "failed")
    .is("thumb_path", null)
    .is("hook", null);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; advertiser: string | null; dedup_key: string }>;

  console.log(`poisoned rows: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.id.slice(0, 8)} ${(r.advertiser ?? "?").padEnd(20)} ${r.dedup_key}`);
  if (!rows.length) return;

  if (!APPLY) return console.log("\nDRY RUN — re-run with --apply to delete.");

  const { error: delErr } = await admin
    .from("creative_skeletons")
    .delete()
    .in("id", rows.map((r) => r.id));
  if (delErr) throw delErr;
  console.log(`\ndeleted ${rows.length} — those ad_keys are eligible again next sweep.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
