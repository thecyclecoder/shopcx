import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data: accts } = await admin.from("meta_ad_accounts").select("id, meta_account_name, meta_account_id").eq("workspace_id",WS);
  const { data: coh } = await admin.from("media_buyer_test_cohorts").select("product_id, meta_ad_account_id, is_active").eq("workspace_id",WS).eq("is_active",true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id",WS);
  const pName=new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  console.log("=== account uuid-prefix → name → active cohorts (products) ===");
  for(const a of (accts||[]) as any[]){
    const mine=(coh||[]).filter((c:any)=>c.meta_ad_account_id===a.id);
    if(!mine.length) continue;
    console.log(`  ${a.id.slice(0,8)}  ${a.meta_account_name}  → ${mine.length} cohort(s): ${mine.map((c:any)=>pName.get(c.product_id)||c.product_id).join(", ")}`);
  }
  const total=(coh||[]).length;
  console.log(`\n  TOTAL active cohorts: ${total}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
