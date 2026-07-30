import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select n.nspname as schema, p.proname as fn, pg_get_function_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prokind='f' and n.nspname not in ('pg_catalog','information_schema')
      and pg_get_functiondef(p.oid) ilike '%json_to_record%' order by 1,2`);
  console.log(`user functions using json_to_record: ${r.rows.length}`);
  for(const x of r.rows) console.log(`  ${x.schema}.${x.fn}(${x.args})`);
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
