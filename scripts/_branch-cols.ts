import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  for(const t of ["agent_jobs","spec_test_runs"]){
    const r=await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 and column_name ilike '%branch%'`,[t]);
    console.log(`  ${t}: branch-ish cols = ${r.rows.map((x:any)=>x.column_name).join(", ")||"NONE"}`);
  }
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
