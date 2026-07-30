import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
// any job actively building/claimed?
const {data:active}=await db.from("agent_jobs").select("kind,status,spec_slug,updated_at").in("status",["building","claimed"]).order("updated_at",{ascending:false}).limit(10);
console.log("ACTIVELY building/claimed jobs:", (active||[]).length);
for(const j of active||[]) console.log(`  [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""} @${(j as any).updated_at?.slice(11,19)}`);
// box heartbeat
const {data:hb,error}=await db.from("loop_heartbeats").select("loop_id,last_beat_at,status").ilike("loop_id","%box%").order("last_beat_at",{ascending:false}).limit(5);
if(error){console.log("loop_heartbeats:",error.message.slice(0,50));}
else{console.log("\nbox heartbeats:");for(const h of hb||[])console.log(`  ${(h as any).loop_id}: last_beat=${(h as any).last_beat_at?.slice(11,19)} ${(h as any).status||""}`);}
// count queued
const {count}=await db.from("agent_jobs").select("*",{count:"exact",head:true}).eq("status","queued");
console.log("\ntotal queued jobs:", count);
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
