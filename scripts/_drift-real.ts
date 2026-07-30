import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
import { readdirSync } from "fs";
(async()=>{
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const recorded=new Set((await c.query(`select version from supabase_migrations.schema_migrations`)).rows.map((r:any)=>String(r.version)));
  const files=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"));
  const versionOf=(f:string)=>f.split("_")[0];
  const unrecorded=files.filter(f=>!recorded.has(versionOf(f)));
  console.log(`migration files: ${files.length} · recorded versions: ${recorded.size}`);
  console.log(`\nMERGED-BUT-UNRECORDED (drift — reconciler would retry these): ${unrecorded.length}`);
  for(const f of unrecorded.slice(0,25)) console.log(`  ✗ ${f}`);
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
