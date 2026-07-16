/**
 * _measure-test-purchaser-overlap — the analytical measurement that Phase 3 of
 * [[docs/brain/specs/orders-classification-sdk]] refactored onto the SDK.
 *
 * Question it answers: for a UTM-campaign-attributed set of "test purchasers"
 * (the checkouts our test ad drove, in a bounded time window), how much
 * overlap is there with our EXISTING purchaser base — i.e. how many of them
 * had ever bought before (renewals counted, per the accepted first-vs-repeat
 * convention)? A HIGH overlap says the ad is preaching to the choir; a LOW
 * overlap says it is genuinely acquiring.
 *
 * BEFORE this refactor the script hand-rolled the canonical renewal /
 * subscription classifier + an earliest-order-per-customer sweep — the exact
 * wheel-reinvention that motivated building the SDK. It now consumes
 * [[../src/lib/orders-classification]] `queryOrders` / `classifyOrder`
 * directly. The UTM → campaign attribution join stays in this script (out of
 * the SDK's scope).
 *
 * READ-ONLY — no `.update()` / `.insert()` / `.delete()` anywhere.
 *
 * Run:
 *   npx tsx scripts/_measure-test-purchaser-overlap.ts \
 *     --workspace <ws-uuid> --campaign <utm_campaign> [--lastDays 30]
 *
 * Follows the script-conventions skill: bootstrap via `./_bootstrap`,
 * `_`-prefix, no writes, single-file, no external deps beyond the SDK.
 */
import { createAdminClient } from "./_bootstrap";
import {
  queryOrders,
  classifyOrder,
  type OrderRow,
} from "../src/lib/orders-classification";

interface Args {
  workspaceId: string;
  campaign: string;
  lastDays: number;
}

function parseArgs(argv: string[]): Args {
  let workspaceId = "";
  let campaign = "";
  let lastDays = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" && argv[i + 1]) workspaceId = argv[++i];
    else if (a === "--campaign" && argv[i + 1]) campaign = argv[++i];
    else if (a === "--lastDays" && argv[i + 1]) lastDays = Number(argv[++i]);
  }
  if (!workspaceId || !campaign) {
    console.error(
      "Usage: npx tsx scripts/_measure-test-purchaser-overlap.ts --workspace <uuid> --campaign <utm_campaign> [--lastDays 30]",
    );
    process.exit(2);
  }
  if (!Number.isFinite(lastDays) || lastDays <= 0) {
    console.error(`--lastDays must be a positive number, got ${lastDays}`);
    process.exit(2);
  }
  return { workspaceId, campaign, lastDays };
}

async function main(): Promise<void> {
  const { workspaceId, campaign, lastDays } = parseArgs(process.argv.slice(2));
  const admin = createAdminClient();

  // ── SDK-owned: pull every CHECKOUT in the window, classified. queryOrders
  //    resolves first-vs-repeat (renewals counted) so this script does NOT
  //    re-derive earliest-order-per-customer or the renewal predicate.
  const checkouts: OrderRow[] = await queryOrders(
    workspaceId,
    { origin: "checkout", lastDays },
    { admin },
  );

  // ── Script-owned: UTM → campaign attribution join. queryOrders selects the
  //    minimal facet set (id + classification columns) so we do the
  //    attribution read here rather than bloat the SDK's column list. We
  //    scope to the same time window + the same set of order ids so the two
  //    reads describe the same population.
  const orderIds = checkouts.map((r) => r.id);
  const attributedIds = new Set<string>();
  if (orderIds.length > 0) {
    const chunkSize = 500; // PostgREST `.in()` prefers small chunks
    for (let i = 0; i < orderIds.length; i += chunkSize) {
      const slice = orderIds.slice(i, i + chunkSize);
      const { data, error } = await admin
        .from("orders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("attributed_utm_campaign", campaign)
        .in("id", slice);
      if (error) throw error;
      for (const row of (data ?? []) as { id: string }[]) attributedIds.add(row.id);
    }
  }

  const testCheckouts = checkouts.filter((r) => attributedIds.has(r.id));

  // ── Roll up on customerRecency — the whole point of the measurement. ──
  //    The recency verdict comes straight from the SDK's classification; we
  //    only count.
  let firstTime = 0;
  let repeat = 0;
  let unknown = 0; // no customer_id on the row (rare — orphan / draft)
  for (const row of testCheckouts) {
    const recency = row.classification.customerRecency;
    if (recency === "first_time") firstTime++;
    else if (recency === "repeat") repeat++;
    else unknown++;
  }

  const total = testCheckouts.length;
  const overlapPct = total > 0 ? Math.round((repeat / total) * 100) : 0;

  console.log("── Test-purchaser overlap ──");
  console.log(`workspace     : ${workspaceId}`);
  console.log(`campaign      : ${campaign}`);
  console.log(`window        : last ${lastDays} days`);
  console.log(`total checkouts (window)      : ${checkouts.length}`);
  console.log(`campaign-attributed checkouts : ${total}`);
  console.log(`  first_time (acquisition)    : ${firstTime}`);
  console.log(`  repeat (existing purchaser) : ${repeat}`);
  if (unknown > 0) console.log(`  unknown (no customer_id)    : ${unknown}`);
  console.log(`OVERLAP with existing base    : ${overlapPct}%`);

  // Also print a quick sanity check: classifyOrder agrees with the row's
  // classification field (rules out any drift between the pure classifier and
  // queryOrders' output).
  const drift = testCheckouts.filter(
    (r) => classifyOrder(r).origin !== r.classification.origin,
  );
  if (drift.length > 0) {
    console.warn(`⚠ ${drift.length} row(s) had classifyOrder/queryOrders origin drift`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("_measure-test-purchaser-overlap failed:", err);
  process.exit(1);
});
