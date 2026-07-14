/**
 * Phase 3 of [[../docs/brain/specs/competitor-sdk-chokepoint-and-per-product-cleanup]].
 *
 * Purges orphan competitors — rows with a null `product_id` OR a `product_id` that no longer
 * exists in the workspace's `products` table (the 46 legacy migrated seeds). All 6 hero products
 * now carry their own product-scoped competitors, so the null-scoped seeds are obsolete.
 *
 * Dry-run by default (lists what WOULD be deleted). Pass `--apply` to actually purge via the
 * `deleteOrphanCompetitors` SDK chokepoint (never a raw delete).
 *
 * FK safety: `competitors.runs_ads_for` is a self-FK ON DELETE SET NULL, so whitelisted-page rows
 * pointing at a purged brand automatically null their fronted-competitor link — no cascade damage.
 *
 * Usage:
 *   npx tsx scripts/purge-orphan-competitors.ts <workspaceId>          # dry-run: list orphans
 *   npx tsx scripts/purge-orphan-competitors.ts <workspaceId> --apply  # actually purge
 */
import "./_bootstrap";
import { listOrphanCompetitors, deleteOrphanCompetitors } from "../src/lib/competitors";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspaceId = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/purge-orphan-competitors.ts <workspaceId> [--apply]");
    process.exit(2);
  }

  const orphans = await listOrphanCompetitors(workspaceId);
  console.log(`orphan competitors: ${orphans.length}`);
  for (const r of orphans) {
    const scope = r.product_id ? `product_id=${r.product_id} (missing product)` : "product_id=NULL";
    console.log(`  ${r.id}  ${r.brand}  [${r.source}/${r.status}]  ${scope}`);
  }
  if (orphans.length === 0) return;

  if (!apply) {
    console.log("\ndry-run — re-run with --apply to purge.");
    return;
  }
  const result = await deleteOrphanCompetitors(workspaceId);
  console.log(`\ndeleted: ${result.deleted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
