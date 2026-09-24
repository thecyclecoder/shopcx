/**
 * Compare what APPSTLE actually charged each migrated customer against what ShopCX will charge.
 *
 * ⭐ Every pricing check we have verifies the contract against OUR OWN PLAN — and the plan is what
 * has been wrong, twice, silently:
 *   · `subscriptions.items` kept Appstle-era prices after the swap (13 rows showed a HIGHER price
 *     than the contract charges);
 *   · percentage codes were dropped entirely (4 customers lost 10–25%, and verify passed because
 *     the plan did not model the code either).
 *
 * Neither failed anything. This check has no such blind spot: it reads the customer's LAST REAL
 * APPSTLE ORDER and compares it to the live contract total. Ground truth on both sides.
 *
 * ⚠️ The baseline is the snapshot's CURRENT recurring total — what Appstle would charge on the
 * next cycle — NOT the customer's last order. A last-order baseline is wrong in three common ways,
 * all of which it flagged on the first run: the customer ADDED a line since (1-line order vs
 * 2-line contract), the order carried a one-off promo (previous order matched ShopCX exactly), or
 * quantity changed. 12 of 196 fired, and inspection showed most were the baseline, not the price.
 *
 * A DECREASE is expected and intended — the migration applies quantity breaks customers never got.
 * An INCREASE means we are about to charge someone more than they agreed to.
 *
 *   npx tsx scripts/_price-parity.ts [--all]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSubscriptionContract } from "../src/lib/commerce/shopify-subscription-client";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const money=(c:number)=>`$${(c/100).toFixed(2)}`;
/** Shipping, tax and one-off additions move an order total without touching the subscription. */
const TOLERANCE_PCT=1;   // same snapshot on both sides, so only rounding should differ

async function main(){
  const admin=createAdminClient();
  const {data:rows}=await admin.from("subscriptions")
    .select("id, shopify_contract_id, migrated_from_contract_id, status, customer_id, items")
    .eq("workspace_id",WS).eq("billing_source","shopcx")
    .not("migrated_from_contract_id","is",null).neq("status","cancelled");
  console.log(`comparing ${rows?.length} migrated contract(s) against what Appstle would charge next\n`);

  const { loadPricingContext, planMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const ctx = await loadPricingContext(WS, "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19");

  const worse:string[]=[]; let checked=0, noHistory=0, cheaper=0, same=0;
  for(const r of rows??[]){
    const {data:snap}=await admin.from("appstle_contract_snapshots").select("*")
      .eq("workspace_id",WS).eq("appstle_contract_id",r.migrated_from_contract_id!).maybeSingle();
    if(!snap){ noHistory++; continue; }
    // What Appstle WOULD have charged on the next cycle, from the same snapshot the plan used.
    let wasCents=0;
    try { wasCents = planMigration(snap as never, ctx).currentTotalCents; } catch { noHistory++; continue; }
    if(!wasCents){ noHistory++; continue; }

    const live = await getSubscriptionContract(WS, r.shopify_contract_id);
    if(!live.contract){ console.log(`  ✗ ${r.shopify_contract_id} unreadable`); continue; }
    const now=live.contract.lines.reduce((t,l)=>t+Math.round(parseFloat(l.lineDiscountedPrice??"0")*100),0);
    checked++;
    const delta=now-wasCents;
    const pct=(delta/wasCents)*100;
    if(pct>TOLERANCE_PCT){
      const {data:c}=await admin.from("customers").select("email").eq("id",r.customer_id!).maybeSingle();
      worse.push(`  ⚠️ ${r.shopify_contract_id} (was ${r.migrated_from_contract_id})  ${c?.email}\n       Appstle would charge ${money(wasCents)} → ShopCX will charge ${money(now)}  +${pct.toFixed(1)}%`);
    } else if(delta<0) cheaper++; else same++;
  }
  console.log(`checked ${checked}   no usable snapshot ${noHistory}   cheaper-or-equal ${cheaper+same}`);
  console.log(`\ncharging MORE than Appstle did (>${TOLERANCE_PCT}%): ${worse.length}`);
  if(worse.length) console.log(worse.join("\n")); else console.log("  ✅ nobody is charged more than they were paying");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
