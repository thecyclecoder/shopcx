import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: j } = await db.from("agent_jobs").select("*").eq("id","be78ec7a-02d9-4fd8-a054-5feade6a705a").maybeSingle();
  console.log("status:", (j as any).status, "kind:", (j as any).kind);
  const p=(j as any).payload||{};
  console.log("payload keys:", Object.keys(p).join(", "));
  // print any string field that looks like a question/reason
  for(const k of Object.keys(p)){
    const v=p[k];
    if(typeof v==="string" && v.length>20) console.log(`\n[${k}]:`, v.slice(0,600));
    if(Array.isArray(v) && v.length) console.log(`\n[${k}] (array ${v.length}):`, JSON.stringify(v).slice(0,600));
  }
  // top-level non-payload fields
  for(const k of Object.keys(j as any)) if(/question|input|reason|note|instruction/i.test(k) && (j as any)[k]) console.log(`\n.${k}:`, String((j as any)[k]).slice(0,500));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
