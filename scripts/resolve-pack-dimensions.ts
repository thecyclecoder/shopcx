/**
 * Resolve real pack dimensions from the Amazon catalog onto `product_variants`, so ad renders
 * reproduce each pouch's true proportions ([[../src/lib/amazon/pack-dimensions]]).
 *
 *   npx tsx scripts/resolve-pack-dimensions.ts                  # dry run, every advertised product
 *   npx tsx scripts/resolve-pack-dimensions.ts --apply          # persist (won't overwrite existing)
 *   npx tsx scripts/resolve-pack-dimensions.ts --apply --overwrite
 *   npx tsx scripts/resolve-pack-dimensions.ts --product <uuid>
 *
 * Dry-run by default, per the script conventions. Skips a variant that already carries a width
 * unless --overwrite: a hand-measured number outranks a scraped one.
 */
import { createAdminClient } from "./_bootstrap";
import { listAdvertisedProductIds } from "../src/lib/advertised-products";
import { resolvePackDimensionsForProduct, persistPackDimensions } from "../src/lib/amazon/pack-dimensions";

const WORKSPACE_ID = process.env.WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const apply = process.argv.includes("--apply");
  const overwrite = process.argv.includes("--overwrite");
  const pIdx = process.argv.indexOf("--product");
  const only = pIdx >= 0 ? process.argv[pIdx + 1] : null;

  const admin = createAdminClient();
  const productIds = only ? [only] : await listAdvertisedProductIds(admin, WORKSPACE_ID);
  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${productIds.length} product(s)${overwrite ? " (overwrite ON)" : ""}\n`);

  for (const productId of productIds) {
    const { data: p } = await admin.from("products").select("title").eq("id", productId).maybeSingle();
    const title = (p as { title?: string } | null)?.title ?? productId;
    const res = await resolvePackDimensionsForProduct(admin, WORKSPACE_ID, productId);
    if (!res.chosen) {
      console.log(`${title.padEnd(28)} — no dimensions (${res.reason})`);
      continue;
    }
    const ratio = (res.chosen.widthMm / res.chosen.heightMm).toFixed(2);
    console.log(
      `${title.padEnd(28)} ${res.chosen.widthMm}W x ${res.chosen.heightMm}H x ${res.chosen.depthMm}D mm  (${ratio}:1)`,
    );
    console.log(`    ${res.reason}`);
    if (apply) {
      const { updated, skipped } = await persistPackDimensions(admin, WORKSPACE_ID, productId, res.chosen, { overwrite });
      console.log(`    → ${updated} variant(s) updated, ${skipped} skipped (already measured)`);
    }
  }
  if (!apply) console.log("\nDry run — re-run with --apply to persist.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
