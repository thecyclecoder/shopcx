/**
 * Re-date subscriptions whose billing date sits in an already-BILLED cycle.
 *
 * ⭐ CAUSE (self-inflicted): the rolling retime after each charge pinned the cycle that had JUST
 * billed onto the customer's next date. The renewal worker resolves by date and skips spent cycles,
 * so those subs were silently unbillable — 90 of 209 on 2026-09-28. Root cause fixed in
 * `shopifyRetimeContract` (never pin a spent cycle); this repairs the damage already done.
 *
 * ⚠️ THE ONLY REACHABLE REPAIR IS TO MOVE THE DATE FORWARD. Probed directly: a spent cycle can be
 * pinned back into its own window, but the following cycle then refuses `OUT_OF_BOUNDS` when pulled
 * back to the customer's date — so the customer's date cannot be preserved. Their next charge moves
 * to the first genuinely open cycle: median +28 days, mean +40. Revenue is DELAYED, never lost, and
 * the date only ever moves LATER — a customer is never surprised by an early charge.
 *
 *   npx tsx scripts/_repair-stranded.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
import { getSubscriptionContract, getUpcomingBillingCycles, getBillingCycleForDate, shopifySetNextBillingDate } from "../src/lib/commerce/shopify-subscription-client";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");

async function main(){
  const admin=createAdminClient();
  const r=await reconcileShopcxDrift(WS,{});
  const stranded=r.drift.filter(d=>d.kind==="stranded");
  console.log(`stranded: ${stranded.length} of ${r.checked} checked`);

  let fixed=0, failed=0, totalDelay=0;
  for(const d of stranded){
    const {data:sub}=await admin.from("subscriptions").select("id,next_billing_date")
      .eq("workspace_id",WS).eq("shopify_contract_id",d.contractId).maybeSingle();
    if(!sub?.next_billing_date){ failed++; continue; }
    const live=await getSubscriptionContract(WS,d.contractId);
    const cy=await getUpcomingBillingCycles(WS,d.contractId,{
      startDate:live.contract?.createdAt??undefined,
      endDate:new Date(Date.now()+400*86400000).toISOString(),first:20});
    const open=(cy.cycles??[]).find(c=>c.status!=="BILLED"&&!c.skipped&&new Date(c.expectedDate)>new Date());
    if(!open){ failed++; console.log(`  ✗ ${d.contractId}: no open cycle in the next 400 days`); continue; }
    const delay=Math.round((new Date(open.expectedDate).getTime()-new Date(sub.next_billing_date).getTime())/86400000);
    if(!APPLY){ console.log(`  [dry] ${d.contractId}  ${String(sub.next_billing_date).slice(0,10)} → ${String(open.expectedDate).slice(0,10)} (+${delay}d, cycle#${open.index})`); totalDelay+=delay; fixed++; continue; }

    const { error }=await admin.from("subscriptions")
      .update({next_billing_date:open.expectedDate,updated_at:new Date().toISOString()}).eq("id",sub.id);
    if(error){ failed++; console.log(`  ✗ ${d.contractId}: ${error.message}`); continue; }
    // Keep the customer-visible date in step. NOT a retime — a retime would re-pin and could undo this.
    await shopifySetNextBillingDate(WS,d.contractId,open.expectedDate);
    const after=await getBillingCycleForDate(WS,d.contractId,open.expectedDate);
    if(after.cycle && after.cycle.status!=="BILLED" && !after.cycle.skipped){
      fixed++; totalDelay+=delay;
      if(fixed<=5||fixed%25===0) console.log(`  ${d.contractId} → ${String(open.expectedDate).slice(0,10)} cycle#${after.cycle.index} (${fixed})`);
    } else { failed++; console.log(`  ✗ ${d.contractId}: still resolves to cycle#${after.cycle?.index} ${after.cycle?.status}`); }
  }
  console.log(`\n${APPLY?"repaired":"would repair"} ${fixed}   failed ${failed}   mean delay +${fixed?(totalDelay/fixed).toFixed(1):0}d`);
  if(!APPLY) console.log("dry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
