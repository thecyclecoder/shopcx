import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:spec}=await admin.from("specs").select("id").eq("workspace_id",WS).eq("slug","lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance").single();
  const {data:phases}=await admin.from("spec_phases").select("id, title, checks, position").eq("spec_id",(spec as any).id).order("position");
  for(const p of (phases||[]) as any[]){
    const checks=p.checks||[];
    console.log(`P${p.position}: ${(p.title||"").slice(0,50)} → ${checks.length} check(s): ${checks.map((c:any)=>`${c.exec_kind}`).join(", ")}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
