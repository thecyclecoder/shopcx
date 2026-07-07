import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data:j}=await a.from("agent_jobs").select("id,spec_slug,status,pending_actions,pr_url,pr_number,log_tail")
    .eq("id","5ec364c3-2a64-48fe-96d7-2d98090e858d").maybeSingle();
  if(!j){console.log("job not found");return;}
  console.log(`job ${j.id} status=${j.status} pr=${j.pr_number||'-'}`);
  const pa=(j.pending_actions as any[])||[];
  console.log(`pending_actions: ${pa.length}`);
  for(const p of pa){
    console.log("──", p.id, "type="+p.type, "status="+p.status);
    console.log("   summary:", p.summary);
    if(p.cmd) console.log("   cmd:", p.cmd);
    if(p.preview) console.log("   preview:", String(p.preview).slice(0,500));
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
