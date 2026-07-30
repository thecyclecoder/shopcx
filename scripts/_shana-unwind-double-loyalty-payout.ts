/**
 * One-off remedy — unwind the double $15 loyalty payout on ticket f9e28d57 (Shana Mortenson).
 *
 * Ticket f9e28d57 shipped a double payout: turn 2 correctly redeemed 1500 pts →
 * $15 CASH refund on SC135320 (the intended Tier-0 Loyalty Save), but the minted
 * coupon LOYALTY-15-J4MYE5 was left `active`, and a drifted turn 4 re-applied that
 * same coupon to her PAUSED sub — so the next renewal (Sep 17) would ALSO get $15 off.
 * Cora graded this 3/10 (rule_violation x2, drift x2) — correctly.
 *
 * CEO decision (Dylan, 2026-07-23): unwind the extra. Shana keeps the $15 cash refund
 * (the single intended remedy); remove the coupon so it never discounts a renewal.
 *
 * Idempotent: if the coupon is already gone / redemption already expired, it no-ops.
 * Read-then-write; prints before/after. --apply to write, dry-run by default.
 */
import { createAdminClient } from "./_bootstrap";
import { subscriptionRemoveCoupon } from "@/lib/subscription-items";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CONTRACT_ID = "27827273901";
const CODE = "LOYALTY-15-J4MYE5";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data: subBefore } = await admin
    .from("subscriptions")
    .select("id, status, applied_discounts")
    .eq("workspace_id", WS)
    .eq("shopify_contract_id", CONTRACT_ID)
    .single();
  const before = (subBefore?.applied_discounts as { title?: string; code?: string }[]) || [];
  const hasCoupon = before.some((d) => (d.title || d.code) === CODE);
  console.log(`SUB ${subBefore?.id} status=${subBefore?.status}`);
  console.log(`  applied_discounts BEFORE:`, JSON.stringify(before));
  console.log(`  ${CODE} present on sub: ${hasCoupon}`);

  const { data: redBefore } = await admin
    .from("loyalty_redemptions")
    .select("id, status, used_at, points_spent, discount_value")
    .eq("workspace_id", WS)
    .eq("discount_code", CODE)
    .maybeSingle();
  console.log(`  redemption:`, JSON.stringify(redBefore));

  if (!APPLY) {
    console.log("\n[dry-run] would:");
    if (hasCoupon) console.log(`  - subscriptionRemoveCoupon(${CONTRACT_ID}, ${CODE})`);
    if (redBefore && redBefore.status === "active") console.log(`  - flip redemption ${redBefore.id} active → expired (used_at=now)`);
    console.log("Re-run with --apply to write.");
    return;
  }

  // 1) Remove the coupon from the subscription (Appstle-aware; also resyncs local applied_discounts).
  if (hasCoupon) {
    const r = await subscriptionRemoveCoupon(WS, CONTRACT_ID, CODE);
    console.log(`\nsubscriptionRemoveCoupon →`, JSON.stringify(r));
    if (!r.success) throw new Error(`removal failed: ${r.error}`);
  } else {
    console.log("\ncoupon already absent from sub — skipping removal");
  }

  // 2) Retire the dangling redemption so it can't be re-applied by a future ticket touch.
  //    Compare-and-set on status='active' (idempotent — re-runs match 0 rows).
  if (redBefore && redBefore.status === "active") {
    const { data: flipped } = await admin
      .from("loyalty_redemptions")
      .update({ status: "expired", used_at: new Date().toISOString() })
      .eq("id", redBefore.id)
      .eq("status", "active")
      .select("id, status, used_at");
    console.log(`redemption flip →`, JSON.stringify(flipped));
  } else {
    console.log("redemption not active — skipping flip");
  }

  // 3) Verify final state.
  const { data: subAfter } = await admin
    .from("subscriptions")
    .select("applied_discounts")
    .eq("workspace_id", WS)
    .eq("shopify_contract_id", CONTRACT_ID)
    .single();
  console.log(`\napplied_discounts AFTER:`, JSON.stringify(subAfter?.applied_discounts));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
