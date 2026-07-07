import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data:owner}=await a.from("workspace_members").select("user_id,role,display_name")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").eq("role","owner").maybeSingle();
  console.log("owner:", owner?.user_id, owner?.display_name);
  const {data:job}=await a.from("agent_jobs").select("pending_actions,status")
    .eq("id","1e199bbb-151c-4122-811e-b72409b4c3c2").maybeSingle();
  const pa=(job?.pending_actions as any[])||[];
  console.log("job status:", job?.status, " actions:", pa.length);
  console.log("action ids + status:");
  for(const x of pa) console.log(`  ${x.id}  ${x.status}  ${(x.spec?.slug||x.summary||'').slice(0,50)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
