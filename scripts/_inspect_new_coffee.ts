import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const START = "2026-07-13T06:00:00Z";
async function main() {
  const admin = createAdminClient();
  const { data: camps } = await admin.from("ad_campaigns")
    .select("id,created_at,status,landing_url").eq("workspace_id",WS).eq("product_id",COFFEE)
    .gte("created_at",START).order("created_at",{ascending:true});
  console.log(`new coffee campaigns: ${(camps??[]).length}`);
  for (const c of camps as any[]) {
    const { data: vids } = await admin.from("ad_videos")
      .select("id,media_kind,format,status,static_jpg_url,meta").eq("campaign_id",c.id);
    const { data: angle } = await admin.from("product_ad_angles")
      .select("angle,headline,primary_text,generated_by,created_at,meta")
      .eq("workspace_id",WS).eq("product_id",COFFEE).gte("created_at",START).order("created_at",{ascending:true});
    console.log(`\n=== campaign ${c.id} | ${c.status} | ${c.created_at}`);
    for (const v of (vids??[]) as any[]) {
      console.log(`  video ${v.id} mk=${v.media_kind} fmt=${v.format} st=${v.status} archetype=${v.meta?.archetype ?? "?"}`);
      console.log(`  jpg: ${v.static_jpg_url}`);
      if (v.meta?.source) console.log(`  source: ${v.meta.source}`);
    }
  }
  // list the angle rows generated this run
  const { data: angles } = await admin.from("product_ad_angles")
    .select("angle,headline,primary_text,generated_by,meta,created_at")
    .eq("workspace_id",WS).eq("product_id",COFFEE).gte("created_at",START).order("created_at",{ascending:true});
  console.log(`\n--- angle rows this run: ${(angles??[]).length} ---`);
  for (const a of (angles??[]) as any[]) {
    console.log(`\n• angle="${a.angle}" archetype=${a.meta?.archetype ?? "?"} source=${a.meta?.source ?? a.meta?.explore_source ?? "?"}`);
    console.log(`  headline: ${a.headline}`);
    console.log(`  primary: ${String(a.primary_text??"").slice(0,140)}`);
    if (a.meta?.competitor || a.meta?.imitates) console.log(`  imitates: ${a.meta?.competitor ?? a.meta?.imitates}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
