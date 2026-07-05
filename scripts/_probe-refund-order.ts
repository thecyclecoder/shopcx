// Dry-run probe for the Phase 2 gateway-aware refundOrder wrapper.
//
// Answers the Phase 2 verification bullet:
//   - Shopify-paid canary order → method resolves to "shopify",
//     no Braintree call fires.
//   - Internal Braintree-paid canary order → method resolves to
//     "braintree", no Shopify GraphQL call fires.
//
// Implemented via the read-only `resolveRefundMethod` helper exported
// from `src/lib/refund.ts` — it mirrors refundOrder's branch rule but
// makes ZERO external API calls. That is the "strict dry-run" mode
// referenced in the spec: the probe only ever reads from `orders`.
//
// Usage:
//   npx tsx scripts/_probe-refund-order.ts <workspaceId> <orderId>
//   npx tsx scripts/_probe-refund-order.ts <workspaceId> --sample
//     (probe one shopify-paid + one braintree-paid canary picked from
//      the workspace's most recent orders)
//
// Read-only — verify with `probe-db` skill conventions.

import { createAdminClient } from "./_bootstrap";
import { resolveRefundMethod, type RefundMethodProbe } from "../src/lib/refund";

function printProbe(label: string, probe: RefundMethodProbe): void {
  console.log(`── ${label} ──`);
  console.log(`  method:                 ${probe.method ?? "(unresolved)"}`);
  console.log(`  reason:                 ${probe.reason}`);
  if (probe.order_id) console.log(`  order_id:               ${probe.order_id}`);
  if ("shopify_order_id" in probe) console.log(`  shopify_order_id:       ${probe.shopify_order_id ?? "(null)"}`);
  if ("braintree_transaction_id" in probe) {
    console.log(`  braintree_transaction:  ${probe.braintree_transaction_id ?? "(null)"}`);
  }
  console.log("");
}

async function probeOne(workspaceId: string, orderId: string): Promise<void> {
  const probe = await resolveRefundMethod(workspaceId, orderId);
  printProbe(orderId, probe);
}

async function probeSample(workspaceId: string): Promise<void> {
  const admin = createAdminClient();

  // A "Shopify-paid canary" — has shopify_order_id, doesn't matter
  // whether braintree_transaction_id is also set.
  const { data: shopifyCanary } = await admin
    .from("orders")
    .select("id, order_number")
    .eq("workspace_id", workspaceId)
    .not("shopify_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  // An "internal Braintree-paid canary" — no shopify_order_id, has
  // braintree_transaction_id (SHOPCX*).
  const { data: braintreeCanary } = await admin
    .from("orders")
    .select("id, order_number")
    .eq("workspace_id", workspaceId)
    .is("shopify_order_id", null)
    .not("braintree_transaction_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  let expectShopify: "shopify" | undefined;
  let expectBraintree: "braintree" | undefined;

  if (shopifyCanary?.[0]) {
    const probe = await resolveRefundMethod(workspaceId, shopifyCanary[0].id);
    printProbe(`Shopify-paid canary (${shopifyCanary[0].order_number ?? shopifyCanary[0].id})`, probe);
    if (probe.method === "shopify") expectShopify = "shopify";
  } else {
    console.log("── Shopify-paid canary ──\n  (no shopify-paid orders found in workspace)\n");
  }

  if (braintreeCanary?.[0]) {
    const probe = await resolveRefundMethod(workspaceId, braintreeCanary[0].id);
    printProbe(`Braintree-paid canary (${braintreeCanary[0].order_number ?? braintreeCanary[0].id})`, probe);
    if (probe.method === "braintree") expectBraintree = "braintree";
  } else {
    console.log("── Braintree-paid canary ──\n  (no internal Braintree-paid orders found in workspace)\n");
  }

  if (expectShopify && expectBraintree) {
    console.log("✓ Both canaries routed to the expected gateway. No external refund call was made.");
    process.exit(0);
  }
  if (!shopifyCanary?.[0] && !braintreeCanary?.[0]) {
    console.error("✗ Neither canary could be sampled from this workspace.");
    process.exit(1);
  }
  console.error("✗ One or more canaries did not route as expected.");
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , workspaceId, arg2] = process.argv;
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/_probe-refund-order.ts <workspaceId> <orderId>|--sample");
    process.exit(1);
  }
  if (!arg2) {
    console.error("usage: npx tsx scripts/_probe-refund-order.ts <workspaceId> <orderId>|--sample");
    process.exit(1);
  }
  if (arg2 === "--sample") {
    await probeSample(workspaceId);
    return;
  }
  await probeOne(workspaceId, arg2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
