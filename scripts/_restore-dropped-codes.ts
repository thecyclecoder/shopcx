/**
 * Re-apply the percentage codes that were silently dropped on migration.
 *
 * `carryableCodes` skipped percentage-valued codes ("needs a separate shape; skip for now"), so
 * 4 customers were migrated with a 10–25% discount quietly removed — $40.34/cycle — and nothing
 * failed or warned. The cause is fixed; this restores the customers already affected.
 *
 * Idempotent: refuses if the contract already carries a discount with that title.
 *
 *   npx tsx scripts/_restore-dropped-codes.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { carryableCodes } from "../src/lib/commerce/shopify-subscription-migrate";
import { withDraft, shopifyAddDraftDiscount, getSubscriptionContract } from "../src/lib/commerce/shopify-subscription-client";
import { mirrorContractPricing } from "../src/lib/commerce/shopcx-contract-ingest";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");

async function main(){
  const admin=createAdminClient();
  const snaps:any[]=[];
  for(let f=0;;f+=1000){
    const {data}=await admin.from("appstle_contract_snapshots")
      .select("appstle_contract_id,raw,migration_completed_at").eq("workspace_id",WS)
      .not("migration_completed_at","is",null).range(f,f+999);
    if(!data?.length)break; snaps.push(...data); if(data.length<1000)break;
  }
  let fixed=0;
  for(const s of snaps){
    const codes=carryableCodes(s.raw as Record<string,unknown>).filter(c=>c.percentage!=null);
    if(!codes.length) continue;
    const {data:sub}=await admin.from("subscriptions").select("shopify_contract_id,customer_id")
      .eq("workspace_id",WS).eq("migrated_from_contract_id",s.appstle_contract_id).maybeSingle();
    if(!sub) continue;
    const live=await getSubscriptionContract(WS,sub.shopify_contract_id);
    if(!live.contract){console.log(`  ✗ ${sub.shopify_contract_id}: unreadable`);continue;}

    // already restored? the structural titles are known; anything else with this title means done
    const missing=codes.filter(c=>!live.contract!.lines.some(()=>false)); // titles aren't on lines; use draft-free check below
    void missing;
    const {data:row}=await admin.from("subscriptions").select("applied_discounts").eq("workspace_id",WS).eq("shopify_contract_id",sub.shopify_contract_id).single();
    const have=new Set(((row?.applied_discounts as any[])??[]).map(d=>String(d.title)));
    const todo=codes.filter(c=>!have.has(c.title));
    if(!todo.length){console.log(`  ok ${sub.shopify_contract_id}: already carries ${codes.map(c=>c.title).join(", ")}`);continue;}

    console.log(`${APPLY?"":"[dry] "}${sub.shopify_contract_id} (was ${s.appstle_contract_id}): add ${todo.map(c=>`${c.title} ${c.percentage}%`).join(", ")}`);
    if(!APPLY) continue;
    const r=await withDraft(WS,sub.shopify_contract_id,async(draftId)=>{
      for(const c of todo){
        const add=await shopifyAddDraftDiscount(WS,draftId,{
          title:c.title,
          value:{percentage:c.percentage!},
          ...(c.recurringCycleLimit!=null?{recurringCycleLimit:c.recurringCycleLimit}:{}),
        });
        if(!add.success) return add;
      }
      return {success:true};
    });
    if(!r.success){console.log(`  ✗ ${r.error}`);continue;}
    await mirrorContractPricing(WS,sub.shopify_contract_id);
    const after=await getSubscriptionContract(WS,sub.shopify_contract_id);
    const total=(after.contract?.lines??[]).reduce((t,l)=>t+Math.round(parseFloat(l.lineDiscountedPrice??"0")*100),0);
    console.log(`  ✅ restored — contract now charges $${(total/100).toFixed(2)}`);
    fixed++;
  }
  console.log(APPLY?`\n${fixed} contract(s) restored`:"\ndry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
