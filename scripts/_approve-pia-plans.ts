import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", JOB="c041f19f-e24d-4144-9ed8-418de53c8f69";
(async () => {
  const db = createAdminClient();
  const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
  for(const aid of ["smrb067jz0","smrb067jz1","smrb067jz2","smrb067jz3","smrb067jz4","smrb067jz5"]){
    const r = await approveRoadmapAction(WS, uid!, { jobId: JOB, actionId: aid, decision: "approve", notes: "Sol goal decomposition reviewed — one spec per milestone, M5 split into measurement + runaway-cap, dependency chain sound (M1 foundation → M2 exec → M3 drift; M4 on M1; M5a on M2+M3; M5b on M3). Approved." });
    console.log(aid, "->", r.ok?"approved":JSON.stringify(r).slice(0,120));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
