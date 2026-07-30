import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const fn=await c.query(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='list_spec_phase_anomalies'`);
  console.log("list_spec_phase_anomalies exists in DB:", fn.rows.length>0);
  // reproduce the syntax issue in a harmless way: try creating a temp func returning table(position int)
  try {
    await c.query(`create or replace function pg_temp._t1() returns table (position int) language sql stable as $$ select 1 $$`);
    console.log("unquoted 'position' as RETURNS TABLE col: OK (not the culprit)");
  } catch(e:any){ console.log("unquoted 'position' RETURNS TABLE col → ERROR:", String(e.message).slice(0,80)); }
  try {
    await c.query(`create or replace function pg_temp._t2() returns table ("position" int) language sql stable as $$ select 1 $$`);
    console.log('quoted "position" as RETURNS TABLE col: OK');
  } catch(e:any){ console.log('quoted "position" → ERROR:', String(e.message).slice(0,80)); }
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
