import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { Client } from "pg";
const PROJECT_REF="urjbhjbygyxffrfkarqn", HOST="aws-1-us-east-1.pooler.supabase.com";
function cs(){ let s=process.env.SUPABASE_DB_URL||process.env.DATABASE_URL||""; if(!s){ const pw=process.env.SUPABASE_DB_PASSWORD; s=`postgres://postgres.${PROJECT_REF}:${encodeURIComponent(pw!)}@${process.env.SUPABASE_DB_HOST||HOST}:5432/postgres`; } return s.replace(":6543/",":5432/"); }
(async()=>{
  const c=new Client({connectionString:cs(),ssl:{rejectUnauthorized:false}}); await c.connect();
  try{ await c.query(readFileSync("supabase/migrations/20261022170000_creative_skeletons_longitudinal.sql","utf8")); console.log("migration applied ✅");
    const {rows}=await c.query(`select winner_tier, count(*) from public.creative_skeletons where source='adlibrary' group by 1 order by 2 desc`);
    console.log("winner_tier distribution after backfill:", rows.map((r:any)=>`${r.winner_tier}:${r.count}`).join(", "));
  } finally { await c.end(); }
})().then(()=>process.exit(0)).catch(e=>{console.error("FAILED:",e.message);process.exit(1);});
