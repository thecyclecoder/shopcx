/**
 * Ticket 178ae5a7 — Jodi's cancel-journey save misfire.
 *
 * What happened: Jodi asked to cancel her Superfood Tabs subscription
 * (sub e66a1171 / contract 27847164077). The cancel journey was launched
 * bound to the WRONG subscription — her Ashwavana sub (f8d2ccef /
 * contract 34026061997). She went through the flow, chose "too much
 * product", and accepted a 20%-off save remedy (SHOPCX-CR20). The coupon
 * landed on the Ashwavana sub. Meanwhile the Tabs sub renewed the next
 * morning as SC132928 ($75.86, full price) — so she got NEITHER the
 * outcome she wanted NOR the 20% she accepted.
 *
 * Make-good (Dylan, ticket 178ae5a7):
 *   1. 20% partial refund on SC132928 — the order the discount should have
 *      hit. 20% of $75.86 = $15.17.
 *   2. Remove the misapplied SHOPCX-CR20 coupon from the Ashwavana sub.
 *
 * Idempotent: the refund is guarded by a sentinel system-note on the
 * ticket; coupon removal is naturally idempotent (no-op if none applied).
 * Dry-run by default. Pass --apply to execute.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "178ae5a7-c29e-45ed-a4b7-24fcbf0e51af";

// Refund target: SC132928 (Superfood Tabs sub renewal that should have been discounted)
const REFUND_ORDER_NUMBER = "SC132928";
const REFUND_ORDER_SHOPIFY_ID = "7003959328941";
const ORDER_TOTAL_CENTS = 7586;
const REFUND_CENTS = Math.round(ORDER_TOTAL_CENTS * 0.2); // 1517 = $15.17
const REFUND_REASON =
  "20% make-good on SC132928 — customer accepted a 20%-off save in the cancel flow (ticket 178ae5a7), but the discount was applied to the wrong subscription so this renewal billed full price.";

// Coupon to remove: SHOPCX-CR20 on the Ashwavana sub (misapplied)
const ASHWAVANA_CONTRACT_ID = "34026061997";

const SENTINEL = `[Remedy 178ae5a7] partial_refund SC132928 ${REFUND_CENTS}c applied`;
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  console.log(`=== Jodi save-misfire remedy (ticket 178ae5a7) — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  // ── Probe: current state ────────────────────────────────────────────
  const { data: order } = await admin.from("orders")
    .select("order_number, shopify_order_id, total_cents, financial_status")
    .eq("order_number", REFUND_ORDER_NUMBER).eq("workspace_id", WS).single();
  console.log("Refund target:", JSON.stringify(order));
  console.log(`Refund amount: ${REFUND_CENTS}c ($${(REFUND_CENTS / 100).toFixed(2)}) = 20% of ${ORDER_TOTAL_CENTS}c\n`);

  const { data: ashw } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, applied_discounts")
    .eq("shopify_contract_id", ASHWAVANA_CONTRACT_ID).eq("workspace_id", WS).single();
  console.log("Ashwavana sub coupons (to remove):", JSON.stringify(ashw?.applied_discounts));

  // Sanity guards
  if (!order?.shopify_order_id || order.shopify_order_id !== REFUND_ORDER_SHOPIFY_ID) {
    throw new Error(`Order resolution mismatch — expected ${REFUND_ORDER_SHOPIFY_ID}, got ${order?.shopify_order_id}`);
  }
  if (order.total_cents !== ORDER_TOTAL_CENTS) {
    throw new Error(`Order total changed (${order.total_cents}c vs expected ${ORDER_TOTAL_CENTS}c) — recompute 20% before applying.`);
  }

  // Idempotency: has this refund already been issued?
  const { data: prior } = await admin.from("ticket_messages")
    .select("id").eq("ticket_id", TICKET).ilike("body", `%${SENTINEL}%`).limit(1);
  const alreadyRefunded = (prior?.length ?? 0) > 0;
  console.log(`\nIdempotency: refund sentinel ${alreadyRefunded ? "FOUND — will skip refund" : "not found — refund will run"}`);

  if (!APPLY) {
    console.log("\n--- DRY RUN PLAN ---");
    console.log(`1. partial_refund $${(REFUND_CENTS / 100).toFixed(2)} on SC132928 (${REFUND_ORDER_SHOPIFY_ID})`);
    console.log(`2. remove_coupon SHOPCX-CR20 from Ashwavana contract ${ASHWAVANA_CONTRACT_ID}`);
    console.log("\nRe-run with --apply to execute.");
    return;
  }

  // ── Step 1: 20% partial refund on SC132928 ─────────────────────────
  if (alreadyRefunded) {
    console.log("\nSTEP 1 — SKIPPED (already refunded per sentinel).");
  } else {
    console.log("\nSTEP 1 — partial refund $" + (REFUND_CENTS / 100).toFixed(2) + " on SC132928...");
    const { partialRefundByAmount } = await import("../src/lib/shopify-order-actions");
    const r = await partialRefundByAmount(WS, REFUND_ORDER_SHOPIFY_ID, REFUND_CENTS, REFUND_REASON);
    console.log("  ->", JSON.stringify(r));
    if (!r.success) {
      console.log("  REFUND FAILED — aborting; coupon left untouched so this can be re-run cleanly.");
      return;
    }
    // Write idempotency sentinel + audit note
    await admin.from("ticket_messages").insert({
      ticket_id: TICKET, workspace_id: WS, direction: "outbound",
      visibility: "internal", author_type: "system",
      body: `${SENTINEL}${r.method === "braintree" ? ` (braintree ${r.braintreeRefundId ?? "?"})` : ""} — ${REFUND_REASON}`,
    });
    console.log("  sentinel written.");
  }

  // ── Step 2: remove misapplied SHOPCX-CR20 from Ashwavana sub ────────
  console.log("\nSTEP 2 — remove SHOPCX-CR20 from Ashwavana contract " + ASHWAVANA_CONTRACT_ID + "...");
  const { removeExistingDiscounts } = await import("../src/lib/appstle-discount");
  const { getAppstleConfig } = await import("../src/lib/subscription-items");
  const config = await getAppstleConfig(WS);
  if (!config) { console.log("  Appstle not configured — ABORT."); return; }
  const rem = await removeExistingDiscounts(config.apiKey, ASHWAVANA_CONTRACT_ID);
  console.log("  ->", JSON.stringify(rem));

  console.log("\nDONE.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
