import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data:n}=await a.from("dashboard_notifications").select("metadata")
    .eq("type","agent_approval_request").eq("dismissed",false)
    .filter("metadata->>kind","eq","plan").limit(1).maybeSingle();
  const jobId=(n?.metadata as any)?.agent_job_id;
  console.log("plan agent_job_id:", jobId);
  if(!jobId) return;
  const {data:job}=await a.from("agent_jobs").select("*").eq("id",jobId).maybeSingle();
  if(!job){console.log("job not found");return;}
  console.log("job columns:", Object.keys(job));
  console.log("kind/status:", job.kind, job.status);
  // find the array of proposed actions among json columns
  for(const k of Object.keys(job)){
    const v=(job as any)[k];
    if(Array.isArray(v) && v.length && v[0] && (v[0].spec||v[0].type==='spec'||v[0].summary)){
      console.log(`\n>>> proposals in column '${k}': ${v.length}`);
    }
  }
  // dump pending_actions if present
  const pa=(job as any).pending_actions;
  if(pa) { console.log("\npending_actions type:", Array.isArray(pa)?`array(${pa.length})`:typeof pa); }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
