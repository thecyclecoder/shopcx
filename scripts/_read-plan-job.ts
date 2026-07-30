import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: j } = await db.from("agent_jobs").select("*").eq("status","needs_approval").eq("kind","plan").eq("spec_slug","sol-ticket-direction-then-cheap-execution").maybeSingle();
  if(!j){console.log("not found");process.exit(0);}
  console.log("jobId:", (j as any).id);
  const pa=(j as any).pending_actions||[];
  console.log("pending_actions:", pa.length);
  for(const a of pa){
    console.log(`\n── action ${a.id} [${a.status||"pending"}] type=${a.type} ──`);
    // the proposed spec content
    const spec = a.spec || a.payload || a.proposed_spec || a;
    for(const k of ["slug","title","why","what","owner","parent","blocked_by","milestone","phases"]){
      const v = (a as any)[k] ?? (spec as any)?.[k];
      if(v!==undefined) console.log(`   ${k}: ${typeof v==="object"?JSON.stringify(v).slice(0,300):String(v).slice(0,260)}`);
    }
    if(a.cmd) console.log("   cmd:", String(a.cmd).slice(0,120));
    if(a.summary||a.description) console.log("   desc:", String(a.summary||a.description).slice(0,260));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
