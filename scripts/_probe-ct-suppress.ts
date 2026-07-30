import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { resolveGoalSlugForSpec } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="control-tower-suppress-box-cron-freshness-during-worker-outa";
(async()=>{
  const a=createAdminClient();
  const s:any=await getSpec(WS,SLUG);
  console.log("status:", s.status, "| auto_build:", s.auto_build, "| blocked_by:", JSON.stringify(s.blocked_by), "| phases:", (s.phases||[]).map((p:any)=>`P${p.position}:${p.status}`).join(" "));
  const goal=await resolveGoalSlugForSpec(WS,SLUG).catch(()=>null);
  console.log("goal:", goal||"STANDALONE");
  const { data:jobs }=await a.from("agent_jobs").select("id,status,spec_branch,needs_attention_class,error,updated_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG).order("updated_at",{ascending:false}).limit(5);
  for(const j of jobs||[]) console.log(`  ${(j as any).id.slice(0,8)} ${(j as any).status}${(j as any).needs_attention_class?"/"+(j as any).needs_attention_class:""} branch=${(j as any).spec_branch||"-"}\n     ${((j as any).error||"").slice(0,150)}`);
})().then(()=>process.exit(0));
