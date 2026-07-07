import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("sonnet_prompts").select("id,status,is_active,reviewed_at,created_at,title").limit(3000);
  const byStatus:Record<string,number>={};
  let reviewed=0, unreviewed=0, oldestUnreviewed="";
  for(const r of data||[]){
    const st=(r as any).status ?? (((r as any).is_active)?"active":"inactive");
    byStatus[st]=(byStatus[st]||0)+1;
    if((r as any).reviewed_at) reviewed++; else { unreviewed++; const c=(r as any).created_at; if(!oldestUnreviewed||c<oldestUnreviewed) oldestUnreviewed=c; }
  }
  console.log("total:", (data||[]).length, "| by status/active:", JSON.stringify(byStatus));
  console.log("reviewed_at set:", reviewed, "| unreviewed:", unreviewed, "| oldest unreviewed:", oldestUnreviewed?.slice(0,16));
  // recent review activity
  const recent=(data||[]).filter((r:any)=>r.reviewed_at).sort((a:any,b:any)=>(b.reviewed_at||"").localeCompare(a.reviewed_at||"")).slice(0,5);
  console.log("\nmost recent reviews:");
  for(const r of recent) console.log(`  ${(r as any).reviewed_at?.slice(0,16)} [${(r as any).status??((r as any).is_active?"active":"inactive")}] ${((r as any).title||"").slice(0,50)}`);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
