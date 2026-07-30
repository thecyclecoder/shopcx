import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.remedy_outcomes'::regclass and contype='c'`);
  for(const x of r.rows) console.log(`  ${x.conname}: ${x.def}`);
  // distinct existing outcome values
  const v=await c.query(`select outcome, count(*)::int n from public.remedy_outcomes group by outcome order by n desc`);
  console.log("\nexisting outcome values:", v.rows.map((x:any)=>`${x.outcome}(${x.n})`).join(", ")||"(none)");
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
