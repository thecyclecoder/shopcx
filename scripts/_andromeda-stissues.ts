import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-andromeda-concept-diversity-tags";
(async()=>{
  const a=createAdminClient();
  const { data:st }=await a.from("spec_test_runs").select("*").eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(3);
  console.log("spec_test_runs for andromeda:", (st||[]).length);
  for(const r of st||[]){
    const o:any=r;
    console.log(`\n[${o.verdict}] ${o.created_at?.slice(0,16)} cols:`, Object.keys(o).join(","));
    for(const k of ["verdict","summary","reasoning","issues","failing_checks","details","notes","output"]){
      if(o[k]!=null){ const v=typeof o[k]==="string"?o[k]:JSON.stringify(o[k]); console.log(`  ${k}: ${v.slice(0,500)}`); }
    }
  }
})().then(()=>process.exit(0));
