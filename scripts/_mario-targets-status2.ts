import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,spec_slug,status,created_at").eq("kind","mario")
    .in("status",["queued","claimed","building"]).order("created_at",{ascending:true});
  const all=jobs||[];
  const terminalSlugs:string[]=[], liveSlugs:string[]=[], noSpec:string[]=[];
  for(const j of all){
    const s:any=await getSpec(WS, j.spec_slug).catch(()=>null);
    const st = s ? (s.derived_status || s.status || "unknown") : "NO_SPEC";
    if(!s) noSpec.push(j.spec_slug);
    else if(["folded","shipped","deferred","archived"].includes(st)) terminalSlugs.push(`${st}:${j.spec_slug}`);
    else liveSlugs.push(`${st}:${j.spec_slug}`);
  }
  console.log("TERMINAL (folded/shipped/deferred):", terminalSlugs.length);
  terminalSlugs.forEach(s=>console.log("  x",s));
  console.log("\nLIVE (should Mario touch):", liveSlugs.length);
  liveSlugs.forEach(s=>console.log("  •",s));
  console.log("\nNO_SPEC:", noSpec.length); noSpec.forEach(s=>console.log("  ?",s));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
