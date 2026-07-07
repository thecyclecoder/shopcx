import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  for(const t of ["cron_heartbeats","control_tower_heartbeats","cron_runs"]){
    const {data,error}=await db.from(t).select("*").ilike("name" as any,"%prompt%").limit(3).order?await db.from(t).select("*").limit(50):{data:null} as any;
    if(error){continue;}
  }
  const {data,error}=await db.from("cron_heartbeats").select("*").limit(100);
  if(error){console.log("cron_heartbeats:",error.message.slice(0,50));process.exit(0);}
  const pr=(data||[]).filter((r:any)=>/prompt/i.test(JSON.stringify(r)));
  for(const r of pr) console.log(JSON.stringify(r).slice(0,200));
  process.exit(0);
})().catch(e=>console.error(e.message));
