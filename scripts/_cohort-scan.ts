import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:cohorts}=await admin.from("media_buyer_test_cohorts").select("id,product_id,is_active,adset_per_test,test_meta_campaign_id,adset_template,default_meta_account_id")
    .eq("workspace_id",WS).eq("is_active",true);
  console.log(`=== ACTIVE cohorts: ${cohorts?.length} ===`);
  for(const c of (cohorts||[]) as any[]){
    const tmplOk = c.adset_template && (c.adset_template as any).pixelId;
    console.log(`  prod ${c.product_id.slice(0,8)} | perTest=${c.adset_per_test} | campaign=${c.test_meta_campaign_id?"set":"NULL"} | template=${tmplOk?"OK (pixel "+(c.adset_template as any).pixelId+")":"❌ MISSING"}`);
  }
  // dedup specs
  const specs:any[]=await listSpecs(WS).catch(()=>[]);
  const hits=specs.filter(s=>/cohort|adset.template|provision|replenish|tabs.*test|stuck|2.4/i.test(s.slug+" "+(s.title||"")));
  console.log(`\n=== dedup (cohort/template/provision/replenish specs) ===`);
  for(const s of hits) console.log(`  ${s.slug} — status=${s.status??"(derived)"}`);
  // parked repair jobs
  const {data:jobs}=await admin.from("agent_jobs").select("spec_slug,status,kind").eq("workspace_id",WS)
    .in("status",["queued","claimed","building","needs_attention","queued_resume"]).or("spec_slug.ilike.%cohort%,spec_slug.ilike.%template%,spec_slug.ilike.%replenish%");
  console.log("parked related jobs:", JSON.stringify(jobs||[]));
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,250));process.exit(1);});
