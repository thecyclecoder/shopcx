// Regression probe for the Phase-3 refund dispatcher.
//
// Answers two Phase-4 verification bullets against a real workspace:
//
//   (a) Cohort routing. Sample N Shopify-paid + N Braintree-paid
//       orders. Call `refundOrder(..., amountCents: 0, { dryRun: true })`
//       on each and assert the resolved `method` matches the order's
//       gateway. dryRun makes ZERO external SDK calls, mutates
//       nothing, and skips the amount-positive check — the probe is
//       strictly a branch-resolution test.
//
//   (b) Double-refund guard preservation. Look at recent
//       `customer_events` rows where event_type = 'order.refunded'
//       (source: this dispatcher). For each event whose order has a
//       matching `returns` row, assert that `returns.refunded_at IS
//       NOT NULL` — proof that the refundOrder success path stamped
//       the return so a subsequent `refund_return` can't double-pay
//       (docs/brain/operational-rules.md § Returns; the SC132396
//       Sonia Stevens precedent noted in
//       docs/brain/lifecycles/return-pipeline.md § Phase 4).
//
// Usage:
//   npx tsx scripts/_verify-refund-dispatcher.ts <workspaceId> [--samples=N] [--guard-days=N] [--verbose]
//
// Exit codes:
//   0 → all cohorts routed to the expected gateway AND every stamped
//       return carries refunded_at IS NOT NULL. If no
//       `order.refunded` events yet exist (a freshly-shipped
//       dispatcher), the guard section is skipped with a warning
//       instead of failing — routing is still asserted.
//   1 → routing mismatch OR at least one order.refunded event's
//       matching return is missing refunded_at.
//
// Read-only. No SDK writes. dryRun on refundOrder is the load-bearing
// guarantee that no cohort probe fires a real refund.

import { createAdminClient } from "./_bootstrap";
import { refundOrder } from "../src/lib/refund";

function parseArgs(): { workspaceId: string; samples: number; guardDays: number; verbose: boolean } {
  const [, , workspaceId, ...rest] = process.argv;
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/_verify-refund-dispatcher.ts <workspaceId> [--samples=N] [--guard-days=N] [--verbose]");
    process.exit(1);
  }
  let samples = 5;
  let guardDays = 30;
  let verbose = false;
  for (const arg of rest) {
    if (arg.startsWith("--samples=")) samples = parseInt(arg.slice("--samples=".length), 10) || samples;
    else if (arg.startsWith("--guard-days=")) guardDays = parseInt(arg.slice("--guard-days=".length), 10) || guardDays;
    else if (arg === "--verbose") verbose = true;
  }
  return { workspaceId, samples, guardDays, verbose };
}

type OrderRow = { id: string; order_number: string | null; shopify_order_id: string | null; braintree_transaction_id: string | null };

async function main(): Promise<void> {
  const { workspaceId, samples, guardDays, verbose } = parseArgs();
  const admin = createAdminClient();
  console.log(`Verifying refund dispatcher for workspace ${workspaceId} — samples=${samples}, guard-days=${guardDays}\n`);

  // ── Cohort A — Shopify-paid canaries ──
  const { data: shopifyCohort, error: shopifyErr } = await admin
    .from("orders")
    .select("id, order_number, shopify_order_id, braintree_transaction_id")
    .eq("workspace_id", workspaceId)
    .not("shopify_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(samples);
  if (shopifyErr) throw new Error(`shopify cohort query failed: ${shopifyErr.message}`);

  // ── Cohort B — Internal (SHOPCX*) Braintree-paid canaries ──
  const { data: braintreeCohort, error: braintreeErr } = await admin
    .from("orders")
    .select("id, order_number, shopify_order_id, braintree_transaction_id")
    .eq("workspace_id", workspaceId)
    .is("shopify_order_id", null)
    .not("braintree_transaction_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(samples);
  if (braintreeErr) throw new Error(`braintree cohort query failed: ${braintreeErr.message}`);

  let failures = 0;

  async function probeCohort(label: "shopify" | "braintree", cohort: OrderRow[]): Promise<void> {
    console.log(`── Cohort: ${label} (${cohort.length} order${cohort.length === 1 ? "" : "s"}) ──`);
    if (!cohort.length) {
      console.log(`  (no ${label}-paid orders sampled — skipping cohort)\n`);
      return;
    }
    for (const order of cohort) {
      const r = await refundOrder(workspaceId, order.id, 0, "dispatcher-verify probe", { dryRun: true, source: "verify" });
      const orderRef = order.order_number || order.id;
      if (!r.success) {
        console.log(`  ✗ ${orderRef} — refundOrder(dryRun) failed: ${r.error}`);
        failures++;
        continue;
      }
      if (r.method !== label) {
        console.log(`  ✗ ${orderRef} — resolved method='${r.method}', expected '${label}'`);
        failures++;
        continue;
      }
      if (verbose) console.log(`  ✓ ${orderRef} — method=${r.method}`);
    }
    if (!verbose) console.log(`  ✓ ${cohort.length} order${cohort.length === 1 ? "" : "s"} routed to '${label}'`);
    console.log("");
  }

  await probeCohort("shopify", (shopifyCohort || []) as OrderRow[]);
  await probeCohort("braintree", (braintreeCohort || []) as OrderRow[]);

  // ── Double-refund guard check ──
  console.log(`── Double-refund guard (last ${guardDays} days) ──`);
  const sinceIso = new Date(Date.now() - guardDays * 86_400_000).toISOString();
  const { data: recentEvents, error: eventErr } = await admin
    .from("customer_events")
    .select("id, customer_id, properties, created_at")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "order.refunded")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(200);
  if (eventErr) throw new Error(`customer_events query failed: ${eventErr.message}`);

  if (!recentEvents?.length) {
    console.log(`  ⚠ no order.refunded events in the last ${guardDays} days — dispatcher has not been exercised yet; guard-preservation is not falsifiable this cycle. Skipping (not a failure).\n`);
  } else {
    let checked = 0;
    let stampedOk = 0;
    for (const ev of recentEvents) {
      const props = (ev.properties as { order_id?: string } | null) || {};
      const orderId = props.order_id;
      if (!orderId) continue;

      // Only orders that ACTUALLY have a returns row can prove or
      // disprove the guard. Orders without returns are correctly a
      // no-op for the stamp (nothing to stamp).
      const { data: rets } = await admin
        .from("returns")
        .select("id, refunded_at, refund_id")
        .eq("workspace_id", workspaceId)
        .eq("order_id", orderId);
      if (!rets?.length) continue;
      checked++;
      const anyOpen = rets.some((r) => r.refunded_at === null);
      if (anyOpen) {
        const openIds = rets.filter((r) => r.refunded_at === null).map((r) => r.id).join(", ");
        console.log(`  ✗ order ${orderId}: customer_events order.refunded fired at ${ev.created_at} but return(s) [${openIds}] still have refunded_at=NULL — double-refund guard did NOT stamp them.`);
        failures++;
      } else {
        stampedOk++;
        if (verbose) console.log(`  ✓ order ${orderId}: ${rets.length} return(s) all stamped refunded_at.`);
      }
    }
    if (!checked) {
      console.log(`  (no order.refunded events had a matching returns row within the window — nothing to falsify against)\n`);
    } else if (!failures) {
      console.log(`  ✓ ${stampedOk}/${checked} recently-refunded orders had their return(s) stamped refunded_at.\n`);
    } else {
      console.log("");
    }
  }

  if (failures) {
    console.error(`✗ verify-refund-dispatcher: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("✓ verify-refund-dispatcher: all checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
