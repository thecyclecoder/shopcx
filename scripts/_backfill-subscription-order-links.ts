/**
 * Backfill `orders.subscription_id` for subscription FIRST orders that were
 * never linked.
 *
 * Ships with the widened gate in src/lib/shopify-webhooks.ts + the authoritative
 * linkage in the Appstle webhook. Those only fix orders from here forward; this
 * repairs the ~1,000 orders stranded since the last manual subscription import
 * (March 2026). See src/lib/subscription-order-link.ts for the full write-up.
 *
 * ORDER-DRIVEN on purpose. The March 2026 subscription migration created ~27,786
 * `subscriptions` rows whose orders that same import already linked, so walking
 * subscriptions scans 28K rows to fix ~1K. Starting from the unlinked orders and
 * fanning out to just those customers' subscriptions is ~25x less work and
 * targets exactly the broken set.
 *
 * Idempotent by construction — reuses `linkOriginatingOrder`, whose candidate
 * query is `.is("subscription_id", null)` and whose UPDATE carries the same
 * compare-and-set, so a re-run can never move an existing link.
 *
 *   npx tsx scripts/_backfill-subscription-order-links.ts            # dry run
 *   npx tsx scripts/_backfill-subscription-order-links.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import {
  chooseOrderForSubscription,
  isFirstSubscriptionOrder,
  LINK_LOOKAHEAD_MS,
  LINK_LOOKBACK_MS,
  linkOriginatingOrder,
  type LinkCandidateOrder,
} from "../src/lib/subscription-order-link";

const APPLY = process.argv.includes("--apply");
const SINCE = process.env.SINCE ?? "2026-03-01";

interface OrderRow {
  id: string; workspace_id: string; shopify_customer_id: string | null;
  created_at: string; tags: string | string[] | null; source_name: string | null;
}
interface SubRow {
  id: string; workspace_id: string; shopify_customer_id: string | null;
  items: unknown; subscription_created_at: string | null; created_at: string;
}

async function main() {
  const admin = createAdminClient();

  // 1. Unlinked orders that look like a subscription's first order.
  const orders: OrderRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin
      .from("orders")
      .select("id,workspace_id,shopify_customer_id,created_at,tags,source_name")
      .is("subscription_id", null)
      .gte("created_at", `${SINCE}T00:00:00Z`)
      .order("created_at", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`orders: ${error.message}`);
    orders.push(...((data ?? []) as unknown as OrderRow[]));
    if (!data || data.length < 1000) break;
  }
  const targets = orders.filter(isFirstSubscriptionOrder).filter((o) => o.shopify_customer_id);
  console.log(`unlinked orders since ${SINCE}: ${orders.length}`);
  console.log(`  of which look like a subscription first order: ${targets.length}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN (pass --apply to write)\n");
  if (!targets.length) return;

  // 2. Their customers' subscriptions only.
  const byWorkspace = new Map<string, Set<string>>();
  for (const o of targets) {
    const set = byWorkspace.get(o.workspace_id) ?? new Set<string>();
    set.add(String(o.shopify_customer_id));
    byWorkspace.set(o.workspace_id, set);
  }
  const subs: SubRow[] = [];
  for (const [wsId, custSet] of byWorkspace) {
    const custIds = [...custSet];
    for (let i = 0; i < custIds.length; i += 200) {
      const { data, error } = await admin
        .from("subscriptions")
        .select("id,workspace_id,shopify_customer_id,items,subscription_created_at,created_at")
        .eq("workspace_id", wsId)
        .in("shopify_customer_id", custIds.slice(i, i + 200));
      if (error) throw new Error(`subscriptions: ${error.message}`);
      subs.push(...((data ?? []) as unknown as SubRow[]));
    }
  }
  console.log(`candidate subscriptions for those customers: ${subs.length}\n`);

  // 3. Link, oldest subscription first so an earlier sub claims its own order.
  subs.sort((a, b) =>
    Date.parse(a.subscription_created_at ?? a.created_at) - Date.parse(b.subscription_created_at ?? b.created_at));

  const tally: Record<string, number> = {};
  let linked = 0;
  let processed = 0;
  for (const sub of subs) {
    processed++;
    const anchorIso = sub.subscription_created_at ?? sub.created_at;
    if (APPLY) {
      const res = await linkOriginatingOrder(admin, {
        workspaceId: sub.workspace_id,
        subscriptionId: sub.id,
        shopifyCustomerId: sub.shopify_customer_id,
        subItems: (Array.isArray(sub.items) ? sub.items : []) as Array<{ sku?: string | null }>,
        anchorIso,
      });
      tally[res.reason] = (tally[res.reason] ?? 0) + 1;
      if (res.linked) linked++;
    } else {
      const anchorMs = Date.parse(anchorIso);
      const { data, error } = await admin
        .from("orders")
        .select("id,created_at,tags,source_name,line_items")
        .eq("workspace_id", sub.workspace_id)
        .eq("shopify_customer_id", String(sub.shopify_customer_id))
        .is("subscription_id", null)
        .gte("created_at", new Date(anchorMs - LINK_LOOKBACK_MS).toISOString())
        .lte("created_at", new Date(anchorMs + LINK_LOOKAHEAD_MS).toISOString())
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) throw new Error(`orders: ${error.message}`);
      const choice = chooseOrderForSubscription(
        (data ?? []) as LinkCandidateOrder[],
        (Array.isArray(sub.items) ? sub.items : []) as Array<{ sku?: string | null }>,
      );
      tally[choice.reason] = (tally[choice.reason] ?? 0) + 1;
      if (choice.linked) linked++;
    }
    if (processed % 250 === 0) console.log(`  …${processed}/${subs.length}, ${linked} linked`);
  }

  console.log(`\n${APPLY ? "LINKED" : "WOULD LINK"}: ${linked} order(s)`);
  console.log("outcomes:", JSON.stringify(tally, null, 1));
  if (!APPLY) console.log("\nRe-run with --apply to write.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
