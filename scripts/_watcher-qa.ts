import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec, listSpecs } from "../src/lib/specs-table";
import { getTestingResults, enrichWithMetaCreatives } from "../src/lib/ads/testing-results-sdk";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // A) Is the replenish-copy/no-angle gap already covered?
  console.log("=== DEDUP: replenish copy/config fix in flight? ===");
  for(const slug of ["media-buyer-replenish-publish-copy-guard","media-buyer-replenish-per-product-scope"]){
    const s:any=await getSpec(WS,slug).catch(()=>null);
    console.log(`  ${slug}: ${s?`status=${s.status??"(derived)"} phases=${(s.phases||[]).length}`:"NOT FOUND"}`);
  }
  const {data:parked}=await admin.from("agent_jobs").select("spec_slug,status,kind").eq("workspace_id",WS)
    .eq("kind","repair").in("status",["queued","claimed","building","needs_attention","queued_resume"]).ilike("spec_slug","%replenish%");
  console.log("  parked replenish repairs:", JSON.stringify(parked));

  // B) LIVE-AD QA — enrich ACTIVE ads with live creative copy + destination
  console.log("\n=== LIVE-AD QA (LF8 / destination) — sample of active ads ===");
  const res:any=await getTestingResults(admin,WS);
  const activeRows = (res.products||[]).flatMap((g:any)=>(g.rows||[]).filter((r:any)=>r.active).map((r:any)=>({...r,product:g.productTitle})));
  console.log(`  ${activeRows.length} active ads total`);
  const token=await getMetaUserToken(WS).catch(()=>null);
  if(!token){ console.log("  no meta token — skipping live creative pull"); }
  else {
    // sample: 1 active ad per product (first active)
    const seen=new Set<string>(); const sample=[];
    for(const r of activeRows){ if(!seen.has(r.product)){ seen.add(r.product); sample.push(r);} }
    await enrichWithMetaCreatives(sample, token, metaGraphRequest, { onlyActive:true, concurrency:4 });
    for(const r of sample){
      const c=r.creative;
      console.log(`\n  ▸ ${r.product} — ${r.adsetName?.slice(0,28)}`);
      if(!c){ console.log("     (no creative resolved)"); continue; }
      console.log(`     headline:  ${String(c.headline||"—").slice(0,90)}`);
      console.log(`     primary:   ${String(c.primaryText||"—").replace(/\n/g," ").slice(0,140)}`);
      console.log(`     dest:      ${String(c.destinationUrl||c.linkUrl||"—").slice(0,80)}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR:",String(e).slice(0,400));process.exit(1);});
