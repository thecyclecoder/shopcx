import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  // scoped vs unscoped
  const { data:all }=await a.from("competitors").select("id,product_id,status").eq("workspace_id",WS);
  const unscoped=(all||[]).filter((c:any)=>!c.product_id);
  const scoped=(all||[]).filter((c:any)=>c.product_id);
  console.log(`competitors: ${(all||[]).length} total | scoped(product): ${scoped.length} | UNSCOPED(product_id null): ${unscoped.length}`);
  const byStatus:Record<string,number>={}; for(const c of unscoped) byStatus[c.status||"?"]=(byStatus[c.status||"?"]||0)+1;
  console.log("unscoped by status:", JSON.stringify(byStatus));
  // do unscoped competitors have creative_skeletons (ads)?
  const unscopedIds=unscoped.map((c:any)=>c.id);
  if(unscopedIds.length){
    const { count }=await a.from("creative_skeletons").select("id",{count:"exact",head:true}).eq("workspace_id",WS).in("competitor_id",unscopedIds.slice(0,200));
    console.log("creative_skeletons (ads) tied to unscoped competitors:", count);
  }
  // FK: does creative_skeletons.competitor_id FK-cascade or restrict?
})().then(()=>process.exit(0));
