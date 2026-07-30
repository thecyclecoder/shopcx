import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const hrs=(iso:string)=>((Date.now()-new Date(iso).getTime())/3600000).toFixed(1)+"h ago";
(async()=>{
  const a=createAdminClient();
  // active Max/growth lanes
  const { data:jobs }=await a.from("agent_jobs").select("id,kind,status,spec_slug,updated_at").eq("workspace_id",WS).in("kind",["ads-supervisor","growth-director","media-buyer-grade","calibrate-media-buyer-policy","sensor-trust-probe","gap-grade","campaign-grade"]).in("status",["queued","claimed","building","needs_input","needs_approval","queued_resume"]).order("updated_at",{ascending:false});
  console.log("ACTIVE Max-owned lanes:", (jobs||[]).length);
  for(const j of jobs||[]) console.log(`  ${(j as any).kind}/${(j as any).status} ${(j as any).spec_slug||""} (${hrs((j as any).updated_at)})`);
  // did ads-supervisor / growth author any spec recently that might touch dahlia/creative?
  const { data:recent }=await a.from("specs").select("slug,status,owner,created_at").eq("workspace_id",WS).eq("owner","growth").gte("created_at",new Date(Date.now()-24*3600000).toISOString()).order("created_at",{ascending:false}).limit(15);
  console.log("\ngrowth-owned specs created last 24h:", (recent||[]).length);
  for(const s of recent||[]) console.log(`  ${(s as any).slug} [${(s as any).status}] (${hrs((s as any).created_at)})`);
})().then(()=>process.exit(0));
