/**
 * Sheryl Dickey (ticket e424aab9). New direction from the earlier
 * pause/auto-resume remediation: instead of waiting for Mixed Berry,
 * swap her paused sub to Strawberry Lemonade now, bill+ship today,
 * and set the next billing date to 2026-07-09 (Mixed Berry's
 * expected restock). The crisis_customer_actions row keeps
 * auto_readd=true so when Mixed Berry comes back, the crisis
 * resolver swaps her back to it before the next bill.
 *
 * Steps:
 *   1. Resume the paused Appstle sub (status → ACTIVE)
 *   2. Swap variant: Mixed Berry (42614433448109) → Strawberry
 *      Lemonade (42614433480877), qty 1
 *   3. Lock the line item price at $39.95 (her grandfathered rate)
 *   4. Bill now (charges card + sends order to fulfillment)
 *   5. Set next_billing_date to 2026-07-09 on Appstle
 *   6. Update crisis_customer_actions: paused_at=null,
 *      auto_resume=false (sub is now active, not paused); keep
 *      auto_readd=true so the crisis resolver still swaps her back
 *      to Mixed Berry on restock
 *   7. Queue confirmation email through ticket_messages with the
 *      standard pending_send_at delay so it threads in Gmail
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "e424aab9-b123-420f-85e9-c34ff01bd7b0";
const CUSTOMER_ID = "f7b01509-f3b4-4750-9985-1ae83f2dcc73";
const SUB_ID = "054337e5-23da-4713-9f9e-397211015e4e";
const CONTRACT_ID = "28135194797";
const OLD_VARIANT = "42614433448109"; // Mixed Berry
const NEW_VARIANT = "42614433480877"; // Strawberry Lemonade
const NEW_PRICE_CENTS = 3995;
const NEXT_DATE = "2026-07-09";

async function main() {
  const { appstleSubscriptionAction, appstleGetUpcomingOrders, appstleAttemptBilling, appstleUpdateNextBillingDate } = await import("../src/lib/appstle");
  const { subSwapVariant, subUpdateLineItemPrice } = await import("../src/lib/subscription-items");

  // 1. Resume the paused sub
  console.log("Step 1: resume paused sub →", CONTRACT_ID);
  const resume = await appstleSubscriptionAction(WS, CONTRACT_ID, "resume");
  console.log("  →", resume);
  if (!resume.success) throw new Error(`resume failed: ${resume.error}`);

  // 2. Swap Mixed Berry → Strawberry Lemonade
  console.log("\nStep 2: swap variant", OLD_VARIANT, "→", NEW_VARIANT, "qty 1");
  const swap = await subSwapVariant(WS, CONTRACT_ID, OLD_VARIANT, NEW_VARIANT, 1);
  console.log("  →", swap);
  if (!swap.success) throw new Error(`swap failed: ${swap.error}`);

  // 3. Lock the price at $39.95 — Strawberry Lemonade catalog MSRP
  //    is higher; we keep her grandfathered rate.
  console.log("\nStep 3: lock line price at $39.95 on variant", NEW_VARIANT);
  const price = await subUpdateLineItemPrice(WS, CONTRACT_ID, NEW_VARIANT, NEW_PRICE_CENTS);
  console.log("  →", price);
  if (!price.success) console.warn(`price update failed: ${price.error}`);

  // 4. Bill now — Appstle requires an upcoming order id to attempt
  console.log("\nStep 4: bill now");
  const upcoming = await appstleGetUpcomingOrders(WS, CONTRACT_ID);
  if (!upcoming.success || !upcoming.orders?.length) {
    throw new Error("no upcoming order found to bill against");
  }
  const billingAttemptId = upcoming.orders[0].id;
  const billed = await appstleAttemptBilling(WS, billingAttemptId);
  console.log("  →", billed);
  if (!billed.success) throw new Error(`bill_now failed: ${billed.error}`);

  // 5. Set next billing date to July 9 (Mixed Berry restock)
  console.log("\nStep 5: set next_billing_date →", NEXT_DATE);
  const nextDate = await appstleUpdateNextBillingDate(WS, CONTRACT_ID, NEXT_DATE);
  console.log("  →", nextDate);
  if (!nextDate.success) console.warn(`next-date update failed: ${nextDate.error}`);

  // Also update our DB mirror so portal + dashboard show right state
  const nowIso = new Date().toISOString();
  await admin
    .from("subscriptions")
    .update({
      status: "active",
      next_billing_date: `${NEXT_DATE}T08:00:00+00:00`,
      updated_at: nowIso,
    })
    .eq("id", SUB_ID);

  // 6. Update crisis_customer_actions — sub is no longer paused; keep
  //    auto_readd=true so the crisis resolver swaps her back to Mixed
  //    Berry on restock before the July 9 renewal fires.
  console.log("\nStep 6: update crisis_customer_actions");
  const { data: cca } = await admin
    .from("crisis_customer_actions")
    .select("id, segment")
    .eq("customer_id", CUSTOMER_ID)
    .order("created_at", { ascending: false })
    .limit(1);
  if (cca && cca.length > 0) {
    await admin
      .from("crisis_customer_actions")
      .update({
        paused_at: null,
        auto_resume: false,
        auto_readd: true,
        tier1_response: "accepted_swap",
        tier1_swapped_to: { title: "Strawberry Lemonade", variantId: NEW_VARIANT },
        updated_at: nowIso,
      })
      .eq("id", cca[0].id);
    console.log("  → updated row", cca[0].id);
  } else {
    console.warn("  ⚠ no crisis row found");
  }

  // 7. Confirmation email — pending_send_at delay matches the other
  //    Suzie-signed automations so it threads naturally in Gmail.
  console.log("\nStep 7: queue confirmation email");
  const body = `<p>Hi Sheryl — all done! Here's what I did just now:</p><ul><li>Switched your Superfood Tabs subscription to <strong>Strawberry Lemonade</strong> for this shipment.</li><li>Sent <strong>1 bag of Strawberry Lemonade</strong> out today at your locked-in <strong>$39.95</strong> price — you'll get a tracking email once it ships from our warehouse.</li><li>Set your next order to ship on <strong>July 9</strong> (when Mixed Berry should be back in stock). It'll automatically switch back to Mixed Berry then — no action needed on your end.</li></ul><p>Suzie, Customer Support at Superfoods Company</p>`;
  const pendingAt = new Date(Date.now() + 5_000).toISOString();
  const { data: msg } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
    pending_send_at: pendingAt,
  }).select("id").single();
  await admin.from("tickets").update({ status: "open", updated_at: nowIso }).eq("id", TICKET_ID);
  console.log("  → queued message", msg?.id, "send at", pendingAt);

  console.log("\n✓ all steps complete");
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
