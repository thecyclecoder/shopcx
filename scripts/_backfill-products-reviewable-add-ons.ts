/**
 * One-shot backfill: flip `products.reviewable = false` on the SKUs that are
 * add-ons the customer did not choose to buy on merit — the four Shipping
 * Protection products (`product_type='ShopWill'` OR `handle='shipping-insurance'`),
 * the internal `Mystery Item` SKU, and the three `(Free Gift)` duplicates listed
 * in `SHOPIFY_PRODUCT_ALIASES` (src/lib/shopify-review-metafields.ts). The
 * review-collection journey never asks about them.
 *
 * Why: `products.reviewable` ships with `default true` (Phase 1 migration
 * 20261215120000_review_collection_foundations.sql) — safe for the ~200 real
 * SKUs and correct on the growing product catalog going forward. But the ~8
 * pre-existing add-on rows need `false` stamped explicitly, or the review
 * journey would happily ask "how did you like the Shipping Protection?".
 *
 * Match rule: a row is updated only if `reviewable IS DISTINCT FROM false` AND
 * one of these matches (in the same UPDATE):
 *   - product_type ILIKE 'shopwill'                           (Shipping Protection · 4 rows)
 *   - handle ILIKE 'shipping-insurance'                       (Shipping Protection belt-and-suspenders)
 *   - LOWER(title) = 'mystery item'                           (internal Mystery Item SKU)
 *   - shopify_product_id IN (SHOPIFY_PRODUCT_ALIASES keys)    (three (Free Gift) duplicates)
 *
 * Idempotent — re-running after a successful pass finds zero matches (the
 * DISTINCT-FROM predicate) and exits clean. Auto-ledgered by the post-merge
 * [[../src/lib/ship-time-backfill-detector]] (the `scripts/_backfill-*.ts`
 * filename convention triggers the pending `data_op_runs` row + CEO card) and
 * drained on the box by [[../src/lib/ship-time-backfill-executor]]
 * `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1`
 * also works.
 *
 *   npx tsx scripts/_backfill-products-reviewable-add-ons.ts            # dry-run
 *   npx tsx scripts/_backfill-products-reviewable-add-ons.ts --apply    # write
 *
 * Spec: docs/brain/specs/review-collection-foundations.md Phase 1.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import { SHOPIFY_PRODUCT_ALIASES } from "../src/lib/shopify-review-metafields";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

type ProductRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  handle: string | null;
  product_type: string | null;
  shopify_product_id: string | null;
  reviewable: boolean | null;
};

const FREE_GIFT_SHOPIFY_IDS = Object.keys(SHOPIFY_PRODUCT_ALIASES);

function isAddOn(row: ProductRow): { match: boolean; reason: string } {
  const productType = (row.product_type || "").trim().toLowerCase();
  if (productType === "shopwill") return { match: true, reason: "product_type=ShopWill (Shipping Protection)" };

  const handle = (row.handle || "").trim().toLowerCase();
  if (handle === "shipping-insurance") return { match: true, reason: "handle=shipping-insurance (Shipping Protection)" };

  const title = (row.title || "").trim().toLowerCase();
  if (title === "mystery item") return { match: true, reason: "title=Mystery Item (internal SKU)" };

  if (row.shopify_product_id && FREE_GIFT_SHOPIFY_IDS.includes(row.shopify_product_id)) {
    return { match: true, reason: `shopify_product_id=${row.shopify_product_id} ((Free Gift) duplicate)` };
  }

  return { match: false, reason: "" };
}

(async () => {
  const admin = createAdminClient();

  console.log(`backfill_products_reviewable_add_ons — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  reviewable=false on Shipping Protection, Mystery Item, and (Free Gift) duplicates\n`);

  // Small universe (~200 rows total). Fetch the fields we need and filter
  // in memory — one round-trip, no cursor.
  const { data, error } = await admin
    .from("products")
    .select("id, workspace_id, title, handle, product_type, shopify_product_id, reviewable")
    .order("id", { ascending: true });
  if (error) throw new Error(`products select failed: ${error.message}`);

  const rows = (data ?? []) as ProductRow[];
  const targets = rows
    .map((r) => ({ row: r, verdict: isAddOn(r) }))
    .filter((t) => t.verdict.match && t.row.reviewable !== false);

  console.log(`  scanned=${rows.length} candidates=${targets.length}`);

  let stamped = 0;
  for (const { row, verdict } of targets) {
    console.log(
      `  ${APPLY ? "stamp        " : "would-stamp  "}` +
        `product=${row.id} title=${JSON.stringify(row.title)} — ${verdict.reason}`,
    );
    if (!APPLY) continue;

    // Compare-and-set on reviewable IS DISTINCT FROM false (via .not.eq) +
    // workspace_id so a concurrent hand-edit or later pass races us out
    // instead of being clobbered.
    const { data: updated, error: updateErr } = await admin
      .from("products")
      .update({ reviewable: false })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .not("reviewable", "is", false)
      .select("id");
    if (updateErr) throw new Error(`update failed product=${row.id}: ${updateErr.message}`);
    if ((updated ?? []).length === 1) stamped++;
  }

  console.log(
    `\n  ${APPLY ? "stamped" : "would-stamp"}=${APPLY ? stamped : targets.length}`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
