import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { queueRoadmapBuild } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{const db=createAdminClient();
const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
const r=await queueRoadmapBuild(WS,uid!,{slug:"sol-ticket-direction-artifact-and-first-touch-box-session"});
console.log("retry M1:",JSON.stringify(r).slice(0,240));
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
