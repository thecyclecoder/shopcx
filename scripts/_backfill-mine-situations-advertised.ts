/**
 * Ship-time initial run of the situation miner across the advertised lineup
 * (docs/brain/specs/customer-situations-all-products.md Phase 2). Enqueues ONE `situation-mine` box
 * job per `products.is_advertised = true` product in every workspace that has advertised products,
 * so the AI shopping agent can recommend each hero SKU by a shopper's situation — not just the
 * hand-seeded Superfood Tabs. Today's lineup: Amazing Coffee, Creatine Prime+, Amazing Coffee
 * K-Cups, Amazing Creamer, Ashwavana Guru Focus, Ashwavana Zen Relax.
 *
 * Idempotent via `enqueueSituationMine` (src/lib/situation-miner.ts): a product with a queued/running
 * situation-mine job, or whose situations were mined in the last 7 days, is SKIPPED — so re-running
 * (or an overlap with the monthly refresh cron) never doubles the box spend. The deterministic
 * applySituationMine on the box is the only writer; this script only queues work.
 *
 * Tracked ship-time backfill (CLAUDE.md § Ship-time backfill-must-be-tracked): the `_backfill-*.ts`
 * name auto-ledgers a pending data_op_runs row on the post-merge hook; the box executor drains it.
 *
 * Dry-run by default; pass --apply to enqueue.
 * Run: npx tsx scripts/_backfill-mine-situations-advertised.ts [--apply]
 */
import { createAdminClient } from "./_bootstrap";
import {
  enqueueSituationMineForAdvertised,
  workspacesWithAdvertisedProducts,
  listAdvertisedPreview,
} from "../src/lib/situation-miner";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const workspaceIds = await workspacesWithAdvertisedProducts(admin);
  if (workspaceIds.length === 0) {
    console.log("No workspaces with advertised products — nothing to enqueue.");
    return;
  }
  console.log(`Workspaces with advertised products: ${workspaceIds.length}`);

  if (!APPLY) {
    console.log("\nDRY RUN — no jobs enqueued. Re-run with --apply to queue the miner.");
    for (const ws of workspaceIds) {
      const preview = await listAdvertisedPreview(admin, ws);
      console.log(`  workspace ${ws}: ${preview.length} advertised product(s)`);
      for (const p of preview) console.log(`    - ${p.title} (${p.id})`);
    }
    return;
  }

  let totalEnqueued = 0;
  let totalInflight = 0;
  let totalFresh = 0;
  let totalProducts = 0;
  for (const ws of workspaceIds) {
    const sweep = await enqueueSituationMineForAdvertised(admin, ws);
    totalProducts += sweep.products;
    totalEnqueued += sweep.enqueued;
    totalInflight += sweep.skippedInflight;
    totalFresh += sweep.skippedFresh;
    console.log(
      `  workspace ${ws}: products=${sweep.products} enqueued=${sweep.enqueued} ` +
        `skipped(inflight)=${sweep.skippedInflight} skipped(fresh<7d)=${sweep.skippedFresh}`,
    );
  }
  console.log(
    `\n✓ Enqueued ${totalEnqueued} situation-mine job(s) across ${totalProducts} advertised product(s) ` +
      `(skipped ${totalInflight} inflight, ${totalFresh} mined<7d).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
