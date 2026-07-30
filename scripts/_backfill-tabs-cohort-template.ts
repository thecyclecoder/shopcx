import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildAdsetTemplate } from "../src/lib/media-buyer/provision-cohort";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // resolve pixel from a sibling active cohort that HAS a template (don't invent one)
  const {data:cohorts}=await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,adset_template,default_meta_account_id")
    .eq("workspace_id",WS).eq("is_active",true).eq("adset_per_test",true);
  const sibling=(cohorts||[]).find((c:any)=>c.adset_template && c.adset_template.pixelId);
  const pixel=(sibling?.adset_template as any)?.pixelId;
  if(!pixel){ console.log("no sibling pixel found — aborting"); return; }
  console.log(`sibling pixel: ${pixel}`);
  const broken=(cohorts||[]).filter((c:any)=>!c.adset_template || !c.adset_template.pixelId);
  console.log(`active per-test cohorts missing template: ${broken.length}`);
  const tmpl=buildAdsetTemplate({ pixelId: pixel });
  for(const c of broken as any[]){
    const {error}=await admin.from("media_buyer_test_cohorts").update({ adset_template: tmpl }).eq("id",c.id);
    console.log(`  ${error?"ERR "+error.message:"✓ set template"} — cohort ${c.id.slice(0,8)} product ${String(c.product_id).slice(0,8)}`);
  }
  const {data:after}=await admin.from("media_buyer_test_cohorts").select("product_id,adset_template").eq("workspace_id",WS).eq("is_active",true).eq("adset_per_test",true);
  const stillBroken=(after||[]).filter((c:any)=>!c.adset_template||!c.adset_template.pixelId).length;
  console.log(`\nafter: ${stillBroken} active per-test cohorts still missing a template`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
