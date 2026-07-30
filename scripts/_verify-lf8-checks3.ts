import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:spec}=await admin.from("specs").select("id").eq("workspace_id",WS).eq("slug","lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance").maybeSingle();
  const {data:phases}=await admin.from("spec_phases").select("id, title, position, origin_check_keys").eq("spec_id",(spec as any).id).order("position");
  for(const p of (phases||[]) as any[]){
    console.log(`\nP${p.position}: origin_check_keys=${JSON.stringify(p.origin_check_keys)}`);
    // try spec_phase_checks table
    for(const tbl of ["spec_phase_checks","phase_checks","spec_checks"]){
      const {data,error}=await admin.from(tbl).select("*").eq("phase_id",p.id);
      if(!error){console.log(`  ${tbl}: ${data?.length||0} row(s) → ${(data||[]).map((c:any)=>c.exec_kind||c.kind).join(", ")}`);}
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
