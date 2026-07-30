import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec, goalBranchState } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GOAL="dahlia-imitate-then-innovate-copy-engine";
(async()=>{
  const a=createAdminClient();
  // goal promotion state
  const { data:g }=await a.from("goals").select("slug,status,main_merge_sha").eq("workspace_id",WS).eq("slug",GOAL).maybeSingle();
  console.log("GOAL:", (g as any)?.slug, "| status:", (g as any)?.status, "| main_merge_sha:", (g as any)?.main_merge_sha ?? "NULL (not promoted to main)");
  // dahlia-copy-author build + phase state
  const s:any=await getSpec(WS,"dahlia-copy-author-box-session");
  console.log("\ndahlia-copy-author: phases:", (s?.phases||[]).map((p:any)=>`P${p.position}:${p.status}`).join(" "));
  const { data:jobs }=await a.from("agent_jobs").select("id,status,updated_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-copy-author-box-session").order("updated_at",{ascending:false}).limit(2);
  for(const j of jobs||[]) console.log("  build", (j as any).id.slice(0,8), (j as any).status);
  // goal member integration state
  const st:any=await goalBranchState(WS,GOAL).catch((e:any)=>({err:e.message}));
  if(!st.err){ const notOn=(st.specs||[]).filter((m:any)=>!m.onGoalBranch).map((m:any)=>m.slug); console.log("\ngoal members NOT yet on goal branch:", notOn.length?notOn.join(", "):"ALL integrated ✓"); }
})().then(()=>process.exit(0));
