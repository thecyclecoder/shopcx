import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data}=await db.from("agent_jobs").select("kind,status,spec_slug,updated_at").order("updated_at",{ascending:false}).limit(6);
console.log("most recent job activity (box liveness):");
for(const j of data||[]) console.log(`  ${(j as any).updated_at?.slice(11,19)} [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""}`);
// M1 queued build age
const {data:m1}=await db.from("agent_jobs").select("status,created_at,updated_at").eq("spec_slug","sol-ticket-direction-artifact-and-first-touch-box-session").eq("kind","build").order("created_at",{ascending:false}).limit(1).maybeSingle();
console.log(`\nM1 latest build: ${(m1 as any)?.status} created=${(m1 as any)?.created_at?.slice(11,19)} updated=${(m1 as any)?.updated_at?.slice(11,19)}`);
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
