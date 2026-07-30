import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("spec_slug,status,kind,updated_at").eq("workspace_id",WS)
    .in("status",["queued","claimed","building","queued_resume"]).order("updated_at",{ascending:false});
  console.log("active jobs:"); for(const j of data||[]) console.log(`  [${j.status}] ${j.kind} ${j.spec_slug??""} ${ago(j.updated_at)}`);
  const { count:na } = await admin.from("agent_jobs").select("id",{count:"exact",head:true}).eq("workspace_id",WS).eq("status","needs_attention");
  console.log(`needs_attention: ${na}`);
  // the 3 new fix-specs present?
  const { data:fs } = await admin.from("specs").select("slug,priority").eq("workspace_id",WS)
    .in("slug",["mario-detects-job-and-pr-wedges-not-just-spec-lifecycle","pr-resolve-retry-cap-and-fold-closes-orphan-pr","parallel-build-serialized-merge-and-deadlock-autobreak"]);
  console.log("\nnew fix-specs:"); for(const s of fs||[]) console.log(`  [${s.priority}] ${s.slug}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
