/**
 * Re-link renewal orders that the old SKU fallback pinned to the WRONG sibling subscription.
 *
 * The order webhook's fallback took the first sub sharing ANY SKU, and Shipping Protection's SKU is
 * on most subs, so a customer with two subs could get a renewal attributed to the wrong one
 * (2026-11-20 SC142618, 2026-11-12 SC142137). The sub that really renewed then read as a month
 * late and lost the order from its history. The webhook now ranks via
 * `chooseSubscriptionForRenewalOrder` ([[../docs/brain/libraries/subscription-order-link]]).
 *
 * Evidence is the renewal worker's `subscription_cycle_charges` claim, not SKUs: a customer can edit
 * a sub's items after the order (SC141431 / SHOPCX495), so a SKU re-check can point at the wrong
 * sibling. For every subscription-sourced order since 2026-09-01 that is already linked, the link
 * moves ONLY when exactly one sibling sub claimed a cycle within RENEWAL_CLAIM_WINDOW_MS of the order
 * and it is not the current link (`pickSubscriptionByCycleClaim`). Appstle-billed renewals have no
 * claims and are never touched.
 * Idempotent: a second run finds nothing to move. Dry-run by default; `--apply` to write.
 *
 *   npx tsx scripts/_backfill-renewal-order-sub-links.ts            # dry-run
 *   npx tsx scripts/_backfill-renewal-order-sub-links.ts --apply    # write
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { pickSubscriptionByCycleClaim, RENEWAL_CLAIM_WINDOW_MS } from "../src/lib/subscription-order-link";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const SINCE = "2026-09-01T00:00:00Z";

type Sub = { id: string; items: unknown; shopify_customer_id: string | null };

async function main() {
  const admin = createAdminClient();
  const totals = { scanned: 0, moved: 0, unchanged: 0 };
  let after = "";
  for (;;) {
    let q = admin
      .from("orders")
      .select("id, workspace_id, order_number, shopify_customer_id, subscription_id, source_name, created_at")
      .ilike("source_name", "%subscription%")
      .not("subscription_id", "is", null)
      .not("shopify_customer_id", "is", null)
      .gte("created_at", SINCE)
      .order("id")
      .limit(500);
    if (after) q = q.gt("id", after);
    const { data: page, error } = await q;
    if (error) throw new Error(error.message);
    if (!page?.length) break;
    for (const o of page) {
      totals.scanned++;
      const { data: subs } = await admin
        .from("subscriptions")
        .select("id, items, shopify_customer_id")
        .eq("workspace_id", o.workspace_id)
        .eq("shopify_customer_id", o.shopify_customer_id)
        .in("status", ["active", "paused"]);
      const list = (subs ?? []) as Sub[];
      if (list.length < 2) { totals.unchanged++; continue; }
      const t = Date.parse(o.created_at as string);
      const { data: claims } = await admin
        .from("subscription_cycle_charges")
        .select("subscription_id, claimed_at")
        .eq("workspace_id", o.workspace_id)
        .in("subscription_id", list.map((x) => x.id))
        .gte("claimed_at", new Date(t - RENEWAL_CLAIM_WINDOW_MS).toISOString())
        .lte("claimed_at", new Date(t + RENEWAL_CLAIM_WINDOW_MS).toISOString());
      const pickId = pickSubscriptionByCycleClaim(
        (claims ?? []) as { subscription_id: string; claimed_at: string }[],
        o.created_at as string,
      );
      if (!pickId || pickId === o.subscription_id) { totals.unchanged++; continue; }
      const pick = { id: pickId };
      console.log(`  ${APPLY ? "→" : "·"} ${o.order_number} ${o.subscription_id} → ${pick.id}`);
      if (APPLY) {
        const { error: upErr } = await admin
          .from("orders")
          .update({ subscription_id: pick.id })
          .eq("id", o.id)
          .eq("subscription_id", o.subscription_id as string); // compare-and-set
        if (upErr) throw new Error(upErr.message);
      }
      totals.moved++;
    }
    if (page.length < 500) break;
    after = page[page.length - 1].id as string;
  }
  console.log(`\nscanned ${totals.scanned} · ${APPLY ? "moved" : "would move"} ${totals.moved} · unchanged ${totals.unchanged}`);
  console.log(`Done${APPLY ? " (applied)" : " (dry-run — pass --apply to write)"}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
