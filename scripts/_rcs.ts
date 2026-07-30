import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select n.nspname sch, p.proname fn, pg_get_function_arguments(p.oid) args, pg_get_function_result(p.oid) ret, p.provolatile
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='refresh_customer_segments'`);
  console.log(`signatures: ${r.rows.length}`);
  for(const x of r.rows) console.log(`  ${x.sch}.${x.fn}(${x.args}) → ${x.ret} [volatile=${x.provolatile}]`);
  // does the arg order/names match p_workspace_id, p_all ?
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
