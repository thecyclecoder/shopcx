/**
 * Loyalty points backfill — credit the points owed since 2026-03-30 cutover.
 *
 * Consumes /tmp/loyalty-backfill-manifest.json (written by the audit script).
 * For each member entry:
 *   1. Set `needs_points_backfill = true` (visibility, in case of partial run).
 *   2. For each owed order_id, look up the order, compute the same qualifying
 *      formula the audit used, and call `earnPoints` with the order's UUID
 *      as the order_id link. Skip orders that already have an earning txn.
 *   3. Clear `needs_points_backfill = false` once all of the member's owed
 *      orders are credited (or already had transactions).
 *
 * Usage:
 *   npx tsx scripts/loyalty-credit-backfill.ts             # dry run
 *   npx tsx scripts/loyalty-credit-backfill.ts --apply     # write
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const APPLY = process.argv.includes("--apply");
const MANIFEST_PATH = "/tmp/loyalty-backfill-manifest.json";

type ManifestEntry = {
  member_id: string;
  customer_id: string;
  email: string | null;
  order_ids: string[];
  total_points_to_credit: number;
};

type LoyaltyMember = {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_customer_id: string;
  email: string;
  points_balance: number;
  points_earned: number;
  points_spent: number;
  source: string;
  created_at: string;
  updated_at: string;
};

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { earnPoints, getLoyaltySettings, calculateEarningPoints } = await import("../src/lib/loyalty");
  const admin = createAdminClient();

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Manifest not found at ${MANIFEST_PATH}. Run loyalty-audit-since-cutover.ts --apply first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    workspace_id: string;
    cutover: string;
    generated_at: string;
    entries: ManifestEntry[];
  };
  const workspaceId = manifest.workspace_id;
  console.log(`[credit] workspace ${workspaceId} · mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`[credit] manifest: ${manifest.entries.length} members owed (generated ${manifest.generated_at})`);

  const settings = await getLoyaltySettings(workspaceId);

  // Phase 1: mark all members in the manifest as needs_points_backfill=true
  // (so a partial run remains visible if we crash mid-flight).
  if (APPLY) {
    console.log("[1] marking needs_points_backfill=true on all manifest members …");
    const memberIds = manifest.entries.map((e) => e.member_id);
    const CHUNK = 100;
    for (let i = 0; i < memberIds.length; i += CHUNK) {
      const chunk = memberIds.slice(i, i + CHUNK);
      const { error } = await admin
        .from("loyalty_members")
        .update({ needs_points_backfill: true, updated_at: new Date().toISOString() })
        .in("id", chunk);
      if (error) console.error("  flag err:", error.message);
    }
  }

  // Phase 2: per-member, credit each owed order. We re-fetch the order rows
  // (in bulk per member) to recompute the same qualifying formula, and the
  // current set of earning order_ids on the member, so a re-run is idempotent.
  let totalCredited = 0;
  let totalOrdersCredited = 0;
  let totalMembersDone = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const startedAt = Date.now();

  for (const [idx, entry] of manifest.entries.entries()) {
    if (idx > 0 && idx % 100 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`  …processed ${idx}/${manifest.entries.length} members (${elapsed}s elapsed)`);
    }

    // Fetch member's current state
    const { data: memRow } = await admin
      .from("loyalty_members")
      .select("*")
      .eq("id", entry.member_id)
      .maybeSingle();
    if (!memRow) {
      console.error(`  ! member ${entry.member_id.slice(0, 8)} not found — skipping`);
      totalErrors++;
      continue;
    }
    const member = memRow as LoyaltyMember;

    // Find orders that already have an earning txn for this member.
    const { data: existingTxns } = await admin
      .from("loyalty_transactions")
      .select("order_id")
      .eq("member_id", entry.member_id)
      .eq("type", "earning")
      .not("order_id", "is", null);
    const alreadyEarned = new Set((existingTxns || []).map((t) => t.order_id));

    const ordersToFetch = entry.order_ids.filter((id) => !alreadyEarned.has(id));
    if (ordersToFetch.length === 0) {
      // Nothing to do — clear flag & move on.
      if (APPLY) {
        await admin.from("loyalty_members")
          .update({ needs_points_backfill: false, updated_at: new Date().toISOString() })
          .eq("id", entry.member_id);
      }
      totalMembersDone++;
      continue;
    }

    // Fetch the order rows (chunked to stay under URL limits)
    const orders: Array<{ id: string; order_number: string | null; total_cents: number | null; line_items: unknown }> = [];
    const CHUNK = 100;
    for (let i = 0; i < ordersToFetch.length; i += CHUNK) {
      const chunk = ordersToFetch.slice(i, i + CHUNK);
      const { data } = await admin
        .from("orders")
        .select("id, order_number, total_cents, line_items")
        .in("id", chunk);
      if (data) orders.push(...data);
    }

    for (const o of orders) {
      const items = (o.line_items as Array<{ sku?: string; quantity?: number; price_cents?: number }>) || [];
      const productSubtotalCents = items
        .filter((i) => i.sku !== "Insure01")
        .reduce((s, i) => s + (i.price_cents || 0) * (i.quantity || 1), 0);
      const qualifyingCents = Math.min(productSubtotalCents, o.total_cents || 0);
      const points = calculateEarningPoints(
        qualifyingCents / 100,
        { tax: 0, discounts: 0, shipping: 0, shippingProtection: 0 },
        settings,
      );
      if (points <= 0) {
        totalSkipped++;
        continue;
      }
      if (APPLY) {
        try {
          await earnPoints(member, points, o.id, `Backfill: order ${o.order_number}`);
          totalCredited += points;
          totalOrdersCredited++;
        } catch (e) {
          console.error(`  ! earn err member=${entry.member_id.slice(0, 8)} order=${o.id.slice(0, 8)}:`, (e as Error).message);
          totalErrors++;
        }
      } else {
        totalCredited += points;
        totalOrdersCredited++;
      }
    }

    if (APPLY) {
      // Clear the flag — this member's owed orders have been processed.
      await admin.from("loyalty_members")
        .update({ needs_points_backfill: false, updated_at: new Date().toISOString() })
        .eq("id", entry.member_id);
    }
    totalMembersDone++;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log("\n=== SUMMARY ===");
  console.log(`  members processed:    ${totalMembersDone} / ${manifest.entries.length}`);
  console.log(`  orders credited:      ${totalOrdersCredited}`);
  console.log(`  zero-point skips:     ${totalSkipped}`);
  console.log(`  errors:               ${totalErrors}`);
  console.log(`  total points:         ${totalCredited.toLocaleString()} (~$${(totalCredited / 100).toFixed(2)} in redemption value)`);
  console.log(`  elapsed:              ${elapsed}s`);
  if (!APPLY) console.log("\n  (dry run — pass --apply to credit)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
