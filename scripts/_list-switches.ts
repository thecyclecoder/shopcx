import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  const { data:sw }=await admin.from("kill_switches").select("key,enabled").order("key");
  console.log("total switches:", (sw||[]).length);
  for(const s of sw||[]) if(/growth|media|ad|creat|dahlia|bianca|max/i.test(s.key)) console.log(`  ${s.enabled?"ON ":"off"} ${s.key}`);
})().then(()=>process.exit(0));
