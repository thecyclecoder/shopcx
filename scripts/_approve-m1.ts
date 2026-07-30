import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{const db=createAdminClient();
const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
const r=await approveRoadmapAction(WS,uid!,{jobId:"b889e2cc-1a1b-482c-b62c-366a80aeae11",actionId:"amrb1zee60",decision:"approve",notes:"M1 ticket_directions table — the Direction artifact, foundation of the Sol goal. Clean apply-script pattern, additive. Approving to unblock M2→M5."});
console.log("M1 migration ->",r.ok?"approved":JSON.stringify(r).slice(0,150));
process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
