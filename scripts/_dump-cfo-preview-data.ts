import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("qb_pnl_snapshots")
    .select("period_month,total_income,net_income,management_fees,adjusted_net_income,fixed_opex,digital_advertising,transaction_fees,refunds,chargebacks,discounts_coupons,inventory_adjustments")
    .eq("workspace_id",WS).order("period_month");
  const n=(v:any)=>v==null?null:Number(v);
  const rows=(data??[]).map((r:any)=>({month:r.period_month,revenue:n(r.total_income),netProfit:n(r.net_income),mgmtFees:n(r.management_fees),netProfitWithAddbacks:n(r.adjusted_net_income),fixedOpex:n(r.fixed_opex),digitalAds:n(r.digital_advertising),transactionFees:n(r.transaction_fees),refunds:n(r.refunds),chargebacks:n(r.chargebacks),discountsCoupons:n(r.discounts_coupons),inventoryAdjustments:n(r.inventory_adjustments)}));
  console.log(JSON.stringify(rows));
}
main().catch(e=>{console.error(e);process.exit(1);});
