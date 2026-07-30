import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB = "30d4128c-3750-4e1a-b295-f143e038172b";
const POLL_MS = 30_000, MAX = 80;
async function main(){
  const admin = createAdminClient();
  let last="";
  for (let i=1;i<=MAX;i++){
    const { data: job } = await admin.from("agent_jobs").select("status").eq("id", JOB).maybeSingle();
    const s = String((job as any)?.status);
    if (s!==last){ console.log(`[watch] poll ${i}: job=${s}`); last=s; }
    const spec:any = await getSpec(WS, "bianca-cold-test-recent-purchaser-exclusion");
    if (spec && ["completed","failed","cancelled","error"].includes(s)){ console.log(`[watch] READY — job=${s}, M2 exclusion spec authored.`); return; }
    if (["failed","cancelled","error"].includes(s)){ console.log(`[watch] job terminal without spec: ${s}`); return; }
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
  console.log("[watch] timed out");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("[watch] fatal",e);process.exit(1);});
