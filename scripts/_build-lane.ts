import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  // most recent build jobs by updated_at (is the lane draining?)
  const {data}=await a.from("agent_jobs").select("spec_slug,status,updated_at,created_at").eq("kind","build").order("updated_at",{ascending:false}).limit(8);
  console.log("recent build jobs (updated desc):");
  for(const j of data||[]) console.log(`  ${j.status.padEnd(12)} upd=${new Date(j.updated_at).toISOString().slice(5,16)}  ${(j.spec_slug||'').slice(0,40)}`);
  const now=Date.now();
  const claimedRecently=(data||[]).find(j=>["claimed","building","completed","needs_input","needs_approval"].includes(j.status) && (now-new Date(j.updated_at).getTime())<25*60*1000);
  console.log(claimedRecently?"\n→ build lane ACTIVE in last 25m":"\n→ build lane may be IDLE/stalled (no build claim/complete in 25m)");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
