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
  console.log("mario active jobs:", all.length);
  let terminal=0, live=0, missing=0;
  const buckets:Record<string,string[]>={};
  for(const j of all){
    const s:any=await getSpec(j.spec_slug, WS).catch(()=>null) || await getSpec(WS, j.spec_slug).catch(()=>null);
    const st = s?.derived_status || s?.status || (s?null:"NO_SPEC");
    (buckets[st]=buckets[st]||[]).push(j.spec_slug);
    if(!s){missing++;} else if(["folded","shipped","deferred"].includes(st)){terminal++;} else {live++;}
  }
  console.log("\n=== mario targets by spec status ===");
  for(const [st,slugs] of Object.entries(buckets)) console.log(`  ${st.padEnd(12)} (${slugs.length}): ${slugs.slice(0,8).join(", ")}${slugs.length>8?" …":""}`);
  console.log(`\nterminal(folded/shipped/deferred): ${terminal} | live: ${live} | no-spec: ${missing}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
