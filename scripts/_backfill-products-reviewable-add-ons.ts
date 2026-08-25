/**
 * One-shot backfill: flip `products.reviewable = false` on the SKUs that are
 * add-ons the customer did not choose to buy on merit — the four Shipping
 * Protection products (`product_type='ShopWill'` OR `handle='shipping-insurance'`),
 * the internal `Mystery Item` SKU, and the three `(Free Gift)` duplicates
 * listed in `SHOPIFY_PRODUCT_ALIASES` (src/lib/shopify-review-metafields.ts).
 * The review-collection journey never asks about them.
 *
 * Why: `products.reviewable` ships with `default true` (Phase 1 migration
 * 20261215120000_review_collection_foundations.sql) — safe for the ~200 real
 * SKUs and correct on the growing product catalog going forward. But the ~8
 * pre-existing add-on rows need `false` stamped explicitly, or the review
 * journey would happily ask "how did you like the Shipping Protection?".
 *
 * Uses raw `pg` (via _bootstrap `pgClient`) instead of the Supabase REST
 * client, because THIS backfill runs immediately after the column-adding
 * migration and PostgREST's schema cache lags — a `.eq('reviewable', ...)`
 * predicate through PostgREST can 400 with "column not found" for ~30 seconds
 * post-migration. Raw SQL bypasses the cache entirely. The update is one
 * atomic statement whose WHERE clause is the idempotency guard (`reviewable =
 * true` — never overwrites a hand-flipped `false` row).
 *
 * FREE_GIFT_SHOPIFY_IDS is inlined rather than imported from
 * shopify-review-metafields.ts so this backfill has no dependency on that
 * module's Shopify + crypto imports (a fresh env without those secrets should
 * still be able to run the backfill).
 *
 * Idempotent — re-running after a successful pass finds zero matches (the
 * `reviewable = true` predicate) and exits clean. Auto-ledgered by the
 * post-merge [[../src/lib/ship-time-backfill-detector]] (the
 * `scripts/_backfill-*.ts` filename convention triggers the pending
 * `data_op_runs` row + CEO card) and drained on the box by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1`
 * also works.
 *
 *   npx tsx scripts/_backfill-products-reviewable-add-ons.ts            # dry-run
 *   npx tsx scripts/_backfill-products-reviewable-add-ons.ts --apply    # write
 *
 * Spec: docs/brain/specs/review-collection-foundations.md Phase 1.
 */
import { pgClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

// The three `(Free Gift)` Shopify product ids that mirror a canonical SKU —
// keys of SHOPIFY_PRODUCT_ALIASES in src/lib/shopify-review-metafields.ts.
// Inlined here so this backfill does not import the shopify metafields module.
const FREE_GIFT_SHOPIFY_IDS = [
  "7902173069485", // Bamboo Coffee Mug (Free Gift)
  "7902148624557", // Handheld Mixer (Free Gift)
  "7902086725805", // Superfoods Tumbler (Free Gift)
];

const MATCH_WHERE = `(
    lower(coalesce(product_type, '')) = 'shopwill'
    OR lower(coalesce(handle, ''))    = 'shipping-insurance'
    OR lower(coalesce(title, ''))     = 'mystery item'
    OR shopify_product_id = ANY($1::text[])
  )`;

(async () => {
  const client = pgClient();
  await client.connect();
  console.log(`backfill_products_reviewable_add_ons — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  reviewable=false on Shipping Protection, Mystery Item, and (Free Gift) duplicates\n`);
  try {
    // Preview: rows that WOULD flip. reviewable=true is the compare-and-set
    // predicate — a re-run after a successful apply produces zero rows.
    const previewSql = `
      SELECT id, workspace_id, title, handle, product_type, shopify_product_id
      FROM public.products
      WHERE reviewable = true
        AND ${MATCH_WHERE}
      ORDER BY id`;
    const preview = await client.query(previewSql, [FREE_GIFT_SHOPIFY_IDS]);
    console.log(`  candidates=${preview.rowCount ?? 0}`);
    for (const r of preview.rows) {
      let reason: string;
      const t = String(r.product_type || "").toLowerCase();
      const h = String(r.handle || "").toLowerCase();
      const ti = String(r.title || "").toLowerCase();
      if (t === "shopwill") reason = "product_type=ShopWill (Shipping Protection)";
      else if (h === "shipping-insurance") reason = "handle=shipping-insurance (Shipping Protection)";
      else if (ti === "mystery item") reason = "title=Mystery Item (internal SKU)";
      else reason = `shopify_product_id=${r.shopify_product_id} ((Free Gift) duplicate)`;
      console.log(
        `  ${APPLY ? "would-flip" : "would-flip"}  product=${r.id} title=${JSON.stringify(r.title)} — ${reason}`,
      );
    }

    if (!APPLY) {
      console.log(`\n  dry-run — no writes. Pass --apply to write.`);
      return;
    }

    const updateSql = `
      UPDATE public.products
      SET reviewable = false
      WHERE reviewable = true
        AND ${MATCH_WHERE}
      RETURNING id`;
    const updated = await client.query(updateSql, [FREE_GIFT_SHOPIFY_IDS]);
    console.log(`\n  stamped=${updated.rowCount ?? 0}`);
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
