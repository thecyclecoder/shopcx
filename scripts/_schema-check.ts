import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  for(const [t,col] of [["meta_ads","spend_cents"],["ad_publish_jobs","ad_campaign_id"]]){
    const r=await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`,[t]);
    const cols=r.rows.map((x:any)=>x.column_name);
    console.log(`\n${t} (${cols.length} cols) — has ${col}? ${cols.includes(col)?"YES":"NO ❌"}`);
    console.log("  cols:", cols.join(", "));
  }
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
