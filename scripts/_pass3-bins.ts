import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCTS=[["Superfood Tabs","221d272d-a6c5-4a5d-86ff-ac693926c992"]];
(async()=>{
  const admin=createAdminClient();
  // bin depth per product (from ad_campaigns ready, angled vs not)
  const {data:prods}=await admin.from("products").select("id,title").eq("workspace_id",WS).limit(20);
  console.log("BIN DEPTH (ready creatives, floor 4):");
  for(const p of (prods||[]) as any[]){
    const {data:ready}=await admin.from("ad_campaigns").select("id,angle_id,name").eq("workspace_id",WS).eq("product_id",p.id).eq("status","ready");
    if(!ready?.length) continue;
    const angled=ready.filter((r:any)=>r.angle_id).length;
    const compSeeded=ready.filter((r:any)=>/competitor/i.test(r.name||"")).length;
    console.log(`  ${p.title.slice(0,22).padEnd(22)}: ${ready.length} ready (${angled} angled/usable, ${compSeeded} competitor-seeded) ${ready.length<4?"⚠️ BELOW FLOOR":angled<4?"⚠️ <4 usable":"✓"}`);
  }
  // did the dahlia null-angle fix + cohort-template fix ship?
  console.log("\nFIX-SPEC STATUS (from prior passes):");
  for(const slug of ["dahlia-creative-requires-angle-before-ready","media-buyer-cohort-adset-template-guard-backfill-and-escalate"]){
    const s:any=await getSpec(WS,slug).catch(()=>null);
    console.log(`  ${slug}: ${s?`status=${s.status??"(derived)"} phases=${(s.phases||[]).map((p:any)=>p.status).join(",")}`:"NOT FOUND"}`);
  }
  // Tabs cohort template still null?
  const {data:tc}=await admin.from("media_buyer_test_cohorts").select("adset_template").eq("workspace_id",WS).eq("product_id","221d272d-a6c5-4a5d-86ff-ac693926c992").eq("is_active",true).maybeSingle();
  console.log(`\nTabs cohort adset_template: ${(tc as any)?.adset_template && (tc as any).adset_template.pixelId ? "SET ✓" : "STILL NULL ⚠️"}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
