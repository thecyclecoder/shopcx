import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:spec,error:se}=await admin.from("specs").select("id").eq("workspace_id",WS).eq("slug","lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance").maybeSingle();
  if(se){console.log("spec err",se.message);return;}
  if(!spec){console.log("spec row not found");return;}
  console.log("spec id",(spec as any).id);
  const {data:phases,error:pe}=await admin.from("spec_phases").select("*").eq("spec_id",(spec as any).id);
  if(pe){console.log("phase err",pe.message);return;}
  console.log("phase count",phases?.length);
  for(const p of (phases||[]) as any[]){
    console.log(`\nP: ${(p.title||"").slice(0,45)}`);
    console.log("  columns:",Object.keys(p).filter(k=>/check/i.test(k)).join(",")||"(no check-named col)");
    const checks=p.checks||p.phase_checks||[];
    console.log("  checks value:",JSON.stringify(checks).slice(0,300));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
