import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data}=await admin.from("specs").select("slug, status").or("slug.ilike.%lf8%,slug.ilike.%life-force%,slug.ilike.%supervisor%vocab%,slug.ilike.%lf8-thin%").order("created_at",{ascending:false}).limit(20);
  console.log(`specs matching lf8/life-force/vocab (${data?.length||0}):`);
  for(const s of (data||[]) as any[]) console.log(`  [${s.status}] ${s.slug}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
