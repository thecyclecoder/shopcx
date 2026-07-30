import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select p.proname, pg_get_function_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='sql'`);
  console.log("public.sql RPC:", r.rows.length?r.rows.map((x:any)=>`sql(${x.args})`).join(" | "):"DOES NOT EXIST");
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,150));process.exit(1);});
