import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const pw=process.env.SUPABASE_DB_PASSWORD;
  if(!pw){ console.log("no SUPABASE_DB_PASSWORD"); process.exit(1); }
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${pw}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  for(const t of ["agent_action_requests","competitor_ads","ad_breakdowns"]){
    await c.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    console.log(`✓ enabled RLS on public.${t}`);
  }
  // verify
  const v=await c.query(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname = any($1)`,[["agent_action_requests","competitor_ads","ad_breakdowns"]]);
  console.log("\nverify:", v.rows.map((r:any)=>`${r.relname}=${r.relrowsecurity?"RLS ON":"RLS OFF"}`).join(" · "));
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,300));process.exit(1);});
