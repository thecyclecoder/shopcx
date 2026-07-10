import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { parsePnlRollups } from "../src/lib/quickbooks";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const fmt=(n:number|null)=>n==null?"    —  ":"$"+Math.round(n).toLocaleString().padStart(7);
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("qb_pnl_snapshots").select("id,period_month,raw").eq("workspace_id",WS).order("period_month");
  const tot:Record<string,number>={};
  console.log("month        Ads      TxnFee   FixedOpex  Refunds  Chgbk   Disc     InvAdj");
  for(const r of data??[]){
    const p=parsePnlRollups((r as any).raw);
    await admin.from("qb_pnl_snapshots").update({
      digital_advertising:p.digital_advertising, transaction_fees:p.transaction_fees, fixed_opex:p.fixed_opex,
      refunds:p.refunds, chargebacks:p.chargebacks, discounts_coupons:p.discounts_coupons, inventory_adjustments:p.inventory_adjustments,
      updated_at:new Date().toISOString(),
    }).eq("id",(r as any).id);
    for(const k of ["digital_advertising","transaction_fees","fixed_opex","refunds","chargebacks","discounts_coupons","inventory_adjustments"]) tot[k]=(tot[k]??0)+((p as any)[k]??0);
    console.log(`${(r as any).period_month} ${fmt(p.digital_advertising)} ${fmt(p.transaction_fees)} ${fmt(p.fixed_opex)} ${fmt(p.refunds)} ${fmt(p.chargebacks)} ${fmt(p.discounts_coupons)} ${fmt(p.inventory_adjustments)}`);
  }
  console.log("\n24-mo totals: Ads",fmt(tot.digital_advertising),"| TxnFees",fmt(tot.transaction_fees),"| Refunds",fmt(tot.refunds),"| Chargebacks",fmt(tot.chargebacks),"| Discounts",fmt(tot.discounts_coupons),"| InvAdj",fmt(tot.inventory_adjustments));
}
main().catch(e=>{console.error(e);process.exit(1);});
