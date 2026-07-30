import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name='fraud_cases' order by ordinal_position`);
  console.log("fraud_cases cols:", r.rows.map((x:any)=>x.column_name).join(", "));
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
