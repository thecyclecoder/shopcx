import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data}=await db.from("agent_jobs").select("kind").limit(2000);
const kinds=new Set((data||[]).map((r:any)=>r.kind));
const god=[...kinds].filter(k=>/god/i.test(k));
console.log("god-ish agent_jobs kinds:", JSON.stringify(god));
console.log("all kinds sample:", [...kinds].slice(0,40).join(", "));
process.exit(0);})();
