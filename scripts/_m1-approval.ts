import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data:j}=await db.from("agent_jobs").select("*").eq("spec_slug","sol-ticket-direction-artifact-and-first-touch-box-session").eq("status","needs_approval").order("created_at",{ascending:false}).limit(1).maybeSingle();
if(!j){console.log("no needs_approval M1 job");process.exit(0);}
console.log("jobId:",(j as any).id,"kind:",(j as any).kind);
const pa=(j as any).pending_actions||[];
console.log("pending_actions:",pa.length);
for(const a of pa) console.log(`  - ${a.id} [${a.status||"pending"}] ${a.type} | cmd: ${(a.cmd||"").slice(0,90)}${a.result?" | result: "+(a.result||"").slice(0,120):""}`);
const q=(j as any).questions; if(q&&(Array.isArray(q)?q.length:q)) console.log("questions:",JSON.stringify(q).slice(0,400));
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
