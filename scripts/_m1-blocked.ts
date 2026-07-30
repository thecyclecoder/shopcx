import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data:j}=await db.from("agent_jobs").select("*").eq("spec_slug","sol-ticket-direction-artifact-and-first-touch-box-session").eq("kind","spec-test").order("created_at",{ascending:false}).limit(1).maybeSingle();
if(!j){console.log("no spec-test job");process.exit(0);}
console.log("status:",(j as any).status);
for(const k of ["instructions","reason","blocker","note","session_note","spec_branch","depends_on"]){const v=(j as any)[k];if(v)console.log(`  ${k}:`, typeof v==="string"?v.slice(0,300):JSON.stringify(v).slice(0,300));}
const p=(j as any).payload||{}; for(const k of Object.keys(p)) if(/block|depend|reason|note/i.test(k)) console.log(`  payload.${k}:`, JSON.stringify(p[k]).slice(0,200));
// what's the serializer state — any OTHER sol goal-member build in flight (claimed/building)?
const {data:inflight}=await db.from("agent_jobs").select("spec_slug,kind,status").ilike("spec_slug","sol-%").eq("kind","build").in("status",["building","claimed"]).limit(10);
console.log("\nother sol builds in-flight (building/claimed):", (inflight||[]).map((x:any)=>`${x.spec_slug?.replace('sol-','')}=${x.status}`).join(", ")||"none");
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
