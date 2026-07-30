import { loadEnv } from "./_bootstrap"; loadEnv();
import { pgQuery } from "../src/lib/pg-pool";
(async()=>{
  const ks=await pgQuery<{node_id:string,scope:string}>(`SELECT node_id, scope FROM public.kill_switches`);
  console.log("kill_switches rows:", (ks||[]).length, JSON.stringify(ks));
  const na=await pgQuery<{c:number}>(`SELECT count(*)::int c FROM public.node_ancestry`);
  console.log("node_ancestry rows:", na?.[0]?.c ?? "?");
  const diag=await pgQuery<{diag:any}>(`SELECT public.claim_agent_job_diag(array['build','plan']) AS diag`);
  console.log("claim suppressed (build/plan):", JSON.stringify(diag?.[0]?.diag));
  // would a build claim return a row? check newest queued build's claimed_at
  const q=await pgQuery<{spec_slug:string,claimed_at:string,status:string}>(`SELECT spec_slug, claimed_at, status FROM public.agent_jobs WHERE kind='build' AND status IN ('queued','queued_resume') ORDER BY created_at LIMIT 5`);
  const now=Date.now();
  for(const r of q||[]) console.log(`  build ${r.spec_slug}: claimed_at=${r.claimed_at?`+${Math.round((new Date(r.claimed_at).getTime()-now)/1000)}s`:'null'} status=${r.status}`);
})().then(()=>process.exit(0));
